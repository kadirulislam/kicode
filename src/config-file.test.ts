import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfigFiles } from "./config-file";

let cwd = "";
let home = "";

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "kicode-cwd-"));
  home = await mkdtemp(path.join(tmpdir(), "kicode-home-"));
});

afterEach(async () => {
  for (const dir of [cwd, home]) if (dir) await rm(dir, { recursive: true, force: true });
});

const env = (): NodeJS.ProcessEnv => ({ KICODE_HOME: home });

async function write(dir: string, json: string): Promise<void> {
  await writeFile(path.join(dir, "kicode.json"), json, "utf8");
}

describe("readConfigFiles", () => {
  it("returns nothing when no file exists, and does not warn", async () => {
    const result = await readConfigFiles(cwd, env());

    expect(result.entries).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("reads the project file", async () => {
    await write(cwd, JSON.stringify({ model: "project-model" }));

    const result = await readConfigFiles(cwd, env());

    expect(result.entries.map((entry) => entry.scope)).toEqual(["project"]);
    expect(result.entries[0]?.json).toEqual({ model: "project-model" });
    expect(result.files).toEqual([path.join(cwd, "kicode.json")]);
  });

  it("lists the global file first so the project can override it", async () => {
    await write(home, JSON.stringify({ model: "global-model" }));
    await write(cwd, JSON.stringify({ model: "project-model" }));

    const result = await readConfigFiles(cwd, env());

    expect(result.entries.map((entry) => entry.scope)).toEqual(["global", "project"]);
  });

  it("accepts a UTF-8 BOM", async () => {
    // Notepad and PowerShell 5.1's `Set-Content -Encoding utf8` both write one,
    // and JSON.parse rejects it — so a valid hand-made config would look broken.
    await write(cwd, `\uFEFF${JSON.stringify({ model: "bom-model" })}`);

    const result = await readConfigFiles(cwd, env());

    expect(result.warnings).toEqual([]);
    expect(result.entries[0]?.json).toEqual({ model: "bom-model" });
  });

  it("reads a file once when home and the working directory are the same", async () => {
    // KICODE_HOME unset, KiCode run from the home directory.
    await write(cwd, JSON.stringify({ model: "once" }));

    const result = await readConfigFiles(cwd, { KICODE_HOME: cwd });

    expect(result.entries).toHaveLength(1);
    expect(result.files).toHaveLength(1);
  });

  it("warns about invalid JSON and keeps going", async () => {
    await write(cwd, "{ not json");

    const result = await readConfigFiles(cwd, env());

    expect(result.entries).toEqual([]);
    expect(result.files).toEqual([path.join(cwd, "kicode.json")]);
    expect(result.warnings.join("\n")).toContain("not valid JSON");
  });

  it("warns about a non-object top level", async () => {
    await write(cwd, "[1, 2]");

    const result = await readConfigFiles(cwd, env());

    expect(result.entries).toEqual([]);
    expect(result.warnings.join("\n")).toContain("JSON object");
  });
});
