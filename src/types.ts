/** Shared message, tool, and streaming types for the agent. */

import type { QuotaReading } from "./routes/quota";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type AssistantMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
};

/**
 * A user turn's content.
 *
 * A plain string whenever there is only text, which is almost always — the
 * array shape exists because a pasted image has to travel beside the words, and
 * that is the one form `/chat/completions` accepts for it.
 */
export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image_url"; image_url: { url: string } };
export type ContentPart = TextPart | ImagePart;

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

/** The words of a message, whichever shape its content is in. */
export function messageText(content: string | readonly ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** How many images a message carries. */
export function imageCount(content: string | readonly ContentPart[]): number {
  return typeof content === "string" ? 0 : content.filter((part) => part.type === "image_url").length;
}

/**
 * What a message looks like once the images are not sent again.
 *
 * A pasted screenshot is hundreds of kilobytes of base64, and a session is a
 * JSON file read back on every listing — storing it would make the transcript
 * unreadable and the store unusable. What happened is kept; the pixels are not.
 */
export function withoutImages(content: string | readonly ContentPart[]): string {
  if (typeof content === "string") return content;
  const images = imageCount(content);
  const text = messageText(content);
  return images === 0 ? text : [text, `[${images} image${images === 1 ? "" : "s"} not kept in the session]`].filter(Boolean).join("\n");
}

/** API-shaped tool declaration — exactly what `/chat/completions` expects. */
export type ToolSpec = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export type Usage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type StreamEvent =
  | { type: "text"; delta: string }
  /**
   * The model thinking out loud, before it answers.
   *
   * Endpoints disagree on the field (`reasoning` on OpenRouter, `reasoning_content`
   * on DeepSeek and the GLM models), and most send none at all. Where it does
   * arrive it is kept apart from the answer: it is not part of what the model
   * said, and the next request must not be built from it.
   */
  | { type: "reasoning"; delta: string }
  | { type: "tool-call"; call: ToolCall }
  /**
   * The request is being retried on another route, before any of it was seen.
   *
   * Emitted by the fallback provider when a gateway rate-limits or fails, so
   * the user learns which route answered instead of the model silently
   * changing under them.
   */
  | { type: "route"; from: string; to: string; reason: string }
  /**
   * What the gateway said about the quota it is enforcing.
   *
   * Emitted before the first token, from the response headers, so the route
   * layer can skip a route that is nearly out without sending an answer that is
   * going to be cut off. Never emitted when the gateway says nothing.
   */
  | { type: "quota"; reading: QuotaReading }
  | { type: "finish"; message: AssistantMessage; finishReason: FinishReason; usage?: Usage };

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  /** Reasoning effort, when the session asks for one. Most endpoints ignore it. */
  reasoningEffort?: string;
  signal?: AbortSignal;
};

export interface Provider {
  stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void>;
}
