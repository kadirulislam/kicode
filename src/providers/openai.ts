import type {
  AssistantMessage,
  ChatRequest,
  FinishReason,
  Provider,
  StreamEvent,
  ToolCall,
  Usage,
} from "../types";
import { readQuota } from "../routes/quota";
import { parseSse } from "./sse";

/**
 * OpenAI-compatible `/chat/completions` client.
 *
 * One HTTP shape covers OpenAI, OpenRouter, Groq, Together, and local Ollama.
 * The hard part is not the request — it is reassembling a tool call whose
 * arguments arrive as fragments across many SSE deltas.
 */

export type OpenAIProviderOptions = {
  apiKey: string;
  baseUrl: string;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Extra headers, e.g. OpenRouter's `HTTP-Referer` / `X-Title`. */
  headers?: Record<string, string>;
  /**
   * Stable per-conversation id, sent as `x-opencode-session`. Gateways that
   * route and cache per conversation — OpenCode Go among them — require it,
   * and name it in their client-validation docs. Absent means no header.
   */
  sessionId?: string;
  /**
   * Sent as `User-Agent`. Gateways that validate clients want a product name
   * (`kicode/0.1.0`), not a generic SDK or HTTP-library name; Node's fetch
   * sends none by default, which reads as exactly the anonymity they refuse.
   */
  userAgent?: string;
};

export class ProviderError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

export class OpenAIProvider implements Provider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly sessionId?: string;
  private readonly userAgent?: string;

  constructor(options: OpenAIProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = options.headers ?? {};
    this.sessionId = options.sessionId;
    this.userAgent = options.userAgent;
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    const url = chatCompletionsUrl(this.baseUrl);

    let response: Response;
    try {
      response = await this.send(request, !NO_STREAM_USAGE.has(this.baseUrl));
      // A gateway that does not know `stream_options` rejects the whole request,
      // naming the field it did not like. That is a supported refusal rather
      // than a failure of the turn, so the field is dropped and the request made
      // again — recorded against this endpoint, so asking costs one wasted
      // request per process instead of one per turn.
      if (response.status === 400 && !NO_STREAM_USAGE.has(this.baseUrl)) {
        const detail = await response
          .clone()
          .text()
          .catch(() => "");
        if (STREAM_OPTIONS_REFUSED.test(detail)) {
          NO_STREAM_USAGE.add(this.baseUrl);
          response = await this.send(request, false);
        }
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      throw new ProviderError(`Request to ${url} failed: ${(error as Error).message}${localHint(this.baseUrl)}`);
    }

    // Read what the gateway said about its limits before deciding anything.
    // It is emitted for a failure too: a 429's headers are the one place the
    // route layer learns when this route is worth trying again.
    const quota = readQuota(response.headers, { host: hostOf(this.baseUrl) });
    if (quota) yield { type: "quota", reading: quota };

    if (!response.ok) throw new ProviderError(await describeHttpError(response, url), response.status);
    if (!response.body) throw new ProviderError("Provider returned an empty response body.");

    /** Keyed by tool-call index — a single turn may request several tools. */
    const partials = new Map<number, { id: string; name: string; args: string }>();
    let content = "";
    let finishReason: FinishReason = "stop";
    let usage: Usage | undefined;

    for await (const data of parseSse(response.body)) {
      if (data === "[DONE]") break;

      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(data) as ChatChunk;
      } catch {
        continue; // keep-alives and non-JSON frames are not fatal
      }

      if (chunk.usage) usage = normalizeUsage(chunk.usage);

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      // Reasoning is kept apart from the answer: it is not what the model said,
      // and a request built from it would be an argument with the model's own
      // scratchpad. Two field names because endpoints do not agree on one.
      const thinking = delta?.reasoning ?? delta?.reasoning_content;
      if (typeof thinking === "string" && thinking.length > 0) yield { type: "reasoning", delta: thinking };

      if (delta && typeof delta.content === "string" && delta.content.length > 0) {
        content += delta.content;
        yield { type: "text", delta: delta.content };
      }

      for (const fragment of delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const partial = partials.get(index) ?? { id: "", name: "", args: "" };
        if (fragment.id) partial.id = fragment.id;
        // Some providers resend the name on every fragment; only the first wins.
        if (fragment.function?.name) partial.name = partial.name || fragment.function.name;
        if (fragment.function?.arguments) partial.args += fragment.function.arguments;
        partials.set(index, partial);
      }

      if (choice.finish_reason) finishReason = normalizeFinishReason(choice.finish_reason);
    }

    const toolCalls: ToolCall[] = [...partials.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, partial]) => ({
        id: partial.id || `call_${index}_${Date.now().toString(36)}`,
        type: "function" as const,
        function: { name: partial.name, arguments: partial.args || "{}" },
      }));

    for (const call of toolCalls) yield { type: "tool-call", call };

    const message: AssistantMessage = { role: "assistant", content: content.length > 0 ? content : null };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
      // Some providers report "stop" even when they asked for tools.
      if (finishReason === "stop") finishReason = "tool_calls";
    }

    yield { type: "finish", message, finishReason, usage };
  }

  /**
   * One request.
   *
   * `usage` asks the gateway to report token counts in the stream. It is not
   * free to leave out: a streaming response carries no `usage` block at all
   * unless the request opts in, so without it the line under an answer has no
   * rate, and the session's token budget never moves however much is spent.
   */
  private send(request: ChatRequest, usage: boolean): Promise<Response> {
    return this.fetchImpl(chatCompletionsUrl(this.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${this.apiKey}`,
        ...(this.sessionId ? { "x-opencode-session": this.sessionId } : {}),
        ...(this.userAgent ? { "User-Agent": this.userAgent } : {}),
        ...this.headers,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: true,
        ...(usage ? { stream_options: { include_usage: true } } : {}),
        ...(request.tools && request.tools.length > 0 ? { tools: request.tools, tool_choice: "auto" } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        // Only sent when the session picked one: an endpoint that does not
        // know the field rejects the whole request.
        ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
      }),
      signal: request.signal,
    });
  }
}

/**
 * Endpoints that answered 400 to `stream_options`, by base URL.
 *
 * Module-level and process-wide on purpose: the answer is a property of the
 * gateway, not of one provider instance, and every turn would otherwise pay to
 * learn it again.
 */
const NO_STREAM_USAGE = new Set<string>();

/** A refusal that names the field, rather than a 400 about something else. */
const STREAM_OPTIONS_REFUSED = /stream[_-]?options/i;

/** Accepts either a base URL (`.../v1`) or a full completions URL. */
/**
 * A connection failure against a local endpoint is almost always a server that
 * is not running, so say that rather than leaving the user with "fetch failed".
 */
function localHint(baseUrl: string): string {
  try {
    const { hostname } = new URL(baseUrl);
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      return " — is a server actually listening there? (the bundled mock: `npm run mock`)";
    }
  } catch {
    // A malformed base URL is already reported by validateConfig.
  }
  return "";
}

/**
 * `GET /models` — what the endpoint actually serves.
 *
 * Worth having because a gateway's model names are its own: pointing KiCode at
 * an OpenAI-compatible endpoint does not mean `gpt-4o-mini` exists there.
 */
export type ModelRecord = {
  id: string;
  label?: string;
  tier?: string;
  /** Undefined when the endpoint does not report one. */
  contextLength?: number;
  /** Undefined when the endpoint does not report tool support. */
  supportsTools?: boolean;
  /** Uses the conventional `:free` suffix that gateways mark free routes with, or 0.00 token pricing. */
  free: boolean;
  promptPrice?: number;
  completionPrice?: number;
};

/**
 * Format model input/output token pricing compactly.
 * Returns "$0.00" if free / zero price.
 */
export function formatModelPrice(promptPrice?: number, completionPrice?: number): string {
  if (promptPrice === undefined && completionPrice === undefined) return "";
  const p = promptPrice ?? 0;
  const c = completionPrice ?? 0;
  if (p === 0 && c === 0) return "$0.00";
  if ((p > 0 && p < 0.01) || (c > 0 && c < 0.01)) {
    const pM = (p * 1_000_000).toFixed(2).replace(/\.00$/, "");
    const cM = (c * 1_000_000).toFixed(2).replace(/\.00$/, "");
    return `$${pM}/$${cM}/M`;
  }
  return `$${p.toFixed(2)}/$${c.toFixed(2)}`;
}

export async function listModels(options: OpenAIProviderOptions): Promise<ModelRecord[]> {
  const url = `${options.baseUrl.trim().replace(/\/+$/, "")}/models`;
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.apiKey}`,
        ...(options.userAgent ? { "User-Agent": options.userAgent } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    throw new ProviderError(`Could not reach ${url}: ${(error as Error).message}${localHint(options.baseUrl)}`);
  }

  if (!response.ok) throw new ProviderError(await describeHttpError(response, url), response.status);

  const body = (await response.json().catch(() => null)) as { data?: unknown; models?: unknown } | null;
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];

  return list.map(toModelRecord).filter((record): record is ModelRecord => record !== null);
}

/**
 * Normalises both the bare `{ id }` shape and the richer metadata some gateways
 * add. Anything absent stays undefined so the table can show "unknown" rather
 * than inventing a value.
 */
function toModelRecord(entry: unknown): ModelRecord | null {
  const id = typeof entry === "string" ? entry : (entry as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id === "") return null;

  const source = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
  const tools = source.tool_call ?? source.function_call;

  const pricing = (source.pricing && typeof source.pricing === "object" ? source.pricing : {}) as Record<string, unknown>;
  const price = (source.price && typeof source.price === "object" ? source.price : {}) as Record<string, unknown>;

  const parseNum = (v: unknown): number | undefined => {
    if (typeof v === "number" && !Number.isNaN(v)) return v;
    if (typeof v === "string") {
      const parsed = parseFloat(v);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return undefined;
  };

  const rawPrompt = pricing.prompt ?? pricing.input ?? price.input ?? source.input_price ?? source.prompt_price;
  const rawCompletion = pricing.completion ?? pricing.output ?? price.output ?? source.output_price ?? source.completion_price;
  const promptPrice = parseNum(rawPrompt);
  const completionPrice = parseNum(rawCompletion);
  const hasZeroPrice =
    (promptPrice === 0 && completionPrice === 0) ||
    (promptPrice === 0 && rawCompletion === undefined) ||
    (rawPrompt === undefined && completionPrice === 0);

  return {
    id,
    label: typeof source.label === "string" ? source.label : undefined,
    tier: typeof source.tier === "string" ? source.tier : undefined,
    contextLength: typeof source.context_length === "number" ? source.context_length : undefined,
    supportsTools: typeof tools === "boolean" ? tools : undefined,
    free: /free/i.test(id) || hasZeroPrice,
    ...(promptPrice !== undefined ? { promptPrice } : {}),
    ...(completionPrice !== undefined ? { completionPrice } : {}),
  };
}

/** The endpoint's hostname, which decides an ambiguous rate-limit window. */
function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

type ChatChunk = {
  choices?: {
    index: number;
    delta?: {
      role?: string;
      content?: string | null;
      /** Thinking, on gateways that stream it — OpenRouter's field name. */
      reasoning?: string | null;
      /** The same thing under the name DeepSeek and the GLM models use. */
      reasoning_content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

function normalizeFinishReason(value: string): FinishReason {
  return value === "length" || value === "tool_calls" || value === "content_filter" ? value : "stop";
}

function normalizeUsage(usage: NonNullable<ChatChunk["usage"]>): Usage {
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

async function describeHttpError(response: Response, url: string): Promise<string> {
  let detail = "";
  try {
    const text = await response.text();
    try {
      const body = JSON.parse(text) as { error?: { message?: unknown } | string };
      const message = typeof body.error === "string" ? body.error : body.error?.message;
      if (typeof message === "string" && message) detail = `: ${message.slice(0, 300)}`;
    } catch {
      if (text.trim()) detail = `: ${text.trim().slice(0, 300)}`;
    }
  } catch {
    // The body was unreadable; the status alone still has to be reported.
  }

  if (response.status === 401 || response.status === 403) {
    return `Provider rejected the API key (HTTP ${response.status})${detail}${clientRestrictionHint(url, response.status, detail)}`;
  }
  if (response.status === 404) {
    // Model names belong to the gateway, not to OpenAI — `gpt-4o-mini` is a
    // 404 on most of them, so point at the endpoint's own model list rather
    // than at other providers' dashboards.
    return `Provider returned 404 for ${url} — the path is wrong, or this endpoint does not serve that model. Run \`kicode --models\` to see what it does serve${detail}`;
  }
  if (response.status === 429) return `Provider rate-limited the request (HTTP 429)${detail}`;
  return `Provider returned HTTP ${response.status} for ${url}${detail}`;
}

/**
 * Gateways that restrict which client may call them say so with a bare 401/403
 * — the same status a wrong key gets. A hint is only worth showing when the
 * body confirms it: an OpenCode-shaped AuthError on an opencode.ai endpoint is
 * their client restriction, not a typo in the key, and the model should know
 * to say that rather than send the user hunting for a key that is already set.
 */
function clientRestrictionHint(url: string, status: number, detail: string): string {
  if (status !== 401 && status !== 403) return "";
  const isOpenCode = /(^|\.)opencode\.ai/i.test(hostOf(url) ?? "");
  if (!isOpenCode) return "";
  const authError = /AuthError|Invalid API key/i.test(detail);
  if (!authError) return "";
  return "\nnote: opencode.ai free models are restricted to the OpenCode client itself — a paid Zen key works from any client, or switch routes with /models (free models on OpenRouter still accept any key)";
}
