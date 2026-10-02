import { messageText, type ChatMessage, type Provider } from "../types";

/**
 * Context compaction.
 *
 * A long session eventually exceeds the model's window. Rather than failing,
 * the older part of the transcript is replaced by a model-written summary and
 * only the most recent part is kept verbatim.
 *
 * Two rules hold the whole thing together.
 *
 * The cut never orphans a tool result. A `tool` message without its preceding
 * `assistant.tool_calls` is a hard API error, so the cut only ever lands on a
 * request — and, when a session has one enormous turn and no request cut fits
 * the target, on an assistant message that owns its own calls.
 *
 * The cut is chosen by **size**, not by counting turns. Two turns can be two
 * thousand tokens or ninety thousand: a turn count cannot know which it is, so
 * a fixed count kept far too little in a tool-heavy session and far too much in
 * a quiet one. What is chosen instead is the size the session should be left
 * at — `targetPercent` of the window, kept inside a band — and the tail is the
 * longest run of recent turns that fits under it.
 */

export type CompactionOptions = {
  /** The model's context window. */
  contextTokens: number;
  /** Headroom left for the model's own reply. */
  reserveTokens: number;
  /**
   * Where in the window a compacted session should sit, as a percentage.
   *
   * Clamped to `COMPACT_TARGET_BAND`. The point of the band: below it a session
   * has been summarised past the point of being useful, and above it there is no
   * room left to keep working in — which is what compaction is for.
   */
  targetPercent?: number;
  /**
   * Compact once the estimate passes this many tokens, even when the window
   * would allow more. A session that grows past ~100K is summarised early so
   * there is always room for the reply and the next round of tool results.
   * Absent means the window alone decides.
   */
  compactAt?: number;
};

/** Where a compacted session sits in its window, unless a config says otherwise. */
export const COMPACT_TARGET_PERCENT = 40;
/** The band the target is clamped into: too small loses the session, too large loses the room. */
export const COMPACT_TARGET_BAND: readonly [number, number] = [30, 50];
/** The briefing's share of the target. The rest of it belongs to the tail. */
const SUMMARY_SHARE = 0.2;
/** Below this a briefing is not worth asking a model for. */
const MIN_SUMMARY_TOKENS = 256;

const SUMMARY_SYSTEM_LINES = [
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
];

export const SUMMARY_HEADER = "[Earlier conversation, summarised to save context]";

const CHARS_PER_TOKEN = 4;
const MAX_MESSAGE_CHARS = 4_000;

/** The summary's own instructions, sized to the room it has been given. */
export function summaryPrompt(budgetTokens: number): string {
  return [
    ...SUMMARY_SYSTEM_LINES,
    "",
    `Keep the briefing under about ${budgetTokens} tokens: it replaces the`,
    "transcript, it does not repeat it.",
  ].join("\n");
}

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

/** The percentage a target is kept inside, whatever a config asked for. */
export function clampTargetPercent(percent: number): number {
  const [low, high] = COMPACT_TARGET_BAND;
  if (!Number.isFinite(percent)) return COMPACT_TARGET_PERCENT;
  return Math.min(Math.max(Math.round(percent), low), high);
}

/**
 * The size a compacted session aims at, in tokens.
 *
 * A share of the window, and never more than the window's usable part: a
 * reserve bigger than the target's remainder would otherwise aim at room that
 * does not exist.
 */
export function compactionTarget(options: CompactionOptions): number {
  const window = Math.max(options.contextTokens - options.reserveTokens, 0);
  const percent = clampTargetPercent(options.targetPercent ?? COMPACT_TARGET_PERCENT);
  return Math.max(Math.min(Math.round((percent / 100) * options.contextTokens), window), 0);
}

export function shouldCompact(messages: readonly ChatMessage[], options: CompactionOptions): boolean {
  const windowed = options.contextTokens - options.reserveTokens;
  const budget = options.compactAt === undefined ? windowed : Math.min(windowed, options.compactAt);
  return budget > 0 && estimateTokens(messages) > budget;
}

/** What a compaction is about to do, decided before a model is asked for anything. */
export type CompactionPlan = {
  /** The estimate the session is being left at, in tokens. */
  target: number;
  /** Index of the first message kept word-for-word. */
  cut: number;
  /** What the briefing is asked to stay under, in tokens. */
  summaryBudget: number;
};

/**
 * Where to cut, and what to aim at — or null when there is nothing to gain.
 *
 * The tail is the longest run of recent turns that still fits under the target,
 * so the session lands at the target rather than wherever a turn count happened
 * to leave it. A session already at or under the target has nothing to gain:
 * summarising it would spend a model call to make it bigger.
 *
 * The target is the whole session's, not the tail's: the system prompt and the
 * briefing are kept whatever the cut, so their room is taken first. Otherwise a
 * long prompt would leave the session a prompt's worth over target every time.
 */
export function planCompaction(
  messages: readonly ChatMessage[],
  options: CompactionOptions,
): CompactionPlan | null {
  const target = compactionTarget(options);
  if (target <= 0) return null;
  if (estimateTokens(messages) <= target) return null;

  const summaryBudget = Math.max(Math.round(target * SUMMARY_SHARE), MIN_SUMMARY_TOKENS);
  // What survives the cut above it: the system prompt is never summarised and
  // never cut, so it is spent out of the target before the tail is measured.
  // Without this the plan aims at the target for the tail alone and the session
  // lands at target-plus-the-prompt — a constant overshoot that grows with the
  // prompt, which is exactly the kind of drift a size target exists to stop.
  const prefix = messages[0] ? estimateTokens([messages[0]]) : 0;
  const tailBudget = Math.max(target - summaryBudget - prefix, 0);
  const sizes = suffixSizes(messages);

  const cut =
    oldestFitting(messages, sizes, tailBudget, isRequest) ??
    oldestFitting(messages, sizes, tailBudget, isTurnCut) ??
    newestCut(messages);
  if (cut === null) return null;

  return { target, cut, summaryBudget };
}

const isRequest = (message: ChatMessage): boolean => message.role === "user";
/** Any message a tail can open on: a tool result cannot, and the system prompt is never cut. */
const isTurnCut = (message: ChatMessage): boolean => message.role === "assistant" || message.role === "user";

/**
 * What every suffix of the transcript costs, in tokens, as `sizes[cut]`.
 *
 * The same estimate `estimateTokens` makes — four characters per token — but
 * computed once for the whole transcript and then read per candidate. A plan
 * weighs a cut at every message against the budget, and stringifying the
 * transcript once per candidate is work a long session cannot spare.
 */
function suffixSizes(messages: readonly ChatMessage[]): number[] {
  const sizes = new Array<number>(messages.length + 1).fill(0);
  // The closing bracket, then each message with the separator in front of it:
  // exactly the string the array serialises to, one entry at a time.
  let length = 1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    length += (message === undefined ? 0 : jsonLength(message)) + 1;
    sizes[index] = Math.ceil(length / CHARS_PER_TOKEN);
  }
  return sizes;
}

function jsonLength(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? "").length;
  } catch {
    return 0;
  }
}

/**
 * The oldest cut of the accepted kind whose tail already fits the budget.
 *
 * Oldest rather than newest because the tail is what is kept word-for-word:
 * the most recent history that fits is better context than less of it.
 */
function oldestFitting(
  messages: readonly ChatMessage[],
  sizes: readonly number[],
  tailBudget: number,
  accepts: (message: ChatMessage) => boolean,
): number | null {
  for (let index = 2; index < messages.length; index++) {
    const message = messages[index];
    if (!message || !accepts(message)) continue;
    const cut = pairedCut(messages, index);
    if (cut >= 2 && (sizes[cut] ?? Number.POSITIVE_INFINITY) <= tailBudget) return cut;
  }
  return null;
}

/**
 * The smallest tail a transcript can be left with: the newest cut that is
 * still a cut.
 *
 * Every message a tail may open on is tried, from the end, because a repaired
 * cut can land older than the message it was asked about — and the smallest
 * tail is what this fallback is for.
 */
function newestCut(messages: readonly ChatMessage[]): number | null {
  let cut = 0;
  for (let index = 2; index < messages.length; index++) {
    const message = messages[index];
    if (!message || !isTurnCut(message)) continue;
    // The largest index is the smallest tail, and a repaired cut only ever
    // lands older than the message it was asked about — so this is a maximum
    // and not the last one seen.
    cut = Math.max(cut, pairedCut(messages, index));
  }
  return cut >= 2 ? cut : null;
}

/**
 * The cut, moved up while the tail it would leave is missing the calls behind
 * its tool results.
 *
 * A well-formed transcript never needs this — a result always follows the call
 * that produced it, so a cut on a request or an assistant message already keeps
 * the pair together. It is here because the one thing that must not go wrong is
 * the pairing, and "the cut cannot land there" is worth more as a line of code
 * than as a comment: whatever the transcript looks like, what is kept is legal.
 */
function pairedCut(messages: readonly ChatMessage[], index: number): number {
  let cut = index;
  for (;;) {
    const orphan = orphanedCall(messages, cut);
    if (orphan === null) return cut;
    const owner = messages.findIndex(
      (message) => message.role === "assistant" && message.tool_calls?.some((call) => call.id === orphan),
    );
    if (owner < 1 || owner >= cut) return cut;
    cut = owner;
  }
}

/** The first tool result in the kept slice whose call is not in it, or null. */
function orphanedCall(messages: readonly ChatMessage[], cut: number): string | null {
  let calls = new Set<string>();
  for (let index = cut; index < messages.length; index++) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "assistant") {
      calls = new Set((message.tool_calls ?? []).map((call) => call.id));
    } else if (message.role === "tool") {
      if (!calls.has(message.tool_call_id)) return message.tool_call_id;
      calls.delete(message.tool_call_id);
    } else {
      calls.clear();
    }
  }
  return null;
}

export type CompactionResult = {
  messages: ChatMessage[];
  summary: string;
  summarized: number;
  /** The estimate the plan aimed at, so the notice can say where it landed. */
  target: number;
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
  const plan = planCompaction(messages, options);
  if (plan === null) return null;

  const system = messages[0];
  const older = messages.slice(1, plan.cut);
  const recent = messages.slice(plan.cut);
  if (older.length === 0) return null;

  let summary = "";
  for await (const event of provider.stream({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: summaryPrompt(plan.summaryBudget) },
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
    target: plan.target,
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
