import { type Span, span, spansWidth, textWidth } from "./ansi";
import { highlightLine, normalizeLanguage, type SupportedLang } from "./syntax";
import type { Styles } from "./theme";

/**
 * A markdown renderer with zero-dependency syntax highlighting for code fences.
 *
 * Models write markdown; a terminal shows the asterisks. This covers what
 * actually shows up in an answer — fenced code blocks with language-aware syntax
 * coloring, bold, inline code, headings, bullets, links — and leaves everything
 * else as typed, because half-rendering a document is worse than not rendering it.
 *
 * `_underscores_` are deliberately *not* italicised: in a coding agent they are
 * overwhelmingly snake_case identifiers (`show_if`, `my_file.ts`), and mangling
 * those is far worse than losing one emphasis style.
 */

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\))/g;

export function markdownSpans(text: string, styles: Styles, width?: number): Span[] {
  const spans: Span[] = [];
  let inFence = false;
  let fenceLang: SupportedLang = "generic";
  let fenceTag = "";

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (index > 0) spans.push(span("\n"));

    // A GFM pipe table: header row, delimiter row, then body rows. Consumed
    // as one block so the rows can share column widths instead of each line
    // rendering on its own. A table wider than the column degrades to
    // key/value lines rather than wrapping mid-cell into an unreadable grid.
    if (!inFence && line.includes("|")) {
      const table = consumeTable(lines, index);
      if (table) {
        spans.push(...tableSpans(table, styles, width));
        index = table.next;
        continue;
      }
    }

    // Check for fenced code block boundary (``` or ~~~)
    const fenceMatch = /^\s*(`{3,}|~{3,})\s*([a-zA-Z0-9_.-]*)/.exec(line);

    if (fenceMatch) {
      if (!inFence) {
        // Entering fence
        inFence = true;
        fenceTag = fenceMatch[1] ?? "```";
        const rawLang = fenceMatch[2] ?? "";
        fenceLang = normalizeLanguage(rawLang);
        spans.push(span("  ╭─ ", styles.rule));
        spans.push(span(rawLang || "code", styles.dim));
        continue;
      } else if (line.trim().startsWith(fenceTag[0] ?? "`")) {
        // Closing fence
        inFence = false;
        spans.push(span("  ╰──", styles.rule));
        continue;
      }
    }

    if (inFence) {
      // Line inside code block: gutter rule + syntax-highlighted tokens
      spans.push(span("  │ ", styles.rule));
      spans.push(...highlightLine(line, fenceLang, styles));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      spans.push(span(heading[2] ?? "", styles.accentBold));
      continue;
    }

    // `- item`, `* item`, `+ item` and `1. item` become real list rows, nested
    // by two-space indent. The marker is consumed here so a bullet is never
    // mistaken for the start of *emphasis*, and `- [ ]` / `- [x]` task items
    // get their own glyphs instead of rendering the brackets literally.
    const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (list) {
      const indent = (list[1] ?? "").replace(/\t/g, "  ");
      const level = Math.min(Math.floor(indent.length / 2), 6);
      const marker = list[2] ?? "-";
      let rest = list[3] ?? "";
      const pad = "  ".repeat(level);

      const task = /^\[([ xX])\]\s+(.*)$/.exec(rest);
      if (task) {
        const done = task[1]?.toLowerCase() === "x";
        spans.push(span(`${pad}${done ? "✓ " : "○ "}`, done ? styles.ok : styles.faint));
        spans.push(...inline(task[2] ?? "", styles));
        continue;
      }

      if (/^[-*+]$/.test(marker)) {
        const glyph = level === 0 ? "• " : level === 1 ? "◦ " : "– ";
        spans.push(span(`${pad}${glyph}`, level === 0 ? styles.accent : styles.faint));
      } else {
        spans.push(span(`${pad}${marker} `, level === 0 ? styles.accent : styles.faint));
      }
      spans.push(...inline(rest, styles));
      continue;
    }

    spans.push(...inline(line, styles));
  }

  return spans;
}

type TableAlign = "left" | "center" | "right";

type Table = { header: string[]; align: TableAlign[]; body: string[][]; next: number };

/** Split a `|` row into cells, honouring `\|` escapes. */
function splitCells(line: string): string[] {
  const placeholder = "\u0000";
  const escaped = line.replace(/\\\|/g, placeholder);
  const trimmed = escaped.trim();
  const inner = trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1
    ? trimmed.slice(1, -1)
    : trimmed;
  return inner.split("|").map((cell) => cell.replaceAll(placeholder, "|").trim());
}

function isDelimiterCell(cell: string): TableAlign | null {
  if (!/^:?-+:?$/.test(cell)) return null;
  if (cell.startsWith(":") && cell.endsWith(":") && cell.length > 2) return "center";
  if (cell.endsWith(":")) return "right";
  return "left";
}

/**
 * A table starting at `at`: header row, delimiter row, then body rows.
 * Returns null when the shape is not a table, so the lines render as prose.
 */
function consumeTable(lines: readonly string[], at: number): Table | null {
  const header = splitCells(lines[at] ?? "");
  if (header.length === 0) return null;
  const delimLine = lines[at + 1] ?? "";
  if (!delimLine.includes("|") && !delimLine.includes("-")) return null;
  const delim = splitCells(delimLine);
  if (delim.length === 0) return null;
  const align: TableAlign[] = [];
  for (const cell of delim) {
    const parsed = isDelimiterCell(cell);
    if (!parsed) return null;
    align.push(parsed);
  }

  const width = Math.max(header.length, align.length);
  const body: string[][] = [];
  let next = at + 2;
  while (next < lines.length) {
    const candidate = lines[next] ?? "";
    if (!candidate.includes("|")) break;
    if (candidate.trim() === "") break;
    body.push(splitCells(candidate));
    next++;
  }
  const padRow = (row: string[]): string[] => {
    const out = [...row];
    while (out.length < width) out.push("");
    return out.slice(0, width);
  };
  while (align.length < width) align.push("left");
  return { header: padRow(header), align, body: body.map(padRow), next: next - 1 };
}

function padCell(spans: Span[], width: number, align: TableAlign): Span[] {
  const gap = Math.max(width - spansWidth(spans), 0);
  if (gap === 0) return spans;
  if (align === "right") return [span(" ".repeat(gap)), ...spans];
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return [span(" ".repeat(left)), ...spans, span(" ".repeat(gap - left))];
  }
  return [...spans, span(" ".repeat(gap))];
}

function tableSpans(table: Table, styles: Styles, width?: number): Span[] {
  const out: Span[] = [];
  const columns = table.header.length;

  const headerCells = table.header.map((cell) => inline(cell, styles));
  const bodyCells = table.body.map((row) => row.map((cell) => inline(cell, styles)));
  const colWidths = table.header.map((_, col) => {
    let widest = spansWidth(headerCells[col] ?? []);
    for (const row of bodyCells) widest = Math.max(widest, spansWidth(row[col] ?? []));
    return widest;
  });
  const total = colWidths.reduce((sum, w) => sum + w, 0) + (columns - 1) * 3;

  // Too wide for the column: one `header: value` line per cell instead of a
  // grid that would wrap mid-cell. The header still names each value.
  if (width !== undefined && total > width) {
    const plain = (cell: string): string => cell.replace(/\\\|/g, "|");
    table.body.forEach((row, rowIndex) => {
      if (rowIndex > 0) out.push(span("\n"));
      row.forEach((cell, col) => {
        if (col > 0) out.push(span("\n"));
        const name = plain(table.header[col] ?? "");
        if (name) {
          out.push(span(`${name}: `, styles.dim));
          out.push(...inline(cell, styles));
        } else {
          out.push(span("• ", styles.accent));
          out.push(...inline(cell, styles));
        }
      });
      if (rowIndex < table.body.length - 1) out.push(span("\n"));
    });
    if (table.body.length === 0) {
      table.header.forEach((cell, col) => {
        if (col > 0) out.push(span("\n"));
        out.push(span("• ", styles.accent));
        out.push(...inline(cell, styles));
      });
    }
    return out;
  }

  const joinRow = (cells: Span[][]): Span[] => {
    const row: Span[] = [];
    cells.forEach((cell, col) => {
      if (col > 0) row.push(span(" │ ", styles.rule));
      row.push(...padCell(cell, colWidths[col] ?? 0, table.align[col] ?? "left"));
    });
    return row;
  };

  out.push(
    ...joinRow(
      headerCells.map((cell) => cell.map((part) => ({ ...part, style: part.style || styles.bold }))),
    ),
  );
  out.push(span("\n"));
  out.push(
    span(
      colWidths.map((w) => "─".repeat(Math.max(w, 1))).join("─┼─"),
      styles.rule,
    ),
  );
  for (const row of bodyCells) {
    out.push(span("\n"));
    out.push(...joinRow(row));
  }
  return out;
}

function inline(text: string, styles: Styles): Span[] {
  const spans: Span[] = [];
  let last = 0;

  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) spans.push(span(text.slice(last, at)));
    const token = match[0];

    if (token.startsWith("**")) {        // Emphasis is its own colour, not just a weight: the word that matters
        // in a sentence should not look like chrome.
        spans.push(span(token.slice(2, -2), styles.emphasis));
    } else if (token.startsWith("`")) {
      spans.push(span(token.slice(1, -1), styles.code));
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      spans.push(span(link?.[1] ?? token));
      // The URL stays visible: terminals are not clickable everywhere, and a
      // bare label loses information.
      if (link?.[2]) spans.push(span(` (${link[2]})`, styles.hint));
    } else {
      spans.push(span(token.slice(1, -1), styles.italic));
    }

    last = at + token.length;
  }

  if (last < text.length) spans.push(span(text.slice(last)));
  return spans;
}

/** Collapses runs of blank lines and trims trailing whitespace. */
export function tidy(text: string): string {
  return text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "");
}
