import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, MOCK_API_KEY, MOCK_BASE_URL, loadConfig, validateConfig } from "./config";
import type { FileSettings } from "./settings-file";
import { DEFAULT_THEME } from "./tui/theme";

/** The environment on a machine that has a gateway configured globally. */
const env = (): NodeJS.ProcessEnv => ({
  KICODE_API_KEY: "env-key",
  OPENAI_BASE_URL: "https://gateway.example.com/v1",
  KICODE_MODEL: "env-model",
});

describe("loadConfig defaults", () => {
  it("falls back to the OpenAI defaults with an empty environment", () => {
    const config = loadConfig({}, {});

    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(config.model).toBe(DEFAULT_MODEL);
    expect(config.compaction.enabled).toBe(true);
  });

  it("still reads the environment when no file is present", () => {
    const config = loadConfig(env(), {});

    expect(config.apiKey).toBe("env-key");
    expect(config.baseUrl).toBe("https://gateway.example.com/v1");
    expect(config.model).toBe("env-model");
  });

  it("starts on the default theme, and takes one from the environment or the file", () => {
    expect(loadConfig({}, {}).theme).toBe(DEFAULT_THEME);
    expect(loadConfig({ KICODE_THEME: "nord" }, {}).theme).toBe("nord");
    // The file beats the environment, as it does for every other setting.
    expect(loadConfig({ KICODE_THEME: "nord" }, { theme: "gruvbox" }).theme).toBe("gruvbox");
    // A name nobody has is kept as written: `run.ts` reports it and moves on.
    expect(loadConfig({}, { theme: "chartreuse" }).theme).toBe("chartreuse");
    expect(loadConfig({}, {}, { theme: "mono" }).theme).toBe("mono");
  });

  it("fills in the spacing a file left out, and keeps the numbers it named", () => {
    // The file half knows only what was written down; this is the seam where
    // the rest of the layout's defaults are supplied.
    const config = loadConfig({}, { view: { spacing: { block: 0, turn: 2 } } } as FileSettings);

    expect(config.view.spacing).toEqual({ block: 0, entry: 1, turn: 2 });
    expect(loadConfig({}, {}).view.spacing).toEqual({ block: 2, entry: 1, turn: 1 });
  });

  it("accepts the OPENAI_* names as fallbacks", () => {
    const config = loadConfig({ OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://x.example.com/v1" }, {});

    expect(config.apiKey).toBe("k");
    expect(config.baseUrl).toBe("https://x.example.com/v1");
  });

  it("strips trailing slashes from the base URL", () => {
    expect(loadConfig({}, { baseUrl: "https://x.example.com/v1///" }).baseUrl).toBe("https://x.example.com/v1");
  });
});

describe("config file beats the environment", () => {
  it("wins for model and baseUrl", () => {
    // This is the whole point: an ambient OPENAI_BASE_URL aimed at some other
    // tool must not silently redirect KiCode.
    const config = loadConfig(env(), { model: "file-model", baseUrl: "https://file.example.com/v1" });

    expect(config.model).toBe("file-model");
    expect(config.baseUrl).toBe("https://file.example.com/v1");
  });

  it("still leaves the key to the environment", () => {
    expect(loadConfig(env(), { model: "file-model" }).apiKey).toBe("env-key");
  });
});

describe("flags beat the config file", () => {
  it("overrides model and baseUrl", () => {
    const file: FileSettings = { model: "file-model", baseUrl: "https://file.example.com/v1" };
    const config = loadConfig(env(), file, { model: "flag-model", baseUrl: "https://flag.example.com/v1" });

    expect(config.model).toBe("flag-model");
    expect(config.baseUrl).toBe("https://flag.example.com/v1");
  });
});

describe('the "mock" shorthand', () => {
  it("points at the bundled mock and uses a placeholder key", () => {
    // The placeholder matters: a real key must never be shipped to localhost.
    const config = loadConfig(env(), { mock: true });

    expect(config.baseUrl).toBe(MOCK_BASE_URL);
    expect(config.apiKey).toBe(MOCK_API_KEY);
  });

  it("overrides an ambient OPENAI_BASE_URL", () => {
    expect(loadConfig(env(), { mock: true }).baseUrl).toBe(MOCK_BASE_URL);
  });

  it("lets an explicit baseUrl win instead", () => {
    const config = loadConfig(env(), { mock: true, baseUrl: "https://real.example.com/v1" });

    expect(config.baseUrl).toBe("https://real.example.com/v1");
    expect(config.apiKey).toBe("env-key");
  });

  it("can be a flag too", () => {
    expect(loadConfig(env(), {}, { baseUrl: MOCK_BASE_URL }).baseUrl).toBe(MOCK_BASE_URL);
  });
});

describe("compaction settings", () => {
  it("uses the documented defaults", () => {
    const config = loadConfig({}, {});

    expect(config.compaction.contextTokens).toBe(128_000);
    expect(config.compaction.reserveTokens).toBe(8_000);
    expect(config.compaction.keepRecentTurns).toBe(6);
    expect(config.compaction.compactAt).toBe(100_000);
  });

  it("reads the compact threshold from the environment and the file", () => {
    expect(loadConfig({ KICODE_COMPACT_AT: "50000" }, {}).compaction.compactAt).toBe(50_000);
    expect(loadConfig({ KICODE_COMPACT_AT: "50000" }, { compaction: { compactAt: 20_000 } }).compaction.compactAt).toBe(20_000);
    expect(loadConfig({ KICODE_COMPACT_AT: "banana" }, {}).compaction.compactAt).toBe(100_000);
  });

  it("reads the environment", () => {
    const config = loadConfig({ KICODE_CONTEXT_TOKENS: "32000", KICODE_KEEP_TURNS: "3" }, {});

    expect(config.compaction.contextTokens).toBe(32_000);
    expect(config.compaction.keepRecentTurns).toBe(3);
  });

  it("lets the config file override the environment", () => {
    const config = loadConfig({ KICODE_CONTEXT_TOKENS: "32000" }, { compaction: { contextTokens: 200_000 } });

    expect(config.compaction.contextTokens).toBe(200_000);
  });

  it("honours enabled: false from the file", () => {
    expect(loadConfig({}, { compaction: { enabled: false } }).compaction.enabled).toBe(false);
  });

  it("lets --no-compact beat an enabled file", () => {
    const config = loadConfig({}, { compaction: { enabled: true } }, { compact: false });

    expect(config.compaction.enabled).toBe(false);
  });

  it("ignores a nonsense context size and keeps the default", () => {
    expect(loadConfig({ KICODE_CONTEXT_TOKENS: "banana" }, {}).compaction.contextTokens).toBe(128_000);
    expect(loadConfig({ KICODE_CONTEXT_TOKENS: "-5" }, {}).compaction.contextTokens).toBe(128_000);
  });
});

describe("named providers", () => {
  const two = {
    providers: {
      tokenharbor: { baseUrl: "https://tokenharbor.ai/v1", apiKeyEnv: "TH_KEY" },
      local: { baseUrl: "http://localhost:11434/v1", models: ["qwen3:8b"] },
    },
  } satisfies FileSettings;

  it("resolves the key from the variable the provider names", () => {
    const config = loadConfig({ TH_KEY: "th" }, two);

    expect(config.providers.map((provider) => provider.name)).toEqual(["tokenharbor", "local"]);
    expect(config.providers[0]?.apiKey).toBe("th");
    expect(config.providers[1]?.apiKey).toBe("");
  });

  it("falls back to the variable the provider's name suggests", () => {
    const config = loadConfig({ LOCAL_API_KEY: "l" }, two);

    expect(config.providers[1]?.apiKeyEnv).toBe("LOCAL_API_KEY");
    expect(config.providers[1]?.apiKey).toBe("l");
  });

  it("points the session at the provider it names, key and all", () => {
    const config = loadConfig({ TH_KEY: "th", KICODE_API_KEY: "ambient" }, { ...two, provider: "tokenharbor" });

    expect(config.provider).toBe("tokenharbor");
    expect(config.baseUrl).toBe("https://tokenharbor.ai/v1");
    expect(config.apiKey).toBe("th");
  });

  it("lets KICODE_PROVIDER choose when the file does not", () => {
    const config = loadConfig({ TH_KEY: "th", KICODE_PROVIDER: "tokenharbor" }, two);

    expect(config.baseUrl).toBe("https://tokenharbor.ai/v1");
    expect(config.apiKey).toBe("th");
  });

  it("lets the file's provider beat the environment's", () => {
    const config = loadConfig({ TH_KEY: "th", KICODE_PROVIDER: "tokenharbor" }, { ...two, provider: "local" });

    expect(config.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("lets an explicit baseUrl beat every provider", () => {
    const config = loadConfig({ TH_KEY: "th" }, { ...two, provider: "tokenharbor" }, { baseUrl: "https://own.example/v1" });

    expect(config.baseUrl).toBe("https://own.example/v1");
    // The key still comes from the provider, because the override is an endpoint.
    expect(config.apiKey).toBe("th");
  });

  it("names an endpoint nobody declared as nothing rather than guessing", () => {
    const config = loadConfig({ KICODE_API_KEY: "k" }, { provider: "nope" });

    expect(config.provider).toBeNull();
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it("keeps a provider with no key in the list, so it can be reported", () => {
    const config = loadConfig({}, two);

    expect(config.providers).toHaveLength(2);
    expect(loadConfig({}, two).providers.every((provider) => provider.apiKey === "")).toBe(true);
  });

  it("gives the bundled mock a key of its own, not the real one", () => {
    const config = loadConfig({ KICODE_API_KEY: "real" }, { mock: true });

    expect(config.baseUrl).toBe(MOCK_BASE_URL);
    expect(config.apiKey).toBe(MOCK_API_KEY);
    expect(config.providers.at(-1)).toMatchObject({ name: "mock", baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY });
  });
});

describe("fallback routes", () => {
  it("turns fallbackModels into routes on the endpoint in use", () => {
    const config = loadConfig({ KICODE_API_KEY: "k" }, { model: "primary", fallbackModels: ["a:free", "b:free"] });

    expect(config.fallback.map((route) => route.model)).toEqual(["a:free", "b:free"]);
    expect(config.fallback.every((route) => route.baseUrl === config.baseUrl)).toBe(true);
  });

  it("reads a comma-separated list from the environment", () => {
    const config = loadConfig({ KICODE_API_KEY: "k", KICODE_FALLBACK_MODELS: "a:free, b:free" }, {});

    expect(config.fallback.map((route) => route.model)).toEqual(["a:free", "b:free"]);
  });

  it("resolves a cross-provider route with that provider's key", () => {
    const file: FileSettings = {
      providers: { groq: { baseUrl: "https://groq.example/v1", apiKeyEnv: "GROQ_KEY" } },
      fallback: [{ provider: "groq", model: "llama" }],
    };
    const config = loadConfig({ KICODE_API_KEY: "k", GROQ_KEY: "gk" }, file);

    expect(config.fallback).toHaveLength(1);
    expect(config.fallback[0]).toMatchObject({ baseUrl: "https://groq.example/v1", apiKey: "gk", model: "llama", label: "groq/llama" });
  });

  it("never lists the model in use as its own backup", () => {
    // The same request to the route that just failed only burns the wait again.
    const config = loadConfig({ KICODE_API_KEY: "k" }, { model: "a:free", fallbackModels: ["a:free", "b:free"] });

    expect(config.fallback.map((route) => route.model)).toEqual(["b:free"]);
  });

  it("de-duplicates a route named twice", () => {
    const config = loadConfig({ KICODE_API_KEY: "k" }, { fallbackModels: ["a:free", "a:free"] });

    expect(config.fallback).toHaveLength(1);
  });

  it("is empty when nothing is declared", () => {
    expect(loadConfig({ KICODE_API_KEY: "k" }, {}).fallback).toEqual([]);
  });
});

describe("the token budget", () => {
  it("defaults to no ceiling", () => {
    expect(loadConfig({}, {}).maxTokens).toBe(0);
  });

  it("reads the file, the environment, and the flag, in that order", () => {
    expect(loadConfig({ KICODE_MAX_TOKENS: "1000" }, {}).maxTokens).toBe(1000);
    expect(loadConfig({ KICODE_MAX_TOKENS: "1000" }, { maxTokens: 500 }).maxTokens).toBe(500);
    expect(loadConfig({ KICODE_MAX_TOKENS: "1000" }, { maxTokens: 500 }, { maxTokens: 250 }).maxTokens).toBe(250);
  });

  it("treats nonsense as no ceiling rather than a tiny one", () => {
    expect(loadConfig({ KICODE_MAX_TOKENS: "banana" }, {}).maxTokens).toBe(0);
  });
});

describe("validateConfig with a named provider", () => {
  it("names the variable it looked in", () => {
    const config = loadConfig({}, { provider: "tokenharbor", providers: { tokenharbor: { baseUrl: "https://th.example/v1", apiKeyEnv: "TH_KEY" } } });

    expect(validateConfig(config)).toBe('No API key for provider "tokenharbor" — set TH_KEY.');
  });

  it("stays plain when no provider was named", () => {
    expect(validateConfig(loadConfig({}, {}))).toBe("No API key found.");
  });
});
