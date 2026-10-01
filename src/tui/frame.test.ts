import { describe, expect, it } from "vitest";
import { bg, textWidth } from "./ansi";
import { LineEditor } from "./editor";
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
} from "./frame";
import { defaultViewSettings, type Spacing } from "./settings";
import { buildStyles, darkTheme } from "./theme";
import type { Entry } from "./transcript";

const styles = buildStyles(darkTheme);
const theme = darkTheme;

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

describe("frame geometry", () => {
  it("fills exactly the rows it is given", () => {
    for (const rows of [24, 12, 8, 6]) {
      expect(draw({}, { cols: 80, rows }).frame.lines).toHaveLength(rows);
    }
  });

  it("never draws into the last column", () => {
    // Writing the final cell can make the terminal wrap and scroll, which would
    // shift the whole UI by a row.
    const { plain } = draw({ modal: { title: "x".repeat(200), body: [], options: "y".repeat(200) } });

    for (const line of plain) expect(textWidth(line)).toBeLessThanOrEqual(79);
  });

  it("cannot be scrolled by the text it is showing", () => {
    // A tab is one cell in the maths and several on screen, and an escape
    // sequence could move the cursor outright. Either overruns the row, and an
    // overrun row wraps — which shifts the entire frame up by a line. The text
    // in a permission prompt is a file's contents, so it is the text least
    // under KiCode's control.
    const { frame, plain } = draw({
      modal: {
        title: "edit wants to run",
        body: [{ text: "edit src/a.ts" }, { text: "\n-\tconst a = 1;\u001b[2J\u001b[H" }],
        options: "allow?  y yes · a always · n no",
      },
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
    // Rows: separator, the box's top padding, the input, the status row, the
    // box's bottom padding, the footer — so the input is fourth from the end.
    expect(frame.caret?.row).toBe(24 - 4);
    expect(frame.caret?.col).toBeLessThan(80);
  });

  it("paints a mouse drag with the accent selection fill, not inverse video", () => {
    // Inverse video is invisible on some terminals; the palette's accent fill
    // is not, and it is the same language the UI already uses for "picked out".
    // The prompt input sits on screen row 21 of a 24-row frame; the drag spans
    // "hello" (cols 8-13), which the highlight splits into its own styled run.
    const editor = new LineEditor();
    editor.insert("hello world");
    const { frame, plain } = draw({ editor, selection: { from: { row: 21, col: 8 }, to: { row: 21, col: 13 } } });
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
    const { frame } = draw({ modal: { title: "bash wants to run", body: [], options: "allow?" } });

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
    const { plain } = draw({ entries: conversation });

    // Rows: 0 the tabs, then the body, then the separator, the box's padding,
    // the input, the status row, the box's padding and the footer.
    expect(plain[24 - 7]).toContain("missing a default");
    expect(plain[24 - 6]).toContain("─");
    expect((plain[24 - 5] ?? "").trim()).toBe("▌");
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
});

describe("the bottom bar", () => {
  it("names the mode, the model and the variant", () => {
    const lines = draw({ model: "gpt-5.6-luna", variant: "high" }).plain;
    const row = lines.findIndex((line) => line.includes("Build"));

    expect(lines[row]?.trimStart()).toBe("▌ Build · gpt-5.6-luna · high");
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

    expect(footer.trimStart().startsWith("C:\\dev\\kicode")).toBe(true);
    expect(footer).toContain("↓ 4 tools");
    expect(footer).toContain("304.8K");
    expect(footer).toContain("(29%)");
    expect(footer.trimEnd().endsWith("ctrl+p commands")).toBe(true);
  });

  it("says nothing about usage before anything is spent", () => {
    const footer = draw({ usage: { tokens: 0, budget: 128_000, tools: 0 } }).plain.at(-1) ?? "";

    expect(footer).toContain("ctrl+p commands");
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
    // The cursor is parked on /cd, so the first three rows are unselected.
    const { frame, plain } = draw({ palette: { items: COMMANDS, selected: 2 } }, { cols: 80, rows: 30 });
    const agents = plain.findIndex((line) => line.includes("/agents"));
    const btw = plain.findIndex((line) => line.includes("/btw"));

    // /agents exists in the list but is not available here, so it is drawn in
    // the faint colour rather than the accent one.
    expect(frame.lines[agents]).toContain(styles.faint);
    expect(frame.lines[agents]).not.toContain(styles.accent);
    expect(frame.lines[btw]).toContain(styles.accent);
  });

  it("leaves unselected rows on the panel background", () => {
    const { frame } = draw({ palette });
    const row = frame.lines.find((line) => line.includes(`/${items[0]?.name}`)) ?? "";

    expect(row).not.toContain("48;2;45;212;191");
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
    expect(plain.at(-1)).toContain("ctrl+p");
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

  it("draws the row under the cursor in the panel, not the list", () => {
    const { plain } = draw({ picker });
    const cursor = plain.find((line) => line.includes("glm-5.3")) ?? "";

    expect(cursor).toContain("▌");
    expect(cursor).toContain("paid");
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

  it("is drawn inside a frame, inset from the edges", () => {
    const { plain } = draw({ picker });
    const rows = plain.filter((line) => line.includes("│") || line.includes("┌") || line.includes("└"));

    expect(rows.length).toBeGreaterThan(4);
    expect(plain.join("\n")).toContain("┌");
    expect(plain.join("\n")).toContain("└");
  });

  it("replaces the transcript while something is being chosen", () => {
    const text = draw({ picker, entries: conversation }).plain.join("\n");

    expect(text).not.toContain("why is the build failing?");
  });

  it("offers its own keys in the footer", () => {
    const text = draw({ picker }).plain.join("\n");

    expect(text).toContain("↑↓ select");
    expect(text).toContain("enter confirm");
    expect(text).toContain("esc close");
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
    const { plain } = draw(
      { picker: { title: "Select model", query: "", items, selected: 25 } },
      { cols: 80, rows: 12 },
    );
    // The item rows carry the cursor and the current-dot; the search field's
    // own block is a different row.
    const cursor = plain.find((line) => line.includes("▌  ")) ?? "";

    expect(cursor).toContain("m25");
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

describe("the mode row", () => {
  it("names the mode, and warns once it is not the everyday one", () => {
    expect(draw({ mode: "build" }).plain.join("\n")).toContain("Build");

    const plan = draw({ mode: "plan" });
    expect(plan.plain.join("\n")).toContain("Plan");
    // The mode is a capability, not a label: plan mode is worth noticing.
    expect(plan.frame.lines.join("\n")).toContain(styles.warn);
  });

  it("keeps the model and the mode on the same row", () => {
    const row = draw({ mode: "plan" }).plain.find((line) => line.includes("Plan")) ?? "";

    expect(row).toContain("deepseek-v4-flash:free");
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
    expect(text).toContain("esc dismiss");
    expect(text).not.toContain("ctrl+p");
  });

  it("offers the input line only while an answer is being typed", () => {
    const options = panel().plain;
    // No prompt row: the keys belong to the panel, and the footer says so.
    expect(options.join("\n")).not.toContain(PLACEHOLDER);
    expect(options.at(-1)).toContain("esc dismiss");

    const editor = new LineEditor();
    editor.insert("Inter");
    const { frame, plain } = panel({ askTyping: true, editor });
    const typing = plain.join("\n");

    expect(typing).toContain("▌ Inter");
    expect(typing).toContain("esc cancel");
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
    expect(plain.at(-1)).toContain("esc dismiss");
  });
});

describe("the approval modal", () => {
  const modal = {
    title: "bash wants to run",
    body: [{ text: "+ npm test" }],
    options: "allow?  y yes · a always · n no",
  };

  it("replaces the prompt with the request", () => {
    const text = draw({ modal }).plain.join("\n");

    expect(text).toContain("bash wants to run");
    expect(text).toContain("+ npm test");
    expect(text).toContain("allow?");
    expect(text).not.toContain(PLACEHOLDER);
  });

  it("names the keys the request does not: escape and ctrl+c", () => {
    const text = draw({ modal }).plain.join("\n");

    expect(text).toContain("esc deny");
    // Escape only denies; ctrl+c denies and stops the turn, which is the one
    // difference that makes it worth pressing here, so the hint names it.
    expect(text).toContain("ctrl+c deny + stop");
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

    expect(footer).toContain("esc deny");
    expect(footer).toContain("ctrl+c deny + stop");
    expect(footer).not.toContain("esc dismiss");
  });

  it("keeps the decision row and its hint on a terminal too short for the preview", () => {
    // The body is the only part that may be cut: losing the `allow?` row or the
    // hint would leave a prompt that does not say how to answer it.
    const long: ApprovalModal = {
      title: "edit wants to run",
      body: Array.from({ length: 40 }, (_, i) => ({ text: `${i === 0 ? "" : "\n"}${i % 2 === 0 ? "-" : "+"} line ${i}` })),
      options: "allow?  y yes · a always · n no",
    };

    for (let rows = 6; rows <= 30; rows++) {
      const { frame, plain } = draw({ modal: long }, { cols: 80, rows });        expect(frame.lines).toHaveLength(rows);
        expect(plain.at(-1)).toContain("esc deny");
        expect(plain.at(-1)).toContain("ctrl+c deny + stop");
        expect(plain.join("\n")).toContain("allow?");
      expect(plain.join("\n")).toContain("edit wants to run");
    }
  });

  it("says how much of a preview it had to cut", () => {
    const long: ApprovalModal = {
      title: "edit wants to run",
      body: Array.from({ length: 40 }, (_, i) => ({ text: `${i === 0 ? "" : "\n"}+ line ${i}` })),
      options: "allow?  y yes · a always · n no",
    };
    const text = draw({ modal: long }).plain.join("\n");

    // Five lines of the six-row body, and the sixth counts the remainder.
    expect(text).toContain("… 35 more lines");
  });

  it("floats centered instead of sitting where the prompt was", () => {
    const { plain } = draw({ modal });

    // Three card rows (title, one body line, options) on a 24-row screen.
    const row = plain.findIndex((line) => line.includes("bash wants to run"));
    expect(row).toBe(Math.floor((24 - 3) / 2));
    // Narrower than the screen, with air on the left: a card, not a band.
    expect(plain[row]?.startsWith("   ▌")).toBe(true);
  });

  it("keeps the tab bar and the footer visible around the card", () => {
    const { plain } = draw({ modal });

    expect(plain[0]).toContain(NEW_TAB);
    expect(plain.at(-1)).toContain("esc deny");
  });

  it("stays quiet when the preview fits", () => {
    // The marker is a lie when nothing was left out, and it costs a row.
    const text = draw({ modal }).plain.join("\n");

    expect(text).not.toContain("more line");
  });

  it("counts the marker itself among the lines it hid", () => {
    // Six rows of body: five from the diff and one to say what was cut, so the
    // seven-line preview leaves two lines unshown rather than one.
    const justOver: ApprovalModal = {
      title: "edit wants to run",
      body: [{ text: "edit src/a.ts" }].concat(
        Array.from({ length: 6 }, (_, i) => ({ text: `\n+ line ${i}` })),
      ),
      options: "allow?",
    };

    expect(draw({ modal: justOver }).plain.join("\n")).toContain("… 2 more lines");
  });
});

describe("the blocks", () => {
  const block = bg(theme.block);
  const panel = bg(theme.panel);

  it("draws a user turn as a filled block with one straight left edge", () => {
    const { frame, plain } = draw({ entries: [{ kind: "user", text: "why is the build failing?" }] });

    const filled = frame.lines.filter((line) => line.includes(block));
    // Padding above and below the text, all of it part of the same block.
    expect(filled.length).toBeGreaterThanOrEqual(3);
    for (const row of filled) expect(strip(row).trimStart().startsWith("▌")).toBe(true);
    expect(plain.join("\n")).toContain("why is the build failing?");
    expect(plain.join("\n")).toContain("▌");
  });

  it("gives a one-line request a five-row panel", () => {
    const { frame } = draw({ entries: [{ kind: "user", text: "hi" }] });

    const filled = frame.lines.filter((line) => line.includes(block));
    // Two rows of padding, the text, two more: one row of padding still reads
    // as a line that happens to be tall.
    expect(filled).toHaveLength(5);
    expect(strip(filled[2] ?? "")).toContain("hi");
    for (const row of [filled[0], filled[1], filled[3], filled[4]]) {
      expect((strip(row ?? "")).trim()).toBe("▌");
    }
  });

  it("keeps the bar and the fill together on a wrapped turn", () => {
    const { frame, plain } = draw({ entries: [{ kind: "user", text: "x".repeat(200) }] }, { cols: 40, rows: 20 });

    const filled = frame.lines.filter((line) => line.includes(block));
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
    expect(frame.lines.join("\n")).not.toContain(block);
  });

  it("fills the prompt box and its mode row as one surface", () => {
    const { frame, plain } = draw({});

    const prompt = frame.lines.find((line) => strip(line).includes(PLACEHOLDER));
    const mode = frame.lines.find((line) => strip(line).includes("Build"));
    expect(prompt).toContain(panel);
    expect(mode).toContain(panel);
    // The footer goes back to the background: the box is the box.
    const footer = frame.lines.find((line) => strip(line).includes("ctrl+p commands"));
    expect(footer).not.toContain(panel);
  });

  it("leaves a blank row between entries, and one more around a request", () => {
    const { plain } = draw({
      entries: [
        { kind: "user", text: "hi" },
        { kind: "assistant", text: "Hello." },
        { kind: "note", text: "Switched model", tone: "dim" },
        { kind: "user", text: "again" },
      ],
    });

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
    const { frame } = draw({
      modal: { title: "bash wants to run", body: [{ text: "run: ls -la" }], options: "allow?  y yes · a always · n no" },
    });

    // The tab bar is on the same surface, so the box is what comes after it.
    const box = frame.lines.slice(1).filter((line) => line.includes(panel));
    // The title, the body, the options, and the state row under them.
    expect(box.length).toBeGreaterThanOrEqual(4);
    for (const line of box) {
      expect(line).toContain(styles.warn);
      expect(line).toContain("▌");
    }
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

  it("puts the request bar, the tool rule and the prompt bar in one column", () => {
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
      expect(columnOf("Ask anything", "▌")).toBe(request);
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

  it("says nothing is clickable when only the transcript is on screen", () => {
    expect(draw({ entries: conversation }).frame.rows).toEqual([]);
    expect(draw({ entries: conversation, modal: { title: "bash wants to run", body: [], options: "allow?" } }).frame.rows).toEqual(
      [],
    );
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
    const { plain } = draw({ menu: menu({ description: "Colours for the whole screen." }) });

    const body = plain.join("\n");
    expect(body).toContain("Settings");
    expect(body).toContain("esc");
    expect(body).toContain("Search");
    expect(body).toContain("‹/› change · esc close");
    // The description of the highlighted row, so a value is never a mystery.
    expect(body).toContain("Colours for the whole screen.");
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

  it("keeps the tab bar out of the way while there is one session", () => {
    const auto = draw({ entries: [], settings: { ...withTabs, sidebar: "auto" } });
    expect(auto.plain[0]).not.toContain(NEW_TAB);
    // And with two sessions it comes back on its own.
    const two = draw({
      tabs: [
        { id: "s1", title: "new session", current: true },
        { id: "s2", title: "build failure", current: false },
      ],
      settings: { ...withTabs, sidebar: "auto" },
    });
    expect(two.plain[0]).toContain(NEW_TAB);
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
