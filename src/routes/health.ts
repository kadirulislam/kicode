/**
 * What this machine has learned about each route.
 *
 * A route that answered an hour ago is worth remembering and a route that was
 * out of quota ten minutes ago is worth *not* trying again — but only on this
 * machine. The file lives in KiCode's own directory beside sessions and
 * favourites, is never uploaded anywhere (spec §9: no telemetry), and never
 * holds a key: a failure reason is a sentence the gateway wrote, so it is
 * redacted and trimmed to one line before it is stored.
 *
 * Nothing here invents a figure. A gateway that reported no limits leaves
 * `quota` unset, and a route with no record is `unknown` — which is drawn as
 * `unknown` and never as `100%`.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveHome } from "../paths";
import type { QuotaSnapshot } from "./quota";

/** How a route may be used right now. Derived, never stored. */
export type HealthState = "unknown" | "healthy" | "flaky" | "throttled" | "capped" | "broken";

/**
 * A model on one endpoint — the identity the model picker already uses, so a
 * row in the list and its health are the same thing.
 */
export type RouteRef = { baseUrl: string; model: string };

/** The key a record is filed under, and the one written to disk. */
export function routeKey(ref: RouteRef): string {
  return `${ref.baseUrl}#${ref.model}`;
}

/** One request's result, as much of it as was observed. */
export type RouteEvent = { at: string; status: number | null };

export type RouteHealthRecord = {
  model: string;
  baseUrl: string;
  lastOkAt?: string;
  lastFailAt?: string;
  /** Belongs to `lastFailAt`: it is cleared by a success, not accumulated. */
  lastReason?: string;
  consecutiveFailures: number;
  /** What the gateway asked us to wait after the last failure, when it asked. */
  retryAfterMs?: number;
  /** The last limits a gateway or probe reported. Absent when it reported none. */
  quota?: QuotaSnapshot;
  /** A bounded ring, newest last, for telling flapping from dead. */
  recent: RouteEvent[];
};

/** What one request said about a route. */
export type RouteOutcome = {
  ok: boolean;
  status?: number;
  /** A short human reason from the caller; the last resort is the status. */
  reason?: string;
  retryAfterMs?: number;
  quota?: QuotaSnapshot | null;
  /** For deterministic tests. */
  at?: number;
};

/** One route, ready to print. The store owns the wording; the UI owns the layout. */
export type RouteHealthLine = { ref: RouteRef; state: HealthState; detail: string };

/** Enough history to tell "flapping" from "one bad minute". */
export const RECENT_EVENTS = 32;
/** An entry untouched for this long is dropped when the file is read. */
export const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;
/** Writes are batched: a streaming session must not do file I/O per request. */
export const WRITE_DEBOUNCE_MS = 5_000;

const FILE_VERSION = 1;
const MAX_REASON_CHARS = 200;
const FILENAME = "routes.json";

export function routesFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveHome(env), FILENAME);
}

export type RouteHealthOptions = {
  env?: NodeJS.ProcessEnv;
  /** Injected in tests, so pruning and debouncing are deterministic. */
  now?: () => number;
  /** Where a corrupt or unwritable file is reported. Once, never repeatedly. */
  warn?: (message: string) => void;
  debounceMs?: number;
};

/**
 * The route records for this machine.
 *
 * Reads are on demand and writes are debounced, because the alternative — a
 * write per request — is a file synced thousands of times per session for
 * information that only matters the next time a route is chosen.
 */
export class RouteHealth {
  private readonly records = new Map<string, RouteHealthRecord>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly clock: () => number;
  private readonly warn: (message: string) => void;
  private readonly debounceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private warnedWrite = false;

  private constructor(options: RouteHealthOptions) {
    this.env = options.env ?? process.env;
    this.clock = options.now ?? (() => Date.now());
    this.warn = options.warn ?? (() => {});
    this.debounceMs = options.debounceMs ?? WRITE_DEBOUNCE_MS;
  }

  /** Reads the file, pruning entries nobody has touched in a month. */
  static async load(options: RouteHealthOptions = {}): Promise<RouteHealth> {
    const store = new RouteHealth(options);
    await store.read();
    return store;
  }

  get(ref: RouteRef): RouteHealthRecord | undefined {
    return this.records.get(routeKey(ref));
  }

  /** Every route this machine has a record for, worst state first. */
  lines(now: number = this.clock()): RouteHealthLine[] {
    return [...this.records.values()]
      .map((record) => {
        const state = healthState(record, now);
        return {
          ref: { baseUrl: record.baseUrl, model: record.model },
          state,
          detail: describeRoute(record, state, now),
        };
      })
      .sort((a, b) => SEVERITY[a.state] - SEVERITY[b.state] || a.ref.model.localeCompare(b.ref.model));
  }

  /**
   * Folds one request's result into the record.
   *
   * A success clears `lastReason` rather than keeping it: the reason belongs to
   * `lastFailAt`, and a healthy route showing last week's failure is noise.
   * Nothing here touches the disk — that is `schedule`.
   */
  record(ref: RouteRef, outcome: RouteOutcome): void {
    const key = routeKey(ref);
    const at = outcome.at ?? this.clock();
    const stamp = new Date(at).toISOString();
    const existing = this.records.get(key) ?? { model: ref.model, baseUrl: ref.baseUrl, consecutiveFailures: 0, recent: [] };

    const record: RouteHealthRecord = {
      ...existing,
      recent: [...existing.recent, { at: stamp, status: outcome.status ?? (outcome.ok ? 200 : null) }].slice(-RECENT_EVENTS),
    };

    if (outcome.ok) {
      record.lastOkAt = stamp;
      record.consecutiveFailures = 0;
      delete record.lastReason;
      delete record.retryAfterMs;
    } else {
      record.lastFailAt = stamp;
      record.lastReason = redact(outcome.reason ?? defaultReason(outcome.status));
      record.consecutiveFailures = existing.consecutiveFailures + 1;
      if (outcome.retryAfterMs !== undefined) record.retryAfterMs = outcome.retryAfterMs;
    }

    if (outcome.quota) record.quota = outcome.quota;

    this.records.set(key, record);
    this.schedule();
  }

  /** Writes now, whatever the debounce was waiting for. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.write();
  }

  /** Stops the debounce timer so a pending write cannot hold the process open. */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.timer || this.debounceMs <= 0) {
      if (this.debounceMs <= 0) void this.write();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.write();
    }, this.debounceMs);
    // Route health is a convenience: it must never keep a finished CLI alive.
    this.timer.unref();
  }

  /** One writer at a time, so two flushes cannot interleave their renames. */
  private write(): Promise<void> {
    this.queue = this.queue.then(() => this.writeNow()).catch(() => undefined);
    return this.queue;
  }

  private async writeNow(): Promise<void> {
    const file = routesFile(this.env);
    const body = JSON.stringify(
      { version: FILE_VERSION, routes: Object.fromEntries(this.records) },
      null,
      2,
    );

    try {
      await mkdir(path.dirname(file), { recursive: true });
      // Write then rename: an interrupted save cannot leave half a file behind.
      const temp = `${file}.tmp`;
      await writeFile(temp, `${body}\n`, "utf8");
      await rename(temp, file);
    } catch (error) {
      if (!this.warnedWrite) {
        this.warnedWrite = true;
        this.warn(`could not write route health to ${file}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Reads the file, tolerating every way it can be wrong.
   *
   * A file that will not parse starts empty and says so — and is deliberately
   * *not* rewritten here, so a bad file is still there to look at until
   * something actually changes.
   */
  private async read(): Promise<void> {
    const file = routesFile(this.env);

    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      // No file yet is the normal first run, not a problem to report.
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.warn(`${file} is not valid JSON — route health starts empty and the file is left as it is.`);
      return;
    }

    const routes = (parsed as { routes?: unknown } | null)?.routes;
    const version = (parsed as { version?: unknown } | null)?.version;
    if (version !== FILE_VERSION || routes === null || typeof routes !== "object" || Array.isArray(routes)) {
      this.warn(`${file} is not a route-health file this version understands — ignoring it.`);
      return;
    }

    const now = this.clock();
    for (const [key, value] of Object.entries(routes as Record<string, unknown>)) {
      const record = toRecord(value);
      if (!record) continue;
      if (stale(record, now)) continue;
      this.records.set(key, record);
    }
  }
}

/** A record with more than this many failures in a row is not coming back. */
const BROKEN_RUN = 3;
/** How far back `flaky` looks. */
const ALTERNATION_WINDOW = 8;

const SEVERITY: Record<HealthState, number> = {
  broken: 0,
  capped: 1,
  throttled: 2,
  flaky: 3,
  healthy: 4,
  unknown: 5,
};

/**
 * The state of a route at `now`, from its record alone.
 *
 * `broken` is checked first because a route that refuses at all outranks one
 * that is merely resting: there is no waiting for a 401 to become a 200.
 */
export function healthState(record: RouteHealthRecord | undefined, now: number): HealthState {
  if (!record) return "unknown";
  if (broken(record)) return "broken";
  if (deferredUntil(record, now) !== null) return exhausted(record, now) ? "capped" : "throttled";
  if (alternates(record.recent) || record.consecutiveFailures >= 2) return "flaky";
  // Failures under two are not a pattern, so a route with any evidence at all
  // and no run of failures is healthy. A record with *no* evidence is not —
  // that is the same as never having used the route.
  if (record.recent.length === 0 && record.lastOkAt === undefined && record.lastFailAt === undefined) return "unknown";
  return "healthy";
}

/**
 * When a held route becomes usable again, or null when it is ready now.
 *
 * `Infinity` is a real answer: a quota that is spent with no reported reset is
 * held until something re-reads it, not until a clock KiCode made up runs out.
 */
export function deferredUntil(record: RouteHealthRecord, now: number): number | null {
  // An observation beats a stale reading: a route that has just answered is not
  // being held by a quota snapshot taken before it did.
  if (lastEvent(record)?.status === 200) return null;

  let until: number | null = null;
  const asked = record.retryAfterMs;
  if (asked !== undefined && record.lastFailAt !== undefined) {
    const at = Date.parse(record.lastFailAt) + asked;
    if (Number.isFinite(at) && at > now) until = at;
  }

  const quota = record.quota;
  if (quota && quota.remaining === 0) {
    if (quota.resetAt === null) return Number.POSITIVE_INFINITY;
    if (quota.resetAt > now) until = Math.max(until ?? 0, quota.resetAt);
  }

  return until;
}

/** True when the route cannot work at all until it is reconfigured. */
function broken(record: RouteHealthRecord): boolean {
  const last = lastEvent(record);
  if (last) {
    // A refused key, or a model this endpoint does not serve: neither is fixed
    // by waiting.
    if (last.status === 401 || last.status === 403 || last.status === 404) return true;
  }
  return trailingFailures(record).filter((event) => serverError(event.status)).length >= BROKEN_RUN;
}

/** The quota that is spent, as opposed to a rate that will clear. */
function exhausted(record: RouteHealthRecord, now: number): boolean {
  const quota = record.quota;
  if (!quota || quota.remaining !== 0) return false;
  if (quota.resetAt === null) return true;
  return quota.resetAt > now;
}

/**
 * True when the most recent results keep changing their mind.
 *
 * That is what flapping looks like and what a single bad minute does not: two
 * consecutive failures are covered by the caller separately. A run of
 * `ok, fail, ok, fail` is worse than one failure, because the next request is a
 * coin toss and the chain should stop leaning on it.
 */
function alternates(recent: readonly RouteEvent[]): boolean {
  const tail = recent.slice(-ALTERNATION_WINDOW);
  if (tail.length < 4) return false;

  const failed = tail.filter((event) => event.status !== 200).length;
  if (failed === 0 || failed === tail.length) return false;

  for (let index = 1; index < tail.length; index++) {
    const previous = tail[index - 1]?.status === 200;
    const current = tail[index]?.status === 200;
    if (previous === current) return false;
  }
  return true;
}

/** The failures since the last success, oldest first. */
function trailingFailures(record: RouteHealthRecord): RouteEvent[] {
  const failures: RouteEvent[] = [];
  for (const event of record.recent) {
    if (event.status === 200) failures.length = 0;
    else failures.push(event);
  }
  return failures;
}

function lastEvent(record: RouteHealthRecord): RouteEvent | undefined {
  return record.recent[record.recent.length - 1];
}

function serverError(status: number | null): boolean {
  return status !== null && status >= 500;
}

/** A record nobody has touched in a month is not worth keeping. */
function stale(record: RouteHealthRecord, now: number): boolean {
  const stamps = [record.lastOkAt, record.lastFailAt, record.recent[record.recent.length - 1]?.at]
    .filter((value): value is string => typeof value === "string")
    .map(Date.parse)
    .filter((value) => Number.isFinite(value));
  if (stamps.length === 0) return true;
  return now - Math.max(...stamps) > PRUNE_AFTER_MS;
}

/** One line saying why, in words that suggest what to do about it. */
export function describeRoute(record: RouteHealthRecord, state: HealthState, now: number): string {
  const failed = relative(record.lastFailAt, now);
  switch (state) {
    case "broken":
      return `will not answer: ${record.lastReason ?? "it refused"}${failed ? ` (${failed})` : ""}`;
    case "capped":
      return `out of quota${remaining(record)}${resets(record, now)}`;
    case "throttled":
      return `asked to wait${resets(record, now)}`;
    case "flaky":
      return `answers sometimes — ${record.consecutiveFailures} failures in a row${failed ? `, last ${failed}` : ""}`;
    case "healthy": {
      const answered = relative(record.lastOkAt, now);
      return `last answered${answered ? ` ${answered}` : ""}`;
    }
    default:
      return "nothing recorded yet";
  }
}

function remaining(record: RouteHealthRecord): string {
  const quota = record.quota;
  if (!quota) return "";
  if (quota.limit === null) return ` (${quota.scope} window)`;
  return ` (0 of ${quota.limit} ${quota.scope} left)`;
}

function resets(record: RouteHealthRecord, now: number): string {
  const until = deferredUntil(record, now);
  if (until === null) return "";
  if (!Number.isFinite(until)) return ", no reset reported";
  return `, resets in ${duration(until - now)}`;
}

/** `2h 5m`, `12m 30s`, `45s`, `3d 4h`. */
export function duration(ms: number): string {
  const seconds = Math.max(Math.round(ms / 1_000), 0);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** `just now`, `12m ago`, `2d ago` — or nothing when there is no stamp. */
export function relative(at: string | undefined, now: number): string {
  if (!at) return "";
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return "";
  const ms = now - then;
  if (ms < 60_000) return "just now";
  return `${duration(ms)} ago`;
}

/**
 * A reason, fit to keep.
 *
 * It is a sentence a gateway wrote, which means it can contain a key, a token,
 * or a paragraph. One line, bounded, with anything credential-shaped replaced.
 */
export function redact(reason: string): string {
  return reason
    .replace(/bearer\s+[^\s,;)\]]+/gi, "bearer ***")
    .replace(/\b(?:sk|pk|thk|key|token|api[-_]?key)[-_][A-Za-z0-9_-]{6,}/gi, "***")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "***")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_REASON_CHARS);
}

/** The status, when the caller had no better words for it. */
function defaultReason(status: number | undefined): string {
  if (status === 429) return "rate-limited (HTTP 429)";
  if (status === 401 || status === 403) return `the key was refused (HTTP ${status})`;
  if (status === 404) return "no such model there (HTTP 404)";
  if (status !== undefined) return `HTTP ${status}`;
  return "unreachable";
}

/** One record, from whatever the file held. Anything unrecognisable is dropped. */
function toRecord(value: unknown): RouteHealthRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;

  const baseUrl = entry.baseUrl;
  const model = entry.model;
  if (typeof baseUrl !== "string" || baseUrl === "" || typeof model !== "string" || model === "") return null;

  const record: RouteHealthRecord = {
    baseUrl,
    model,
    consecutiveFailures: typeof entry.consecutiveFailures === "number" ? entry.consecutiveFailures : 0,
    recent: Array.isArray(entry.recent) ? entry.recent.filter(isEvent) : [],
  };

  if (typeof entry.lastOkAt === "string") record.lastOkAt = entry.lastOkAt;
  if (typeof entry.lastFailAt === "string") record.lastFailAt = entry.lastFailAt;
  if (typeof entry.lastReason === "string") record.lastReason = entry.lastReason;
  if (typeof entry.retryAfterMs === "number") record.retryAfterMs = entry.retryAfterMs;
  if (isQuota(entry.quota)) record.quota = entry.quota;

  return record;
}

function isEvent(value: unknown): value is RouteEvent {
  if (value === null || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return typeof event.at === "string" && (event.status === null || typeof event.status === "number");
}

function isQuota(value: unknown): value is QuotaSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const quota = value as Record<string, unknown>;
  return (
    (quota.scope === "requests" || quota.scope === "tokens" || quota.scope === "credits") &&
    (quota.window === "minute" || quota.window === "day" || quota.window === "month" || quota.window === "unknown") &&
    (quota.limit === null || typeof quota.limit === "number") &&
    (quota.remaining === null || typeof quota.remaining === "number") &&
    (quota.resetAt === null || typeof quota.resetAt === "number") &&
    (quota.source === "headers" || quota.source === "probe" || quota.source === "error")
  );
}
