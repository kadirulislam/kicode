import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globTool } from "./glob";
import { globToRegExp } from "./glob-match";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kicode-glob-"));
  await mkdir(path.join(dir, "src/nested"), { recursive: true });
  await mkdir(path.join(dir, "node_modules/pkg"), { recursive: true });
  await writeFile(path.join(dir, "root.txt"), "root", "utf8");
  await writeFile(path.join(dir, "src/a.ts"), "a", "utf8");
  await writeFile(path.join(dir, "src/b.js"), "b", "utf8");
  await writeFile(path.join(dir, "src/nested/c.ts"), "c", "utf8");
  await writeFile(path.join(dir, "node_modules/pkg/index.ts"), "x", "utf8");
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const context = (): { cwd: string } => ({ cwd: dir });

const match = (pattern: string, value: string): boolean => globToRegExp(pattern).test(value);

describe("globToRegExp", () => {
  it("keeps a single star inside one path segment", () => {
    expect(match("*.ts", "a.ts")).toBe(true);
    expect(match("*.ts", "src/a.ts")).toBe(false);
  });

  it("lets **/ match zero directories as well as many", () => {
    expect(match("**/*.ts", "a.ts")).toBe(true);
    expect(match("**/*.ts", "src/deep/a.ts")).toBe(true);
  });

  it("supports brace alternation and character classes", () => {
    expect(match("*.{ts,js}", "a.js")).toBe(true);
    expect(match("*.{ts,js}", "a.css")).toBe(false);
    expect(match("file[0-9].txt", "file3.txt")).toBe(true);
  });

  it("supports single-character wildcards", () => {
    expect(match("a?c.ts", "abc.ts")).toBe(true);
    expect(match("a?c.ts", "a/c.ts")).toBe(false);
  });

  it("escapes regex metacharacters in the pattern", () => {
    expect(match("a+b.ts", "a+b.ts")).toBe(true);
    expect(match("a+b.ts", "aab.ts")).toBe(false);
  });
});

describe("glob tool", () => {
  it("finds files recursively and skips noise directories", async () => {
    const result = await globTool.run({ pattern: "**/*.ts" }, context());

    expect(result.content.split("\n")).toEqual(["src/a.ts", "src/nested/c.ts"]);
  });

  it("matches only the top level for a bare pattern", async () => {
    const result = await globTool.run({ pattern: "*.txt" }, context());

    expect(result.content).toBe("root.txt");
  });

  it("supports brace alternation", async () => {
    const result = await globTool.run({ pattern: "src/*.{ts,js}" }, context());

    expect(result.content.split("\n")).toEqual(["src/a.ts", "src/b.js"]);
  });

  it("matches the pattern relative to the given path", async () => {
    const result = await globTool.run({ pattern: "*.ts", path: "src" }, context());

    // Found via `src/*.ts`, reported relative to the working directory.
    expect(result.content).toBe("src/a.ts");
  });

  it("caps results and says so", async () => {
    const result = await globTool.run({ pattern: "**/*.ts", max_results: 1 }, context());

    expect(result.content).toContain("src/a.ts");
    expect(result.content).toContain("showing 1 of 2");
  });

  it("explains an empty result instead of returning nothing", async () => {
    expect((await globTool.run({ pattern: "**/*.rs" }, context())).content).toContain("No files matched");
  });

  it("requires a pattern", async () => {
    expect((await globTool.run({}, context())).isError).toBe(true);
  });

  it("reports a missing search directory", async () => {
    expect((await globTool.run({ pattern: "*", path: "nope" }, context())).isError).toBe(true);
  });
});
