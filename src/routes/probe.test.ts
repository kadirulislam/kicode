import { describe, expect, it } from "vitest";
import { PROBE_TTL_MS, QuotaProbes, nextUtcMidnight, parseKeyPayload, probeUrl } from "./probe";

const NOW = Date.UTC(2026, 8, 30, 10, 0, 0);

/** A fetch that answers with one JSON body and counts the calls. */
function stubFetch(body: unknown, status = 200): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe("probeUrl", () => {
  it("finds the key endpoint on OpenRouter", () => {
    expect(probeUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1/key");
    expect(probeUrl("https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api/v1/key");
    expect(probeUrl("https://openrouter.ai/api/v1/chat/completions")).toBe("https://openrouter.ai/api/v1/key");
  });

  it("has no probe for anyone else", () => {
    // Detection is by host: renaming a provider must not change its behaviour.
    expect(probeUrl("https://api.groq.com/openai/v1")).toBeNull();
    expect(probeUrl("not a url")).toBeNull();
  });
});

describe("parseKeyPayload", () => {
  it("reads the free-model daily counter, the one that gates :free routes", () => {
    const reading = parseKeyPayload({ data: { free_model_daily_requests: { used: 47, limit: 50, remaining: 3 } } }, NOW);

    expect(reading?.requests).toEqual({
      scope: "requests",
      window: "day",
      limit: 50,
      remaining: 3,
      resetAt: nextUtcMidnight(NOW),
      source: "probe",
    });
  });

  it("falls back to the key's credit cap when there is no free counter", () => {
    const reading = parseKeyPayload({ data: { limit: 10, limit_remaining: 4.5 } }, NOW);

    expect(reading?.requests?.scope).toBe("credits");
    expect(reading?.requests?.remaining).toBe(4.5);
    // The reset period is prose in their docs, so it is honestly unknown.
    expect(reading?.requests?.resetAt).toBeNull();
  });

  it("says nothing rather than guessing", () => {
    expect(parseKeyPayload({ data: {} }, NOW)).toBeNull();
    expect(parseKeyPayload({}, NOW)).toBeNull();
    expect(parseKeyPayload(null, NOW)).toBeNull();
  });
});

describe("nextUtcMidnight", () => {
  it("is the next UTC day boundary, not a local one", () => {
    expect(nextUtcMidnight(Date.UTC(2026, 8, 30, 10, 0, 0))).toBe(Date.UTC(2026, 9, 1, 0, 0, 0));
    // A minute before midnight still lands on the same boundary.
    expect(nextUtcMidnight(Date.UTC(2026, 8, 30, 23, 59, 0))).toBe(Date.UTC(2026, 9, 1, 0, 0, 0));
  });
});

describe("QuotaProbes", () => {
  const route = { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" };

  it("asks once and caches the answer", async () => {
    const { fetchImpl, calls } = stubFetch({ data: { free_model_daily_requests: { limit: 50, remaining: 12 } } });
    const probes = new QuotaProbes({ fetchImpl });

    const first = await probes.get(route, { now: NOW });
    const second = await probes.get(route, { now: NOW + PROBE_TTL_MS - 1 });

    expect(first?.requests?.remaining).toBe(12);
    expect(second?.requests?.remaining).toBe(12);
    expect(calls()).toBe(1);
  });

  it("asks again once the answer is stale", async () => {
    const { fetchImpl, calls } = stubFetch({ data: { free_model_daily_requests: { limit: 50, remaining: 12 } } });
    const probes = new QuotaProbes({ fetchImpl });

    await probes.get(route, { now: NOW });
    await probes.get(route, { now: NOW + PROBE_TTL_MS });

    expect(calls()).toBe(2);
  });

  it("can be told its answer is stale after a 429", async () => {
    const { fetchImpl, calls } = stubFetch({ data: { free_model_daily_requests: { limit: 50, remaining: 0 } } });
    const probes = new QuotaProbes({ fetchImpl });

    await probes.get(route, { now: NOW });
    probes.invalidate(route.baseUrl);
    await probes.get(route, { now: NOW + 1 });

    expect(calls()).toBe(2);
  });

  it("stays silent when the endpoint does not answer", async () => {
    const { fetchImpl } = stubFetch({ error: "nope" }, 401);
    const probes = new QuotaProbes({ fetchImpl });

    await expect(probes.get(route, { now: NOW })).resolves.toBeNull();
  });

  it("does not even call an endpoint it cannot ask", async () => {
    const { fetchImpl, calls } = stubFetch({});
    const probes = new QuotaProbes({ fetchImpl });

    const reading = await probes.get({ baseUrl: "https://api.groq.com/openai/v1", apiKey: "k" }, { now: NOW });

    expect(reading).toBeNull();
    expect(calls()).toBe(0);
  });
});
