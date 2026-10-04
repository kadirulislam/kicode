import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveHome } from "./paths";

/**
 * Machine-wide usage tracking.
 *
 * One JSON line per finished turn in `<KICODE_HOME or ~/.kicode>/usage.jsonl`.
 * Counts only — the model, the endpoint's host, tokens, tool calls, duration.
 * No prompts, no transcripts, no keys, and not even the full URL: a query
 * string can carry a credential, so only the hostname is kept.
 *
 * The file is append-only and every read tolerates garbage: a corrupt line is
 * skipped, a missing file is an empty history. Two processes appending at once
 * are fine — each `appendFile` is one `O_APPEND` write.
 */

export type UsageRecord = {
  /** When the turn finished, UTC. */
  at: string;
  model: string;
  /** Endpoint hostname (`api.openai.com`), never the URL. */
  host: string;
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
  /** How long the turn took, milliseconds. */
  ms: number;
};

/** A finished turn's numbers, before they are filed under an endpoint host. */
export type TurnUsage = {
  model: string;
  baseUrl: string;
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
  ms: number;
};

export function usageFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveHome(env), "usage.jsonl");
}

/** The hostname of an endpoint, or `"unknown"` when it does not parse. */
export function hostOfBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

function isRecord(value: unknown): value is UsageRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.at === "string" &&
    typeof record.model === "string" &&
    typeof record.host === "string" &&
    typeof record.promptTokens === "number" &&
    typeof record.completionTokens === "number" &&
    typeof record.toolCalls === "number" &&
    typeof record.ms === "number"
  );
}

/**
 * Files one finished turn. A turn that cost nothing (no tokens, no tools) is
 * not worth a line — providers that report no usage would otherwise fill the
 * file with zeros.
 *
 * Returns null when there was nothing to file, so callers can skip the write.
 */
export function turnRecord(turn: TurnUsage, at = new Date().toISOString()): UsageRecord | null {
  if (turn.promptTokens <= 0 && turn.completionTokens <= 0 && turn.toolCalls <= 0) return null;
  return {
    at,
    model: turn.model,
    host: hostOfBaseUrl(turn.baseUrl),
    promptTokens: Math.max(Math.trunc(turn.promptTokens), 0),
    completionTokens: Math.max(Math.trunc(turn.completionTokens), 0),
    toolCalls: Math.max(Math.trunc(turn.toolCalls), 0),
    ms: Math.max(Math.trunc(turn.ms), 0),
  };
}

export async function recordUsage(record: UsageRecord, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = usageFile(env);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

export async function readUsage(env: NodeJS.ProcessEnv = process.env): Promise<UsageRecord[]> {
  let raw: string;
  try {
    raw = await readFile(usageFile(env), "utf8");
  } catch {
    return [];
  }
  const records: UsageRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // A half-written line from a killed process is not history.
    }
  }
  return records;
}

export type UsageTotals = {
  turns: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolCalls: number;
  ms: number;
};

const emptyTotals = (): UsageTotals => ({ turns: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCalls: 0, ms: 0 });

function addTotals(into: UsageTotals, record: UsageRecord): void {
  into.turns += 1;
  into.promptTokens += record.promptTokens;
  into.completionTokens += record.completionTokens;
  into.totalTokens += record.promptTokens + record.completionTokens;
  into.toolCalls += record.toolCalls;
  into.ms += record.ms;
}

export type UsageSummary = {
  /** Local day (`YYYY-MM-DD`), newest first. */
  days: Array<{ day: string } & UsageTotals>;
  /** Model id, most tokens first. */
  models: Array<{ model: string } & UsageTotals>;
  total: UsageTotals;
};

/** Local-day bucket: usage is read on the machine that spent it. */
export function dayOf(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "unknown";
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function summarizeUsage(records: readonly UsageRecord[]): UsageSummary {
  const days = new Map<string, UsageTotals>();
  const models = new Map<string, UsageTotals>();
  const total = emptyTotals();
  for (const record of records) {
    const day = dayOf(record.at);
    let dayTotals = days.get(day);
    if (!dayTotals) {
      dayTotals = emptyTotals();
      days.set(day, dayTotals);
    }
    addTotals(dayTotals, record);
    let modelTotals = models.get(record.model);
    if (!modelTotals) {
      modelTotals = emptyTotals();
      models.set(record.model, modelTotals);
    }
    addTotals(modelTotals, record);
    addTotals(total, record);
  }
  return {
    days: [...days.entries()]
      .map(([day, totals]) => ({ day, ...totals }))
      .sort((a, b) => (a.day < b.day ? 1 : -1)),
    models: [...models.entries()]
      .map(([model, totals]) => ({ model, ...totals }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.turns - a.turns),
    total,
  };
}

export function formatTokensShort(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}K`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 === 0 ? "" : ` ${minutes % 60}m`}`;
}

/** One rollup line: turns, tokens in/out, tool calls, time. */
export function totalsLine(label: string, totals: UsageTotals): string {
  return (
    `${label}: ${totals.turns} turn${totals.turns === 1 ? "" : "s"} · ` +
    `${formatTokensShort(totals.totalTokens)} tokens (${formatTokensShort(totals.promptTokens)} in / ${formatTokensShort(totals.completionTokens)} out) · ` +
    `${totals.toolCalls} tool call${totals.toolCalls === 1 ? "" : "s"} · ${formatDuration(totals.ms)}`
  );
}

/** How many day rows `/usage` prints before folding the rest into one line. */
const DAYS_SHOWN = 14;
/** How many model rows `/usage` prints before folding the rest. */
const MODELS_SHOWN = 8;

/** Human-readable rollup: total, per-day, per-model. Empty history says so. */
export function renderUsage(summary: UsageSummary): string[] {
  if (summary.total.turns === 0) return ["no usage recorded yet — the file fills in as turns finish"];
  const days = summary.days.slice(0, DAYS_SHOWN);
  const models = summary.models.slice(0, MODELS_SHOWN);
  const lines = [
    totalsLine("all time", summary.total),
    ...days.map((day) => totalsLine(day.day, day)),
    ...models.map((model) => totalsLine(model.model, model)),
  ];
  if (summary.days.length > days.length) lines.push(`… and ${summary.days.length - days.length} earlier day${summary.days.length - days.length === 1 ? "" : "s"}`);
  if (summary.models.length > models.length) lines.push(`… and ${summary.models.length - models.length} more model${summary.models.length - models.length === 1 ? "" : "s"}`);
  return lines;
}

/** Machine-readable rollup for `kicode --usage --json`. */
export function usageReportJson(summary: UsageSummary): string {
  return JSON.stringify(summary, null, 2);
}
