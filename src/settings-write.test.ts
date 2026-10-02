import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addGlobalProvider, globalConfigPath, writeGlobalSetting, writeGlobalSettings } from "./settings-write";

let home = "";

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "kicode-settings-"));
});

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

const env = (): NodeJS.ProcessEnv => ({ KICODE_HOME: home });
const file = (): string => path.join(home, "kicode.json");
const read = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(file(), "utf8")) as Record<string, unknown>;

describe("writing a global setting", () => {
  it("points at the user's own kicode.json, wherever KICODE_HOME says", () => {
    expect(globalConfigPath(env())).toBe(file());
  });

  it("creates the file and the directory it lives in", async () => {
    const result = await writeGlobalSetting("thinking", "hide", env());

    expect(result).toEqual({ ok: true, file: file(), status: "written" });
    expect(await read()).toEqual({ thinking: "hide" });
  });

  it("merges, so a second setting does not drop the first", async () => {
    await writeGlobalSetting("thinking", "hide", env());
    const result = await writeGlobalSetting("tps", "off", env());

    expect(result.ok && result.status).toBe("updated");
    expect(await read()).toEqual({ thinking: "hide", tps: "off" });
  });

  it("keeps keys it does not know about, mcp included", async () => {
    await writeFile(file(), JSON.stringify({ mcp: { srv: { command: "x" } }, unknown: 1 }), "utf8");
    await writeGlobalSetting("theme", "nord", env());

    expect(await read()).toEqual({ mcp: { srv: { command: "x" } }, unknown: 1, theme: "nord" });
  });

  it("writes several keys in one go", async () => {
    await writeGlobalSettings({ theme: "nord", colorMode: "dark" }, env());
    expect(await read()).toEqual({ theme: "nord", colorMode: "dark" });
  });

  it("says so when there is nothing to change", async () => {
    await writeGlobalSetting("theme", "nord", env());
    const again = await writeGlobalSetting("theme", "nord", env());

    expect(again.ok && again.status).toBe("unchanged");
  });

  it("refuses to touch a file it cannot parse, rather than replacing it", async () => {
    await writeFile(file(), "{ this is not json", "utf8");
    const result = await writeGlobalSetting("theme", "nord", env());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Refusing to touch");
    // The content is exactly as it was: a read is not a licence to write.
    expect(await readFile(file(), "utf8")).toBe("{ this is not json");
  });

  it("refuses a file whose top level is not an object", async () => {
    await writeFile(file(), "[1, 2, 3]", "utf8");
    const result = await writeGlobalSetting("theme", "nord", env());
    expect(result.ok).toBe(false);
  });

  it("reads through a BOM, which is what a Windows editor writes", async () => {
    await writeFile(file(), `\ufeff${JSON.stringify({ theme: "nord" })}`, "utf8");
    const result = await writeGlobalSetting("tps", "off", env());

    expect(result.ok).toBe(true);
    expect(await read()).toEqual({ theme: "nord", tps: "off" });
  });
});

describe("adding a provider", () => {
  it("writes the base URL and the name of the variable the key lives in", async () => {
    const result = await addGlobalProvider("groq", { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" }, env());

    expect(result.ok).toBe(true);
    expect(await read()).toEqual({
      providers: { groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" } },
    });
  });

  it("adds to the block rather than replacing it", async () => {
    await addGlobalProvider("groq", { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" }, env());
    await addGlobalProvider("openai", { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" }, env());

    const json = await read();
    expect(Object.keys(json.providers as Record<string, unknown>)).toEqual(["groq", "openai"]);
  });

  it("keeps the rest of the file", async () => {
    await writeGlobalSetting("theme", "nord", env());
    await addGlobalProvider("ollama", { baseUrl: "http://localhost:11434/v1" }, env());

    const json = await read();
    expect(json.theme).toBe("nord");
    expect(json.providers).toEqual({ ollama: { baseUrl: "http://localhost:11434/v1" } });
  });

  it("never writes a credential — only the variable's name", async () => {
    await addGlobalProvider("groq", { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" }, env());
    const text = await readFile(file(), "utf8");

    expect(text).not.toMatch(/apiKey"|"key"|"token"/);
    expect(text).toContain("apiKeyEnv");
  });

  it("keeps a credential already on the entry it rewrites", async () => {
    // KiCode does not *add* a key, but rewriting an entry must not destroy one
    // that is already there: that is a credential no one can get back.
    await writeFile(
      file(),
      JSON.stringify({ providers: { groq: { baseUrl: "https://old/v1", apiKey: "sk-legacy" } } }),
      "utf8",
    );
    await addGlobalProvider(
      "groq",
      { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" },
      env(),
    );

    expect(await read()).toEqual({
      providers: {
        groq: { baseUrl: "https://api.groq.com/openai/v1", apiKey: "sk-legacy", apiKeyEnv: "GROQ_API_KEY" },
      },
    });
  });

  it("refuses a file it cannot parse", async () => {
    await writeFile(file(), "nope", "utf8");
    expect((await addGlobalProvider("groq", { baseUrl: "https://x/v1" }, env())).ok).toBe(false);
  });
});
