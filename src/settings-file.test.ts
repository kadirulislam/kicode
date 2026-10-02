import { describe, expect, it } from "vitest";
import type { ConfigFileEntry } from "./config-file";
import { fileSettingsFromEntries } from "./settings-file";

const entry = (json: Record<string, unknown>, scope: "global" | "project" = "project"): ConfigFileEntry => ({
  file: `/somewhere/${scope}/kicode.json`,
  scope,
  json,
});

describe("fileSettingsFromEntries", () => {
  it("returns nothing for empty config", () => {
    const result = fileSettingsFromEntries([]);

    expect(result.settings).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it("reads a theme by name, and warns about one that is not a name", () => {
    expect(fileSettingsFromEntries([entry({ theme: "tokyo-night" })]).settings.theme).toBe("tokyo-night");

    const bad = fileSettingsFromEntries([entry({ theme: 7 })]);
    expect(bad.settings.theme).toBeUndefined();
    expect(bad.warnings[0]).toContain('Ignoring "theme"');
  });

  it("reads model, baseUrl, mock, and compaction", () => {
    const result = fileSettingsFromEntries([
      entry({
        model: "deepseek-v4-flash:free",
        baseUrl: "https://gateway.example.com/v1",
        compaction: { contextTokens: 200_000, reserveTokens: 16_000, targetPercent: 35, compactAt: 50_000 },
      }),
    ]);

    expect(result.settings).toEqual({
      model: "deepseek-v4-flash:free",
      baseUrl: "https://gateway.example.com/v1",
      compaction: { contextTokens: 200_000, reserveTokens: 16_000, targetPercent: 35, compactAt: 50_000 },
    });
    expect(result.warnings).toEqual([]);
  });

  it("lets the project file override the global one", () => {
    const result = fileSettingsFromEntries([
      entry({ model: "global-model", baseUrl: "https://global.example.com/v1" }, "global"),
      entry({ model: "project-model" }, "project"),
    ]);

    expect(result.settings.model).toBe("project-model");
    // Untouched fields keep the global value.
    expect(result.settings.baseUrl).toBe("https://global.example.com/v1");
  });

  it("merges compaction across files rather than replacing the block", () => {
    const result = fileSettingsFromEntries([
      entry({ compaction: { contextTokens: 100_000, targetPercent: 35 } }, "global"),
      entry({ compaction: { targetPercent: 45 } }, "project"),
    ]);

    expect(result.settings.compaction).toEqual({ contextTokens: 100_000, targetPercent: 45 });
  });

  it("names the turn count it no longer takes, instead of dropping it in silence", () => {
    const result = fileSettingsFromEntries([entry({ compaction: { keepRecentTurns: 8 } })]);

    // A knob that does nothing is worse than one that says it does nothing.
    expect(Object.keys(result.settings.compaction ?? {})).toEqual([]);
    expect(result.warnings.join("\n")).toContain("keepRecentTurns");
    expect(result.warnings.join("\n")).toContain("targetPercent");
  });

  it("accepts the mock shorthand", () => {
    expect(fileSettingsFromEntries([entry({ mock: true })]).settings.mock).toBe(true);
  });

  it("warns when mock and baseUrl are both set, because baseUrl wins", () => {
    const result = fileSettingsFromEntries([entry({ mock: true, baseUrl: "https://real.example.com/v1" })]);

    expect(result.warnings.join("\n")).toContain('"mock" is ignored');
  });

  it("refuses to take an API key from the file", () => {
    // A project file is committed and shared — the worst place for a secret.
    for (const key of ["apiKey", "key", "token"]) {
      const result = fileSettingsFromEntries([entry({ [key]: "sk-secret" })]);

      expect(result.warnings.join("\n")).toContain("environment");
      expect(JSON.stringify(result.settings)).not.toContain("sk-secret");
    }
  });

  it("refuses a key on a provider, at any scope, and names the variable to use", () => {
    // The global file is on the same disk as a project one — it is not more
    // private, so a key stored there is refused and reported the same way.
    for (const scope of ["global", "project"] as const) {
      const result = fileSettingsFromEntries([
        entry(
          { providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-secret" } } },
          scope,
        ),
      ]);

      expect(result.warnings.join("\n")).toContain("OPENROUTER_API_KEY");
      expect(JSON.stringify(result.settings)).not.toContain("sk-or-secret");
      // The endpoint itself is still read — only the credential is dropped.
      expect(result.settings.providers?.openrouter?.baseUrl).toBe("https://openrouter.ai/api/v1");
    }
  });

  it("warns and ignores malformed values instead of failing", () => {
    const result = fileSettingsFromEntries([
      entry({
        model: "",
        baseUrl: "not-a-url",
        mock: "yes",
        compaction: { contextTokens: -1, reserveTokens: "nope", enabled: "maybe" },
      }),
    ]);

    const warnings = result.warnings.join("\n");
    expect(warnings).toContain('"model"');
    expect(warnings).toContain('"baseUrl"');
    expect(warnings).toContain('"mock"');
    expect(warnings).toContain("compaction.contextTokens");
    expect(warnings).toContain("compaction.reserveTokens");
    expect(warnings).toContain("compaction.enabled");
    expect(result.settings.model).toBeUndefined();
    expect(result.settings.baseUrl).toBeUndefined();
    expect(result.settings.mock).toBeUndefined();
  });

  it("warns when compaction is not an object", () => {
    expect(fileSettingsFromEntries([entry({ compaction: "soon" })]).warnings.join("\n")).toContain('"compaction"');
  });

  it("accepts numeric strings for compaction sizes", () => {
    expect(fileSettingsFromEntries([entry({ compaction: { contextTokens: "64000" } })]).settings.compaction).toEqual({
      contextTokens: 64_000,
    });
  });

  it("reads fallback models and backup routes", () => {
    const result = fileSettingsFromEntries([
      entry({
        fallbackModels: ["a:free", "b:free"],
        fallback: [{ provider: "groq", model: "llama" }, { baseUrl: "https://own.example/v1", model: "own" }],
      }),
    ]);

    expect(result.settings.fallbackModels).toEqual(["a:free", "b:free"]);
    expect(result.settings.fallback).toEqual([
      { provider: "groq", model: "llama" },
      { baseUrl: "https://own.example/v1", model: "own" },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("drops a fallback route with no model, which says nothing to ask for", () => {
    const result = fileSettingsFromEntries([entry({ fallback: [{ provider: "groq" }, { model: "ok" }] })]);

    expect(result.settings.fallback).toEqual([{ model: "ok" }]);
    expect(result.warnings.join("\n")).toContain("fallback[0]");
  });

  it("never takes a key inside a fallback route either", () => {
    const result = fileSettingsFromEntries([entry({ fallback: [{ model: "m", apiKey: "sk-secret" }] })]);

    expect(result.warnings.join("\n")).toContain("fallback[0]");
    expect(JSON.stringify(result.settings)).not.toContain("sk-secret");
  });

  it("reads a token budget, and treats 0 as no limit", () => {
    expect(fileSettingsFromEntries([entry({ maxTokens: 500_000 })]).settings.maxTokens).toBe(500_000);
    expect(fileSettingsFromEntries([entry({ maxTokens: 0 })]).settings.maxTokens).toBe(0);
  });

  it("warns and ignores a malformed token budget", () => {
    const result = fileSettingsFromEntries([entry({ maxTokens: -5 })]);

    expect(result.settings.maxTokens).toBeUndefined();
    expect(result.warnings.join("\n")).toContain('"maxTokens"');
  });

  it("reads a brain path, and warns about one that is not a path", () => {
    expect(fileSettingsFromEntries([entry({ brain: "~/.kicode/brain" })]).settings.brain).toBe("~/.kicode/brain");

    const bad = fileSettingsFromEntries([entry({ brain: 7 })]);
    expect(bad.settings.brain).toBeUndefined();
    expect(bad.warnings.join("\n")).toContain('"brain"');
  });

  it("reads a spacing block, one number at a time", () => {
    const result = fileSettingsFromEntries([entry({ spacing: { block: 0, turn: 3 } })]);

    // Only what the file said: the numbers it left out are filled in by
    // `viewFrom`, which is the one place that knows what the defaults are.
    expect(result.settings.view?.spacing).toEqual({ block: 0, turn: 3 });
    expect(result.warnings).toEqual([]);
  });

  it("keeps the spacing numbers it can use when one of them is nonsense", () => {
    const result = fileSettingsFromEntries([entry({ spacing: { block: 9, entry: 0 } })]);

    expect(result.settings.view?.spacing).toEqual({ entry: 0 });
    expect(result.warnings.join("\n")).toContain('Ignoring "spacing.block"');
    expect(result.warnings.join("\n")).toContain("0 to 3");
  });

  it("refuses a fractional gap, because half a row is not a row", () => {
    const result = fileSettingsFromEntries([entry({ spacing: { entry: 1.5 } })]);

    expect(result.settings.view?.spacing).toBeUndefined();
    expect(result.warnings.join("\n")).toContain('Ignoring "spacing.entry"');
  });

  it("warns when spacing is not an object, and leaves nothing behind", () => {
    const result = fileSettingsFromEntries([entry({ spacing: 2 })]);

    expect(result.settings.view).toBeUndefined();
    expect(result.warnings.join("\n")).toContain('Ignoring "spacing"');
  });

  it("lets a project override one gap without losing the ones the global file set", () => {
    const result = fileSettingsFromEntries([
      entry({ spacing: { entry: 2, turn: 2 } }, "global"),
      entry({ spacing: { block: 0 } }, "project"),
    ]);

    expect(result.settings.view?.spacing).toEqual({ block: 0, entry: 2, turn: 2 });
  });
});
