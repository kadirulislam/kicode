import { messageText, type ChatMessage, type Provider } from "../types";

/**
 * Context compaction.
 *
 * A long session eventually exceeds the model's window. Rather than failing,
 * the older part of the transcript is replaced by a model-written summary and
 * only the most recent turns are kept verbatim.
 *
 * The one thing that must not go wrong is tool-call pairing: a `tool` message
 * without its preceding `assistant.tool_calls` is a hard API error. The cut
 * therefore only ever lands on a `user` message, and a `tool` result can never
 * be separated from the call that produced it.
 */

export type CompactionOptions = {
  /** The model's context window. */
  contextTokens: number;
  /** Headroom left for the model's own reply. */
  reserveTokens: number;
  /** Recent user turns kept word-for-word. */
  keepRecentTurns: number;
  /**
   * Compact once the estimate passes this many tokens, even when the window
   * would allow more. A session that grows past ~100K is summarised early so
   * there is always room for the reply and the next round of tool results.
   * Absent means the window alone decides.
   */
  compactAt?: number;
};

export const SUMMARY_SYSTEM_PROMPT = [
  "You compress a coding session transcript into a briefing for the assistant that will continue it.",
  "",
  "Preserve, concretely:",
  "- Every request the user made, in order, including ones that were completed.",
  "- Decisions taken and why, plus anything explicitly rejected.",
  "- File paths, symbol names, commands, and values that came up.",
  "- What is still unfinished or unverified.",
  "",
  "Do not invent anything, do not add advice, and do not use headings or bullet",
  "characters that would be lost in plain text. Write it as compact prose.",
].join("\n");

export const SUMMARY_HEADER = "[Earlier conversation, summarised to save context]";

const CHARS_PER_TOKEN = 4;
const MAX_MESSAGE_CHARS = 4_000;

/**
 * Rough token estimate: ~4 characters per token.
 *
 * Deliberately crude — an exact count needs the model's tokeniser, and being
 * within a few percent is enough to decide when to compact.
 */
export function estimateTokens(value: unknown): number {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  } catch {
    return 0;
  }
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function shouldCompact(messages: readonly ChatMessage[], options: CompactionOptions): boolean {
  const windowed = options.contextTokens - options.reserveTokens;
  const budget = options.compactAt === undefined ? windowed : Math.min(windowed, options.compactAt);
  return budget > 0 && estimateTokens(messages) > budget;
}

/**
 * Index of the first message to keep, or null when there is nothing safe to cut.
 * Always a `user` message (or the system prompt at index 0).
 */
export function splitIndex(messages: readonly ChatMessage[], keepRecentTurns: number): number | null {
  if (keepRecentTurns <= 0) return null;

  const userIndices: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]?.role === "user") userIndices.push(index);
  }
  if (userIndices.length <= keepRecentTurns) return null;

  const keepFrom = userIndices[userIndices.length - keepRecentTurns];
  if (keepFrom === undefined || keepFrom <= 1) return null;
  return keepFrom;
}

export type CompactionResult = {
  messages: ChatMessage[];
  summary: string;
  summarized: number;
};

/**
 * Returns the compacted transcript, or null when there is nothing to do.
 * Throws only if the summarisation call itself fails; the caller decides
 * whether to carry on over budget.
 */
export async function compactMessages(
  provider: Provider,
  model: string,
  messages: readonly ChatMessage[],
  options: CompactionOptions,
): Promise<CompactionResult | null> {
  const split = splitIndex(messages, options.keepRecentTurns);
  if (split === null) return null;

  const system = messages[0];
  const older = messages.slice(1, split);
  const recent = messages.slice(split);
  if (older.length === 0) return null;

  let summary = "";
  for await (const event of provider.stream({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: transcriptToText(older) },
    ],
  })) {
    if (event.type === "text") summary += event.delta;
  }

  const trimmed = summary.trim();
  if (trimmed === "") return null;

  return {
    messages: [
      ...(system ? [system] : []),
      { role: "user", content: `${SUMMARY_HEADER}\n\n${trimmed}` },
      ...recent,
    ],
    summary: trimmed,
    summarized: older.length,
  };
}

/** Flattens a transcript into bounded plain text for the summariser. */
export function transcriptToText(messages: readonly ChatMessage[]): string {
  return messages
    .map((message) => {
      if (message.role === "tool") {
        return `[tool result] ${clip(message.content)}`;
      }
      if (message.role === "assistant") {
        const calls = message.tool_calls
          ?.map((call) => `${call.function.name}(${clip(call.function.arguments, 500)})`)
          .join(", ");
        const body = message.content ? clip(message.content) : "";
        return `[assistant] ${body}${calls ? `${body ? "\n" : ""}[called] ${calls}` : ""}`;
      }
      return `[${message.role}] ${clip(messageText(message.content))}`;
    })
    .join("\n\n");
}

function clip(value: string, max = MAX_MESSAGE_CHARS): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
