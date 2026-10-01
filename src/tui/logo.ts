import { type Span, fg } from "./ansi";
import { type Theme, blend } from "./theme";

/**
 * The home screen wordmark.
 *
 * Drawn as a small pixel font and tinted with a left-to-right gradient: dark
 * slate at the start of the word, white at the end. The colour is computed from
 * the column, so the two-tone look comes from the glyph shapes rather than from
 * hand-authoring two versions of the art.
 */

const GLYPHS: Record<string, string[]> = {
  k: ["█  █", "█ █ ", "██  ", "█ █ ", "█  █"],
  i: ["███", " █ ", " █ ", " █ ", "███"],
  c: [" ███", "█   ", "█   ", "█   ", " ███"],
  o: [" ██ ", "█  █", "█  █", "█  █", " ██ "],
  d: ["   █", "   █", " ███", "█  █", " ███"],
  e: [" ██ ", "█  █", "████", "█   ", " ███"],
};

export const LOGO_TEXT = "kicode";

type Cell = { col: number; char: string };

/** The wordmark as a grid of cells, independent of colour. */
function grid(text: string): Cell[][] {
  const rows: Cell[][] = Array.from({ length: 5 }, () => []);
  let col = 0;

  for (const char of text) {
    const glyph = GLYPHS[char];
    if (!glyph) {
      col += 1; // an unknown character becomes a blank column
      continue;
    }
    const width = Math.max(...glyph.map((row) => row.length));
    for (let row = 0; row < rows.length; row++) {
      const source = glyph[row] ?? "";
      for (let x = 0; x < width; x++) {
        const cell = source[x] ?? " ";
        if (cell !== " ") rows[row]?.push({ col: col + x, char: cell });
      }
    }
    col += width + 1;
  }

  return rows;
}

/** Display width of the wordmark in cells. */
export function logoWidth(text = LOGO_TEXT): number {
  const rows = grid(text);
  return rows.reduce((max, row) => Math.max(max, ...row.map((cell) => cell.col + 1), 0), 0);
}

/** The wordmark, one entry per row, each cell tinted by its column. */
export function logoRows(theme: Theme, text = LOGO_TEXT): Span[][] {
  const rows = grid(text);
  // Dividing by the last column index, so the final column reaches full white.
  const span = Math.max(logoWidth(text) - 1, 1);

  return rows.map((row) => {
    const at = new Map(row.map((cell) => [cell.col, cell.char]));
    const spans: Span[] = [];

    let run = "";
    let runStyle: string | undefined;

    const flush = (): void => {
      if (!run) return;
      spans.push(runStyle ? { text: run, style: runStyle } : { text: run });
      run = "";
    };

    // Every column is emitted, blanks included — dropping the blanks would
    // close the gaps in a glyph like `k` and turn the wordmark into a bar.
    // Consecutive columns share a colour, so runs keep the escape count small.
    for (let col = 0; col <= span; col++) {
      const char = at.get(col) ?? " ";
      const styleCode = at.has(col) ? fg(blend(theme.logoFrom, theme.logoTo, col / span)) : undefined;
      if (styleCode !== runStyle) {
        flush();
        runStyle = styleCode;
      }
      run += char;
    }

    flush();
    return spans;
  });
}
