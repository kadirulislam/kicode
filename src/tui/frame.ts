import {
  type Span,
  ERASE_TO_EOL,
  RESET,
  bg,
  charWidth,
  markCells,
  padSpans,
  renderSpans,
  span,
  spansWidth,
  stripAnsi,
  textWidth,
  SPINNER,
  truncateSpans,
  wrapSpans,
} from "./ansi";
import { COMMAND_WIDTH, isAvailable, type Command } from "./commands";
import { type LineEditor, editorRows } from "./editor";
import { LOGO_TEXT, logoRows } from "./logo";
import type { PlanSnapshot } from "../agent/tools/types";
import type { MenuPanel, MenuRow } from "./menu";
import { type ViewSettings, defaultViewSettings } from "./settings";
import { blend, type Styles, type Theme } from "./theme";
import { type Entry, entrySpans } from "./transcript";

/**
 * Layout, as a pure function: state + terminal size -> the exact rows to draw.
 *
 * Nothing here touches the terminal, so the whole screen is unit-testable —
 * which matters for a UI that cannot be checked by refreshing a browser.
 */

export type TabInfo = { id: string; title: string; current: boolean; busy?: boolean };

/**
 * Where a tab sits on the first row, in columns, so a click can be placed.
 *
 * `closeStart` is where the × begins: a press at or after it closes the tab,
 * and anywhere before it switches to it — the same split a browser tab has.
 */
export type TabHit = {
  id: string;
  start: number;
  closeStart: number;
  end: number;
};

/** One thing a card offers, and the key that offers it. */
export type ModalChoice = {
  /** The key that answers with this choice. `esc` is drawn as the close chip. */
  key: string;
  /** What it does, printed beside the chip. */
  label: string;
};

export type Modal = {
  /** e.g. `bash wants to run` */
  title: string;
  body: Span[];
  /** The question the choices answer, when there is one — `allow?`. */
  question?: string;
  /** The keys the card offers, in the order they are drawn. */
  choices: readonly ModalChoice[];
  /**
   * The keys the card does *not* name, for the session's footer. Between them
   * the two name every key exactly once, and `esc` is a chip in both places.
   */
  footer?: readonly (readonly [string, string])[];
  /** Optional tone for the card: "error" gives an alert red theme and border. */
  tone?: "warn" | "error" | "accent";
};

/** The slash-command list, floating above the prompt. */
export type Palette = {
  items: readonly Command[];
  selected: number;
};

/** One `@` completion row: the label (without the `@`), its kind and a note. */
export type MentionRow = {
  label: string;
  description?: string;
  kind: string;
};

/** The `@` completion list, floating above the prompt like the palette. */
export type MentionPopup = {
  items: readonly MentionRow[];
  selected: number;
};

/**
 * A list the user picks one thing from — a model, a theme, a message to jump
 * to. It replaces the transcript rather than sitting above the prompt, because
 * choosing is then the only thing left to do.
 */
export type Picker = {
  title: string;
  /** Already filtered by `query` — the renderer draws what it is handed. */
  items: readonly PickItem[];
  selected: number;
  /** What is in the search field. */
  query: string;
  /** Extra keys the panel names on its own last row, if any. */
  hints?: readonly (readonly [string, string])[];
  /**
   * Filters across the top of the panel, e.g. `all · free · paid`.
   *
   * The list is rebuilt by the caller when the active tab changes; this layer
   * only draws which one is on. Nothing here filters anything.
   */
  tabs?: { labels: readonly string[]; active: number };
  /** Whether the picker has a search input field. Defaults to true. */
  searchable?: boolean;
  /** Placeholder text when search field is empty. Defaults to "Search". */
  placeholder?: string;
  /** Position of modal box: "center" (default) or "top" (for tab context menus). */
  position?: "center" | "top" | "bottom";
  /** When present, pressing Enter submits the query string. */
  onSubmitQuery?: (query: string) => void | Promise<void>;
};

export type PickItem = {
  label: string;
  description?: string;
  /** What the command is handed back when this row is chosen. */
  value: string;
  /**
   * Right-aligned on the row, in the faint colour: a price, a tier, a date.
   * Being on the right is what lets the eye compare a whole column of them.
   */
  trailing?: string;
  /**
   * Matched by the search but never drawn: a session's opening request, a
   * model id — text that finds the row without deserving a column.
   */
  keywords?: string;
  /**
   * A heading printed above this row, grouping it with the rows that follow.
   * Only the first row of a run carries one.
   */
  group?: string;
  /** The one in use now, marked so the current choice is recognisable. */
  current?: boolean;
  /**
   * Shown but not choosable — a provider that could not be reached, or one
   * with no models. It stays in the list because a provider that is missing is
   * the thing you most need to see, and it is skipped by the arrow keys.
   */
  disabled?: boolean;
};

/**
 * The nearest row the keys may land on, skipping what cannot be chosen.
 *
 * Returns where it started when every row is disabled, so a list of nothing but
 * notes cannot leave the cursor nowhere.
 */
export function stepPick(items: readonly PickItem[], from: number, delta: number): number {
  if (items.length === 0) return 0;

  const start = Math.min(Math.max(from, 0), items.length - 1);
  for (let step = 1; step <= items.length; step++) {
    const index = (((start + delta * step) % items.length) + items.length) % items.length;
    if (!items[index]?.disabled) return index;
  }
  return start;
}

/**
 * Rows matching what has been typed into the search field.
 *
 * The label, the description and the trailing note are all searched: the tier a
 * model is on and the price beside it are as likely to be what someone types as
 * the name is.
 */
export function filterPickItems(items: readonly PickItem[], query: string): PickItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];

  return items.filter((item) =>
    `${item.label} ${item.description ?? ""} ${item.trailing ?? ""} ${item.keywords ?? ""}`.toLowerCase().includes(needle),
  );
}

/**
 * A question the model is asking, and the state of answering it.
 *
 * The options are already the display list — the free-text row is appended by
 * the caller, so this layer only draws what it is handed.
 */
export type AskPanel = {
  questions: readonly { header: string; question: string; options: readonly { label: string; description?: string }[] }[];
  /** Which question is on screen. */
  index: number;
  /** Highlighted option of the current question. */
  selected: number;
  /** Chosen label per question, or null while unanswered. */
  answers: readonly (string | null)[];
};

export type TuiState = {
  /** The text the user has dragged over, if any. */
  selection?: Selection | null;
  tabs: readonly TabInfo[];
  /** Tab currently hovered by mouse pointer */
  hoverTabId?: string | null;
  /** Whether the mouse is hovering over the close box (x) specifically */
  hoverClose?: boolean;
  entries: readonly Entry[];
  editor: LineEditor;
  /** Number of attached images awaiting submission with the next prompt. */
  attachedImages?: number;
  /** Names of attached documents (`/attach`), shown beside the image badges. */
  attachedDocs?: readonly string[];
  /** Spinner label while a turn is in flight. */
  busy: string | null;
  spinnerFrame: number;
  model: string;
  messageCount: number;
  compacting: boolean;
  cwd: string;
  version: string;
  /** Connected MCP servers, shown on the home screen. */
  mcp: string | null;
  /** Config files in use, so "why this model?" always has an answer. */
  config: string | null;
  /** Transient one-liner, such as a denial or a warning. */
  notice: Span | null;
  modal: Modal | null;
  palette: Palette | null;
  /** Set while an `@query` in the prompt has completions to offer. */
  mentions?: MentionPopup | null;
  /** Set while the model is waiting on an answer. */
  ask: AskPanel | null;
  /** True once the user picked the free-text option and is typing. */
  askTyping: boolean;
  /** Set while the user is choosing from a list. */
  picker: Picker | null;
  /**
   * A full-screen menu over the transcript — `/settings`, `/connect`.
   *
   * Separate from `picker` because a menu's rows carry a value that is changed
   * in place rather than a choice that closes the panel, and because both of
   * them are drawn as one filled surface rather than as a bordered list.
   */
  menu?: MenuPanel | null;
  /** Set while the clipboard & attachment options menu is open in the chat input area. */
  clipboardMenu?: ClipboardMenuState | null;
  /** Whether execution is currently paused. */
  isPaused?: boolean;
  /** Number of queued messages waiting to execute. */
  queuedCount?: number;
  /** The plan tools' state, for the progress button and its panel. */
  plan?: PlanSnapshot | null;
  /** True while the plan panel is open above the box. */
  todoPanel?: boolean;
  /**
   * The queued messages themselves, drawn as tiles above the box.
   *
   * The count says a queue exists; these say what is in it, so a message queued
   * by mistake can be seen and dropped before it runs — or pushed into the turn
   * already running, when waiting for it would be too late.
   */
  queue?: readonly string[];
  /** What the screen shows. Absent means the defaults, which a test relies on. */
  settings?: ViewSettings;
  /** Reasoning effort for this session, shown next to the model. */
  variant: string;
  /** Build or plan; what the agent is currently allowed to do. */
  mode: SessionMode;
  /** True while a `/goal` run is executing — shows "Goal" in the mode pill. */
  goalActive?: boolean;
  /** What the session has cost so far, for the footer. */
  usage: { tokens: number; budget: number; tools: number };
  /** Lines scrolled up from the newest. */
  scroll: number;
  /** Entry index pinned to the top of the view, or null to follow the tail. */
  anchor: number | null;
  /** Unmistakable feedback when text is copied. */
  copiedNotice?: string | null;
};

/**
 * How a session works: it builds, or it only plans.
 *
 * The distinction is not cosmetic — plan mode is enforced in the agent, which
 * refuses the tools that change files or run commands — so the mode is a real
 * capability, and the row that names it is the one place it is visible.
 */
export type SessionMode = "build" | "plan";

export const MODES: readonly SessionMode[] = ["build", "plan"];

/** The word drawn in the mode pill, and on the state row while there is no box. */
export const MODE_LABELS: Record<SessionMode, string> = { build: "Build", plan: "Plan" };

/** The mode `shift+tab` moves to, cycling through them all. */
export function nextMode(mode: SessionMode): SessionMode {
  const at = MODES.indexOf(mode);
  return MODES[(at + 1) % MODES.length] ?? "build";
}

export type Size = { cols: number; rows: number };

export type ScrollbarInfo = {
  topRow: number;
  bottomRow: number;
  col: number;
  maxScroll: number;
};

/**
 * Where the prompt box sits, and which text each of its rows shows.
 *
 * A mouse needs both: the box's own edges say where the chrome under the rule
 * begins, and the code-unit range each row carries is what turns a click into a
 * caret position. The same row maps to a different offset once the text wraps,
 * so the renderer — the only thing that knows where the breaks landed — reports
 * them rather than leaving the app to guess.
 */
export type PromptBox = {
  /** Screen row of the box's top bar row. */
  top: number;
  /** Screen row of the box's bottom bar row. */
  bottom: number;
  /** The column the text starts in, 1-based, badges included. */
  textLeft: number;
  /** One entry per text row: its screen row, and the text it shows. */
  rows: { row: number; start: number; end: number }[];
  /**
   * The mode pill on the box's left edge, in the columns it was drawn in.
   *
   * The pill is the mode's own word, so its width is not knowable from
   * outside the renderer — the caller presses it by these numbers instead of
   * working the arithmetic out a second time.
   */
  modeButton: { row: number; colStart: number; colEnd: number };
  /** The upload button at the box's right edge, in the columns it was drawn in. */
  uploadButton: { row: number; colStart: number; colEnd: number };
};

export type RenderedFrame = {
  /** Exactly `rows` strings, each already styled. */
  lines: string[];
  /** The same rows with every escape sequence taken out, for copying. */
  text: string[];
  /** Where the terminal caret belongs, or null to leave it hidden. */
  caret: { row: number; col: number } | null;
  /** The tab bar's click targets, in the same order as the tabs. */
  tabs: TabHit[];
  /** Every panel row a click can land on, in screen rows (1-based). */
  rows: PanelRow[];
  /**
   * The rows a drag can select, as 1-based screen rows.
   *
   * The conversation, and not the chrome under the rule: the prompt box, the
   * state row and the footer are about the session rather than part of it, and
   * nothing there is something you would paste anywhere.
   */
  selectable: { top: number; bottom: number };
  /** Scrollbar geometry when visible, for mouse dragging/clicking. */
  scrollbar?: ScrollbarInfo | null;
  /** The prompt box's rows when it is on screen, for clicks that place the caret. */
  prompt: PromptBox | null;
};

/** A cell of the screen, in the coordinates a terminal reports a mouse in. */
export type Cell = { row: number; col: number };

/**
 * A run of text the user dragged over.
 *
 * Both ends are kept, rather than a normalised pair, because which one was the
 * anchor is not knowable from the other two — and the highlight only needs to
 * know the extremes, so it normalises for itself.
 */
export type Selection = { from: Cell; to: Cell };

/** Which panel a clickable row belongs to. */
export type PanelKind =
  | "picker"
  | "menu"
  | "palette"
  | "ask"
  | "picker_tab"
  | "jump_bottom"
  | "clipboard_menu"
  /** A `[×]` chip: the escape key, somewhere a mouse can reach it. */
  | "close"
  /** One of a card's own decision chips, by its place in `Modal.choices`. */
  | "modal_choice"
  /** The `[x]` on a queued message's tile, by its place in the queue. */
  | "queued"
  /** The `[Add+]` on a queued tile: hand that message to the turn in flight. */
  | "queued_add"
  /** The `TODO [n/m]` chip on the state row, which opens the plan panel. */
  | "todo_button"
  /** The `[USAGE]` chip on the state row, which opens this session's usage. */
  | "usage_button";

export type ClipboardMenuState = {
  items: readonly PickItem[];
  selected: number;
  preview?: {
    kind: "text" | "image" | "empty";
    text?: string;
    lines?: string[];
    totalLines?: number;
    totalChars?: number;
    image?: {
      mime: string;
      bytes: number;
      width?: number;
      height?: number;
      grid?: string[];
      pixelRows?: { text: string; style: string }[][];
    };
  };
};

/**
 * A row of a panel that a click can land on.
 *
 * `index` is the row's place in the panel's *own* list — the same number Enter
 * acts on — not its position on screen, because those two part company the
 * moment a list is filtered or scrolled, and acting on the wrong one of them is
 * the whole failure mode of a click. Headings, blank rows and the panel's own
 * chrome are simply not reported.
 */
export type PanelRow = {
  kind: PanelKind;
  /** Screen row, 1-based, numbered the way a terminal reports a mouse click. */
  row: number;
  index: number;
  colStart?: number;
  colEnd?: number;
};

/** The same thing before the frame has turned it into a screen row. */
type Hit = { kind: PanelKind; row: number; index: number; colStart?: number; colEnd?: number };

/** A drawn panel: its rows, and which of them can be clicked. */
type Panel = { lines: BodyLine[]; hits: Hit[]; scrollbarMax?: number };

const BAR = "▌";
/**
 * How much air sits between things is *not* here.
 *
 * It is `view.spacing` — the request block's padding and the two entry gaps —
 * so density is a line in `kicode.json` rather than a constant somebody has to
 * rebuild to change. The defaults live beside the type, in `settings.ts`.
 */
/** The thin left rule that ties a run of tool output together. */
const RULE = "│";
/** Keeps a redraw cheap on a very long conversation. */
const MAX_TRANSCRIPT_LINES = 4000;
/** Blank cells of block colour after the widest text row of a request block. */
const BLOCK_PAD = 2;
const MODAL_BODY_LINES = 6;
/** The glyph in a tab that closes it. */
export const TAB_CLOSE = "×";
/** Marks a tab with a turn running in it — the session working in the background. */
const TAB_BUSY = "◐ ";
/** A tab title longer than this is cut, so one name cannot push the rest off. */
const TAB_TITLE_MAX = 18;
/** Stands in for "a new session" in the tab bar, and is clickable too. */
export const NEW_TAB = "+NEW";
/** Shown in the status row until the variant is changed. */
export const DEFAULT_VARIANT = "default";

export const PLACEHOLDER = "Ask anything...";

export function renderFrame(state: TuiState, size: Size, styles: Styles, theme: Theme): RenderedFrame {
  const cols = Math.max(size.cols, 20);
  const rows = Math.max(size.rows, 6);

  // The final cell of every row is left unpainted: writing it can trigger the
  // terminal's own wrap, which scrolls the screen and corrupts the layout.
  const usable = cols - 1;
  const margin = cols >= 50 ? 2 : 0;

  // The palette takes the room it needs, leaving the tab bar, the rule, the
  // prompt, the status and the footer their five rows.
  const paletteRoom = Math.max(rows - 6, 1);
  const bottom = renderBottom(state, styles, theme, usable - margin - 2, usable, margin, paletteRoom);
  // The tab bar is the session sidebar, so the setting can take its row back:
  // with one session there is nothing in it but a label.
  const showTabs = sidebarShown(state);
  const tabRow = showTabs ? renderTabs(state, styles, usable) : { spans: [] as Span[], hits: [] };

  const bodyRows = Math.max(rows - (showTabs ? 1 : 0) - bottom.lines.length, 0);
  // A picker or a menu is a card laid **over** the page, not instead of it: the
  // conversation stays where it was and steps back, so opening `/models` does
  // not wipe the screen the user was reading. The page behind is drawn from the
  // same state with the panel taken out, and every row the card does not cover
  // is faded — the card is the only thing at full strength.
  const overlay = Boolean(state.picker || state.menu);
  const page = overlay ? renderBody({ ...state, picker: null, menu: null }, styles, theme, usable - margin, bodyRows, usable, margin) : null;
  const body = page ?? renderBody(state, styles, theme, usable - margin, bodyRows, usable, margin);
  const card = overlay ? renderBody(state, styles, theme, usable - margin, bodyRows, usable, margin) : null;

  const tabRowCount = showTabs ? 1 : 0;
  const allRows: BodyLine[] = [];
  /** Rows the card covers, which keep their own colour while the rest fades. */
  const cardRows = new Set<number>();
  if (showTabs) {
    allRows.push({ spans: tabRow.spans, background: theme.panel });
  }
  for (let i = 0; i < bodyRows; i++) {
    const cardLine = card?.lines[i];
    const line = body.lines[i];
    // A card row carrying text covers the page; the card's own blank padding
    // rows let the faded page show through around it.
    if (cardLine && cardLine.spans.length > 0) {
      allRows.push({ spans: cardLine.spans, background: cardLine.background ?? theme.panel, page: cardLine.page ?? theme.bg });
      cardRows.add(allRows.length - 1);
    } else {
      allRows.push({ spans: line?.spans ?? [], background: line?.background ?? theme.bg, page: line?.page ?? theme.bg });
    }
  }
  for (const bRow of bottom.rows) {
    allRows.push(bRow);
  }

  // Only the page behind fades — the tab bar and the transcript. The rows under
  // the rule are the input area's own chrome (the mode row and the footer), and
  // they keep their colour: they are what the card is standing on, and the
  // permission card is deliberately one box with the state row under it.
  const pageRows = tabRowCount + bodyRows;
  if (overlay) {
    for (const [index, row] of allRows.entries()) {
      if (index >= pageRows || cardRows.has(index)) continue;
      allRows[index] = fadeRow(row, styles, theme);
    }
  }

  const lines: string[] = [];
  for (let i = 0; i < allRows.length; i++) {
    const r = allRows[i]!;
    const screenRow = i + 1;
    const spans = state.selection ? selectRow(r.spans, screenRow, state.selection, styles) : r.spans;
    const pageBg = r.page ?? (r.background === theme.block ? theme.bg : r.background);
    lines.push(paint(spans, r.background, usable, pageBg));
  }

  // A backstop, not a policy: the room budgets above mean the bottom block and
  // the tab bar always fit, so nothing is ever dropped from the tail. Popping
  // here would cut the newest rows first — which, with a permission prompt up,
  // is the row that says how to answer it.
  while (lines.length > rows) lines.pop();
  while (lines.length < rows) lines.push(paint([], theme.bg, usable));

  // A card — a permission request, or the question a failed turn asks — floats
  // at the foot of the page rather than in the middle of it: it lands directly
  // above the rule and the prompt, where the eye already is while typing, which
  // is where a picker lands too. The tab bar and the footer stay visible around
  // it, and its own decision chips are click targets.
  const modalRows: PanelRow[] = [];
  if (state.modal) {
    const boxWidth = Math.min(Math.max(usable - 6, 20), MODAL_BOX_WIDTH);
    // Title + body + decision row must fit between the tab bar and the footer,
    // so the body is the part that gives: it is the only part with a boundary
    // to cut at, and the row that says how to answer is not negotiable.
    const bodyBudget = clamp(rows - 4, 1, MODAL_BODY_LINES);
    const card = modalCard(state.modal, styles, boxWidth, bodyBudget);
    const box = card.box;
    const left = Math.max(Math.floor((usable - boxWidth) / 2), 0);
    // The card's last row is the last row of the conversation.
    const start = Math.max(pageRows - box.length, 0);
    // The card is the only thing on screen that has to be read, so the page
    // under it steps back — the same treatment a picker's card gets.
    for (let row = 0; row < pageRows; row++) {
      if (row >= start && row < start + box.length) continue;
      const source = allRows[row];
      if (source && source.spans.length > 0) lines[row] = paint(fadeRow(source, styles, theme).spans, theme.bg, usable, theme.bg);
    }
    const isError = state.modal.tone === "error" || /failed|rate.?limit|error|denied|refused/i.test(state.modal.title);
    const modalBg = isError ? blend(theme.panel, theme.error, 0.35) : theme.panel;

    box.forEach((spans, offset) => {
      const row = start + offset;
      if (row < 0 || row >= lines.length) return;
      const screenRow = row + 1;
      const boxSpans = padSpans([span(" ".repeat(left)), ...spans], left + boxWidth);
      const highlighted = state.selection ? selectRow(boxSpans, screenRow, state.selection, styles) : boxSpans;
      lines[row] = paint(highlighted, modalBg, usable, theme.bg);
    });
    // One target per chip, in the columns it was drawn in: the card's own rows
    // are already in screen coordinates, so they need no offset.
    const decisionRow = start + card.decisionRowOffset + 1;
    for (const chip of card.chips) {
      modalRows.push({
        kind: "modal_choice",
        row: decisionRow,
        index: chip.index,
        colStart: left + chip.start + 1,
        colEnd: left + chip.end + 1,
      });
    }
  }

  const caret =
    bottom.caretRow === null
      ? null
      : {
          row: 1 + tabRowCount + bodyRows + bottom.caretRow,
          // `caretCol` counts the cells before the caret *inside the box's own
          // text*, and where that starts is the box's to say: the gutter, the
          // mode pill and the badges all sit in front of it. Asking the box is
          // also what keeps a press and a caret landing in the same column.
          col: Math.min((bottom.prompt?.textLeft ?? margin + 3) + bottom.caretCol, usable - 1),
        };

  // Two blocks, two offsets: the body starts under the tab bar, the bottom block
  // under the body. Both are in rows the mouse actually reports, so a caller can
  // compare a click against them without knowing the layout at all.
  // A card owns the clicks while it is up — the page behind it is scenery, and a
  // row you cannot see clearly is not a row you should be able to press — and so
  // does a modal, which is the one thing that must not be answered by accident.
  const panelRows: PanelRow[] = state.modal
    ? [
        ...modalRows,
        // The card's own chips, and the footer's — while the card is up, the
        // footer's close box is the only other thing a mouse may press.
        ...bottom.hits.map((hit) => ({ ...hit, row: hit.row + tabRowCount + bodyRows + 1 })),
      ]
    : [
        ...(card ? card.hits : body.hits).map((hit) => ({ ...hit, row: hit.row + tabRowCount + 1 })),
        ...bottom.hits.map((hit) => ({ ...hit, row: hit.row + tabRowCount + bodyRows + 1 })),
      ];

  // The prompt box in screen rows, the way a mouse reports a click. Its own
  // rows are counted from the top of the bottom block, like the hits above.
  const prompt = bottom.prompt
    ? {
        ...bottom.prompt,
        top: bottom.prompt.top + tabRowCount + bodyRows + 1,
        bottom: bottom.prompt.bottom + tabRowCount + bodyRows + 1,
        rows: bottom.prompt.rows.map((row) => ({ ...row, row: row.row + tabRowCount + bodyRows + 1 })),
        // The box's three buttons ride the same shift as its rows.
        modeButton: { ...bottom.prompt.modeButton, row: bottom.prompt.modeButton.row + tabRowCount + bodyRows + 1 },
        uploadButton: { ...bottom.prompt.uploadButton, row: bottom.prompt.uploadButton.row + tabRowCount + bodyRows + 1 },
      }
    : null;

  const scrollbar: ScrollbarInfo | null =
    body.scrollbarMax && body.scrollbarMax > 0
      ? {
          topRow: tabRowCount + 1,
          bottomRow: tabRowCount + bodyRows,
          col: usable,
          maxScroll: body.scrollbarMax,
        }
      : null;

  return {
    lines,
    text: lines.map(stripAnsi),
    caret,
    tabs: tabRow.hits,
    rows: panelRows,
    selectable: { top: 1, bottom: rows },
    scrollbar,
    prompt,
  };
}

/**
 * Whether the tab bar is drawn.
 *
 * `auto` is the setting that makes the row worth having: a session with no
 * other session keeps the whole screen, and the row appears the moment there is
 * something to switch to.
 */
function sidebarShown(state: TuiState): boolean {
  const sidebar = state.settings?.sidebar ?? "on";
  if (sidebar === "off") return false;
  // Always show the tab bar so the active tab and +NEW button remain accessible
  return true;
}

/**
 * One padded row.
 *
 * The background is re-applied before erasing because every span ends with a
 * reset — without that, `ERASE_TO_EOL` would erase in the terminal's default
 * colour and leave a pale stripe down the right-hand side.
 */
/**
 * One row, styled, clipped, and filled out to the terminal's edge.
 *
 * `page` is what the *rest* of the row is filled with. It only differs from
 * `background` for a row that is a panel rather than the page — a request
 * block — because a coloured row must stop where its shape stops instead of
 * bleeding to the rim in the columns the caller never asked it to cover.
 */
function paint(spans: readonly Span[], background: string, usable: number, page = background): string {
  const clipped = truncateSpans(spans, usable);
  // The background is passed down so every span repaints it, and re-applied
  // before the erase because a span's reset clears it.
  return `${renderSpans(clipped, bg(background))}${bg(page)}${ERASE_TO_EOL}${RESET}`;
}

/**
 * The session tabs, each with its own close box.
 *
 * The geometry is returned alongside the spans because a click has to be placed
 * in a column, and only this function knows where the pieces landed.
 */
function renderTabs(state: TuiState, styles: Styles, usable: number): { spans: Span[]; hits: TabHit[] } {
  const spans: Span[] = [];
  const hits: TabHit[] = [];
  let x = 0;

  // One tab is ` title  ×  `: single leading space, then the close box gets
  // two cells of air on each side so it reads — and clicks — as its own
  // target rather than punctuation at the end of the title.
  for (const tab of state.tabs) {
    const isHovered = state.hoverTabId === tab.id;
    const isCloseHovered = isHovered && Boolean(state.hoverClose);
    const title = `${tab.busy && !tab.current ? TAB_BUSY : " "}${cut(tab.title, TAB_TITLE_MAX)}  `;
    const body = tab.current ? styles.tabActive : isHovered ? styles.tabHover : styles.tabInactive;
    const close = isCloseHovered
      ? styles.tabCloseHover
      : tab.current
        ? styles.tabClose
        : styles.tabCloseInactive;

    const start = x;
    spans.push(span(title, body));
    x += textWidth(title);

    const closeStart = x;
    spans.push(span(TAB_CLOSE, close));
    x += textWidth(TAB_CLOSE);

    // The two trailing cells are the gap to the next tab, so the close box
    // keeps its air without a separate separator span to drift from it.
    spans.push(span("  ", body));
    x += 2;

    hits.push({ id: tab.id, start, closeStart, end: x });
  }

  const newTabLabel = NEW_TAB;
  const isNewHovered = state.hoverTabId === NEW_TAB;
  hits.push({ id: NEW_TAB, start: x, closeStart: x, end: x + textWidth(newTabLabel) });
  spans.push(span(newTabLabel, isNewHovered ? styles.tabNewHover : styles.tabNew));

  return {
    spans: truncateSpans(spans, usable),
    // A tab the row ran out of room for is not clickable: there is nothing on
    // screen where the click would land.
    hits: hits
      .filter((hit) => hit.start < usable)
      .map((hit) => ({ ...hit, end: Math.min(hit.end, usable) })),
  };
}

/** Cuts a title to `max` cells, marking the cut. */
function cut(text: string, max: number): string {
  if (textWidth(text) <= max) return text;
  let kept = "";
  for (const char of text) {
    if (textWidth(kept) + charWidth(char.codePointAt(0) ?? 0) > max - 1) break;
    kept += char;
  }
  return `${kept}…`;
}

/**
 * One body row: its text, and the surface it is drawn on.
 *
 * The background travels with the row because a block is a *shape*, not a line:
 * a user turn is filled all the way across, and the row's own colour is what
 * makes it read as one block rather than as bold text with a bar beside it.
 */
type BodyLine = { spans: Span[]; background: string; page?: string };

/** Rows of a plain list, all on the background. */
function plain(rows: readonly Span[][], background: string): BodyLine[] {
  return rows.map((spans) => ({ spans, background }));
}

/**
 * A row the card is covering, folded back into the page.
 *
 * The card owns the eye, so everything behind it drops to the faint colour on
 * the page background — still legible enough to keep your place in the
 * conversation, plainly not the thing being answered. Chip fills go too: a
 * block of colour left at full strength behind a modal reads as another panel.
 */
function fadeRow(row: BodyLine, styles: Styles, theme: Theme): BodyLine {
  return { spans: row.spans.map((s) => ({ ...s, style: styles.faint })), background: theme.bg };
}

/**
 * One row's spans with the part of it the selection covers drawn in reverse.
 *
 * `row` is a screen row. A selection that runs over several lines takes all of
 * the rows between its ends and only the covered part of the two it ends on —
 * which is what makes it read as text rather than as a block.
 */
function selectRow(spans: readonly Span[], row: number, selection: Selection, styles: Styles): Span[] {
  const from = selection.from;
  const to = selection.to;
  const startRow = Math.min(from.row, to.row);
  const endRow = Math.max(from.row, to.row);
  if (row < startRow || row > endRow) return [...spans];

  let left = 0;
  let right = Number.POSITIVE_INFINITY;

  if (startRow === endRow) {
    left = Math.min(from.col, to.col) - 1;
    right = Math.max(from.col, to.col) - 1;
  } else if (row === startRow) {
    const startCol = from.row <= to.row ? from.col : to.col;
    left = startCol - 1;
  } else if (row === endRow) {
    const endCol = from.row <= to.row ? to.col : from.col;
    right = endCol - 1;
  }

  if (left > right) return [...spans];
  return markCells(spans, Math.max(left, 0), Math.max(right, 0), styles.selection);
}

function renderBody(
  state: TuiState,
  styles: Styles,
  theme: Theme,
  width: number,
  height: number,
  usable: number,
  margin: number,
): Panel {
  if (height <= 0) return { lines: [], hits: [] };
  if (state.ask) {
    const ask = renderAsk(state, styles, height, width, margin);
    return { lines: plain(ask.lines, theme.bg), hits: ask.hits };
  }
  if (state.picker) return renderPicker(state.picker, styles, theme, height, margin, usable);
  if (state.menu) return renderMenu(state.menu, styles, theme, height, usable, margin);
  if (state.entries.length === 0) return { lines: plain(renderHome(state, styles, theme, height, usable, margin), theme.bg), hits: [] };

  const view = state.settings ?? defaultViewSettings();
  const spacing = view.spacing;
  // The transcript is a column with a gutter down each side. A long line needs
  // somewhere to stop, and a request block that has an edge on both sides reads
  // as a block rather than as a band across the screen. The terminal's last
  // column is held back for the scrollbar, so the column is centred in what is
  // left rather than pressed against one rim.
  const room = Math.max(usable - 1, 16);
  const gutter = Math.min(margin, Math.max(Math.floor((room - 16) / 2), 0));
  const inner = Math.max(room - 2 * gutter, 8);
  const edge = span(" ".repeat(gutter), bg(theme.bg));
  const gutterLine = (line: BodyLine): BodyLine =>
    gutter === 0 ? line : { spans: [edge, ...line.spans, edge], background: line.background };

  const lines: BodyLine[] = [];
  /** The line each entry starts on, so `/timeline` can pin one to the top. */
  const starts: number[] = [];
  for (const [index, entry] of state.entries.entries()) {
    const previous = index > 0 ? state.entries[index - 1] : undefined;
    // Air between acts. A transcript drawn tight reads as a wall, and the eye
    // needs to see where one thing ended and the next began — a little more of
    // it around a request, because that is the real boundary: everything above
    // it answered it, everything below is the next thing asked.
    if (previous && !sameRun(previous, entry, view)) {
      const gap = spacing.entry + (previous.kind === "user" || entry.kind === "user" ? spacing.turn : 0);
      for (let row = 0; row < gap; row++) lines.push({ spans: [], background: theme.bg });
    }
    starts.push(lines.length);
    lines.push(...entryLines(entry, styles, theme, inner, view, state.spinnerFrame));
  }

  const lastEntry = state.entries.at(-1);
  const hasOpenThought = state.entries.some((e) => e.kind === "thought" && e.open);
  if (!hasOpenThought && state.busy && (lastEntry?.kind === "user" || lastEntry?.kind === "result")) {
    const glyph = SPINNER[state.spinnerFrame % SPINNER.length] ?? "⠋";
    const dotCount = (state.spinnerFrame % 3) + 1;
    const dots = ".".repeat(dotCount);
    const thinkingRow: Span[] = [
      span("▌ ", styles.accent),
      span(`${glyph} `, styles.accentBold),
      span(`Agent is Thinking${dots}`, styles.dim),
    ];
    lines.push({ spans: [], background: theme.bg });
    lines.push({ spans: thinkingRow, background: theme.bg });
  }
  // Guttering last, so an entry never has to know where the column begins.
  const drawn = gutter === 0 ? lines : lines.map(gutterLine);

  const dropped = Math.max(drawn.length - MAX_TRANSCRIPT_LINES, 0);
  const capped = dropped > 0 ? drawn.slice(dropped) : drawn;
  const max = Math.max(capped.length - height, 0);

  let offset = Math.min(Math.max(state.scroll, 0), max);
  const anchored = state.anchor === null ? undefined : starts[state.anchor];
  if (anchored !== undefined) {
    // Scrolling releases the anchor, so this only applies until the next key.
    offset = Math.min(Math.max(capped.length - (anchored - dropped) - height, 0), max);
  }

  const end = capped.length - offset;
  const visible = capped.slice(Math.max(end - height, 0), end);
  const blank = height - visible.length;

  const hasBar = view.scrollbar !== "off" && max > 0 && visible.length > 0;
  let stacked: BodyLine[];
  if (!hasBar) {
    stacked = [...Array.from({ length: Math.max(blank, 0) }, () => ({ spans: [] as Span[], background: theme.bg })), ...visible];
  } else {
    // A bar down the right edge, drawn only when there is something to scroll:
    // a track on a screen that already shows everything is a lie about how much
    // there is. The thumb is the fraction of the transcript on screen, and where
    // it sits is that fraction scrolled past.
    const thumb = Math.max(Math.round((visible.length / capped.length) * height), 1);
    const first = Math.max(capped.length - offset - height, 0);
    const thumbStart = Math.min(Math.round((first / capped.length) * height), height - thumb);
    const barred = visible.map((line, index) => {
      const inThumb = index + blank >= thumbStart && index + blank < thumbStart + thumb;
      return {
        spans: [
          ...padSpans(line.spans, usable - 1),
          span(inThumb ? "█" : "│", inThumb ? styles.accent : styles.faint),
        ],
        background: line.background,
      };
    });
    stacked = [...Array.from({ length: Math.max(blank, 0) }, () => ({ spans: [] as Span[], background: theme.bg })), ...barred];
  }

  const hits: Hit[] = [];
  const lastLineIdx = height - 1;
  const btnText = " Go to Bottom ↓ ";
  const btnLen = btnText.length;
  if (offset > 0 && height >= 2 && usable >= 30) {
    const target = stacked[lastLineIdx];
    if (target) {
      const barSpan = hasBar && target.spans.length > 0 ? target.spans[target.spans.length - 1] : undefined;
      const contentSpans = hasBar && barSpan ? target.spans.slice(0, -1) : target.spans;
      const colStart = (usable - (hasBar ? 1 : 0)) - btnLen;
      const colEnd = usable - (hasBar ? 1 : 0);
      if (colStart > 0) {
        const paddedContent = truncateSpans(contentSpans, colStart);
        const padWidth = colStart - spansWidth(paddedContent);
        const padSpace = padWidth > 0 ? [span(" ".repeat(padWidth))] : [];
        stacked[lastLineIdx] = {
          spans: [
            ...paddedContent,
            ...padSpace,
            span(btnText, styles.accentBold),
            ...(barSpan ? [barSpan] : []),
          ],
          background: target.background,
        };
        hits.push({
          kind: "jump_bottom",
          row: lastLineIdx,
          index: 0,
          colStart: colStart + 1,
          colEnd: colEnd + 1,
        });
      }
    }
  }

  return { lines: stacked, hits, scrollbarMax: hasBar ? max : undefined };
}

/**
 * True when two entries are one run of activity rather than two things.
 *
 * A tool call and its result are one act, and they already carry a ruled gap
 * between them — adding another would break the run into pieces and make the
 * rule pointless.
 */
function sameRun(a: Entry, b: Entry, view: ViewSettings): boolean {
  if (view.toolGrouping === "off") return false;
  const activity = (entry: Entry): boolean => entry.kind === "tool" || entry.kind === "result";
  return activity(a) && activity(b);
}

/**
 * One entry's rows, wrapped, on the surface it belongs to.
 *
 * Three shapes, and each one is a decision about what the transcript is for:
 *
 * - a **user turn** is a filled block with the accent bar down its left edge,
 *   because it is the thing the rest of the screen is an answer to;
 * - **tool output** carries a thin rule instead, so a run of actions reads as
 *   one piece of work rather than as several unrelated lines;
 * - **the answer** is plain prose, with emphasis in its own colour, because it
 *   is the part that is meant to be read.
 */
/**
 * Wrapped rows with the entry's own blank first and last rows removed.
 *
 * How much air sits between two things is the layout's decision, not each
 * entry's, so the same gap is used everywhere instead of one entry carrying a
 * newline and its neighbour not.
 */
function wrappedRows(spans: Span[], width: number): Span[][] {
  const rows = wrapSpans(spans, width);
  while (rows.length > 0 && (rows[0] ?? []).length === 0) rows.shift();
  while (rows.length > 0 && (rows[rows.length - 1] ?? []).length === 0) rows.pop();
  return rows;
}

function entryLines(
  entry: Entry,
  styles: Styles,
  theme: Theme,
  width: number,
  view: ViewSettings,
  spinnerFrame = 0,
): BodyLine[] {
  if (entry.kind === "user") {
    const body: Span[] = [
      ...(entry.images && view.transcriptImages === "on"
        ? [span(`[${entry.images} image${entry.images === 1 ? "" : "s"}] `, styles.imageBadge)]
        : []),
      span(entry.text, styles.bold),
    ];
    const rows = wrappedRows(body, Math.max(width - 2, 1));
    // Padding above and below, and the bar runs down all of it: a block with one
    // straight left edge reads as a block, which is what makes a request
    // findable when scrolling back through a long session. How many rows is
    // `spacing.block`, because a single row still looks like a line that happens
    // to be tall while three is a panel — and which of those a person wants is
    // theirs to say, not this function's.
    const bar = (row: Span[]): BodyLine => ({
      spans: [span(`${BAR} `, styles.accent), ...row],
      background: theme.block,
      page: theme.bg,
    });
    const pad = Array.from({ length: view.spacing.block }, () => bar([]));
    const block = [...pad, ...rows.map(bar), ...pad];
    // A block is a rectangle that hugs its text: every row's fill runs to the
    // widest row plus a little right padding, so the shape reads as a chip
    // around the words rather than as a band that stops wherever it likes.
    // Left unpadded, a pad row's fill covers only the bar — two cells of block
    // colour on an otherwise page-coloured row — which reads as a glitch.
    const widest = Math.max(...block.map((line) => spansWidth(line.spans)), 1) + BLOCK_PAD;
    return block.map((line) => {
      const shortfall = widest - spansWidth(line.spans);
      return shortfall > 0 ? { spans: [...line.spans, span(" ".repeat(shortfall))], background: line.background } : line;
    });
  }

  if (entry.kind === "tool" || entry.kind === "result") {
    const rows = wrappedRows(entrySpans(entry, styles, view, spinnerFrame), Math.max(width - 2, 1));
    const ruled = (row: Span[]): BodyLine => ({
      // An empty row keeps the rule without the space after it, so a gap inside
      // the run is a line rather than a line and a stray trailing cell.
      spans: row.length === 0 ? [span(RULE, styles.rule)] : [span(`${RULE} `, styles.rule), ...row],
      background: theme.bg,
    });
    // A call opens its own gap inside the run, which is what the rule is for:
    // the actions of one turn read as one piece of work rather than as several
    // unrelated lines.
    return entry.kind === "tool" ? [ruled([]), ...rows.map(ruled)] : rows.map(ruled);
  }

  return wrappedRows(entrySpans(entry, styles, view, spinnerFrame), width).map((spans) => ({ spans, background: theme.bg }));
}

/** The empty-transcript screen: the wordmark, centred, with a hint under it. */
function renderHome(
  state: TuiState,
  styles: Styles,
  theme: Theme,
  height: number,
  usable: number,
  margin: number,
): Span[][] {
  const logo = logoRows(theme, LOGO_TEXT);
  const block: Span[][] = [
    ...logo,
    [],
    [span("Your terminal. Your keys. Your agent.", styles.faint)],
    [],
    [span("Where should we begin?", styles.bold)],
    [],
    [span(`${state.model} · v${state.version}`, styles.dim)],
    [span("/models to choose a model · /help for commands", styles.accent)],
    [],
  ];
  if (state.mcp) block.push([span(`MCP: ${state.mcp}`, styles.faint)]);
  if (state.config) block.push([span(`config: ${state.config}`, styles.faint)]);

  const top = Math.max(Math.floor((height - block.length) / 2), 0);

  const out: Span[][] = [];
  for (let i = 0; i < top; i++) out.push([]);
  for (const row of block) {
    if (row.length === 0) {
      out.push([]);
      continue;
    }
    // Centred per row, so the tagline lines up with the wordmark rather than
    // inheriting its offset.
    const pad = Math.max(Math.floor((usable - spansWidth(row)) / 2) - margin, 0);
    out.push([span(" ".repeat(pad)), ...row]);
  }
  while (out.length < height) out.push([]);
  return out.slice(0, height);
}

/**
 * The command palette: one full-width row per command, the highlighted one
 * filled edge to edge.
 *
 * It is drawn as ordinary rows rather than as a real overlay, because the
 * layout has no z-order — staying a stack of rows is what keeps the whole
 * screen a pure function of the state.
 */
function renderPalette(
  palette: Palette,
  styles: Styles,
  usable: number,
  margin: number,
  room: number,
): { lines: Span[][]; hits: Hit[] } {
  const items = palette.items;
  const inner = Math.max(usable - margin, 12);
  const indent = " ".repeat(margin);

  const capacity = Math.max(room, 1);
  const selected = clamp(palette.selected, 0, Math.max(items.length - 1, 0));
  // Window the list around the selection rather than always showing the top.
  const start = clamp(selected - capacity + 1, 0, Math.max(items.length - capacity, 0));
  const visible = items.slice(start, start + capacity);

  if (visible.length === 0) return { lines: [[span(`${indent}no matching command`, styles.hint)]], hits: [] };

  return {
    lines: visible.map((command, offset) => paletteRow(command, start + offset === selected, indent, inner, styles)),
    hits: visible.map((_command, offset) => ({ kind: "palette" as const, row: offset, index: start + offset })),
  };
}

/**
 * One palette row: the name in a fixed column, then its description.
 *
 * A name that cannot run here is drawn dim in both columns, so the list still
 * answers "does KiCode have this?" without pretending it does.
 */
function paletteRow(
  command: Command,
  isSelected: boolean,
  indent: string,
  inner: number,
  styles: Styles,
): Span[] {
  const available = isAvailable(command);
  const fill = isSelected ? styles.paletteSelected : "";
  const nameStyle = isSelected ? styles.paletteSelected : available ? styles.accent : styles.faint;
  const textStyle = isSelected ? styles.paletteSelected : available ? styles.dim : styles.faint;

  const name = truncateSpans([span(`/${command.name}`.padEnd(COMMAND_WIDTH + 2), nameStyle)], COMMAND_WIDTH + 2);
  const description = command.usage ? `${command.description} ${command.usage}` : command.description;
  const tail = truncateSpans([span(description, textStyle)], Math.max(inner - spansWidth(name), 1));

  // The fill continues over the gap, so the highlight reads as one bar rather
  // than stopping at the end of the text.
  const pad = Math.max(inner - spansWidth(name) - spansWidth(tail), 0);
  return [span(indent), ...name, ...tail, span(" ".repeat(pad), fill)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The question panel: the questions as a tab strip, the current one, and its
 * options.
 *
 * It replaces the transcript rather than floating over it — the layout has no
 * z-order, and a question is modal in intent anyway: answering it is the only
 * thing to do next.
 */
function renderAsk(
  state: TuiState,
  styles: Styles,
  height: number,
  width: number,
  margin: number,
): { lines: Span[][]; hits: Hit[] } {
  const ask = state.ask;
  if (!ask) return { lines: [], hits: [] };

  const current = ask.questions[Math.min(Math.max(ask.index, 0), ask.questions.length - 1)];
  if (!current) return { lines: [], hits: [] };

  const pad = " ".repeat(margin);
  const lines: Span[][] = [];
  const push = (spans: Span[]): void => {
    lines.push([span(pad), ...spans]);
  };

  // 0. Questions header
  push([span("Questions", styles.hint)]);
  lines.push([]);

  // 1. Breadcrumbs step indicator: e.g. • New project │ ○ Location │ ○ Review │ ○ Submit
  if (ask.questions.length > 1) {
    const ready = ask.answers.every((answer) => answer !== null && answer !== undefined);
    const tabs: Span[] = [];
    for (const [index, question] of ask.questions.entries()) {
      if (index > 0) tabs.push(span(" │ ", styles.rule));
      const isCurrent = index === ask.index;
      const isDone = ask.answers[index] !== null && ask.answers[index] !== undefined;
      const icon = isDone ? "✓ " : isCurrent ? "• " : "○ ";
      const iconStyle = isDone ? styles.ok : isCurrent ? styles.accentBold : styles.faint;
      const labelStyle = isCurrent ? styles.bold : isDone ? styles.dim : styles.faint;
      tabs.push(span(icon, iconStyle), span(question.header, labelStyle));
    }
    tabs.push(
      span(" │ ", styles.rule),
      span(ready ? "✓ " : "○ ", ready ? styles.ok : styles.faint),
      span("Submit", ready ? styles.accentBold : styles.dim),
    );
    push(tabs);
    lines.push([]);
  } else if (current.header) {
    push([span("• ", styles.accentBold), span(current.header, styles.bold)]);
    lines.push([]);
  }

  // 2. Question title
  push([span(current.question, styles.bold)]);
  lines.push([]);

  // 3. Options list with ❯ for selected and indented descriptions
  const optionLines: number[] = [];
  const optionRows: { row: number; index: number }[] = [];
  for (const [index, option] of current.options.entries()) {
    optionLines.push(lines.length);
    optionRows.push({ row: lines.length, index });
    const isSelected = index === ask.selected;
    const num = `${index + 1}. `;

    if (isSelected) {
      push([
        span("❯ ", styles.accent),
        span(num, styles.accentBold),
        span(option.label, styles.bold),
        span(" ✓", styles.accent),
      ]);
    } else {
      push([
        span("  "),
        span(num, styles.dim),
        span(option.label, styles.text),
      ]);
    }

    if (option.description) {
      for (const line of wrapSpans([span(option.description, styles.dim)], Math.max(width - 8, 8))) {
        optionRows.push({ row: lines.length, index });
        push([span("     "), ...line]);
      }
    }
  }

  // 4. Footer navigation hints
  lines.push([]);
  const hintLine: Span[] = [
    span("Enter", styles.hintKey),
    span(" to select", styles.hint),
    span(" │ ", styles.faint),
    span("Arrow keys", styles.hintKey),
    span(" to navigate", styles.hint),
    span(" │ ", styles.faint),
    span("1-9", styles.hintKey),
    span(" quick select", styles.hint),
    span(" │ ", styles.faint),
    span("Esc", styles.hintKey),
    span(" to cancel", styles.hint),
  ];
  push(hintLine);

  // Keep the highlighted option on screen on a short terminal.
  const offset = lines.length <= height ? 0 : Math.min(Math.max((optionLines[ask.selected] ?? 0) - 1, 0), lines.length - height);
  const visible = lines.slice(offset, offset + height);

  // Pin questions to bottom directly above prompt line
  const padTop = Math.max(height - visible.length, 0);
  const out: Span[][] = [];
  for (let i = 0; i < padTop; i++) out.push([]);
  for (const row of visible) out.push(row);
  while (out.length < height) out.push([]);

  const hits: Hit[] = optionRows
    .filter(({ row }) => row >= offset && row < offset + height)
    .map(({ row, index }) => ({ kind: "ask" as const, row: row - offset + padTop, index }));

  return { lines: out, hits };
}

/**
 * A full-screen menu: a title, a search field, grouped rows and a footer.
 *
 * It replaces the transcript the way the picker does. The band itself is the
 * only thing on screen carrying `theme.panel`, which is what makes it read as a
 * surface laid over the conversation rather than as more of it — and a row is
 * filled edge to edge, because there is no z-order here to draw a floating box
 * with.
 *
 * Its own footer names the keys for the same reason the picker's does: the
 * bottom footer belongs to the session, and the keys that act on a panel are
 * only true while the panel is up.
 */
function renderMenu(
  menu: MenuPanel,
  styles: Styles,
  theme: Theme,
  height: number,
  usable: number,
  margin: number,
): Panel {
  // A row is `width` cells wide and starts after the indent, so the band stops
  // a margin short of both edges. The values are right-aligned to `width`,
  // which is what makes a column of them line up down the screen.
  const indent = " ".repeat(margin + 2);
  const width = Math.max(usable - 2 * margin - 2, 20);
  const selected = clamp(menu.selected, 0, Math.max(menu.rows.length - 1, 0));

  // The rows that scroll. A heading is printed when the group changes, so a
  // filtered list keeps the headings that still have rows under them.
  const list: Span[][] = [];
  /** The menu row each list line belongs to, or null for a heading or a gap. */
  const listIndex: (number | null)[] = [];
  let cursorRow = 0;
  let cursorHeading = -1;
  let headingRow = -1;
  let group = "";
  for (const [index, row] of menu.rows.entries()) {
    if (row.group && row.group !== group) {
      if (list.length > 0) {
        list.push([]);
        listIndex.push(null);
      }
      headingRow = list.length;
      list.push([span(row.group, styles.heading)]);
      listIndex.push(null);
      group = row.group;
    }
    if (index === selected) {
      cursorRow = list.length;
      cursorHeading = headingRow;
    }
    list.push(menuRow(row, index === selected, width, styles));
    listIndex.push(index);
  }

  // The chrome around the list: a blank row at each edge of the band, the
  // title, the search field, and the footer. The description is the first thing
  // dropped on a short terminal, because it explains a row rather than being
  // one.
  const showDescription = menu.description !== undefined && height >= 12;
  const chrome = 5 + (showDescription ? 1 : 0) + (list.length === 0 ? 1 : 0);
  const room = Math.max(height - 2 - chrome, 1);
  const first = firstRowFor(list.length, cursorRow, cursorHeading, Math.min(room, list.length));
  const visible = list.slice(first, first + room);

  // A blank row of the band's own fill, not an empty one: the surface is a solid
  // rectangle, and a gap that let the page through would break it into two.
  const blank = (): Span[] => [span(indent), span(" ".repeat(width))];
  const band: Span[][] = [];
  band.push(blank());
  band.push([span(indent), ...menuTitleRow(menu.title, width, styles)]);
  band.push([span(indent), ...searchRow(menu.query, width, styles)]);
  band.push(blank());
  if (list.length === 0) band.push([span(indent), span("nothing matches", styles.faint), span(` ${menu.query}`, styles.dim)]);
  const bandTop = band.length;
  const hits: Hit[] = [];
  for (const [offset, row] of visible.entries()) {
    band.push(row.length === 0 ? blank() : [span(indent), ...row]);
    const index = listIndex[first + offset];
    if (index !== null && index !== undefined) hits.push({ kind: "menu", row: bandTop + offset + 1, index });
  }
  band.push(blank());
  if (showDescription)  band.push([span(indent), ...truncateSpans([span(menu.description ?? "", styles.faint)], width)]);
  band.push([span(indent), ...hintLine(menu.footer, styles)]);

  // The band sits low on the page, just above the rule, for the same reason the
  // picker does: a menu is answered from the keyboard while the eye is down by
  // the prompt. `band` is drawn one row down, inside the blank row that gives
  // the surface its top edge — so every hit moves with it, and with the padding
  // that pushes the whole band down.
  const padTop = Math.max(height - (band.length + 2), 0);
  for (const hit of hits) hit.row += padTop;
  // The two ways out of the band: the chip in its title row and the one in its
  // footer, in the rows those land on once the band is pushed down.
  hits.push(...closeChipHits(padTop + 2, band[1] ?? [], 0));
  hits.push(...closeChipHits(padTop + band.length, band.at(-1) ?? [], 0));
  const out: BodyLine[] = [];
  for (let i = 0; i < padTop; i++) out.push({ spans: [], background: theme.bg });
  out.push({ spans: [], background: theme.bg });
  for (const spans of band) out.push({ spans, background: theme.panel });
  out.push({ spans: [], background: theme.bg });
  while (out.length < height) out.push({ spans: [], background: theme.bg });
  return { lines: out.slice(0, height), hits };
}

/** `Title` left, the close chip right, inside the band. */
function menuTitleRow(title: string, inner: number, styles: Styles): Span[] {
  const head = truncateSpans([span(title, styles.bold)], Math.max(inner - 6, 4));
  return [...head, span(" ".repeat(Math.max(inner - spansWidth(head) - 3, 1))), span(CLOSE_CHIP, styles.hintKey)];
}

/**
 * One row of a menu: a tick when it is already set up, the label, and its value
 * pinned right so a column of values can be compared down the screen.
 */
function menuRow(row: MenuRow, isSelected: boolean, inner: number, styles: Styles): Span[] {
  // The highlighted row is filled rather than merely coloured: on a screen of
  // values, the one the keys act on has to be unmistakable.
  const fill = isSelected ? styles.paletteSelected : "";
  const body = isSelected ? styles.paletteSelected : row.disabled ? styles.faint : styles.text;
  const tick: Span = row.checked
    ? span("✔ ", isSelected ? styles.paletteSelected : styles.ok)
    : span("  ", fill || undefined);
  const label: Span[] = [tick, span(row.label, body)];

  if (!row.trailing) return padSpans(label, inner);

  const gap = Math.max(inner - spansWidth(label) - textWidth(row.trailing) - 1, 1);
  return padSpans([...label, span(" ".repeat(gap), fill), span(row.trailing, isSelected ? styles.paletteSelected : styles.faint)], inner);
}

/** How wide a card may get, and how narrow it may be before a flat list wins. */
const PANEL_MAX = 76;
const PANEL_MIN = 24;
/** The air inside a card's own edge, on both sides of every row. */
const CARD_PAD = "  ";

/**
 * A list to choose from, in a card of its own.
 *
 * It replaces the transcript rather than sitting above the prompt, because
 * choosing is then the only thing left to do. The card carries its own search
 * field, its own grouped rows and its own hints: a list longer than a screen is
 * only usable if it can be narrowed by typing, and the keys it answers to belong
 * next to it.
 *
 * It is one filled surface, with no frame around it — the reader's eye is
 * already being asked to follow a column of rows, and border glyphs are one more
 * thing drawn over them. What says "card" is the fill, the air inside its own
 * edges, and the page showing through beside it.
 */
function renderPicker(
  picker: Picker,
  styles: Styles,
  theme: Theme,
  height: number,
  margin: number,
  usable: number,
): Panel {
  const isTop = picker.position === "top" || picker.title.startsWith("Tab:");

  // Measure max-content width so the modal hugs its content cleanly instead of
  // spreading out unnecessarily with wide empty gaps.
  let contentWidth = Math.max(
    textWidth(picker.title) + textWidth(CLOSE_CHIP) + 4,
    textWidth(picker.query || (picker.placeholder ?? "Search")) + 4,
    42,
  );

  if (picker.tabs) {
    const tabsWidth =
      picker.tabs.labels.reduce((acc, l) => acc + textWidth(l), 0) +
      (picker.tabs.labels.length - 1) * 3 + 2;
    contentWidth = Math.max(contentWidth, tabsWidth);
  }

  for (const item of picker.items) {
    let itemW = 4 + textWidth(item.label);
    if (item.description) itemW += textWidth(item.description) + 2;
    if (item.trailing) itemW += textWidth(item.trailing) + 2;
    contentWidth = Math.max(contentWidth, itemW);
  }

  if (picker.hints && picker.hints.length > 0) {
    const hintsWidth =
      picker.hints.reduce((acc, [k, l]) => acc + textWidth(k) + textWidth(l) + 3, 0) + 2;
    contentWidth = Math.max(contentWidth, hintsWidth);
  }

  const maxAllowed = Math.min(usable - 4, isTop ? 64 : PANEL_MAX);
  const width = clamp(contentWidth + CARD_PAD.length * 2, Math.min(PANEL_MIN, maxAllowed), maxAllowed);
  const left = isTop
    ? Math.min(margin + 2, Math.max(usable - width, 0))
    : clamp(Math.floor((usable - width) / 2), 0, Math.max(usable - width, 0));
  const rightPad = Math.max(usable - left - width, 0);

  // Inside the card: a row of air at its top edge, the title, the search field,
  // the tabs when there are any, a blank, the list, and the row of air under it.
  // What is left is the list — and if that leaves nothing to list, the card is
  // not worth drawing and a flat list says more.
  const hasSearch = picker.searchable !== false;
  const room = height - 5 - (hasSearch ? 1 : 0) - (picker.tabs ? 1 : 0);
  if (room < 1 || width < PANEL_MIN) {
    const flat = renderFlatPicker(picker, styles, height, margin);
    return { lines: plain(flat.lines, theme.bg), hits: flat.hits };
  }

  const inner = Math.max(width - CARD_PAD.length * 2, 8);
  const card: Span[][] = [];
  // The page beside the card on both left and right, so the card is centered
  // and does not bleed its background across to the right edge.
  const sideLeft = span(" ".repeat(left), bg(theme.bg));
  const sideRight = span(" ".repeat(rightPad), bg(theme.bg));
  /** A row of the card: the air inside its edge, the content, the air again. */
  const row = (content: readonly Span[]): void => {
    card.push([sideLeft, span(CARD_PAD), ...padSpans(content, inner), span(CARD_PAD), sideRight]);
  };

  const hits: Hit[] = [];
  row([]);
  const titleRow = card.length;
  row(panelTitle(picker.title, CLOSE_CHIP, inner, styles));
  // The chip is found by walking the row it was drawn in — the row's own spans,
  // coordinates and all — so a target cannot drift from the glyph.
  hits.push(...closeChipHits(titleRow, card[titleRow] ?? [], 0));
  if (hasSearch) row(searchRow(picker.query, inner, styles, picker.placeholder ?? "Search"));
  if (picker.tabs) {
    const tabRowIdx = card.length;
    row(tabSpans(picker.tabs, styles));
    hits.push(...tabHits(tabRowIdx, card[tabRowIdx] ?? [], 0, picker.tabs.labels));
  }
  row([]);

  const rows: Span[][] = [];
  /** The item each list line belongs to, or null for a heading or a gap. */
  const rowsIndex: (number | null)[] = [];
  const selected = clamp(picker.selected, 0, Math.max(picker.items.length - 1, 0));
  /** Where the cursor's row landed, and the heading of the group it is in. */
  let cursorRow = 0;
  let heading = -1;
  let currentGroup: string | null = null;
  for (const [index, item] of picker.items.entries()) {
    if (item.group && item.group !== currentGroup) {
      // A blank row above a heading separates one group from the last, so a
      // run of rows reads as one block rather than as a heading claiming the
      // rows above it too. There is none above the very first row.
      if (rows.length > 0) {
        rows.push([]);
        rowsIndex.push(null);
      }
      // The heading wears the theme's heading hue: it names the rows under it
      // rather than being one of them, and the accent is the colour of the row
      // the keys act on.
      rows.push([span(` ${item.group}`, styles.heading)]);
      rowsIndex.push(null);
      heading = rows.length - 1;
      currentGroup = item.group;
    }
    if (index === selected) cursorRow = rows.length;
    rows.push(itemRow(item, index === selected, inner, styles));
    rowsIndex.push(index);
  }

  const first = firstRowFor(rows.length, cursorRow, heading, Math.min(room, rows.length));
  const window = rows.slice(first, first + room);
  const visible = window.length;

  if (picker.items.length === 0) {
    if (!picker.onSubmitQuery) {
      if (hasSearch) {
        row([span(" nothing matches ", styles.faint), span(picker.query, styles.dim)]);
      } else {
        row([span(" no options available", styles.faint)]);
      }
    }
  }
  const listTop = card.length;
  for (const [offset, line] of window.entries()) {
    row(line);
    const index = rowsIndex[first + offset];
    if (index !== null && index !== undefined) {
      hits.push({
        kind: "picker",
        row: listTop + offset,
        index,
        colStart: 1,
        colEnd: usable,
      });
    }
  }

  // A window that does not reach the end says so, so a short list is not
  // mistaken for the whole of it.
  if (first + visible < rows.length) {
    const hidden = rows.length - (first + visible);
    row([span(" ", styles.hint), span(`↓ ${hidden} more`, styles.faint)]);
  } else if (picker.hints && picker.hints.length > 0) {
    row([span(" ", styles.hint), ...hintRow(picker.hints, inner - 1, styles)]);
  } else {
    row([]);
  }
  row([]);

  // The card is centered vertically in the terminal window, except when pinned
  // to the top (e.g. tab right-click context menus).
  const topPad = isTop ? 0 : Math.max(Math.floor((height - card.length) / 2), 0);
  const out: BodyLine[] = [];
  for (let i = 0; i < topPad; i++) out.push({ spans: [], background: theme.bg, page: theme.bg });
  for (const spans of card) out.push({ spans, background: theme.panel, page: theme.bg });
  while (out.length < height) out.push({ spans: [], background: theme.bg, page: theme.bg });

  if (topPad > 0) {
    for (const hit of hits) {
      hit.row += topPad;
    }
  }
  return { lines: out.slice(0, height), hits };
}

/**
 * One row of the list: a dot for the one in use, then the label and the notes.
 *
 * There is no cursor glyph: the row the keys are on is the row that is filled,
 * and a bar beside a filled row is the same statement made twice.
 */
function itemRow(item: PickItem, isSelected: boolean, inside: number, styles: Styles): Span[] {
  const body = item.disabled ? styles.faint : isSelected ? styles.paletteSelected : styles.text;
  const lead = span("  ", isSelected ? styles.paletteSelected : undefined);
  const bullet = span(item.current ? "● " : "  ", isSelected ? styles.paletteSelected : styles.faint);

  // If item has a description and no trailing note (like skills or commands)
  if (item.description && !item.trailing) {
    const nameWidth = Math.min(Math.max(textWidth(item.label), 24), 30);
    const nameSpan = truncateSpans([span(item.label.padEnd(nameWidth + 2), body)], nameWidth + 2);
    const descWidth = Math.max(inside - 2 - spansWidth(nameSpan) - 1, 8);
    const descSpan = truncateSpans([span(item.description, isSelected ? styles.paletteSelected : styles.faint)], descWidth);
    const rowContent = [lead, bullet, ...nameSpan, ...descSpan];
    return padSpans(truncateSpans(rowContent, inside), inside);
  }

  const label: Span[] = [
    lead,
    bullet,
    span(item.label, body),
    ...(item.description ? [span("  "), span(item.description, isSelected ? styles.paletteSelected : styles.faint)] : []),
  ];

  if (!item.trailing) return padSpans(truncateSpans(label, inside), inside);

  // Clean raw FREE ($...) tags to pure FREE
  const trailingClean = item.trailing.replace(/FREE\s*\(\$[^)]*\)/g, "FREE");
  const trailingSpans: Span[] = trailingClean.startsWith("FREE")
    ? [span("FREE", styles.ok), span(trailingClean.slice(4), styles.faint)]
    : [span(trailingClean, styles.faint)];
  const trailingWidth = textWidth(trailingClean);

  // Truncate label so label + gap + trailing never overruns the card's edge.
  const maxLabelWidth = Math.max(inside - trailingWidth - 2, 8);
  const truncatedLabel = truncateSpans(label, maxLabelWidth);
  const gap = Math.max(inside - spansWidth(truncatedLabel) - trailingWidth, 1);

  return padSpans([
    ...truncatedLabel,
    span(" ".repeat(gap), isSelected ? styles.paletteSelected : undefined),
    ...trailingSpans,
  ], inside);
}

/** `Title` left, one key named right, both inside the card's edge. */
function panelTitle(title: string, key: string, inside: number, styles: Styles): Span[] {
  const tail = textWidth(key) + 2;
  const head = truncateSpans([span(` ${title}`, styles.bold)], Math.max(inside - tail - 1, 1));
  return padSpans([...head, span(" ".repeat(Math.max(inside - spansWidth(head) - tail, 1))), span(key, styles.hint)], inside);
}

/**
 * The search field.
 *
 * The block is drawn out of the same character the prompt cursor is, because it
 * is the same thing: where typing goes. It sits before the placeholder and after
 * what has been typed.
 */
function searchRow(query: string, inside: number, styles: Styles, placeholder = "Search"): Span[] {
  const field: Span[] = query
    ? [span(` ${query}`, styles.text), span("▌", styles.accent)]
    : [span("▌", styles.accent), span(placeholder, styles.faint)];
  return padSpans(field, inside);
}

/**
 * A card's own keys.
 *
 * The pairs run left to right, except the last one, which is pinned to the
 * right edge when there is room for it: a card's footer then has a beginning and
 * an end rather than being one run of keys that happens to stop early.
 */
function hintRow(pairs: readonly (readonly [string, string])[], inner: number, styles: Styles): Span[] {
  const all = hintPairs(pairs, styles);
  if (pairs.length < 2) return padSpans(all, inner);

  const tail = hintPairs([pairs[pairs.length - 1]!], styles);
  const head = hintPairs(pairs.slice(0, -1), styles);
  const gap = inner - spansWidth(head) - spansWidth(tail);
  if (gap < 4) return padSpans(all, inner);
  return padSpans([...head, span(" ".repeat(gap)), ...tail], inner);
}

/**
 * One click target per tab label, found by walking the row they were drawn in.
 *
 * The same trick as the close chip's: the columns come off the finished row, so
 * the targets cannot drift from the glyphs however the row was padded.
 */
function tabHits(row: number, spans: readonly Span[], origin: number, labels: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  let column = origin;
  for (const item of spans) {
    const index = item.text ? labels.indexOf(item.text) : -1;
    if (index >= 0) {
      hits.push({ kind: "picker_tab", row, index, colStart: column + 1, colEnd: column + textWidth(item.text) });
    }
    column += textWidth(item.text);
  }
  return hits;
}

/**
 * Where to start the window.
 *
 * The cursor comes first: it is the row the keys act on, and a list that
 * scrolls it out of view is unusable. The heading of the group it is in is then
 * pulled in with it where there is room — a group name stranded just above the
 * window names nothing — and dropped where there is not, because the cursor
 * cannot be spent on it.
 */
function firstRowFor(rows: number, cursorRow: number, heading: number, room: number): number {
  const start = clamp(cursorRow - room + 1, 0, Math.max(rows - room, 0));
  if (heading >= 0 && heading < start && cursorRow - heading + 1 <= room) return heading;
  return start;
}

/** A picker on a screen too short for a frame: the list, and nothing else. */
function renderFlatPicker(
  picker: Picker,
  styles: Styles,
  height: number,
  margin: number,
): { lines: Span[][]; hits: Hit[] } {
  const pad = " ".repeat(margin);
  const lines: Span[][] = [];
  const hits: Hit[] = [];
  const push = (spans: Span[]): void => {
    lines.push([span(pad), ...spans]);
  };

  push([span(picker.title, styles.bold)]);
  lines.push([]);

  const rows = Math.max(height - 2, 1);
  const selected = clamp(picker.selected, 0, Math.max(picker.items.length - 1, 0));
  const start = clamp(selected - rows + 1, 0, Math.max(picker.items.length - rows, 0));

  for (const [offset, item] of picker.items.slice(start, start + rows).entries()) {
    const isSelected = start + offset === selected;
    hits.push({ kind: "picker", row: lines.length, index: start + offset });
    push([
      span(isSelected ? "▸ " : "  ", styles.accent),
      span(item.current ? "● " : "  ", styles.ok),
      span(item.label, isSelected ? styles.accent : styles.text),
      ...(item.description ? [span("  "), span(item.description, styles.faint)] : []),
    ]);
  }

  const out: Span[][] = [];
  for (let i = 0; i < height; i++) out.push(lines[i] ?? []);
  return { lines: out, hits };
}

/**
 * The escape key as a chip: the glyph a tab closes with.
 *
 * Escape is the one key every card offers and the one a mouse had no way to
 * press, so it is drawn as a chip rather than printed as a word — and a click on
 * that chip *is* that key.
 */
export const CLOSE_CHIP = "[×]";

/**
 * What a card's every row is drawn behind: the bar and the space after it.
 *
 * Named because the decision row's chips are placed in the columns a click
 * reports, and those columns are measured from the card's left edge — not from
 * the first chip.
 */
const DECISION_PREFIX = 2;

/** A permission prompt is a card, not a full-width surface: narrow enough to read as floating. */
const MODAL_BOX_WIDTH = 72;

/**
 * The permission prompt's rows at card width: title, body, decision row.
 *
 * Each row is `▌` plus `inner` cells of text, so every row is exactly
 * `boxWidth` wide and the overlay can pad them as one block. A body that does
 * not fit says how much was cut — approving a diff the prompt cut in half
 * without knowing it did is the mistake the prompt exists to prevent.
 */
function modalCard(
  modal: Modal,
  styles: Styles,
  boxWidth: number,
  bodyBudget: number,
): { box: Span[][]; chips: { index: number; start: number; end: number }[]; decisionRowOffset: number } {
  const isError = modal.tone === "error" || /failed|rate.?limit|error|denied|refused/i.test(modal.title);
  const barStyle = isError ? styles.error : styles.warn;
  const inner = Math.max(boxWidth - 2, 8);
  const withSpacers = isError && bodyBudget >= 4;
  const out: Span[][] = [];

  // Top spacer row for internal breathing room
  if (withSpacers) out.push([span(`${BAR} `, barStyle)]);

  // Title row with warning glyph
  const titleIcon = isError ? "⚠  " : "";
  const titleStyle = isError ? styles.errorBold : styles.bold;
  out.push([span(`${BAR} `, barStyle), ...truncateSpans([span(`${titleIcon}${modal.title}`, titleStyle)], inner)]);

  // Spacer between title and body
  if (withSpacers) out.push([span(`${BAR} `, barStyle)]);

  const wrapped = wrapSpans(modal.body, inner);
  // One of the body's rows goes to the marker when there is a remainder.
  const actualBudget = withSpacers ? Math.max(bodyBudget - 2, 1) : bodyBudget;
  const shown = wrapped.length > actualBudget ? wrapped.slice(0, Math.max(actualBudget - 1, 0)) : wrapped;
  const hidden = wrapped.length - shown.length;
  for (const line of shown) out.push([span(`${BAR} `, barStyle), ...line]);
  if (hidden > 0 && actualBudget >= 1) {
    const tail = hidden === 1 ? "1 more line" : `${hidden} more lines`;
    out.push([span(`${BAR} `, barStyle), span(`… ${tail}`, styles.faint)]);
  }

  // Spacer between body and decision chips
  if (withSpacers) out.push([span(`${BAR} `, barStyle)]);

  // The decision row: one chip per key, with full clickable width covering button and label
  const chips: { index: number; start: number; end: number }[] = [];
  const decisions: Span[] = [];
  let column = 0;
  if (modal.question) {
    decisions.push(span(`${modal.question}  `, styles.dim));
    column += modal.question.length + 2;
  }
  modal.choices.forEach((choice, index) => {
    if (index > 0) {
      decisions.push(span(" · ", styles.faint));
      column += 3;
    }
    const text = choice.key === "esc" ? CLOSE_CHIP : `[${choice.key}]`;
    const keyWidth = textWidth(text);
    const btnWidth = keyWidth + 1 + choice.label.length;

    // Full button + label is clickable by mouse
    if (column + btnWidth <= inner) {
      chips.push({
        index,
        start: column + DECISION_PREFIX,
        end: column + DECISION_PREFIX + btnWidth - 1,
      });
    }

    const keyStyle = isError && (choice.key === "r" || choice.key === "enter") ? styles.errorBold : styles.accentBold;
    decisions.push(span(text, keyStyle));
    column += keyWidth;
    decisions.push(span(` ${choice.label}`, isError ? styles.bold : styles.dim));
    column += choice.label.length + 1;
  });

  const decisionRowOffset = out.length;
  out.push([span(`${BAR} `, barStyle), ...truncateSpans(decisions, inner)]);
  return { box: out, chips, decisionRowOffset };
}

type Bottom = {
  lines: string[];
  rows: BodyLine[];
  caretRow: number | null;
  caretCol: number;
  hits: Hit[];
  /** The prompt box's own rows, as indices into `rows`, or null when it is hidden. */
  prompt: PromptBox | null;
};

function renderBottom(
  state: TuiState,
  styles: Styles,
  theme: Theme,
  width: number,
  usable: number,
  margin: number,
  paletteRoom: number,
): Bottom {
  const rows: BodyLine[] = [];
  const push = (spans: Span[], background: string): void => {
    rows.push({ spans, background });
  };
  const indent = " ".repeat(margin);
  /** Rows a click can land on, in rows of this block. */
  const hits: Hit[] = [];
  let caretRow: number | null = null;
  let caretCol = 0;
  let prompt: Bottom["prompt"] = null;

  push([span("─".repeat(usable), styles.rule)], theme.bg);
  // The palette floats over the transcript rather than sitting on a surface of
  // its own, so it keeps the background the text behind it was drawn on.
  if (state.palette) {
    const palette = renderPalette(state.palette, styles, usable, margin, paletteRoom);
    // The rule row above it is already on screen, so the palette's own first row
    // is the one after that.
    for (const hit of palette.hits) hits.push({ ...hit, row: hit.row + 1 });
    for (const line of palette.lines) push(line, theme.bg);
  }

  // The `@` completions sit where the palette would: above the prompt, on the
  // page background. No click targets — the list is small and keyboard-first —
  // and no border, for the same reason the prompt box has none.
  if (state.mentions && state.mentions.items.length > 0) {
    const selected = clamp(state.mentions.selected, 0, state.mentions.items.length - 1);
    for (const [offset, item] of state.mentions.items.slice(0, 8).entries()) {
      const isSelected = offset === selected;
      push(
        [
          span(indent),
          span(isSelected ? "▌" : " ", isSelected ? styles.accent : styles.faint),
          span(`@${item.label}`, isSelected ? styles.accentBold : styles.accent),
          ...(item.description ? [span(`  ${item.description}`, styles.dim)] : []),
          span(" ", isSelected ? styles.paletteSelected : undefined),
        ],
        theme.bg,
      );
    }
  }

  // Right-click / attachment clipboard menu opened directly in the chat input area
  if (state.clipboardMenu) {
    const cm = state.clipboardMenu;
    const boxWidth = Math.min(width, 76);
    const inside = Math.max(boxWidth - 2, 20);
    const borderStyle = styles.faint;
    const leftPad = span(indent);

    const row = (spans: Span[]): void => {
      const truncated = truncateSpans(spans, inside);
      const gap = Math.max(inside - spansWidth(truncated), 0);
      push([leftPad, span("│", borderStyle), ...truncated, span(" ".repeat(gap)), span("│", borderStyle)], theme.bg);
    };

    const divider = (title?: string): void => {
      if (title) {
        const titleText = `─ ${title} `;
        const filler = Math.max(inside - textWidth(titleText), 0);
        push([leftPad, span("├", borderStyle), span(titleText, borderStyle), span("─".repeat(filler), borderStyle), span("┤", borderStyle)], theme.bg);
      } else {
        push([leftPad, span("├", borderStyle), span("─".repeat(inside), borderStyle), span("┤", borderStyle)], theme.bg);
      }
    };

    const titlePrefix = " Clipboard & Recent History (Last 5) ";
    const closeSuffix = ` ${CLOSE_CHIP} `;
    const fillerTop = Math.max(inside - textWidth(titlePrefix) - textWidth(closeSuffix), 0);
    const titleRow = rows.length;
    push([
      leftPad,
      span("┌─", borderStyle),
      span("Clipboard & Recent History (Last 5) ", styles.bold),
      span("─".repeat(fillerTop), borderStyle),
      span(` ${CLOSE_CHIP}`, styles.hintKey),
      span(" ┐", borderStyle),
    ], theme.bg);
    hits.push(...closeChipHits(titleRow, rows[titleRow]?.spans ?? [], 0));

    // Preview area: Real image grid (true-color half-blocks or ANSI grid) or line-numbered text
    if (cm.preview) {
      if (cm.preview.kind === "image" && cm.preview.image) {
        const img = cm.preview.image;
        const dims = img.width && img.height ? `${img.width}×${img.height} px · ` : "";
        const sizeKb = Math.max(Math.round(img.bytes / 1024), 1);
        const imgHeader = `Image Preview: ${img.mime} · ${dims}${sizeKb} KB`;
        row([span(" "), span(imgHeader, styles.accentBold)]);
        if (img.pixelRows && img.pixelRows.length > 0) {
          for (const pixelRow of img.pixelRows) {
            row([span("   "), ...pixelRow]);
          }
        } else if (img.grid && img.grid.length > 0) {
          for (const gridLine of img.grid) {
            row([span("   "), span(gridLine)]);
          }
        }
      } else if (cm.preview.kind === "text" && cm.preview.lines) {
        const info = `Text Preview (${cm.preview.totalLines ?? cm.preview.lines.length} lines · ${cm.preview.totalChars ?? cm.preview.text?.length ?? 0} chars):`;
        row([span(" "), span(info, styles.accentBold)]);
        for (const line of cm.preview.lines) {
          row([span("   "), span(line, styles.dim)]);
        }
      } else {
        const emptyMsg = "Clipboard is currently empty (no recent copies)";
        row([span(" "), span(emptyMsg, styles.faint)]);
      }
      divider("Choose from History or Actions");
    }

    const selected = clamp(cm.selected, 0, Math.max(cm.items.length - 1, 0));
    for (const [offset, item] of cm.items.entries()) {
      if (item.label.startsWith("───")) {
        divider(item.description);
        continue;
      }
      const isSelected = offset === selected;
      const rowIdx = rows.length;
      hits.push({ kind: "clipboard_menu", row: rowIdx, index: offset });
      const hasLeadingNumber = /^\d+\.\s/.test(item.label);
      const numPrefix = hasLeadingNumber ? "" : `${offset + 1}. `;
      const marker = isSelected ? "❯ " : "  ";

      const itemSpans: Span[] = [
        span(" "),
        span(marker, isSelected ? styles.accent : styles.faint),
        ...(numPrefix ? [span(numPrefix, isSelected ? styles.accentBold : styles.dim)] : []),
        span(item.label, isSelected ? styles.accentBold : styles.text),
        ...(item.description ? [span(`  ${item.description}`, isSelected ? styles.accent : styles.dim)] : []),
      ];
      row(itemSpans);
    }

    const footerText = ` ${CLOSE_CHIP} close · ↑↓ select · 1-5 choose · enter paste `;
    const fillerBottom = Math.max(inside - textWidth(footerText), 0);
    const footerRow = rows.length;
    push([
      leftPad,
      span("└─", borderStyle),
      span(CLOSE_CHIP, styles.hintKey),
      span(" close · ↑↓ select · 1-5 choose · enter paste", styles.hint),
      span(` ${"─".repeat(fillerBottom)}`, borderStyle),
      span("┘", borderStyle),
    ], theme.bg);
    hits.push(...closeChipHits(footerRow, rows[footerRow]?.spans ?? [], 0));
  }

  // A permission prompt is not drawn here: it floats centered over the
  // transcript (see renderFrame), because the middle of the screen is where
  // the eye is. The prompt box stays hidden with it — the modal owns the
  // keyboard, so a caret in a box that cannot take typing would be a lie.
  // One filled panel with an amber bar reads as "answer this", where a bar
  // per row on the transcript's own background reads as more transcript.
  //
  // The surface the box is drawn on: the same fill a user's own turn sits
  // on, so the place being typed into is visibly the same material as the
  // words it will become. `panel` (the tab bar, a card) sat one step off the
  // page and read as one more line of transcript.
  const boxBg = theme.input;
  // A list or a panel is on screen and the keys belong to it. An input line
  // that cannot be typed into would only invite typing that goes nowhere —
  // and a menu's own search field already says where typing goes. The box
  // being on screen is also what decides whether the mode row under it has to
  // name the mode: the box's own pill says it whenever the box is there.
  const boxShown = !state.modal && !state.picker && !state.menu && !(state.ask && !state.askTyping);

  // Messages queued while a turn was running wait here, above the box, so what
  // will run next is visible without reaching for `/queue`. Each queued message
  // is its own row with two controls: `[x]` drops just that one, and `[Add+]`
  // hands it to the turn already running — a queue is right when the next words
  // can wait, and the second button is for when they cannot.
  if (boxShown && state.queue && state.queue.length > 0) {
    const queueWidth = Math.min(width, 76);
    const inside = Math.max(queueWidth - 2, 20);
    const borderStyle = styles.faint;
    const leftPad = span(indent);
    const addLabel = "[Add+]";
    const dropLabel = "[x]";
    const addWidth = textWidth(addLabel);
    const dropWidth = textWidth(dropLabel);
    // The two chips travel as one block, `[Add+]` first: reaching for a queued
    // message to make the agent read it *now* is the common case, and dropping
    // it is the rarer, more final act — so the order is by which is wanted more
    // often, not by which is listed first anywhere else.
    const chipsWidth = addWidth + 1 + dropWidth;
    const topContent = `─ Queued (${state.queue.length}) `;
    push(
      [
        leftPad,
        span("┌", borderStyle),
        span(topContent, styles.bold),
        span("─".repeat(Math.max(inside - textWidth(topContent), 0)), borderStyle),
        span("┐", borderStyle),
      ],
      theme.bg,
    );
    state.queue.forEach((text, index) => {
      const body = ` ${index + 1}. ${text}`;
      const truncated = cut(body, Math.max(inside - chipsWidth - 2, 4));
      const truncWidth = textWidth(truncated);
      const gap = Math.max(inside - truncWidth - chipsWidth - 1, 0);
      const row = rows.length;
      const addCol = margin + 2 + truncWidth + gap;
      const dropCol = addCol + addWidth + 1;
      push(
        [
          leftPad,
          span("│", borderStyle),
          span(truncated, styles.text),
          span(" ".repeat(gap)),
          span(addLabel, styles.hintKey),
          span(" ", borderStyle),
          span(dropLabel, styles.hintKey),
          span(" ", borderStyle),
          span("│", borderStyle),
        ],
        theme.bg,
      );
      hits.push({ kind: "queued_add", row, index, colStart: addCol, colEnd: addCol + addWidth - 1 });
      hits.push({ kind: "queued", row, index, colStart: dropCol, colEnd: dropCol + dropWidth - 1 });
    });
    push([leftPad, span("└", borderStyle), span("─".repeat(inside), borderStyle), span("┘", borderStyle)], theme.bg);
  }

  // The plan panel: the tracked checklist and any running goal, right-aligned
  // just above the box. Narrow on purpose — it is a glance, not the transcript —
  // and hidden with the box, so a card that owns the screen is not sharing it.
  if (boxShown && state.todoPanel && state.plan) {
    const panelWidth = clamp(Math.min(44, width - 2), 20, 44);
    const panel = renderPlanPanel(state.plan, styles, panelWidth);
    const left = Math.max(usable - panelWidth, 0);
    const base = rows.length;
    panel.rows.forEach((spans, offset) => {
      const gap = Math.max(usable - left - spansWidth(spans), 0);
      push([span(" ".repeat(left)), ...spans, span(" ".repeat(gap))], theme.bg);
      if (offset === panel.closeRow) {
        const colStart = left + panel.closeStart + 1;
        hits.push({ kind: "close", row: base + offset, index: 0, colStart, colEnd: colStart + panel.closeWidth - 1 });
      }
    });
  }

  if (boxShown) {
    const attachedCount = state.attachedImages ?? 0;
    const badges: Span[] = [];
    let badgeWidth = 0;
    if (attachedCount > 0) {
      for (let i = 1; i <= attachedCount; i++) {
        const text = `[Image ${i}]`;
        badges.push(span(text, styles.imageBadge), span(" "));
        badgeWidth += text.length + 1;
      }
    }
    // Documents carry their own name — what was attached is the useful part.
    for (const name of state.attachedDocs ?? []) {
      const text = `[${cut(name, 24)}]`;
      badges.push(span(text, styles.imageBadge), span(" "));
      badgeWidth += text.length + 1;
    }

    // Right controls: `UPLOAD[+]` — plain text, no emoji, and it is spelled out
    // so the glyph is not a riddle. The button opens the platform's
    // file-selection window, so attaching is a click and not a slash command to
    // remember. Send has no button of its own: a filled arrow was the loudest
    // thing on a quiet screen for the one action the keyboard already has
    // (enter). The variant is changed with `/effort`, which needs no button
    // either.
    const uploadText = "UPLOAD[+]";
    const uploadLen = textWidth(uploadText);
    // The trailing space is part of the control, so the gap arithmetic matches
    // exactly what is drawn and the row never overflows. Queuing is a keyboard
    // action — enter while a turn runs — so the box carries no button for it;
    // the only control a click can do that the keyboard cannot is opening the
    // platform's file dialog, and that is what is left here.
    const rightLen = uploadLen + 1;

    // The mode pill, on the box's own left edge.
    //
    // It is the word the state row below used to carry, drawn as the button it
    // now is: a press on it cycles the mode the way shift+tab does. It leads the
    // row because it answers the question the row is about — what this box will
    // do with what is typed into it — and a button that changes the session
    // belongs where the session's own writing starts.
    const mode = modeWord(state, styles);
    const modeWordText = mode.text.toUpperCase();
    const pillText = `[${modeWordText}]`;
    const pillWidth = textWidth(pillText);
    // The pill's own trailing cell: one gap, so the words after it are not
    // touching the button that changed the mode they will be read in.
    const pillGap = 1;

    const availableWidth = Math.max(width - pillWidth - pillGap - badgeWidth - rightLen, 10);
    const placeholder = attachedCount > 0 ? "" : (state.ask ? "Type your answer…" : PLACEHOLDER);
    const view = editorRows(state.editor, styles, availableWidth, placeholder);

    // Brackets, with the mode's own word between them: the shape of every other
    // key the interface offers (`[esc]`, `[y]`), so a press is legible as one.
    const pillSpans: Span[] = [
      span("[", styles.pillBorder),
      span(modeWordText, mode.style),
      span("]", styles.pillBorder),
    ];
    const rightControls: Span[] = [span("UPLOAD", styles.hintKey), span("[+]", styles.plusButton), span(" ")];

    // The box is fill and nothing else: no bar down its left edge, no border,
    // and two rows of its own fill above the text and two below. The fill is
    // what says "this is the typing area" — the bar was doing that job and
    // talking over the surface it was marking out.
    //
    // `gutter` is the inset a request block's bar has, so the box opens in the
    // same column as the conversation above it — and the pill takes the column
    // that block's text would have begun in, one gap in from the gutter.
    const gutter = span(`${indent}  `);
    push([span(indent)], boxBg);
    const boxTop = rows.length - 1;
    push([span(indent)], boxBg);
    const firstTextRow = rows.length;
    // The rows under the first keep the same text column, so a wrapped prompt
    // stays one block of text rather than starting over at the gutter.
    const badgePad: Span[] = badgeWidth > 0 ? [span(" ".repeat(badgeWidth))] : [];
    // The rows under the first pad the pill out instead of drawing it again:
    // the pill is the row's button, and one button per wrapped line would read
    // as a column of them. The pads keep every row's text in one column.
    const pillPad = span(" ".repeat(pillWidth));
    view.rows.forEach((row, index) => {
      // The controls ride the row being typed on, for the same reason.
      const trailing = index === 0 ? rightLen : 0;
      const lead = pillWidth + pillGap;
      const gap = Math.max(width - lead - badgeWidth - spansWidth(row.spans) - trailing, 0);
      push(
        [
          gutter,
          ...(index === 0 ? pillSpans : [pillPad]),
          span(" ".repeat(pillGap)),
          ...(index === 0 ? badges : badgePad),
          ...row.spans,
          span(" ".repeat(gap)),
          ...(index === 0 ? rightControls : []),
        ],
        boxBg,
      );
    });
    caretRow = firstTextRow + view.caretRow;
    caretCol = badgeWidth + view.caretCol;
    // Two rows of air under the text: what is being typed and where it will go
    // are two different answers, and stacked flush they read as one run of
    // text. The box carries its mass below the text so the words are not pinned
    // to the fill's top edge.
    push([span(indent)], boxBg);
    push([span(indent)], boxBg);
    prompt = {
      top: boxTop,
      bottom: rows.length - 1,
      // One-based, which is what a mouse reports: the gutter and its two cells,
      // the pill and its gap, then whatever the badges take.
      textLeft: margin + 4 + pillWidth + badgeWidth,
      rows: view.rows.map((row, index) => ({ row: firstTextRow + index, start: row.start, end: row.end })),
      // Both controls, in the columns they were drawn in — the boxes the app
      // presses, so neither it nor a future change has to redo this arithmetic.
      modeButton: { row: firstTextRow, colStart: margin + 3, colEnd: margin + 2 + pillWidth },
      uploadButton: { row: firstTextRow, colStart: usable - uploadLen, colEnd: usable - 1 },
    };
  }

  // The state row shares the box the prompt (or the ask) is in, and stands
  // alone on the background only when there is no box under it at all. It is
  // filled with whatever is over it: the permission card's own panel while a
  // decision is up, the box when there is one to type into, and the page
  // otherwise — and it carries no bar of its own, because the fill under it
  // already says which box it belongs to.
  //
  // The mode leads the row only when the box is not on screen: with the box up,
  // the pill inside it already says the mode, and a row that says the same thing
  // twice spends its width on an answer the eye has already been given. One
  // screen names the mode exactly once — the pill, or the row that stands in for
  // it while a card has the keyboard.
  const isErrorModal = state.modal && (state.modal.tone === "error" || /failed|rate.?limit|error|denied|refused/i.test(state.modal.title));
  const stateRowBg = state.modal
    ? (isErrorModal ? blend(theme.panel, theme.error, 0.35) : theme.panel)
    : !state.picker && !state.ask && !state.menu
      ? boxBg
      : theme.bg;
  // The tracked-work chip rides the state row's right end: it says how much of
  // the checklist (or the goal) is done, and pressing it opens the panel. The
  // row is what has the room, and the row is where a session's own status lives.
  const stateSpans = modeSpans(state, styles, width, indent, !boxShown);
  // Not while a card is up: the panel it opens is hidden then, and a button
  // that visibly does nothing is worse than one that is not there.
  // `[USAGE]` rides there too: the session's own cost is the same kind of
  // status, and it is the one thing the row can offer that asks a question with
  // a number for an answer. It is always present — unlike the TODO chip, which
  // only exists when something is tracked — so a session with nothing running
  // still has a way to ask what it has spent.
  const chips: { kind: PanelKind; spans: Span[] }[] = [];
  if (boxShown && state.plan) {
    const plan = planChip(state.plan, styles);
    if (plan) chips.push({ kind: "todo_button", spans: plan });
  }
  if (boxShown) {
    chips.push({
      kind: "usage_button",
      spans: [span("[", styles.pillBorder), span("USAGE", styles.hintKey), span("]", styles.pillBorder)],
    });
  }
  if (chips.length > 0) {
    const chipsWidth = chips.reduce((sum, chip) => sum + spansWidth(chip.spans), 0) + (chips.length - 1);
    const gap = Math.max(usable - spansWidth(stateSpans) - chipsWidth - 1, 1);
    const rowSpans: Span[] = [...stateSpans, span(" ".repeat(gap))];
    let col = spansWidth(stateSpans) + gap + 1;
    chips.forEach((chip, index) => {
      if (index > 0) rowSpans.push(span(" "));
      rowSpans.push(...chip.spans);
      const chipWidth = spansWidth(chip.spans);
      hits.push({ kind: chip.kind, row: rows.length, index: 0, colStart: col, colEnd: col + chipWidth - 1 });
      col += chipWidth + 1;
    });
    push(rowSpans, stateRowBg);
  } else {
    push(stateSpans, stateRowBg);
  }
  // The footer's own chips close whatever is open, so escape is a mouse action
  // here too. Its columns are read off the packed row, which is the only place
  // that knows where they landed.
  const footer = footerSpans(state, styles, usable);
  hits.push(...closeChipHits(rows.length, footer, 0));
  push(footer, theme.bg);

  return { lines: rows.map((row) => paint(row.spans, row.background, usable)), rows, caretRow, caretCol, hits, prompt };
}

/**
 * What the session's mode is called, and in what colour.
 *
 * One function, because the pill inside the box and the state row that stands
 * in for it both say it — and two places with their own copy of the words could
 * disagree about which mode the session is in.
 *
 * The colour is the warn one whenever the mode is not the everyday one, so a
 * session that has stopped writing files is noticeable at a glance.
 */
function modeWord(state: TuiState, styles: Styles): { text: string; style: string } {
  const isPaused = Boolean(state.isPaused);
  // A goal run is named while it lasts: it is the same "what is this session
  // doing right now" question, and more specific than Build — the session is
  // executing a goal, not taking edits one request at a time. It is transient,
  // so it is not in the mode cycle.
  const text = isPaused ? "paused" : state.goalActive ? "Goal" : MODE_LABELS[state.mode];
  const style = isPaused || state.mode === "plan" ? styles.warn : styles.mode;
  return { text, style };
}

/**
 * The mode row: what the session may do, then what is in play or happening.
 *
 * With no box on screen it leads with the mode, which is the only place left to
 * read it; with the box up the leading word is dropped, because the box's own
 * pill is already saying it. The variant is warn-coloured for the same reason
 * the mode is: an unusual setting should catch the eye.
 */
/**
 * Dynamic square blocks animation for active status/mode operations.
 * Sweeps a glowing pulse back and forth across 5 square blocks (■/□).
 */
function squareBlocksAnimation(frame: number, styles: Styles): Span[] {
  const count = 5;
  const cycle = (count - 1) * 2;
  const step = frame % cycle;
  const active = step < count ? step : cycle - step;
  const spans: Span[] = [];
  for (let i = 0; i < count; i++) {
    if (i === active) {
      spans.push(span("■ ", styles.accentBold));
    } else if (Math.abs(i - active) === 1) {
      spans.push(span("■ ", styles.accent));
    } else {
      spans.push(span("□ ", styles.faint));
    }
  }
  return spans;
}

function modeSpans(state: TuiState, styles: Styles, width: number, indent: string, showMode: boolean): Span[] {
  const word = modeWord(state, styles);
  const head = [
    span(`${indent}  `),
    ...(showMode ? [span(word.text, word.style), span(" · ", styles.faint)] : []),
  ];
  if (state.busy !== null) {
    const queueNote = state.queuedCount && state.queuedCount > 0 ? ` · ${state.queuedCount} queued` : "";
    const blocks = squareBlocksAnimation(state.spinnerFrame, styles);
    const modeLabel = state.isPaused ? "Paused" : `Working in ${word.text} mode...`;
    const label = state.busy === "thinking…" ? modeLabel : state.busy;
    return [
      span(`${indent}  `),
      ...blocks,
      span(` ${label}${queueNote}`, styles.dim),
    ];
  }

  if (state.copiedNotice) {
    return [
      span(`${indent}  `),
      span("✓ copied", styles.ok),
      span(" · ", styles.faint),
      span(state.copiedNotice, styles.bold),
    ];
  }

  if (state.notice) {
    return [...head, ...truncateSpans([span(state.notice.text, state.notice.style ?? styles.dim)], Math.max(width - 8, 8))];
  }

  const queueSuffix = state.queuedCount && state.queuedCount > 0 ? ` · ${state.queuedCount} queued` : "";
  return [
    ...head,
    span(state.model, styles.bold),
    span(" · ", styles.faint),
    span(`${state.variant}${queueSuffix}`, state.variant === DEFAULT_VARIANT ? styles.faint : styles.warn),
  ];
}

/**
 * The tracked-work chip for the state row, or null when nothing is tracked.
 *
 * A goal is the headline while it runs — the checklist beside it is a means to
 * it — so the chip shows the goal's own subtask progress when one is active,
 * and the checklist's otherwise. Nothing tracked means no chip at all: a
 * `TODO [0/0]` on every quiet session is a button for nothing.
 */
function planChip(plan: PlanSnapshot, styles: Styles): Span[] | null {
  const goalTasks = plan.goal?.tasks ?? [];
  let done: number;
  let total: number;
  if (plan.goal && goalTasks.length > 0) {
    done = goalTasks.filter((task) => task.status === "done").length;
    total = goalTasks.length;
  } else {
    done = plan.todos.filter((todo) => todo.done).length;
    total = plan.todos.length;
  }
  if (total === 0) return null;
  return [span("[", styles.pillBorder), span(`TODO ${done}/${total}`, styles.accent), span("]", styles.pillBorder)];
}

/** One checklist row: `✓` done, `◐` the one in hand, `○` still to come. */
function todoIcon(todo: PlanSnapshot["todos"][number], firstOpen: number, index: number): string {
  if (todo.done) return "✓";
  return todo.inProgress || index === firstOpen ? "◐" : "○";
}

/**
 * The plan panel: a narrow card above the box, on the right.
 *
 * It shows the checklist and, when one is running, the goal's subtasks with a
 * bar each. Rows are returned without their place on screen — the caller owns
 * the right-alignment and the close chip's columns — so the geometry lives in
 * one place the way the prompt box's does.
 */
function renderPlanPanel(
  plan: PlanSnapshot,
  styles: Styles,
  width: number,
): { rows: Span[][]; closeStart: number; closeWidth: number; closeRow: number } {
  const inside = Math.max(width - 2, 16);
  const border = styles.faint;
  const rows: Span[][] = [];

  const bar = (done: number, total: number): Span[] => {
    const filled = total > 0 ? Math.round((done / total) * 10) : 0;
    return [
      span("[", styles.faint),
      span("▓".repeat(filled), styles.accent),
      span("░".repeat(Math.max(10 - filled, 0)), styles.faint),
      span("]", styles.faint),
      span(`  ${done}/${total}`, styles.dim),
    ];
  };

  /** A bordered content row, padded out to the panel's inner width. */
  const row = (inner: Span[]): void => {
    const gap = Math.max(inside - spansWidth(inner), 0);
    rows.push([span("│", border), ...inner, span(" ".repeat(gap)), span("│", border)]);
  };

  // The title row carries the `[×]`, so the caller can make it a target.
  const title = " TODO ";
  const close = `[${TAB_CLOSE}]`;
  const closeWidth = textWidth(close);
  const titleFiller = Math.max(inside - textWidth(title) - closeWidth, 0);
  rows.push([
    span("┌", border),
    span(title, styles.bold),
    span("─".repeat(titleFiller), border),
    span(close, styles.hintKey),
    span("┐", border),
  ]);
  const closeStart = 1 + textWidth(title) + titleFiller;
  const closeRow = 0;

  const todos = plan.todos;
  const firstOpen = todos.findIndex((todo) => !todo.done);
  if (todos.length > 0) {
    const done = todos.filter((todo) => todo.done).length;
    row([span(" "), ...bar(done, todos.length)]);
    todos.forEach((todo, index) => {
      const icon = todoIcon(todo, firstOpen, index);
      const iconStyle = todo.done ? styles.dim : icon === "◐" ? styles.accent : styles.faint;
      row([span(` ${icon} `, iconStyle), span(cut(todo.text, inside - 6), todo.done ? styles.dim : styles.text)]);
    });
  }

  const goal = plan.goal;
  if (goal && goal.tasks.length > 0) {
    if (todos.length > 0) row([span(" "), span("─".repeat(Math.max(inside - 2, 1)), border)]);
    const done = goal.tasks.filter((task) => task.status === "done").length;
    row([span(" "), span(`Goal · ${goal.status}`, styles.bold), span(`  ${done}/${goal.tasks.length}`, styles.dim)]);
    row([span(" "), span(cut(goal.title, inside - 4), styles.text)]);
    for (const task of goal.tasks) {
      const icon = task.status === "done" ? "✓" : task.status === "in_progress" ? "▸" : "·";
      const iconStyle = task.status === "done" ? styles.dim : task.status === "in_progress" ? styles.accent : styles.faint;
      row([span(` ${icon} `, iconStyle), span(cut(`${task.id}  ${task.title}`, inside - 6), task.status === "done" ? styles.dim : styles.text)]);
    }
    if (goal.current) row([span(" "), span(cut(`now  ${goal.current}`, inside - 4), styles.dim)]);
  }

  rows.push([span("└", border), span("─".repeat(inside), border), span("┘", border)]);
  return { rows, closeStart, closeWidth, closeRow };
}

/**
 * The last row: where you are, what this session has cost, and the one key worth
 * naming.
 *
 * The path is shortened last, so the numbers and the hint survive a narrow
 * terminal — a path is recognisable from its tail, a percentage is not.
 */
function footerSpans(state: TuiState, styles: Styles, usable: number): Span[] {
  // Packed right to left, dropping whole pieces rather than truncating one.
  // A session that has used nothing shows nothing rather than a bare zero.
  const spent = state.usage.tokens > 0 || state.usage.tools > 0;
  const groups: Span[][] = [footerHints(styles, state), spent ? usageSpans(state, styles) : []].filter(
    (group) => group.length > 0,
  );

  let packed: Span[] = [];
  for (const group of groups) {
    const candidate = packed.length > 0 ? [...group, span("   "), ...packed] : [...group];
    if (spansWidth(candidate) + 12 <= usable) packed = candidate;
  }

  const room = Math.max(usable - spansWidth(packed) - 5, 4);
  const left: Span[] = [span(shortenPath(state.cwd, room), styles.hint), span("  ·", styles.faint)];

  const gap = Math.max(usable - spansWidth(left) - spansWidth(packed) - 1, 1);
  return [...left, span(" ".repeat(gap)), ...packed];
}

/** Context used, and how much of the window that is. */
function usageSpans(state: TuiState, styles: Styles): Span[] {
  const { tokens, budget, tools } = state.usage;
  const parts: Span[] = [];

  if (tools > 0) {
    parts.push(span(`↓ ${tools} ${tools === 1 ? "tool" : "tools"}`, styles.dim), span(" · ", styles.faint));
  }
  parts.push(span(formatTokens(tokens), styles.dim));
  if (budget > 0 && tokens > 0) {
    parts.push(span(` (${Math.min(Math.round((tokens / budget) * 100), 999)}%)`, styles.faint));
  }
  return parts;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}K`;
}

function askHints(styles: Styles, typing: boolean): Span[] {
  const pairs: [string, string][] = typing
    ? [
        ["enter", "confirm"],
        ["esc", "cancel"],
      ]
    : [
        ["tab", "next"],
        ["↑↓", "select"],
        ["enter", "confirm"],
        ["esc", "dismiss"],
      ];

  return hintPairs(pairs, styles);
}

/**
 * The footer hint.
 *
 * OpenCode names one key here, and it is the right one to name: the palette is
 * where every other key is written down. Session switching and quitting are in
 * `/help`, which is one keystroke away.
 */
function footerHints(styles: Styles, state: TuiState): Span[] {
  // The modal is checked first because it claims every key while it is up, even
  // if a panel is still on screen behind it — naming the panel's keys there
  // would name keys that do nothing.
  //
  // Its body already lists y/a/n. Escape and Ctrl+C are the ones it does not
  // name: both mean no, but Ctrl+C also stops the turn, and that difference is
  // the whole reason to press it here instead of Escape.
  // The card names its own answers and the footer names the rest, so between
  // them every key is written down exactly once. The recovery card names all
  // three of its keys and adds nothing here.
  if (state.modal) return state.modal.footer ? hintPairs(state.modal.footer, styles) : [];
  if (state.clipboardMenu) return hintPairs([["esc", "close"], ["↑↓", "select"], ["1-5", "choose"], ["enter", "paste"]], styles);
  if (state.ask) return askHints(styles, state.askTyping);
  if (state.picker) return hintPairs([["↑↓", "select"], ["enter", "confirm"], ["esc", "close"]], styles);
  // A menu names its own keys on its own last row, where they are true — the
  // session's footer is a row about the session, and the panel's keys are not.
  if (state.menu) return [];
  return [];
}

/**
 * The tab row: the filters across the top of a list.
 *
 * The active one is the accent colour and the rest are faint, so the row reads
 * as "you are on this one" at a glance rather than needing a marker beside it.
 */
function tabSpans(tabs: { labels: readonly string[]; active: number }, styles: Styles): Span[] {
  return tabs.labels.flatMap((label, index) => [
    ...(index > 0 ? [span("   ", styles.hint)] : []),
    span(label, index === tabs.active ? styles.accentBold : styles.faint),
  ]);
}

function hintPairs(pairs: readonly (readonly [string, string])[], styles: Styles): Span[] {
  return pairs.flatMap(([key, label], index) => [
    ...(index > 0 ? [span("  ", styles.hint)] : []),
    span(key === "esc" ? CLOSE_CHIP : key, styles.hintKey),
    span(` ${label}`, styles.hint),
  ]);
}

/**
 * A footer written as prose by its caller, with `esc` drawn as the close chip.
 *
 * A menu names its own keys in a sentence (`‹/› change · ↑↓ move · esc close`),
 * so the chip is found by splitting on the word: every panel then offers a mouse
 * the same way out, without the caller having to know about either.
 */
function hintLine(text: string, styles: Styles): Span[] {
  return text.split("esc").flatMap((part, index) => [
    ...(index > 0 ? [span(CLOSE_CHIP, styles.hintKey)] : []),
    ...(part ? [span(part, styles.hint)] : []),
  ]);
}

/**
 * One click target per close chip in a finished row.
 *
 * The chip is found by walking the row it was drawn in, so a target can never
 * drift from where the glyph landed — however the row was packed, padded or
 * truncated, and whatever sits to its left.
 */
function closeChipHits(row: number, spans: readonly Span[], origin: number): Hit[] {
  const hits: Hit[] = [];
  let column = origin;
  for (const item of spans) {
    const raw = item.text.trim();
    if (raw === CLOSE_CHIP || raw === "[x]" || raw === "[×]" || raw === "×" || raw === "x") {
      const leadSpaces = item.text.length - item.text.trimStart().length;
      const chipStart = column + leadSpaces + 1;
      const chipWidth = textWidth(raw);
      hits.push({
        kind: "close",
        row,
        index: 0,
        colStart: chipStart,
        colEnd: chipStart + chipWidth - 1,
      });
    } else {
      const match = /\[[×x]\]/g;
      let m: RegExpExecArray | null;
      while ((m = match.exec(item.text)) !== null) {
        const chipStart = column + m.index + 1;
        const chipWidth = textWidth(m[0]);
        hits.push({
          kind: "close",
          row,
          index: 0,
          colStart: chipStart,
          colEnd: chipStart + chipWidth - 1,
        });
      }
    }
    column += textWidth(item.text);
  }
  return hits;
}

/**
 * Keeps the tail of a long path, which is the informative half — and never
 * cuts an escape-code-free path mid-separator.
 */
export function shortenPath(full: string, max: number): string {
  if (full.length <= max || max < 4) return full.slice(0, Math.max(max, 1));
  const tail = full.slice(full.length - (max - 1));
  const cut = Math.max(tail.lastIndexOf("\\"), tail.lastIndexOf("/"));
  return `…${cut >= 0 ? tail.slice(cut) : tail}`;
}
