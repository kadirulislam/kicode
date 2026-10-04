import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPACING,
  SETTING_KEYS,
  SETTING_SHORTCUTS,
  SPACING_KEYS,
  cycleValue,
  defaultViewSettings,
  filterSettings,
  filterShortcuts,
  setSettingValue,
  settingDefs,
  settingOptions,
  settingValue,
  stepSetting,
  viewFrom,
} from "./settings";
import { themeMode, themeNamesFor } from "./theme";

describe("the view settings", () => {
  it("starts on a theme that exists, in the mode it belongs to", () => {
    const view = defaultViewSettings();
    expect(themeNamesFor(view.colorMode)).toContain(view.theme);
  });

  it("names every setting exactly once, each with the values it accepts", () => {
    const defs = settingDefs(defaultViewSettings());
    const ids = defs.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Every row the values are validated against is a row the panel draws, and
    // the three spacing numbers arrive as dotted rows.
    for (const key of SETTING_KEYS) expect(ids).toContain(key);
    for (const key of SPACING_KEYS) expect(ids).toContain(`spacing.${key}`);
    expect(new Set(ids).size).toBe(SETTING_KEYS.length + 1 + SPACING_KEYS.length);
  });

  it("describes every row, because a settings screen that explains nothing is a guess", () => {
    for (const def of settingDefs(defaultViewSettings())) {
      expect(def.description.length, def.id).toBeGreaterThan(10);
      expect(settingOptions(def.id), def.id).toEqual(def.options);
    }
  });

  it("has no row that changes nothing — every value is one it offers", () => {
    const view = defaultViewSettings();
    for (const def of settingDefs(view)) {
      expect(def.options, def.id).toContain(settingValue(view, def.id));
    }
  });
});

describe("the spacing", () => {
  it("ships the layout the documents describe", () => {
    expect(defaultViewSettings().spacing).toEqual(DEFAULT_SPACING);
  });

  it("hands out its own copy, so one screen cannot space out the next", () => {
    const first = defaultViewSettings();
    first.spacing.block = 0;
    expect(defaultViewSettings().spacing.block).toBe(2);
  });

  it("merges a partial spacing block rather than replacing the whole thing", () => {
    // Naming one number is not a request for 0 in the other two.
    expect(viewFrom("nord", { spacing: { block: 0 } }).spacing).toEqual({ block: 0, entry: 1, turn: 1 });
    expect(viewFrom("nord", {}).spacing).toEqual(DEFAULT_SPACING);
  });
});

describe("stepping a setting", () => {
  it("wraps round at both ends", () => {
    const def = settingDefs(defaultViewSettings()).find((entry) => entry.id === "verbosity")!;
    expect(cycleValue(def, "medium", 1)).toBe("high");
    expect(cycleValue(def, "high", 1)).toBe("low");
    expect(cycleValue(def, "low", -1)).toBe("high");
  });

  it("starts from the first value when the current one is not one of ours", () => {
    const def = settingDefs(defaultViewSettings()).find((entry) => entry.id === "verbosity")!;
    expect(cycleValue(def, "shouty", 1)).toBe("low");
    expect(cycleValue(def, "shouty", -1)).toBe("low");
  });

  it("offers only themes of the current colour mode", () => {
    const dark = defaultViewSettings();
    const def = settingDefs(dark).find((entry) => entry.id === "theme")!;
    expect(def.options.every((name) => themeMode(name) === "dark")).toBe(true);
  });

  it("moves the theme when colour mode moves, so the row cannot lie", () => {
    const dark = { ...defaultViewSettings(), theme: "nord", colorMode: "dark" as const };
    const light = stepSetting(dark, "colorMode", 1);

    expect(light.colorMode).toBe("light");
    expect(themeMode(light.theme)).toBe("light");
  });

  it("moves the theme back when the mode is stepped again", () => {
    const light = { ...defaultViewSettings(), theme: "light", colorMode: "light" as const };
    const dark = stepSetting(light, "colorMode", -1);

    expect(dark.colorMode).toBe("dark");
    expect(themeMode(dark.theme)).toBe("dark");
  });

  it("changes one value and nothing else", () => {
    const view = defaultViewSettings();
    const next = stepSetting(view, "tps", 1);
    expect(next.tps).toBe("off");
    expect({ ...next, tps: view.tps }).toEqual(view);
  });

  it("ignores a row that does not exist", () => {
    const view = defaultViewSettings();
    expect(stepSetting(view, "nonsense" as never, 1)).toBe(view);
  });
});

describe("filtering the rows", () => {
  const view = defaultViewSettings();
  const defs = settingDefs(view);

  it("keeps every row when nothing has been typed", () => {
    expect(filterSettings(defs, view, "  ")).toHaveLength(defs.length);
  });

  it("matches the label, the group and the effect", () => {
    expect(filterSettings(defs, view, "scroll").map((def) => def.id)).toEqual(["scrollbar"]);
    expect(filterSettings(defs, view, "Appearance").map((def) => def.id)).toEqual(["theme", "colorMode", "animations"]);
    // The description is searched too: "reasoning" is what Thinking is about.
    expect(filterSettings(defs, view, "reasoning").map((def) => def.id)).toEqual(["thinking"]);
  });

  it("matches the value on the row, so a column can be found by what it says", () => {
    expect(filterSettings(defs, view, "on").some((def) => def.id === "animations")).toBe(true);
  });

  it("matches nothing rather than everything when there is no match", () => {
    expect(filterSettings(defs, view, "chartreuse")).toEqual([]);
  });
});

describe("settings from a config file", () => {
  it("takes the theme, and the mode the theme is in", () => {
    expect(viewFrom("light")).toMatchObject({ theme: "light", colorMode: "light" });
  });

  it("takes a declared light mode when no theme was named", () => {
    const view = viewFrom("nope", { colorMode: "light", thinking: "hide" });
    expect(themeMode(view.theme)).toBe("light");
    expect(view.thinking).toBe("hide");
  });

  it("falls back to a real theme when the name is not one of ours", () => {
    const view = viewFrom("chartreuse", {});
    expect(themeNamesFor(view.colorMode)).toContain(view.theme);
  });

  it("keeps the declared values it was given", () => {
    const view = viewFrom("nord", { verbosity: "high", markdown: "raw" });
    expect(view).toMatchObject({ verbosity: "high", markdown: "raw", theme: "nord", colorMode: "dark" });
  });
});

describe("the settings shortcuts", () => {
  it("lists the seven doors in panel order, each explained", () => {
    expect(SETTING_SHORTCUTS.map((shortcut) => shortcut.id)).toEqual([
      "shortcut:connect",
      "shortcut:models",
      "shortcut:sessions",
      "shortcut:compact",
      "shortcut:skills",
      "shortcut:tools",
      "shortcut:mcp",
    ]);
    for (const shortcut of SETTING_SHORTCUTS) {
      expect(shortcut.label.length).toBeGreaterThan(0);
      expect(shortcut.description.length).toBeGreaterThan(10);
    }
  });

  it("keeps every shortcut row, unfiltered, when nothing has been typed", () => {
    expect(filterShortcuts("  ").map((shortcut) => shortcut.id)).toEqual(
      SETTING_SHORTCUTS.map((shortcut) => shortcut.id),
    );
  });

  it("matches the label and the effect, ignoring case", () => {
    expect(filterShortcuts("MODEL").map((shortcut) => shortcut.id)).toEqual(["shortcut:models"]);
    // The description is searched too: "endpoint" is what Connect is about.
    expect(filterShortcuts("endpoint").map((shortcut) => shortcut.id)).toEqual([
      "shortcut:connect",
      "shortcut:models",
    ]);
  });

  it("matches nothing rather than everything when there is no match", () => {
    expect(filterShortcuts("chartreuse")).toEqual([]);
  });
});
