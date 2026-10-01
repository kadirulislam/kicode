/**
 * A minimal line diff.
 *
 * Enough to show a user exactly what a tool is about to change before they
 * approve it, without pulling in a diff dependency. Longest-common-subsequence
 * over lines, then grouped into hunks with configurable context.
 */

const MAX_DIFF_LINES = 1200;
const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_LINES = 400;

export type DiffOptions = {
  /** Unchanged lines kept on each side of a change. */
  context?: number;
  /** Cap on emitted lines; the remainder is summarised. */
  maxLines?: number;
};

type Op = { type: "equal" | "delete" | "insert"; text: string };

export function splitLines(text: string): string[] {
  // An empty file is zero lines, not one empty line — otherwise creating a file
  // would render a phantom deletion.
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  // A trailing newline is not a line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffLines(before: string, after: string, options: DiffOptions = {}): string {
  const a = splitLines(before);
  const b = splitLines(after);

  // O(n*m) is fine for source files; a generated bundle is not, and dumping a
  // 50k-line diff into a terminal is useless anyway.
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return `(${a.length} → ${b.length} lines; too large to diff inline)`;
  }

  const ops = lcsOps(a, b);
  const lines: string[] = [];

  for (const [start, end] of hunkRanges(ops, options.context ?? DEFAULT_CONTEXT)) {
    const slice = ops.slice(start, end + 1);
    const prefix = ops.slice(0, start);
    lines.push(`@@ -${countBefore(prefix) + 1},${countBefore(slice)} +${countAfter(prefix) + 1},${countAfter(slice)} @@`);
    for (const op of slice) {
      lines.push(`${op.type === "insert" ? "+" : op.type === "delete" ? "-" : " "}${op.text}`);
    }
  }

  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  if (lines.length > maxLines) {
    const hidden = lines.length - maxLines;
    return [...lines.slice(0, maxLines), `… ${hidden} more diff line${hidden === 1 ? "" : "s"}`].join("\n");
  }
  return lines.join("\n");
}

function countBefore(ops: Op[]): number {
  return ops.filter((op) => op.type !== "insert").length;
}

function countAfter(ops: Op[]): number {
  return ops.filter((op) => op.type !== "delete").length;
}

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs = new Uint32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", text: a[i] ?? "" });
      i++;
      j++;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      ops.push({ type: "delete", text: a[i] ?? "" });
      i++;
    } else {
      ops.push({ type: "insert", text: b[j] ?? "" });
      j++;
    }
  }
  while (i < n) ops.push({ type: "delete", text: a[i++] ?? "" });
  while (j < m) ops.push({ type: "insert", text: b[j++] ?? "" });

  return ops;
}

/** Index ranges to print, keeping `context` unchanged lines around each change. */
function hunkRanges(ops: Op[], context: number): [number, number][] {
  const ranges: [number, number][] = [];

  for (let index = 0; index < ops.length; index++) {
    if (ops[index]?.type === "equal") continue;

    const start = Math.max(0, index - context);
    const end = Math.min(ops.length - 1, index + context);
    const last = ranges[ranges.length - 1];

    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  return ranges;
}
