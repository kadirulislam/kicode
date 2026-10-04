import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keysFilePath, readStoredKeys, writeStoredKey } from "./keys-file";

let home = "";

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "kicode-keys-"));
});

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

const env = (): NodeJS.ProcessEnv => ({ KICODE_HOME: home });
const file = (): string => path.join(home, "keys.json");

describe("the key file", () => {
  it("lives beside the global config, wherever KICODE_HOME says", () => {
    expect(keysFilePath(env())).toBe(file());
  });

  it("reads nothing when there is nothing stored yet", async () => {
    await expect(readStoredKeys(env())).resolves.toEqual({});
  });

  it("keeps a pasted key and reads it back by variable name", async () => {
    const result = await writeStoredKey("OPENCODE_API_KEY", "stored-key-value", env());

    expect(result).toEqual({ ok: true, file: file() });
    await expect(readStoredKeys(env())).resolves.toEqual({ OPENCODE_API_KEY: "stored-key-value" });
  });

  it("merges, so a second provider does not drop the first", async () => {
    await writeStoredKey("OPENCODE_API_KEY", "first-stored-key", env());
    await writeStoredKey("OPENROUTER_API_KEY", "second-stored-key", env());

    await expect(readStoredKeys(env())).resolves.toEqual({
      OPENCODE_API_KEY: "first-stored-key",
      OPENROUTER_API_KEY: "second-stored-key",
    });
  });

  it("pasting again overwrites a rotated key", async () => {
    await writeStoredKey("OPENCODE_API_KEY", "old-stored-key", env());
    await writeStoredKey("OPENCODE_API_KEY", "new-stored-key", env());

    await expect(readStoredKeys(env())).resolves.toEqual({ OPENCODE_API_KEY: "new-stored-key" });
  });

  it("refuses a name no shell could export and an empty key", async () => {
    await expect(writeStoredKey("NOT A VAR", "some-stored-key", env())).resolves.toMatchObject({ ok: false });
    await expect(writeStoredKey("OPENCODE_API_KEY", "   ", env())).resolves.toMatchObject({ ok: false });
    await expect(readStoredKeys(env())).resolves.toEqual({});
  });

  it("reads nothing rather than failing the run on a corrupt file", async () => {
    await writeFile(file(), "{ not json", "utf8");

    await expect(readStoredKeys(env())).resolves.toEqual({});
  });

  it("skips entries that are not string keys under variable names", async () => {
    await writeFile(file(), JSON.stringify({ OPENCODE_API_KEY: "kept-stored-key", nested: { a: 1 }, count: 3 }), "utf8");

    await expect(readStoredKeys(env())).resolves.toEqual({ OPENCODE_API_KEY: "kept-stored-key" });
  });

  it("leaves non-key files alone — it only ever writes keys.json", async () => {
    await writeFile(path.join(home, "kicode.json"), JSON.stringify({ theme: "kicode" }), "utf8");
    await writeStoredKey("OPENCODE_API_KEY", "stored-key-value", env());

    expect(JSON.parse(await readFile(path.join(home, "kicode.json"), "utf8"))).toEqual({ theme: "kicode" });
  });
});
