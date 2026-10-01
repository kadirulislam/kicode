import { imageCount, messageText, type ChatMessage } from "../types";
import type { AgentEvent } from "../agent/loop";
import { type Span, flatten, span } from "./ansi";
import { markdownSpans, tidy } from "./markdown";
import { type ViewSettings, defaultViewSettings } from "./settings";
import type { Styles } from "./theme";

/**
 * The conversation as the TUI thinks about it: a flat list of entries.
 *
 * Entries stay un-wrapped because the terminal can be resized at any time;
 * width-dependent work happens in `frame.ts`, once per draw.
 */

export type Tone = "dim" | "ok" | "error" | "warn" | "accent";

export type Entry =
  /** `images` counts the pictures sent with the words, for the marker. */
  /** `docs` names the files attached with `/attach`, shown as badges. */
  | { kind: "user"; text: string; images?: number; docs?: string[] }
  | { kind: "assistant"; text: string }
  /**
   * The model's reasoning, which is not part of the conversation — it is not
   * sent back on the next request, and the transcript export leaves it out.
   * `open` is true until the answer starts, which is what the elapsed time
   * under the heading measures.
   */
  | { kind: "thought"; text: string; ms: number; open: boolean; since: number }
  | { kind: "tool"; name: string; args: unknown }
  | { kind: "result"; name: string; content: string; isError: boolean }
  | { kind: "note"; text: string; tone: Tone; /** How many identical notes in a row this one stands for. */ count?: number }
  /** The line under an answer: mode, model, time, tokens a second. */
  | { kind: "meta"; text: string };

/**
 * How much of a tool's output is shown, and how much reasoning.
 *
 * One setting rather than two because they are the same question — how much
 * detail belongs on screen — and a transcript that shows every line of a
 * `grep` but hides the thinking behind it is answering that question twice,
 * differently.
 */
const VERBOSITY: Record<ViewSettings["verbosity"], { lines: number; chars: number; thoughtLines: number }> = {
  low: { lines: 1, chars: 120, thoughtLines: 0 },
  medium: { lines: 3, chars: 400, thoughtLines: 6 },
  high: { lines: 12, chars: 2000, thoughtLines: 40 },
};

/** One value of one argument, on one line: past this, it is a wall, not a summary. */
const ARG_VALUE_CHARS = 96;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * What a tool call shows beside its name.
 *
 * The tool name matters: `ask` carries whole question objects — headers, option
 * lists, descriptions — that the question panel below renders properly anyway,
 * and flattening them to JSON is a wall that pushes the turn off the screen.
 * Every value is capped because an argument summary that scrolls is an argument
 * dump with extra steps.
 */
export function summarizeArgs(args: unknown, tool?: string): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return flatten(args);
  if (typeof args !== "object") return String(args);

  const record = args as Record<string, unknown>;

  if (tool === "ask" && Array.isArray(record.questions)) {
    const questions = record.questions as unknown[];
    const first = questions[0];
    const text = first && typeof first === "object" && typeof (first as { question?: unknown }).question === "string"
      ? flatten((first as { question: string }).question)
      : "";
    const count = questions.length;
    const label = `${count} question${count === 1 ? "" : "s"}`;
    return text ? `${label}: "${clip(text, ARG_VALUE_CHARS)}"` : label;
  }

  const entries = Object.entries(record);
  if (entries.length === 0) return "";

  return entries
    .map(([key, value]) => {
      const rendered =
        typeof value === "string"
          ? flatten(value)
          : value === null || typeof value !== "object"
            ? String(value)
            : flatten(JSON.stringify(value));
      return `${key}: ${clip(rendered, ARG_VALUE_CHARS)}`;
    })
    .join(", ");
}

function resultLines(content: string, verbosity: ViewSettings["verbosity"]): string {
  const { lines: maxLines, chars } = VERBOSITY[verbosity];
  const all = content.replace(/\r/g, "").split("\n");
  // Medium is the everyday setting, and mid-turn a result is usually not what
  // anyone is reading — the tool and what it touched are. One line says both;
  // low keeps its single clipped line, high keeps everything it showed before.
  if (verbosity === "medium" && !/^(error|denied|refused)/i.test(content.trim())) {
    const total = all.length;
    const first = (all[0] ?? "").trim();
    const summary = first.length > chars ? `${first.slice(0, chars)}…` : first;
    return total > 1 ? `${summary} · ${total} lines` : summary;
  }
  const kept = all.slice(0, maxLines).join("\n");
  const clipped = kept.length > chars ? `${kept.slice(0, chars)}…` : kept;
  return all.length > maxLines ? `${clipped}\n… ${all.length - maxLines} more lines` : clipped;
}

/**
 * The tail of a reasoning stream, for the one-line thinking ticker.
 *
 * The newest sentence fragment is the part that describes what the model is
 * doing *now*; everything before it is already done. Splitting on sentence
 * ends keeps whole clauses together, and the flat cap keeps one long clause
 * from wrapping the ticker into the wall it exists to replace.
 */
const THOUGHT_TICKER_CHARS = 96;

export function lastThoughtFragment(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentences = flat.split(/(?<=[.!?])\s+/);
  let tail = sentences.at(-1) ?? flat;
  // A fragment cut mid-sentence still beats none: keep the last N characters
  // but start at a word edge, so the ticker never opens with half a word.
  if (tail.length > THOUGHT_TICKER_CHARS) {
    tail = tail.slice(-THOUGHT_TICKER_CHARS);
    // The cap usually lands mid-word; trimming to the next word edge keeps
    // the ticker from opening with a fragment of one.
    const space = tail.indexOf(" ");
    if (space > 0) tail = tail.slice(space + 1);
  }
  return tail;
}

/** Rebuilds the transcript from a restored session. */
export function entriesFromHistory(messages: readonly ChatMessage[]): Entry[] {
  const entries: Entry[] = [];
  const names = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "user") {
      const images = imageCount(message.content);
      entries.push({
        kind: "user",
        text: messageText(message.content),
        ...(images > 0 ? { images } : {}),
      });
      continue;
    }
    if (message.role === "assistant") {
      if (message.content?.trim()) entries.push({ kind: "assistant", text: tidy(message.content) });
      for (const call of message.tool_calls ?? []) {
        names.set(call.id, call.function.name);
        entries.push({ kind: "tool", name: call.function.name, args: parseArgs(call.function.arguments) });
      }
      continue;
    }
    if (message.role === "tool") {
      entries.push({
        kind: "result",
        name: names.get(message.tool_call_id) ?? "tool",
        content: message.content,
        isError: /^\s*(error|denied|refused)/i.test(message.content),
      });
    }
  }

  return entries;
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * What the transcript needs to know about the moment an event arrived.
 *
 * The clock is passed in rather than read here so a test can drive a turn
 * deterministically, and `turn` carries the few facts the per-answer line is
 * made of — null when that line should not be drawn at all.
 */
export type EventTiming = {
  at: number;
  turn: {
    startedAt: number;
    /** `Build` or `Plan`, as the status row writes it. */
    mode: string;
    model: string;
    tps: boolean;
  } | null;
};

/** Applies one streaming event to the transcript, returning what changed. */
export function applyEvent(
  entries: Entry[],
  event: AgentEvent,
  timing: EventTiming = { at: Date.now(), turn: null },
): void {
  // Reasoning ends the moment there is something else to show: the answer, a
  // tool call, or the end of the turn. Measuring it here rather than in the
  // renderer keeps the frame a pure function of the state.
  if (event.type !== "reasoning") closeThought(entries, timing.at);

  switch (event.type) {
    case "text": {
      const last = entries.at(-1);
      if (last?.kind === "assistant") last.text += event.delta;
      else entries.push({ kind: "assistant", text: event.delta });
      return;
    }
    case "reasoning": {
      const last = entries.at(-1);
      if (last?.kind === "thought" && last.open) last.text += event.delta;
      else entries.push({ kind: "thought", text: event.delta, ms: 0, open: true, since: timing.at });
      return;
    }
    case "tool-start":
      entries.push({ kind: "tool", name: event.name, args: event.args });
      return;
    case "tool-result": {
      // The todo list is live, not history. The agent rewrites it as it works,
      // and a fresh copy per update would bury the conversation under
      // near-identical checklists. The previous card is lifted out and the new
      // state put at the end, so there is exactly one checklist and it stays
      // where the work is.
      if (event.name === "todo") {
        const previous = entries.findLastIndex((entry) => entry.kind === "result" && entry.name === "todo");
        if (previous !== -1) entries.splice(previous, 1);
      }
      entries.push({ kind: "result", name: event.name, content: event.content, isError: event.isError });
      return;
    }
    case "compacted":
      entries.push({
        kind: "note",
        text: `compacted ${event.summarized} earlier messages · ~${event.before} → ~${event.after} tokens`,
        tone: "dim",
      });
      return;
    case "route":
      // Worth saying out loud: the answer came from a different model than the
      // one on the status row, and nothing else would tell the user that.
      entries.push({ kind: "note", text: `switched to ${event.to} — ${event.reason}`, tone: "warn" });
      return;
    case "route-wait":
      // Not an entry on purpose: a wait is seconds, not history, and the busy
      // row is already saying it. (The caller maps this event to the spinner.)
      return;
    case "budget":
      entries.push({ kind: "note", text: `session budget reached — ~${event.spent} of ${event.limit} tokens`, tone: "warn" });
      return;
    case "quota":
      // Deliberately silent for now: a quota reading arrives on every response,
      // and a transcript line per request would bury the conversation. It feeds
      // the route layer and, later, the budget HUD.
      return;
    case "done": {
      // A turn that produced only tool calls leaves the last assistant entry
      // empty; drop it so the transcript does not collect blank lines.
      const last = entries.at(-1);
      if (last?.kind === "assistant" && !last.text.trim()) entries.pop();

      const line = metaLine(event, timing);
      if (line) entries.push({ kind: "meta", text: line });
      return;
    }
  }
}

/** Marks the open thought closed, recording how long it ran. */
function closeThought(entries: readonly Entry[], at: number): void {
  const last = entries.at(-1);
  if (last?.kind !== "thought" || !last.open) return;
  last.ms = Math.max(at - last.since, 0);
  last.open = false;
}

/**
 * The line under an answer.
 *
 * It says which mode and model produced the answer, how long the turn took, and
 * how fast it wrote — the three things that are invisible otherwise. Only the
 * parts that are known are printed: an endpoint that reports no usage gets the
 * time and no rate, rather than a made-up number.
 */
function metaLine(event: Extract<AgentEvent, { type: "done" }>, timing: EventTiming): string | null {
  if (!timing.turn?.tps) return null;
  // A turn stopped by the budget has its own note; a second line under it would
  // only repeat that something ended early.
  if (event.reason === "budget") return null;

  const elapsed = Math.max(event.ms ?? timing.at - timing.turn.startedAt, 0);
  const model = event.model ?? timing.turn.model;
  const rate =
    event.completionTokens && elapsed > 0 ? ` · ${(event.completionTokens / (elapsed / 1000)).toFixed(1)} tok/s` : "";

  return `${timing.turn.mode} · ${model} · ${formatElapsed(elapsed)}${rate}`;
}

/** `700ms`, `3.9s`, `2m 04s` — short enough to sit under an answer. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * The transcript as plain text, for `/copy`, `/export` and the clipboard.
 *
 * Styling is dropped here rather than stripped later: the clipboard wants the
 * words, and a note that only makes sense on screen is kept, because a partial
 * transcript is more confusing than a slightly noisy one. Reasoning is left out
 * on purpose — it is the model's scratchpad, not something either party said.
 */
export function entriesToText(entries: readonly Entry[]): string {
  const blocks: string[] = [];

  for (const entry of entries) {
    switch (entry.kind) {
      case "user":
        blocks.push(`> ${entry.text}`);
        break;
      case "assistant":
        blocks.push(entry.text.trim());
        break;
      case "tool": {
        const args = summarizeArgs(entry.args, entry.name);
        blocks.push(`→ ${entry.name}${args ? `(${args})` : "()"}`);
        break;
      }
      case "result":
        blocks.push(`${entry.isError ? "✕" : "✓"} ${entry.content.trim()}`);
        break;
      case "note":
        blocks.push(`[${noteText(entry)}]`);
        break;
      case "meta":
      case "thought":
        break;
    }
  }

  return `${blocks.filter((block) => block.length > 0).join("\n\n")}\n`;
}

export function entrySpans(entry: Entry, styles: Styles, view: ViewSettings = defaultViewSettings()): Span[] {
  switch (entry.kind) {
    case "user":
      // No sender header: the block's own bar and fill say who wrote it, and
      // a label row would cost a row on every turn without adding meaning.
      return [
        ...(entry.images && view.transcriptImages === "on"
          ? [span(`[${entry.images} image${entry.images === 1 ? "" : "s"}] `, styles.imageBadge), span("\n")]
          : []),
        ...(entry.docs ?? []).map((name) => [span(`[${name}] `, styles.imageBadge), span("\n")]).flat(),
        span(entry.text, styles.bold),
        span("\n"),
      ];
    case "assistant": {
      // No sender header either: an answer is plain prose, and the words are
      // the row — a label above every reply is chrome, not content.
      // `raw` prints exactly what the model typed. It exists because a
      // half-rendered document is worse than an unrendered one, and a diff or a
      // table is exactly the half that goes wrong.
      const content = view.markdown === "raw"
        ? [span(entry.text.trim(), styles.text), span("\n")]
        : [...markdownSpans(entry.text.trim(), styles), span("\n")];
      return [...content];
    }
    case "thought": {
      if (view.thinking === "hide") return [];
      // One line, whichever way it is drawn: while the model is thinking, the
      // latest sentence ticks in place — alive, but never a wall of stream —
      // and once the answer starts it collapses to the elapsed time. The full
      // stream is not gone: verbosity=high still shows it while running.
      if (entry.open && view.verbosity !== "high") {
        const fragment = lastThoughtFragment(entry.text);
        return [
          span("\n"),
          span("▌ thinking ", styles.accent),
          span(fragment, styles.faint),
          span("\n"),
        ];
      }
      const heading = entry.open ? "Thought…" : `Thought: ${formatElapsed(entry.ms)}`;
      const rows: Span[] = [span("\n"), span(heading, styles.faint)];
      const budget = VERBOSITY[view.verbosity].thoughtLines;
      const body = entry.text.trim();
      if (budget > 0 && body) {
        const all = body.split("\n");
        const shown = all.slice(0, budget);
        const clipped = shown.join("\n");
        const trimmed = clipped.length > 4000 ? `${clipped.slice(0, 4000)}…` : clipped;
        rows.push(span("\n"), span(trimmed, styles.dim));
        if (all.length > budget) rows.push(span(`\n… ${all.length - budget} more lines`, styles.faint));
      }
      rows.push(span("\n"));
      return rows;
    }
    case "tool": {
      const args = summarizeArgs(entry.args, entry.name);
      return [
        span("\n"),
        span("→ ", styles.accent),
        span(entry.name, styles.code),
        span(args ? `(${args})` : "()", styles.dim),
        span("\n"),
      ];
    }
    case "result":
      return [
        span(entry.isError ? "✕ " : "✓ ", entry.isError ? styles.error : styles.ok),
        span(resultLines(entry.content, view.verbosity), entry.isError ? styles.error : styles.text),
        span("\n"),
      ];
    case "note":
      return [span("\n"), span(`[${noteText(entry)}]`, styles[entry.tone]), span("\n")];
    case "meta":
      return [span("\n"), span(entry.text, styles.faint), span("\n")];
  }
}

/**
 * A note that has repeated fold into one line with a count: the gateway saying
 * "rate-limited" seven turns running is one fact about the route, not seven
 * events worth seven rows. The first occurrence shows plain; each repeat is
 * absorbed into the same row.
 */
function noteText(entry: Extract<Entry, { kind: "note" }>): string {
  return entry.count !== undefined && entry.count > 1 ? `${entry.text} ×${entry.count}` : entry.text;
}
