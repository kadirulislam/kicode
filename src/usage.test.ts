import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dayOf,
  hostOfBaseUrl,
  readUsage,
  recordUsage,
  renderUsage,
  summarizeUsage,
  turnRecord,
  usageFile,
  usageReportJson,
  type UsageRecord,
} from "./usage";

let home = "";
const env = (): NodeJS.ProcessEnv => ({ ...process.env, KICODE_HOME: home });

const record = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  at: "2026-09-30T10:00:00.000Z",
  model: "m",
  host: "api.example.com",
  promptTokens: 100,
  completionTokens: 50,
  toolCalls: 2,
  ms: 30_000,
  ...over,
});

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "kicode-usage-"));
});

afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

describe("usage file", () => {
  it("lives beside the sessions, as JSON lines", async () => {
    expect(usageFile(env())).toBe(path.join(home, "usage.jsonl"));
  });

  it("round-trips what was filed", async () => {
    await recordUsage(record({ model: "a" }), env());
    await recordUsage(record({ model: "b", at: "2026-10-01T10:00:00.000Z" }), env());

    const records = await readUsage(env());
    expect(records.filter((r) => r.model === "a" || r.model === "b")).toHaveLength(2);
  });

  it("reads nothing when there is nothing, and skips garbage", async () => {
    const own = await mkdtemp(path.join(tmpdir(), "kicode-usage-empty-"));
    const onlyVisible = { ...process.env, KICODE_HOME: own };
    try {
      expect(await readUsage(onlyVisible)).toEqual([]);

      await writeFile(usageFile(onlyVisible), "{ not json\n[1,2]\n", "utf8");
      expect(await readUsage(onlyVisible)).toEqual([]);
    } finally {
      await rm(own, { recursive: true, force: true });
    }
  });
});

describe("turnRecord", () => {
  it("keeps the hostname and drops the rest of the URL", () => {
    const filed = turnRecord({
      model: "m",
      baseUrl: "https://api.example.com/v1?key=secret",
      promptTokens: 10,
      completionTokens: 5,
      toolCalls: 1,
      ms: 1000,
    });

    // A query string can carry a credential, so only the host is kept.
    expect(filed?.host).toBe("api.example.com");
  });

  it("says unknown when the endpoint does not parse", () => {
    expect(hostOfBaseUrl("not a url")).toBe("unknown");
  });

  it("files nothing for a turn that cost nothing", () => {
    expect(
      turnRecord({ model: "m", baseUrl: "https://api.example.com/v1", promptTokens: 0, completionTokens: 0, toolCalls: 0, ms: 10 }),
    ).toBeNull();
  });

  it("files a turn that only ran tools", () => {
    const filed = turnRecord({
      model: "m",
      baseUrl: "https://api.example.com/v1",
      promptTokens: 0,
      completionTokens: 0,
      toolCalls: 3,
      ms: 500,
    });

    expect(filed?.toolCalls).toBe(3);
  });
});

describe("summarizeUsage", () => {
  // Built from local components: day buckets are read on the local clock, so
  // a UTC string would land on different days in different timezones.
  const at = (month: number, day: number, hour = 10): string => new Date(2026, month - 1, day, hour).toISOString();
  const history: UsageRecord[] = [
    record({ at: at(9, 30), model: "a", promptTokens: 100, completionTokens: 50, toolCalls: 1, ms: 10_000 }),
    record({ at: at(9, 30, 12), model: "b", promptTokens: 200, completionTokens: 0, toolCalls: 0, ms: 20_000 }),
    record({ at: at(10, 1), model: "a", promptTokens: 0, completionTokens: 25, toolCalls: 3, ms: 30_000 }),
  ];

  it("rolls up totals, days newest-first, models by tokens", () => {
    const summary = summarizeUsage(history);

    expect(summary.total).toMatchObject({ turns: 3, promptTokens: 300, completionTokens: 75, totalTokens: 375, toolCalls: 4, ms: 60_000 });
    expect(summary.days.map((day) => day.day)).toEqual(["2026-10-01", "2026-09-30"]);
    expect(summary.days[1]).toMatchObject({ turns: 2, totalTokens: 350 });
    expect(summary.models.map((model) => model.model)).toEqual(["b", "a"]);
  });

  it("renders an empty history as one line, not an empty report", () => {
    expect(renderUsage(summarizeUsage([]))).toEqual(["no usage recorded yet — the file fills in as turns finish"]);
  });

  it("renders totals a terminal can read at a glance", () => {
    const lines = renderUsage(summarizeUsage(history));

    expect(lines[0]).toContain("all time: 3 turns");
    expect(lines[0]).toContain("375 tokens");
    expect(lines.some((line) => line.startsWith("2026-09-30:"))).toBe(true);
    expect(lines.some((line) => line.startsWith("a:"))).toBe(true);
  });

  it("folds long histories instead of flooding", () => {
    const many: UsageRecord[] = Array.from({ length: 30 }, (_, index) =>
      record({ at: new Date(2026, 7, index + 1, 10).toISOString(), model: `m${index}` }),
    );

    const lines = renderUsage(summarizeUsage(many));
    expect(lines.some((line) => line.includes("earlier days"))).toBe(true);
    expect(lines.some((line) => line.includes("more models"))).toBe(true);
  });

  it("reports JSON with the same shape it summarizes", () => {
    const parsed = JSON.parse(usageReportJson(summarizeUsage(history))) as ReturnType<typeof summarizeUsage>;

    expect(parsed.total.turns).toBe(3);
    expect(parsed.days).toHaveLength(2);
    expect(parsed.models).toHaveLength(2);
  });

  it("buckets an unreadable stamp as unknown instead of crashing", () => {
    expect(dayOf("not a date")).toBe("unknown");
  });
});
