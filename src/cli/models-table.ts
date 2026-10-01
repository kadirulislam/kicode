import type { ModelRecord } from "../providers/openai";

/**
 * Renders `--models` as an aligned table.
 *
 * The point is to pick a model without leaving the terminal: which routes are
 * free, how much context they take, and whether they can call tools at all —
 * an agent is useless without the last one.
 */

export type ModelsTableOptions = {
  /** Marked with `*` so the active model is obvious. */
  currentModel?: string;
};

const MAX_ID_WIDTH = 44;

export function renderModelsTable(models: readonly ModelRecord[], options: ModelsTableOptions = {}): string {
  if (models.length === 0) return "This endpoint listed no models.";

  // Free first — the thing being looked for — then alphabetical within a group.
  const sorted = [...models].sort((a, b) => (a.free === b.free ? a.id.localeCompare(b.id) : a.free ? -1 : 1));

  const rows = sorted.map((model) => ({
    mark: model.id === options.currentModel ? "*" : " ",
    id: model.id,
    tier: model.tier ?? "—",
    ctx: formatContext(model.contextLength),
    tools: model.supportsTools === undefined ? "—" : model.supportsTools ? "yes" : "NO",
    cost: model.free ? "FREE" : "paid",
  }));

  const idWidth = clamp(widest(rows.map((row) => row.id)), 5, MAX_ID_WIDTH);
  const tierWidth = widest(rows.map((row) => row.tier));
  const ctxWidth = Math.max(3, widest(rows.map((row) => row.ctx)));
  const toolsWidth = Math.max(5, widest(rows.map((row) => row.tools)));

  const row = (mark: string, id: string, tier: string, ctx: string, tools: string, cost: string): string =>
    [
      mark,
      fit(id, idWidth).padEnd(idWidth),
      tier.padEnd(tierWidth),
      ctx.padStart(ctxWidth),
      tools.padEnd(toolsWidth),
      cost,
    ].join("  ");

  const lines = [
    row(" ", "MODEL", "TIER", "CTX", "TOOLS", "COST"),
    ...rows.map((entry) => row(entry.mark, entry.id, entry.tier, entry.ctx, entry.tools, entry.cost)),
  ];

  return `${lines.join("\n")}\n\n${summary(sorted, options.currentModel)}`;
}

function summary(models: readonly ModelRecord[], currentModel: string | undefined): string {
  const free = models.filter((model) => model.free).length;
  const noTools = models.filter((model) => model.supportsTools === false).length;

  const parts = [`${models.length} model${models.length === 1 ? "" : "s"}`, `${free} free`];

  if (currentModel) {
    parts.push(models.some((model) => model.id === currentModel) ? `current: ${currentModel}` : `current: ${currentModel} (not offered here)`);
  }

  const notes: string[] = [];
  if (free > 0) notes.push("FREE rows are not billed");
  if (noTools > 0) notes.push(`${noTools} model${noTools === 1 ? "" : "s"} cannot call tools, so they cannot drive the agent`);

  return notes.length > 0 ? `${parts.join(" · ")}\n${notes.join(". ")}.` : parts.join(" · ");
}

function formatContext(value: number | undefined): string {
  if (value === undefined || value <= 0) return "—";
  if (value >= 1_000_000) return `${trimZero(value / 1_000_000)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function widest(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function fit(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(width - 1, 1))}…`;
}
