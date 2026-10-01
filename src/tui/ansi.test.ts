import { describe, expect, it } from "vitest";
import { INVERSE, markCells, sliceCells, spansWidth, textWidth, truncateSpans, wrapSpans, type Span } from "./ansi";

const plain = (spans: readonly Span[]): string => spans.map((span) => span.text).join("");
const lines = (text: string, width: number): string[] => wrapSpans([{ text }], width).map(plain);

describe("wrapSpans", () => {
  it("keeps words whole and moves the one that does not fit", () => {
    expect(lines("one two three four five", 10)).toEqual(["one two", "three four", "five"]);
  });

  it("never drops a letter", () => {
    const text = "one two three four five six seven eight nine ten eleven";

    for (const width of [6, 9, 13, 20, 37]) {
      // Spaces may go at a break point; nothing else may.
      expect(lines(text, width).join("").replace(/ /g, "")).toBe(text.replace(/ /g, ""));
    }
  });

  it("uses the whole line before breaking", () => {
    // "three four" is exactly ten cells, so it belongs on one line.
    expect(lines("one two three four five", 10)).toEqual(["one two", "three four", "five"]);
    expect(lines("one two three four five six seven eight", 20)).toEqual([
      "one two three four",
      "five six seven eight",
    ]);
  });

  it("never leaves a space at the end of a line", () => {
    // A trailing space is invisible, but it costs a cell and indents the next
    // line by one when it is re-joined.
    const text = "alpha beta gamma delta epsilon zeta";

    for (const width of [5, 11, 17, 23]) {
      for (const line of lines(text, width)) expect(line).toBe(line.trimEnd());
    }
  });

  it("splits a word wider than the pane rather than overflowing it", () => {
    const long = "averyverylongpath/that/never/breaks.tsx";

    const wrapped = lines(long, 10);

    expect(wrapped.every((line) => textWidth(line) <= 10)).toBe(true);
    expect(wrapped.join("")).toBe(long);
  });

  it("honours hard newlines in the text", () => {
    expect(lines("first\nsecond", 40)).toEqual(["first", "second"]);
  });

  it("keeps the style with its own text", () => {
    const wrapped = wrapSpans(
      [
        { text: "bold\n", style: "B" },
        { text: "plain" },
      ],
      20,
    );

    expect(wrapped.map(plain)).toEqual(["bold", "plain"]);
    expect(wrapped[0]?.[0]?.style).toBe("B");
    expect(wrapped[1]?.[0]?.style).toBeUndefined();
  });

  it("returns one empty line when there is nothing to wrap", () => {
    expect(wrapSpans([], 10)).toEqual([[]]);
    expect(wrapSpans([{ text: "" }], 10)).toEqual([[]]);
  });

  it("does not loop forever on a zero width", () => {
    expect(wrapSpans([{ text: "anything" }], 0)).toEqual([[]]);
  });
});

describe("truncateSpans", () => {
  it("leaves short text alone", () => {
    expect(plain(truncateSpans([{ text: "short" }], 10))).toBe("short");
  });

  it("marks what it cut", () => {
    const cut = truncateSpans([{ text: "a long sentence" }], 8);

    expect(textWidth(plain(cut))).toBeLessThanOrEqual(8);
    expect(plain(cut)).toContain("…");
  });

  it("measures wide characters as two cells", () => {
    expect(spansWidth([{ text: "日本" }])).toBe(4);
    expect(textWidth("ok")).toBe(2);
  });

  it("makes text safe even on the rows that fit", () => {
    // The early return is the common path, so the guarantee cannot live only
    // inside the truncating loop.
    expect(plain(truncateSpans([{ text: "\u001b[31mred\u001b[0m" }], 40))).toBe("red");
  });
});

describe("text from outside KiCode", () => {
  it("cannot drive the terminal", () => {
    // Model output, tool results and file contents all reach the same writer.
    expect(plain(truncateSpans([{ text: "\u001b[2J\u001b[Hcleared" }], 40))).toBe("cleared");
    expect(plain(truncateSpans([{ text: "\u001b]0;pwned\u0007text" }], 40))).toBe("]0;pwnedtext");
    expect(plain(truncateSpans([{ text: "a\rbc" }], 40))).toBe("abc");
  });

  it("counts a tab as the four cells it takes on screen", () => {
    // Counting it as one cell is what let a tab-indented diff overrun the row,
    // and an overrun row wraps — which scrolls the whole frame by a line.
    expect(spansWidth(truncateSpans([{ text: "\tx" }], 40))).toBe(5);
  });

  it("keeps the newlines the layout breaks lines with", () => {
    expect(plain(truncateSpans([{ text: "one\ntwo" }], 40))).toBe("one\ntwo");
  });

  it("is made safe before wrapping, so a tab does not cost the text after it", () => {
    // Measured as one cell, the tab fits on the line and `abc` is only cut later
    // — by the truncation that would then drop it without a word. Expanded to
    // the four cells it takes on screen, the break happens where it belongs.
    const wrapped = wrapSpans([{ text: "\tabc" }], 4);

    for (const line of wrapped) expect(spansWidth(line)).toBeLessThanOrEqual(4);
    expect(wrapped.map(plain).join("")).toBe("abc");
  });
});

describe("the cells a selection covers", () => {
  it("takes both ends of the range, and nothing outside it", () => {
    expect(sliceCells("hello world", 0, 4)).toBe("hello");
    expect(sliceCells("hello world", 6, 10)).toBe("world");
    // Past the end of the row is an empty string, not an error.
    expect(sliceCells("hi", 5, 9)).toBe("");
  });

  it("takes a wide glyph whole when either of its cells is covered", () => {
    // A cell is not a character: the two-byte glyph is taken as one.
    expect(sliceCells("a漢b", 1, 2)).toBe("漢");
    expect(sliceCells("a漢b", 2, 2)).toBe("漢");
  });

  it("marks only the covered part of a row, in reverse", () => {
    const marked = markCells([{ text: "hello world" }], 6, 10);

    // The row reads the same; only a run of it is highlighted.
    expect(plain(marked)).toBe("hello world");
    expect(marked.find((span) => span.text === "world")?.style).toContain(INVERSE);
    expect(marked.find((span) => span.text === "hello ")?.style ?? "").not.toContain(INVERSE);
  });

  it("replaces the span's colour inside the highlight by default", () => {
    // A selection cell shows the highlight style, not a blend: the accent-fill
    // selection passes its own style here, and mixed colours under a drag
    // would otherwise read as patchwork.
    const marked = markCells([{ text: "abcd", style: "\u001b[31m" }], 1, 2);

    expect(marked.find((span) => span.text === "bc")?.style).toBe(INVERSE);
    expect(marked.find((span) => span.text === "a")?.style).toBe("\u001b[31m");
  });

  it("takes a custom highlight style, as the themed selection does", () => {
    const marked = markCells([{ text: "abcd", style: "\u001b[31m" }], 1, 2, "\u001b[48;2;1;2;3m");

    expect(marked.find((span) => span.text === "bc")?.style).toBe("\u001b[48;2;1;2;3m");
  });
});
