/**
 * Terminal primitives, hand-rolled.
 *
 * KiCode has no runtime dependencies, so the TUI is built from escape codes
 * rather than a renderer library. Two things make that workable: every colour
 * is a 24-bit SGR code (universally supported by the terminals we target), and
 * text is carried as *spans* — a string plus the style that applies to it —
 * so width math never has to parse escape codes out of the middle of a line.
 */

export const RESET = "\u001b[0m";
export const BOLD = "\u001b[1m";
export const DIM = "\u001b[2m";
export const ITALIC = "\u001b[3m";
export const UNDERLINE = "\u001b[4m";

/**
 * Inverse video, for a text selection.
 *
 * The terminal's own inversion rather than a colour of our own, so the
 * highlight follows whatever palette is in use — and so a theme cannot ship a
 * selection nobody can see. It is cleared by the `RESET` every span ends with,
 * which is why it can simply be prefixed onto a span's style.
 */
export const INVERSE = "\u001b[7m";

/** Erase from the cursor to the end of the row, in the current background. */
export const ERASE_TO_EOL = "\u001b[K";
export const CURSOR_HOME = "\u001b[H";
export const CLEAR_SCREEN = "\u001b[2J";
export const HIDE_CURSOR = "\u001b[?25l";
export const SHOW_CURSOR = "\u001b[?25h";
export const ENTER_ALT_SCREEN = "\u001b[?1049h";
export const LEAVE_ALT_SCREEN = "\u001b[?1049l";

/**
 * Mouse reporting, in SGR encoding.
 *
 * `1000` is presses and releases, `1002` adds motion *while a button is held* —
 * which is what a drag-to-select is made of — and `1003`, every pointer move, is
 * deliberately not asked for: it would be a stream of events for nothing. SGR
 * (`1006`) is what reports coordinates past column 223. While this is on, a
 * terminal hands the mouse to the application; KiCode uses the drag itself for
 * selection, and the terminal's own bypass is still there as a second way.
 */
export const ENABLE_MOUSE = "\u001b[?1000h\u001b[?1003h\u001b[?1006h";
export const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1003l\u001b[?1000l";

/**
 * Bracketed paste.
 *
 * Without this the terminal hands a paste over as if it had been typed: every
 * newline becomes a real Enter and the prompt is submitted halfway down the
 * snippet — which reads as "pasting does not work". Asking for `2004` makes the
 * terminal wrap the whole thing in `ESC [ 200 ~ … ESC [ 201 ~`, which the key
 * decoder turns into one `paste` key that can carry newlines safely.
 */
export const ENABLE_PASTE = "\u001b[?2004h";
export const DISABLE_PASTE = "\u001b[?2004l";
export const ENABLE_WRAP = "\u001b[?7h";
export const DISABLE_WRAP = "\u001b[?7l";

export function cursorTo(row: number, col: number): string {
  return `\u001b[${row + 1};${col + 1}H`;
}

let colorEnabled = true;

/** `NO_COLOR` and non-TTY output both turn every style into a no-op. */
export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

export function isColorEnabled(): boolean {
  return colorEnabled;
}

function hexToRgb(hex: string): [number, number, number] {
  let value = hex.replace("#", "").trim();
  if (value.length === 3) value = value.split("").map((char) => char + char).join("");
  const int = Number.parseInt(value, 16);
  if (!Number.isFinite(int) || value.length !== 6) return [255, 255, 255];
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

export function fg(hex: string): string {
  if (!colorEnabled) return "";
  const [r, g, b] = hexToRgb(hex);
  return `\u001b[38;2;${r};${g};${b}m`;
}

export function bg(hex: string): string {
  if (!colorEnabled) return "";
  const [r, g, b] = hexToRgb(hex);
  return `\u001b[48;2;${r};${g};${b}m`;
}

export function style(...codes: (string | undefined)[]): string {
  if (!colorEnabled) return "";
  return codes.filter((code): code is string => Boolean(code)).join("");
}

/** A piece of text plus the style to render it in. */
export type Span = {
  text: string;
  /** Pre-rendered SGR prefix, or "" for unstyled. */
  style?: string;
};

export function span(text: string, styleCode?: string): Span {
  return styleCode ? { text, style: styleCode } : { text };
}

/** Width of a single code point in terminal cells. */
export function charWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  // Combining marks and zero-width joiners ride along with the previous glyph.
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }
  // East Asian wide/fullwidth, plus the emoji blocks.
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function textWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0) ?? 0);
  return width;
}

export function spansWidth(spans: readonly Span[]): number {
  let width = 0;
  for (const item of spans) width += textWidth(item.text);
  return width;
}

/** Collapses newlines and tabs so a value cannot break the layout. */
/**
 * The cells `from`..`to` (inclusive, 0-based) of a plain string.
 *
 * The counterpart of `truncateSpans` for text that has already been rendered: a
 * selection is dragged over *cells*, and a cell is not a character — a wide
 * glyph covers two of them.
 */
export function sliceCells(text: string, from: number, to: number): string {
  let x = 0;
  let out = "";
  for (const char of text) {
    const width = charWidth(char.codePointAt(0) ?? 0);
    if (x + Math.max(width, 1) - 1 >= from && x <= to) out += char;
    x += width;
  }
  return out;
}

/** A rendered row, with every escape sequence taken back out. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

/**
 * The spans with one cell range drawn in a highlight style, for a text selection.
 *
 * Split at the range's edges rather than per character: a row is a handful of
 * spans and a drag usually covers whole ones, so this usually produces the same
 * number it was handed. The highlight style is applied *instead of* the span's
 * own — a selection cell shows the accent fill, not a blend — which is what
 * makes the drag read as one solid block regardless of what colours the text
 * underneath was wearing.
 */
export function markCells(spans: readonly Span[], from: number, to: number, highlight = INVERSE): Span[] {
  const out: Span[] = [];
  let x = 0;

  for (const item of spans) {
    let run = "";
    let inside = false;
    let started = false;

    const flush = (): void => {
      if (run) out.push(span(run, inside ? highlight : (item.style ?? "")));
      run = "";
    };

    for (const char of item.text) {
      const width = charWidth(char.codePointAt(0) ?? 0);
      // A character is selected when any of the cells it covers is.
      const here = x + Math.max(width, 1) - 1 >= from && x <= to;
      if (started && here !== inside) flush();
      run += char;
      inside = here;
      started = true;
      x += width;
    }

    flush();
  }

  return out;
}

export function flatten(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\t/g, "    ").replace(/\s+/g, " ").trim();
}

/**
 * Removes what a foreign string must not be able to do to the terminal.
 *
 * Model output, tool results and file contents all end up as frame text, and
 * none of them is under KiCode's control. A control sequence could move the
 * cursor, erase the screen or retitle the window; a carriage return would send
 * the rest of the row back to column 1; and a tab is one cell by declaration but
 * several on screen, which overruns the row and makes the terminal scroll — the
 * whole frame shifting by a row is the symptom, and a diff of any tab-indented
 * file would do it.
 *
 * Newlines are left alone: the layout uses them as line breaks. This is applied
 * on the way to the screen rather than to each source of text, so there is one
 * guarantee instead of one per feature.
 */
export function sanitiseText(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\t/g, "    ");
}

/**
 * Renders spans to a string.
 *
 * `background` is re-applied before every span, after the span's own style.
 * Without it, the reset that closes each span would drop the terminal back to
 * its *default* background for the next one — so styled text would paint on the
 * wrong colour and the theme would only show through in the gaps.
 */
export function renderSpans(spans: readonly Span[], background = ""): string {
  let out = "";
  for (const item of spans) {
    if (!item.text) continue;
    out += background + (item.style ?? "") + item.text + RESET;
  }
  return out;
}

/**
 * Wraps spans to `width` cells.
 *
 * Breaks at spaces when it can and mid-word when it must: a file path or URL
 * longer than the terminal has to be split rather than overflow the pane.
 */
export function wrapSpans(spans: readonly Span[], width: number): Span[][] {
  if (width <= 0) return [[]];

  const lines: Span[][] = [];
  let line: Span[] = [];
  let used = 0;

  const append = (text: string, style: string | undefined): void => {
    if (!text) return;
    line.push(style ? { text, style } : { text });
    used += textWidth(text);
  };

  const breakLine = (): void => {
    lines.push(line);
    line = [];
    used = 0;
  };

  for (const item of spans) {
    let buffer = "";
    const text = sanitiseText(item.text);

    for (const char of text) {
      if (char === "\n") {
        append(buffer, item.style);
        buffer = "";
        breakLine();
        continue;
      }

      const cells = charWidth(char.codePointAt(0) ?? 0);
      if (used + cells > width) {
        if (char === " ") {
          // The space itself ran past the edge, so the line is complete and the
          // break takes the space's place. Backing up to an earlier space here
          // would push a whole word down that fits.
          append(buffer, item.style);
          buffer = "";
          breakLine();
          continue;
        }

        // Back up to the last space so the word is not cut in half. Text that
        // already ends at a space breaks there instead, and a word with no
        // space in it is wider than the pane, so it has to be cut.
        const space = buffer.endsWith(" ") ? -1 : buffer.lastIndexOf(" ");
        const head = space > 0 ? buffer.slice(0, space) : buffer.replace(/ +$/, "");
        const tail = space > 0 ? buffer.slice(space + 1) : "";

        append(head, item.style);
        breakLine();

        buffer = tail;
        used = textWidth(tail);
      }

      // The character that did not fit is still the one in hand, so it starts
      // the next line rather than being lost.
      buffer += char;
      used += cells;
    }

    append(buffer, item.style);
  }

  if (line.length > 0 || lines.length === 0) lines.push(line);
  return lines;
}

/** Pads with spaces to exactly `width` cells, never truncating. */
export function padSpans(spans: readonly Span[], width: number): Span[] {
  const gap = width - spansWidth(spans);
  if (gap <= 0) return [...spans];
  return [...spans, { text: " ".repeat(gap) }];
}

/** Cuts to `width` cells, using an ellipsis when it has to. */
export function truncateSpans(spans: readonly Span[], width: number): Span[] {
  if (width <= 0) return [];

  // The last stop before every row is written, so it is where the text is made
  // safe: nothing else in the pipeline is guaranteed to run, and the early
  // return below would otherwise skip it on the rows that fit.
  const clean = spans.map((item) => {
    const text = sanitiseText(item.text);
    return item.style ? { text, style: item.style } : { text };
  });

  if (spansWidth(clean) <= width) return clean;

  const out: Span[] = [];
  let used = 0;
  for (const item of clean) {
    let buffer = "";
    for (const char of item.text) {
      const charCells = charWidth(char.codePointAt(0) ?? 0);
      if (used + charCells > width - 1) break;
      buffer += char;
      used += charCells;
    }
    if (buffer) out.push({ text: buffer, ...(item.style ? { style: item.style } : {}) });
    if (used >= width - 1) break;
  }
  out.push({ text: "…" });
  return out;
}

