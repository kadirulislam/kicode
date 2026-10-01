import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTool } from "./read";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kicode-read-"));
  await writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\n", "utf8");
  await writeFile(path.join(dir, "binary.bin"), "a\u0000b", "utf8");
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("read tool", () => {
  it("numbers every line and ignores the trailing newline", async () => {
    const result = await readTool.run({ path: "a.txt" }, { cwd: dir });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("    1  one\n    2  two\n    3  three");
  });

  it("pages with offset and limit", async () => {
    const result = await readTool.run({ path: "a.txt", offset: 2, limit: 1 }, { cwd: dir });

    expect(result.content).toContain("    2  two");
    expect(result.content).toContain("more line");
  });

  it("reads absolute paths", async () => {
    const result = await readTool.run({ path: path.join(dir, "a.txt") }, { cwd: tmpdir() });

    expect(result.content).toContain("    1  one");
  });

  it("reports a missing file without throwing", async () => {
    const result = await readTool.run({ path: "nope.txt" }, { cwd: dir });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("no such file");
  });

  it("reports a directory rather than failing opaquely", async () => {
    const result = await readTool.run({ path: "." }, { cwd: dir });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("directory");
  });

  it("refuses binary files", async () => {
    const result = await readTool.run({ path: "binary.bin" }, { cwd: dir });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("binary");
  });

  it("requires a path", async () => {
    const result = await readTool.run({}, { cwd: dir });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("`path` is required");
  });
});
