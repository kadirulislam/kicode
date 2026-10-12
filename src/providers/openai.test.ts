import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../types";
import { OpenAIProvider, listModels, formatModelPrice } from "./openai";

/**
 * A deliberately tiny chunk size proves the parser reassembles frames that are
 * split mid-line and mid-token by the network.
 */
function streamFrom(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

function providerFor(sse: string, chunkSize = 7): OpenAIProvider {
  const fetchImpl = (async () =>
    new Response(streamFrom(sse, chunkSize), { status: 200 })) as unknown as typeof fetch;
  return new OpenAIProvider({ apiKey: "test-key", baseUrl: "https://example.com/v1", fetchImpl });
}

/**
 * A provider whose requests are captured and whose replies are scripted.
 *
 * `baseUrl` is a parameter because one fact is remembered per endpoint — that it
 * refused `stream_options` — so two tests must not share a host.
 */
function recording(
  replies: readonly (() => Response)[],
  baseUrl = "https://example.com/v1",
): { provider: OpenAIProvider; bodies: Record<string, unknown>[]; calls: () => number } {
  const bodies: Record<string, unknown>[] = [];
  let call = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const reply = replies[Math.min(call, replies.length - 1)];
    call += 1;
    return reply!();
  }) as unknown as typeof fetch;

  return { provider: new OpenAIProvider({ apiKey: "test-key", baseUrl, fetchImpl }), bodies, calls: () => call };
}

/** A complete one-message stream, with an optional usage frame before `[DONE]`. */
function answerSse(usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): string {
  return [
    chunk({ role: "assistant", content: "hi" }),
    chunk({}, "stop"),
    ...(usage ? [`data: ${JSON.stringify({ choices: [], usage })}\n\n`] : []),
    "data: [DONE]\n\n",
  ].join("");
}

async function collect(provider: OpenAIProvider): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream({ model: "test-model", messages: [{ role: "user", content: "hi" }] })) {
    events.push(event);
  }
  return events;
}

/** Builds a real SSE frame from an object, so the JSON is never hand-escaped. */
function chunk(delta: unknown, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

function textOf(events: StreamEvent[]): string {
  return events
    .filter((event): event is Extract<StreamEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.delta)
    .join("");
}

function finishOf(events: StreamEvent[]): Extract<StreamEvent, { type: "finish" }> {
  const finish = events.find((event) => event.type === "finish");
  if (!finish || finish.type !== "finish") throw new Error("expected a finish event");
  return finish;
}

describe("OpenAIProvider.stream", () => {
  it("streams text deltas and finishes with the assembled message", async () => {    const sse = [
      chunk({ role: "assistant", content: "Hel" }),
      chunk({ content: "lo" }),
      chunk({}, "stop"),
      "data: [DONE]\n\n",
    ].join("");

    const events = await collect(providerFor(sse));

    expect(textOf(events)).toBe("Hello");
    expect(finishOf(events).message).toEqual({ role: "assistant", content: "Hello" });
    expect(finishOf(events).finishReason).toBe("stop");
  });

  it("reassembles one tool call whose arguments arrive in fragments", async () => {
    const sse = [
      chunk({
        role: "assistant",
        tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } }],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }),
      chunk({}, "tool_calls"),
      "data: [DONE]\n\n",
    ].join("");

    const events = await collect(providerFor(sse, 5));
    const finish = finishOf(events);

    expect(finish.finishReason).toBe("tool_calls");
    expect(finish.message.content).toBeNull();
    expect(finish.message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } },
    ]);
    expect(events.filter((event) => event.type === "tool-call")).toHaveLength(1);
  });

  it("keeps parallel tool calls separate and ordered by index", async () => {
    const sse = [
      chunk({
        role: "assistant",
        tool_calls: [
          { index: 0, id: "call_a", type: "function", function: { name: "read", arguments: "{}" } },
          { index: 1, id: "call_b", type: "function", function: { name: "read", arguments: '{"path"' } },
        ],
      }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: ':"b.txt"}' } }] }),
      chunk({}, "tool_calls"),
      "data: [DONE]\n\n",
    ].join("");

    const calls = finishOf(await collect(providerFor(sse, 3))).message.tool_calls ?? [];

    expect(calls.map((call) => call.id)).toEqual(["call_a", "call_b"]);
    expect(calls[1]?.function.arguments).toBe('{"path":"b.txt"}');
  });

  it("upgrades a misleading `stop` to `tool_calls` when tools were requested", async () => {
    const sse = [
      chunk({
        role: "assistant",
        tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
      }),
      chunk({}, "stop"),
      "data: [DONE]\n\n",
    ].join("");

    expect(finishOf(await collect(providerFor(sse))).finishReason).toBe("tool_calls");
  });

  it("hints at a missing local server rather than only saying fetch failed", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const provider = new OpenAIProvider({ apiKey: "k", baseUrl: "http://localhost:8787/v1", fetchImpl });

    await expect(collect(provider)).rejects.toThrow(/npm run mock/);
  });

  it("does not add that hint for a remote endpoint", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const provider = new OpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com/v1", fetchImpl });

    await expect(collect(provider)).rejects.not.toThrow(/npm run mock/);
  });

  it("surfaces the provider's message on an HTTP error instead of hanging", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 })) as unknown as typeof fetch;
    const provider = new OpenAIProvider({ apiKey: "bad", baseUrl: "https://example.com/v1", fetchImpl });

    await expect(collect(provider)).rejects.toThrow(/Invalid API key/);
  });

  it("names both suspects on an opencode 401 rather than asserting the gate", async () => {
    // The exact shape the gateway returns — but "Invalid API key" is what the
    // gate says about a third-party client *and* what a genuinely wrong key
    // says. The key may be fine or it may be bad, so the error names both and
    // the one request that tells them apart, instead of sending a user with a
    // typo'd key hunting for a policy.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "AuthError", message: "Invalid API key." } }), {
        status: 401,
      })) as unknown as typeof fetch;
    const provider = new OpenAIProvider({ apiKey: "test-mock-api-key", baseUrl: "https://opencode.ai/zen/v1", fetchImpl });

    await expect(collect(provider)).rejects.toThrow(/either the key or the client gate/);
    await expect(collect(provider)).rejects.toThrow(/--probe --model/);
  });

  it("names the client restriction on a bare 403, whatever the body says", async () => {
    // What the free models answer now: a 403 with no OpenCode-shaped body at
    // all. A 403 is not a rejected key — that is a 401 — so the note must not
    // wait for the body to confirm it, or the user goes hunting for a key that
    // is fine.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "Forbidden" } }), { status: 403 })) as unknown as typeof fetch;
    const provider = new OpenAIProvider({ apiKey: "test-mock-api-key", baseUrl: "https://opencode.ai/zen/v1", fetchImpl });

    await expect(collect(provider)).rejects.toThrow(/restricted to the OpenCode client/);
  });

  it("does not blame opencode's client restriction on another gateway", async () => {
    // "Invalid API key" is a generic message; the hint is about the endpoint,
    // not the words.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 })) as unknown as typeof fetch;
    const provider = new OpenAIProvider({ apiKey: "bad", baseUrl: "https://example.com/v1", fetchImpl });

    await expect(collect(provider)).rejects.not.toThrow(/OpenCode client/);
  });

  it("sends the session header and an honest user agent to gateways that validate clients", async () => {
    // OpenCode Go's documented requirements: a product user agent, not an SDK
    // name, and a stable per-conversation id. Their validated-clients list is
    // exactly this.
    let headers: Record<string, string> = {};
    const sse = [chunk({ role: "assistant", content: "hi" }), chunk({}, "stop"), "data: [DONE]\n\n"].join("");
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response(streamFrom(sse), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new OpenAIProvider({
      apiKey: "k",
      baseUrl: "https://opencode.ai/zen/go/v1",
      fetchImpl,
      sessionId: "session-1",
      userAgent: "kicode/0.1.0",
    });

    await collect(provider);

    expect(headers["x-opencode-session"]).toBe("session-1");
    expect(headers["User-Agent"]).toBe("kicode/0.1.0");
  });

  it("sends neither header when the caller has none", async () => {
    let headers: Record<string, string> = {};
    const sse = [chunk({ role: "assistant", content: "hi" }), chunk({}, "stop"), "data: [DONE]\n\n"].join("");
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response(streamFrom(sse), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new OpenAIProvider({ apiKey: "k", baseUrl: "https://example.com/v1", fetchImpl });

    await collect(provider);

    expect(headers["x-opencode-session"]).toBeUndefined();
    expect(headers["User-Agent"]).toBeUndefined();
  });

  it("reports what the gateway said about its limits, before the first token", async () => {
    const sse = [chunk({ role: "assistant", content: "Hi" }), chunk({}, "stop"), "data: [DONE]\n\n"].join("");
    const fetchImpl = (async () =>
      new Response(streamFrom(sse), {
        status: 200,
        headers: {
          "x-ratelimit-limit-requests": "14400",
          "x-ratelimit-remaining-requests": "14370",
          "x-ratelimit-reset-requests": "2m59.56s",
        },
      })) as unknown as typeof fetch;
    const provider = new OpenAIProvider({ apiKey: "k", baseUrl: "https://api.groq.com/openai/v1", fetchImpl });

    const events = await collect(provider);
    const quota = events.find((event) => event.type === "quota");

    // Ahead of the text, so the route layer can act on it before an answer.
    expect(events[0]?.type).toBe("quota");
    if (quota?.type !== "quota") throw new Error("expected a quota event");
    expect(quota.reading.requests).toMatchObject({ scope: "requests", window: "day", remaining: 14370 });
  });

  it("stays silent when the gateway reports nothing", async () => {
    const sse = [chunk({ role: "assistant", content: "Hi" }), chunk({}, "stop"), "data: [DONE]\n\n"].join("");

    expect((await collect(providerFor(sse))).some((event) => event.type === "quota")).toBe(false);
  });

  it("still reports the limits on the refusal it is about to throw", async () => {
    // A 429's headers are the one place the route layer learns when this route
    // is worth trying again, so they must not be lost with the error.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "retry-after": "3" },
      })) as unknown as typeof fetch;
    const provider = new OpenAIProvider({ apiKey: "k", baseUrl: "https://example.com/v1", fetchImpl });

    const events: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of provider.stream({ model: "m", messages: [{ role: "user", content: "hi" }] })) {
          events.push(event);
        }
      })(),
    ).rejects.toThrow(/rate limited/);

    const quota = events.find((event) => event.type === "quota");
    if (quota?.type !== "quota") throw new Error("expected a quota event");
    expect(quota.reading.retryAfterMs).toBe(3_000);
  });
});

describe("a route with no key", () => {
  it("refuses before any request when the caller names the missing variable", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(streamFrom(answerSse()), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new OpenAIProvider({
      apiKey: "",
      baseUrl: "https://gw.example/v1",
      fetchImpl,
      missingKeyHint: "No API key for gw.example — set GW_API_KEY.",
    });

    await expect(collect(provider)).rejects.toThrow("No API key for gw.example");
    // The gateway never saw this: nothing was sent to 401 about.
    expect(calls).toBe(0);
  });

  it("still sends keyless when nothing names a variable (a local server)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(streamFrom(answerSse()), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new OpenAIProvider({ apiKey: "", baseUrl: "http://localhost:11434/v1", fetchImpl });

    expect(textOf(await collect(provider))).toBe("hi");
    expect(calls).toBe(1);
  });
});

describe("asking for token counts", () => {
  it("opts into the usage block, which a streamed answer does not carry by default", async () => {    // Without this the `finish` event has no usage, so the line under an answer
    // has no rate and the session's token budget never moves.
    const { provider, bodies } = recording([() => new Response(streamFrom(answerSse()), { status: 200 })]);
    await collect(provider);

    expect(bodies[0]?.stream_options).toEqual({ include_usage: true });
  });

  it("reads the usage frame a gateway sends at the end of the stream", async () => {
    const usage = { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 };
    const { provider } = recording([() => new Response(streamFrom(answerSse(usage)), { status: 200 })]);

    expect(finishOf(await collect(provider)).usage).toEqual({ promptTokens: 100, completionTokens: 40, totalTokens: 140 });
  });

  it("drops the field, and finishes the turn, when the gateway refuses it by name", async () => {
    const refuse = () =>
      new Response(JSON.stringify({ error: { message: "Unrecognized request argument supplied: stream_options" } }), {
        status: 400,
      });
    const ok = () => new Response(streamFrom(answerSse()), { status: 200 });

    const { provider, bodies, calls } = recording([refuse, ok], "https://strict.example.com/v1");
    expect(textOf(await collect(provider))).toBe("hi");

    expect(bodies[0]?.stream_options).toEqual({ include_usage: true });
    expect(bodies[1]?.stream_options).toBeUndefined();

    // And the endpoint is not asked again: the refusal is a property of the
    // gateway, so paying for it once is enough.
    await collect(provider);
    expect(calls()).toBe(3);
    expect(bodies[2]?.stream_options).toBeUndefined();
  });

  it("keeps the field when a 400 is about something else", async () => {
    const other = () => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 400 });
    const { provider, calls } = recording([other], "https://pickier.example.com/v1");

    await expect(collect(provider)).rejects.toThrow(/model not found/);
    expect(calls()).toBe(1);
  });
});

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("listModels", () => {
  it("reads the OpenAI `data` shape", async () => {
    const models = await listModels({
      apiKey: "k",
      baseUrl: "https://example.com/v1",
      fetchImpl: jsonFetch({ data: [{ id: "a" }, { id: "b" }] }),
    });

    expect(models.map((model) => model.id)).toEqual(["a", "b"]);
  });

  it("also reads a bare `models` array", async () => {
    const models = await listModels({
      apiKey: "k",
      baseUrl: "https://example.com/v1",
      fetchImpl: jsonFetch({ models: ["a", { id: "b" }, { nope: true }] }),
    });

    expect(models.map((model) => model.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list rather than throwing on an unexpected shape", async () => {
    expect(await listModels({ apiKey: "k", baseUrl: "https://example.com/v1", fetchImpl: jsonFetch({}) })).toEqual([]);
  });

  it("points at --models when the request 404s", async () => {
    const provider = { apiKey: "k", baseUrl: "https://example.com/v1", fetchImpl: jsonFetch({}, 404) };

    await expect(listModels(provider)).rejects.toThrow(/--models/);
  });

  it("normalises a trailing slash instead of doubling it", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await listModels({ apiKey: "k", baseUrl: "https://example.com/v1/", fetchImpl });

    expect(seen[0]).toBe("https://example.com/v1/models");
  });

  it("normalises the extra metadata some gateways return", async () => {
    const [model] = await listModels({
      apiKey: "k",
      baseUrl: "https://example.com/v1",
      fetchImpl: jsonFetch({ data: [{ id: "big", label: "Big", tier: "high", context_length: 200_000, tool_call: true }] }),
    });

    expect(model).toEqual({
      id: "big",
      label: "Big",
      tier: "high",
      contextLength: 200_000,
      supportsTools: true,
      free: false,
    });
  });

  it("reads tool support from function_call too", async () => {
    const [model] = await listModels({
      apiKey: "k",
      baseUrl: "https://example.com/v1",
      fetchImpl: jsonFetch({ data: [{ id: "x", function_call: false }] }),
    });

    expect(model?.supportsTools).toBe(false);
  });

  it("recognises a free route by its id", async () => {
    const models = await listModels({
      apiKey: "k",
      baseUrl: "https://example.com/v1",
      fetchImpl: jsonFetch({ data: ["cheap:free", "pricey"] }),
    });

    expect(models.map((model) => model.free)).toEqual([true, false]);
  });

  it("leaves unknown metadata undefined rather than inventing it", async () => {
    const [model] = await listModels({
      apiKey: "k",
      baseUrl: "https://example.com/v1",
      fetchImpl: jsonFetch({ data: ["only-an-id"] }),
    });

    expect(model).toEqual({
      id: "only-an-id",
      label: undefined,
      tier: undefined,
      contextLength: undefined,
      supportsTools: undefined,
      free: false,
    });
  });

  it("recognises 0.00 input and output token price as free", async () => {
    const models = await listModels({
      apiKey: "k",
      baseUrl: "https://example.com/v1",
      fetchImpl: jsonFetch({
        data: [
          { id: "custom-zero", pricing: { prompt: "0.00", completion: "0.00" } },
          { id: "custom-paid", pricing: { prompt: "0.00000015", completion: "0.00000060" } },
        ],
      }),
    });

    expect(models[0]?.free).toBe(true);
    expect(models[0]?.promptPrice).toBe(0);
    expect(models[0]?.completionPrice).toBe(0);

    expect(models[1]?.free).toBe(false);
    expect(models[1]?.promptPrice).toBe(0.00000015);
    expect(models[1]?.completionPrice).toBe(0.00000060);
  });

  it("formats model prices correctly", () => {
    expect(formatModelPrice(0, 0)).toBe("$0.00");
    expect(formatModelPrice(0.00000015, 0.0000006)).toBe("$0.15/$0.60/M");
    expect(formatModelPrice(1.5, 3.0)).toBe("$1.50/$3.00");
    expect(formatModelPrice()).toBe("");
  });
});
