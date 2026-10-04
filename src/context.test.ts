import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./types";
import {
  CONTEXT_BAR_CELLS,
  contextBar,
  contextHeadline,
  contextRowLine,
  formatContextTokens,
  renderContext,
  summarizeContext,
} from "./context";

const turns: ChatMessage[] = [
  { role: "user", content: "why is the build failing?" },
  { role: "assistant", content: "Because src/config.ts is missing a default." },
  { role: "assistant", content: null, tool_calls: [] },
];

describe("summarizeContext", () => {
  it("lifts the briefing rows out of the system row so they add up", () => {
    const system = `${"s".repeat(400)}${"k".repeat(400)}${"m".repeat(400)}`;
    const skills = "k".repeat(400);
    const memory = "m".repeat(400);

    const breakdown = summarizeContext({
      systemText: system,
      toolCount: 22,
      skillText: skills,
      skillsLoaded: 12,
      memoryText: memory,
      memoryFiles: 3,
      turns: [...turns],
      budget: 128_000,
    });

    const byLabel = Object.fromEntries(breakdown.rows.map((row) => [row.label, row]));
    // 400 chars at four to a token is 100 each: 300 system, less the two
    // briefing rows, plus the conversation on top.
    expect(byLabel["System tools"]?.tokens).toBe(100);
    expect(byLabel["System tools"]?.detail).toBe("22 tools");
    expect(byLabel["Skills"]).toMatchObject({ tokens: 100, detail: "12 loaded" });
    expect(byLabel["Memory"]).toMatchObject({ tokens: 100, detail: "3 memory files" });
    expect(breakdown.rows).toHaveLength(4);
    expect(breakdown.used).toBe(
      (byLabel["System tools"]?.tokens ?? 0) +
        (byLabel["Skills"]?.tokens ?? 0) +
        (byLabel["Memory"]?.tokens ?? 0) +
        (byLabel["Messages"]?.tokens ?? 0),
    );
    expect(breakdown.budget).toBe(128_000);
  });

  it("skips the rows the briefing does not carry, and counts the conversation", () => {
    const breakdown = summarizeContext({
      systemText: "s".repeat(400),
      toolCount: 22,
      turns: [...turns],
      budget: 128_000,
    });

    expect(breakdown.rows.map((row) => row.label)).toEqual(["System tools", "Messages"]);
    expect(breakdown.rows.at(-1)?.detail).toBe("1 user · 2 assistant");
  });

  it("names one memory file in the singular", () => {
    const breakdown = summarizeContext({
      systemText: "",
      toolCount: 0,
      memoryText: "m".repeat(40),
      memoryFiles: 1,
      turns: [],
      budget: 0,
    });

    expect(breakdown.rows.map((row) => row.label)).toEqual(["System tools", "Memory", "Messages"]);
    expect(breakdown.rows[1]).toMatchObject({ detail: "1 memory file" });
  });

  it("costs the tool declarations into the system row", () => {
    const without = summarizeContext({ systemText: "s".repeat(400), toolCount: 3, turns: [], budget: 0 });
    const specs = summarizeContext({ systemText: "s".repeat(400), toolCount: 3, toolTokens: 250, turns: [], budget: 0 });

    expect(without.rows[0]?.tokens).toBe(100);
    expect(specs.rows[0]?.tokens).toBe(350);
    expect(specs.rows[0]?.detail).toBe("3 tools");
  });

  it("never lets the system row go negative when the briefing outweighs it", () => {    const breakdown = summarizeContext({
      systemText: "short",
      toolCount: 0,
      skillText: "k".repeat(4000),
      skillsLoaded: 1,
      turns: [],
      budget: 0,
    });

    expect(breakdown.rows[0]?.tokens).toBe(0);
  });
});

describe("contextHeadline", () => {
  it("says used, window and what is left", () => {
    expect(contextHeadline(45_700, 1_000_000)).toBe("45.7k / 1.0M · 954.3k remaining (estimated)");
  });

  it("says when the session names no window", () => {
    expect(contextHeadline(1200, 0)).toBe("1.2k used · window unknown");
  });
});

describe("contextBar", () => {
  it("fills in proportion, 24 cells wide", () => {
    const bar = contextBar(500_000, 1_000_000);

    expect(bar).toHaveLength(CONTEXT_BAR_CELLS);
    expect(bar).toBe(`${"█".repeat(12)}${"░".repeat(12)}`);
  });

  it("fills whole rather than drawing past the end when over budget", () => {
    expect(contextBar(2_000_000, 1_000_000)).toBe("█".repeat(CONTEXT_BAR_CELLS));
  });

  it("has nothing to draw without a window", () => {
    expect(contextBar(1200, 0)).toBe(null);
  });
});

describe("renderContext", () => {
  it("reads like the panel: model, bar with the share, headline, rows", () => {
    const lines = renderContext(
      "deepseek-v4-flash",
      summarizeContext({ systemText: "", toolCount: 22, turns: [], budget: 1_000_000 }),
    );

    expect(lines[0]).toBe("CONTEXT · deepseek-v4-flash");
    expect(lines[1]).toMatch(/%$/);
    expect(lines[2]).toContain("remaining (estimated)");
    expect(lines.at(-1)).toContain("Messages");
  });
});

describe("contextRowLine", () => {
  it("pairs the count with what the count is", () => {
    expect(contextRowLine({ label: "System tools", tokens: 12_600, detail: "22 tools" })).toBe(
      "System tools  12.6k tokens · 22 tools",
    );
  });
});

describe("formatContextTokens", () => {
  it("keeps the decimal where a context panel lives", () => {
    expect(formatContextTokens(140)).toBe("140");
    expect(formatContextTokens(45_700)).toBe("45.7k");
    expect(formatContextTokens(1_000_000)).toBe("1.0M");
  });
});
