import { describe, expect, it } from "vitest";
import { markdownSpans } from "./markdown";
import { buildStyles, darkTheme } from "./theme";

describe("markdownSpans with syntax highlighting", () => {
  const styles = buildStyles(darkTheme);
  const spansText = (spans: { text: string }[]): string => spans.map((s) => s.text).join("");

  it("renders headings, bold, inline code and bullets", () => {
    const input = "# Title\n- **item 1**\n- `code`";
    const spans = markdownSpans(input, styles);
    const text = spans.map((s) => s.text).join("");

    expect(text).toContain("Title");
    expect(text).toContain("• item 1");
    expect(text).toContain("• code");
  });

  it("renders fenced TypeScript code with syntax styling and border rules", () => {
    const input = "```ts\nconst num: number = 42;\n```";
    const spans = markdownSpans(input, styles);
    const text = spans.map((s) => s.text).join("");

    expect(text).toContain("╭─ ts");
    expect(text).toContain("│ const num: number = 42;");
    expect(text).toContain("╰──");

    const constSpan = spans.find((s) => s.text === "const");
    expect(constSpan?.style).toBe(styles.accent);
    const typeSpan = spans.find((s) => s.text === "number");
    expect(typeSpan?.style).toBe(styles.emphasis);
  });

  it("renders unterminated fences during streaming without breaking or dropping content", () => {
    const input = "```python\ndef run():\n  return True";
    const spans = markdownSpans(input, styles);
    const text = spans.map((s) => s.text).join("");

    expect(text).toContain("╭─ python");
    expect(text).toContain("│ def run():");
    expect(text).toContain("│   return True");

    const defSpan = spans.find((s) => s.text === "def");
    expect(defSpan?.style).toBe(styles.accent);
  });

  it("renders diff fences with addition and deletion coloring", () => {
    const input = "```diff\n+ added line\n- removed line\n```";
    const spans = markdownSpans(input, styles);

    const addSpan = spans.find((s) => s.text === "+ added line");
    expect(addSpan?.style).toBe(styles.ok);
    const delSpan = spans.find((s) => s.text === "- removed line");
    expect(delSpan?.style).toBe(styles.error);
  });

  it("renders a pipe table with aligned columns", () => {
    const input = "| name | size |\n| --- | --- |\n| src | 12 |\n| tests | 120 |";
    const spans = markdownSpans(input, styles, 80);
    const text = spans.map((s) => s.text).join("");

    expect(text).toContain("name");
    expect(text).toContain("src");
    expect(text).toContain("│");
    // Header and body rows share column edges: the separator sits in the
    // same column on every row.
    const rows = text.split("\n");
    const headerBar = rows[0]?.indexOf("│") ?? -1;
    expect(headerBar).toBeGreaterThan(0);
    for (const row of rows.slice(2)) {
      if (!row.trim()) continue;
      expect(row.indexOf("│")).toBe(headerBar);
    }
  });

  it("degrades a wide table to key/value lines at a narrow width", () => {
    const input = "| name | description |\n| --- | --- |\n| src | the source directory with all code |";
    const text = spansText(markdownSpans(input, styles, 20));

    expect(text).not.toContain("│");
    expect(text).toContain("name: src");
    expect(text).toContain("description: the source directory with all code");
  });

  it("renders nested and ordered lists with indentation", () => {
    const input = "- top\n  - nested\n    - deep\n1. first\n2. second";
    const text = spansText(markdownSpans(input, styles));

    expect(text).toContain("• top");
    expect(text).toContain("  ◦ nested");
    expect(text).toContain("    – deep");
    expect(text).toContain("1. first");
    expect(text).toContain("2. second");
  });

  it("renders task list items with their own glyphs", () => {
    const text = spansText(markdownSpans("- [ ] open\n- [x] done", styles));

    expect(text).toContain("○ open");
    expect(text).toContain("✓ done");
    expect(text).not.toContain("[ ]");
  });

  it("leaves non-tables with pipes alone", () => {
    const text = spansText(markdownSpans("a | b without a delimiter row", styles));

    expect(text).toContain("a | b without a delimiter row");
    expect(text).not.toContain("│");
  });
});
