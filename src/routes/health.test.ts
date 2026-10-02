import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PRUNE_AFTER_MS,
  RouteHealth,
  deferredUntil,
  duration,
  healthState,
  redact,
  relative,
  routeKey,
  routesFile,
  type RouteHealthRecord,
} from "./health";

let home = "";

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "kicode-routes-"));
});

afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1_000;
/** A fresh directory per test, so one case cannot leave a file for the next. */
const freshHome = async (): Promise<string> => mkdtemp(path.join(tmpdir(), "kicode-routes-"));

const record = (overrides: Partial<RouteHealthRecord> = {}): RouteHealthRecord => ({
  baseUrl: "https://api.example/v1",
  model: "glm-5.3",
  consecutiveFailures: 0,
  recent: [],
  ...overrides,
});

/** A ring that alternates between ok and one failure. */
const events = (...statuses: (number | null)[]): { at: string; status: number | null }[] =>
  statuses.map((status, index) => ({ at: new Date(NOW - (statuses.length - index) * 1_000).toISOString(), status }));

describe("healthState", () => {
  it("is unknown for a route no request has ever been made against", () => {
    expect(healthState(undefined, NOW)).toBe("unknown");
  });

  it("is broken after three consecutive server errors", () => {
    const state = healthState(record({ consecutiveFailures: 3, recent: events(500, 502, 503) }), NOW);
    expect(state).toBe("broken");
  });

  it("is not broken after two server errors, and is broken by a refused key at once", () => {
    expect(healthState(record({ consecutiveFailures: 2, recent: events(200, 500, 500) }), NOW)).toBe("flaky");
    expect(healthState(record({ consecutiveFailures: 1, recent: events(200, 401) }), NOW)).toBe("broken");
    expect(healthState(record({ consecutiveFailures: 1, recent: events(200, 404) }), NOW)).toBe("broken");
  });

  it("is flaky when the results keep alternating", () => {
    const state = healthState(record({ consecutiveFailures: 1, recent: events(200, 429, 200, 429) }), NOW);
    expect(state).toBe("flaky");
  });

  it("is healthy after one failure, and after a plain success", () => {
    expect(healthState(record({ consecutiveFailures: 1, recent: events(200, 200, 429) }), NOW)).toBe("healthy");
    expect(healthState(record({ lastOkAt: new Date(NOW).toISOString(), recent: events(200) }), NOW)).toBe("healthy");
  });

  it("holds a route with a spent quota until its reset, and lets it go once it passes", () => {
    const spent = {
      scope: "requests" as const,
      window: "day" as const,
      limit: 50,
      remaining: 0,
      resetAt: NOW + 3 * 60 * 60 * 1_000,
      source: "probe" as const,
    };

    const held = record({ consecutiveFailures: 1, recent: events(200, 429), quota: spent });
    expect(healthState(held, NOW)).toBe("capped");
    expect(deferredUntil(held, NOW)).toBe(NOW + 3 * 60 * 60 * 1_000);

    expect(healthState(held, NOW + 4 * 60 * 60 * 1_000)).not.toBe("capped");
    expect(deferredUntil(held, NOW + 4 * 60 * 60 * 1_000)).toBeNull();
  });

  it("holds a spent quota with no reported reset indefinitely, rather than guessing", () => {
    const held = record({
      recent: events(429),
      quota: { scope: "credits", window: "unknown", limit: null, remaining: 0, resetAt: null, source: "probe" },
    });

    expect(healthState(held, NOW)).toBe("capped");
    expect(deferredUntil(held, NOW)).toBe(Number.POSITIVE_INFINITY);
  });

  it("is throttled — for seconds — when the gateway asked for a wait", () => {
    const held = record({
      consecutiveFailures: 1,
      lastFailAt: new Date(NOW).toISOString(),
      retryAfterMs: 5_000,
      recent: events(200, 429),
    });

    expect(healthState(held, NOW + 1_000)).toBe("throttled");
    expect(deferredUntil(held, NOW + 1_000)).toBe(NOW + 5_000);
    expect(healthState(held, NOW + 6_000)).not.toBe("throttled");
  });

  it("lets an observation beat a stale reading", () => {
    // A route that has just answered is not held by a snapshot taken before it.
    const answered = record({
      lastOkAt: new Date(NOW).toISOString(),
      recent: events(429, 200),
      quota: { scope: "requests", window: "day", limit: 50, remaining: 0, resetAt: NOW + 3_600_000, source: "probe" },
    });

    expect(deferredUntil(answered, NOW)).toBeNull();
    expect(healthState(answered, NOW)).toBe("healthy");
  });
});

describe("RouteHealth store", () => {
  it("files a route under its endpoint and model, and writes valid JSON", async () => {
    const dir = await freshHome();
    const store = await RouteHealth.load({ env: { KICODE_HOME: dir }, now: () => NOW, debounceMs: 0 });

    store.record({ baseUrl: "https://api.example/v1", model: "glm-5.3" }, { ok: true, at: NOW });
    await store.flush();

    const raw = await readFile(routesFile({ KICODE_HOME: dir }), "utf8");
    const parsed = JSON.parse(raw) as { version: number; routes: Record<string, RouteHealthRecord> };
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.routes)).toEqual([routeKey({ baseUrl: "https://api.example/v1", model: "glm-5.3" })]);
    expect(parsed.routes["https://api.example/v1#glm-5.3"]?.lastOkAt).toBe(new Date(NOW).toISOString());
    await rm(dir, { recursive: true, force: true });
  });

  it("never writes a key, even when the gateway puts one in its error", async () => {
    const dir = await freshHome();
    const store = await RouteHealth.load({ env: { KICODE_HOME: dir }, now: () => NOW, debounceMs: 0 });

    store.record(
      { baseUrl: "https://api.example/v1", model: "glm-5.3" },
      {
        ok: false,
        status: 401,
        // A key shape inside a gateway message, which is the input the redaction
        // this file tests has to survive.
        reason:
          "Provider rejected the API key: Authorization: Bearer thk_live_Xa7UA9mQ2secretvalue (sk-proj-abcdefghijklmnop1234)\nsecond line", // kicode-secret-ok
        at: NOW,
      },
    );
    await store.flush();

    const raw = await readFile(routesFile({ KICODE_HOME: dir }), "utf8");
    expect(raw).not.toContain("Xa7UA9mQ2secretvalue");
    expect(raw).not.toContain("abcdefghijklmnop1234");
    expect(raw).not.toContain("Bearer thk_live");
    expect(raw).toContain("bearer ***");
    // One line, because it is drawn as one.
    expect(raw).not.toContain("\nsecond line");
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the reason beside the failure and drops it on the next success", async () => {
    const dir = await freshHome();
    const store = await RouteHealth.load({ env: { KICODE_HOME: dir }, now: () => NOW, debounceMs: 0 });
    const ref = { baseUrl: "https://api.example/v1", model: "glm-5.3" };

    store.record(ref, { ok: false, status: 429, reason: "rate-limited (HTTP 429)", retryAfterMs: 5_000, at: NOW });
    expect(store.get(ref)?.lastReason).toBe("rate-limited (HTTP 429)");
    expect(store.get(ref)?.retryAfterMs).toBe(5_000);

    store.record(ref, { ok: true, at: NOW + 6_000 });
    expect(store.get(ref)?.lastReason).toBeUndefined();
    expect(store.get(ref)?.retryAfterMs).toBeUndefined();
    expect(store.get(ref)?.consecutiveFailures).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  it("prunes an entry nobody has touched in a month, and keeps one from yesterday", async () => {
    const dir = await freshHome();
    const file = routesFile({ KICODE_HOME: dir });
    const write = (routes: Record<string, unknown>): Promise<void> => writeFile(file, JSON.stringify({ version: 1, routes }), "utf8");

    await write({
      "https://old.example/v1#ancient": { ...record(), baseUrl: "https://old.example/v1", model: "ancient", lastOkAt: new Date(NOW - 31 * DAY).toISOString() },
      "https://new.example/v1#recent": { ...record(), baseUrl: "https://new.example/v1", model: "recent", lastOkAt: new Date(NOW - 29 * DAY).toISOString() },
    });

    const store = await RouteHealth.load({ env: { KICODE_HOME: dir }, now: () => NOW });
    expect(store.get({ baseUrl: "https://old.example/v1", model: "ancient" })).toBeUndefined();
    expect(store.get({ baseUrl: "https://new.example/v1", model: "recent" })).toBeDefined();

    // Loading prunes in memory only: a read is not a reason to write.
    expect((JSON.parse(await readFile(file, "utf8")) as { routes: Record<string, unknown> }).routes).toHaveProperty(
      "https://old.example/v1#ancient",
    );
    await rm(dir, { recursive: true, force: true });
  });

  it("starts empty from a corrupt file, warns once, and leaves it alone until something changes", async () => {
    const dir = await freshHome();
    const file = routesFile({ KICODE_HOME: dir });
    await writeFile(file, "{ not json at all", "utf8");

    const warnings: string[] = [];
    const store = await RouteHealth.load({ env: { KICODE_HOME: dir }, now: () => NOW, warn: (message) => warnings.push(message), debounceMs: 0 });

    expect(store.lines(NOW)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not valid JSON");
    // The bad file is still there to look at.
    expect(await readFile(file, "utf8")).toBe("{ not json at all");

    // ...until a request is actually observed, which is a reason to write.
    store.record({ baseUrl: "https://api.example/v1", model: "glm-5.3" }, { ok: true, at: NOW });
    await store.flush();
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1 });
    await rm(dir, { recursive: true, force: true });
  });

  it("ignores a file it does not understand rather than reading it wrong", async () => {
    const dir = await freshHome();
    const warnings: string[] = [];
    await writeFile(routesFile({ KICODE_HOME: dir }), JSON.stringify({ version: 99, routes: { anything: 1 } }), "utf8");

    const store = await RouteHealth.load({ env: { KICODE_HOME: dir }, now: () => NOW, warn: (message) => warnings.push(message) });

    expect(store.lines(NOW)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not a route-health file");
    await rm(dir, { recursive: true, force: true });
  });

  it("waits for the debounce before touching the disk", async () => {
    const dir = await freshHome();
    const file = routesFile({ KICODE_HOME: dir });
    const store = await RouteHealth.load({ env: { KICODE_HOME: dir }, now: () => NOW, debounceMs: 60_000 });

    store.record({ baseUrl: "https://api.example/v1", model: "glm-5.3" }, { ok: true, at: NOW });
    await expect(readFile(file, "utf8")).rejects.toThrow();

    await store.flush();
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1 });
    store.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it("lists every route worst state first, with the reason", async () => {
    const dir = await freshHome();
    const store = await RouteHealth.load({ env: { KICODE_HOME: dir }, now: () => NOW, debounceMs: 0 });

    store.record({ baseUrl: "https://api.example/v1", model: "healthy" }, { ok: true, at: NOW });
    store.record({ baseUrl: "https://api.example/v1", model: "refused" }, { ok: false, status: 403, reason: "the key was refused (HTTP 403)", at: NOW });
    store.record(
      { baseUrl: "https://api.example/v1", model: "spent" },
      {
        ok: false,
        status: 429,
        reason: "rate-limited (HTTP 429)",
        at: NOW,
        quota: { scope: "requests", window: "day", limit: 50, remaining: 0, resetAt: NOW + 3_600_000, source: "probe" },
      },
    );

    const lines = store.lines(NOW);
    expect(lines.map((line) => `${line.ref.model}:${line.state}`)).toEqual(["refused:broken", "spent:capped", "healthy:healthy"]);
    expect(lines[0]?.detail).toContain("the key was refused (HTTP 403)");
    expect(lines[1]?.detail).toContain("0 of 50 requests left");
    expect(lines[1]?.detail).toContain("resets in 1h 0m");
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips what it wrote", async () => {
    const dir = await freshHome();
    const ref = { baseUrl: "https://api.example/v1", model: "glm-5.3" };
    const first = await RouteHealth.load({ env: { KICODE_HOME: dir }, now: () => NOW, debounceMs: 0 });

    first.record(ref, { ok: false, status: 503, reason: "HTTP 503", at: NOW });
    first.record(ref, { ok: true, at: NOW + 1_000 });
    await first.flush();

    const second = await RouteHealth.load({ env: { KICODE_HOME: dir }, now: () => NOW + 2_000 });
    expect(second.get(ref)?.recent).toHaveLength(2);
    expect(healthState(second.get(ref), NOW + 2_000)).toBe("healthy");
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the ring bounded", async () => {
    const dir = await freshHome();
    const store = await RouteHealth.load({ env: { KICODE_HOME: dir }, now: () => NOW, debounceMs: 0 });
    const ref = { baseUrl: "https://api.example/v1", model: "glm-5.3" };

    for (let index = 0; index < 40; index++) store.record(ref, { ok: index % 2 === 0, at: NOW + index });

    expect(store.get(ref)?.recent).toHaveLength(32);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("wording", () => {
  it("measures a wait the way a person would say it", () => {
    expect(duration(7_660)).toBe("8s");
    expect(duration(120_000)).toBe("2m 0s");
    expect(duration(3 * 3_600_000 + 120_000)).toBe("3h 2m");
  });

  it("says just now rather than 0s ago", () => {
    expect(relative(new Date(NOW - 1_000).toISOString(), NOW)).toBe("just now");
    expect(relative(new Date(NOW - 12 * 60_000).toISOString(), NOW)).toBe("12m 0s ago");
    expect(relative(undefined, NOW)).toBe("");
  });

  it("redacts anything that looks like a credential, and keeps one line", () => {
    const redacted = redact("bad key\nsk-abcdef1234567890 token=deadbeefdeadbeefdeadbeefdeadbeef");
    expect(redacted).not.toContain("abcdef1234567890");
    expect(redacted).not.toContain("deadbeefdeadbeefdeadbeefdeadbeef");
    expect(redacted).not.toContain("\n");
  });

  it("keeps a month's pruning window honest", () => {
    expect(PRUNE_AFTER_MS).toBe(30 * DAY);
  });
});
