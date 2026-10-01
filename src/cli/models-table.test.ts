import { describe, expect, it } from "vitest";
import type { ModelRecord } from "../providers/openai";
import { renderModelsTable } from "./models-table";

const model = (over: Partial<ModelRecord> & { id: string }): ModelRecord => ({
  free: false,
  ...over,
});

const rows = (output: string): string[] => output.split("\n").filter((line) => line.trim() !== "");

describe("renderModelsTable", () => {
  it("says so when there is nothing to show", () => {
    expect(renderModelsTable([])).toContain("no models");
  });

  it("puts free routes first, then sorts alphabetically", () => {
    const output = renderModelsTable([
      model({ id: "zebra" }),
      model({ id: "banana" }),
      model({ id: "paid-free", free: true }),
      model({ id: "alpha-free", free: true }),
    ]);

    const ids = rows(output).slice(1, 5).map((line) => line.slice(2).trim().split(/\s+/)[0]);

    expect(ids).toEqual(["alpha-free", "paid-free", "banana", "zebra"]);
  });

  it("marks free routes and paid routes", () => {
    const output = renderModelsTable([model({ id: "cheap:free", free: true }), model({ id: "pricey" })]);

    expect(output).toContain("FREE");
    expect(output).toContain("paid");
  });

  it("marks the current model with an asterisk", () => {
    const output = renderModelsTable([model({ id: "a" }), model({ id: "b" })], { currentModel: "b" });

    const lines = rows(output);
    expect(lines.some((line) => line.startsWith("*") && line.includes("b"))).toBe(true);
    expect(lines.some((line) => line.startsWith(" ") && line.includes("  a"))).toBe(true);
  });

  it("notes when the current model is not offered by the endpoint", () => {
    const output = renderModelsTable([model({ id: "a" })], { currentModel: "gpt-4o-mini" });

    expect(output).toContain("current: gpt-4o-mini (not offered here)");
  });

  it("formats context windows compactly", () => {
    const output = renderModelsTable([
      model({ id: "million", contextLength: 1_048_576 }),
      model({ id: "twohundred", contextLength: 200_000 }),
      model({ id: "small", contextLength: 8192 }),
      model({ id: "unknown" }),
    ]);

    expect(output).toContain("1M");
    expect(output).toContain("200k");
    expect(output).toContain("8k");
    // An endpoint that reports nothing must not print a made-up number.
    expect(output).toContain("—");
  });

  it("shouts when a model cannot call tools", () => {
    const output = renderModelsTable([model({ id: "chat-only", supportsTools: false }), model({ id: "agent" , supportsTools: true })]);

    expect(output).toContain("NO");
    expect(output).toContain("cannot call tools");
  });

  it("shows tool support as unknown when the endpoint omits it", () => {
    const output = renderModelsTable([model({ id: "mystery" })]);

    expect(output).not.toContain("cannot call tools");
    expect(rows(output)[1]).toContain("—");
  });

  it("aligns every row to the same column widths", () => {
    const output = renderModelsTable([
      model({ id: "short", tier: "high", contextLength: 1000, supportsTools: true }),
      model({ id: "a-much-longer-model-name", tier: "low", contextLength: 200_000, supportsTools: false }),
    ]);

    const lines = rows(output);
    const costAt = (line: string): number => line.search(/(FREE|paid)$/);

    expect(costAt(lines[1] ?? "")).toBe(costAt(lines[2] ?? ""));
  });

  it("truncates a very long id rather than wrecking the table", () => {
    const output = renderModelsTable([model({ id: "x".repeat(80) })]);

    expect(output).toContain("…");
    expect(rows(output)[1]?.length).toBeLessThan(100);
  });
});
