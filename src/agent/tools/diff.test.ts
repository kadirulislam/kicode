import { describe, expect, it } from "vitest";
import { diffLines, splitLines } from "./diff";

const hasDeletion = (diff: string): boolean => diff.split("\n").some((line) => line.startsWith("-") && !line.startsWith("@@"));

describe("splitLines", () => {
  it("does not turn a trailing newline into an empty line", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
  });

  it("handles CRLF input", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
  });
});

describe("diffLines", () => {
  it("returns nothing for identical input", () => {
    expect(diffLines("a\nb\n", "a\nb\n")).toBe("");
  });

  it("marks an inserted line without inventing a deletion", () => {
    const diff = diffLines("a\nb", "a\nb\nc");

    expect(diff).toContain("@@");
    expect(diff).toContain("+c");
    expect(hasDeletion(diff)).toBe(false);
  });

  it("treats a new file as pure additions, with no phantom deletion", () => {
    const diff = diffLines("", "one\ntwo\n");

    expect(diff).toContain("+one");
    expect(diff).toContain("+two");
    expect(hasDeletion(diff)).toBe(false);
  });

  it("marks a deleted line", () => {
    expect(diffLines("a\nb\nc", "a\nc")).toContain("-b");
  });

  it("renders a changed line as a delete plus an insert", () => {
    const diff = diffLines("a\nb\nc", "a\nB\nc");

    expect(diff).toContain("-b");
    expect(diff).toContain("+B");
  });

  it("summarises instead of exploding on huge inputs", () => {
    const big = Array.from({ length: 1300 }, (_, index) => `line ${index}`).join("\n");

    expect(diffLines(big, `${big}\nmore`)).toContain("too large");
  });

  it("collapses distant changes into separate hunks", () => {
    const before = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 1", "LINE 1").replace("line 55", "LINE 55");

    const diff = diffLines(before, after);

    expect(diff.match(/@@/g)).toHaveLength(4); // two hunks, two markers each
    expect(diff).not.toContain("line 30");
  });
});
