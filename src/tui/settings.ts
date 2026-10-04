import { isThemeName, themeMode, themeNames, themeNamesFor } from "./theme";
/**
 * What the screen shows, as one value.
 *
 * These are preferences about the *display*, not about what the agent may do —
 * build/plan mode is a capability and lives in the session. Every row here has
 * a backing effect (listed beside it below); a setting that changed nothing
 * would be a lie told by a menu, so there are none.
 *
 * The values are strings rather than booleans on purpose: they are written to
 * `kicode.json` verbatim, and `"hide"` reads better in a config file than
 * `false` does next to a key called `thinking`.
 */
export type OnOff = "on" | "off";

/**
 * How much air the layout leaves between things.
 *
 * Numbers rather than a `compact`/`cozy`/`airy` preset, because a preset is
 * only ever somebody else's numbers — and because these are the two things
 * people disagree about most, so the honest control is the number itself. They
 * live in `kicode.json`, which means picking a density is an edit and a
 * restart rather than a rebuild.
 */
export type Spacing = {
  /** Rows of padding above and below the text inside a request block. */
  block: number;
  /** Blank rows between two entries. */
  entry: number;
  /** The extra rows on either side of a request, where the turn turns over. */
  turn: number;
};

/** The keys of `spacing`, in the order the documents name them. */
export const SPACING_KEYS = ["block", "entry", "turn"] as const;

/**
 * The layout as shipped: a five-row request block, and room to breathe.
 *
 * Three is the ceiling. Past that a request is mostly margin, and the setting
 * has stopped being about density and become a way to scroll a screen that has
 * nothing on it.
 */
export const DEFAULT_SPACING: Spacing = { block: 2, entry: 1, turn: 1 };
export const MAX_SPACING = 3;

export type ViewSettings = {
  /** The colour theme by name. `/themes` offers the same list. */
  theme: string;
  /** Which half of the theme list `theme` is chosen from. */
  colorMode: "dark" | "light";
  /** The spinner and the 30ms repaint while a turn runs. */
  animations: OnOff;
  /** The tab bar: `auto` shows it only when there is another session. */
  sidebar: "auto" | OnOff;
  /** A scrollbar down the right edge when the transcript is taller than the view. */
  scrollbar: OnOff;
  /** The model's reasoning: `show` prints it, `hide` drops it entirely. */
  thinking: "show" | "hide";
  /** Answers as markdown, or exactly as the model typed them. */
  markdown: "rendered" | "raw";
  /** `auto` keeps a tool call and its result as one run. */
  toolGrouping: "auto" | "off";
  /** How much of a tool's output is printed. */
  verbosity: "low" | "medium" | "high";
  /** The `[n images]` marker on a request that carried pictures. */
  transcriptImages: OnOff;
  /** The line under each answer: `Build · model · 3.9s · 17.7 tok/s`. */
  tps: OnOff;
  /** How much white space the transcript is spaced out with. */
  spacing: Spacing;
};

/**
 * What a config file — or a caller — may declare.
 *
 * `spacing` is partial so one of its numbers can be set without repeating the
 * other two: a file that says `{ "spacing": { "block": 0 } }` means "no
 * padding inside a request block", not "and the two gaps are zero".
 */
export type ViewOverrides = Partial<Omit<ViewSettings, "spacing">> & { spacing?: Partial<Spacing> };

/** One row of the settings panel. */
export type SettingDef = {
  id: SettingId;
  group: string;
  label: string;
  /** The values it cycles through, in order. */
  options: readonly string[];
  /** What the row actually changes, shown under the list. */
  description: string;
};

/**
 * A row id: a top-level setting, or one of the three spacing numbers as
 * `spacing.block` and friends. The panel speaks in single values, so the
 * nested object arrives as three rows rather than one it cannot step.
 */
export type SettingId = keyof ViewSettings | `spacing.${(typeof SPACING_KEYS)[number]}`;

/** The numbers a spacing row steps through: none, up to the ceiling. */
const SPACING_OPTIONS = Array.from({ length: MAX_SPACING + 1 }, (_, index) => String(index));

/** The value a row shows, whatever shape its setting is stored in. */
export function settingValue(view: ViewSettings, id: SettingId): string {
  if (id.startsWith("spacing.")) {
    const key = id.slice("spacing.".length);
    if (key === "block" || key === "entry" || key === "turn") return String(view.spacing[key]);
    return "";
  }
  return String(view[id as keyof ViewSettings]);
}

/**
 * A view with one row's value adopted — a full spacing object when the row is
 * one of its numbers, so a write never stores two of the three and drops the
 * third. Out-of-range numbers clamp; an unknown row or a non-number leaves
 * the view untouched, so no patch (and no write) follows.
 */
export function setSettingValue(view: ViewSettings, id: SettingId, value: string): ViewSettings {
  if (!id.startsWith("spacing.")) return { ...view, [id]: value } as ViewSettings;
  const key = id.slice("spacing.".length);
  if (key !== "block" && key !== "entry" && key !== "turn") return view;
  const parsed = Number.parseInt(value, 10);
  const next = Number.isNaN(parsed) ? view.spacing[key] : Math.min(Math.max(parsed, 0), MAX_SPACING);
  if (next === view.spacing[key]) return view;
  return { ...view, spacing: { ...view.spacing, [key]: next } };
}

/** Rows in the order the panel draws them. */
export const SETTINGS_GROUPS = ["Appearance", "Session", "Spacing"] as const;

/**
 * A shortcut row at the top of the settings panel: a door, not a value.
 *
 * Settings are stepped in place; these leave the panel for the screen that
 * owns the thing — the model list, the session list, the connect menu. The
 * `shortcut:` prefix keeps their ids from ever colliding with a SettingId, so
 * a value lookup can never mistake one for a setting.
 */
export type SettingShortcut = {
  id: string;
  label: string;
  description: string;
};

/** The doors, in the order the panel draws them — most reached-for first. */
export const SETTING_SHORTCUTS: readonly SettingShortcut[] = [
  {
    id: "shortcut:connect",
    label: "Connect / Provider",
    description: "Add an endpoint KiCode can reach, or switch to one.",
  },
  {
    id: "shortcut:models",
    label: "Models",
    description: "Pick a model — choosing one chooses its endpoint too.",
  },
  {
    id: "shortcut:sessions",
    label: "Sessions",
    description: "Switch to another session in this directory.",
  },
  {
    id: "shortcut:compact",
    label: "Compact",
    description: "Compact the transcript now, not when the window fills.",
  },
  {
    id: "shortcut:skills",
    label: "Skills",
    description: "Browse the brain's skills, and use one as @skill:.",
  },
  {
    id: "shortcut:tools",
    label: "Tools",
    description: "What this session can call — names and one line each.",
  },
  {
    id: "shortcut:mcp",
    label: "MCP",
    description: "Which MCP servers are connected for this project.",
  },
];

/** Shortcut rows matching what has been typed, in panel order. */
export function filterShortcuts(query: string): SettingShortcut[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...SETTING_SHORTCUTS];
  return SETTING_SHORTCUTS.filter((shortcut) =>
    `${shortcut.label} ${shortcut.description}`.toLowerCase().includes(needle),
  );
}

export function defaultViewSettings(): ViewSettings {
  return {
    theme: themeNames()[0] ?? "kicode",
    colorMode: "dark",
    animations: "on",
    sidebar: "on",
    scrollbar: "on",
    thinking: "show",
    markdown: "rendered",
    toolGrouping: "auto",
    verbosity: "medium",
    transcriptImages: "on",
    tps: "on",
    // A copy, so a caller that edits what it was handed cannot edit the default
    // for every other screen in the process.
    spacing: { ...DEFAULT_SPACING },
  };
}

/**
 * The rows, with the current value of each.
 *
 * The theme's options are the themes of the current colour mode, so switching
 * colour mode narrows the list rather than offering a dark theme while the
 * screen is set to light.
 */
export function settingDefs(view: ViewSettings): SettingDef[] {
  return [
    {
      id: "theme",
      group: "Appearance",
      label: "Theme",
      options: themeNamesFor(view.colorMode),
      description: "Colours for the whole screen. /themes previews each one.",
    },
    {
      id: "colorMode",
      group: "Appearance",
      label: "Color mode",
      options: ["dark", "light"],
      description: "Which half of the theme list Theme steps through.",
    },
    {
      id: "animations",
      group: "Appearance",
      label: "Animations",
      options: ["on", "off"],
      description: "The working spinner, and the repaint that advances it.",
    },
    {
      id: "sidebar",
      group: "Session",
      label: "Sidebar",
      options: ["auto", "on", "off"],
      description: "The session tab bar. Auto shows it once a second session exists.",
    },
    {
      id: "scrollbar",
      group: "Session",
      label: "Scrollbar",
      options: ["on", "off"],
      description: "A bar down the right edge when there is more text than fits.",
    },
    {
      id: "thinking",
      group: "Session",
      label: "Thinking",
      options: ["show", "hide"],
      description: "The model's own reasoning, when the endpoint sends any.",
    },
    {
      id: "markdown",
      group: "Session",
      label: "Markdown",
      options: ["rendered", "raw"],
      description: "Answers rendered, or printed exactly as the model typed them.",
    },
    {
      id: "toolGrouping",
      group: "Session",
      label: "Tool grouping",
      options: ["auto", "off"],
      description: "Auto ties a tool call to its result with one left rule.",
    },
    {
      id: "verbosity",
      group: "Session",
      label: "Verbosity",
      options: ["low", "medium", "high"],
      description: "How much of a tool's output is printed under it.",
    },
    {
      id: "transcriptImages",
      group: "Session",
      label: "Transcript images",
      options: ["on", "off"],
      description: "The [n images] marker on a request that carried pictures.",
    },
    {
      id: "tps",
      group: "Session",
      label: "TPS",
      options: ["on", "off"],
      description: "The line under each answer: mode, model, time and tokens a second.",
    },
    {
      id: "spacing.block",
      group: "Spacing",
      label: "Request padding",
      options: SPACING_OPTIONS,
      description: "Rows of padding above and below the text inside a request block.",
    },
    {
      id: "spacing.entry",
      group: "Spacing",
      label: "Entry gap",
      options: SPACING_OPTIONS,
      description: "Blank rows between two entries.",
    },
    {
      id: "spacing.turn",
      group: "Spacing",
      label: "Turn gap",
      options: SPACING_OPTIONS,
      description: "The extra rows on either side of a request, where the turn turns over.",
    },
  ];
}

/** The rows in a fixed order, for a caller that has no settings yet. */
export function settingOptions(id: string): readonly string[] {
  return settingDefs(defaultViewSettings()).find((def) => def.id === id)?.options ?? [];
}

/** The settings a config file may name, other than the theme. */
export const SETTING_KEYS: readonly (keyof ViewSettings)[] = [
  "colorMode",
  "animations",
  "sidebar",
  "scrollbar",
  "thinking",
  "markdown",
  "toolGrouping",
  "verbosity",
  "transcriptImages",
  "tps",
];

/**
 * A full set of view settings, given a theme and whatever a file declared.
 *
 * The colour mode follows the theme rather than being taken from the file on
 * its own: the two have to agree, and the theme is the one that decides what
 * the screen actually looks like. `colorMode` is then only a way to ask for a
 * light theme without naming one.
 */
export function viewFrom(theme: string, declared: ViewOverrides = {}): ViewSettings {
  const view = {
    ...defaultViewSettings(),
    ...declared,
    // Merged rather than replaced: `spacing` is three settings wearing one
    // name, and a file that names one of them is not asking for 0 in the other
    // two simply by not mentioning them.
    spacing: { ...DEFAULT_SPACING, ...declared.spacing },
  };
  const named = isThemeName(theme) ? theme : (themeNamesFor(declared.colorMode ?? "dark")[0] ?? view.theme);
  return { ...view, theme: named, colorMode: themeMode(named) };
}

/** The next value of a row, wrapping round at either end. */
export function cycleValue(def: SettingDef, current: string, delta: number): string {
  const at = def.options.indexOf(current);
  const count = def.options.length;
  if (count === 0) return current;
  // A value that is not one of ours is not a position, so both directions land
  // on the first option: a config file naming something we no longer have can
  // still be stepped away from, and it steps away from it the same way either way.
  if (at < 0) return def.options[0] ?? current;
  return def.options[(((at + delta) % count) + count) % count] ?? current;
}

/**
 * Steps one setting, returning the whole set back.
 *
 *
 * Colour mode carries an extra rule: moving to a mode the current theme does
 * not belong to would leave the row saying `light` while the screen is dark, so
 * the theme moves to the first one of that mode. That is the only setting that
 * touches another, and it is why this returns the set rather than a value.
 */
export function stepSetting(view: ViewSettings, id: SettingId, delta: number): ViewSettings {
  const def = settingDefs(view).find((entry) => entry.id === id);
  if (!def) return view;

  const value = cycleValue(def, settingValue(view, def.id), delta);
  if (def.id !== "colorMode") return setSettingValue(view, def.id, value);

  const mode = value === "light" ? "light" : "dark";
  const theme = themeMode(view.theme) === mode ? view.theme : (themeNamesFor(mode)[0] ?? view.theme);
  return { ...view, colorMode: mode, theme };
}

/** Rows whose label, group, value or effect matches what has been typed. */
export function filterSettings(defs: readonly SettingDef[], view: ViewSettings, query: string): SettingDef[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...defs];
  return defs.filter((def) =>
    `${def.label} ${def.group} ${settingValue(view, def.id)} ${def.description}`.toLowerCase().includes(needle),
  );
}
