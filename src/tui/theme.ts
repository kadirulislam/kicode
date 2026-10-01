import { BOLD, DIM, ITALIC, UNDERLINE, bg, fg, style } from "./ansi";

/**
 * The palettes, in one place.
 *
 * Every theme fills the same slots, so a theme is a statement about colour and
 * never about layout: the transcript reads as the content and the chrome
 * recedes. Colours are 24-bit; a terminal that cannot do that still gets the
 * layout, just flat.
 *
 * The slots beyond text/background are the ones the blocks need:
 *
 * - `panel` fills the bars and a card — a surface that is *above* the
 *   background without being loud;
 * - `block` is the fill behind a user turn **and behind the input box**, so a
 *   request reads as a block of its own rather than a line that happens to be
 *   bold, and the place being typed into is visibly the same material as the
 *   words it will become;
 * - `rule` is the thin left rule on tool output, which is what ties a run of
 *   actions together as one piece of work;
 * - `highlight` is emphasis inside prose — the one word in a sentence that
 *   matters — and is deliberately *not* the accent, so it stands out against
 *   the chrome instead of blending into it;
 * - `mode` colours the build/plan word, which changes what the model may do
 *   and so deserves its own colour on the row.
 */
export type Theme = {
  bg: string;
  panel: string;
  block: string;
  text: string;
  dim: string;
  faint: string;
  rule: string;
  accent: string;
  mode: string;
  ok: string;
  error: string;
  warn: string;
  code: string;
  highlight: string;
  /** Gradient ends for the wordmark. */
  logoFrom: string;
  logoTo: string;
};

/**
 * The default: the violet-on-near-black look KiCode is built to be recognised
 * by. A dark background with a violet accent reads as a tool, and the orange
 * emphasis keeps a sentence's important word from looking like chrome.
 */
export const kicodeTheme: Theme = {
  bg: "#08090f",
  panel: "#151621",
  block: "#1d1e2e",
  text: "#e6e6ef",
  dim: "#9b9bb5",
  faint: "#55556d",
  rule: "#2a2c42",
  accent: "#a78bfa",
  mode: "#38bdf8",
  ok: "#34d399",
  error: "#f87171",
  warn: "#fbbf24",
  code: "#67e8f9",
  highlight: "#f59e0b",
  logoFrom: "#4c3d99",
  logoTo: "#ffffff",
};

/** The original dark slate with a teal accent. */
export const darkTheme: Theme = {
  bg: "#0f1720",
  panel: "#16212e",
  block: "#1b2837",
  text: "#e6edf3",
  dim: "#8296ab",
  faint: "#46617d",
  rule: "#2b415a",
  accent: "#2dd4bf",
  mode: "#2dd4bf",
  ok: "#4ade80",
  error: "#f87171",
  warn: "#fbbf24",
  code: "#7dd3fc",
  highlight: "#fbbf24",
  logoFrom: "#33506f",
  logoTo: "#ffffff",
};

/**
 * The same layout on a light background.
 *
 * Every colour is a step darker than its dark-theme twin: a terminal with a
 * pale background has to be met with text that stays readable on it, and the
 * accent gets deeper rather than brighter so it does not wash out.
 */
export const lightTheme: Theme = {
  bg: "#f8fafc",
  panel: "#e7edf4",
  block: "#eef2f8",
  text: "#182430",
  dim: "#4d6076",
  faint: "#8a9bad",
  rule: "#c2cfdd",
  accent: "#0f766e",
  mode: "#b45309",
  ok: "#15803d",
  error: "#b91c1c",
  warn: "#b45309",
  code: "#0369a1",
  highlight: "#b45309",
  logoFrom: "#b9c9d8",
  logoTo: "#0b1219",
};

export const tokyoNightTheme: Theme = {
  bg: "#1a1b26",
  panel: "#1f2335",
  block: "#24283b",
  text: "#c0caf5",
  dim: "#9aa5ce",
  faint: "#565f89",
  rule: "#3b4261",
  accent: "#7aa2f7",
  mode: "#bb9af7",
  ok: "#9ece6a",
  error: "#f7768e",
  warn: "#e0af68",
  code: "#7dcfff",
  highlight: "#ff9e64",
  logoFrom: "#3b4261",
  logoTo: "#ffffff",
};

export const gruvboxTheme: Theme = {
  bg: "#282828",
  panel: "#32302f",
  block: "#3c3836",
  text: "#ebdbb2",
  dim: "#a89984",
  faint: "#7c6f64",
  rule: "#504945",
  accent: "#83a598",
  mode: "#d3869b",
  ok: "#b8bb26",
  error: "#fb4934",
  warn: "#fabd2f",
  code: "#8ec07c",
  highlight: "#fabd2f",
  logoFrom: "#504945",
  logoTo: "#fbf1c7",
};

export const nordTheme: Theme = {
  bg: "#2e3440",
  panel: "#3b4252",
  block: "#434c5e",
  text: "#eceff4",
  dim: "#d8dee9",
  faint: "#7b88a1",
  rule: "#4c566a",
  accent: "#88c0d0",
  mode: "#b48ead",
  ok: "#a3be8c",
  error: "#bf616a",
  warn: "#ebcb8b",
  code: "#8fbcbb",
  highlight: "#d08770",
  logoFrom: "#4c566a",
  logoTo: "#eceff4",
};

export const draculaTheme: Theme = {
  bg: "#282a36",
  panel: "#343746",
  block: "#3b3f52",
  text: "#f8f8f2",
  dim: "#bdc3d1",
  faint: "#6272a4",
  rule: "#44475a",
  accent: "#bd93f9",
  mode: "#ff79c6",
  ok: "#50fa7b",
  error: "#ff5555",
  warn: "#f1fa8c",
  code: "#8be9fd",
  highlight: "#ffb86c",
  logoFrom: "#44475a",
  logoTo: "#f8f8f2",
};

export const catppuccinTheme: Theme = {
  bg: "#1e1e2e",
  panel: "#181825",
  block: "#313244",
  text: "#cdd6f4",
  dim: "#a6adc8",
  faint: "#6c7086",
  rule: "#45475a",
  accent: "#cba6f7",
  mode: "#89b4fa",
  ok: "#a6e3a1",
  error: "#f38ba8",
  warn: "#f9e2af",
  code: "#89dceb",
  highlight: "#fab387",
  logoFrom: "#45475a",
  logoTo: "#cdd6f4",
};

export const solarizedDarkTheme: Theme = {
  bg: "#002b36",
  panel: "#073642",
  block: "#0b3f4d",
  text: "#93a1a1",
  dim: "#839496",
  faint: "#586e75",
  rule: "#0f4c5c",
  accent: "#268bd2",
  mode: "#6c71c4",
  ok: "#859900",
  error: "#dc322f",
  warn: "#b58900",
  code: "#2aa198",
  highlight: "#cb4b16",
  logoFrom: "#586e75",
  logoTo: "#fdf6e3",
};

/** The Catppuccin light flavour, so the light half of the roster is not a corner. */
export const catppuccinLatteTheme: Theme = {
  bg: "#eff1f5",
  panel: "#e6e9ef",
  block: "#dce0e8",
  text: "#4c4f69",
  dim: "#5c5f77",
  faint: "#8c8fa1",
  rule: "#bcc0cc",
  accent: "#8839ef",
  mode: "#1e66f5",
  ok: "#40a02b",
  error: "#d20f39",
  warn: "#df8e1d",
  code: "#04a5e5",
  highlight: "#fe640b",
  logoFrom: "#bcc0cc",
  logoTo: "#4c4f69",
};

/** GitHub's light palette: a white page with a blue accent. */
export const githubLightTheme: Theme = {
  bg: "#ffffff",
  panel: "#f6f8fa",
  block: "#eaeef2",
  text: "#1f2328",
  dim: "#59636e",
  faint: "#818b98",
  rule: "#d0d7de",
  accent: "#0969da",
  mode: "#8250df",
  ok: "#1a7f37",
  error: "#cf222e",
  warn: "#9a6700",
  code: "#0550ae",
  highlight: "#953800",
  logoFrom: "#d0d7de",
  logoTo: "#1f2328",
};

export const solarizedLightTheme: Theme = {
  bg: "#fdf6e3",
  panel: "#eee8d5",
  block: "#f4eeda",
  text: "#586e75",
  dim: "#657b83",
  faint: "#93a1a1",
  rule: "#d9d2c0",
  accent: "#268bd2",
  mode: "#6c71c4",
  ok: "#859900",
  error: "#dc322f",
  warn: "#b58900",
  code: "#2aa198",
  highlight: "#cb4b16",
  logoFrom: "#d9d2c0",
  logoTo: "#002b36",
};

/**
 * No colour at all: greys only, for a terminal whose palette is being used for
 * something else (or one with no colour to speak of).
 *
 * The states are still told apart — by their glyph and their weight — which is
 * why `ok` and `error` are not the same grey: a `✓` in white and a `✕` in pale
 * grey is still a difference a person can see.
 */
export const monoTheme: Theme = {
  bg: "#0b0b0b",
  panel: "#161616",
  block: "#1f1f1f",
  text: "#e8e8e8",
  dim: "#b0b0b0",
  faint: "#767676",
  rule: "#3a3a3a",
  accent: "#ffffff",
  mode: "#ffffff",
  ok: "#e8e8e8",
  error: "#a0a0a0",
  warn: "#cfcfcf",
  code: "#dcdcdc",
  highlight: "#ffffff",
  logoFrom: "#3a3a3a",
  logoTo: "#ffffff",
};

/**
 * For a terminal read in poor light, or at a distance: maximum contrast on
 * black, with an accent bright enough to survive a washed-out screen.
 */
export const contrastTheme: Theme = {
  bg: "#000000",
  panel: "#101014",
  block: "#1a1a20",
  text: "#ffffff",
  dim: "#dcdce4",
  faint: "#a8a8b4",
  rule: "#6e6e80",
  accent: "#4fd1ff",
  mode: "#ffd400",
  ok: "#00ff88",
  error: "#ff5555",
  warn: "#ffd400",
  code: "#7dd3fc",
  highlight: "#ffd400",
  logoFrom: "#6e6e80",
  logoTo: "#ffffff",
};

/** Which half of the roster a theme belongs to, for the Color mode setting. */
export type ColorMode = "dark" | "light";

/**
 * Every theme, in the order `/themes` lists them. The first is the default.
 *
 * `mode` is not decoration: the Color mode setting steps the theme list within
 * one half of it, so a theme has to say which half it is in rather than have it
 * guessed from its name.
 */
export const THEMES: readonly { name: string; mode: ColorMode; theme: Theme }[] = [
  { name: "kicode", mode: "dark", theme: kicodeTheme },
  { name: "dark", mode: "dark", theme: darkTheme },
  { name: "light", mode: "light", theme: lightTheme },
  { name: "tokyo-night", mode: "dark", theme: tokyoNightTheme },
  { name: "gruvbox", mode: "dark", theme: gruvboxTheme },
  { name: "nord", mode: "dark", theme: nordTheme },
  { name: "dracula", mode: "dark", theme: draculaTheme },
  { name: "catppuccin", mode: "dark", theme: catppuccinTheme },
  { name: "catppuccin-latte", mode: "light", theme: catppuccinLatteTheme },
  { name: "github-light", mode: "light", theme: githubLightTheme },
  { name: "solarized-dark", mode: "dark", theme: solarizedDarkTheme },
  { name: "solarized-light", mode: "light", theme: solarizedLightTheme },
  { name: "mono", mode: "dark", theme: monoTheme },
  { name: "contrast", mode: "dark", theme: contrastTheme },
];

/** The theme a run starts with, and the one an unknown name falls back to. */
export const DEFAULT_THEME = "kicode";

/** The theme names, for a usage line or a picker. */
export function themeNames(): string[] {
  return THEMES.map((entry) => entry.name);
}

/**
 * Aliases for backwards compatibility or user muscle memory.
 * e.g. "opencode" maps to "kicode" so legacy configs do not produce a warning.
 */
export const THEME_ALIASES: Record<string, string> = {
  opencode: "kicode",
};

/** Resolves an alias to its canonical theme name, lowercase. */
export function canonicalThemeName(name: string): string {
  const lower = name.trim().toLowerCase();
  return THEME_ALIASES[lower] ?? name;
}

/** Whether a name is one of ours (or a known alias). An unknown name is reported, not guessed. */
export function isThemeName(name: string): boolean {
  const canonical = canonicalThemeName(name);
  return THEMES.some((entry) => entry.name === canonical);
}

/** The named theme, or the default when the name is unknown. */
export function themeByName(name: string): Theme {
  const canonical = canonicalThemeName(name);
  return THEMES.find((entry) => entry.name === canonical)?.theme ?? (THEMES[0]?.theme ?? darkTheme);
}

/** The theme names in one half of the roster, in listing order. */
export function themeNamesFor(mode: ColorMode): string[] {
  return THEMES.filter((entry) => entry.mode === mode).map((entry) => entry.name);
}

/** Which half a theme is in. An unknown name is treated as dark, like the default. */
export function themeMode(name: string): ColorMode {
  const canonical = canonicalThemeName(name);
  return THEMES.find((entry) => entry.name === canonical)?.mode ?? "dark";
}

/** Pre-rendered SGR prefixes, so producers never name a hex value. */
export type Styles = {
  text: string;
  dim: string;
  faint: string;
  accent: string;
  accentBold: string;
  ok: string;
  error: string;
  warn: string;
  code: string;
  bold: string;
  italic: string;
  underline: string;
  /** Emphasis inside prose: the word that matters in a sentence. */
  emphasis: string;
  /** The thin left rule that ties a run of tool output together. */
  rule: string;
  /** The build/plan word on the mode row. */
  mode: string;
  tabActive: string;
  tabInactive: string;
  tabHover: string;
  tabNew: string;
  tabNewHover: string;
  /** The close box inside a tab, muted against the tab's own background. */
  tabClose: string;
  tabCloseInactive: string;
  tabCloseHover: string;
  /** The highlighted row of the command palette. */
  paletteSelected: string;
  /** Text the user dragged over: accent fill, the palette's own selection language. */
  selection: string;
  hint: string;
  hintKey: string;
  panel: string;
  bg: string;
  /** Attached image chip in the input prompt (e.g. [Image 1]). */
  imageBadge: string;
  /** Visual chat badges and headers for GUI distinction */
  userBadge: string;
  userHeader: string;
  assistantHeader: string;
  assistantBadge: string;
  pillBorder: string;
  plusButton: string;
  thinkBadge: string;
};

export function buildStyles(theme: Theme): Styles {
  return {
    text: style(fg(theme.text)),
    dim: style(fg(theme.dim)),
    faint: style(fg(theme.faint)),
    accent: style(fg(theme.accent)),
    accentBold: style(fg(theme.accent), BOLD),
    ok: style(fg(theme.ok)),
    error: style(fg(theme.error)),
    warn: style(fg(theme.warn)),
    code: style(fg(theme.code)),
    bold: style(fg(theme.text), BOLD),
    italic: style(fg(theme.text), ITALIC),
    underline: style(fg(theme.text), UNDERLINE),
    emphasis: style(fg(theme.highlight), BOLD),
    rule: style(fg(theme.rule)),
    mode: style(fg(theme.mode)),
    tabActive: style(bg(theme.accent), fg(theme.bg), BOLD),
    tabInactive: style(bg(theme.panel), fg(theme.dim)),
    tabHover: style(bg(blend(theme.panel, theme.accent, 0.25)), fg(theme.text), BOLD),
    tabNew: style(bg(theme.panel), fg(theme.accent)),
    tabNewHover: style(bg(blend(theme.panel, theme.accent, 0.25)), fg(theme.accent), BOLD),
    // Kept inside the tab's own background, so the close box reads as part of
    // the tab rather than a hole in it.
    tabClose: style(bg(theme.accent), fg(blend(theme.accent, theme.bg, 0.3))),
    tabCloseInactive: style(bg(theme.panel), fg(theme.faint)),
    tabCloseHover: style(fg(theme.error), BOLD),
    paletteSelected: style(bg(theme.accent), fg(theme.bg), BOLD),
    // A selection is the palette's highlight applied to transcript text: always
    // visible regardless of the terminal's inverse-video handling, and the same
    // visual language everywhere — accent fill means "this is picked out".
    selection: style(bg(theme.accent), fg(theme.bg)),
    hint: style(fg(theme.faint)),
    hintKey: style(fg(theme.dim)),
    panel: style(fg(theme.text), DIM),
    bg: style(fg(theme.text)),
    imageBadge: style(fg(theme.highlight), BOLD),
    userBadge: style(bg(theme.accent), fg(theme.bg), BOLD),
    userHeader: style(fg(theme.accent), BOLD),
    assistantHeader: style(fg(theme.code), BOLD),
    assistantBadge: style(bg(theme.panel), fg(theme.accent), BOLD),
    pillBorder: style(fg(theme.rule)),
    plusButton: style(fg(theme.accent), BOLD),
    thinkBadge: style(fg(theme.highlight)),
  };
}

/** Linear blend between two hex colours, quantised so the banding is visible. */
export function blend(from: string, to: string, ratio: number, steps = 6): string {
  const mix = (hex: string): [number, number, number] => {
    const value = Number.parseInt(hex.replace("#", ""), 16);
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  };

  const [r1, g1, b1] = mix(from);
  const [r2, g2, b2] = mix(to);
  const step = Math.round(ratio * (steps - 1)) / Math.max(steps - 1, 1);

  const channel = (a: number, b: number): string =>
    Math.round(a + (b - a) * step)
      .toString(16)
      .padStart(2, "0");

  return `#${channel(r1, r2)}${channel(g1, g2)}${channel(b1, b2)}`;
}
