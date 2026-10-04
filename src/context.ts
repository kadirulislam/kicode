import { estimateTokens } from "./agent/compaction";
import type { ChatMessage } from "./types";

/**
 * The context window, broken down the way it is spent.
 *
 * Four rows, each an estimate (four characters to a token, the same convention
 * as `estimateTokens`): the system prompt alongside the tools it offers, the
 * skill list the briefing carries, this project's memory, and the conversation
 * itself. The briefing is part of the system prompt on the wire, so the system
 * row is what is left after the skill and memory rows are lifted out — the
 * rows add up to the whole instead of counting the briefing twice.
 */

export type ContextRow = {
  label: string;
  tokens: number;
  detail: string;
};

export type ContextBreakdown = {
  rows: ContextRow[];
  /** What the window holds, in estimated tokens. */
  used: number;
  /** The window, or 0 when the session names none. */
  budget: number;
};

export type ContextInput = {
  /** The system message, briefing included, exactly as the request carries it. */
  systemText: string;
  /** Tools the next request offers. */
  toolCount: number;
  /** Their declarations, estimated — they ride every request too. */
  toolTokens?: number;
  /** The skill list block, as sent — absent when the briefing carries none. */
  skillText?: string;
  /** Skills named in the block. */
  skillsLoaded?: number;
  /** The memory block, as sent — absent when the briefing carries none. */
  memoryText?: string;
  /** Memory files on disk, for the detail column. */
  memoryFiles?: number;
  /** Everything after the system prompt. */
  turns: readonly ChatMessage[];
  /** The window. */
  budget: number;
};

function countRole(turns: readonly ChatMessage[], role: "user" | "assistant"): number {
  return turns.filter((message) => message.role === role).length;
}

/**
 * `45.7k`, not `46k`: the shared short formatter drops the decimal past ten
 * thousand, which is where a context panel lives — the remaining count going
 * `954k, 953k` reads stuck beside a bar that keeps moving.
 */
export function formatContextTokens(count: number): string {
  if (count < 1000) return `${Math.max(Math.trunc(count), 0)}`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function summarizeContext(input: ContextInput): ContextBreakdown {
  const skillsTokens = input.skillText ? estimateTokens(input.skillText) : 0;
  const memoryTokens = input.memoryText ? estimateTokens(input.memoryText) : 0;
  // The briefing rides inside the system prompt: lifting its rows out leaves
  // the base prompt, and the rows add up to the whole. The tool declarations
  // ride alongside it on every request, so they cost into the same row.
  const systemTokens = Math.max(estimateTokens(input.systemText) - skillsTokens - memoryTokens, 0) + (input.toolTokens ?? 0);
  const messageTokens = estimateTokens(input.turns);

  const users = countRole(input.turns, "user");
  const assistants = countRole(input.turns, "assistant");

  const rows: ContextRow[] = [
    {
      label: "System tools",
      tokens: systemTokens,
      detail: `${input.toolCount} tools`,
    },
  ];
  if (input.skillText) {
    rows.push({
      label: "Skills",
      tokens: skillsTokens,
      detail: `${input.skillsLoaded ?? 0} loaded`,
    });
  }
  if (input.memoryText) {
    rows.push({
      label: "Memory",
      tokens: memoryTokens,
      detail: input.memoryFiles === 1 ? "1 memory file" : `${input.memoryFiles ?? 0} memory files`,
    });
  }
  rows.push({
    label: "Messages",
    tokens: messageTokens,
    detail: `${users} user · ${assistants} assistant`,
  });

  return { rows, used: systemTokens + skillsTokens + memoryTokens + messageTokens, budget: Math.max(Math.trunc(input.budget), 0) };
}

/** `45.7k / 1M · 954.3k remaining (estimated)`. Unknown budget says so. */
export function contextHeadline(used: number, budget: number): string {
  if (budget <= 0) return `${formatContextTokens(used)} used · window unknown`;
  return `${formatContextTokens(used)} / ${formatContextTokens(budget)} · ${formatContextTokens(Math.max(budget - used, 0))} remaining (estimated)`;
}

/**
 * A 24-cell bar, filled to the share used. Over budget fills it whole rather
 * than drawing past the end.
 */
export const CONTEXT_BAR_CELLS = 24;

export function contextBar(used: number, budget: number): string | null {
  if (budget <= 0) return null;
  const filled = Math.min(Math.round((Math.max(used, 0) / budget) * CONTEXT_BAR_CELLS), CONTEXT_BAR_CELLS);
  return `${"█".repeat(filled)}${"░".repeat(CONTEXT_BAR_CELLS - filled)}`;
}

/** One line per row: `System tools   12.6k tokens · 22 built-in`. */
export function contextRowLine(row: ContextRow): string {
  return `${row.label}  ${formatContextTokens(row.tokens)} tokens · ${row.detail}`;
}

/**
 * The panel, plain text: model line, bar with the share, the headline, then
 * the rows. A modal body and the transcript both read these lines as-is.
 */
export function renderContext(model: string, breakdown: ContextBreakdown): string[] {
  const lines = [`CONTEXT · ${model}`];
  const { used, budget } = breakdown;
  if (budget > 0) {
    const percent = ((Math.max(used, 0) / budget) * 100).toFixed(1);
    const bar = contextBar(used, budget);
    lines.push(bar ? `${bar}  ${percent}%` : `${percent}%`);
  }
  lines.push(contextHeadline(used, budget));
  lines.push(...breakdown.rows.map(contextRowLine));
  return lines;
}
