import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { editTool } from "./edit";
import { writeTool } from "./write";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kicode-files-"));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const context = (): { cwd: string } => ({ cwd: dir });
const file = (name: string): string => path.join(dir, name);
const readBack = (name: string): Promise<string> => readFile(file(name), "utf8");

describe("write tool", () => {
  it("is gated behind approval", () => {
    expect(writeTool.requiresApproval).toBe(true);
  });

  it("creates a file, including missing directories", async () => {
    const result = await writeTool.run({ path: "nested/out.txt", content: "hello\n" }, context());

    expect(result.isError).toBeUndefined();
    expect(await readBack("nested/out.txt")).toBe("hello\n");
  });

  it("previews the change without touching disk", async () => {
    const preview = await writeTool.preview?.({ path: "preview.txt", content: "x\ny\n" }, context());

    expect(preview).toContain("create preview.txt");
    expect(preview).toContain("+x");
    await expect(readBack("preview.txt")).rejects.toThrow();
  });

  it("reports a missing content argument", async () => {
    expect((await writeTool.run({ path: "x.txt" }, context())).isError).toBe(true);
  });

  it("refuses to overwrite a directory", async () => {
    const result = await writeTool.run({ path: ".", content: "x" }, context());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("directory");
  });
});

describe("edit tool", () => {
  it("replaces a unique match", async () => {
    await writeFile(file("unique.txt"), "alpha\nbeta\ngamma\n", "utf8");

    const result = await editTool.run({ path: "unique.txt", old_string: "beta", new_string: "BETA" }, context());

    expect(result.isError).toBeUndefined();
    expect(await readBack("unique.txt")).toBe("alpha\nBETA\ngamma\n");
  });

  it("refuses an ambiguous match until replace_all is set", async () => {
    await writeFile(file("ambiguous.txt"), "x\nx\n", "utf8");

    const refused = await editTool.run({ path: "ambiguous.txt", old_string: "x", new_string: "y" }, context());
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("2 places");
    expect(await readBack("ambiguous.txt")).toBe("x\nx\n");

    const allowed = await editTool.run(
      { path: "ambiguous.txt", old_string: "x", new_string: "y", replace_all: true },
      context(),
    );
    expect(allowed.isError).toBeUndefined();
    expect(await readBack("ambiguous.txt")).toBe("y\ny\n");
  });

  it("keeps $ patterns in the replacement literal", async () => {
    await writeFile(file("dollar.txt"), "value = OLD\n", "utf8");

    await editTool.run({ path: "dollar.txt", old_string: "OLD", new_string: "$&$$-$1" }, context());

    expect(await readBack("dollar.txt")).toBe("value = $&$$-$1\n");
  });

  it("reports text that is not present", async () => {
    await writeFile(file("missing-text.txt"), "abc\n", "utf8");

    const result = await editTool.run({ path: "missing-text.txt", old_string: "nope", new_string: "x" }, context());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("previews a diff and explains a refused edit", async () => {
    await writeFile(file("preview-edit.txt"), "one\ntwo\n", "utf8");

    const ok = await editTool.preview?.({ path: "preview-edit.txt", old_string: "two", new_string: "TWO" }, context());
    expect(ok).toContain("edit preview-edit.txt");
    expect(ok).toContain("-two");
    expect(ok).toContain("+TWO");

    const refused = await editTool.preview?.({ path: "preview-edit.txt", old_string: "zzz", new_string: "x" }, context());
    expect(refused).toContain("not found");
    expect(await readBack("preview-edit.txt")).toBe("one\ntwo\n");
  });
});
