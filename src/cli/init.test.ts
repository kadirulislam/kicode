import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_COMPACT_AT_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  DEFAULT_MAX_SUBAGENTS_PER_TURN,
  DEFAULT_MODEL,
  DEFAULT_RETRY_UNFINISHED,
  DEFAULT_SUBAGENT_ITERATIONS,
  DEFAULT_SUBAGENT_STALE_MS,
  DEFAULT_SUBAGENT_STALE_TOOL_MS,
  MOCK_BASE_URL,
  type Config,
} from "../config";
import { defaultViewSettings } from "../tui/settings";
import { DEFAULT_THEME } from "../tui/theme";
import { writeProjectConfig } from "./init";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kicode-init-"));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function config(overrides: Partial<Config> = {}): Config {
  return {
    apiKey: "test",
    // `""` is the fresh-install state: nothing declared yet. The tests that care
    // about an endpoint pass one explicitly.
    baseUrl: "",
    provider: null,
    providers: [],
    model: DEFAULT_MODEL,
    theme: DEFAULT_THEME,
    view: defaultViewSettings(),
    maxTurns: 12,
    fallback: [],
    fallbackAuto: true,
    maxTokens: 0,
    allow: {},
    learning: "auto",
    compaction: {
      enabled: true,
      contextTokens: DEFAULT_CONTEXT_TOKENS,
      reserveTokens: 8_000,
      targetPercent: 40,
      compactAt: DEFAULT_COMPACT_AT_TOKENS,
    },
    delegation: {
      enabled: true,
      model: "",
      baseUrl: "",
      maxConcurrent: DEFAULT_MAX_CONCURRENT_SUBAGENTS,
      maxPerTurn: DEFAULT_MAX_SUBAGENTS_PER_TURN,
      maxIterations: DEFAULT_SUBAGENT_ITERATIONS,
      staleMs: DEFAULT_SUBAGENT_STALE_MS,
      staleToolMs: DEFAULT_SUBAGENT_STALE_TOOL_MS,
      retryUnfinished: DEFAULT_RETRY_UNFINISHED,
    },
    github: { enabled: false },
    ...overrides,
  };
}

const file = (): string => path.join(dir, "kicode.json");

async function readJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file(), "utf8")) as Record<string, unknown>;
}

describe("--init creating a file", () => {
  it("writes the model and the endpoint it would actually use", async () => {
    const outcome = await writeProjectConfig(dir, config({ model: "some-model", baseUrl: "https://gw.example.com/v1" }));

    expect(outcome.status).toBe("written");
    expect(await readJson()).toEqual({ model: "some-model", baseUrl: "https://gw.example.com/v1" });
  });

  it("writes no endpoint when none is configured yet", async () => {
    // Recording `""` would freeze an empty endpoint into the file, which is
    // worse than recording nothing at all.
    await writeProjectConfig(dir, config({ model: "m" }));

    expect(await readJson()).toEqual({ model: "m" });
  });

  it("ends the file with a newline", async () => {
    await writeProjectConfig(dir, config());

    expect(await readFile(file(), "utf8")).toMatch(/\n$/);
  });

  it("writes the mock shorthand instead of the mock's URL", async () => {
    const outcome = await writeProjectConfig(dir, config({ baseUrl: MOCK_BASE_URL, model: "mock-model" }));
    if (outcome.status === "blocked") throw new Error(outcome.reason);

    // The summary line the CLI prints is driven by these keys.
    expect(outcome.keys).toContain("mock");
    expect(await readJson()).toEqual({ model: "mock-model", mock: true });
  });

  it("records compaction only when it differs from the defaults", async () => {
    const tuning = config({
      compaction: { enabled: true, contextTokens: 256_000, reserveTokens: 8_000, targetPercent: 35, compactAt: 120_000 },
    });

    await writeProjectConfig(dir, tuning);

    expect(await readJson()).toEqual({
      model: DEFAULT_MODEL,
      compaction: { contextTokens: 256_000, targetPercent: 35, compactAt: 120_000 },
    });
  });

  it("records a non-default compactAt", async () => {
    const tuning = config({
      compaction: {
        enabled: true,
        contextTokens: DEFAULT_CONTEXT_TOKENS,
        reserveTokens: 8_000,
        targetPercent: 40,
        compactAt: 50_000,
      },
    });

    await writeProjectConfig(dir, tuning);

    expect(await readJson()).toEqual({ model: DEFAULT_MODEL, compaction: { compactAt: 50_000 } });
  });

  it("records compaction being switched off", async () => {
    await writeProjectConfig(
      dir,
      config({
        compaction: {
          enabled: false,
          contextTokens: DEFAULT_CONTEXT_TOKENS,
          reserveTokens: 8_000,
          targetPercent: 40,
          compactAt: DEFAULT_COMPACT_AT_TOKENS,
        },
      }),
    );

    expect((await readJson()).compaction).toEqual({ enabled: false });
  });
});

describe("--init merging into an existing file", () => {
  it("keeps the mcp servers and reports an update", async () => {
    const servers = { mcp: { docs: { type: "local", command: ["npx", "-y", "some-server"] } } };
    await writeFile(file(), JSON.stringify({ model: "old", ...servers }), "utf8");

    const outcome = await writeProjectConfig(dir, config({ model: "new" }));

    expect(outcome.status).toBe("updated");
    expect(await readJson()).toEqual({ model: "new", ...servers });
  });

  it("keeps unknown keys at the top level and inside compaction", async () => {
    await writeFile(
      file(),
      JSON.stringify({ model: "old", future: true, compaction: { targetPercent: 35, futureKnob: 1 } }),
      "utf8",
    );

    await writeProjectConfig(
      dir,
      config({ compaction: { enabled: true, contextTokens: 256_000, reserveTokens: 8_000, targetPercent: 35, compactAt: 100_000 } }),
    );

    expect(await readJson()).toEqual({
      model: DEFAULT_MODEL,
      future: true,
      compaction: { targetPercent: 35, futureKnob: 1, contextTokens: 256_000, compactAt: 100_000 },
    });
  });

  it("does not rewrite an unchanged file", async () => {
    await writeProjectConfig(dir, config({ model: "same" }));
    const before = await readFile(file(), "utf8");

    const outcome = await writeProjectConfig(dir, config({ model: "same" }));

    expect(outcome.status).toBe("unchanged");
    expect(await readFile(file(), "utf8")).toBe(before);
  });

  it("drops a stale baseUrl when switching the project to the mock", async () => {
    // Both keys at once is a contradiction: the URL wins and `mock` is ignored.
    await writeFile(file(), JSON.stringify({ model: "m", baseUrl: "https://gw.example.com/v1" }), "utf8");

    await writeProjectConfig(dir, config({ baseUrl: MOCK_BASE_URL, model: "m" }));

    expect(await readJson()).toEqual({ model: "m", mock: true });
  });

  it("drops a stale mock when an explicit endpoint is recorded", async () => {
    await writeFile(file(), JSON.stringify({ model: "m", mock: true }), "utf8");

    await writeProjectConfig(dir, config({ baseUrl: "https://gw.example.com/v1", model: "m" }));

    expect(await readJson()).toEqual({ model: "m", baseUrl: "https://gw.example.com/v1" });
  });
});

describe("--init refuses to clobber what it cannot read", () => {
  it("blocks on invalid JSON and names the file", async () => {
    await writeFile(file(), "{ not json", "utf8");

    const outcome = await writeProjectConfig(dir, config());

    expect(outcome.status).toBe("blocked");
    expect(outcome.status === "blocked" && outcome.reason).toContain("Refusing to touch");
    // Left exactly as it was, rather than half-rewritten.
    expect(await readFile(file(), "utf8")).toBe("{ not json");
  });

  it("blocks on a non-object top level", async () => {
    await writeFile(file(), "[1, 2]", "utf8");

    const outcome = await writeProjectConfig(dir, config());

    expect(outcome.status).toBe("blocked");
    expect(outcome.status === "blocked" && outcome.reason).toContain("JSON object");
  });
});
