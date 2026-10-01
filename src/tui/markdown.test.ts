import { describe, expect, it } from "vitest";
import { markdownSpans } from "./markdown";
import { buildStyles, darkTheme } from "./theme";

describe("markdownSpans with syntax highlighting", () => {
  const styles = buildStyles(darkTheme);

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
});
