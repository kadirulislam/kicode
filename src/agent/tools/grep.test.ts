import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grepTool } from "./grep";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kicode-grep-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "node_modules/pkg"), { recursive: true });
  await writeFile(path.join(dir, "src/a.ts"), "const needle = 1;\nNEEDLE again\n", "utf8");
  await writeFile(path.join(dir, "src/b.js"), "let other = 2;\n", "utf8");
  await writeFile(path.join(dir, "notes.md"), "a plain needle here\n", "utf8");
  await writeFile(path.join(dir, "binary.bin"), "needle\u0000binary", "utf8");
  await writeFile(path.join(dir, "node_modules/pkg/index.ts"), "needle\n", "utf8");
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const context = (): { cwd: string } => ({ cwd: dir });

describe("grep tool", () => {
  it("reports path, line number, and text", async () => {
    const result = await grepTool.run({ pattern: "needle", literal: true, glob: "**/*.ts" }, context());

    expect(result.content.split("\n")).toEqual(["src/a.ts:1: const needle = 1;"]);
  });

  it("is case sensitive unless asked otherwise", async () => {
    const sensitive = await grepTool.run({ pattern: "needle", literal: true, glob: "**/*.ts" }, context());
    expect(sensitive.content).not.toContain("NEEDLE");

    const insensitive = await grepTool.run(
      { pattern: "needle", literal: true, ignore_case: true, glob: "**/*.ts" },
      context(),
    );
    expect(insensitive.content).toContain("src/a.ts:2: NEEDLE again");
  });

  it("treats the pattern as a regex by default and literally when asked", async () => {
    await writeFile(path.join(dir, "regex.txt"), "value(1)\nvalue(2)\n", "utf8");

    const asRegex = await grepTool.run({ pattern: "value\\(\\d\\)", glob: "**/regex.txt" }, context());
    expect(asRegex.content).toContain("regex.txt:1: value(1)");

    const asLiteral = await grepTool.run({ pattern: "value(1)", literal: true, glob: "**/regex.txt" }, context());
    expect(asLiteral.content.split("\n")).toEqual(["regex.txt:1: value(1)"]);
  });

  it("skips node_modules and binary files", async () => {
    const result = await grepTool.run({ pattern: "needle", literal: true }, context());

    expect(result.content).not.toContain("node_modules");
    expect(result.content).not.toContain("binary.bin");
    expect(result.content).toContain("src/a.ts:1:");
    expect(result.content).toContain("notes.md:1:");
  });

  it("searches a single file when given one", async () => {
    const result = await grepTool.run({ pattern: "other", path: "src/b.js" }, context());

    expect(result.content).toBe("src/b.js:1: let other = 2;");
  });

  it("caps matches and says so", async () => {
    const result = await grepTool.run({ pattern: "needle", literal: true, ignore_case: true, glob: "**/*.ts", max_results: 1 }, context());

    expect(result.content).toContain("stopped at 1 matches");
  });

  it("explains an empty result rather than returning nothing", async () => {
    const result = await grepTool.run({ pattern: "definitely-absent" }, context());

    expect(result.content).toContain("No matches");
    expect(result.content).toContain("searched");
  });

  it("explains an invalid regex and suggests literal", async () => {
    const result = await grepTool.run({ pattern: "([unclosed" }, context());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("literal: true");
  });

  it("requires a pattern", async () => {
    expect((await grepTool.run({}, context())).isError).toBe(true);
  });
});
