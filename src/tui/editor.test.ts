import { describe, expect, it } from "vitest";
import { LineEditor, caretColumn, editorView } from "./editor";
import { shortenPath } from "./frame";
import { LOGO_TEXT, logoRows, logoWidth } from "./logo";
import { buildStyles, darkTheme } from "./theme";
import { spansWidth } from "./ansi";

const styles = buildStyles(darkTheme);

describe("LineEditor", () => {
  it("inserts at the caret", () => {
    const editor = new LineEditor();
    editor.insert("ac");
    editor.left();
    editor.insert("b");

    expect(editor.text).toBe("abc");
    expect(editor.cursor).toBe(2);
  });

  it("backspaces one character", () => {
    const editor = new LineEditor();
    editor.insert("ab");
    editor.backspace();

    expect(editor.text).toBe("a");
  });

  it("does nothing on backspace at the start", () => {
    const editor = new LineEditor();
    editor.insert("ab");
    editor.home();
    editor.backspace();

    expect(editor.text).toBe("ab");
    expect(editor.cursor).toBe(0);
  });

  it("deletes forward at the caret", () => {
    const editor = new LineEditor();
    editor.insert("abc");
    editor.left();
    editor.deleteForward();

    expect(editor.text).toBe("ab");
  });

  it("does not move the caret past either end", () => {
    const editor = new LineEditor();
    editor.insert("ab");
    for (let i = 0; i < 5; i++) editor.right();
    expect(editor.cursor).toBe(2);
    for (let i = 0; i < 5; i++) editor.left();
    expect(editor.cursor).toBe(0);
  });

  it("kills back to the start of the line", () => {
    const editor = new LineEditor();
    editor.insert("keep this");
    editor.setText("discard keep this", 8);
    editor.killToStart();

    expect(editor.text).toBe("keep this");
    expect(editor.cursor).toBe(0);
  });

  it("flattens a pasted newline so it cannot submit the prompt", () => {
    const editor = new LineEditor();
    editor.insert("line one\nline two");

    expect(editor.text).toBe("line one line two");
  });

  it("recalls the previous prompt", () => {
    const editor = new LineEditor();
    editor.acceptHistory("first");
    editor.acceptHistory("second");
    editor.clear();

    editor.historyPrev();
    expect(editor.text).toBe("second");
    editor.historyPrev();
    expect(editor.text).toBe("first");
    editor.historyNext();
    expect(editor.text).toBe("second");
    editor.historyNext();
    expect(editor.text).toBe("");
  });

  it("does not record the same prompt twice in a row", () => {
    const editor = new LineEditor();
    editor.acceptHistory("same");
    editor.acceptHistory("same");
    editor.historyPrev();
    editor.historyPrev();

    expect(editor.text).toBe("same");
  });

  it("ignores blank prompts in the history", () => {
    const editor = new LineEditor();
    editor.acceptHistory("   ");
    editor.historyPrev();

    expect(editor.text).toBe("");
  });

  it("measures the caret in cells, not code units", () => {
    const editor = new LineEditor();
    editor.setText("日本ab", 2);

    // Two wide characters occupy four cells, so the caret sits at column 4
    // even though it is only 2 code units in.
    expect(caretColumn(editor)).toBe(4);
    expect(editor.text.length).toBe(4);
  });
});

describe("editorView", () => {
  it("shows the placeholder when empty", () => {
    const view = editorView(new LineEditor(), styles, 60, "Ask anything");

    expect(view.caret).toBe(0);
    expect(view.spans.map((item) => item.text).join("")).toBe("Ask anything");
  });

  it("shows the typed text once there is some", () => {
    const editor = new LineEditor();
    editor.insert("hi");

    expect(editorView(editor, styles, 60, "Ask anything").spans.map((item) => item.text).join("")).toBe("hi");
  });

  it("truncates a placeholder that cannot fit", () => {
    const text = editorView(new LineEditor(), styles, 10, "Ask anything at all").spans.map((item) => item.text).join("");

    expect(text.length).toBeLessThanOrEqual(10);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("the wordmark", () => {
  it("is drawn from a fixed-width grid", () => {
    const rows = logoRows(darkTheme, LOGO_TEXT);

    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => spansWidth(row))).size).toBe(1);
    expect(spansWidth(rows[0] ?? [])).toBe(logoWidth());
  });

  it("keeps the gaps inside a glyph", () => {
    // A `k` is `█  █` on its first row; dropping the blanks would close it into
    // a solid bar and the wordmark would stop being readable.
    const first = (logoRows(darkTheme, "k")[0] ?? []).map((item) => item.text).join("");

    expect(first).toBe("█  █");
  });

  it("fades from dark to light across the word", () => {
    const row = logoRows(darkTheme, "kicode")[0] ?? [];
    const first = row.find((item) => item.text.includes("█"))?.style ?? "";
    const last = [...row].reverse().find((item) => item.text.includes("█"))?.style ?? "";

    expect(first).not.toBe(last);
    // The final column is drawn at full white, the first at the dark end.
    expect(last).toContain("38;2;255;255;255");
  });

  it("renders an unknown character as a gap rather than throwing", () => {
    expect(() => logoRows(darkTheme, "k?")).not.toThrow();
  });
});

describe("shortenPath", () => {
  it("leaves a path that fits alone", () => {
    expect(shortenPath("C:\\dev", 20)).toBe("C:\\dev");
  });

  it("keeps the tail, which is the informative half", () => {
    const short = shortenPath("C:\\MAMP\\htdocs\\ai-dev\\projects\\kicode", 20);

    expect(short.startsWith("…")).toBe(true);
    expect(short).toContain("kicode");
    expect(short.length).toBeLessThanOrEqual(20);
  });

  it("cuts on a separator so it does not end mid-name", () => {
    expect(shortenPath("C:\\dev\\projects\\kicode", 14)).toBe("…\\kicode");
  });

  it("degrades gracefully when there is no room at all", () => {
    expect(shortenPath("C:\\dev\\projects", 1)).toHaveLength(1);
  });
});
