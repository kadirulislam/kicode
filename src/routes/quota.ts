/**
 * What a gateway says about the quota it is enforcing.
 *
 * The facts come from response headers, a documented probe, or an error body —
 * never from an assumption. A gateway that reports nothing yields `null`, and
 * "unknown" is a legitimate, shown answer: the whole product promise is cost
 * honesty, and an invented remaining count is worse than no count.
 *
 * The header families are not one format. Groq documents that
 * `x-ratelimit-limit-requests` is a **daily** request ceiling while
 * `x-ratelimit-limit-tokens` is a **per-minute** token ceiling; OpenAI uses the
 * same names with different windows; OpenRouter sends an unsuffixed
 * `X-RateLimit-*` only on an error. A snapshot therefore carries its scope and
 * window explicitly, and `unknown` where the name does not determine it.
 */

export type QuotaScope = "requests" | "tokens" | "credits";
export type QuotaWindow = "minute" | "day" | "month" | "unknown";
export type QuotaSource = "headers" | "probe" | "error";

export type QuotaSnapshot = {
  scope: QuotaScope;
  window: QuotaWindow;
  limit: number | null;
  remaining: number | null;
  /** Absolute ms since the epoch when this window resets, or null. */
  resetAt: number | null;
  source: QuotaSource;
};

/**
 * Everything one response said, in one object.
 *
 * The request window is a *quota* (switch when it is gone) and the token window
 * is a *rate* (wait a moment and retry). They are different reactions, so they
 * are kept apart rather than collapsed into one number.
 */
export type QuotaReading = {
  /** The request/quota window, when the gateway reported one. */
  requests: QuotaSnapshot | null;
  /** The token/per-minute window, when the gateway reported one. */
  tokens: QuotaSnapshot | null;
  /** What the gateway asked us to wait, when it asked. */
  retryAfterMs: number | null;
  /** Gateway correlation id, kept so a failure can be traced. */
  requestId?: string;
};

/** A `Retry-After` longer than this is not honoured; it would park the session. */
export const RETRY_AFTER_CAP_MS = 60_000;

/**
 * The one window worth remembering from a reading.
 *
 * A reading can carry two, and they mean different things: the request window is
 * a quota that is used up and then resets hours later, the token window is a
 * rate that clears in seconds. A store can only keep one, so the choice is
 * made by what it says rather than by which is bigger:
 *
 * 1. the window that is **exhausted** — that is the fact that changes a
 *    decision, and it is the only reason to hold a route back;
 * 2. the request window — the one that runs out for a whole day;
 * 3. the token window — better than nothing;
 * 4. `null` when the gateway said nothing usable.
 */
export function preferredSnapshot(reading: QuotaReading | null): QuotaSnapshot | null {
  if (!reading) return null;
  if (reading.requests?.remaining === 0) return reading.requests;
  if (reading.tokens?.remaining === 0) return reading.tokens;
  return reading.requests ?? reading.tokens ?? null;
}

export type ReadQuotaOptions = {
  /** For deterministic tests. */
  now?: number;
  /** The endpoint's hostname, which decides an ambiguous window. */
  host?: string;
  retryAfterCapMs?: number;
};

/**
 * Reads every quota header a response carries, or null when it carries none.
 *
 * Header lookup is case-insensitive by the platform's `Headers`, which is what
 * the HTTP spec says anyway.
 */
export function readQuota(headers: Headers, options: ReadQuotaOptions = {}): QuotaReading | null {
  const now = options.now ?? Date.now();
  const cap = options.retryAfterCapMs ?? RETRY_AFTER_CAP_MS;
  const get = (name: string): string | null => headers.get(name);

  const requests = suffixed(get, "requests", "headers", now, options.host);
  const tokens = suffixed(get, "tokens", "headers", now, options.host);

  // The unsuffixed family — the IETF draft's `RateLimit-*`, and the
  // `X-RateLimit-*` OpenRouter sends on a platform-limit error. Only used when
  // nothing suffixed was there, since it is the same names without a scope.
  const flat = requests ?? tokens ? null : flatReading(get, now);

  const retryAfterMs = readRetryAfter(get, now, cap);
  const requestId = get("x-request-id") ?? undefined;

  if (!requests && !tokens && !flat && retryAfterMs === null) return null;
  return {
    requests: requests ?? flat,
    tokens,
    retryAfterMs,
    ...(requestId ? { requestId } : {}),
  };
}

/** One suffixed family, e.g. `x-ratelimit-*-requests`. */
function suffixed(
  get: (name: string) => string | null,
  suffix: "requests" | "tokens",
  source: QuotaSource,
  now: number,
  host: string | undefined,
): QuotaSnapshot | null {
  const limit = number(get(`x-ratelimit-limit-${suffix}`));
  const remaining = number(get(`x-ratelimit-remaining-${suffix}`));
  const resetAt = parseReset(get(`x-ratelimit-reset-${suffix}`), now);
  if (limit === null && remaining === null && resetAt === null) return null;

  return {
    scope: suffix,
    window: inferWindow(suffix, host),
    limit,
    remaining,
    resetAt,
    source,
  };
}

/** The unsuffixed family; scope is a guess the caller can see as one. */
function flatReading(get: (name: string) => string | null, now: number): QuotaSnapshot | null {
  const limit = number(get("ratelimit-limit")) ?? number(get("x-ratelimit-limit"));
  const remaining = number(get("ratelimit-remaining")) ?? number(get("x-ratelimit-remaining"));
  const resetAt = parseReset(get("ratelimit-reset") ?? get("x-ratelimit-reset"), now);
  if (limit === null && remaining === null && resetAt === null) return null;

  return { scope: "requests", window: "unknown", limit, remaining, resetAt, source: "headers" };
}

/**
 * The window a name does not tell us.
 *
 * Token ceilings are per-minute on every OpenAI-compatible gateway worth
 * supporting, so that one is safe. Request ceilings are not: Groq documents a
 * daily one, OpenAI's is per-minute, so only a host we know may claim a window.
 */
function inferWindow(scope: "requests" | "tokens", host: string | undefined): QuotaWindow {
  if (scope === "tokens") return "minute";
  const hostname = (host ?? "").toLowerCase();
  if (hostname === "groq.com" || hostname.endsWith(".groq.com")) return "day";
  return "unknown";
}

/**
 * A duration like `2m59.56s`, `14h12m`, `7.66s` or `1h` → milliseconds.
 *
 * Groq's documented reset format, and the one OpenAI uses. A string with no
 * unit (`"60"`) is *not* a duration and returns null, so the caller can treat it
 * as seconds instead.
 */
export function parseDuration(raw: string | null | undefined): number | null {
  if (!raw) return null;

  const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const pattern = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi;

  let total = 0;
  let matched = false;
  for (let match = pattern.exec(raw); match !== null; match = pattern.exec(raw)) {
    const value = Number(match[1]);
    const unit = units[(match[2] ?? "").toLowerCase()];
    if (!Number.isFinite(value) || unit === undefined) continue;
    total += value * unit;
    matched = true;
  }

  return matched ? total : null;
}

/**
 * A reset value in any of the shapes gateways use → absolute ms, or null.
 *
 * Accepts a duration, bare seconds, an epoch-seconds integer, and an HTTP-date.
 * Anything else is ignored rather than defaulted: a `0` would read as "resets
 * now" and cause a retry storm.
 */
export function parseReset(raw: string | null | undefined, now: number): number | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;

  const duration = parseDuration(text);
  if (duration !== null && duration >= 0) return now + duration;

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const value = Number(text);
    // Ten digits cannot be a plausible duration; it is an epoch in seconds.
    return value >= 1_000_000_000 ? value * 1_000 : now + value * 1_000;
  }

  const date = Date.parse(text);
  return Number.isNaN(date) ? null : date;
}

/** Seconds (or an HTTP-date) from `Retry-After`, clamped to the cap. */
function readRetryAfter(get: (name: string) => string | null, now: number, cap: number): number | null {
  const explicit = number(get("retry-after-ms"));
  if (explicit !== null) return Math.min(explicit, cap);

  const raw = get("retry-after");
  if (!raw) return null;
  const text = raw.trim();

  const seconds = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1_000 : Date.parse(text) - now;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds, cap);
}

/** A header value as a non-negative number, or null when it is not one. */
function number(raw: string | null): number | null {
  if (raw === null) return null;
  const text = raw.trim();
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}
