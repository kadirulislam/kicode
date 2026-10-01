import { describe, expect, it } from "vitest";
import { filterMenuRows, selectedRow, stepMenuRow, type MenuRow } from "./menu";

const rows: MenuRow[] = [
  { label: "Theme", value: "theme", trailing: "nord", group: "Appearance" },
  { label: "Color mode", value: "colorMode", trailing: "dark" },
  { label: "Sidebar", value: "sidebar", trailing: "auto", group: "Session" },
  { label: "unreachable", value: "nope", disabled: true },
  { label: "TPS", value: "tps", trailing: "on" },
];

describe("stepping through menu rows", () => {
  it("moves, and wraps at both ends", () => {
    expect(stepMenuRow(rows, 0, 1)).toBe(1);
    expect(stepMenuRow(rows, 0, -1)).toBe(4);
    expect(stepMenuRow(rows, 4, 1)).toBe(0);
  });

  it("skips a row that cannot be chosen", () => {
    // From `Sidebar` forward: `unreachable` is passed over, not landed on.
    expect(stepMenuRow(rows, 2, 1)).toBe(4);
    expect(stepMenuRow(rows, 4, -1)).toBe(2);
  });

  it("stays put when nothing can be chosen", () => {
    const all = rows.map((row) => ({ ...row, disabled: true }));
    expect(stepMenuRow(all, 2, 1)).toBe(2);
  });

  it("has nowhere to go in an empty list", () => {
    expect(stepMenuRow([], 0, 1)).toBe(0);
  });
});

describe("filtering menu rows", () => {
  it("keeps everything when nothing has been typed", () => {
    expect(filterMenuRows(rows, "  ")).toHaveLength(rows.length);
  });

  it("searches the label, the heading and the value", () => {
    expect(filterMenuRows(rows, "theme").map((row) => row.value)).toEqual(["theme"]);
    // Only the first row of a run carries the heading, so the group name finds
    // the row that names it — which is the one the heading sits above.
    expect(filterMenuRows(rows, "Session").map((row) => row.value)).toEqual(["sidebar"]);
    expect(filterMenuRows(rows, "nord").map((row) => row.value)).toEqual(["theme"]);
    expect(filterMenuRows(rows, "tps").map((row) => row.value)).toEqual(["tps"]);
  });

  it("matches nothing rather than everything", () => {
    expect(filterMenuRows(rows, "chartreuse")).toEqual([]);
  });
});

describe("the row under the cursor", () => {
  it("finds it, and clamps a cursor that has run off the end", () => {
    expect(selectedRow(rows, 1)?.value).toBe("colorMode");
    expect(selectedRow(rows, 99)?.value).toBe("tps");
    expect(selectedRow(rows, -3)?.value).toBe("theme");
    expect(selectedRow([], 0)).toBeUndefined();
  });
});
