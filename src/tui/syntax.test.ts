import { describe, expect, it } from "vitest";
import { highlightLine, normalizeLanguage } from "./syntax";
import { buildStyles, darkTheme } from "./theme";
import { renderSpans } from "./ansi";

describe("syntax highlighting", () => {
  const styles = buildStyles(darkTheme);

  it("normalizes language tags accurately", () => {
    expect(normalizeLanguage("typescript")).toBe("ts");
    expect(normalizeLanguage("TSX")).toBe("ts");
    expect(normalizeLanguage("python")).toBe("python");
    expect(normalizeLanguage("py")).toBe("python");
    expect(normalizeLanguage("sh")).toBe("bash");
    expect(normalizeLanguage("diff")).toBe("diff");
    expect(normalizeLanguage("unknown_lang")).toBe("generic");
    expect(normalizeLanguage(undefined)).toBe("generic");
  });

  it("highlights diff additions and deletions", () => {
    const add = highlightLine("+ const x = 1;", "diff", styles);
    const del = highlightLine("- const y = 2;", "diff", styles);
    const hunk = highlightLine("@@ -1,3 +1,4 @@", "diff", styles);

    expect(renderSpans(add)).toContain("+ const x = 1;");
    expect(add[0]?.style).toBe(styles.ok);
    expect(del[0]?.style).toBe(styles.error);
    expect(hunk[0]?.style).toBe(styles.accent);
  });

  it("highlights TypeScript keywords, types, and strings", () => {
    const line = 'import { User } from "./user";';
    const spans = highlightLine(line, "ts", styles);
    const text = spans.map((s) => s.text).join("");
    expect(text).toBe(line);
    const importSpan = spans.find((s) => s.text === "import");
    expect(importSpan?.style).toBe(styles.accent);
    const typeSpan = spans.find((s) => s.text === "User");
    expect(typeSpan?.style).toBe(styles.emphasis);
    const stringSpan = spans.find((s) => s.text === '"./user"');
    expect(stringSpan?.style).toBe(styles.ok);
  });

  it("highlights JSON keys, values, and numbers", () => {
    const line = '  "port": 8080, "active": true';
    const spans = highlightLine(line, "json", styles);
    const text = spans.map((s) => s.text).join("");
    expect(text).toBe(line);
    const keySpan = spans.find((s) => s.text === '"port"');
    expect(keySpan?.style).toBe(styles.accent);
    const numSpan = spans.find((s) => s.text === "8080");
    expect(numSpan?.style).toBe(styles.warn);
    const boolSpan = spans.find((s) => s.text === "true");
    expect(boolSpan?.style).toBe(styles.warn);
  });

  it("highlights Python comments and keywords", () => {
    const line = "def calculate(total): # compute";
    const spans = highlightLine(line, "python", styles);
    const text = spans.map((s) => s.text).join("");
    expect(text).toBe(line);
    const defSpan = spans.find((s) => s.text === "def");
    expect(defSpan?.style).toBe(styles.accent);
    const commentSpan = spans.find((s) => s.text === "# compute");
    expect(commentSpan?.style).toBe(styles.dim);
  });
});
