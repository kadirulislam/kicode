import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatRequest, Provider, StreamEvent } from "../types";
import type { FallbackRoute } from "../config";
import type { RouteOutcome } from "../routes/health";
import { FallbackProvider, fallbackReason, isRetryable } from "./fallback";
import { MissingKeyError, OpenAIProvider, ProviderError } from "./openai";

const route = (model: string, label = model): FallbackRoute => ({
  label,
  provider: null,
  baseUrl: "https://gw.example/v1",
  apiKey: "k",
  model,
});

const request: ChatRequest = {
  model: "primary",
  messages: [{ role: "user", content: "hi" } as ChatMessage],
};

/** A route that fails outright, before sending anything. */
function failing(status?: number): Provider {
  return {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      throw new ProviderError(`failed with ${status ?? "no status"}`, status);
    },
  };
}

/** A route that answers with one line of text. */
function answering(text: string): Provider {
  return {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      yield { type: "text", delta: text };
      yield { type: "finish", message: { role: "assistant", content: text }, finishReason: "stop" };
    },
  };
}

/** Answers with text, then dies mid-stream, the way a dropped connection does. */
function startsThenFails(): Provider {
  return {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      yield { type: "text", delta: "half an ans" };
      throw new ProviderError("connection reset", 500);
    },
  };
}

async function collect(provider: Provider, signal?: AbortSignal): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(signal ? { ...request, signal } : request)) events.push(event);
  return events;
}

describe("isRetryable", () => {
  it("retries a quota, a missing model, a flaky gateway, or no answer at all", () => {
    for (const status of [402, 404, 429, 500, 503]) expect(isRetryable(new ProviderError("x", status)), `${status}`).toBe(true);
    // No status is a connection/DNS failure: the next route may reach.
    expect(isRetryable(new ProviderError("fetch failed"))).toBe(true);
  });

  it("does not retry a bad key, which is a mistake to be seen", () => {
    expect(isRetryable(new ProviderError("x", 401))).toBe(false);
    expect(isRetryable(new ProviderError("x", 403))).toBe(false);
    expect(isRetryable(new Error("not a provider error"))).toBe(false);
  });
});

describe("fallbackReason", () => {
  it("names the quota it recognised", () => {
    expect(fallbackReason(new ProviderError("x", 429))).toBe("rate-limited (HTTP 429)");
    expect(fallbackReason(new ProviderError("x", 402))).toBe("out of credit (HTTP 402)");
    expect(fallbackReason(new ProviderError("x"))).toBe("unreachable");
  });

  it("names a missing key, which the chain walks past", () => {
    expect(isRetryable(new MissingKeyError("No API key for gw.example — set GW_API_KEY."))).toBe(true);
    expect(fallbackReason(new MissingKeyError("No API key for gw.example — set GW_API_KEY."))).toBe("no API key");
  });
});

describe("routes with no key", () => {
  it("walks past a route with no key to one that has", async () => {
    // The keyless hop is the real provider: it throws before any request, so
    // this test touches no network and still proves the guard fires in-chain.
    const keyless = new OpenAIProvider({
      apiKey: "",
      baseUrl: "https://gw.example/v1",
      missingKeyHint: "No API key for gw.example — set GW_API_KEY.",
    });
    const provider = new FallbackProvider({
      routes: [{ ...route("a"), apiKey: "", keyHint: "No API key for gw.example — set GW_API_KEY." }, route("b")],
      makeProvider: (r) => (r.model === "a" ? keyless : answering("hello")),
      wait: async () => undefined,
    });

    const events = await collect(provider);

    expect(events[0]).toEqual({ type: "route", from: "a", to: "b", reason: "no API key" });
    expect(events.some((event) => event.type === "text" && event.delta === "hello")).toBe(true);
  });

  it("says which variable is missing when the only route has no key", async () => {
    const provider = new FallbackProvider({
      routes: [{ ...route("a"), apiKey: "", keyHint: "No API key for gw.example — set GW_API_KEY." }],
      wait: async () => undefined,
    });

    await expect(collect(provider)).rejects.toThrow("No API key for gw.example");
  });

  it("names the missing key on every route when none has one", async () => {
    const hint = "No API key for gw.example — set GW_API_KEY.";
    const provider = new FallbackProvider({
      routes: [
        { ...route("a"), apiKey: "", keyHint: hint },
        { ...route("b"), apiKey: "", keyHint: hint },
      ],
      wait: async () => undefined,
    });

    await expect(collect(provider)).rejects.toThrow(/Every route failed — a \(no API key\), b \(no API key\)/);
  });
});

describe("FallbackProvider", () => {
  it("replays the request on the next route, and says it did", async () => {
    const provider = new FallbackProvider({
      routes: [route("used-up", "gw/used-up"), route("free-alt", "gw/free-alt")],
      makeProvider: (r) => (r.model === "used-up" ? failing(429) : answering("hello")),
      wait: async () => undefined,
    });

    const events = await collect(provider);

    expect(events[0]).toEqual({ type: "route-wait", ms: 1_500, from: "gw/used-up", reason: "rate-limited (HTTP 429)" });
    expect(events[1]).toEqual({ type: "route", from: "gw/used-up", to: "gw/free-alt", reason: "rate-limited (HTTP 429)" });
    expect(events.some((event) => event.type === "text")).toBe(true);
    expect(events.at(-1)?.type).toBe("finish");
  });

  it("uses the backup route's model, not the one that was asked for", async () => {
    const seen: string[] = [];
    const provider = new FallbackProvider({
      routes: [route("used-up"), route("free-alt")],
      makeProvider: (r) => ({
        async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
          seen.push(request.model);
          if (r.model === "used-up") throw new ProviderError("x", 429);
          yield { type: "finish", message: { role: "assistant", content: "ok" }, finishReason: "stop" };
        },
      }),
    });

    await collect(provider);

    expect(seen).toEqual(["used-up", "free-alt"]);
  });

  it("never switches once the model has started answering", async () => {
    // Half an answer is still the answer the user is reading: another route
    // would rewrite it. The failure is reported instead.
    const second: Provider = { async *stream(): AsyncGenerator<StreamEvent, void, void> { throw new Error("must not be reached"); } };
    const provider = new FallbackProvider({
      routes: [route("primary"), route("backup")],
      makeProvider: (r) => (r.model === "primary" ? startsThenFails() : second),
    });

    await expect(collect(provider)).rejects.toThrow(/connection reset/);
  });

  it("does not route around a rejected key", async () => {
    let streams = 0;
    const provider = new FallbackProvider({
      routes: [route("bad-key"), route("backup")],
      makeProvider: () => ({
        async *stream(): AsyncGenerator<StreamEvent, void, void> {
          streams += 1;
          throw new ProviderError("failed with 401", 401);
        },
      }),
    });

    await expect(collect(provider)).rejects.toThrow(/failed with 401/);
    expect(streams).toBe(1);
  });

  it("reports every route when none of them answer", async () => {
    const provider = new FallbackProvider({
      routes: [route("a", "gw/a"), route("b", "gw/b")],
      makeProvider: () => failing(500),
      wait: async () => undefined,
    });

    await expect(collect(provider)).rejects.toThrow(/Every route failed — gw\/a .*gw\/b/);
  });

  it("leaves a cancellation alone rather than trying another route", async () => {
    const controller = new AbortController();
    controller.abort();
    let streams = 0;
    const provider = new FallbackProvider({
      routes: [route("a"), route("b")],
      makeProvider: () => ({
        async *stream(): AsyncGenerator<StreamEvent, void, void> {
          streams += 1;
          yield { type: "text", delta: "no" };
        },
      }),
    });

    await expect(collect(provider, controller.signal)).rejects.toThrow(/abort/i);
    // The turn was cancelled, not routed around: not one request was made.
    expect(streams).toBe(0);
  });

  it("still routes around a failure that arrived with its quota reading", async () => {
    // A 429 reports its headers and then throws. The reading is not the model
    // starting to answer, so it must not stop the fallback.
    let streams = 0;
    const provider = new FallbackProvider({
      routes: [route("used-up"), route("free-alt")],
      wait: async () => undefined,
      makeProvider: (r) => ({
        async *stream(): AsyncGenerator<StreamEvent, void, void> {
          streams += 1;
          if (r.model === "used-up") {
            yield { type: "quota", reading: { requests: null, tokens: null, retryAfterMs: 2_000 } };
            throw new ProviderError("rate limited", 429);
          }
          yield { type: "text", delta: "ok" };
          yield { type: "finish", message: { role: "assistant", content: "ok" }, finishReason: "stop" };
        },
      }),
    });

    const events = await collect(provider);

    expect(events.some((event) => event.type === "route")).toBe(true);
    expect(events.some((event) => event.type === "text")).toBe(true);
    expect(streams).toBe(2);
  });

  it("stays a plain provider when there is only one route", async () => {
    // The wrapped error message would only obscure the real one.
    const provider = new FallbackProvider({ routes: [route("only")], makeProvider: () => failing(401) });

    await expect(collect(provider)).rejects.toThrow(/failed with 401/);
    expect(provider.routes.map((entry) => entry.model)).toEqual(["only"]);
  });
});

describe("FallbackProvider outcomes", () => {
  it("reports which route answered, and what it said about its limits", async () => {
    const outcomes: { model: string; outcome: RouteOutcome }[] = [];
    const reading = {
      requests: { scope: "requests" as const, window: "day" as const, limit: 50, remaining: 12, resetAt: null, source: "headers" as const },
      tokens: null,
      retryAfterMs: null,
    };
    const provider = new FallbackProvider({
      routes: [route("primary")],
      onOutcome: (r, outcome) => outcomes.push({ model: r.model, outcome }),
      makeProvider: () => ({
        async *stream(): AsyncGenerator<StreamEvent, void, void> {
          yield { type: "quota", reading };
          yield { type: "text", delta: "hi" };
          yield { type: "finish", message: { role: "assistant", content: "hi" }, finishReason: "stop" };
        },
      }),
    });

    await collect(provider);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.model).toBe("primary");
    expect(outcomes[0]?.outcome.ok).toBe(true);
    expect(outcomes[0]?.outcome.quota?.remaining).toBe(12);
  });

  it("reports the failing route, not the one that took over", async () => {
    const outcomes: { model: string; outcome: RouteOutcome }[] = [];
    const provider = new FallbackProvider({
      routes: [route("used-up"), route("free-alt")],
      onOutcome: (r, outcome) => outcomes.push({ model: r.model, outcome }),
      wait: async () => undefined,
      makeProvider: (r) =>
        r.model === "used-up"
          ? {
              async *stream(): AsyncGenerator<StreamEvent, void, void> {
                yield { type: "quota", reading: { requests: null, tokens: null, retryAfterMs: 3_000 } };
                throw new ProviderError("rate limited", 429);
              },
            }
          : answering("hello"),
    });

    await collect(provider);

    expect(outcomes.map((entry) => `${entry.model}:${entry.outcome.ok}`)).toEqual(["used-up:false", "free-alt:true"]);
    expect(outcomes[0]?.outcome.status).toBe(429);
    expect(outcomes[0]?.outcome.reason).toBe("rate-limited (HTTP 429)");
    expect(outcomes[0]?.outcome.retryAfterMs).toBe(3_000);
  });

  it("does not blame a route for a turn the user cancelled", async () => {
    const outcomes: string[] = [];
    const provider = new FallbackProvider({
      routes: [route("primary")],
      onOutcome: (r) => outcomes.push(r.model),
      makeProvider: () => ({
        async *stream(): AsyncGenerator<StreamEvent, void, void> {
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          throw error;
        },
      }),
    });

    await expect(collect(provider)).rejects.toThrow(/aborted/);
    expect(outcomes).toEqual([]);
  });

  it("pauses before the next route when a rate limit names a wait, and says it did", async () => {
    const waits: number[] = [];
    const provider = new FallbackProvider({
      routes: [route("used-up", "gw/used-up"), route("free-alt", "gw/free-alt")],
      makeProvider: (r) => (r.model === "used-up" ? failing(429) : answering("hello")),
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    const events = await collect(provider);

    expect(events).toContainEqual({ type: "route-wait", ms: 1_500, from: "gw/used-up", reason: "rate-limited (HTTP 429)" });
    expect(waits).toEqual([1_500]);
    expect(events.some((event) => event.type === "text")).toBe(true);
  });

  it("honours the wait the quota reading asked for, capped", async () => {
    const waits: number[] = [];
    const provider = new FallbackProvider({
      routes: [route("used-up"), route("free-alt")],
      makeProvider: (r) => (r.model === "used-up" ? limitedWith(45_000) : answering("ok")),
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    await collect(provider);
    expect(waits).toEqual([45_000]);

    // A "come back tomorrow" is honoured only up to the ceiling, so the session
    // is never parked on one gateway's schedule.
    const capped = new FallbackProvider({
      routes: [route("used-up"), route("free-alt")],
      makeProvider: (r) => (r.model === "used-up" ? limitedWith(90_000) : answering("ok")),
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    await collect(capped);
    expect(waits.at(-1)).toBe(60_000);
  });

  it("does not pause for a failure that is not a rate limit", async () => {
    const waits: number[] = [];
    const provider = new FallbackProvider({
      routes: [route("down", "gw/down"), route("up", "gw/up")],
      makeProvider: (r) => (r.model === "down" ? failing(502) : answering("ok")),
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    const events = await collect(provider);
    expect(waits).toEqual([]);
    expect(events.some((event) => event.type === "route-wait")).toBe(false);
  });

  it("appends the lazily discovered free routes once the declared chain runs dry", async () => {
    let asked = 0;
    const provider = new FallbackProvider({
      routes: [route("primary", "gw/primary")],
      makeProvider: (r) => (r.model === "primary" ? failing(429) : answering(`from ${r.model}`)),
      moreRoutes: async () => {
        asked += 1;
        return [route("free-b", "gw/free-b"), route("free-c", "gw/free-c")];
      },
    });

    const events = await collect(provider);

    expect(events.some((event) => event.type === "route-wait")).toBe(true);
    expect(events.some((event) => event.type === "text" && event.delta.includes("from free-b"))).toBe(true);
    // One fetch per provider: the second failure walks the chain it already has.
    expect(asked).toBe(1);
  });

  it("does not re-add a route that is already in the chain", async () => {
    const provider = new FallbackProvider({
      routes: [route("primary", "gw/primary"), route("free-b", "gw/free-b")],
      makeProvider: (r) => (r.model === "primary" ? failing(429) : answering(`from ${r.model}`)),
      wait: async () => undefined,
      moreRoutes: async () => [route("free-b", "gw/free-b"), route("free-c", "gw/free-c")],
    });

    const events = await collect(provider);
    // free-b was already declared; the answer must come from it, not from a copy.
    expect(events.some((event) => event.type === "text" && event.delta.includes("from free-b"))).toBe(true);
    expect(events.filter((event) => event.type === "route")).toHaveLength(1);
  });

  it("carries on with what it had when the discovery fails", async () => {
    const provider = new FallbackProvider({
      routes: [route("primary", "gw/primary")],
      makeProvider: () => failing(429),
      wait: async () => undefined,
      moreRoutes: async () => {
        throw new Error("gateway will not say");
      },
    });

    // One route, no discovery: the original error is the answer, not a
    // failure of the discovery itself.
    await expect(collect(provider)).rejects.toThrow(/failed with 429/);
  });

  it("says what to do when every route is rate-limited", async () => {
    const provider = new FallbackProvider({
      routes: [route("a", "gw/a"), route("b", "gw/b")],
      makeProvider: () => failing(429),
      wait: async () => undefined,
    });

    await expect(collect(provider)).rejects.toThrow(/Every route is rate-limited/);
  });
});

/** A route that reports its quota's Retry-After, then fails, the way a 429 does. */
function limitedWith(retryAfterMs: number): Provider {
  return {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      yield { type: "quota", reading: { requests: null, tokens: null, retryAfterMs } };
      throw new ProviderError("failed with 429", 429);
    },
  };
}
