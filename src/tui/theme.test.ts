import { describe, expect, it } from "vitest";
import { BOLD, fg } from "./ansi";
import {
  DEFAULT_THEME,
  THEMES,
  buildStyles,
  isThemeName,
  themeByName,
  themeMode,
  themeNames,
  themeNamesFor,
} from "./theme";

/** Perceived brightness, near enough to answer "is this readable on that?". */
function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  return ((value >> 16) & 0xff) * 0.299 + ((value >> 8) & 0xff) * 0.587 + (value & 0xff) * 0.114;
}

/** How much colour a surface carries, 0–1: the gap between its widest channels. */
function chroma(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  return (Math.max(...channels) - Math.min(...channels)) / 255;
}

/** The four fills a screen is built from, near enough to background to rest the eye. */
const SURFACES = ["bg", "panel", "block", "input"] as const;

describe("the theme roster", () => {
  it("starts on the default, and names every theme exactly once", () => {
    expect(THEMES[0]?.name).toBe(DEFAULT_THEME);
    expect(new Set(themeNames()).size).toBe(THEMES.length);
  });

  it("fills every slot of every theme with a real colour", () => {
    const slots = Object.keys(THEMES[0]!.theme);
    expect(slots.length).toBeGreaterThan(12);

    for (const { name, theme } of THEMES) {
      expect(Object.keys(theme), name).toEqual(slots);
      for (const [slot, value] of Object.entries(theme)) {
        // A theme is a palette, and a palette entry is a hex colour — a slot
        // left empty would be a theme that renders as the terminal's default.
        expect(value, `${name}.${slot}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it("keeps text readable against its own background", () => {
    for (const { name, mode, theme } of THEMES) {
      const contrast = Math.abs(luminance(theme.text) - luminance(theme.bg));
      expect(contrast, name).toBeGreaterThan(100);
      // The mode is a claim about the palette, so it is checked rather than
      // declared: a light theme on a dark background would leave the Colour
      // mode setting picking a theme that is not the one it advertises.
      expect(luminance(theme.text) > luminance(theme.bg), name).toBe(mode === "dark");
    }
  });

  it("has both halves of the roster filled, for the colour mode setting", () => {
    expect(themeNamesFor("dark").length).toBeGreaterThan(1);
    expect(themeNamesFor("light").length).toBeGreaterThan(1);
    // Every name in one half belongs to that half, and no name is in both.
    for (const name of themeNamesFor("light")) expect(themeMode(name)).toBe("light");
    for (const name of themeNamesFor("dark")) expect(themeMode(name)).toBe("dark");
    expect(themeNamesFor("dark").length + themeNamesFor("light").length).toBe(THEMES.length);
  });

  it("has a default that is one of ours, so a name is never a guess", () => {
    expect(isThemeName(DEFAULT_THEME)).toBe(true);
    expect(isThemeName("nope")).toBe(false);
    expect(themeByName("nope")).toBe(themeByName(DEFAULT_THEME));
  });

  it("resolves legacy theme aliases like opencode cleanly", () => {
    expect(isThemeName("opencode")).toBe(true);
    expect(themeByName("opencode")).toBe(themeByName("kicode"));
  });

  it("keeps every surface matte, so a theme rests the eye rather than glares at it", () => {
    // A background is the largest area on screen: any chroma in it is read as
    // colour everywhere at once. The fills may not carry much either — a tinted
    // box is a highlight, and the typing area is not the loudest thing here.
    // The two themes whose whole point is not to tint anything sit lower still.
    for (const { name, theme } of THEMES) {
      for (const slot of SURFACES) {
        expect(chroma(theme[slot]), `${name}.${slot}`).toBeLessThanOrEqual(0.08);
      }
      if (name === "mono" || name === "contrast") {
        for (const slot of SURFACES) expect(chroma(theme[slot]), `${name}.${slot}`).toBe(0);
      }
    }
  });

  it("steps each fill away from its own background, so surfaces stay tellable apart", () => {
    // Matte is not the same as flat: a box the eye cannot pick out is a box the
    // eye stops seeing. Dark themes step lighter as they come forward, light ones
    // step darker — the same direction as the theme it belongs to.
    for (const { name, mode, theme } of THEMES) {
      const steps = SURFACES.filter((slot) => slot !== "bg").map((slot) => luminance(theme[slot]));
      const bgL = luminance(theme.bg);
      for (const value of steps) {
        expect(Math.abs(value - bgL) > 8, `${name} surface on bg`).toBe(true);
        expect(value > bgL, `${name} ${mode} surface`).toBe(mode === "dark");
      }
      expect(new Set(steps.map((value) => Math.round(value))).size).toBeGreaterThan(1);
    }
  });

  it("gives every slot a style of its own, so a theme can change it", () => {
    const theme = themeByName("kicode");
    const styles = buildStyles(theme);

    expect(styles.emphasis).toContain(fg(theme.highlight));
    expect(styles.emphasis).toContain(BOLD);
    expect(styles.rule).toContain(fg(theme.rule));
    expect(styles.mode).toContain(fg(theme.mode));
    expect(styles.accent).toContain(fg(theme.accent));
    expect(styles.paletteSelected).toContain(fg(theme.bg));
  });
});
