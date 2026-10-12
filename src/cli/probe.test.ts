import { describe, expect, it } from "vitest";
import { probeEndpoint, probeModels, renderProbe } from "./probe";

/**
 * Scripted fetches, no network. Each test plays the gateway's part: a model
 * list that answers, a chat that streams, or the refusal the probe is meant
 * to explain.
 */

const MODELS = JSON.stringify({
  data: [{ id: "glm-5.3-flash" }, { id: "mimo-v2.6-flash-free" }, { id: "claude-opus-5" }],
});

const modelList = (): Response => new Response(MODELS, { status: 200 });

/** A one-token streamed reply, shaped like a real gateway's. */
const chatOk = (): Response =>
  new Response(
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const chatError = (status: number, body: unknown): (() => Response) => () =>
  new Response(JSON.stringify(body), { status });

/** A fetch that answers the models call and plays `chat` for completions. */
function fetchFor(chat: () => Response): typeof fetch {
  return (async (url: string | URL) => {
    if (String(url).endsWith("/models")) return modelList();
    return chat();
  }) as unknown as typeof fetch;
}

describe("probeEndpoint", () => {
  it("reports a working endpoint in two ok steps", async () => {
    const result = await probeEndpoint({
      apiKey: "k",
      baseUrl: "https://example.com/v1",
      fetchImpl: fetchFor(chatOk),
    });

    expect(result.steps.map((step) => step.ok)).toEqual([true, true]);
    expect(result.steps[0]?.detail).toContain("3 models listed (1 free)");
    expect(result.steps[1]?.detail).toContain("key and client are accepted");
    expect(result.verdict).toContain("accepts KiCode");
  });

  it("stops at the model list when the endpoint is unreachable", async () => {
    const result = await probeEndpoint({
      apiKey: "k",
      baseUrl: "https://example.com/v1",
      fetchImpl: (async () => {
        throw new Error("fetch failed");
      }) as unknown as typeof fetch,
    });

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.ok).toBe(false);
    expect(result.verdict).toContain("could not reach the model list");
  });

  it("names both suspects from the gateway's own error", async () => {
    const result = await probeEndpoint({
      apiKey: "test-mock-api-key",
      baseUrl: "https://opencode.ai/zen/v1",
      fetchImpl: fetchFor(
        chatError(401, { type: "error", error: { type: "AuthError", message: "Invalid API key." } }),
      ),
    });

    expect(result.steps[1]?.ok).toBe(false);
    expect(result.verdict).toContain("client gate");
    expect(result.verdict).toContain("--probe --model");
  });

  it("tells a wrong key from a restricted client", async () => {
    const result = await probeEndpoint({
      apiKey: "bad",
      baseUrl: "https://example.com/v1",
      fetchImpl: fetchFor(chatError(401, { error: { message: "no such key" } })),
    });

    expect(result.verdict).toContain("key was refused");
    expect(result.verdict).not.toContain("client-restricted");
  });

  it("points at --model when the probe model does not exist there", async () => {
    const result = await probeEndpoint({
      apiKey: "k",
      baseUrl: "https://example.com/v1",
      fetchImpl: fetchFor(chatError(404, { error: { message: "no such model" } })),
    });

    expect(result.verdict).toContain("--model");
  });

  it("calls rate limits what they are: not a client problem", async () => {
    const result = await probeEndpoint({
      apiKey: "k",
      baseUrl: "https://example.com/v1",
      fetchImpl: fetchFor(chatError(429, { error: { message: "slow down" } })),
    });

    expect(result.verdict).toContain("client is fine");
  });

  it("uses the caller's model when one is named", async () => {
    let body = "";
    const fetchImpl = (async (url: string | URL, init: RequestInit) => {
      // The models GET has no body; the chat POST is what carries the model.
      if (String(url).endsWith("/models")) return modelList();
      body = String(init.body);
      return chatOk();
    }) as unknown as typeof fetch;
    await probeEndpoint({ apiKey: "k", baseUrl: "https://example.com/v1", model: "kimi-k3", fetchImpl });

    expect(JSON.parse(body).model).toBe("kimi-k3");
  });

  it("sends the session header and honest user agent, as the gateway asks", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (url: string | URL, init: RequestInit) => {
      if (String(url).endsWith("/models")) return modelList();
      headers = init.headers as Record<string, string>;
      return chatOk();
    }) as unknown as typeof fetch;
    await probeEndpoint({ apiKey: "k", baseUrl: "https://example.com/v1", fetchImpl });

    expect(headers["x-opencode-session"]).toBe("kicode-probe");
    expect(headers["User-Agent"]).toBe("kicode-probe/1.0");
  });
});

describe("renderProbe", () => {
  it("prints the endpoint, each step, and the verdict last", () => {
    const lines = renderProbe({
      baseUrl: "https://example.com/v1",
      steps: [
        { name: "models", ok: true, detail: "3 models listed" },
        { name: "chat", ok: false, detail: "refused" },
      ],
      verdict: "the key was refused",
    });

    expect(lines[0]).toContain("probing https://example.com/v1");
    expect(lines.join("\n")).toContain("ok    models");
    expect(lines.join("\n")).toContain("fail  chat");
    expect(lines.at(-1)).toBe("the key was refused");
  });
});

describe("probeModels", () => {
  it("says when the endpoint lists nothing", async () => {
    const step = await probeModels({
      apiKey: "k",
      baseUrl: "https://example.com/v1",
      fetchImpl: (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch,
    });

    expect(step.ok).toBe(false);
    expect(step.detail).toContain("lists no models");
  });
});
