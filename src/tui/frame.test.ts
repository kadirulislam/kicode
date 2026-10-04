import { describe, expect, it } from "vitest";
import type { SubagentView } from "../agent/tools/types";
import { bg, textWidth } from "./ansi";
import { EDITOR_MAX_ROWS, LineEditor } from "./editor";
import { COMMANDS } from "./commands";
import {
  NEW_TAB,
  PLACEHOLDER,
  TAB_CLOSE,
  filterPickItems,
  nextMode,
  renderFrame,
  stepPick,
  type AskPanel,
  type Modal as ApprovalModal,
  type Size,
  type TuiState,
  type Picker,
} from "./frame";
import type { PlanSnapshot } from "../agent/tools/types";
import { defaultViewSettings, type Spacing } from "./settings";
import { buildStyles, darkTheme } from "./theme";
import type { Entry } from "./transcript";

const styles = buildStyles(darkTheme);
const theme = darkTheme;

/**
 * The selected palette row's fill, as the escape sequence carries it.
 *
 * The palette fills the whole selected row rather than colouring the text, so
 * "is this row selected" is a question about the background, not about the text
 * style — which is why it is named once here instead of repeated as a literal.
 */
const ACCENT_BG = "48;2;45;212;191";

/**
 * The tab bar is a setting, and `auto` keeps its row for the transcript while
 * there is one session — so the tests that are about the tabs ask for it.
 */
const withTabs = { ...defaultViewSettings(), sidebar: "on" } as const;

/** Every escape sequence, not just colour — `ERASE_TO_EOL` is a sequence too. */
const strip = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

function state(over: Partial<TuiState> = {}): TuiState {
  return {
    tabs: [{ id: "s1", title: "new session", current: true }],
    entries: [],
    editor: new LineEditor(),
    busy: null,
    spinnerFrame: 0,
    model: "deepseek-v4-flash:free",
    messageCount: 0,
    compacting: true,
    cwd: "C:\\dev\\projects\\kicode",
    version: "0.1.0",
    mcp: null,
    config: null,
    notice: null,
    modal: null,
    palette: null,
    ask: null,
    askTyping: false,
    picker: null,
    variant: "default",
    mode: "build",
    usage: { tokens: 0, budget: 128_000, tools: 0 },
    scroll: 0,
    anchor: null,
    settings: withTabs,
    ...over,
  };
}

function draw(over: Partial<TuiState> = {}, size: Size = { cols: 80, rows: 24 }) {
  const frame = renderFrame(state(over), size, styles, theme);
  return { frame, plain: frame.lines.map((line) => strip(line)) };
}

const conversation: Entry[] = [
  { kind: "user", text: "why is the build failing?" },
  { kind: "assistant", text: "Because **src/config.ts** is missing a default." },
];

/**
 * A permission card, whole.
 *
 * The card names its own three answers; escape and ctrl+c stay in the footer,
 * which is the part of the decision it does not offer as a chip.
 */
const permission = (over: Partial<ApprovalModal> = {}): ApprovalModal => ({
  title: "bash wants to run",
  body: [],
  question: "allow?",
  choices: [
    { key: "y", label: "yes" },
    { key: "a", label: "always" },
    { key: "n", label: "no" },
  ],
  footer: [
    ["esc", "deny"],
    ["ctrl+c", "deny + stop"],
  ],
  ...over,
});

describe("frame geometry", () => {
  it("fills exactly the rows it is given", () => {
    for (const rows of [24, 12, 8, 6]) {
      expect(draw({}, { cols: 80, rows }).frame.lines).toHaveLength(rows);
    }
  });

  it("keeps a modal's centering offset on the page background", () => {
    // Same smear as the menu card had: the offset left of a centered box must
    // not wear the modal fill to the screen's left edge.
    const { frame } = draw({ modal: permission() }, { cols: 160, rows: 30 });
    const raw = frame.lines.find((line) => strip(line).includes("allow?")) ?? "";
    const pageAt = raw.indexOf(bg(theme.bg));
    expect(pageAt).toBeGreaterThanOrEqual(0);
    expect(pageAt).toBeLessThan(raw.indexOf("allow?"));
  });

  it("never draws into the last column", () => {
    // Writing the final cell can make the terminal wrap and scroll, which would
    // shift the whole UI by a row.
    const { plain } = draw({ modal: permission({ title: "x".repeat(200), choices: [{ key: "y", label: "y".repeat(200) }] }) });

    for (const line of plain) expect(textWidth(line)).toBeLessThanOrEqual(79);
  });

  it("cannot be scrolled by the text it is showing", () => {
    // A tab is one cell in the maths and several on screen, and an escape
    // sequence could move the cursor outright. Either overruns the row, and an
    // overrun row wraps — which shifts the entire frame up by a line. The text
    // in a permission prompt is a file's contents, so it is the text least
    // under KiCode's control.
    const { frame, plain } = draw({
      modal: permission({
        title: "edit wants to run",
        body: [{ text: "edit src/a.ts" }, { text: "\n-\tconst a = 1;\u001b[2J\u001b[H" }],
      }),
    });

    for (const line of plain) {
      expect(textWidth(line)).toBeLessThanOrEqual(79);
      expect(line).not.toContain("\t");
      expect(line).not.toContain("\r");
      expect(line).not.toContain("\u001b");
    }
    // The erase sequence must not survive into what is written to the terminal.
    for (const line of frame.lines) expect(line).not.toContain("\u001b[2J");
  });

  it("survives a terminal too small for the chrome", () => {
    expect(() => draw({}, { cols: 20, rows: 6 })).not.toThrow();
    expect(draw({}, { cols: 20, rows: 6 }).frame.lines).toHaveLength(6);
  });

  it("keeps the tab bar on the first row", () => {
    const { plain } = draw({ tabs: [{ id: "s1", title: "build failure", current: true }] });

    expect(plain[0]).toContain("build failure");
    expect(plain[0]).toContain(NEW_TAB);
  });

  it("reports the caret inside the input row", () => {
    const editor = new LineEditor();
    editor.insert("hello");
    const { frame } = draw({ editor });

    expect(frame.caret).not.toBeNull();
    // Rows from the bottom: footer, the state row, two rows of the box's own
    // fill, then the input — the box carries its air below the text. The tab bar
    // above the transcript pushes everything down one row, and the caret has to
    // move with it or the cursor lands on the state row instead of the input.
    expect(frame.caret?.row).toBe(24 - 4);
    expect(frame.caret?.col).toBeLessThan(80);
  });

  it("paints a mouse drag with the accent selection fill, not inverse video", () => {
    // Inverse video is invisible on some terminals; the palette's accent fill
    // is not, and it is the same language the UI already uses for "picked out".
    // The prompt input sits on screen row 20 of a 24-row frame; the drag spans
    // "hello" (cols 8-13), which the highlight splits into its own styled run.
    const editor = new LineEditor();
    editor.insert("hello world");
    const { frame, plain } = draw({ editor, selection: { from: { row: 20, col: 8 }, to: { row: 20, col: 13 } } });
    // The highlight splits "hello" mid-word into styled runs, so the styled
    // line itself does not contain the whole word — locate the row by its
    // ANSI-stripped text instead.
    const idx = plain.findIndex((line) => line.includes("hello"));
    expect(idx).toBeGreaterThanOrEqual(0);
    const row = frame.lines[idx] ?? "";

    expect(row).toContain(styles.selection);
    // No row of the frame falls back to the terminal's inverse video.
    for (const line of frame.lines) expect(line).not.toContain("\u001b[7m");
  });

  it("hides the caret while a modal owns the keyboard", () => {
    const { frame } = draw({ modal: permission() });

    expect(frame.caret).toBeNull();
  });
});

describe("the tab bar", () => {
  const tabs = [
    { id: "s1", title: "new session", current: true },
    { id: "s2", title: "build failure", current: false },
  ];

  it("gives every tab a close box, and the new-tab button a place of its own", () => {
    expect(draw({ tabs }).plain[0]).toBe(` new session  ${TAB_CLOSE}   build failure  ${TAB_CLOSE}  ${NEW_TAB}`);
  });

  it("records where each tab and its close box are", () => {
    const { frame } = draw({ tabs });

    // A press before `closeStart` switches tab; at or after it, closes one.
    expect(frame.tabs[0]).toEqual({ id: "s1", start: 0, closeStart: 14, end: 17 });
    expect(frame.tabs[1]).toEqual({ id: "s2", start: 17, closeStart: 33, end: 36 });
    expect(frame.tabs[2]).toEqual({ id: NEW_TAB, start: 36, closeStart: 36, end: 40 });
  });

  it("draws the close box in the tab's own background", () => {
    const { frame } = draw({ tabs });
    const row = frame.lines[0] ?? "";

    // Two close boxes, one in each tab's colour.
    expect(row).toContain(styles.tabClose);
    expect(row).toContain(styles.tabCloseInactive);
  });

  it("cuts a long title rather than pushing the other tabs off the row", () => {
    const long = [{ id: "s1", title: "a-very-long-session-name-indeed", current: true }];
    const { plain, frame } = draw({ tabs: long });

    expect(plain[0]).toContain("…");
    // 18 cells of title, a space before it and two before the close box.
    expect(frame.tabs[0]?.closeStart).toBe(21);
  });

  it("keeps a following tab reachable whatever it is called", () => {
    const { plain } = draw({
      tabs: [
        { id: "s1", title: "x".repeat(60), current: true },
        { id: "s2", title: "second", current: false },
      ],
    });

    expect(plain[0]).toContain("second");
  });
});

describe("the home screen", () => {
  it("shows the wordmark, the model and the version", () => {
    const text = draw().plain.join("\n");

    expect(text).toContain("█");
    expect(text).toContain("deepseek-v4-flash:free");
    expect(text).toContain("v0.1.0");
    expect(text).toContain("/help");
  });

  it("centres the wordmark", () => {
    const logoRows = draw().plain.filter((line) => line.includes("█"));
    const starts = logoRows.map((line) => line.indexOf("█"));

    expect(logoRows).toHaveLength(5);
    expect(new Set(starts).size).toBe(1);
  });

  it("lists connected MCP servers when there are any", () => {
    expect(draw({ mcp: "docs, remote" }).plain.join("\n")).toContain("MCP: docs, remote");
  });

  it("names the config files it read", () => {
    // So "why is it using that model" is answerable without leaving the UI.
    expect(draw({ config: "C:\\Users\\me\\.kicode\\kicode.json" }).plain.join("\n")).toContain("config: C:\\Users");
  });

  it("compresses the wordmark's air rather than cutting the MCP and config lines", () => {
    // Twenty-two rows leave eleven for the page while the block wants fifteen:
    // the four blank separators go, and every content row survives.
    const text = draw(
      { mcp: "docs, remote", config: "C:\\Users\\me\\.kicode\\kicode.json" },
      { cols: 80, rows: 22 },
    ).plain.join("\n");

    expect(text).toContain("MCP: docs, remote");
    expect(text).toContain("config: C:\\Users");
  });
});

describe("the transcript", () => {
  it("replaces the wordmark once there is a conversation", () => {
    const text = draw({ entries: conversation }).plain.join("\n");

    expect(text).toContain("why is the build failing?");
    // The prompt's placeholder stays — only the wordmark gives way.
    expect(text).not.toContain("/models to choose a model");
    expect(text).not.toContain("█");
  });

  it("sits above the prompt box, with the box's own rows below it", () => {
    const { frame, plain } = draw({ entries: conversation });

    // Under the rule: two rows of the box's fill, the text, then two more. The
    // fill is the whole of what says where the box starts — there is no bar in
    // it to draw the edge.
    const rule = plain.findIndex((line) => line.includes("─"));
    expect(plain[rule - 1]).toContain("missing a default");
    expect(plain[rule + 1]?.trim()).toBe("");
    expect(plain[rule + 2]?.trim()).toBe("");
    expect(plain[rule + 3]).toContain(PLACEHOLDER);
    for (const row of [1, 2, 3, 4, 5]) expect(frame.lines[rule + row]).toContain(bg(theme.input));
  });

  it("pins the newest line to the bottom when the history is longer than the screen", () => {
    const long: Entry[] = Array.from({ length: 60 }, (_, index) => ({
      kind: "user" as const,
      text: `question number ${index}`,
    }));

    const { plain } = draw({ entries: long });

    expect(plain.join("\n")).toContain("question number 59");
    expect(plain.join("\n")).not.toContain("question number 0");
  });

  it("scrolls back to the start, and clamps a scroll past it", () => {
    const long: Entry[] = Array.from({ length: 60 }, (_, index) => ({
      kind: "user" as const,
      text: `question number ${index}`,
    }));

    // Far more than the transcript holds, so this also proves the clamp.
    const text = draw({ entries: long, scroll: 500 }).plain.join("\n");

    expect(text).toContain("question number 0");
    expect(text).not.toContain("question number 59");
  });

  it("wraps rather than overflowing", () => {
    const words = Array.from({ length: 60 }, () => "word").join(" ");
    const { plain } = draw({ entries: [{ kind: "assistant", text: words }] });

    for (const line of plain) expect(textWidth(line)).toBeLessThanOrEqual(79);
  });

  it("hard-breaks a single token longer than the pane", () => {
    const { plain } = draw({ entries: [{ kind: "assistant", text: "x".repeat(500) }] });

    for (const line of plain) expect(textWidth(line)).toBeLessThanOrEqual(79);
  });

  it("renders markdown instead of showing its punctuation", () => {
    const text = draw({ entries: conversation }).plain.join("\n");

    expect(text).toContain("src/config.ts");
    expect(text).not.toContain("**");
  });

  it("offers a clipped tool result as a click target, by entry index", () => {
    const entries: Entry[] = [
      { kind: "user", text: "go" },
      { kind: "tool", name: "read", args: { file_path: "src/app.ts" } },
      { kind: "result", name: "read", content: "line one\nline two\nline three", isError: false },
    ];
    const { frame } = draw({ entries });

    const hits = frame.rows.filter((row) => row.kind === "result");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.index === 2)).toBe(true);
  });

  it("leaves a short tool result with no click target", () => {
    const entries: Entry[] = [{ kind: "result", name: "read", content: "ok", isError: false }];
    const { frame } = draw({ entries });

    expect(frame.rows.some((row) => row.kind === "result")).toBe(false);
  });
});

describe("the bottom bar", () => {
  it("names the mode in the pill, and the model and the variant on the state row", () => {
    const lines = draw({ model: "gpt-5.6-luna", variant: "high" }).plain;
    // The last row naming the model: the transcript's header names it too, and
    // the state row is the one under the box.
    const row = lines.findLastIndex((line) => line.includes("gpt-5.6-luna"));

    // No bar in front of it: the row is inside the input box, and the box's own
    // fill is what marks it out. The mode is not here — it is the pill in the
    // box above, which is a button now, and a row that said it again would
    // spend a line on a word the eye has already been given.
    // The `[USAGE]` chip rides the row's right end, so the words lead it.
    expect(lines[row]?.trimStart().startsWith("gpt-5.6-luna · high")).toBe(true);
    expect(lines[row]).toContain("[USAGE]");
    // The pill is on the row being typed into, at its left, where the words
    // will start once there are some.
    expect(lines[row - 3]).toContain("[BUILD]");
    expect(lines[row - 3]).toContain(PLACEHOLDER);
  });

  it("shows a spinner while a turn is in flight", () => {
    const text = draw({ busy: "read…", spinnerFrame: 3 }).plain.join("\n");

    expect(text).toContain("read…");
    expect(text).not.toContain("gpt");
  });

  it("shows a transient notice in place of the model", () => {
    expect(draw({ notice: { text: "denied", style: "" } }).plain.join("\n")).toContain("denied");
  });

  it("puts the directory, the usage and the one key on the last row", () => {
    const { plain } = draw({ cwd: "C:\\dev\\kicode", usage: { tokens: 304_800, budget: 1_048_576, tools: 4 } });
    const footer = plain.at(-1) ?? "";

    // The settings glyph trails the row past the usage numbers.
    expect(footer).toContain("⚙");
    expect(footer).not.toContain("[⚙]");
    // The path starts in the same gutter the prompt box and the state row
    // keep — one left edge for the whole bottom block, not two.
    expect(footer.startsWith("    C:\\dev\\kicode")).toBe(true);
    expect(footer).toContain("C:\\dev\\kicode");
    expect(footer).toContain("↓ 4 tools");
    expect(footer).toContain("304.8K");
    expect(footer).toContain("(29%)");
    expect(footer.indexOf("⚙")).toBeGreaterThan(footer.indexOf("304.8K"));
    expect(footer).not.toContain("ctrl+p");
  });

  it("says nothing about usage before anything is spent", () => {
    const footer = draw({ usage: { tokens: 0, budget: 128_000, tools: 0 } }).plain.at(-1) ?? "";

    expect(footer).not.toContain("ctrl+p");
    expect(footer).not.toContain("%");
  });

  it("counts a single tool in the singular", () => {
    expect(draw({ usage: { tokens: 900, budget: 128_000, tools: 1 } }).plain.at(-1)).toContain("↓ 1 tool ·");
    expect(draw({ usage: { tokens: 900, budget: 128_000, tools: 1 } }).plain.at(-1)).toContain("900");
  });

  it("keeps the path when the terminal is too narrow for the numbers", () => {
    const { plain } = draw({ cwd: "C:\\dev\\kicode", usage: { tokens: 304_800, budget: 1_048_576, tools: 4 } }, { cols: 34, rows: 24 });
    const footer = plain.at(-1) ?? "";

    // The path is shortened last: a percentage is not recognisable from a
    // fragment, and a path is.
    expect(footer).toContain("kicode");
    expect(textWidth(footer)).toBeLessThanOrEqual(33);
  });
});

describe("the command palette", () => {
  const items = COMMANDS.slice(0, 3);
  const palette = { items, selected: 1 };

  it("lists each command with its description in a fixed column", () => {
    const lines = draw({ palette }).plain;
    const rows = items.map((item) => lines.find((line) => line.includes(`/${item.name}`)) ?? "");

    expect(rows[0]).toContain(`/${items[0]?.name}`);
    expect(rows[1]).toContain(items[1]?.description.slice(0, 12) ?? "");

    // The description column starts in the same place on every row, so the
    // list reads down as two columns rather than a ragged block.
    const columns = items.map((item, index) => rows[index]?.indexOf(item.description.slice(0, 6)) ?? -1);
    expect(new Set(columns).size).toBe(1);
    expect(columns[0]).toBeGreaterThan(0);
  });

  it("stays inside the terminal width", () => {
    for (const line of draw({ palette }, { cols: 60, rows: 24 }).plain) {
      expect(textWidth(line)).toBeLessThanOrEqual(59);
    }
  });

  it("fills the selected row right across", () => {
    const short = [
      { name: "help", description: "Help" },
      { name: "exit", description: "Exit the app" },
    ];
    const { frame } = draw({ palette: { items: short, selected: 0 } });
    // The last match: the home screen mentions `/help` too.
    const row = frame.lines.filter((line) => line.includes("/help")).at(-1) ?? "";

    // The name, the description, and the padding that carries the fill to the
    // right-hand edge of the row.
    expect((row.match(/48;2;45;212;191/g) ?? []).length).toBe(3);
  });

  it("dims the names that cannot run here", () => {
    // An explicit list rather than the whole catalogue: the window follows the
    // selection, so a gated command far down the real list would not be on
    // screen to be measured.
    const short = [
      { name: "budget", description: "Show the token budget" },
      { name: "plugins", description: "Plugins", unavailable: "nothing behind it" },
      { name: "sessions", description: "Other sessions" },
    ];
    const { frame, plain } = draw({ palette: { items: short, selected: 0 } });
    const plugins = plain.findIndex((line) => line.includes("/plugins"));

    expect(plugins).toBeGreaterThan(-1);
    // It exists in the list but cannot run, so it reads as dimmed rather than as
    // something to press.
    expect(frame.lines[plugins]).toContain(styles.faint);
    expect(frame.lines[plugins]).not.toContain(styles.accent);
    // The selected row carries the accent highlight; the dimmed row carries neither
    // the highlight nor the accent text.
    expect(frame.lines[plain.findIndex((line) => line.includes("/budget"))]).toContain(ACCENT_BG);
    expect(frame.lines[plain.findIndex((line) => line.includes("/sessions"))]).not.toContain(ACCENT_BG);
  });

  it("leaves unselected rows on the panel background", () => {
    const { frame } = draw({ palette });
    const row = frame.lines.find((line) => line.includes(`/${items[0]?.name}`)) ?? "";

    expect(row).not.toContain(ACCENT_BG);
  });

  it("says so when nothing matches", () => {
    expect(draw({ palette: { items: [], selected: 0 } }).plain.join("\n")).toContain("no matching command");
  });

  it("keeps the prompt visible underneath", () => {
    expect(draw({ palette }).plain.join("\n")).toContain(PLACEHOLDER.slice(0, 12));
  });

  it("never squeezes the footer out of a short terminal", () => {
    const { plain, frame } = draw({ palette }, { cols: 80, rows: 12 });

    expect(frame.lines).toHaveLength(12);
    expect(plain.at(-1)).toContain("kicode");
  });

  it("windows a list too long for the room around the selection", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ name: `cmd${index}`, description: `does thing ${index}` }));
    const text = draw({ palette: { items: many, selected: 19 } }, { cols: 80, rows: 20 }).plain.join("\n");

    // The selection is on screen…
    expect(text).toContain("/cmd19");
    // …and the list has scrolled, rather than being cut off at the bottom.
    expect(text).not.toContain("/cmd0 ");
  });

  it("shows every command when they all fit", () => {
    const text = draw({ palette: { items: COMMANDS, selected: 0 } }, { cols: 80, rows: COMMANDS.length + 8 }).plain.join("\n");

    for (const command of COMMANDS) expect(text).toContain(`/${command.name}`);
  });
});

describe("the picker", () => {
  const picker = {
    title: "Select model",
    query: "",
    items: [
      { label: "deepseek-v4-flash:free", description: "low", trailing: "FREE", value: "deepseek-v4-flash:free", group: "api.example.com" },
      { label: "glm-5.3", trailing: "paid", value: "glm-5.3" },
    ],
    selected: 1,
  };

  it("shows the title, the rows and the group heading", () => {
    const text = draw({ picker }).plain.join("\n");

    expect(text).toContain("Select model");
    expect(text).toContain("deepseek-v4-flash:free");
    expect(text).toContain("FREE");
    expect(text).toContain("api.example.com");
  });

  it("fills the row under the cursor, rather than marking it with a bar", () => {
    const { frame, plain } = draw({ picker });
    const row = frame.lines.find((line) => strip(line).includes("glm-5.3")) ?? "";

    // The row the keys are on is the row that is filled, edge to edge.
    expect(row).toContain(styles.paletteSelected);
    expect(plain.find((line) => line.includes("glm-5.3"))).toContain("paid");
    // And there is no cursor glyph anywhere on the card — the search field's
    // own block is a different thing.
    expect(plain.join("\n")).not.toContain("▌  ");
  });

  it("pins a trailing note to the right, so a column of them lines up", () => {
    const { plain } = draw({ picker });
    const first = plain.find((line) => line.includes("FREE")) ?? "";
    const second = plain.find((line) => line.includes("glm-5.3")) ?? "";

    // Same column, so a column of prices can be read down rather than scanned.
    expect(first.indexOf("FREE") + "FREE".length).toBe(second.indexOf("paid") + "paid".length);
  });

  it("marks the choice in use", () => {
    const text = draw({
      picker: { ...picker, items: [{ ...picker.items[1]!, current: true }], selected: 0 },
    }).plain.join("\n");

    expect(text).toContain("● glm-5.3");
  });

  it("names a group of rows in the heading colour, not the accent", () => {
    const { frame } = draw({ picker });
    const heading = frame.lines.find((line) => strip(line).includes("api.example.com")) ?? "";

    // A heading names the rows under it rather than being one of them, so it
    // gets a hue the accent does not use — the accent is the row the keys act on.
    expect(heading).toContain(styles.heading);
    expect(heading).not.toContain(styles.accentBold);
  });

  it("pins the last of its own keys to the card's right edge", () => {
    const hints: [string, string][] = [
      ["ctrl+d", "delete"],
      ["ctrl+r", "rename"],
      ["ctrl+a", "current directory"],
    ];
    const { plain } = draw({ picker: { ...picker, hints } });
    const row = plain.find((line) => line.includes("ctrl+d")) ?? "";

    // The first two run left as one group, the last sits at the far edge: a
    // footer then has a beginning and an end rather than one run of keys that
    // happens to stop early.
    expect(row.indexOf("ctrl+d")).toBeLessThan(row.indexOf("ctrl+r"));
    expect(row.indexOf("current directory")).toBeGreaterThan(row.indexOf("ctrl+r") + 20);
    // The right-hand key ends at the card's own inner edge: the title row's
    // close box ends two cells short of it, by its own trailing air.
    const title = plain.find((line) => line.includes("Select model")) ?? "";
    expect(row.trimEnd()).toHaveLength(title.trimEnd().length + 2);
  });

  it("carries a search field", () => {
    const text = draw({ picker: { ...picker, query: "gpt" } }).plain.join("\n");

    // The block sits after what has been typed: it is where the next
    // character goes.
    expect(text).toContain("gpt▌");
  });

  it("names the placeholder while the search field is empty", () => {
    expect(draw({ picker }).plain.join("\n")).toContain("▌Search");
  });

  it("draws a tab row and shows which filter is on", () => {
    const off = draw({ picker: { ...picker, tabs: { labels: ["all", "free", "paid"], active: 0 } } }).plain.join("\n");
    const onFree = draw({ picker: { ...picker, tabs: { labels: ["all", "free", "paid"], active: 1 } } }).plain.join("\n");

    expect(off).toContain("all   free   paid");
    // Same row either way: the tabs are a filter, not a second screen.
    expect(onFree).toContain("all   free   paid");
    expect(onFree).toContain("free");
  });

  it("has no tab row when the list has no filters", () => {
    expect(draw({ picker }).plain.join("\n")).not.toContain("all   free");
  });

  it("names one more key on its own row, when it has one", () => {
    const text = draw({ picker: { ...picker, hints: [["ctrl+a", "change provider"]] } }).plain.join("\n");

    expect(text).toContain("ctrl+a");
    expect(text).toContain("change provider");
  });

  it("skips a row that only explains itself", () => {
    const items = [
      { label: "m1", value: "m1" },
      { label: "401 Unauthorized", value: "", disabled: true },
      { label: "m2", value: "m2" },
    ];

    expect(stepPick(items, 0, 1)).toBe(2);
    expect(stepPick(items, 2, 1)).toBe(0);
    expect(stepPick(items, 0, -1)).toBe(2);
    // Nothing choosable leaves the cursor where it was rather than nowhere.
    expect(stepPick([items[1]!], 0, 1)).toBe(0);
  });

  it("searches model, tier and price alike", () => {
    const items = [
      { label: "glm-5.3", value: "glm-5.3", trailing: "paid" },
      { label: "mimo-v2.5:free", value: "mimo-v2.5:free", trailing: "FREE" },
    ];

    expect(filterPickItems(items, "glm").map((item) => item.label)).toEqual(["glm-5.3"]);
    expect(filterPickItems(items, "free").map((item) => item.label)).toEqual(["mimo-v2.5:free"]);
    // Keywords find the row without deserving a column: a session's opening
    // request matches even though no row shows it.
    const keyed = [
      { label: "fix login", value: "s1", keywords: "the oauth redirect loops forever" },
      { label: "readme", value: "s2", keywords: "typo on the pricing page" },
    ];
    expect(filterPickItems(keyed, "oauth").map((item) => item.label)).toEqual(["fix login"]);
    expect(filterPickItems(keyed, "pricing").map((item) => item.label)).toEqual(["readme"]);
    // Nothing typed is everything, not nothing.
    expect(filterPickItems(items, "  ")).toHaveLength(2);
  });

  it("says when nothing matches rather than showing an empty panel", () => {
    expect(draw({ picker: { ...picker, query: "zzz", items: [] } }).plain.join("\n")).toContain("nothing matches");
  });

  it("is one filled surface, inset from the edges, with no frame around it", () => {
    const { frame, plain } = draw({ picker });

    // The tab bar is on the same fill, so the card is what comes after it.
    const card = frame.lines.slice(1).filter((line) => line.includes(bg(theme.panel)));
    expect(card.length).toBeGreaterThan(4);
    // No border glyphs: the fill is what says where the card is.
    for (const glyph of ["┌", "┐", "└", "┘", "│"]) expect(plain.join("\n")).not.toContain(glyph);
    // And it starts inside the terminal's edge rather than against it.
    const title = plain.findIndex((line) => line.includes("Select model"));
    expect(plain[title]?.startsWith("  ")).toBe(true);
  });

  it("renders over the conversation while something is being chosen", () => {
    const { plain } = draw({ picker, entries: conversation });

    expect(plain.join("\n")).toContain("Select model");
  });

  it("offers its own keys in the footer", () => {
    const text = draw({ picker }).plain.join("\n");

    expect(text).toContain("↑↓ select");
    expect(text).toContain("enter confirm");
    expect(text).toContain("[×] close");
    expect(text).not.toContain("ctrl+p");
  });

  it("windows a long list around the selection", () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ label: `m${index}`, value: `m${index}` }));
    const text = draw({ picker: { title: "Select model", query: "", items, selected: 29 } }, { cols: 80, rows: 12 }).plain.join("\n");

    expect(text).toContain("m29");
    expect(text).not.toContain("m0 ");
  });

  it("keeps the cursor row on screen, heading or no heading", () => {
    // A group heading is worth a row only while the cursor does not need it:
    // scrolling the row the keys act on out of view is the worse trade.
    const items = Array.from({ length: 30 }, (_, index) => ({
      label: `m${index}`,
      value: `m${index}`,
      ...(index === 0 ? { group: "api.example.com" } : {}),
    }));
    const { frame } = draw(
      { picker: { title: "Select model", query: "", items, selected: 25 } },
      { cols: 80, rows: 12 },
    );
    // The row the keys are on is the one that is filled.
    const cursor = frame.lines.find((line) => line.includes(styles.paletteSelected)) ?? "";

    expect(strip(cursor)).toContain("m25");
  });

  it("says how many rows the window left out", () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ label: `m${index}`, value: `m${index}` }));
    const text = draw({ picker: { title: "Select model", query: "", items, selected: 0 } }, { cols: 80, rows: 14 }).plain.join("\n");

    expect(text).toContain("more");
  });

  it("separates a group from the rows above it with a blank row", () => {
    const items = [
      { label: "m1", value: "m1", group: "First" },
      { label: "m2", value: "m2" },
      { label: "m3", value: "m3", group: "Second" },
    ];
    const { plain } = draw({ picker: { title: "Select model", query: "", items, selected: 0 } });
    const heading = plain.findIndex((line) => line.includes("Second"));

    expect(heading).toBeGreaterThan(0);
    // The row above the heading is inside the frame and empty, so the heading
    // claims the rows below it rather than the ones above it too.
    expect(plain[heading - 1]?.replace(/[│┌└─]/g, "").trim()).toBe("");
  });

  it("deduplicates group headings across consecutive items", () => {
    const items = [
      { label: "session A", value: "s1", group: "Today" },
      { label: "session B", value: "s2", group: "Today" },
      { label: "session C", value: "s3", group: "Yesterday" },
    ];
    const text = draw({ picker: { title: "Sessions", query: "", items, selected: 0 } }).plain.join("\n");
    const todayMatches = text.match(/Today/g);
    expect(todayMatches).toHaveLength(1);
    const yesterdayMatches = text.match(/Yesterday/g);
    expect(yesterdayMatches).toHaveLength(1);
  });

  it("names every extra key it answers to", () => {
    const text = draw({
      picker: {
        ...picker,
        hints: [
          ["ctrl+a", "change provider"],
          ["ctrl+f", "favorite"],
        ],
      },
    }).plain.join("\n");

    expect(text).toContain("ctrl+a");
    expect(text).toContain("ctrl+f");
    expect(text).toContain("favorite");
  });

  it("sits in the center of the page", () => {
    const { frame, plain } = draw({
      entries: conversation,
      picker: { ...picker, items: picker.items.slice(0, 1), selected: 0 },
    });

    const rule = plain.findIndex((line) => /^─{20,}$/.test(line));
    const page = frame.lines.slice(0, rule);
    const topEdge = page.findIndex((line) => line.includes(bg(theme.panel)));
    const bottomEdge = page.findLastIndex((line) => line.includes(bg(theme.panel)));
    expect(topEdge).toBeGreaterThan(0);
    expect(bottomEdge).toBeGreaterThan(topEdge);
    expect(bottomEdge).toBeLessThan(page.length - 1);
  });

  it("leaves the conversation on screen behind it, faded", () => {
    // A page with something on it: the transcript follows the tail, so a short
    // conversation sits exactly where the card lands and there is nothing above
    // to fade.
    const long: Entry[] = Array.from({ length: 12 }, (_, i) => ({ kind: "user", text: `message number ${i}` }));
    const { frame, plain } = draw({ entries: long, picker });

    // The transcript is still there — the screen is not wiped — but its rows
    // are faint, so only the card is at full strength.
    const behind = frame.lines.filter((line) => strip(line).includes("message number"));
    expect(behind.length).toBeGreaterThan(0);
    for (const line of behind) {
      expect(line).toContain(styles.faint);
      // The page goes back to the page's own background: a chip fill left at
      // full strength behind a card reads as a second panel.
      expect(line).not.toContain(bg(theme.panel));
    }

    // And the card keeps its own colours, so it is still the readable thing on
    // screen: the title is bold, and the list rows are not faint.
    const title = frame.lines.filter((line) => strip(line).includes("Select model"));
    expect(title.length).toBe(1);
    expect(title[0]).toContain(styles.bold);
    // The selected row still wears the accent fill — the fade is a single faint
    // style, so the fill appearing at all proves the card is not it.
    const rows = frame.lines.filter((line) => strip(line).includes("glm-5.3"));
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain(styles.paletteSelected);
    expect(plain.some((line) => line.includes("glm-5.3"))).toBe(true);
  });

  it("stops the page behind it answering clicks", () => {
    // A row you cannot see clearly is not a row you should be able to press, so
    // only the card — and the close box in the footer, which is the way out —
    // contributes click targets while it is up.
    const { frame } = draw({ entries: conversation, picker });
    expect(frame.rows.every((row) => row.kind === "picker" || row.kind === "picker_tab" || row.kind === "close")).toBe(
      true,
    );
    expect(frame.rows.some((row) => row.kind === "close")).toBe(true);
  });
});

describe("the mention list", () => {
  const mentions = {
    items: [
      { label: "src/app.ts", kind: "file" },
      { label: "skill:seo-audit", description: "Audit a site.", kind: "skill" },
    ],
    selected: 0,
  };

  it("floats @ completions above the prompt", () => {
    const text = draw({ mentions }).plain.join("\n");

    expect(text).toContain("@src/app.ts");
    expect(text).toContain("@skill:seo-audit");
    // The prompt stays where typing goes.
    expect(text).toContain(PLACEHOLDER.slice(0, 12));
  });

  it("says nothing when there is nothing to offer", () => {
    const text = draw({ mentions: { items: [], selected: 0 } }).plain.join("\n");

    expect(text).not.toContain("@src/app.ts");
  });
});

describe("the mode", () => {
  it("names it in the pill, and warns once it is not the everyday one", () => {
    const build = draw({ mode: "build" });
    expect(build.plain.join("\n")).toContain("[BUILD]");
    expect(build.frame.lines.join("\n")).toContain(styles.mode);

    const plan = draw({ mode: "plan" });
    expect(plan.plain.join("\n")).toContain("[PLAN]");
    // The mode is a capability, not a label: plan mode is worth noticing.
    expect(plan.frame.lines.join("\n")).toContain(styles.warn);
  });

  it("puts the pill and the prompt on the one row", () => {
    const row = draw({ mode: "plan" }).plain.find((line) => line.includes("[PLAN]")) ?? "";

    // The pill is the row's own button, not a row of its own: it sits on the
    // line being typed into, in the column the words would start in.
    expect(row).toContain(PLACEHOLDER);
    expect(row).not.toContain("deepseek-v4-flash:free");
  });

  it("names the mode on the state row when there is no box for a pill", () => {
    // A card has the keyboard, so there is no box — and the row that stands in
    // for it is the only place left to read which mode the session is in.
    const picker = { title: "Select model", query: "", items: [{ label: "m1", value: "m1" }], selected: 0 };
    const { plain } = draw({ mode: "plan", picker });

    expect(plain.join("\n")).toContain("Plan · deepseek-v4-flash:free");
    expect(plain.join("\n")).not.toContain("[PLAN]");
  });

  it("cycles between the two", () => {
    expect(nextMode("build")).toBe("plan");
    expect(nextMode("plan")).toBe("build");
  });
});

describe("a picker on a screen too short for a frame", () => {
  const picker = { title: "Select model", query: "", items: [{ label: "m1", value: "m1" }], selected: 0 };

  it("falls back to a flat list, and still shows the choice", () => {
    const { frame, plain } = draw({ picker }, { cols: 80, rows: 9 });

    expect(frame.lines).toHaveLength(9);
    expect(plain.join("\n")).toContain("m1");
    expect(plain.join("\n")).not.toContain("┌");
  });
});

describe("the question panel", () => {
  /** The panel from the reference: five tabs, the third current. */
  const questions = [
    { header: "Base stack", question: "Which stack?", options: [{ label: "Next.js" }] },
    { header: "Layout scope", question: "How far?", options: [{ label: "One page" }] },
    {
      header: "Typography",
      question: "The reference is clean sans-serif, not monospace. Which way?",
      options: [
        {
          label: "Sans-serif (Recommended)",
          description: "Clean sans-serif throughout, like the reference. Correct for long-form reading.",
        },
        { label: "Keep monospace", description: "Keep IBM Plex Mono from ki-code-v1.0." },
        { label: "Sans body, mono for UI meta" },
        { label: "Type your own answer" },
      ],
    },
    { header: "Content", question: "What goes in?", options: [{ label: "Copy" }] },
  ];

  const panel = (over: Partial<TuiState> = {}) =>
    draw({
      ask: {
        questions,
        index: 2,
        selected: 0,
        answers: ["Next.js", "One page", null, null],
      },
      ...over,
    });

  it("replaces the transcript and the prompt", () => {
    const text = panel({ entries: conversation }).plain.join("\n");

    expect(text).toContain("Questions");
    expect(text).not.toContain("why is the build failing?");
    expect(text).not.toContain(PLACEHOLDER);
  });

  it("lists every question as a tab, then the submit marker", () => {
    const tabs = panel().plain.find((line) => line.includes("Base stack")) ?? "";

    expect(tabs).toContain("Base stack");
    expect(tabs).toContain("Typography");
    expect(tabs).toContain("Content");
    // The marker is the UI's, so it is there once rather than per question.
    expect(tabs.split("Submit")).toHaveLength(2);
    // The current tab is the one carrying the bold weight.
    const bold = panel().frame.lines.join("\n");
    expect(bold).toContain(`${styles.bold}Typography`);
    expect(bold).toContain(`${styles.dim}Base stack`);
  });

  it("asks the question and numbers the options", () => {
    const text = panel().plain.join("\n");

    expect(text).toContain("The reference is clean sans-serif, not monospace. Which way?");
    expect(text).toContain("1. Sans-serif (Recommended) ✓");
    expect(text).toContain("2. Keep monospace");
    expect(text).toContain("4. Type your own answer");
  });

  it("hangs each description under its label", () => {
    const lines = panel().plain;
    const row = lines.findIndex((line) => line.includes("2. Keep monospace"));
    const label = lines[row] ?? "";
    const description = lines[row + 1] ?? "";

    expect(description.trimStart()).toBe("Keep IBM Plex Mono from ki-code-v1.0.");
    // Indented to the label, not to the number.
    expect(description.indexOf("Keep")).toBe(label.indexOf("Keep monospace"));
  });

  it("moves the tick with the selection", () => {
    const first = panel().plain.join("\n");
    const second = panel({ ask: { questions, index: 2, selected: 1, answers: ["Next.js", "One page", null, null] } })
      .plain.join("\n");

    expect(first).toContain("1. Sans-serif (Recommended) ✓");
    expect(first).not.toContain("2. Keep monospace ✓");
    expect(second).toContain("2. Keep monospace ✓");
    expect(second).not.toContain("1. Sans-serif (Recommended) ✓");
  });

  it("swaps the footer for the answering keys", () => {
    const text = panel().plain.join("\n");

    expect(text).toContain("tab");
    expect(text).toContain("↑↓ select");
    expect(text).toContain("enter confirm");
    expect(text).toContain("[×] dismiss");
    expect(text).not.toContain("ctrl+p");
  });

  it("offers the input line only while an answer is being typed", () => {
    const options = panel().plain;
    // No prompt row: the keys belong to the panel, and the footer says so.
    expect(options.join("\n")).not.toContain(PLACEHOLDER);
    expect(options.at(-1)).toContain("[×] dismiss");

    const editor = new LineEditor();
    editor.insert("Inter");
    const { frame, plain } = panel({ askTyping: true, editor });
    const typing = plain.join("\n");

    expect(typing).toContain("Inter");
    expect(typing).toContain("[×] cancel");
    // Leaving the caret in the input row is what makes it typeable.
    expect(frame.caret).not.toBeNull();
  });

  it("labels the empty input line while an answer is being typed", () => {
    const typing = panel({ askTyping: true, editor: new LineEditor() }).plain.join("\n");

    expect(typing).toContain("Type your answer…");
  });

  it("hides the strip for a single question rather than showing one tab", () => {
    const text = draw({
      ask: { questions: [questions[2]!], index: 0, selected: 0, answers: [null] },
    }).plain.join("\n");

    expect(text).toContain("Questions");
    expect(text).not.toContain("Submit");
  });

  it("scrolls to keep the selection on screen when the options do not fit", () => {
    const tall = {
      header: "Layout",
      question: "Which?",
      options: Array.from({ length: 12 }, (_, index) => ({
        label: `option ${index + 1}`,
        description: "A sentence about what choosing this one means for the layout.",
      })),
    };

    const { plain } = draw(
      { ask: { questions: [tall], index: 0, selected: 11, answers: [null] } },
      { cols: 90, rows: 14 },
    );
    const text = plain.join("\n");

    expect(text).toContain("12. option 12 ✓");
    // The trailing newline keeps "11. option 11" from matching as well.
    expect(text).not.toContain("1. option 1\n");
    // Whatever was scrolled away, the footer is still the footer.
    expect(plain.at(-1)).toContain("[×] dismiss");
  });
});

describe("the approval modal", () => {
  const modal = permission({ body: [{ text: "+ npm test" }] });

  it("replaces the prompt with the request", () => {
    const text = draw({ modal }).plain.join("\n");

    expect(text).toContain("bash wants to run");
    expect(text).toContain("+ npm test");
    expect(text).toContain("allow?");
    expect(text).not.toContain(PLACEHOLDER);
  });

  it("names the keys the request does not: escape and ctrl+c", () => {
    const text = draw({ modal }).plain.join("\n");

    expect(text).toContain("[×] deny");
    // Escape only denies; ctrl+c denies and stops the turn, which is the one
    // difference that makes it worth pressing here, so the hint names it.
    expect(text).toContain("ctrl+c deny + stop");
    // The card's own answers are chips too, so a mouse can pick any of them.
    expect(text).toContain("[y] yes");
    expect(text).toContain("[a] always");
    expect(text).toContain("[n] no");
  });

  it("lets the request win the footer, because it owns every key", () => {
    // A panel can still be on screen behind it, but its keys do nothing while
    // the request is up, and naming them would be a lie.
    const ask: AskPanel = {
      questions: [{ header: "Scope", question: "which one?", options: [{ label: "a" }, { label: "b" }] }],
      index: 0,
      selected: 0,
      answers: [null],
    };
    const footer = draw({ modal, ask }).plain.at(-1) ?? "";

    expect(footer).toContain("[×] deny");
    expect(footer).toContain("ctrl+c deny + stop");
    expect(footer).not.toContain("[×] dismiss");
  });

  it("keeps the decision row and its hint on a terminal too short for the preview", () => {
    // The body is the only part that may be cut: losing the `allow?` row or the
    // hint would leave a prompt that does not say how to answer it.
    const long: ApprovalModal = permission({
      title: "edit wants to run",
      body: Array.from({ length: 40 }, (_, i) => ({ text: `${i === 0 ? "" : "\n"}${i % 2 === 0 ? "-" : "+"} line ${i}` })),
    });

    for (let rows = 6; rows <= 30; rows++) {
      const { frame, plain } = draw({ modal: long }, { cols: 80, rows });
      expect(frame.lines).toHaveLength(rows);
      expect(plain.at(-1)).toContain("[×] deny");
      expect(plain.at(-1)).toContain("ctrl+c deny + stop");
      expect(plain.join("\n")).toContain("allow?");
      expect(plain.join("\n")).toContain("edit wants to run");
    }
  });

  it("says how much of a preview it had to cut", () => {
    const long: ApprovalModal = permission({
      title: "edit wants to run",
      body: Array.from({ length: 40 }, (_, i) => ({ text: `${i === 0 ? "" : "\n"}+ line ${i}` })),
    });
    const text = draw({ modal: long }).plain.join("\n");

    // Five lines of the six-row body, and the sixth counts the remainder.
    expect(text).toContain("… 35 more lines");
  });

  it("sits at the foot of the page, one row above the rule", () => {
    const { plain } = draw({ modal });

    // The card's last row is the last row of the conversation, so it lands
    // directly above the rule and the prompt — where the eye already is while
    // typing, and where a picker lands too.
    const rule = plain.findIndex((line) => line.trimStart().startsWith("─"));
    const last = plain.findLastIndex((line) => line.includes("[n] no"));
    expect(last).toBe(rule - 1);
    // Narrower than the screen, with air on the left: a card, not a band.
    const card = plain.find((line) => line.includes("bash wants to run")) ?? "";
    expect(card.startsWith("   ▌")).toBe(true);
  });

  it("makes the card's chips and the footer's close box click targets", () => {
    const { frame } = draw({ modal });

    // Three answers on the card and the footer's way out, each with the columns
    // it was drawn in — and nothing else on screen is clickable while the card
    // owns the keys.
    expect(frame.rows.map((row) => row.kind)).toEqual([
      "modal_choice",
      "modal_choice",
      "modal_choice",
      "close",
    ]);
    const starts = frame.rows.map((row) => row.colStart ?? 0);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    // Every target sits inside the card: right of its bar and inside the frame.
    for (const row of frame.rows) {
      expect(row.colStart ?? 0).toBeGreaterThan(3);
      expect(row.colEnd ?? 0).toBeLessThan(80);
    }
  });

  it("keeps the tab bar and the footer visible around the card", () => {
    const { plain } = draw({ modal });

    expect(plain[0]).toContain(NEW_TAB);
    expect(plain.at(-1)).toContain("[×] deny");
  });

  it("stays quiet when the preview fits", () => {
    // The marker is a lie when nothing was left out, and it costs a row.
    const text = draw({ modal }).plain.join("\n");

    expect(text).not.toContain("more line");
  });

  it("counts the marker itself among the lines it hid", () => {
    // Six rows of body: five from the diff and one to say what was cut, so the
    // seven-line preview leaves two lines unshown rather than one.
    const justOver: ApprovalModal = permission({
      title: "edit wants to run",
      body: [{ text: "edit src/a.ts" }].concat(
        Array.from({ length: 6 }, (_, i) => ({ text: `\n+ line ${i}` })),
      ),
    });

    expect(draw({ modal: justOver }).plain.join("\n")).toContain("… 2 more lines");
  });
});

describe("the blocks", () => {
  const block = bg(theme.block);
  const panel = bg(theme.panel);
  /** The input box's own fill, a step off `block`. */
  const fill = bg(theme.input);

  /**
   * The transcript's own rows: everything above the rule that closes it.
   *
   * The input box under the rule is filled with the same surface a user's turn
   * is — that is what makes it read as somewhere to type — so a test about a
   * turn's block has to say which block it means.
   */
  const transcriptOf = (frame: { lines: readonly string[] }): string[] => {
    const rule = frame.lines.findIndex((line) => strip(line).includes("─"));
    return frame.lines.slice(0, rule < 0 ? frame.lines.length : rule);
  };

  it("draws a user turn as a filled block with one straight left edge", () => {
    const { frame, plain } = draw({ entries: [{ kind: "user", text: "why is the build failing?" }] });

    const filled = transcriptOf(frame).filter((line) => line.includes(block));
    // Padding above and below the text, all of it part of the same block.
    expect(filled.length).toBeGreaterThanOrEqual(3);
    for (const row of filled) expect(strip(row).trimStart().startsWith("▌")).toBe(true);
    expect(plain.join("\n")).toContain("why is the build failing?");
    expect(plain.join("\n")).toContain("▌");
  });

  it("gives a one-line request a five-row panel", () => {
    const { frame } = draw({ entries: [{ kind: "user", text: "hi" }] });

    const filled = transcriptOf(frame).filter((line) => line.includes(block));
    // Two rows of padding, the text, two more: one row of padding still reads
    // as a line that happens to be tall.
    expect(filled).toHaveLength(5);
    expect(strip(filled[2] ?? "")).toContain("hi");
    for (const row of [filled[0], filled[1], filled[3], filled[4]]) {
      expect((strip(row ?? "")).trim()).toBe("▌");
    }
  });

  it("pads the block fill into one rectangle, not slivers", () => {
    // The padding rows carry only the bar's two cells unless they are padded
    // out to the text row's width — which reads as a glitched background, not
    // a panel.
    const { frame } = draw({ entries: [{ kind: "user", text: "hi" }] });
    const filled = transcriptOf(frame).filter((line) => line.includes(block));
    const widths = filled.map((row) => textWidth(strip(row)));
    expect(new Set(widths).size).toBe(1);
  });

  it("hugs the text with a little padding, rather than running to the rim", () => {
    // The fill is a chip around the words: bar, text, and a couple of cells of
    // block colour — not a band that stretches the width of the column.
    const { frame } = draw({ entries: [{ kind: "user", text: "hi" }] });
    const filled = transcriptOf(frame).filter((line) => line.includes(block));
    for (const row of filled) {
      // Two gutter cells are page-coloured, then the block itself.
      expect(textWidth(strip(row))).toBeLessThan(20);
    }
  });

  it("shows attached documents as named badges beside the prompt", () => {
    const { plain } = draw({ attachedDocs: ["notes.md", "spec.txt"] });
    const joined = plain.join("\n");
    expect(joined).toContain("[notes.md]");
    expect(joined).toContain("[spec.txt]");
  });

  it("keeps only the attach button on the prompt row", () => {
    const { plain } = draw({});
    const prompt = plain.find((line) => line.includes("Ask anything")) ?? "";

    // The row carries the one control that is pressed while typing. Send has
    // no button of its own — enter sends, and a filled arrow was the loudest
    // thing on screen for the one key everybody already presses — and the
    // variant pill went the same way: `/effort` changes it.
    expect(prompt).toContain("[+]");
    expect(prompt).not.toContain("\u2191");
    expect(prompt).not.toContain("[Think]");
  });

  it("keeps the bar and the fill together on a wrapped turn", () => {
    const { frame, plain } = draw({ entries: [{ kind: "user", text: "x".repeat(200) }] }, { cols: 40, rows: 20 });

    const filled = transcriptOf(frame).filter((line) => line.includes(block));
    expect(filled.length).toBeGreaterThan(3);
    for (const row of filled) expect(strip(row)).toContain("▌");
    // And nothing overflows the width with a bar on every row.
    for (const line of plain) expect(textWidth(line)).toBeLessThanOrEqual(39);
  });

  it("rules tool output instead of filling it", () => {
    const { frame, plain } = draw({
      entries: [
        { kind: "tool", name: "read", args: { file: "a.ts" } },
        { kind: "result", name: "read", content: "42 lines", isError: false },
      ],
    });

    // Every row of the run carries the rule, gaps included, which is what makes
    // it read as one piece of work.
    expect(plain.filter((line) => line.trimStart().startsWith("│")).length).toBeGreaterThanOrEqual(3);
    expect(plain.join("\n")).toContain("→ read");
    expect(plain.join("\n")).toContain("42 lines");
    expect(transcriptOf(frame).join("\n")).not.toContain(block);
  });

  it("fills the prompt box and the state row under it as one surface", () => {
    const { frame, plain } = draw({});

    const prompt = frame.lines.find((line) => strip(line).includes(PLACEHOLDER));
    // The last row that names the model: the transcript's own header names it
    // too, and the state row is the one under the box.
    const status = frame.lines.findLast((line) => strip(line).includes("deepseek-v4-flash:free"));
    // The box and the state row wear the theme's own input surface — a step off
    // the fill a user's turn wears, so the place being typed into reads as the
    // surface in front rather than one more line of transcript. The panel is
    // the tab bar and a card's own fill, not this.
    expect(prompt).toContain(fill);
    expect(status).toContain(fill);
    expect(prompt).not.toContain(panel);
    expect(prompt).not.toContain(block);
    // Every row of the box carries the fill — the rows of air included — so it
    // is one surface, not a stripe of page between two bars. And no row of it
    // starts with a bar: the fill is what marks the box out.
    const rows = frame.lines.filter((line) => line.includes(fill));
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) expect(strip(row).trimStart().startsWith("▌")).toBe(false);
    // The footer goes back to the background: the box is the box.
    const footer = frame.lines.at(-1)!;
    expect(footer).not.toContain(fill);
  });

  it("leaves a row of air between the editor and the state row", () => {
    const { plain } = draw({});
    const lines = plain.map((line) => line.trimEnd());
    const editor = lines.findIndex((line) => line.includes(PLACEHOLDER));
    // The last row that names the model: the transcript's own header names it
    // too, and the state row is the one under the box.
    const status = lines.findLastIndex((line) => line.includes("deepseek-v4-flash:free"));

    // Enter puts two rows of the box's own fill between what is being typed and
    // where it will go: stacked flush, the two answers read as one run of text.
    expect(status - editor).toBe(3);
    expect(lines[editor + 1]?.trim()).toBe("");
    expect(lines[editor + 2]?.trim()).toBe("");
  });

  it("leaves a blank row between entries, and one more around a request", () => {
    // A 30-row screen, so the four short entries fit and no scrollbar takes the
    // last column of the blank rows being counted.
    const { plain } = draw(
      {
        entries: [
          { kind: "user", text: "hi" },
          { kind: "assistant", text: "Hello." },
          { kind: "note", text: "Switched model", tone: "dim" },
          { kind: "user", text: "again" },
        ],
      },
      { cols: 80, rows: 30 },
    );

    const last = (text: string): number => plain.findLastIndex((line) => line.includes(text));
    const blanks = (from: number, to: number): number =>
      plain.slice(from, to).filter((line) => line.trim() === "").length;

    // The block's own padding row, then two blanks before the answer.
    expect(blanks(last("▌ hi") + 1, last("Hello."))).toBe(2);
    // A plain pair of entries gets one.
    expect(blanks(last("Hello.") + 1, last("Switched model"))).toBe(1);
    // And a request boundary gets two again.
    expect(blanks(last("Switched model") + 1, last("▌ again"))).toBe(2);
  });

  it("fills an ask and the state row as one box, edged in the ask's colour", () => {
    const { frame } = draw({ modal: permission({ body: [{ text: "run: ls -la" }] }) });

    // The tab bar is on the same surface, so the box is what comes after it.
    const box = frame.lines.slice(1).filter((line) => line.includes(panel));
    // The card's own title, body and options, then the state row under them.
    expect(box.length).toBeGreaterThanOrEqual(4);
    // The card's rows carry its warn bar; the state row under it does not — the
    // fill is what ties it to the box, and a bar there would read as a fifth
    // line of the card.
    for (const line of box.slice(0, -1)) {
      expect(line).toContain(styles.warn);
      expect(line).toContain("▌");
    }
    expect(box.at(-1)).not.toContain("▌");
    // One box, whose last row is still the state row — and still says which
    // mode the session is in, in the mode's own colour.
    expect(strip(box.at(-1) ?? "")).toContain("Build");
    expect(box.at(-1)).toContain(`${styles.mode}Build`);
  });

  it("emphasises a word in prose without touching the prose around it", () => {
    const { frame } = draw({ entries: [{ kind: "assistant", text: "The default is **missing** here." }] });

    const line = frame.lines.find((raw) => strip(raw).includes("missing"));
    expect(line).toContain(styles.emphasis);
    expect(line).toContain("The default is ");
  });
});



/**
 * A prompt longer than the box is wide used to be cut off at the right edge
 * with a `…`, which is how you lose the end of what you are typing. These are
 * about the box growing instead.
 */
describe("the prompt that wraps", () => {
  const block = bg(theme.block);

  const typed = (text: string, size: Size = { cols: 80, rows: 24 }) => {
    const editor = new LineEditor();
    editor.setText(text);
    const frame = renderFrame(state({ editor }), size, styles, theme);
    const plain = frame.lines.map((line) => strip(line));
    // What each text row of the box shows, read off the frame at the columns
    // the renderer reported — the same route a click takes.
    const textLeft = (frame.prompt?.textLeft ?? 1) - 1;
    const shown = (frame.prompt?.rows ?? []).map((row) =>
      plain[row.row - 1]!.slice(textLeft, textLeft + (row.end - row.start)),
    );
    return { frame, plain, shown };
  };

  it("grows the box instead of cutting the line at the edge", () => {
    const { frame, plain, shown } = typed("f".repeat(200));

    // Every character is on screen, across four rows instead of one — one more
    // than the row count before the pill: the pill and the upload button take
    // ten cells of the row's own budget.
    expect(shown.join("")).toBe("f".repeat(200));
    expect(frame.prompt?.rows).toHaveLength(4);
    const box = plain.slice((frame.prompt?.top ?? 1) - 1, frame.prompt?.bottom);
    for (const line of box) expect(line).not.toContain("…");
  });

  it("fills every row of the taller box with the typing surface", () => {
    const { frame } = typed("f".repeat(200));
    const prompt = frame.prompt!;

    // The rows of air above and below the text are part of the box: one fill
    // from its first row to its last, with no bar down the edge.
    for (const line of frame.lines.slice(prompt.top - 1, prompt.bottom)) {
      expect(line).toContain(bg(theme.input));
      expect(strip(line).trimStart().startsWith("▌")).toBe(false);
    }
  });

  it("keeps the caret on the row that is being typed on", () => {
    const { frame, shown } = typed("f".repeat(200));
    const prompt = frame.prompt!;

    // The box's own rows bracket the text: two rows of air, the text, two more.
    expect(prompt.rows[0]?.row).toBe(prompt.top + 2);
    expect(prompt.rows.at(-1)?.row).toBe(prompt.bottom - 2);
    expect(frame.caret?.row).toBe(prompt.rows.at(-1)?.row);
    // The caret is the cell the next character goes in: just past the text on
    // the row it is on, which is a different column once the row wrapped.
    expect(frame.caret?.col).toBe(prompt.textLeft + (shown.at(-1)?.length ?? 0));
  });

  it("stops growing at six rows and follows the caret instead", () => {
    const { frame, shown } = typed("f".repeat(2000));
    const prompt = frame.prompt!;

    expect(prompt.rows).toHaveLength(EDITOR_MAX_ROWS);
    expect(prompt.rows[0]!.start).toBeGreaterThan(0);
    // What is on screen is the tail — the part being typed — and still the
    // text as it was typed.
    expect(shown.join("")).toBe("f".repeat(2000 - prompt.rows[0]!.start));
    expect(frame.caret?.row).toBe(prompt.rows.at(-1)?.row);
  });

  it("takes its room from the transcript rather than the frame", () => {
    const editor = new LineEditor();
    editor.setText("f".repeat(2000));
    const frame = renderFrame(state({ editor, entries: conversation }), { cols: 80, rows: 24 }, styles, theme);
    const plain = frame.lines.map((line) => strip(line));

    expect(frame.lines).toHaveLength(24);
    // The conversation is still there under the taller box, rather than pushed
    // off the bottom of the screen.
    expect(plain.join("\n")).toContain("build failing");
  });
});

describe("the box's own two buttons", () => {
  it("reports the cells it drew each of them in", () => {
    const editor = new LineEditor();
    editor.setText("hi");
    const { frame, plain } = draw({ editor });
    const box = frame.prompt!;
    const row = plain[box.modeButton.row - 1] ?? "";

    // Both are presses, so the renderer says where they landed: the app presses
    // these cells and nothing else. The pill is the mode's own word, so its
    // width is not knowable from outside — this is the only copy of it.
    expect(row.slice(box.modeButton.colStart - 1, box.modeButton.colEnd)).toBe("[BUILD]");
    expect(row.slice(box.uploadButton.colStart - 1, box.uploadButton.colEnd)).toBe("UPLOAD [+]");
    // Neither of them sits on the text: the pill ends before the words begin and
    // the button starts after them.
    expect(box.modeButton.colEnd).toBeLessThan(box.textLeft);
    expect(box.uploadButton.colStart).toBeGreaterThan(box.textLeft);
  });

  it("keeps both on the row that is being typed into", () => {
    const editor = new LineEditor();
    editor.setText("f".repeat(200));
    const { frame } = draw({ editor });
    const box = frame.prompt!;

    // One row each: a pill or a `UPLOAD [+]` beside every wrapped row would read
    // as a column of buttons, and one press would have to say which it meant.
    expect(box.rows.length).toBeGreaterThan(1);
    expect(box.modeButton.row).toBe(box.rows[0]?.row);
    expect(box.uploadButton.row).toBe(box.rows[0]?.row);
  });
});

describe("prompt badges", () => {
  it("puts the caret right after the text, not a badge-width past it", () => {
    const editor = new LineEditor();
    editor.setText("ssss");
    const { frame, plain } = draw({ editor, attachedImages: 1 });
    const box = frame.prompt!;

    // The bug this pins: the badge width was counted in `textLeft` and again
    // in the caret column, so the terminal caret sat ~10 cells right of the
    // text it belonged to.
    expect(box.badgeWidth).toBe("[Image 1] ".length);
    const row = plain[box.rows[0]!.row - 1] ?? "";
    expect(row).toContain("[Image 1] ssss");
    expect(frame.caret?.row).toBe(box.rows[0]?.row);
    expect(frame.caret?.col).toBe(box.textLeft + "ssss".length);
  });

  it("reports the badge run's columns ahead of the text", () => {
    const editor = new LineEditor();
    editor.setText("hi");
    const { frame, plain } = draw({ editor, attachedImages: 1, attachedDocs: ["notes.md"] });
    const box = frame.prompt!;

    expect(box.badgeWidth).toBe("[Image 1] ".length + "[notes.md] ".length);
    const row = plain[box.rows[0]!.row - 1] ?? "";
    // The detach hit-test starts here, so the badges must actually be drawn
    // in these columns rather than merely reported.
    expect(row.slice(box.textLeft - box.badgeWidth - 1, box.textLeft - 1)).toBe("[Image 1] [notes.md] ");
    expect(frame.caret?.col).toBe(box.textLeft + "hi".length);
  });
});

describe("the queue above the box", () => {
  it("carries no ADD button — queuing is the enter key's job", () => {
    // A queued message is added by pressing enter while a turn runs, so the box
    // offers only the one click-only control it has: uploading a file.
    expect(draw({}).plain.join("\n")).not.toContain("ADD[+]");
    expect(draw({ busy: "thinking…" }).plain.join("\n")).not.toContain("ADD[+]");

    const running = draw({ busy: "thinking…" });
    expect(running.plain.join("\n")).toContain("UPLOAD [+]");
    const box = running.frame.prompt!;
    const row = running.plain[box.uploadButton.row - 1] ?? "";
    expect(row.slice(box.uploadButton.colStart - 1, box.uploadButton.colEnd)).toBe("UPLOAD [+]");
  });

  it("puts [Add+] before [x] on every tile, each with its own columns", () => {
    const { frame, plain } = draw({ busy: "thinking…", queue: ["first one", "second one"] });
    const adds = frame.rows.filter((row) => row.kind === "queued_add");
    const drops = frame.rows.filter((row) => row.kind === "queued");

    expect(adds).toHaveLength(2);
    for (const [index, hit] of adds.entries()) {
      const line = plain[hit.row - 1] ?? "";
      expect(line.slice(hit.colStart! - 1, hit.colEnd!)).toBe("[Add+]");
      expect(hit.index).toBe(index);
      // `[Add+]` sits first, so the space between the two chips is part of its
      // hit box: a click that lands a column late must read as "send it now",
      // never as "throw it away".
      expect(hit.colEnd!).toBeLessThan(drops[index]!.colStart! - 1);
    }
  });

  it("draws each queued message with an [x] the app can hit", () => {
    const { frame, plain } = draw({ busy: "thinking…", queue: ["first one", "second one"] });
    const tiles = frame.rows.filter((row) => row.kind === "queued");

    expect(tiles).toHaveLength(2);
    expect(plain.join("\n")).toContain("Queued (2)");
    for (const [index, hit] of tiles.entries()) {
      const line = plain[hit.row - 1] ?? "";
      // The reported columns are the `[x]` itself, so a mis-click is the only
      // way the wrong message could be dropped.
      expect(line.slice(hit.colStart! - 1, hit.colEnd!)).toBe("[x]");
      expect(hit.index).toBe(index);
      expect(line).toContain(["first one", "second one"][index]!);
    }
  });
});

describe("the usage chip", () => {
  it("is always on the state row, and reports its own columns", () => {
    // Unlike the TODO chip, this one exists even on a quiet session: "what has
    // this cost me?" is a question every session can answer.
    const { frame, plain } = draw({});
    const hit = frame.rows.find((row) => row.kind === "usage_button");
    expect(hit).toBeDefined();
    const line = plain[hit!.row - 1] ?? "";
    expect(line.slice(hit!.colStart! - 1, hit!.colEnd!)).toBe("[USAGE]");
  });

  it("rides beside the TODO chip without overlapping it", () => {
    const { frame } = draw({ plan: { todos: [{ text: "one", done: false }], goal: null } });
    const todo = frame.rows.find((row) => row.kind === "todo_button")!;
    const usage = frame.rows.find((row) => row.kind === "usage_button")!;
    expect(todo.colEnd!).toBeLessThan(usage.colStart!);
  });
});

describe("the settings button", () => {
  it("trails the footer past the usage, and reports its own columns", () => {
    // The mouse way to reach what `/settings` does by name: a bare bold glyph
    // at the footer's right end, past the numbers, while no card owns the
    // screen.
    const { frame, plain } = draw({ usage: { tokens: 1700, budget: 128_000, tools: 0 } });
    const hit = frame.rows.find((row) => row.kind === "settings_button");
    expect(hit).toBeDefined();
    const line = plain[hit!.row - 1] ?? "";
    expect(line.slice(hit!.colStart! - 1, hit!.colEnd!)).toBe("⚙");
    expect(line.indexOf("⚙")).toBeGreaterThan(line.indexOf("1.7K"));
    expect(line.trimEnd().endsWith("⚙")).toBe(true);
  });

  it("hides while a card owns the screen", () => {
    // A button that visibly does nothing is worse than one that is not there:
    // the panel it opens is hidden behind the card, like the state row's chips.
    const { frame } = draw({ modal: permission() });
    expect(frame.rows.some((row) => row.kind === "settings_button")).toBe(false);
  });
});

describe("the subagent dock", () => {
  const child = (over: Partial<SubagentView> = {}): SubagentView => ({
    id: "sa-1",
    goal: "find the retry logic",
    model: "gemini-3.8-flash",
    status: "running",
    ms: 4_200,
    toolCalls: 3,
    ...over,
  });

  it("draws nothing when no child is running", () => {
    expect(draw({ subagents: [] }).plain.join("\n")).not.toContain("gemini-3.8-flash");
  });

  it("names the child, its model and its progress", () => {
    // A child can run for minutes while the parent's own words stay silent, so
    // the row has to say who is working on what without being asked.
    const row = draw({ subagents: [child()] }).plain.find((line) => line.includes("find the retry logic"));

    expect(row).toBeDefined();
    expect(row).toContain("gemini-3.8-flash");
    expect(row).toContain("3 tools");
    expect(row).toContain("4s");
  });

  it("says how many it is hiding, because two rows is the cap", () => {
    // A batch of eight is eight rows of chrome in a fixed-height area; the count
    // is what tells the user how much of it is off screen, and `/agents` is what
    // opens the rest.
    const many = Array.from({ length: 6 }, (_, at) => child({ id: `sa-${at}`, goal: `task ${at}` }));
    const plain = draw({ subagents: many }).plain.join("\n");

    expect(plain).toContain("task 0");
    expect(plain).toContain("task 1");
    expect(plain).not.toContain("task 2");
    expect(plain).toContain("+4 more");
    expect(plain).toContain("/agents");
  });

  it("tells a running child from a finished one and a dead one", () => {
    const plain = draw({
      subagents: [child({ id: "a", goal: "still going" }), child({ id: "b", goal: "all done", status: "completed" })],
    }).plain.join("\n");

    expect(plain).toContain("◐ still going");
    expect(plain).toContain("✓ all done");
  });

  it("marks a child that did not finish with a cross", () => {
    const plain = draw({ subagents: [child({ goal: "dead one", status: "failed" })] }).plain.join("\n");

    expect(plain).toContain("✕ dead one");
  });

  it("reads the elapsed time in whatever unit fits it", () => {
    expect(draw({ subagents: [child({ ms: 400 })] }).plain.join("\n")).toContain("400ms");
    expect(draw({ subagents: [child({ ms: 90_000 })] }).plain.join("\n")).toContain("90s");
  });

  it("keeps every row inside the terminal width", () => {
    const many = Array.from({ length: 4 }, (_, at) =>
      child({ id: `sa-${at}`, goal: "a".repeat(300) }),
    );

    for (const line of draw({ subagents: many }).plain) {
      expect(textWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  it("copes with a screen too short to give the dock a row", () => {
    // The dock is chrome above the box; on a short terminal the box and the
    // prompt win, because a prompt you cannot see is worse than a dock you
    // cannot see.
    const { plain } = draw({ subagents: [child()] }, { cols: 80, rows: 6 });

    expect(plain.join("\n")).toContain("find the retry logic");
    expect(plain.some((line) => line.includes("Ask anything"))).toBe(true);
  });
});

describe("the plan button and its panel", () => {
  const plan: PlanSnapshot = {
    todos: [
      { text: "read the code", done: true },
      { text: "change the loop", done: false, inProgress: true },
      { text: "write the tests", done: false },
    ],
    goal: null,
  };

  it("shows a TODO chip with its progress, and no chip without tracked work", () => {
    const withPlan = draw({ plan });
    expect(withPlan.plain.join("\n")).toContain("[TODO 1/3]");

    // The chip reports the columns it was drawn in, so the press lands on it.
    const hit = withPlan.frame.rows.find((row) => row.kind === "todo_button");
    expect(hit).toBeDefined();
    const line = withPlan.plain[hit!.row - 1] ?? "";
    expect(line.slice(hit!.colStart! - 1, hit!.colEnd!)).toBe("[TODO 1/3]");

    // Nothing tracked (or no plan at all) means no button: `TODO [0/0]` on a
    // quiet session is a button for nothing.
    expect(draw({}).frame.rows.some((row) => row.kind === "todo_button")).toBe(false);
    expect(draw({ plan: { todos: [], goal: null } }).frame.rows.some((row) => row.kind === "todo_button")).toBe(false);
  });

  it("prefers the goal's own progress while one is running", () => {
    const withGoal: PlanSnapshot = {
      todos: plan.todos,
      goal: {
        title: "ship it",
        status: "running",
        tasks: [
          { id: "t1", title: "build", status: "done" },
          { id: "t2", title: "test", status: "open" },
        ],
      },
    };
    expect(draw({ plan: withGoal }).plain.join("\n")).toContain("[TODO 1/2]");
  });

  it("draws the checklist and the goal in a panel, right-aligned above the box", () => {
    const withGoal: PlanSnapshot = {
      todos: plan.todos,
      goal: {
        title: "ship it",
        status: "running",
        tasks: [
          { id: "t1", title: "build", status: "done" },
          { id: "t2", title: "test", status: "open" },
        ],
        current: "t2 · test",
      },
    };

    // Shut, the panel is not on screen at all.
    expect(draw({ plan: withGoal }).plain.join("\n")).not.toContain("write the tests");

    const open = draw({ plan: withGoal, todoPanel: true });
    const screen = open.plain.join("\n");
    expect(screen).toContain("write the tests");
    expect(screen).toContain("ship it");
    expect(screen).toContain("t2");

    // Right-aligned: the panel's border starts inside the terminal's edge.
    const titleRow = open.plain.findIndex((line) => line.includes(" TODO ") && line.includes("[×]"));
    expect(titleRow).toBeGreaterThanOrEqual(0);
    expect((open.plain[titleRow] ?? "").search(/\S/)).toBeGreaterThan(0);

    // And its close chip is a target on the row it was drawn in.
    const close = open.frame.rows.find((row) => row.kind === "close" && row.row === titleRow + 1);
    expect(close).toBeDefined();
  });
});

describe("the transcript column", () => {
  it("starts a request block at the column's edge, not the terminal's", () => {
    const { frame, plain } = draw({ entries: [{ kind: "user", text: "hi" }] }, { cols: 80, rows: 24 });

    const row = plain.find((line) => line.includes("hi"))!;
    expect(row.indexOf("▌")).toBe(2);
    expect(row.indexOf("hi")).toBe(4);

    // The row carries the block's background, and the gutter span paints the
    // page over it — that override is what gives the block an edge to sit on
    // instead of letting it run off the rim.
    const raw = frame.lines.find((line) => strip(line).includes("hi"))!;
    expect(raw.startsWith(`${bg(theme.block)}${bg(theme.bg)}  `)).toBe(true);
    expect(raw).toContain(`${bg(theme.block)}${styles.accent}▌`);
  });

  it("wraps a long word short of the terminal's edge, with a gutter down each side", () => {
    // An unbreakable word, so every full row is exactly as wide as the column.
    const { plain } = draw({ entries: [{ kind: "assistant", text: "x".repeat(200) }] }, { cols: 80, rows: 24 });

    const rows = plain.filter((line) => line.includes("x")).map((line) => line.replace(/\s+$/, ""));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.startsWith("  ")).toBe(true);
      // Two columns of page a side, 74 of prose, and the last usable column
      // still free: nothing in the transcript reaches the terminal's rim.
      expect(textWidth(row)).toBeLessThanOrEqual(76);
    }
    expect(textWidth(rows[0] ?? "")).toBe(76);
  });

  it("puts the request bar, the tool rule and the box's own edge in one column", () => {
    const entries: Entry[] = [
      { kind: "user", text: "hi" },
      { kind: "tool", name: "read", args: { file: "a.ts" } },
      { kind: "result", name: "read", content: "42 lines", isError: false },
    ];

    for (const cols of [80, 50, 40]) {
      const { plain } = draw({ entries }, { cols, rows: 22 });
      const columnOf = (text: string, glyph: string): number =>
        plain.find((line) => line.includes(text))!.indexOf(glyph);

      // One left edge down the whole screen: the request block, the rule that
      // ties a run of tool output together, and the box you type into all start
      // in the same column — and it follows the gutter in when the terminal is
      // too narrow to spare it.
      const request = columnOf("hi", "▌");
      expect(columnOf("→ read", "│")).toBe(request);
      // The box carries no bar of its own, but it opens where the request
      // block opens: the bar, its space, then the pill. The words follow the
      // pill, one gap behind it — the pill takes the column the request block's
      // text begins in, because it is what says how that text will be read.
      const edge = columnOf("Ask anything", "[");
      expect(edge).toBe(request + 2);
      expect(columnOf("Ask anything", "A")).toBe(edge + textWidth("[BUILD] "));
      expect(request).toBe(cols >= 50 ? 2 : 0);
    }
  });

  it("takes the requested density from the view instead of a constant", () => {
    const entries: Entry[] = [
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "Hello." },
    ];
    // The distance from one line to the next, which is `block` rows of padding
    // under the request plus the `entry + turn` blank rows after it.
    const between = (spacing: Spacing): number => {
      const { plain } = draw({ entries, settings: { ...withTabs, spacing } });
      return plain.findIndex((line) => line.includes("Hello.")) - plain.findIndex((line) => line.includes("hi"));
    };

    expect(between({ block: 2, entry: 1, turn: 1 })).toBe(5);
    // Zero is a real answer: no padding, no gaps, one line per thing.
    expect(between({ block: 0, entry: 0, turn: 0 })).toBe(1);
    expect(between({ block: 3, entry: 3, turn: 3 })).toBe(10);
  });
});

describe("the rows a click can land on", () => {
  /** The text drawn on a 1-based screen row. */
  const lineAt = (plain: readonly string[], row: number): string => plain[row - 1] ?? "";

  it("reports the picker's rows, and which item each one is", () => {
    const items = ["alpha", "beta", "gamma"].map((label) => ({ label, value: label }));
    const { frame, plain } = draw({ picker: { title: "Select model", items, selected: 1, query: "" } });

    const rows = frame.rows.filter((row) => row.kind === "picker");
    expect(rows.map((row) => row.index)).toEqual([0, 1, 2]);
    // The row number is the one the terminal reports, so the item really is on
    // the line the click would land on.
    for (const row of rows) expect(lineAt(plain, row.row)).toContain(items[row.index]?.label);
  });

  it("skips a picker's headings, so no click can land on nothing", () => {
    const { frame } = draw({
      picker: {
        title: "Select model",
        items: [
          { label: "alpha", value: "alpha", group: "Recent" },
          { label: "beta", value: "beta", group: "Favorites" },
        ],
        selected: 0,
        query: "",
      },
    });

    const rows = frame.rows.filter((row) => row.kind === "picker");
    expect(rows.map((row) => row.index)).toEqual([0, 1]);
    // Two headings and a gap were drawn between them, and none of it is a row.
    expect(rows[1]!.row - rows[0]!.row).toBeGreaterThan(1);
  });

  it("reports the palette's rows against the list the keys step through", () => {
    const items = COMMANDS.slice(0, 4);
    const { frame, plain } = draw({ palette: { items, selected: 2 } });

    const rows = frame.rows.filter((row) => row.kind === "palette");
    expect(rows.map((row) => row.index)).toEqual([0, 1, 2, 3]);
    for (const row of rows) expect(lineAt(plain, row.row)).toContain(`/${items[row.index]?.name}`);
  });

  it("reports a menu's rows, counting past the group headings", () => {
    const { frame, plain } = draw({
      menu: {
        title: "Settings",
        rows: [
          { label: "Theme", value: "theme", trailing: "nord", group: "Appearance" },
          { label: "Animations", value: "animations", trailing: "on" },
          { label: "Sidebar", value: "sidebar", trailing: "auto", group: "Session" },
        ],
        selected: 1,
        query: "",
        footer: "‹/› change",
      },
    });

    const rows = frame.rows.filter((row) => row.kind === "menu");
    expect(rows.map((row) => row.index)).toEqual([0, 1, 2]);
    expect(lineAt(plain, rows[0]!.row)).toContain("Theme");
    expect(lineAt(plain, rows[2]!.row)).toContain("Sidebar");
  });

  it("counts every line of an option as the option it belongs to", () => {
    const { frame } = draw({
      ask: {
        questions: [
          {
            header: "Pick",
            question: "Which one?",
            options: [{ label: "one", description: "the first one" }, { label: "two" }],
          },
        ],
        index: 0,
        selected: 0,
        answers: [null],
      },
    });

    // The label, the line its description wrapped onto, and the second option.
    expect(frame.rows.filter((row) => row.kind === "ask").map((row) => row.index)).toEqual([0, 0, 1]);
  });

  it("reports only the transcript's own targets, and the card's when one is up", () => {
    // The transcript itself is not clickable; the targets an idle frame has
    // are the `[USAGE]` chip on the state row and the `[⚙]` button on the
    // footer's left end.
    expect(draw({ entries: conversation }).frame.rows.map((row) => row.kind)).toEqual([
      "usage_button",
      "settings_button",
    ]);
    // A card owns the screen: its own chips and the footer's close box are the
    // only things left to press.
    const card = draw({ entries: conversation, modal: permission() }).frame.rows;
    expect(card.map((row) => row.kind)).toEqual(["modal_choice", "modal_choice", "modal_choice", "close"]);
  });
});

describe("the menu panel", () => {
  const menu = (over: Partial<import("./menu").MenuPanel> = {}) => ({
    title: "Settings",
    rows: [
      { label: "Theme", value: "theme", trailing: "nord", group: "Appearance" },
      { label: "Animations", value: "animations", trailing: "on" },
      { label: "Sidebar", value: "sidebar", trailing: "auto", group: "Session" },
      { label: "TPS", value: "tps", trailing: "on" },
    ],
    selected: 0,
    query: "",
    footer: "‹/› change · esc close",
    ...over,
  });

  it("draws a title, the way out, a search field and a footer of its own", () => {
    const { plain } = draw({
      menu: menu({ description: "Colours for the whole screen.", descriptionWidth: 40 }),
    });

    const body = plain.join("\n");
    expect(body).toContain("Settings");
    // The title row and the footer both carry the way out, as a chip a mouse
    // can press rather than the word `esc`.
    expect(body).toContain("[×]");
    expect(body).toContain("Search");
    expect(body).toContain("‹/› change · [×] close");
    // The description of the highlighted row, so a value is never a mystery.
    expect(body).toContain("Colours for the whole screen.");
  });

  it("keeps the card width when the highlighted row — and its description — changes", () => {
    // The description names the row under the cursor, so sizing by the current
    // sentence resized the card on every hover: the whole panel jumped
    // sideways as the cursor moved. The card is sized by the widest sentence
    // instead, so every row fits and nothing moves. Geometry is leading
    // whitespace here — the card is centered, so any width change moves every
    // row's indent.
    const indents = (plain: string[]): number[] => plain.map((line) => line.length - line.trimStart().length);
    const rows = menu().rows;
    const short = draw({ menu: menu({ rows, selected: 0, description: "Short.", descriptionWidth: 64 }) });
    const long = draw({
      menu: menu({
        rows,
        selected: 2,
        description: "Whether the sidebar shows every session or just current ones.",
        descriptionWidth: 64,
      }),
    });

    // Both sentences fit in full — sizing by the longest means no truncation
    // anywhere, not just a steady width.
    expect(short.plain.join("\n")).toContain("Short.");
    expect(long.plain.join("\n")).toContain("or just current ones.");
    expect(indents(short.plain)).toEqual(indents(long.plain));
  });

  it("prints a heading above each run of rows, and names every value", () => {
    const { plain } = draw({ menu: menu() });
    const body = plain.join("\n");

    expect(body).toContain("Appearance");
    expect(body).toContain("Session");
    // A heading appears once, not above every row in the group.
    expect(body.split("Appearance")).toHaveLength(2);
    expect(body).toContain("Theme");
    expect(body).toContain("nord");
  });

  it("fills the band it is drawn on, and leaves the rows around it alone", () => {
    const { frame } = draw({ menu: menu() });

    const surface = bg(theme.panel);
    const band = frame.lines.filter((line) => line.includes(surface));
    // The whole surface: the title, the search field, the rows, the footer.
    expect(band.length).toBeGreaterThan(6);
    // And it does not reach the row below it, so the transcript's background
    // still frames it. (The row above is the tab bar, which is a panel too.)
    expect(frame.lines.at(-1)).not.toContain(surface);
    expect(frame.lines[1]).not.toContain(surface);
  });

  it("fills the highlighted row end to end, so the cursor is unmistakable", () => {
    const { frame } = draw({ menu: menu({ selected: 1 }) });

    const line = frame.lines.find((raw) => strip(raw).includes("Animations"));
    expect(line).toContain(styles.paletteSelected);
  });

  it("marks a row that is already set up with a tick", () => {
    const { plain } = draw({
      menu: menu({ rows: [{ label: "OpenAI", value: "openai", checked: true, trailing: "key in OPENAI_API_KEY" }] }),
    });

    expect(plain.join("\n")).toContain("✔ OpenAI");
  });

  it("says so when nothing matches what has been typed", () => {
    const { plain } = draw({ menu: menu({ rows: [], query: "chartreuse" }) });
    expect(plain.join("\n")).toContain("nothing matches");
  });

  it("takes the prompt away, because its own search field is where typing goes", () => {
    const { plain } = draw({ menu: menu() });
    expect(plain.join("\n")).not.toContain(PLACEHOLDER);
  });

  it("names the panel's keys on the panel, not on the session's footer", () => {
    const { plain } = draw({ menu: menu() });
    const footer = plain.at(-1) ?? "";

    expect(footer).not.toContain("ctrl+p");
  });

  it("fills the rows it is given even on a terminal too small for it", () => {
    for (const size of [
      { cols: 20, rows: 6 },
      { cols: 40, rows: 9 },
      { cols: 200, rows: 60 },
    ]) {
      const { frame } = draw({ menu: menu({ description: "Colours for the whole screen." }) }, size);
      expect(frame.lines, `${size.cols}x${size.rows}`).toHaveLength(size.rows);
    }
  });

  it("leaves air inside the card's edges, like the reference", () => {
    const { plain } = draw({ menu: menu() }, { cols: 120, rows: 30 });
    const title = plain.find((line) => line.includes("Settings")) ?? "";
    const theme = plain.find((line) => line.includes("Theme")) ?? "";
    const footer = plain.find((line) => line.includes("‹/›")) ?? "";
    // The card is one solid rectangle: every row runs the same width.
    const widths = new Set([title.length, theme.length, footer.length]);
    expect(widths.size).toBe(1);
    // With room to spare past the text — the fill does not hug the glyphs.
    for (const line of [title, theme, footer]) {
      expect(line.length - line.trimEnd().length).toBeGreaterThanOrEqual(2);
    }
    // And air above the title and below the footer: blank fill rows.
    const titleAt = plain.findIndex((line) => line.includes("Settings"));
    expect(plain[titleAt - 1]?.trim()).toBe("");
    const footerAt = plain.findIndex((line) => line.includes("‹/›"));
    expect(plain[footerAt + 1]?.trim()).toBe("");
  });

  it("blacks out the page behind the card instead of fading it", () => {
    const transcript: Entry[] = [
      { kind: "user", text: "why is the build failing?" },
      { kind: "assistant", text: "Because src/config.ts is missing a default." },
    ];
    const { plain } = draw({ menu: menu(), entries: transcript }, { cols: 120, rows: 30 });

    // The conversation is gone from the body — the modal owns the backdrop.
    // (The footer names no transcript text, so any match is the page showing.)
    expect(plain.join("\n")).not.toContain("why is the build failing?");
    expect(plain.join("\n")).toContain("Settings");
  });

  it("hugs its content instead of spreading to a fixed width", () => {
    const { plain } = draw({ menu: menu() }, { cols: 120, rows: 30 });
    // The card's own rows, not the tab bar or the state row below it.
    const card = plain.filter((line) => line.includes("Settings") || line.includes("Theme") || line.includes("‹/›"));
    const widest = Math.max(...card.map((line) => line.trimEnd().length - (line.length - line.trimStart().length)));

    // Five short rows must not make a 76-wide card: the air is what read as
    // shifted rather than centered.
    expect(widest).toBeLessThan(76);
  });

  it("floats centered as a modal, with the page around it", () => {
    const size = { cols: 120, rows: 30 };
    const { frame, plain } = draw({ menu: menu() }, size);

    // The card is capped, not full-width: page on both sides of every row.
    const row = plain.find((line) => line.includes("Theme")) ?? "";
    const left = row.length - row.trimStart().length;
    expect(left).toBeGreaterThan(2);
    expect(row.trimEnd().length).toBeLessThan(size.cols - 1 - 2);
    // And centered: roughly as much air left as right.
    expect(Math.abs(left - (size.cols - 1 - row.trimEnd().length))).toBeLessThanOrEqual(2);

    // The margins are page, not card fill: the centering offset must not wear
    // the panel surface to the screen's left edge (the smear that read as a
    // second panel beside the card). Pin surfaces, not columns.
    const raw = frame.lines.find((line) => strip(line).includes("Theme")) ?? "";
    const pageAt = raw.indexOf(bg(theme.bg));
    expect(pageAt).toBeGreaterThanOrEqual(0);
    expect(pageAt).toBeLessThan(raw.indexOf("Theme"));

    // Air above and below, not docked at the rule: the transcript's
    // background frames it on all four sides.
    const surface = bg(theme.panel);
    const first = frame.lines.findIndex((line) => line.includes(surface));
    const last = frame.lines.map((line) => line.includes(surface)).lastIndexOf(true);
    expect(first).toBeGreaterThan(1);
    expect(last).toBeLessThan(size.rows - 5);

    // The rows still report where they landed, so a press finds them.
    const hits = frame.rows.filter((r) => r.kind === "menu");
    expect(hits.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    for (const hit of hits) expect(plain[hit.row - 1]).toContain(menu().rows[hit.index]?.label ?? "");
  });
});

describe("the settings that change the display", () => {
  const transcript: Entry[] = [
    { kind: "user", text: "look at this", images: 2 },
    { kind: "thought", text: "First I read the file.\nThen I check the default.", ms: 1100, open: false, since: 0 },
    { kind: "assistant", text: "Because **config.ts** is missing a default." },
    { kind: "tool", name: "read", args: { file: "src/config.ts" } },
    { kind: "result", name: "read", content: "one\ntwo\nthree\nfour\nfive", isError: false },
    { kind: "meta", text: "Build · m · 3.9s · 17.7 tok/s" },
  ];

  const view = (over: Partial<ReturnType<typeof defaultViewSettings>> = {}) => ({ ...withTabs, ...over });
  // Tall enough for the whole transcript: these tests are about what a row
  // looks like, and a scrolled view would cut the row being asserted on.
  const tall = { cols: 80, rows: 40 } as const;
  const shown = (over: Partial<TuiState> = {}) => draw(over, tall).plain.join("\n");

  it("keeps the tab bar and +NEW accessible while sidebar is on or auto", () => {
    const auto = draw({ entries: [], settings: { ...withTabs, sidebar: "auto" } });
    expect(auto.plain[0]).toContain(NEW_TAB);
    const off = draw({ entries: [], settings: { ...withTabs, sidebar: "off" } });
    expect(off.plain[0]).not.toContain(NEW_TAB);
  });

  it("gives the row back to the transcript, so a hidden sidebar is not a wasted row", () => {
    const long: Entry[] = [];
    for (let i = 0; i < 60; i++) long.push({ kind: "assistant", text: `line ${i}` });

    // The oldest line still on screen: with the row back, it is one older.
    const oldest = (sidebar: "on" | "off"): number => {
      const { plain } = draw({ entries: long, settings: { ...withTabs, sidebar } }, tall);
      const first = plain.map((line) => /^line (\d+)$/.exec(line.trim())).find((match) => match);
      return Number(first?.[1] ?? NaN);
    };

    expect(oldest("off")).toBe(oldest("on") - 1);
  });

  it("drops the tab bar when it is turned off, whatever is running", () => {
    const { plain } = draw({
      tabs: [
        { id: "s1", title: "new session", current: true },
        { id: "s2", title: "build failure", current: false },
      ],
      settings: view({ sidebar: "off" }),
    });
    expect(plain[0]).not.toContain(NEW_TAB);
  });

  it("shows the model's reasoning, and hides it when asked", () => {
    expect(shown({ entries: transcript, settings: view() })).toContain("Thought: 1.1s");

    const hidden = shown({ entries: transcript, settings: view({ thinking: "hide" }) });
    expect(hidden).not.toContain("Thought");
    expect(hidden).not.toContain("First I read the file.");
  });

  it("hides the reasoning text, but keeps the heading, at low verbosity", () => {
    const body = shown({ entries: transcript, settings: view({ verbosity: "low" }) });

    expect(body).toContain("Thought: 1.1s");
    expect(body).not.toContain("First I read the file.");
  });

  it("prints an answer as typed when markdown is off", () => {
    expect(shown({ entries: transcript, settings: view() })).not.toContain("**");
    expect(shown({ entries: transcript, settings: view({ markdown: "raw" }) })).toContain("**config.ts**");
  });

  it("puts the pictures back on the request only when asked", () => {
    expect(shown({ entries: transcript, settings: view() })).toContain("[2 images]");

    const bare = shown({ entries: transcript, settings: view({ transcriptImages: "off" }) });
    expect(bare).not.toContain("[2 images]");
    expect(bare).toContain("look at this");
  });

  it("shows more of a tool's output at high verbosity", () => {
    const low = shown({ entries: transcript, settings: view({ verbosity: "low" }) });
    const high = shown({ entries: transcript, settings: view({ verbosity: "high" }) });

    expect(low).toContain("one");
    expect(low).not.toContain("two");
    expect(high).toContain("five");
  });

  it("draws a scrollbar only when the transcript is taller than the view", () => {
    expect(shown({ entries: transcript, settings: view() })).not.toContain("█");

    const long: Entry[] = [];
    for (let i = 0; i < 40; i++) long.push({ kind: "assistant", text: `line ${i}` });
    expect(draw({ entries: long, settings: view() }).plain.join("\n")).toContain("█");
    expect(draw({ entries: long, settings: view({ scrollbar: "off" }) }).plain.join("\n")).not.toContain("█");
  });
});

describe("picker close chip", () => {
  it("generates a close chip hit target on the picker title row", () => {
    const p: Picker = {
      title: "Models",
      items: [{ label: "Model A", value: "a" }],
      query: "",
      selected: 0,
    };
    const { frame } = draw({ picker: p });
    const closeHit = frame.rows.find((r) => r.kind === "close");
    expect(closeHit).toBeDefined();
    expect(closeHit?.colStart).toBeGreaterThan(0);
    expect(closeHit?.colEnd).toBeGreaterThan(closeHit?.colStart!);
  });
});
