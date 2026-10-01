import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Agent, ApprovalDecision, ApprovalRequest, ApproveFn } from "../agent/loop";
import type { AskAnswer, AskFn, AskOption, AskQuestion } from "../agent/ask";
import type { ChatMessage } from "../types";
import {
  CLEAR_SCREEN,
  CURSOR_HOME,
  DISABLE_MOUSE,
  DISABLE_PASTE,
  DISABLE_WRAP,
  ENABLE_MOUSE,
  ENABLE_PASTE,
  ENABLE_WRAP,
  ENTER_ALT_SCREEN,
  HIDE_CURSOR,
  LEAVE_ALT_SCREEN,
  SHOW_CURSOR,
  cursorTo,
  flatten,
  setColorEnabled,
  sliceCells,
  span,
  type Span,
} from "./ansi";
import { COMMANDS, commandQuery, filterCommands, isAvailable, stepSelectable, type Command } from "./commands";
import { LineEditor } from "./editor";
import { KeyDecoder, type Key, type MouseKey } from "./keys";
import {
  DEFAULT_VARIANT,
  MODES,
  MODE_LABELS,
  NEW_TAB,
  filterPickItems,
  formatTokens,
  nextMode,
  renderFrame,
  stepPick,
  type Modal,
  type PanelRow,
  type PickItem,
  type PromptBox,
  type Selection,
  type SessionMode,
  type TabHit,
  type TabInfo,
  type TuiState,
  type ClipboardMenuState,
} from "./frame";
import {
  DEFAULT_THEME,
  THEMES,
  buildStyles,
  isThemeName,
  themeByName,
  themeNames,
  type Styles,
  type Theme,
} from "./theme";
import { type MenuPanel, type MenuRow, filterMenuRows, stepMenuRow } from "./menu";
import {
  type SettingDef,
  type ViewSettings,
  defaultViewSettings,
  filterSettings,
  settingDefs,
  settingOptions,
  stepSetting,
} from "./settings";
import type { AddProviderResult } from "../providers/services";
import {
  decodeImagePreview,
  formatTextPreview,
  type ClipboardRead,
  type PastedImage,
} from "../clipboard";
import {
  activeToken,
  buildMentionIndex,
  completeMention,
  expandMentions,
  type MentionIndex,
  type MentionItem,
} from "../mentions";
import type { RouteHealthLine } from "../routes/health";
import { applyEvent, entriesFromHistory, entriesToText, summarizeArgs, type Entry, type Tone } from "./transcript";
import { readAttachedFile, docBlock, type AttachedDoc } from "./attach";

/**
 * The TUI runtime.
 *
 * Owns the terminal (alternate screen, raw mode), the transcript, and session
 * switching. Everything visual lives in `frame.ts`; this file is about state
 * transitions and the keyboard.
 */

export type SessionSummary = {
  id: string;
  title: string;
  /** ISO timestamp of the last turn, for the picker's trailing note. */
  updatedAt?: string;
  /** Turns in the session, for the picker's trailing note. */
  messageCount?: number;
  /** Model the session used — searched, not shown. */
  model?: string;
  /** Opening request, capped — searched, not shown. */
  preview?: string;
};

/**
 * A model id that is a free route.
 *
 * Gateways mark free routes with a `:free` suffix (OpenRouter's convention,
 * which is also what `config.ts` reads), and a few use a `/free` router id.
 */
function isFree(
  id: string,
  modelInfo?: {
    free?: boolean;
    promptPrice?: number;
    completionPrice?: number;
    description?: string;
  },
): boolean {
  if (modelInfo) {
    if (modelInfo.free === true) return true;
    if (
      (modelInfo.promptPrice === 0 && modelInfo.completionPrice === 0) ||
      (modelInfo.promptPrice === 0 && modelInfo.completionPrice === undefined) ||
      (modelInfo.promptPrice === undefined && modelInfo.completionPrice === 0)
    ) {
      return true;
    }
    if (
      modelInfo.description &&
      (/\bfree\b/i.test(modelInfo.description) || /\$0\.00/i.test(modelInfo.description))
    ) {
      return true;
    }
  }
  return /free/i.test(id);
}

/** The model list's tabs: everything, or only the routes that cost nothing. */
type ModelFilter = "all" | "free" | "paid";
const MODEL_FILTERS: readonly ModelFilter[] = ["all", "free", "paid"];
const MODEL_FILTER_LABELS = ["all", "free", "paid"] as const;

/** When a session last ran, in words for recent days and a date past that. */
function formatSessionDate(iso: string): string | null {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  const diffDays = Math.floor((Date.now() - time) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return iso.slice(0, 10);
}

/** Groups sessions by calendar date: Today, Tue Sep 29 2026, etc. */
function sessionGroup(session: SessionSummary): string {
  let date: Date | null = null;
  if (session.updatedAt) {
    const t = Date.parse(session.updatedAt);
    if (!Number.isNaN(t)) date = new Date(t);
  }
  if (!date && session.id) {
    const m = session.id.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }
  }
  if (!date) return "Other";

  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) return "Today";

  return date.toDateString();
}

/** One line describing the session's token budget, either way. */
function budgetLine(spent: number, limit: number): string {
  if (limit <= 0) return `budget none · ~${formatTokens(spent)} tokens used`;
  return `budget ~${formatTokens(spent)} of ${formatTokens(limit)} tokens`;
}

/**
 * Everything an agent needs that the UI can change while it runs.
 *
 * The model, the directory and the variant are the TUI's state, not the
 * configuration's: `/models`, `/cd` and `/variants` change them for this
 * session, and each change rebuilds the agent from the same transcript.
 */
export type AgentSettings = {
  approve: ApproveFn;
  ask: AskFn;
  model: string;
  /** The endpoint this agent should talk to, which `/models` can change. */
  baseUrl: string;
  cwd: string;
  variant: string;
  /** Build or plan. The agent refuses file changes and commands in plan mode. */
  mode: SessionMode;
  /** The id this session's transcript is saved under, for per-conversation routing. */
  sessionId: string;
};

/**
 * A model on a specific endpoint.
 *
 * The pair is the unit because the same name can exist on two providers and
 * only one of them may answer to it.
 */
export type ModelRef = { baseUrl: string; model: string };

/** An endpoint the run can reach, offered by the model list's provider key. */
export type ProviderOption = {
  label: string;
  value: string;
  description?: string;
};

export type TuiOptions = {
  cwd: string;
  baseUrl: string;
  version: string;
  model: string;
  /** The window the footer measures the transcript against. */
  contextTokens: number;
  compacting: boolean;
  /**
   * Sessions for a directory, newest first. The directory is passed in because
   * `/cd` moves the session, and the tabs have to follow it.
   */
  listSessions: (cwd: string) => Promise<SessionSummary[]>;
  /** Full history for a session, or null if it vanished. */
  loadSession: (id: string) => Promise<ChatMessage[] | null>;
  /**
   * A fresh agent for a session's history, wired to the TUI's own approval and
   * question channels — the model can only reach the user while the UI that
   * draws the prompts is the one listening.
   */
  createAgent: (history: ChatMessage[], settings: AgentSettings) => Agent;
  /** Persists the transcript for a session. A title is kept once one is set. */
  saveSession: (input: {
    id: string;
    createdAt: string;
    cwd: string;
    messages: ChatMessage[];
    title?: string;
  }) => Promise<void>;
  newSessionId: () => string;
  initial: { id: string; createdAt: string; messages?: ChatMessage[] };
  /** Connected MCP servers, shown on the home screen. */
  mcp?: string | null;
  /** Config files that were read, shown on the home screen. */
  config?: string | null;
  theme?: Theme;
  /** Named theme to start with, when the caller has one. */
  themeName?: string;
  /** What the screen shows, from the config files. */
  view?: ViewSettings;
  /**
   * Writes settings changed in the panel, so a choice outlives the run.
   *
   * Absent when there is nowhere to write: a preview render, or a test. The
   * panel then says the change will not be kept, rather than pretending it was.
   */
  saveView?: (patch: Partial<ViewSettings>) => Promise<{ ok: boolean; file: string; reason?: string }>;
  saveProvider?: (
    name: string,
    provider: { baseUrl: string; apiKey?: string; apiKeyEnv?: string; models?: string[] },
  ) => Promise<void>;
  saveApiKey?: (apiKey: string, baseUrl?: string) => Promise<void>;
  /** The services `/connect` can add, and what adding one does. */
  connect?: {
    list: () => Promise<MenuRow[]>;
    add: (name: string, apiKey?: string) => Promise<AddProviderResult>;
  };
  streams?: { input: NodeJS.ReadStream; output: NodeJS.WriteStream };
  /** Renders one frame to stdout and returns, for eyeballing and bug reports. */
  preview?: boolean;
  /**
   * The endpoint's models, for `/models`. The endpoint is passed in because
   * the model list is what can move the session to another one, so the list has
   * to be asked for from the one in use rather than the one it started on.
   */
  listModels?: (baseUrl: string) => Promise<{
    id: string;
    description?: string;
    free?: boolean;
    promptPrice?: number;
    completionPrice?: number;
  }[]>;
  /**
   * The endpoints this run can actually reach, for the model list's provider
   * key. Empty or missing means one, and the key is not offered.
   */
  listProviders?: () => Promise<ProviderOption[]>;
  /**
   * What the system clipboard holds — an image, text, or nothing. Injected
   * because a test has no clipboard, and absent when the platform is one this
   * run cannot read.
   */
  readClipboard?: () => Promise<ClipboardRead>;
  /**
   * Opens the platform's file-selection window for the attach button and
   * resolves the chosen path — or null for a cancelled dialog. Injected for
   * the same reason `readClipboard` is: a test has no dialog to open, and
   * absent means the click falls back to typing a path into the prompt.
   */
  pickFile?: () => Promise<{ path: string } | null>;
  /**
   * Models kept to hand, offered as their own group at the top of the model
   * list. Absent means favourites are not offered at all.
   */
  favorites?: {
    list: () => Promise<ModelRef[]>;
    save: (favorites: readonly ModelRef[]) => Promise<void>;
  };
  /** Re-reads the config files, for `/reload`. */
  reload?: () => Promise<{ model: string; files: string[] }>;
  /** Writes the transcript out and returns where it went, for `/export`. */
  exportTranscript?: (messages: readonly ChatMessage[], cwd: string) => Promise<string>;
  /** Puts text on the system clipboard, for `/copy`. */
  copyToClipboard?: (text: string) => Promise<boolean>;
  /**
   * What this machine knows about each route it has used — which endpoints
   * answered, when they did not, and why.
   *
   * Absent when nothing is recording it: a test, or a run where the store
   * could not be opened. `/routes` then says so rather than showing a state it
   * does not have.
   */
  routeHealth?: {
    list: () => Promise<RouteHealthLine[]>;
    /** Writes whatever the store's debounce was still holding. */
    flush: () => Promise<void>;
  };
  /** The diff for `/review`, or null when there is nothing to review. */
  gitDiff?: (scope: string, cwd: string) => Promise<string | null>;
  /** Writes kicode.json and AGENTS.md, for `/init`. */
  initialise?: (cwd: string) => Promise<{ file: string; status: string; agents?: string | null; blocked?: boolean }>;
  /** Writes chosen model to kicode.json so selection persists on the device. */
  saveModel?: (model: string, baseUrl?: string) => Promise<void>;
  /** Permanently deletes a session by ID from the store. */
  deleteSession?: (id: string) => Promise<boolean>;
};

const REDRAW_MS = 30;
const MAX_TABS = 3;
/** How many models the `Recent` group remembers. */
const MAX_RECENT_MODELS = 5;
/** How many favourites are kept, matching the store's own limit. */
const MAX_FAVORITES = 20;

/** A model on a specific endpoint; `/models` changes both at once. */
type ModelChoice = ModelRef;

/**
 * A key a picker answers to besides the arrows and Enter.
 *
 * `close` is true by default: an extra that moves to another list is done with
 * this one. An extra that changes a row in place — favouriting a model — keeps
 * the list up, so the choice still there is not lost.
 */
type PickerExtra = {
  hint: readonly [string, string];
  key: string;
  close?: boolean;
  run: (item: PickItem | undefined) => void | Promise<void>;
};

/** One endpoint's models, and why there are none when there are none. */
type ModelGroup = {
  label: string;
  baseUrl: string;
  description?: string;
  models: { id: string; description?: string }[];
  error?: string;
};
/**
 * How long to wait for the rest of an escape sequence before calling a lone
 * `ESC` an Escape press. Long enough for a slow link to finish a sequence,
 * short enough that Escape still feels immediate.
 */
const ESCAPE_GRACE_MS = 40;
/** Label of the row that lets an answer be typed instead of chosen. */
const FREE_TEXT = "Type your own answer";
/** Reasoning efforts worth offering; anything else the endpoint handles itself. */
const VARIANTS = [DEFAULT_VARIANT, "low", "medium", "high"];

/**
 * The key a card's chip names, in the shape a keypress arrives in.
 *
 * A click on a chip is not a second implementation of what the chip does: it is
 * that key, handed to the same handler the keyboard reaches, so the two can
 * never disagree about what `m` or escape means on this screen.
 */
function chipKey(key: string): Key {
  return key === "esc" ? { type: "escape" } : { type: "text", text: key };
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export async function runTui(options: TuiOptions): Promise<number> {
  const input = options.streams?.input ?? process.stdin;
  const output = options.streams?.output ?? process.stdout;
  const theme = options.theme ?? themeByName(options.themeName ?? DEFAULT_THEME);
  const styles = buildStyles(theme);

  if (options.preview) {
    // No raw mode and no alternate screen: this is a plain one-shot draw, so
    // it works over a pipe — which is exactly when it is needed most.
    setColorEnabled(!process.env.NO_COLOR && output.isTTY === true);
    // With --continue this renders the resumed conversation, which is the only
    // way to inspect the transcript layout without a live terminal.
    const state: TuiState = {
      ...blankState(options),
      entries: entriesFromHistory(options.initial.messages ?? []),
    };
    output.write(`${renderFrame(state, terminalSize(output), styles, theme).lines.join("\n")}\n`);
    return 0;
  }

  const app = new TuiApp(options, input, output, styles, theme);
  return app.start();
}

class TuiApp {
  private readonly options: TuiOptions;
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  /** Both are rebuilt by `/themes`, so neither is readonly. */
  private styles: Styles;
  private theme: Theme;
  /** The theme in use by name — what `/themes` marks, and a preview never changes. */
  private themeName: string;

  private readonly editor = new LineEditor();
  /** Holds a half-received escape sequence until the rest of it arrives. */
  private readonly keys = new KeyDecoder();
  private entries: Entry[] = [];
  private tabs: TabInfo[] = [];
  /** Where each tab sits on the first row, from the last draw. */
  private tabHits: TabHit[] = [];
  /** Tab currently hovered by mouse pointer */
  private hoverTab: { id: string; close: boolean } | null = null;
  /** The rows of the panel on screen a click can land on, from the last frame. */
  private panelRows: PanelRow[] = [];
  /** Screen row of prompt line from last draw */
  private promptRow: number | null = null;
  /** The prompt box's rows from the last draw, for clicks that place the caret. */
  private promptBox: PromptBox | null = null;
  /** The last frame's rows with every escape sequence taken out, for copying. */
  private frameText: string[] = [];
  /** Which rows a drag may select, in the rows the mouse reports. */
  private selectable = { top: 0, bottom: 0 };
  /** The text dragged over since the button went down, if it went down on one. */
  private selection: Selection | null = null;
  /** True while a `/goal` run is executing, so the mode row can say "Goal". */
  private goalRun = false;
  /** True between a press that could select and the release that ends it. */
  private dragging = false;
  /** Scrollbar geometry from last draw for mouse scrolling */
  private scrollbarInfo: { topRow: number; bottomRow: number; col: number; maxScroll: number } | null = null;
  /** True while mouse button is held down over scrollbar */
  private scrollingScrollbar = false;
  /**
   * Sessions whose tab was closed in this run.
   *
   * Closing a tab hides it, it does not delete anything: the transcript is a
   * file the user can get back with `/sessions`, and a stray click must never
   * throw away work.
   */
  private closedSessions = new Set<string>();
  /** Sessions permanently deleted in this run — must never be resurrected or re-saved. */
  private deletedSessions = new Set<string>();

  private agent!: Agent;
  private sessionId: string;
  private createdAt: string;
  /** Set by `/rename`, and sent back on every save so it is never re-derived. */
  private title: string | null = null;
  /** Model, directory and variant are session state: `/models`, `/cd`, `/variants`. */
  private model: string;
  /** Where the agent is pointed. `/models` can move it to another endpoint. */
  private baseUrl: string;
  /** Models used this session, newest first, for the `Recent` group. */
  private recentModels: ModelChoice[] = [];
  /** Models kept to hand, read from the store and written back on a toggle. */
  private favorites: ModelRef[] = [];
  /** Images pasted for the next turn, sent with it and then forgotten. */
  private attached: PastedImage[] = [];
  /** Documents attached with `/attach`, read into the next turn as context. */
  private attachedDocs: AttachedDoc[] = [];
  /**
   * A turn that failed and is waiting on the user: retry it, move to another
   * model, or let it go. The message and its attachments are kept so `r` can
   * run the exact request again.
   */
  private recovery: { title: string; body: string; prompt: string; images: PastedImage[] } | null = null;
  /** The failed turn `m` set aside, re-run the moment a picked model lands. */
  private pendingRetry: { prompt: string; images: PastedImage[] } | null = null;
  private cwd: string;
  private variant = DEFAULT_VARIANT;
  /** Shift+Tab switches it; the agent is rebuilt because the mode is read then. */
  private mode: SessionMode = "build";
  private config: string | null;
  /** Entry pinned to the top of the view by `/timeline`, until the next scroll. */
  private anchor: number | null = null;
  /** Diffs that were approved, for `/diff`. */
  private changes: { label: string; preview: string }[] = [];
  /**
   * The list being chosen from, and what to do with the choice.
   *
   * `all` is kept beside the filtered `items` because filtering has to be able
   * to widen again when a character is deleted — and because the cursor has to
   * index the same list the renderer draws.
   */
  private picker: {
    title: string;
    all: readonly PickItem[];
    items: PickItem[];
    query: string;
    selected: number;
    searchable?: boolean;
    placeholder?: string;
    hints?: readonly (readonly [string, string])[];
    onSubmitQuery?: (query: string) => void | Promise<void>;
    /**
     * More keys the list answers to, named on the panel's last row. The model
     * list uses them to get from one endpoint to another — the thing you want
     * when the model you are looking for is not in the list — and to keep a
     * model to hand.
     */
    extras?: PickerExtra[];
    /**
     * Filters drawn as tabs across the top, when the list has any.
     *
     * `rows` rebuilds the whole list for a tab, so the filter lives with the
     * data it filters rather than in the renderer.
     */
    tabs?: { labels: readonly string[]; active: number; rows: (active: number) => readonly PickItem[] };
    pick: (value: string) => void | Promise<void>;
    /**
     * Told which row is under the cursor as it moves, for a list whose choice
     * can be *shown* before it is made — `/themes` repaints in each one.
     */
    preview?: (value: string) => void;
    /**
     * Told how the list ended: chosen, or left without choosing. The one list
     * that has something to put back uses it.
     */
    onClose?: (committed: boolean) => void;
  } | null = null;

  private busy: string | null = null;
  /** True between Ctrl+C and the turn actually ending, so the key cannot double-cancel. */
  private stopping = false;
  private spinnerFrame = 0;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private scroll = 0;
  private notice: Span | null = null;
  private modal: Modal | null = null;
  /** The key a click on a card named, to be answered as if it had been typed. */
  private clickedKey: Key | null = null;
  /** What the screen shows. Changed by `/settings`, kept by the caller. */
  private view: ViewSettings;
  /**
   * The settings panel, when it is open.
   *
   * The rows are rebuilt from `view` on every key, so the value on screen is
   * always the value in effect — there is no second copy to drift.
   */
  private settingsMenu: { selected: number; query: string } | null = null;
  /** The integration list, when it is open. */
  private connectMenu: { all: readonly MenuRow[]; rows: MenuRow[]; selected: number; query: string } | null = null;
  /** Active clipboard & attachment options menu in the chat input area. */
  private clipboardMenu: ClipboardMenuState | null = null;
  /** True while clipboard context menu preview is being loaded. */
  private clipboardMenuOpening = false;
  /** Timestamp of last right-click to ignore terminal's automatic paste. */
  private lastRightClickTime = 0;
  /** Whether model execution or session is currently paused. */
  private isPaused = false;
  /** Queued prompts to execute in sequence when active turn finishes. */
  private queuedPrompts: Array<{ prompt: string; images: PastedImage[] }> = [];
  /** Notice shown when text is copied. */
  private copiedNotice: string | null = null;
  private copiedTimer: NodeJS.Timeout | null = null;
  private paletteSelected = 0;
  /** The prompt text when the palette was dismissed, so typing reopens it. */
  private paletteDismissedFor: string | null = null;
  /**
   * The `@` completion list, when the prompt holds a token with matches.
   *
   * `tokenStart` is where `@query` begins in the prompt, so accepting a row
   * can replace exactly that span. The index is cached per directory and
   * refreshed when it goes stale, so typing filters memory rather than disk.
   */
  private mention: { items: MentionItem[]; selected: number; tokenStart: number; query: string } | null = null;
  private mentionIndex: MentionIndex | null = null;
  private mentionIndexAt = 0;
  private mentionIndexPromise: Promise<MentionIndex> | null = null;
  private mentionIndexPromiseCwd: string | null = null;
  /** The query Escape dismissed, so it stays shut until the text changes. */
  private mentionDismissed: string | null = null;

  private askState: { questions: AskQuestion[]; answers: (string | null)[]; index: number; selected: number } | null = null;
  private askTyping = false;
  private askResolver: ((answers: AskAnswer[]) => void) | null = null;
  private pending: { request: ApprovalRequest; resolve: (decision: ApprovalDecision) => void } | null = null;

  private redrawPending: NodeJS.Timeout | null = null;
  private holdTimer: NodeJS.Timeout | null = null;
  private closed = false;
  /** Resolves the input loop; set once the listeners are attached. */
  private finish: (() => void) | null = null;
  private cleanup: () => void = () => {};

  constructor(
    options: TuiOptions,
    input: NodeJS.ReadStream,
    output: NodeJS.WriteStream,
    styles: Styles,
    theme: Theme,
  ) {
    this.options = options;
    this.input = input;
    this.output = output;
    this.styles = styles;
    this.theme = theme;
    this.themeName = isThemeName(options.themeName ?? "") ? (options.themeName as string) : DEFAULT_THEME;
    this.view = options.view ?? defaultViewSettings();
    this.sessionId = options.initial.id;
    this.createdAt = options.initial.createdAt;
    this.entries = entriesFromHistory(options.initial.messages ?? []);
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.cwd = options.cwd;
    this.config = options.config ?? null;
  }

  async start(): Promise<number> {
    setColorEnabled(!process.env.NO_COLOR && this.output.isTTY === true);

    this.agent = this.options.createAgent(this.options.initial.messages ?? [], this.settings());
    // Warm the `@` index in the background so the first `@` is fast: the
    // walk is what made Tab arrive before the list existed in tests and on
    // large directories. Failures are ignored — the first keystroke rebuilds.
    void this.ensureMentionIndex().catch(() => undefined);
    await this.refreshTabs();

    this.enterTerminal();

    try {
      this.draw();
      const finished = new Promise<void>((resolve) => {
        this.finish = resolve;
        // Keys are handled in the order they were typed, one chunk at a time.
        // Handling two at once lets the second be read against a state the
        // first has not finished building — an Enter pressed while a command is
        // still loading its list is looked at before there is a list to pick
        // from, and is dropped. From the outside that is a key that does
        // nothing, which is what "Enter does not work" looks like.
        let typed: Promise<void> = Promise.resolve();
        const onData = (chunk: Buffer | string): void => {
          const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
          typed = typed.then(() => this.onInput(text)).catch(() => undefined);
        };
        const onResize = (): void => {
          this.draw();
        };
        // Piped input ends the stream, which ends the session.
        const onEnd = (): void => resolve();

        this.input.on("data", onData);
        this.output.on("resize", onResize);
        this.input.on("end", onEnd);
        this.cleanup = () => {
          this.input.off("data", onData);
          this.output.off("resize", onResize);
          this.input.off("end", onEnd);
        };
      });

      await finished;
    } finally {
      await this.shutdown();
    }

    return 0;
  }

  private enterTerminal(): void {
    this.input.setRawMode?.(true);
    this.input.resume();
    // Mouse reporting goes on with the alternate screen: without it there is no
    // way to click a tab, and clicking tabs is the point of the close box.
    this.output.write(
      ENTER_ALT_SCREEN + DISABLE_WRAP + ENABLE_MOUSE + ENABLE_PASTE + CLEAR_SCREEN + CURSOR_HOME + HIDE_CURSOR,
    );
  }

  private async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
    if (this.redrawPending) clearTimeout(this.redrawPending);
    if (this.holdTimer) clearTimeout(this.holdTimer);
    // A pending approval would otherwise leave the agent waiting forever.
    this.pending?.resolve("deny");
    this.pending = null;
    // Nor should the agent wait forever on a question nobody will answer.
    if (this.askResolver) this.settleAsk();
    // And a turn in flight is stopped, so an abandoned request cannot keep the
    // process alive or repaint a terminal that has already been handed back.
    this.agent?.cancel();

    this.cleanup();
    this.input.setRawMode?.(false);
    this.input.pause();
    this.output.write(DISABLE_PASTE + DISABLE_MOUSE + ENABLE_WRAP + SHOW_CURSOR + LEAVE_ALT_SCREEN);
    setColorEnabled(true);

    try {
      await this.save();
    } catch {
      // Nothing useful to do at exit; the plain CLI reports save failures.
    }

    // Whatever the route store was holding is written now: the debounce is a
    // batching device, not a reason to lose the last few observations.
    try {
      await this.options.routeHealth?.flush();
    } catch {
      // Same: it is a convenience, and a full disk must not block the exit.
    }
  }

  // ---- input -----------------------------------------------------------------

  private async onInput(chunk: string): Promise<void> {
    // Keys typed after the app closed — a queued chunk behind a slow command —
    // must not reach a torn-down terminal.
    if (this.closed) return;

    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }

    await this.handleKeys(this.keys.push(chunk));

    if (this.keys.held.startsWith("\u001b")) {
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        void this.handleKeys(this.keys.flush());
      }, ESCAPE_GRACE_MS);
    }
  }

  private async handleKeys(keys: readonly Key[]): Promise<void> {
    for (const typed of keys) {
      let key = typed;
      // The clipboard, above every panel, so it works wherever the cursor is —
      // the prompt, a picker's search field, a settings row. Two keys because
      // one is not enough: Windows Terminal and iTerm both bind Ctrl+V to their
      // *own* paste, so KiCode never sees it and could never attach a copied
      // screenshot — and a terminal's paste can only ever carry text. Alt+V is
      // nobody's shortcut, so the image path is always reachable.
      if ((key.type === "ctrl" || key.type === "alt") && key.key === "v") {
        await this.pasteFromClipboard();
        this.draw();
        continue;
      }
      // Suppress terminal auto-paste arriving right after right-click or while clipboard menu is up
      if (key.type === "paste") {
        if (this.clipboardMenu || this.clipboardMenuOpening || Date.now() - this.lastRightClickTime < 600) {
          continue;
        }
      }
      if (key.type === "text" && this.clipboardMenuOpening) {
        continue;
      }
      // A selection is a thing you did to the screen, and it stops being true
      // the moment anything else happens: the text under it moves, or a turn
      // starts writing into it. So a key — any key — lets it go.
      if (key.type !== "mouse" && !(key.type === "ctrl" && key.key === "c") && (this.selection || this.dragging)) {
        this.selection = null;
        this.dragging = false;
      }
      // A click is handled here too, and for a related reason: every panel ends
      // in "anything else is mine", which is right for keys and wrong for this
      // one — a click is not a key a panel owns, it is a press on a row, and
      // routing it through the panels would mean teaching each of them to pass
      // it on. Deciding it here means a click works on any panel, including one
      // written later that never heard of the mouse.
      if (key.type === "mouse") {
        // Redraw only when the mouse action produced a visual change
        // (hover row changed, clicked, scrolled, selection changed).
        if (this.click(key)) this.draw();
        // A click on a chip is the key that chip names — a `[×]` is escape, a
        // card's `[m]` is `m` — and it is answered by the handlers below, which
        // are the ones a keypress reaches. Falling through rather than handling
        // it here is what keeps one implementation of "what does this key do".
        const chosen = this.clickedKey;
        this.clickedKey = null;
        if (!chosen) continue;
        key = chosen;
      }
      if (this.recovery) {
        const answer = await this.answerRecovery(key);
        if (answer === "quit") return;
        if (answer === "handled") continue;
        // Anything this modal does not own falls through to the normal keys —
        // Ctrl+C has to keep meaning what it means everywhere else.
      }
      if (this.modal && this.pending) {
        if (this.answerModal(key) === "quit") return;
        continue;
      }
      if (this.settingsMenu && (await this.handleSettingsKey(key))) {
        this.draw();
        continue;
      }
      if (this.connectMenu && (await this.handleConnectKey(key))) {
        this.draw();
        continue;
      }
      if (this.clipboardMenu && (await this.handleClipboardMenuKey(key))) {
        this.draw();
        continue;
      }
      if (this.picker && (await this.handlePickerKey(key))) {
        this.draw();
        continue;
      }
      if (this.askState && (await this.handleAskKey(key))) {
        this.draw();
        continue;
      }
      // The `@` list claims navigation and acceptance while it is up;
      // everything else falls through and re-filters it from the new text.
      if (this.mention && (await this.handleMentionKey(key))) {
        this.draw();
        continue;
      }
      // The palette only claims the keys it needs; everything else (typing,
      // Tab for sessions, Ctrl+C) falls through to the normal handling.
      if (this.paletteOpen() && (await this.handlePaletteKey(key))) {
        this.draw();
        continue;
      }

      switch (key.type) {
        case "ctrl":
          if (key.key === "a") {
            this.editor.selectAll();
            break;
          }
          if (key.key === "x") {
            if (this.editor.hasSelection()) {
              const text = this.editor.selectedText();
              if (text.trim()) {
                this.writeSelection(text);
                this.editor.deleteSelection();
                break;
              }
            }
          }
          if (key.key === "c") {
            // First check if editor has selection
            if (this.editor.hasSelection()) {
              const text = this.editor.selectedText();
              if (text.trim()) {
                this.writeSelection(text);
                this.editor.clearSelection();
                break;
              }
            }
            // Then check transcript selection
            if (this.selection) {
              const text = this.selectedText();
              if (text.trim()) {
                this.copySelection();
                this.selection = null;
                this.draw();
                continue;
              }
            }
            if (this.busy !== null && !this.stopping) this.cancelTurn();
            else return this.quit();
          }
          if (key.key === "l") {
            this.output.write(CLEAR_SCREEN + CURSOR_HOME);
            this.draw();
          }
          if (key.key === "d" && this.editor.text.length === 0) return this.quit();
          if (key.key === "u") this.editor.killToStart();
          // Ctrl+W closes the tab, which is what it does in a browser.
          if (key.key === "w") await this.closeSession(this.sessionId);
          break;
        case "enter":
          await this.submit();
          break;
        case "paste": {
          const trimmed = key.text.trim().replace(/^["']|["']$/g, "");
          if (/\.(png|jpe?g|webp|gif)$/i.test(trimmed)) {
            const attached = await this.tryAttachImagePath(trimmed);
            if (attached) {
              this.notice = null;
              break;
            }
          }
          this.editor.insert(key.text);
          this.notice = null;
          break;
        }

        case "escape":
          this.notice = null;
          break;
        case "up":
          if (this.editor.text.length === 0) this.scrollBy(1);
          else this.editor.historyPrev();
          break;
        case "tab":
          await this.cycleSession();
          break;
        // Shift+Tab switches between building and planning. It is handled here
        // rather than by the panels above, so a modal or a waiter keeps every
        // key it owns.
        case "backtab":
          this.toggleMode();
          break;
        case "down":
          if (this.editor.text.length === 0) this.scrollBy(-1);
          else this.editor.historyNext();
          break;
        case "pageup":
          this.scrollBy(10);
          break;
        case "pagedown":
          this.scrollBy(-10);
          break;
        case "left":
          this.editor.left();
          break;
        case "right":
          this.editor.right();
          break;
        case "home":
          this.editor.home();
          break;
        case "end":
          this.editor.end();
          break;
        case "backspace":
          // Backspace on an empty prompt detaches: images first, then the
          // documents — newest attachment goes first, whichever kind it is.
          if (this.editor.text.length === 0 || this.editor.cursor === 0) {
            if (this.attached.length > 0) {
              this.attached.pop();
              this.notice = null;
              break;
            }
            if (this.attachedDocs.length > 0) {
              const removed = this.attachedDocs.pop();
              this.notice = removed ? span(`detached ${removed.name}`, this.styles.dim) : null;
              break;
            }
          }
          this.editor.backspace();
          break;
        case "delete":
          this.editor.deleteForward();
          break;
        case "text":
          this.editor.insert(key.text);
          this.notice = null;
          break;
        default:
          break;
      }

      this.syncPalette();
      await this.syncMentions();
      this.draw();
    }
  }

  private answerModal(key: Key): "handled" | "quit" {
    if (!this.pending) return "handled";

    if (key.type === "ctrl" && key.key === "c") {
      // The prompt is refused and the turn behind it is stopped — someone
      // pressing Ctrl+C half-way through a diff is not asking about this one
      // tool, they are asking for the whole turn to end.
      this.resolveModal("deny");
      this.cancelTurn();
      return "handled";
    }
    if (key.type === "escape") {
      // Escape is a refusal: closing a permission prompt must never mean yes.
      this.resolveModal("deny");
      this.draw();
      return "handled";
    }

    const pressed = key.type === "text" ? key.text.toLowerCase() : key.type === "ctrl" ? key.key : "";
    if (pressed === "y" || pressed === "enter") this.resolveModal("allow");
    else if (pressed === "a") this.resolveModal("always");
    else if (pressed === "n") this.resolveModal("deny");
    else return "handled";

    this.draw();
    return "handled";
  }

  /**
   * The keys a failed turn answers to.
   *
   * `r` runs the exact request again — same words, same attachments, same
   * model — because a rate limit is usually about *when*, not *what*. `m`
   * opens the model picker and remembers the turn, so the model the user
   * picks is the one the retry lands on. Esc keeps the error in the
   * transcript and lets the user move on; Ctrl+C is deliberately not owned by
   * this modal, so quit means quit.
   */
  private async answerRecovery(key: Key): Promise<"handled" | "quit" | "unhandled"> {
    if (!this.recovery) return "handled";

    if (key.type === "ctrl" && key.key === "c") return "unhandled";

    const pressed = key.type === "text" ? key.text.toLowerCase() : key.type === "ctrl" ? key.key : "";

    if (key.type === "escape" || pressed === "n") {
      this.dismissRecovery();
      this.draw();
      this.releaseHeldQueue();
      return "handled";
    }

    if (pressed === "r" || key.type === "enter") {
      const failed = this.recovery;
      this.dismissRecovery();
      this.note("retrying the failed message", "dim");
      void this.runTurn(failed.prompt, failed.images);
      return "handled";
    }

    if (pressed === "m") {
      const failed = this.recovery;
      this.dismissRecovery();
      // The turn waits for a model: `setModel` consumes this the moment a
      // choice lands, whether it moved or the user re-confirmed the current
      // one — both are an answer to "what now?".
      this.pendingRetry = { prompt: failed.prompt, images: failed.images };
      await this.chooseModel();
      if (this.picker) {
        // Picking is the retry; closing the picker without one cancels it.
        this.picker.onClose = (committed) => {
          if (!committed) this.pendingRetry = null;
        };
      } else {
        // The picker never opened (no list available, nothing to choose):
        // hand the decision back instead of silently dropping the turn.
        this.pendingRetry = null;
        this.recovery = failed;
        this.modal = this.recoveryModal(failed);
      }
      this.draw();
      return "handled";
    }

    // Every other key is held by the modal: typing into the prompt behind a
    // question the user has not answered would look like the answer worked.
    return "handled";
  }

  private dismissRecovery(): void {
    this.recovery = null;
    this.modal = null;
    this.pendingRetry = null;
  }

  /** The queue held behind the recovery modal moves once the question is gone. */
  private releaseHeldQueue(): void {
    if (this.busy || this.queuedPrompts.length === 0) return;
    const next = this.queuedPrompts.shift();
    if (next) void this.runTurn(next.prompt, next.images);
  }

  /**
   * The recovery card, as the renderer wants it.
   *
   * The error is shown in full — wrapped, then cut with a `… N more lines`
   * marker by the modal itself — because a gateway's message is usually the
   * whole diagnosis (which model, which quota, how long to wait).
   */
  private recoveryModal(failed: { title: string; body: string }): Modal {
    return {
      title: failed.title,
      // One span per line, with the newline in front of every line but the
      // first: a row's spans are glued together, so a gateway message that was
      // written as four lines would otherwise be printed as one run-on row.
      body: failed.body.split("\n").map((line, index) => span(`${index === 0 ? "" : "\n"}${line}`, this.styles.dim)),
      choices: [
        { key: "r", label: "retry" },
        { key: "m", label: "choose model" },
        { key: "esc", label: "dismiss" },
      ],
    };
  }

  private resolveModal(decision: ApprovalDecision): void {
    const pending = this.pending;
    this.pending = null;
    this.modal = null;

    // Keep the diff that was approved: `/diff` shows what actually changed, and
    // this is the only moment it is known for certain to have been applied.
    if (pending && decision !== "deny" && pending.request.preview) {
      const args = summarizeArgs(pending.request.args, pending.request.name);
      this.changes.push({ label: `${pending.request.name}${args ? ` ${args}` : ""}`, preview: pending.request.preview });
    }

    pending?.resolve(decision);
  }

  private scrollBy(lines: number): void {
    // Scrolling releases a `/timeline` jump: the view is the user's again.
    this.anchor = null;
    this.scroll = Math.max(0, this.scroll + lines);
  }

  /** Shift+Tab switches the session between building and planning. */
  private toggleMode(): void {
    this.enterMode(nextMode(this.mode));
  }

  /**
   * Changes the mode, and says so on the status row.
   *
   * The mode is not only a label: the agent is rebuilt with it, and plan mode
   * refuses the tools that change anything. A new agent is how a setting read
   * at construction changes — the same path a model change takes — so a turn
   * already in flight finishes under the mode it started on.
   *
   * The announcement is a notice rather than a transcript line: it describes
   * the row it is drawn on, and a transcript that gathers one line per keypress
   * buries the conversation it is meant to accompany.
   */
  private enterMode(mode: SessionMode): void {
    this.mode = mode;
    this.rebuild(this.agent.turns);
    this.notice = span(
      mode === "plan"
        ? "plan mode · file changes and commands are refused · shift+tab for build"
        : "build mode · changes and commands need approval again",
      mode === "plan" ? this.styles.warn : this.styles.dim,
    );
  }

  /** `/mode`: the picker, or the mode named outright. */
  private chooseMode(argument: string): void {
    if (argument) {
      const wanted = argument.trim().toLowerCase();
      if (wanted !== "build" && wanted !== "plan") {
        this.note(`usage: /mode [build|plan]`);
        return;
      }
      if (wanted === this.mode) {
        this.note(`already in ${wanted} mode`);
        return;
      }
      this.enterMode(wanted);
      return;
    }

    this.openPicker(
      "Mode",
      MODES.map((mode) => ({
        label: MODE_LABELS[mode],
        description:
          mode === "plan"
            ? "read-only: file changes are refused, but read-only commands still run"
            : "changes and commands need approval",
        value: mode,
        current: mode === this.mode,
      })),
      (value) => this.enterMode(value === "plan" ? "plan" : "build"),
    );
  }

  // ---- questions ---------------------------------------------------------------

  /** The channel the `ask` tool reaches the user through. */
  private asker(): AskFn {
    return (request) =>
      new Promise<AskAnswer[]>((resolve) => {
        this.askResolver = resolve;
        this.askState = {
          questions: request.questions,
          answers: request.questions.map(() => null),
          index: 0,
          selected: 0,
        };
        this.askTyping = false;
        this.editor.clear();
        this.draw();
      });
  }

  /** The model's options, plus the UI's own free-text row. */
  private askOptions(question: AskQuestion | undefined): AskOption[] {
    if (!question) return [];
    return [...question.options, { label: FREE_TEXT, description: "Write your own answer instead of choosing." }];
  }

  private async handleAskKey(key: Key): Promise<boolean> {
    const state = this.askState;
    if (!state) return false;

    if (this.askTyping) {
      // Typing is ordinary typing; only the two ways out are special.
      if (key.type === "escape") {
        this.askTyping = false;
        this.editor.clear();
        return true;
      }
      return false;
    }

    const question = state.questions[state.index];
    const options = this.askOptions(question);
    const last = Math.max(options.length - 1, 0);

    switch (key.type) {
      case "up":
        state.selected = state.selected <= 0 ? last : state.selected - 1;
        return true;
      case "down":
        state.selected = state.selected >= last ? 0 : state.selected + 1;
        return true;
      case "tab": {
        // Move to the next question, wrapping — never submits by accident.
        const next = (state.index + 1) % state.questions.length;
        state.index = next;
        state.selected = this.answerIndex(next);
        return true;
      }
      case "escape":
        this.settleAsk();
        return true;
      case "enter":
        this.confirmOption(state.selected);
        return true;
      case "text": {
        // Digits are a shortcut for choosing an option outright.
        const digit = /^([1-9])$/.exec(key.text.trim());
        if (!digit) return true; // swallow stray letters rather than typing them
        const index = Number(digit[1]) - 1;
        if (index > last) return true;
        state.selected = index;
        this.confirmOption(index);
        return true;
      }
      default:
        // Ctrl+C and Ctrl+L still work; nothing else is meaningful here.
        return false;
    }
  }

  /**
   * Where the cursor should land when a question comes back on screen.
   *
   * Returning to an already-answered question and seeing the cursor at the top
   * would read as if the answer had been forgotten.
   */
  private answerIndex(index: number): number {
    const state = this.askState;
    if (!state) return 0;

    const answer = state.answers[index];
    if (answer === null || answer === undefined) return 0;

    const options = this.askOptions(state.questions[index]);
    const found = options.findIndex((option) => option.label === answer);
    // A typed answer has no row of its own; the free-text row is the one it came from.
    return found >= 0 ? found : Math.max(options.length - 1, 0);
  }

  private confirmOption(index: number): void {
    const state = this.askState;
    if (!state) return;

    const option = this.askOptions(state.questions[state.index])[index];
    if (!option) return;

    if (option.label === FREE_TEXT) {
      this.askTyping = true;
      this.editor.clear();
      return;
    }

    state.answers[state.index] = option.label;
    this.advanceAsk();
  }

  /** Moves to the next unanswered question, and submits once there is none. */
  private advanceAsk(): void {
    const state = this.askState;
    if (!state) return;

    const next = state.answers.findIndex((answer) => answer === null);
    if (next === -1) {
      this.settleAsk();
      return;
    }
    state.index = next;
    state.selected = 0;
  }

  /** Resolves the pending question with whatever has been answered so far. */
  private settleAsk(): void {
    const state = this.askState;
    const resolve = this.askResolver;
    this.askState = null;
    this.askTyping = false;
    this.askResolver = null;
    this.editor.clear();

    // Unanswered questions are reported as dismissed. Saying nothing would let
    // the model read silence as agreement with whatever it proposed.
    resolve?.(
      (state?.questions ?? []).map((question, index) => {
        const answer = state?.answers[index] ?? null;
        return { header: question.header, answer: answer ?? "", dismissed: answer === null };
      }),
    );
  }

  // ---- the command palette ----------------------------------------------------

  /**
   * Open whenever the prompt starts with a slash and the argument has not been
   * started — the same thing OpenCode's `ctrl+p` shows, without a separate mode:
   * there is one place a command can be, and the list reflects it.
   */
  private paletteOpen(): boolean {
    if (this.modal || this.askState || this.picker || this.settingsMenu || this.connectMenu) return false;
    if (this.paletteDismissedFor !== null && this.editor.text === this.paletteDismissedFor) return false;
    return commandQuery(this.editor.text) !== null;
  }

  private paletteItems(): Command[] {
    return filterCommands(commandQuery(this.editor.text) ?? "");
  }

  private async handlePaletteKey(key: Key): Promise<boolean> {
    const items = this.paletteItems();
    if (items.length === 0) {
      if (key.type === "escape") {
        this.editor.clear();
        this.paletteDismissedFor = null;
        return true;
      }
      return false;
    }

    const last = items.length - 1;
    switch (key.type) {
      case "up":
        // Steps over the names that cannot run here, so the keys never land on
        // one that would do nothing.
        this.paletteSelected = stepSelectable(items, this.paletteSelected, -1);
        return true;
      case "down":
        this.paletteSelected = stepSelectable(items, this.paletteSelected, 1);
        return true;
      case "escape":
        this.paletteDismissedFor = this.editor.text;
        // A bare slash was only there to open the list.
        if (this.editor.text === "/") this.editor.clear();
        return true;
      case "enter": {
        const chosen = items[Math.min(Math.max(this.paletteSelected, 0), last)];
        if (!chosen) return false;
        this.editor.setText(`/${chosen.name}`);
        await this.submit();
        return true;
      }
      default:
        return false;
    }
  }

  /** Keeps the highlight on the same command as the list is filtered down. */
  private syncPalette(): void {
    const items = this.paletteItems();
    this.paletteSelected = Math.min(this.paletteSelected, Math.max(items.length - 1, 0));
  }

  /**
   * Rebuilds the file index when the directory changed or it went stale.
   *
   * A turn can create the very file the next `@` names, so an index that is
   * never refreshed would miss exactly the files the session just made.
   */
  private async ensureMentionIndex(): Promise<MentionIndex> {
    const stale = Date.now() - this.mentionIndexAt > 60_000;
    if (this.mentionIndex && this.mentionIndex.cwd === this.cwd && !stale) return this.mentionIndex;
    // Deduplicate concurrent builds: every keystroke calls syncMentions, and
    // without this each one would start its own walk over the directory.
    if (!this.mentionIndexPromise || this.mentionIndexPromiseCwd !== this.cwd) {
      this.mentionIndexPromiseCwd = this.cwd;
      this.mentionIndexPromise = buildMentionIndex(this.cwd).then((index) => {
        this.mentionIndex = index;
        this.mentionIndexAt = Date.now();
        return index;
      });
      // A failed walk must not poison later keystrokes with a stuck promise.
      void this.mentionIndexPromise.catch(() => {
        if (this.mentionIndexPromiseCwd === this.cwd) this.mentionIndexPromise = null;
      });
    }
    return this.mentionIndexPromise;
  }

  /**
   * Re-filters the `@` list from the prompt text after every key.
   *
   * Runs on keystrokes, not on a timer, so the list is always about the text
   * on screen: typing narrows it, deleting widens it, and moving past the
   * token closes it. A query dismissed with Escape stays shut until it changes.
   */
  private async syncMentions(): Promise<void> {
    if (this.coveredBy() || this.modal || this.paletteOpen()) {
      this.mention = null;
      return;
    }
    const token = activeToken(this.editor.text, this.editor.cursor);
    if (!token || (this.mentionDismissed !== null && token.query === this.mentionDismissed)) {
      this.mention = null;
      return;
    }
    // Typing on is a new intention even after a dismissal.
    if (token.query !== this.mentionDismissed) this.mentionDismissed = null;
    const index = await this.ensureMentionIndex();
    const items = completeMention(index, token.query);
    if (items.length === 0) {
      this.mention = null;
      return;
    }
    const selected = this.mention ? Math.min(this.mention.selected, items.length - 1) : 0;
    this.mention = { items, selected, tokenStart: token.start, query: token.query };
  }

  /**
   * Navigation and acceptance for the `@` list. Anything else — typing,
   * deleting, moving the caret — belongs to the prompt and re-filters after.
   */
  private async handleMentionKey(key: Key): Promise<boolean> {
    const mention = this.mention;
    if (!mention) return false;

    switch (key.type) {
      case "up":
        mention.selected = (mention.selected - 1 + mention.items.length) % mention.items.length;
        return true;
      case "tab":
        // Tab accepts rather than switching sessions while the list is up:
        // the keystroke the list is open for wins over the one behind it.
        this.acceptMention();
        return true;
      case "down":
        mention.selected = (mention.selected + 1) % mention.items.length;
        return true;
      case "enter":
        this.acceptMention();
        return true;
      case "escape":
        this.mentionDismissed = mention.query;
        this.mention = null;
        return true;
      default:
        return false;
    }
  }

  /** Writes the chosen row back into the prompt as `@label `. */
  private acceptMention(): void {
    const mention = this.mention;
    const item = mention?.items[mention.selected];
    this.mention = null;
    this.mentionDismissed = null;
    if (!mention || !item) return;
    const before = this.editor.text.slice(0, mention.tokenStart);
    const after = this.editor.text.slice(this.editor.cursor);
    this.editor.setText(`${before}@${item.label} ${after}`, before.length + item.label.length + 2);
  }

  // ---- the turn ---------------------------------------------------------------

  private async submit(): Promise<void> {
    // A typed answer ends the question rather than being sent to the model.
    if (this.askState && this.askTyping) {
      const answer = this.editor.text.trim();
      if (!answer) return;
      this.askState.answers[this.askState.index] = answer;
      this.askTyping = false;
      this.editor.clear();
      this.advanceAsk();
      this.draw();
      return;
    }

    const prompt = this.editor.text.trim();
    if (!prompt) return;

    const lower = prompt.toLowerCase();
    // Check pause intent: if user types "pause" or "/pause"
    if (lower === "pause" || lower === "/pause") {
      this.editor.acceptHistory(prompt);
      this.editor.clear();
      if (this.busy !== null) {
        this.cancelTurn();
        this.isPaused = true;
        this.entries.push({
          kind: "note",
          text: "paused — model execution paused at your request. Send a message or /resume to continue.",
          tone: "warn",
        });
        this.notice = span("execution paused", this.styles.warn);
        this.draw();
        return;
      }
      this.isPaused = true;
      this.notice = span("session paused — send a message or /resume to continue", this.styles.warn);
      this.draw();
      return;
    }

    if (this.isPaused && (lower === "resume" || lower === "/resume" || lower === "unpause" || lower === "/unpause")) {
      this.isPaused = false;
      this.editor.acceptHistory(prompt);
      this.editor.clear();
      this.notice = span("session resumed", this.styles.accent);
      if (this.queuedPrompts.length > 0) {
        const next = this.queuedPrompts.shift();
        if (next) void this.runTurn(next.prompt, next.images);
      }
      this.draw();
      return;
    }

    // If a turn is actively running, queue subsequent submitted messages to run in sequence
    if (this.busy !== null) {
      this.editor.acceptHistory(prompt);
      this.editor.clear();
      this.paletteDismissedFor = null;
      this.paletteSelected = 0;

      const isInsert = lower.startsWith("/insert ") || lower.startsWith("insert: ");
      let cleanPrompt = prompt;
      if (lower.startsWith("/queue ") || lower.startsWith("/insert ") || lower.startsWith("queue: ") || lower.startsWith("insert: ")) {
        cleanPrompt = prompt.replace(/^(\/queue|\/insert|queue:|insert:)\s*/i, "").trim();
      }

      const images = this.attached;
      this.attached = [];
      const queuedDocs = this.attachedDocs;
      this.attachedDocs = [];
      let expanded = cleanPrompt;
      if (cleanPrompt.includes("@")) {
        try {
          expanded = (await expandMentions(cleanPrompt, await this.ensureMentionIndex())).text;
        } catch {}
      }
      if (queuedDocs.length > 0) expanded = [expanded, ...queuedDocs.map(docBlock)].join("\n\n");

      if (isInsert) {
        this.queuedPrompts.unshift({ prompt: expanded, images });
        this.entries.push({
          kind: "note",
          text: `[inserted next in conversation] ${cleanPrompt}`,
          tone: "accent",
        });
        this.notice = span(`inserted next into queue (${this.queuedPrompts.length} queued)`, this.styles.accent);
      } else {
        this.queuedPrompts.push({ prompt: expanded, images });
        this.entries.push({
          kind: "note",
          text: `[queued in conversation] ${cleanPrompt}`,
          tone: "accent",
        });
        this.notice = span(`pushed into conversation queue (${this.queuedPrompts.length} queued)`, this.styles.accent);
      }
      this.draw();
      return;
    }

    this.isPaused = false;
    this.editor.acceptHistory(prompt);
    this.editor.clear();
    this.paletteDismissedFor = null;
    this.paletteSelected = 0;

    // A command is awaited, though: its work is what the next key acts on. An
    // Enter pressed to pick from a list must be read after the list exists.
    if (prompt.startsWith("/")) {
      await this.command(prompt);
      return;
    }

    const images = this.attached;
    this.attached = [];
    // Documents attached with `/attach` travel as context blocks beside the
    // words — the same shape an `@file` mention produces, so every model can
    // read them. They are consumed here: one attachment, one message.
    const docs = this.attachedDocs;
    this.attachedDocs = [];
    // `@` mentions expand into their context here: the transcript keeps the
    // words that were typed, while the model receives those words plus the
    // files, skills and memories they named.
    let expanded = prompt;
    if (prompt.includes("@")) {
      try {
        expanded = (await expandMentions(prompt, await this.ensureMentionIndex())).text;
      } catch {
        // A directory that vanished mid-turn must not eat the prompt.
      }
    }
    if (docs.length > 0) expanded = [expanded, ...docs.map(docBlock)].join("\n\n");
    this.entries.push({
      kind: "user",
      text: prompt,
      ...(images.length > 0 ? { images: images.length } : {}),
      ...(docs.length > 0 ? { docs: docs.map((doc) => doc.name) } : {}),
    });
    this.scroll = 0;
    // Not awaited: a turn is answered *through* this loop — an approval, a
    // question — so holding the loop for its duration would be a deadlock, and
    // it would stop every later key from being read in order. `busy` is set
    // before this returns, so a second prompt is still refused.
    void this.runTurn(expanded, images);
  }

  /**
   * The clipboard, from `Ctrl+V` or `Alt+V`.
   *
   * Text is handed on as the `paste` key the terminal's own paste arrives as,
   * rather than being written to the prompt here: that way a picker's search
   * field, a settings row and the prompt are all filled by the one piece of code
   * that already knows how each of them takes text, and there is no second
   * implementation of "where does a paste go" to drift from the first.
   *
   * An image cannot travel that way — a paste carries text and nothing else —
   * so it is read out of the system clipboard and attached to the next turn,
   * and not sent on its own, because "look at this" is never the whole request.
   * Neither answer is silence: an empty clipboard says it is empty.
   */
  private async pasteFromClipboard(): Promise<void> {
    if (!this.options.readClipboard) {
      this.note("this run cannot read the clipboard", "warn");
      this.draw();
      return;
    }

    let read: ClipboardRead;
    try {
      read = await this.options.readClipboard();
    } catch (error) {
      this.note(`could not read the clipboard: ${(error as Error).message}`, "error");
      this.draw();
      return;
    }

    if (read.kind === "empty") {
      this.note("the clipboard is empty — copy text or a screenshot first, then ctrl+v (or alt+v)", "warn");
      this.draw();
      return;
    }

    if (read.kind === "text") {
      await this.handleKeys([{ type: "paste", text: read.text }]);
      this.notice = null;
      if (read.truncated) {
        this.note(`pasted the first ${read.text.length} characters of a longer clipboard`, "warn");
      }
      this.draw();
      return;
    }

    const image = read.image;
    this.attached = [...this.attached, image];
    const line = `attached image ${this.attached.length} · ${Math.max(Math.round(image.bytes / 1024), 1)} KB · sent with the next prompt`;
    // Set notice without polluting the chat conversation transcript
    this.notice = span(line, this.styles.dim);
    this.draw();
  }

  /**
   * Attaching a file from the attach button — the click-driven replacement
   * for the old `/attach` command.
   *
   * The platform's file-selection window is opened by the injected `pickFile`
   * option; when it is not available the user is asked to type or paste a
   * path into the prompt instead. Either way the chosen file lands in the
   * same machinery `/attach` fed: an image joins `attached` (the paste path),
   * everything else is read now and held as a document. Reading at attach
   * time rather than send time is the point: a bad path is a message on
   * screen while the user can still pick again, not an error buried in the
   * middle of a running turn.
   */
  private async attachFromPicker(): Promise<void> {
    if (this.options.pickFile) {
      const picked = await this.options.pickFile().catch(() => null);
      if (!picked) {
        // A closed dialog means "never mind" — not an error to announce.
        this.draw();
        return;
      }
      await this.attachFile(picked.path);
      return;
    }
    // No file-picker on this platform: ask for a path in the terminal, the
    // same way an API key is asked for.
    this.promptInput("Attach a file", "/path/to/file — or paste one", async (value) => {
      const filePath = value.trim();
      if (!filePath) {
        this.note("no file given");
        this.draw();
        return;
      }
      await this.attachFile(filePath);
    });
  }

  /**
   * Attaches one file by path — the attach button's landing place.
   *
   * An image joins `attached` (the paste path), everything else is read now and
   * held as a document. Reading at attach time rather than send time is the
   * point: a bad path is a message on screen while the user can still retype
   * it, not an error buried in the middle of a running turn.
   */
  private async attachFile(argument: string): Promise<void> {
    const filePath = argument.trim().replace(/^["']|["']$/g, "");
    if (!filePath) {
      this.note("no file given — use the [+] button beside the prompt");
      this.draw();
      return;
    }

    try {
      const file = await readAttachedFile(filePath, this.cwd);
      if (file.kind === "image") {
        this.attached = [...this.attached, file.image];
        this.notice = span(
          `attached image ${this.attached.length} · ${Math.max(Math.round(file.image.bytes / 1024), 1)} KB · sent with the next prompt`,
          this.styles.dim,
        );
      } else {
        this.attachedDocs = [...this.attachedDocs, file.doc];
        const size = `${Math.max(Math.round(file.doc.body.length / 1024), 1)} KB${file.doc.truncated ? " (truncated)" : ""}`;
        this.notice = span(`attached ${file.doc.name} (${size}) · sent with the next prompt`, this.styles.dim);
      }
    } catch (error) {
      this.note(`could not attach: ${(error as Error).message}`, "error");
    }
    this.draw();
  }

  /**
   * Attempts to attach an image from a local file path.
   */
  private async tryAttachImagePath(filePath: string): Promise<boolean> {
    try {
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(this.cwd, filePath);
      const fileStat = await stat(resolved);
      if (!fileStat.isFile() || fileStat.size > 10 * 1024 * 1024) return false;
      const buffer = await readFile(resolved);
      const ext = path.extname(resolved).toLowerCase().replace(".", "");
      const mime =
        ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "png"
            ? "image/png"
            : ext === "webp"
              ? "image/webp"
              : "image/gif";
      const pasted: PastedImage = {
        bytes: fileStat.size,
        data: buffer.toString("base64"),
        mime,
      };
      this.attached = [...this.attached, pasted];
      this.draw();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * True while a panel is drawn *in place of* the conversation.
   *
   * These are the screens whose first row is the tab bar, so anything written
   * into the transcript is invisible until they close. The palette is not one of
   * them: it floats above the prompt rather than replacing it.
   */
  private coveredBy(): boolean {
    return (
      this.picker !== null || this.settingsMenu !== null || this.connectMenu !== null || this.askState !== null
    );
  }

  /**
   * Stops the turn in flight.
   *
   * A prompt on screen is that turn waiting for an answer, so it is wound up
   * here too rather than left waiting for keys that are never going to come.
   * This is the first half of `Ctrl+C`; the second press — with nothing running
   * any more — quits.
   */
  private cancelTurn(): void {
    this.stopping = true;
    if (this.pending) this.resolveModal("deny");
    if (this.askState) this.settleAsk();
    this.agent.cancel();
    this.setBusy("stopping…");
    this.draw();
  }

  private async runTurn(prompt: string, images: readonly PastedImage[] = []): Promise<void> {
    this.setBusy("thinking…");

    // Stamped once, here, because this is the only place that knows when the
    // user's request started — and the per-answer line is about the wait they
    // sat through, not about one request inside the turn.
    const startedAt = Date.now();
    const turn = {
      startedAt,
      mode: this.goalRun ? "Goal" : MODE_LABELS[this.mode],
      model: this.model,
      tps: this.view.tps === "on",
    };

    try {
      for await (const event of this.agent.send(prompt, images)) {
        applyEvent(this.entries, event, { at: Date.now(), turn });
        if (event.type === "tool-start") this.setBusy(`${event.name}…`);
        else if (event.type === "route-wait") this.setBusy(`rate-limited on ${event.from} — waiting ${Math.ceil(event.ms / 1000)}s…`);
        else if (event.type === "tool-result" || event.type === "text") this.setBusy("thinking…");
        this.scheduleDraw();
      }
    } catch (error) {
      // A cancelled turn is a decision, not a failure: it says so plainly
      // instead of surfacing the AbortError underneath it.
      const failure = error as Error;
      const cancelled = failure.name === "AbortError";
      this.note(
        cancelled ? "stopped — that turn was cancelled" : failure.message,
        cancelled ? "warn" : "error",
        !cancelled,
      );
      // A dead turn is worth a decision, not just a red line: the transcript
      // keeps the error, and the modal offers the three things that can
      // actually happen next — run it again, move to another model, or let it
      // go. Goal runs stay autonomous: a modal nobody is watching would stall
      // the run, so they only get the note.
      if (!cancelled && !this.goalRun) {
        const limited = /rate.limit|429/i.test(failure.message);
        this.recovery = {
          title: limited ? "Rate limited — what now?" : "The turn failed — what now?",
          body: failure.message,
          prompt,
          images: [...images],
        };
        this.modal = this.recoveryModal(this.recovery);
      }
    } finally {
      this.stopBusy();
      this.goalRun = false;
      await this.save().catch(() => undefined);
      this.draw();
      // A failed turn holding the recovery modal also holds the queue: a turn
      // running behind the question would be a second thing deciding what the
      // screen is doing. The queue moves when the question is answered.
      if (!this.isPaused && !this.recovery && this.queuedPrompts.length > 0) {
        const next = this.queuedPrompts.shift();
        if (next) {
          void this.runTurn(next.prompt, next.images);
        }
      }
    }
  }

  private setBusy(label: string): void {
    this.busy = label;
    if (this.spinnerTimer || this.view.animations === "off") return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame += 1;
      this.scheduleDraw();
    }, 90);
  }

  private stopBusy(): void {
    this.busy = null;
    // Whatever was being stopped has now stopped.
    this.stopping = false;
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  // ---- slash commands ---------------------------------------------------------

  /**
   * Runs a slash command.
   *
   * The name is resolved through the catalogue, so an alias and the command it
   * stands for can never drift apart, and a name KiCode does not have answers
   * for itself instead of failing silently.
   */
  private async command(line: string): Promise<void> {
    const [word = "", ...rest] = line.slice(1).trim().split(/\s+/);
    const argument = rest.join(" ").trim();

    if (word === "queue") {
      if (argument === "clear") {
        const count = this.queuedPrompts.length;
        this.queuedPrompts = [];
        this.note(`cleared ${count} queued message(s)`);
      } else if (argument) {
        this.queuedPrompts.push({ prompt: argument, images: [] });
        this.entries.push({ kind: "note", text: `[queued in conversation] ${argument}`, tone: "accent" });
        this.notice = span(`pushed into conversation queue (${this.queuedPrompts.length} queued)`, this.styles.accent);
      } else if (this.queuedPrompts.length === 0) {
        this.note("no messages queued in conversation (use /queue <message> to push)");
      } else {
        this.notes([
          `Queued messages (${this.queuedPrompts.length}):`,
          ...this.queuedPrompts.map((q, idx) => `  ${idx + 1}. ${q.prompt.slice(0, 60)}`),
        ]);
      }
      this.draw();
      return;
    }

    if (word === "insert") {
      if (!argument) {
        this.note("usage: /insert <message to push in between>");
      } else {
        this.queuedPrompts.unshift({ prompt: argument, images: [] });
        this.entries.push({ kind: "note", text: `[inserted next in conversation] ${argument}`, tone: "accent" });
        this.notice = span(`inserted next into queue (${this.queuedPrompts.length} queued)`, this.styles.accent);
      }
      this.draw();
      return;
    }

    const typed = COMMANDS.find((entry) => entry.name === word);

    if (!typed) {
      this.note(`unknown command: /${word} — try /help`, "warn");
      // Put it back so a typo is editable rather than lost.
      this.editor.setText(line);
      this.draw();
      return;
    }

    if (!isAvailable(typed)) {
      this.note(`/${typed.name} is not available in KiCode: ${typed.unavailable}`, "warn");
      this.draw();
      return;
    }

    switch (typed.alias ?? typed.name) {
      case "exit":
        return this.quit();
      case "help":
        this.notes(this.helpLines());
        break;
      case "clear":
        this.entries = [];
        this.anchor = null;
        break;
      case "new":
        await this.newSession();
        break;
      case "rename":
        await this.rename(argument);
        break;
      case "fork":
        await this.forkSession();
        break;
      case "undo":
        this.undo();
        break;
      case "pause":
        if (this.busy !== null) {
          this.cancelTurn();
          this.isPaused = true;
          this.entries.push({
            kind: "note",
            text: "paused — model execution paused at your request. Type /resume or send a message to continue.",
            tone: "warn",
          });
          this.notice = span("execution paused", this.styles.warn);
          this.draw();
        } else {
          this.isPaused = true;
          this.note("session paused — send a message or /resume to continue", "warn");
        }
        break;
      case "resume":
        this.isPaused = false;
        this.note("session resumed");
        if (this.queuedPrompts.length > 0) {
          const next = this.queuedPrompts.shift();
          if (next) void this.runTurn(next.prompt, next.images);
        }
        break;
      case "sessions":
        await this.openSessions();
        break;
      case "delete-session":
      case "session-delete":
        if (argument) {
          await this.deleteSession(argument);
          break;
        }
        await this.chooseSessionToDelete();
        break;
      case "continue":
        await this.resumeLatest();
        break;
      case "export":
        await this.exportTranscript();
        break;
      case "copy":
        await this.copyTranscript();
        break;
      case "status":
        this.notes(this.statusLines());
        break;
      case "stats":
        this.notes(this.statsLines());
        break;
      case "debug":
        this.notes(this.debugLines());
        break;
      case "settings":
        await this.showSettings(argument);
        break;
      case "key":
      case "api-key":
        await this.enterApiKey(this.baseUrl);
        break;
      case "add-provider":
      case "add-model":
        this.addCustomProvider();
        break;
      case "connect":
        await this.connect(argument);
        break;
      case "reload":
        await this.reloadConfig();
        break;
      case "mcps":
        this.notes([this.options.mcp ? `connected: ${this.options.mcp}` : "no MCP servers configured for this project"]);
        break;
      case "diff":
        this.showDiff();
        break;
      case "timeline":
        this.timeline(argument);
        break;
      case "models":
        if (argument && argument !== "free") {
          await this.setModel(argument);
          break;
        }
        await this.chooseModel(undefined, argument === "free" ? "free" : "all");
        break;
      case "model":
        if (argument) {
          await this.setModel(argument);
          break;
        }
        await this.chooseModel(undefined, "all");
        break;
      case "detach":
      case "clear-images":
        if (this.attached.length > 0) {
          const count = this.attached.length;
          this.attached = [];
          this.notice = span(`removed ${count} attached image${count === 1 ? "" : "s"}`, this.styles.dim);
        } else {
          this.notice = span("no images attached", this.styles.faint);
        }
        this.draw();
        break;
      case "budget":
        this.budget(argument);
        break;
      case "goal":
      case "goal-direct": {
        if (!argument) {
          this.note("usage: /goal <objective description> (runs autonomous goal loop with subtask checklist)");
          break;
        }
        const goalPrompt = [
          `Execute this goal autonomously using the goal tool:`,
          `Objective: ${argument}`,
          ``,
          `First, call goal with action 'init', title: "${argument}", and break the work into ordered subtasks (id: t1, t2, ...).`,
          `Before executing each task, call goal with action 'task_start', taskId: "<id>".`,
          `When each task finishes, call goal with action 'task_done', taskId: "<id>".`,
          `When verifying, call goal with action 'verify', verify: "<check done>".`,
          `When all tasks pass verification, call goal with action 'complete'.`,
          `Begin now.`,
        ].join("\n");
        this.entries.push({ kind: "user", text: `/goal ${argument}` });
        this.scroll = 0;
        this.goalRun = true;
        void this.runTurn(goalPrompt);
        break;
      }
      case "variants":
        this.chooseVariant(argument);
        break;
      case "skills":
        await this.skills(argument);
        break;
      case "mode":
        this.chooseMode(argument);
        break;
      case "paste":
        await this.pasteFromClipboard();
        break;
      case "themes":
        await this.chooseTheme(argument);
        break;
      case "compact":
        await this.compact();
        break;
      case "btw":
        await this.sideQuestion(argument);
        break;
      case "routes":
        await this.routes();
        break;
      case "review":
        await this.review(argument);
        break;
      case "editor":
        await this.openEditor(argument);
        break;
      case "cd":
        await this.changeDirectory(argument);
        break;
      case "init":
        await this.initialise();
        break;
      case "update":
        this.notes([
          "KiCode runs from the checkout you built it from — it is not published to npm.",
          "Update it there (`npm run build`, then `npm link` if you linked it), and start it again.",
        ]);
        break;
      default:
        this.note(`/${word} has no implementation yet`, "warn");
    }

    this.draw();
  }

  /**
   * One line of transcript, in the tone that suits it.
   *
   * With `foldPastRetry`, the fold looks past the user's own message: a gateway
   * that rate-limits every retry would otherwise stack identical error blocks
   * down the transcript, each separated by the one-line prompt that caused it.
   * The repeat count rides on the entry, so the row renders once and admits
   * how many times it happened.
   */
  private note(text: string, tone: Tone = "dim", foldPastRetry = false): void {
    const target = foldPastRetry
      ? [...this.entries].reverse().find((entry) => entry.kind !== "user")
      : this.entries.at(-1);
    if (target && target.kind === "note" && target.text === text && target.tone === tone) {
      target.count = (target.count ?? 1) + 1;
      return;
    }
    this.entries.push({ kind: "note", text, tone });
  }

  private notes(lines: readonly string[], tone: Tone = "dim"): void {
    for (const line of lines) this.note(line, tone);
  }

  private helpLines(): string[] {
    const available = COMMANDS.filter((command) => isAvailable(command) && !command.alias).map(
      (command) => `/${command.name}`,
    );
    return [
      "type / for the palette — ↑↓ choose, enter runs, esc closes",
      "tab switches session · ctrl+w closes a tab · ctrl+p palette · ctrl+v paste text or attach a clipboard image · ctrl+u clear the line · ctrl+c stops a turn, again to quit",
      "click a tab to switch, its × to close, +NEW for a fresh one · the wheel scrolls",
      available.join("  "),
    ];
  }

  private statusLines(): string[] {
    const messages = this.agent.turns.length;
    return [
      `model ${this.model} · ${this.mode} mode · variant ${this.variant} · ${this.options.compacting ? "compaction on" : "compaction off"}`,
      `cwd ${this.cwd}`,
      `session ${this.sessionId}${this.title ? ` (${this.title})` : ""} · ${messages} messages`,
      `endpoint ${this.baseUrl}`,
      budgetLine(this.agent.spentTokens, this.agent.tokenBudget),
      `mcp ${this.options.mcp ?? "none"} · config ${this.config ?? "none"}`,
    ];
  }

  /**
   * `/budget` — where the session stands against its token ceiling.
   *
   * Read-only with no argument, so the common question ("how much have I
   * burned?") is answered without changing anything. With a number it sets the
   * ceiling, because the honest answer to a limit you are about to cross is to
   * raise it on purpose rather than to discover it as an error.
   */
  private budget(argument: string): void {
    if (!argument) {
      this.notes([
        budgetLine(this.agent.spentTokens, this.agent.tokenBudget),
        this.agent.tokenBudget > 0
          ? "set it with /budget <tokens>, or 0 to remove it"
          : "set one with /budget <tokens>, or KICODE_MAX_TOKENS",
      ]);
      return;
    }

    const tokens = Number(argument);
    if (!Number.isFinite(tokens) || tokens < 0) {
      this.note("usage: /budget [tokens] — a number, or 0 for no limit", "warn");
      this.draw();
      return;
    }

    this.agent.setBudget(Math.trunc(tokens));
    this.note(tokens === 0 ? "token budget removed" : `token budget set to ${formatTokens(tokens)}`);
    this.draw();
  }

  /**
   * `/routes` — what this machine has learned about each endpoint.
   *
   * The honest version of "will this route answer?": what happened last time,
   * which survives a restart because it is a file. A route that has never been
   * used says so rather than being shown as healthy.
   */
  private async routes(): Promise<void> {
    if (!this.options.routeHealth) {
      this.note("route health is not being recorded in this run", "warn");
      this.draw();
      return;
    }

    const list = await this.options.routeHealth.list();
    const here = list.find((line) => line.ref.baseUrl === this.baseUrl && line.ref.model === this.model);

    if (list.length === 0) {
      this.notes([
        "nothing recorded yet — the file fills in as requests are made",
        `asked for ${this.model} on ${this.endpointName()}`,
      ]);
      this.draw();
      return;
    }

    this.notes([
      `route health — ${list.length} route${list.length === 1 ? "" : "s"} remembered on this machine`,
      ...(here ? [routeLine(here, true)] : [`${this.model} on ${this.endpointName()} — nothing recorded yet`]),
      ...list.filter((line) => line !== here).map((line) => routeLine(line, false)),
    ]);
    this.draw();
  }

  private statsLines(): string[] {
    const tokens = this.agent.contextTokens;
    const budget = this.options.contextTokens;
    const minutes = Math.max(Math.round((Date.now() - Date.parse(this.createdAt)) / 60_000), 0);

    return [
      `${this.agent.turns.length} messages · ${this.toolCalls()} tool calls · ${this.entries.length} transcript entries`,
      `~${formatTokens(tokens)} tokens${budget > 0 ? ` (${Math.round((tokens / budget) * 100)}% of ${formatTokens(budget)})` : ""}`,
      budgetLine(this.agent.spentTokens, this.agent.tokenBudget),
      `session started ${this.createdAt}${Number.isNaN(minutes) ? "" : ` (${minutes} min ago)`}`,
    ];
  }

  private debugLines(): string[] {
    return [
      `kicode ${this.options.version} · node ${process.version} · ${process.platform}`,
      `cwd ${this.cwd} · model ${this.model} · mode ${this.mode} · variant ${this.variant}`,
      `endpoint ${this.baseUrl}`,
      `config ${this.config ?? "none"} · mcp ${this.options.mcp ?? "none"}`,
      `session ${this.sessionId} · ${this.agent.turns.length} messages · ~${this.agent.contextTokens} tokens`,
      `sessions are JSON files under ~/.kicode/sessions (KICODE_HOME moves them)`,
    ];
  }

  // ---- settings and integrations ----------------------------------------------

  /**
   * `/settings` — the panel, or one value set outright.
   *
   * With an argument it sets that one setting and writes it, which is what a
   * script or a muscle-memory user wants: `/settings thinking hide` is a single
   * fact, and opening a panel to change one row is slower than saying it.
   */
  private async showSettings(argument: string): Promise<void> {
    if (argument) {
      const [id = "", value = ""] = argument.split(/\s+/);
      const def = settingDefs(this.view).find((entry) => entry.id === id);
      if (!def) {
        this.note(`usage: /settings [${settingDefs(this.view).map((entry) => entry.id).join("|")}] [value]`, "warn");
        this.draw();
        return;
      }
      if (!value) {
        this.note(`${def.id} is ${String(this.view[def.id])} — ${def.description}`, "dim");
        this.draw();
        return;
      }
      if (!def.options.includes(value)) {
        this.note(`usage: /settings ${def.id} [${def.options.join("|")}]`, "warn");
        this.draw();
        return;
      }
      await this.applyView({ ...this.view, [def.id]: value } as ViewSettings);
      this.draw();
      return;
    }

    this.settingsMenu = { selected: 0, query: "" };
    this.editor.clear();
    this.draw();
  }

  /** The settings rows, filtered by the panel's search field. */
  private visibleSettings(): SettingDef[] {
    const menu = this.settingsMenu;
    if (!menu) return [];
    return filterSettings(settingDefs(this.view), this.view, menu.query);
  }

  /**
   * Adopts a set of view settings, repaints, and writes what changed.
   *
   * The write is the point of the panel: a setting that is forgotten when the
   * session ends is a keybinding, not a preference. Whatever the caller could
   * not write is said out loud rather than shown as if it had been kept.
   */
  private async applyView(next: ViewSettings): Promise<void> {
    const patch: Partial<ViewSettings> = {};
    for (const key of Object.keys(next) as (keyof ViewSettings)[]) {
      if (next[key] !== this.view[key]) (patch as Record<string, unknown>)[key] = next[key];
    }
    if (Object.keys(patch).length === 0) return;

    this.view = next;
    this.adoptTheme(next.theme);

    if (!this.options.saveView) {
      this.notice = span(
        `${describePatch(patch)} — not saved (this run cannot write settings)`,
        this.styles.warn,
      );
      return;
    }

    const result = await this.options.saveView(patch).catch((error: unknown) => ({
      ok: false,
      file: "",
      reason: (error as Error).message,
    }));
    this.notice = result.ok
      ? span(`${describePatch(patch)} — saved to ${result.file}`, this.styles.dim)
      : span(`${describePatch(patch)} — not saved: ${result.reason ?? "write failed"}`, this.styles.warn);
  }

  /** Uses a theme without adopting it as this run's name — the patch does that. */
  private adoptTheme(name: string): void {
    if (!isThemeName(name) || name === this.themeName) return;
    this.themeName = name;
    this.theme = themeByName(name);
    this.styles = buildStyles(this.theme);
  }

  private async handleSettingsKey(key: Key): Promise<boolean> {
    const menu = this.settingsMenu;
    if (!menu) return false;

    const rows = this.visibleSettings();
    const last = Math.max(rows.length - 1, 0);
    const clampCursor = (): void => {
      menu.selected = Math.min(Math.max(menu.selected, 0), last);
    };

    switch (key.type) {
      case "up":
        menu.selected = menu.selected <= 0 ? last : menu.selected - 1;
        return true;
      case "down":
        menu.selected = menu.selected >= last ? 0 : menu.selected + 1;
        return true;
      // The arrows along the row change its value: a row that has a value is a
      // row you can move through them, and it is the one gesture the footer names.
      case "left":
      case "right": {
        const def = rows[menu.selected];
        if (def) await this.applyView(stepSetting(this.view, def.id, key.type === "right" ? 1 : -1));
        return true;
      }
      case "enter": {
        // Enter steps forward too, so a row can be changed without the arrows —
        // and it never closes the panel, because one change is rarely the only one.
        const def = rows[menu.selected];
        if (def) await this.applyView(stepSetting(this.view, def.id, 1));
        return true;
      }
      case "escape":
        this.settingsMenu = null;
        this.editor.clear();
        return true;
      case "backspace":
        if (menu.query.length > 0) {
          menu.query = menu.query.slice(0, -1);
          clampCursor();
        }
        return true;
      case "text":
      case "paste": {
        menu.query += key.text.split("\n")[0] ?? "";
        clampCursor();
        return true;
      }
      case "ctrl":
        // Ctrl+C and Ctrl+L still belong to the app: a panel must never be
        // able to trap somebody in a screen they cannot leave.
        return false;
      default:
        // Anything else is the panel's, so nothing lands in the prompt hidden
        // behind it.
        return true;
    }
  }

  /**
   * `/connect` — add an endpoint KiCode can reach.
   *
   * Adding one writes its base URL and the name of the environment variable its
   * key lives in into the global `kicode.json`, and then moves the session onto
   * it when the key is actually there. A service whose variable is unset is
   * still declared: the endpoint is worth recording, and saying which variable
   * is missing is more useful than refusing.
   */
  private async connect(argument: string): Promise<void> {
    if (!this.options.connect) {
      this.note("this run cannot add providers", "warn");
      this.draw();
      return;
    }

    if (argument) {
      await this.addService(argument);
      this.draw();
      return;
    }

    const all = await this.options.connect.list().catch((): MenuRow[] => []);
    const customRows: MenuRow[] = [
      {
        label: "+ Add Custom Provider / Endpoint",
        value: "__add_custom__",
        group: "Custom",
        trailing: "URL & Key",
      },
      {
        label: "+ Manually enter API Key",
        value: "__enter_key__",
        group: "Custom",
        trailing: "for endpoint",
      },
    ];
    const combined = [...all, ...customRows];
    if (combined.length === 0) {
      this.note("no services to offer in this build", "warn");
      this.draw();
      return;
    }

    this.connectMenu = { all: combined, rows: [...combined], selected: 0, query: "" };
    this.editor.clear();
    this.draw();
  }

  private async handleConnectKey(key: Key): Promise<boolean> {
    const menu = this.connectMenu;
    if (!menu) return false;

    const last = Math.max(menu.rows.length - 1, 0);
    const refilter = (): void => {
      menu.rows = filterMenuRows(menu.all, menu.query);
      menu.selected = stepMenuRow(menu.rows, Math.min(menu.selected, Math.max(menu.rows.length - 1, 0)), 0);
    };

    switch (key.type) {
      case "up":
        menu.selected = stepMenuRow(menu.rows, menu.selected, -1);
        return true;
      case "down":
        menu.selected = stepMenuRow(menu.rows, menu.selected, 1);
        return true;
      case "escape":
        this.connectMenu = null;
        this.editor.clear();
        return true;
      case "enter": {
        const row = menu.rows[Math.min(Math.max(menu.selected, 0), last)];
        if (!row || row.disabled) return true;
        this.connectMenu = null;
        if (row.value === "__add_custom__") {
          this.addCustomProvider();
          return true;
        }
        if (row.value === "__enter_key__") {
          await this.enterApiKey(this.baseUrl);
          return true;
        }
        await this.addService(row.value);
        return true;
      }
      case "backspace":
        if (menu.query.length > 0) {
          menu.query = menu.query.slice(0, -1);
          refilter();
        }
        return true;
      case "text":
      case "paste": {
        menu.query += key.text.split("\n")[0] ?? "";
        refilter();
        return true;
      }
      case "ctrl":
        return false;
      default:
        return true;
    }
  }

  /** Declares one service, and switches to it when it can be reached. */
  private async addService(name: string): Promise<void> {
    const connect = this.options.connect;
    if (!connect) return;

    const result = await connect.add(name);
    if (!result.ok) {
      this.note(`could not add ${name}: ${result.reason}`, "warn");
      return;
    }

    this.note(`added ${result.provider} to ${result.file} — ${result.baseUrl}`);
    if (!result.ready) {
      this.note(
        result.apiKeyEnv
          ? `no key yet: set ${result.apiKeyEnv} or enter API key manually`
          : `no credential was needed; /models will list ${result.baseUrl}`,
        "warn",
      );
      if (result.apiKeyEnv) {
        await this.enterApiKey(result.baseUrl, result.provider);
      }
      return;
    }

    // Declared *and* switched to, which is what "connect" means. The endpoint's
    // models are then offered, because the model in use may not exist there.
    this.baseUrl = result.baseUrl;
    this.rebuild(this.agent.turns);
    await this.chooseModel(result.baseUrl);
  }

  /** `/themes` and the settings panel both land here, so one note names the key. */
  private async keepTheme(name: string): Promise<void> {
    if (!this.options.saveView) return;
    const result = await this.options.saveView({ theme: name }).catch(() => null);
    if (result?.ok) this.notice = span(`theme ${name} — saved to ${result.file}`, this.styles.dim);
  }

  private toolCalls(): number {
    return this.entries.filter((entry) => entry.kind === "tool").length;
  }

  // ---- sessions ---------------------------------------------------------------

  private async cycleSession(): Promise<void> {
    if (this.tabs.length < 2) {
      this.note("no other sessions for this directory");
      this.draw();
      return;
    }

    const current = this.tabs.findIndex((tab) => tab.current);
    const next = this.tabs[(current + 1) % this.tabs.length];
    if (!next) return;

    await this.switchSession(next.id);
    this.draw();
  }

  /** Moves to another session, saving the one being left behind first. */
  private async switchSession(id: string): Promise<void> {
    if (id === this.sessionId) return;

    const messages = await this.options.loadSession(id);
    if (messages === null) {
      this.note(`session ${id} could not be read`, "error");
      return;
    }

    await this.save().catch(() => undefined);
    // Explicitly switching to a session re-opens it
    this.closedSessions.delete(id);
    this.deletedSessions.delete(id);
    this.sessionId = id;
    this.createdAt = new Date().toISOString();
    this.title = null;
    this.entries = entriesFromHistory(messages);
    this.changes = [];
    this.anchor = null;
    this.rebuild(messages);
    this.scroll = 0;

    for (const t of this.tabs) t.current = false;
    const existing = this.tabs.find((t) => t.id === id);
    if (existing) {
      existing.current = true;
    } else {
      const summaries = await this.options.listSessions(this.cwd).catch(() => []);
      const found = summaries.find((s) => s.id === id);
      const title = found?.title ?? "session";
      this.tabs = [
        { id, title, current: true },
        ...this.tabs.filter((t) => !this.closedSessions.has(t.id) && !this.deletedSessions.has(t.id)),
      ];
      if (this.tabs.length > MAX_TABS) {
        this.tabs = this.tabs.slice(0, MAX_TABS);
      }
    }
    this.notice = span(`switched session · ${messages.length} messages`, this.styles.dim);
  }

  private async newSession(): Promise<void> {
    await this.save().catch(() => undefined);
    this.sessionId = this.options.newSessionId();
    this.createdAt = new Date().toISOString();
    this.title = null;
    this.entries = [];
    this.changes = [];
    this.anchor = null;
    this.scroll = 0;
    this.rebuild([]);

    for (const t of this.tabs) t.current = false;
    this.tabs = [
      { id: this.sessionId, title: "new session", current: true },
      ...this.tabs.filter((t) => !this.closedSessions.has(t.id) && !this.deletedSessions.has(t.id)),
    ];
    if (this.tabs.length > MAX_TABS) {
      this.tabs = this.tabs.slice(0, MAX_TABS);
    }
    // A notice, not a note: a transcript entry would make the session
    // non-empty and hide the home screen a fresh session must open on.
    this.notice = span("new session", this.styles.dim);
  }

  private async rename(name: string): Promise<void> {
    if (!name) {
      this.note(this.title ? `this session is called \"${this.title}\"` : "usage: /rename <name>");
      return;
    }

    this.title = name;
    await this.save().catch(() => undefined);
    await this.refreshTabs();
    this.note(`renamed to \"${name}\"`);
  }

  private async forkSession(): Promise<void> {
    const history = this.agent.turns;
    if (history.length === 0) {
      this.note("nothing to fork yet");
      return;
    }

    await this.save().catch(() => undefined);
    this.title = `${this.title ?? "session"} (fork)`;
    this.sessionId = this.options.newSessionId();
    this.createdAt = new Date().toISOString();
    this.rebuild(history);
    await this.save().catch(() => undefined);
    await this.refreshTabs();
    this.note(`forked into a new session · ${history.length} messages`);
  }

  /**
   * Drops the last request, and everything it produced.
   *
   * The cut goes back to a `user` message on purpose: half a turn — a tool call
   * without its result — is not something the endpoint will accept next time.
   */
  private undo(): void {
    const turns = this.agent.turns;
    let cut = -1;
    for (let index = turns.length - 1; index >= 0; index--) {
      if (turns[index]?.role === "user") {
        cut = index;
        break;
      }
    }

    if (cut === -1) {
      this.note("nothing to undo");
      return;
    }

    const kept = turns.slice(0, cut);
    this.agent.rewind(kept);
    this.entries = entriesFromHistory(kept);
    this.anchor = null;
    this.scroll = 0;
    this.note(`undid the last request · ${kept.length} messages left`);
  }

  private async openSessions(): Promise<void> {
    let sessions: Awaited<ReturnType<TuiOptions["listSessions"]>>;
    try {
      sessions = await this.options.listSessions(this.cwd);
    } catch (error) {
      this.note(`could not read the session store: ${(error as Error).message}`, "error");
      return;
    }

    const others = sessions.filter((session) => session.id !== this.sessionId);
    if (others.length === 0) {
      this.note(`no other sessions in ${this.cwd} — the store is shared, but sessions are listed per directory`, "warn");
      return;
    }

    this.openPicker(
      "Sessions",
      others.map((session) => this.sessionRow(session)),
      (id) => this.switchSession(id),
    );
  }

  /**
   * One session as a picker row grouped by date (Today, Tue Sep 29 2026, etc.).
   * The preview, model, and raw timestamp ID are searchable keywords, keeping
   * the row display clean and clutter-free.
   */
  private sessionRow(session: SessionSummary): PickItem {
    const group = sessionGroup(session);
    const meta: string[] = [];
    const date = session.updatedAt ? formatSessionDate(session.updatedAt) : null;
    if (date) meta.push(date);
    if (typeof session.messageCount === "number")
      meta.push(`${session.messageCount} msg${session.messageCount === 1 ? "" : "s"}`);
    const isGeneratedId = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-/.test(session.id);
    const description = isGeneratedId ? undefined : session.id;
    const keywords = [session.id, session.preview ?? "", session.model ?? ""].join(" ").trim();
    return {
      label: session.title,
      group,
      ...(description ? { description } : {}),
      ...(meta.length > 0 ? { trailing: meta.join(" · ") } : {}),
      ...(keywords ? { keywords } : {}),
      value: session.id,
    };
  }

  private async resumeLatest(): Promise<void> {
    const sessions = await this.options.listSessions(this.cwd).catch(() => []);
    const other = sessions.find((session) => session.id !== this.sessionId);

    if (!other) {
      this.note("no other sessions for this directory");
      return;
    }

    await this.switchSession(other.id);
  }

  // ---- files ------------------------------------------------------------------

  private async exportTranscript(): Promise<void> {
    if (!this.options.exportTranscript) {
      this.note("this run cannot write files");
      return;
    }

    try {
      const file = await this.options.exportTranscript(this.agent.turns, this.cwd);
      this.note(`exported to ${file}`);
    } catch (error) {
      this.note(`could not export: ${(error as Error).message}`, "warn");
    }
  }

  private async copyTranscript(): Promise<void> {
    const text = entriesToText(this.entries);
    const copied = await this.options.copyToClipboard?.(text).catch(() => false);

    if (copied) {
      this.copiedNotice = `conversation (${text.length} chars)`;
      if (this.copiedTimer) clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => {
        this.copiedNotice = null;
        this.copiedTimer = null;
        this.draw();
      }, 2500);
      this.notice = span(`✓ copied conversation (${text.length} characters) to clipboard`, this.styles.ok);
    }
    this.note(copied ? `copied ${text.length} characters to the clipboard` : "no clipboard here — /export writes a file instead", copied ? "dim" : "warn");
  }

  private showDiff(): void {
    if (this.changes.length === 0) {
      this.note("no file changes were approved in this session");
      return;
    }

    for (const change of this.changes) this.note(`${change.label}\n${change.preview}`.trim());
  }

  private timeline(argument: string): void {
    const prompts = this.entries
      .map((entry, at) => ({ entry, at }))
      .filter((item): item is { entry: { kind: "user"; text: string }; at: number } => item.entry.kind === "user");

    if (prompts.length === 0) {
      this.note("no messages to jump to yet");
      return;
    }

    if (!argument) {
      this.openPicker(
        "Messages",
        prompts.map((item, order) => ({
          label: `${order + 1}. ${item.entry.text.split("\n")[0]?.slice(0, 60) ?? ""}`,
          value: String(item.at),
        })),
        (value) => this.jump(Number(value)),
      );
      return;
    }

    const index = Number(argument);
    if (!Number.isInteger(index) || index < 1 || index > prompts.length) {
      this.note(`usage: /timeline <1..${prompts.length}>`);
      return;
    }

    this.jump(prompts[index - 1]!.at);
  }

  /**
   * `/skills` — the named skills in `ki-agent-brain/skills`.
   *
   * With a name it shows that skill's card, so a skill can be read without
   * spending a turn on it. With no argument it opens the list, and choosing
   * one writes `@skill:name` back into the prompt: the mention expands into
   * context on submit, the same as if it had been typed by hand.
   */
  private async skills(argument: string): Promise<void> {
    let index: MentionIndex;
    try {
      index = await this.ensureMentionIndex();
    } catch {
      this.note("could not read the skills directory", "warn");
      return;
    }
    if (!index.brain) {
      this.note("no skills here — no ki-agent-brain was found above this directory", "warn");
      return;
    }
    if (argument) {
      const found = index.skills.find((skill) => skill.name === argument);
      if (!found) {
        this.note(`no skill named "${argument}" — /skills lists the ones there are`, "warn");
        return;
      }
      let body: string;
      try {
        const buffer = await readFile(found.file);
        if (buffer.includes(0)) body = "(binary file, not included)";
        else {
          const text = buffer.toString("utf8").trimEnd();
          body = text.length <= 12_000 ? text || "(empty file)" : `${text.slice(0, 12_000).trimEnd()}\n… (truncated)`;
        }
      } catch {
        this.note(`could not read ${found.file}`, "warn");
        return;
      }
      this.notes([`skill:${found.name} — ${found.description}`, body]);
      return;
    }
    if (index.skills.length === 0) {
      this.note("no skills in this brain yet — a SKILL.md under ki-agent-brain/skills/ is what shows up here", "warn");
      return;
    }
    this.openPicker(
      `Skills · ${index.skills.length}`,
      index.skills.map((skill) => ({ label: skill.name, description: skill.description, value: skill.name })),
      (name) => {
        this.editor.setText(`@skill:${name} `);
      },
    );
  }

  private jump(entry: number): void {
    this.anchor = entry;
    this.scroll = 0;
    // On the state row rather than in the transcript: the view has just been
    // pinned to an older message, so a line appended at the end of the
    // conversation would be below the window the command just moved.
    this.notice = span("jumped to message · scrolling returns to the end", this.styles.dim);
  }

  // ---- settings that change while it runs -------------------------------------

  /**
   * Every model every provider offers, in one list.
   *
   * A provider is a heading rather than a separate screen: choosing a model is
   * choosing an endpoint at the same time, which is what makes a second
   * provider usable at all — the alternative is switching one, forgetting, and
   * sending a model name the endpoint has never heard of.
   */
  private async chooseModel(only?: string, initialFilter: ModelFilter = "all"): Promise<void> {
    if (!this.options.listModels) {
      this.note("this run cannot list the endpoint's models", "warn");
      return;
    }

    const configured = (await this.options.listProviders?.().catch(() => [])) ?? [];
    const targets = (configured.length > 0 ? configured : [{ label: this.endpointName(), value: this.baseUrl }]).filter(
      (target) => !only || target.value === only,
    );

    // Asked for in parallel: one slow endpoint should not hold up the list, and
    // one that fails reports itself in its own group rather than sinking the
    // command. "The endpoint listed no models" and "401 from the gateway" look
    // identical on screen, and only one of them is fixable.
    const groups: ModelGroup[] = await Promise.all(
      targets.map(async (target) => {
        const group: ModelGroup = {
          label: target.label,
          baseUrl: target.value,
          models: [],
          ...(target.description ? { description: target.description } : {}),
        };
        try {
          group.models = await this.options.listModels!(target.value);
        } catch (error) {
          group.error = (error as Error).message;
        }
        return group;
      }),
    );

    // Favourites are read once per open, so the list is built from the store
    // rather than from whatever a previous panel happened to leave behind.
    this.favorites = this.options.favorites ? await this.options.favorites.list().catch(() => []) : [];

    // A row's value has to carry the provider as well, so the choice moves both.
    const choice = new Map<string, { baseUrl: string; model: string }>();

    /**
     * The rows as they stand right now.
     *
     * A function rather than a value because favouriting a model has to be able
     * to rebuild the list under the user — and doing it here means the rebuild
     * keeps the same group order and the same values as the first build.
     */
    const rows = (filter: ModelFilter): PickItem[] => {
      const items: PickItem[] = [];

      const modelMap = new Map<
        string,
        { id: string; free?: boolean; promptPrice?: number; completionPrice?: number; description?: string }
      >();
      for (const group of groups) {
        for (const m of group.models) {
          modelMap.set(`${group.baseUrl}#${m.id}`, m);
          if (!modelMap.has(m.id)) modelMap.set(m.id, m);
        }
      }

      // One predicate decides every row, shortcuts included, so a tab cannot
      // mean one thing in the list and another in Recent.
      const pass = (id: string, baseUrl?: string): boolean => {
        const info = (baseUrl ? modelMap.get(`${baseUrl}#${id}`) : undefined) ?? modelMap.get(id);
        const free = isFree(id, info);
        return filter === "all" || (filter === "free" ? free : !free);
      };
      // A row is only worth offering if the endpoint it names still serves it.
      const serves = (entry: ModelRef): boolean =>
        groups.some((group) => group.baseUrl === entry.baseUrl && group.models.some((model) => model.id === entry.model));
      const row = (entry: ModelRef, groupHeading: string | null): PickItem => {
        const value = `${entry.baseUrl}#${entry.model}`;
        choice.set(value, entry);
        const groupMatch = groups.find((g) => g.baseUrl === entry.baseUrl);
        const providerName = groupMatch?.label || this.endpointName(entry.baseUrl);
        const providerSuffix = providerName ? ` (${providerName})` : "";
        const mInfo = modelMap.get(value) ?? modelMap.get(entry.model);
        return {
          label: `${entry.model}${providerSuffix}`,
          value,
          current: entry.model === this.model && entry.baseUrl === this.baseUrl,
          ...(mInfo?.description ? { trailing: mInfo.description } : {}),
          ...(groupHeading ? { group: groupHeading } : {}),
        };
      };

      const wanted = (entry: ModelRef): boolean => pass(entry.model, entry.baseUrl);

      const recent = this.recentModels.filter((entry) => serves(entry) && wanted(entry));
      recent.forEach((entry, index) => items.push(row(entry, index === 0 ? "Recent" : null)));

      // Favourites sit under Recent so the two shortcuts read as one block at
      // the top. Only the ones this endpoint actually serves are offered: a
      // favourite from another endpoint would be a row that cannot be chosen.
      this.favorites
        .filter((entry) => serves(entry) && wanted(entry))
        .forEach((entry, index) => items.push(row(entry, index === 0 ? "Favorites" : null)));

      for (const group of groups) {
        // A provider that failed or serves nothing still gets a row: a provider
        // missing from the list is the thing hardest to notice, and this is the
        // only place the reason can be seen while the list is open.
        if (group.models.length === 0) {
          items.push({
            label: group.error ?? "no models",
            value: "",
            group: group.label,
            disabled: true,
          });
          continue;
        }

        const listed = group.models.filter((model) => pass(model.id, group.baseUrl));
        if (listed.length === 0) {
          items.push({ label: `no ${filter} models`, value: "", group: group.label, disabled: true });
          continue;
        }

        listed.forEach((model, index) => {
          const value = `${group.baseUrl}#${model.id}`;
          choice.set(value, { baseUrl: group.baseUrl, model: model.id });
          const providerSuffix = group.label ? ` (${group.label})` : "";
          items.push({
            label: `${model.id}${providerSuffix}`,
            value,
            current: model.id === this.model && group.baseUrl === this.baseUrl,
            ...(model.description ? { trailing: model.description } : {}),
            // Only the first row of a group carries its heading, so a provider is
            // named once rather than repeated down the list.
            ...(index === 0 ? { group: group.label } : {}),
          });
        });
      }

      return items;
    };

    const items = rows(initialFilter);

    // Nothing choosable at all: say why in one line rather than opening a panel
    // full of the same reason.
    if (!items.some((item) => !item.disabled)) {
      const reason = groups.find((group) => group.error)?.error;
      this.note(
        `no ${initialFilter === "all" ? "" : `${initialFilter} `}models from ${targets
          .map((target) => target.label)
          .join(", ")}${reason ? `: ${reason}` : ""}`,
        "warn",
      );
      return;
    }

    const extras: PickerExtra[] = [
      {
        hint: ["ctrl+k", "api key"],
        key: "k",
        run: async () => {
          await this.enterApiKey(this.baseUrl);
        },
      },
    ];
    if (configured.length > 1) {
      extras.push({ hint: ["ctrl+a", "change provider"], key: "a", run: () => this.chooseProvider(configured) });
    }
    if (this.options.favorites) {
      extras.push({
        hint: ["ctrl+f", "favorite"],
        key: "f",
        // Favouriting changes the list rather than leaving it, so the search
        // that found the model and the cursor's place are still there after.
        close: false,
        run: async (item) => {
          await this.toggleFavorite(item ? choice.get(item.value) : undefined);
          // The Favorites group appears, or loses the row, as it happens — the
          // list is rebuilt in place rather than waiting for the next open, and
          // it stays on the tab it was favourited from.
          this.replacePickerItems(rows(MODEL_FILTERS[this.picker?.tabs?.active ?? 0] ?? "all"));
          this.draw();
        },
      });
    }

    this.openPicker(
      "Select model",
      items,
      (value) => {
        if (value.startsWith("__enter_key__#")) {
          const parts = value.split("#");
          const targetUrl = parts[1] || this.baseUrl;
          const label = parts[2];
          return this.enterApiKey(targetUrl, label);
        }
        const picked = choice.get(value);
        return picked ? this.setModel(picked.model, picked.baseUrl) : undefined;
      },
      extras,
      {
        labels: MODEL_FILTER_LABELS,
        active: Math.max(MODEL_FILTERS.indexOf(initialFilter), 0),
        rows: (active) => rows(MODEL_FILTERS[active] ?? "all"),
      },
    );
  }

  /**
   * Adds or removes the highlighted model from the saved favourites.
   *
   * The in-memory list only moves once the store has accepted it: a save that
   * failed must not leave the screen showing a favourite that is not there on
   * the next run.
   */
  private async toggleFavorite(entry: ModelRef | undefined): Promise<void> {
    if (!entry) return;

    const exists = this.favorites.some((fav) => fav.baseUrl === entry.baseUrl && fav.model === entry.model);
    const next = exists
      ? this.favorites.filter((fav) => fav.baseUrl !== entry.baseUrl || fav.model !== entry.model)
      : [{ baseUrl: entry.baseUrl, model: entry.model }, ...this.favorites].slice(0, MAX_FAVORITES);

    try {
      await this.options.favorites?.save(next);
    } catch (error) {
      this.note(`could not save favorites: ${(error as Error).message}`, "warn");
      return;
    }

    this.favorites = next;
    this.notice = span(
      exists ? `removed ${entry.model} from favorites` : `favorited ${entry.model}`,
      exists ? this.styles.faint : this.styles.accent,
    );
  }

  /**
   * Rebuilds the list behind an open picker, keeping the cursor where it was.
   *
   * The cursor is followed by its *value*, not by its index: a row that moved
   * is still the same row, and landing on whatever now happens to sit at the
   * old index would read as the keys having jumped on their own.
   */
  private replacePickerItems(all: readonly PickItem[]): void {
    const picker = this.picker;
    if (!picker) return;

    const at = Math.min(Math.max(picker.selected, 0), Math.max(picker.items.length - 1, 0));
    const value = picker.items[at]?.value;

    picker.all = all;
    picker.items = filterPickItems(all, picker.query);

    const found = value === undefined ? -1 : picker.items.findIndex((item) => item.value === value);
    picker.selected =
      found >= 0 ? found : stepPick(picker.items, Math.min(picker.selected, Math.max(picker.items.length - 1, 0)), 0);
  }

  /** The endpoint in use, as short as it can honestly be. */
  private endpointName(baseUrl = this.baseUrl): string {
    return shortHost(baseUrl);
  }

  /**
   * Switches the endpoint this session talks to.
   *
   * The list is what the environment can already reach with a key — KiCode has
   * no way to invent a credential, so offering an endpoint it cannot
   * authenticate to would only produce a 401 after the choice.
   */
  private async chooseProvider(providers: readonly ProviderOption[]): Promise<void> {
    if (providers.length === 0) {
      this.note("this run knows of one endpoint; change it with kicode.json or KICODE_BASE_URL", "warn");
      return;
    }

    this.openPicker(
      "Select provider",
      providers.map((provider) => ({
        label: provider.label,
        value: provider.value,
        current: provider.value === this.baseUrl,
        ...(provider.description ? { description: provider.description } : {}),
        ...(provider.value === this.baseUrl ? { trailing: "in use" } : {}),
      })),
      (url) => this.setProvider(url),
    );
  }

  private async setProvider(baseUrl: string): Promise<void> {
    if (baseUrl === this.baseUrl) {
      this.note(`already talking to ${baseUrl}`);
      this.draw();
      return;
    }

    this.baseUrl = baseUrl;
    // The provider is chosen when the agent is built, so a new agent is how a
    // session changes endpoint — the same way a model change works.
    this.rebuild(this.agent.turns);
    this.note(`provider ${baseUrl}`);
    this.draw();
    // Then that endpoint's models, because the model in use may not exist
    // there — and a model name the endpoint has never heard of is a 404.
    await this.chooseModel(baseUrl);
  }

  private async setModel(id: string, baseUrl: string = this.baseUrl): Promise<void> {
    const retry = this.pendingRetry;
    this.pendingRetry = null;

    if (id === this.model && baseUrl === this.baseUrl) {
      this.note(`already using ${id}`);
      if (retry) void this.runTurn(retry.prompt, retry.images);
      this.draw();
      return;
    }

    const moved = baseUrl !== this.baseUrl;
    this.model = id;
    this.baseUrl = baseUrl;
    // Newest first, and only once: the Recent group is a shortcut, not a log.
    this.recentModels = [
      { baseUrl, model: id },
      ...this.recentModels.filter((used) => used.model !== id || used.baseUrl !== baseUrl),
    ].slice(0, MAX_RECENT_MODELS);

    // The provider and the model are both fixed when the agent is built, so a
    // new agent is how a session changes either — and asking for a model is
    // how an endpoint changes too, which is the point of one list.
    this.rebuild(this.agent.turns);
    this.note(moved ? `model ${id} · ${this.endpointName()}` : `model ${id}`);
    void this.options.saveModel?.(id, baseUrl);
    await this.save().catch(() => undefined);
    this.draw();
    // A model chosen from the recovery modal is the answer to "what now?":
    // the failed message runs again, on the model that was just picked.
    if (retry) void this.runTurn(retry.prompt, retry.images);
  }

  private chooseVariant(argument: string): void {
    if (argument) {
      if (!VARIANTS.includes(argument)) {
        this.note(`usage: /variants [${VARIANTS.join("|")}]`);
        return;
      }
      this.setVariant(argument);
      return;
    }

    this.openPicker(
      "Model variant",
      VARIANTS.map((name) => ({
        label: name,
        description: name === DEFAULT_VARIANT ? "the endpoint decides" : "sent as reasoning_effort",
        value: name,
      })),
      (value) => this.setVariant(value),
    );
  }

  private setVariant(name: string): void {
    this.variant = name;
    this.rebuild(this.agent.turns);
    this.note(name === DEFAULT_VARIANT ? "variant back to the default" : `variant ${name} — sent as reasoning_effort`);
    this.draw();
  }

  /**
   * `/themes` — the palette, with a live preview.
   *
   * Moving through the list repaints the screen in the highlighted theme, which
   * is the only honest way to choose a colour scheme: the name tells you
   * nothing. Leaving the list without choosing puts back the one you had, so
   * the preview cannot cost anything.
   *
   * The choice is not remembered by KiCode. It is written down by the user —
   * `"theme"` in `kicode.json`, or `KICODE_THEME` — and saying so here is why
   * the note names both.
   */
  private async chooseTheme(argument: string): Promise<void> {
    if (argument) {
      if (!isThemeName(argument)) {
        this.note(`usage: /themes [${themeNames().join("|")}]`, "warn");
        return;
      }
      await this.setTheme(argument);
      return;
    }

    this.openPicker(
      "Theme",
      THEMES.map((entry) => ({
        label: entry.name,
        value: entry.name,
        ...(entry.name === this.themeName ? { current: true } : {}),
      })),
      (name) => this.setTheme(name),
    );

    // The list previews as it is walked. Set here rather than passed in because
    // a preview is a property of *this* list, not of the picker machinery.
    const before = this.themeName;
    if (this.picker) {
      this.picker.preview = (name) => this.previewTheme(name);
      this.picker.onClose = (committed) => {
        if (!committed) this.previewTheme(before);
      };
    }
  }

  /** Paints the screen in a theme without adopting it. */
  private previewTheme(name: string): void {
    this.theme = themeByName(name);
    this.styles = buildStyles(this.theme);
    this.draw();
  }

  /**
   * Adopts a theme, and keeps it.
   *
   * `/themes` and the settings panel write the same key, so switching a theme
   * from either one survives the run. Two surfaces that saved different things
   * would be a bug report waiting to happen.
   */
  private async setTheme(name: string): Promise<void> {
    this.previewTheme(name);
    this.themeName = name;
    this.view = { ...this.view, theme: name };
    this.note(`theme ${name}`);
    await this.keepTheme(name);
    this.draw();
  }

  private async reloadConfig(): Promise<void> {
    if (!this.options.reload) {
      this.note("this run has no config to reload");
      return;
    }

    try {
      const result = await this.options.reload();
      const changed = result.model !== this.model;
      this.model = result.model;
      this.config = result.files.length > 0 ? result.files.join("  ") : null;
      // The model lives inside the agent, so a change means a new one.
      if (changed) this.rebuild(this.agent.turns);

      this.notes([
        `reloaded ${this.config ?? "no config files"}`,
        changed ? `model is now ${this.model}` : `model unchanged (${this.model})`,
      ]);
    } catch (error) {
      this.note(`could not reload: ${(error as Error).message}`, "warn");
    }
  }

  private async compact(): Promise<void> {
    if (!this.options.compacting) {
      this.note("compaction is off (--no-compact)");
      return;
    }

    const result = await this.agent.compactNow();
    this.note(
      result
        ? `compacted ${result.summarized} earlier messages · ~${formatTokens(result.before)} → ~${formatTokens(result.after)} tokens`
        : "nothing to compact yet, or the summariser failed",
    );
  }

  /** A question answered from the transcript, recorded nowhere. */
  private async sideQuestion(question: string): Promise<void> {
    if (!question) {
      this.note("usage: /btw <question>");
      return;
    }

    this.note(`btw: ${question}`);
    this.setBusy("thinking…");

    let answer = "";
    try {
      for await (const chunk of this.agent.sideQuestion(question)) answer += chunk;
    } catch (error) {
      answer = `could not answer: ${(error as Error).message}`;
    } finally {
      this.stopBusy();
    }

    this.note(answer.trim() || "(no answer)", "accent");
  }

  // ---- the working directory ---------------------------------------------------

  /**
   * Sends a change set to the model for review.
   *
   * This is the one command that spends a turn: a review is a judgement, and a
   * judgement needs the model that has been looking at the code.
   */
  private async review(scope: string): Promise<void> {
    if (!this.options.gitDiff) {
      this.note("this run cannot read git");
      return;
    }

    const target = scope || "uncommitted";
    const diff = await this.options.gitDiff(target, this.cwd).catch(() => null);
    if (!diff) {
      this.note(`no ${target} changes to review`);
      return;
    }

    this.entries.push({ kind: "user", text: `/review ${target}` });
    this.note(`reviewing ${target} changes · ${diff.split("\n").length} lines`);
    await this.runTurn(
      [
        "Review the changes below. Point out bugs, risky edits, and anything that does not fit the surrounding code.",
        "Be brief and specific, and do not restate the diff.",
        "",
        "```diff",
        diff,
        "```",
      ].join("\n"),
    );
  }

  private async changeDirectory(argument: string): Promise<void> {
    if (!argument) {
      this.note(`cwd ${this.cwd}`);
      return;
    }

    const target = path.resolve(this.cwd, argument);
    try {
      const info = await stat(target);
      if (!info.isDirectory()) throw new Error("not a directory");
    } catch (error) {
      this.note(`cannot change to ${target}: ${(error as Error).message}`, "warn");
      return;
    }

    await this.save().catch(() => undefined);
    this.cwd = target;
    this.mention = null;
    void this.ensureMentionIndex().catch(() => undefined);
    // The tools run in the agent's directory, and the agent is rebuilt around it.
    this.rebuild(this.agent.turns);
    this.changes = [];
    await this.refreshTabs();
    this.note(`cwd ${target}`);
  }

  /**
   * Hands the prompt to `$EDITOR`.
   *
   * The alternate screen has to be given back first: a full-screen editor needs
   * the real terminal, and leaving our frame up would corrupt both.
   */
  private async openEditor(argument: string): Promise<void> {
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
      this.note("no editor here: this is not a real terminal");
      return;
    }

    const editor =
      process.env.KICODE_EDITOR || process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
    const target = argument
      ? path.resolve(this.cwd, argument)
      : path.join(await mkdtemp(path.join(tmpdir(), "kicode-")), "prompt.md");

    if (!argument) await writeFile(target, this.editor.text, "utf8");

    this.output.write(DISABLE_PASTE + ENABLE_WRAP + SHOW_CURSOR + LEAVE_ALT_SCREEN);
    this.input.setRawMode?.(false);
    try {
      const result = spawnSync(editor, [target], { stdio: "inherit", shell: process.platform === "win32" });
      if (result.error) this.note(`could not open ${editor}: ${result.error.message}`, "warn");
      else if (result.status !== 0) this.note(`${editor} exited with ${result.status}`, "warn");
      else if (!argument) this.editor.setText((await readFile(target, "utf8")).trim());
    } finally {
      this.enterTerminal();
      this.draw();
    }
  }

  private async initialise(): Promise<void> {
    if (!this.options.initialise) {
      this.note("this run cannot write settings");
      return;
    }

    try {
      const result = await this.options.initialise(this.cwd);
      if (result.blocked) {
        this.note(`could not write ${result.file}: the existing file is not valid JSON`, "warn");
        return;
      }

      this.note(result.status === "unchanged" ? `${result.file} already records these settings` : `${result.file} ${result.status}`);
      if (result.agents) this.note(`wrote ${result.agents} — the model reads it as project instructions`);
    } catch (error) {
      this.note(`could not write settings: ${(error as Error).message}`, "warn");
    }
  }

  // ---- the picker ---------------------------------------------------------------

  /** Shows a list to choose from until one is taken or the list is closed. */
  private openPicker(
    title: string,
    items: readonly PickItem[],
    pick: (value: string) => void | Promise<void>,
    extras?: readonly PickerExtra[],
    tabs?: { labels: readonly string[]; active: number; rows: (active: number) => readonly PickItem[] },
    searchable = true,
    position?: "center" | "top" | "bottom",
  ): void {
    if (items.length === 0) {
      this.note(`nothing to choose from for ${title.toLowerCase()}`);
      return;
    }

    this.picker = {
      title,
      all: items,
      items: [...items],
      query: "",
      selected: 0,
      searchable,
      pick,
      ...(extras && extras.length > 0 ? { extras: [...extras] } : {}),
      ...(tabs ? { tabs } : {}),
      ...(position ? { position } : {}),
    };
    this.editor.clear();
    this.draw();
  }

  private promptInput(
    title: string,
    placeholder: string,
    onSubmit: (value: string) => Promise<void> | void,
    options?: { hints?: readonly (readonly [string, string])[]; initial?: string },
  ): void {
    this.picker = {
      title,
      all: [],
      items: [],
      query: options?.initial ?? "",
      selected: 0,
      searchable: true,
      placeholder,
      hints: options?.hints ?? [["enter", "submit"]],
      onSubmitQuery: onSubmit,
      pick: () => {},
    };
    this.editor.clear();
    this.draw();
  }

  private async enterApiKey(targetBaseUrl = this.baseUrl, providerName?: string): Promise<void> {
    const name = providerName || this.endpointName(targetBaseUrl);
    this.promptInput("Manually enter API Key", "API key", async (key) => {
      const trimmed = key.trim();
      if (!trimmed) {
        this.note("no API key entered", "warn");
        this.draw();
        return;
      }
      if (this.options.saveApiKey) {
        await this.options.saveApiKey(trimmed, targetBaseUrl);
      }
      this.note(`saved API key for ${name}`);
      this.baseUrl = targetBaseUrl;
      this.rebuild(this.agent.turns);
      this.draw();
      await this.chooseModel(targetBaseUrl);
    });
  }

  private addCustomProvider(): void {
    this.promptInput("Add API Provider (Base URL)", "https://api.openai.com/v1", async (urlInput) => {
      const rawUrl = urlInput.trim().replace(/\/+$/, "");
      if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
        this.note("invalid Base URL — expected http:// or https:// URL", "warn");
        this.draw();
        return;
      }

      let defaultName = "custom";
      try {
        defaultName = new URL(rawUrl).hostname.replace(/\./g, "-").replace(/[^a-zA-Z0-9-]/g, "") || "custom";
      } catch {}

      this.promptInput("Manually enter API Key", "API key (or press enter for none)", async (keyInput) => {
        const apiKey = keyInput.trim();
        if (this.options.saveProvider) {
          await this.options.saveProvider(defaultName, {
            baseUrl: rawUrl,
            ...(apiKey ? { apiKey } : {}),
          });
        }
        this.note(`added ${defaultName} (${rawUrl})`);
        this.baseUrl = rawUrl;
        this.rebuild(this.agent.turns);
        this.draw();
        await this.chooseModel(rawUrl);
      });
    });
  }

  private async handlePickerKey(key: Key): Promise<boolean> {
    const picker = this.picker;
    if (!picker) return false;

    const last = Math.max(picker.items.length - 1, 0);
    const take = (index: number): void => {
      const item = picker.items[index];
      // A row that cannot be chosen is a note, not a choice: pressing Enter on
      // one leaves the list open rather than doing nothing at all.
      if (!item || item.disabled) return;
      this.picker = null;
      picker.onClose?.(true);
      this.run(picker.pick(item.value));
    };

    /** Says which row the cursor is on now, for a list that previews. */
    const announce = (): void => {
      picker.preview?.(picker.items[picker.selected]?.value ?? "");
    };

    /** Re-filters after the search field changed, keeping the cursor in range. */
    const refilter = (query: string): void => {
      picker.query = query;
      picker.items = filterPickItems(picker.all, query);
      // The cursor lands on something choosable, or the first keystroke after a
      // search would leave it on a row that only explains itself.
      picker.selected = stepPick(picker.items, Math.min(picker.selected, Math.max(picker.items.length - 1, 0)), 0);
    };

    switch (key.type) {
      case "tab":
      case "backtab": {
        // The tab row is a filter, not a second list: the search stays typed and
        // the cursor stays as close to where it was as the new list allows.
        if (!picker.tabs) return false;
        const count = picker.tabs.labels.length;
        const step = key.type === "tab" ? 1 : -1;
        picker.tabs.active = (((picker.tabs.active + step) % count) + count) % count;
        picker.all = picker.tabs.rows(picker.tabs.active);
        refilter(picker.query);
        announce();
        return true;
      }
      case "up":
        picker.selected = stepPick(picker.items, picker.selected, -1);
        announce();
        return true;
      case "down":
        picker.selected = stepPick(picker.items, picker.selected, 1);
        announce();
        return true;
      case "escape":
        this.picker = null;
        picker.onClose?.(false);
        return true;
      case "enter": {
        if (picker.onSubmitQuery) {
          const query = picker.query.trim();
          this.picker = null;
          picker.onClose?.(true);
          this.run(picker.onSubmitQuery(query));
          return true;
        }
        take(Math.min(Math.max(picker.selected, 0), last));
        return true;
      }
      case "backspace":
        if (picker.query.length > 0) {
          refilter(picker.query.slice(0, -1));
          announce();
        }
        return true;
      case "text": {
        if (picker.searchable === false) {
          const digit = /^([1-9])$/.exec(key.text);
          if (digit) {
            const index = Number(digit[1]) - 1;
            if (index <= last) take(index);
          }
          return true;
        }

        // A digit picks only while the search field is empty, so the documented
        // shortcut survives and `2.5` can still be typed into a search.
        const digit = !picker.onSubmitQuery && picker.query.length === 0 ? /^([1-9])$/.exec(key.text) : null;
        if (digit) {
          const index = Number(digit[1]) - 1;
          if (index <= last) take(index);
          return true;
        }

        // Everything else goes into the search field rather than being typed
        // into the prompt behind the list.
        refilter(picker.query + key.text);
        announce();
        return true;
      }
      // A pasted list of models is searched for by its first line, which is
      // what pasting a name into a search field is for.
      case "paste":
        if (picker.searchable === false) return true;
        refilter(picker.query + key.text.split("\n")[0]!);
        announce();
        return true;
      case "ctrl": {
        const extra = picker.extras?.find((entry) => entry.key === key.key);
        if (extra) {
          // The row under the cursor is the one an in-place key acts on, so it
          // is handed over rather than looked up again by whoever handles it.
          const item = picker.items[Math.min(Math.max(picker.selected, 0), last)];
          // An extra that changes a row in place leaves the list up: closing it
          // would throw away the search and the cursor with it.
          if (extra.close === false) {
            await extra.run(item);
            return true;
          }
          this.picker = null;
          this.run(extra.run(item));
          return true;
        }
        // Every other Ctrl key still reaches the app: quitting must never be
        // swallowed by a list.
        return false;
      }
      default:
        // Anything else belongs to the panel and goes no further, so nothing
        // lands in the prompt hidden behind it.
        return true;
    }
  }

  private async refreshTabs(): Promise<void> {
    const summaries = await this.options.listSessions(this.cwd).catch(() => []);
    if (this.tabs.length === 0) {
      const others = summaries
        .filter((session) => session.id !== this.sessionId && !this.closedSessions.has(session.id) && !this.deletedSessions.has(session.id))
        .slice(0, MAX_TABS - 1)
        .map((session) => ({ id: session.id, title: session.title, current: false }));

      const mine = summaries.find((session) => session.id === this.sessionId);
      const title = mine?.title ?? this.title ?? "new session";

      this.tabs = [{ id: this.sessionId, title, current: true }, ...others];
      return;
    }

    // Refresh titles of currently open tabs
    this.tabs = this.tabs
      .filter((tab) => !this.closedSessions.has(tab.id) && !this.deletedSessions.has(tab.id))
      .map((tab) => {
        const found = summaries.find((s) => s.id === tab.id);
        const title = tab.id === this.sessionId && this.title ? this.title : (found?.title ?? tab.title);
        return { ...tab, title, current: tab.id === this.sessionId };
      });
  }

  // ---- the tab bar ------------------------------------------------------------

  /**
   * A click, a drag or a wheel turn.
   *
   * Three things are clickable — the tab bar, the rows of whatever panel is up,
   * and nothing else — and everything else in the conversation can be **dragged
   * over to select it**. Those two do not compete, because a press is only ever
   * one of them: a press on a row that does something is a click, and a press
   * anywhere else starts a selection. The things you click are not the things
   * you read.
   *
   * A permission prompt is deliberately neither: a click must never answer it,
   * least of all by landing on `allow`.
   */
  /**
   * The editor offset a click at `x` picks out, for a press on the prompt box,
   * or null when the row is not one of the box's text rows.
   *
   * The box reports which text each of its rows carries, because once a long
   * prompt wraps a row no longer starts at the beginning of the line. Without
   * that, a click on the third row would put the caret near the start of the
   * prompt — which is the bug a wrapping box would otherwise introduce.
   */
  private promptClickOffset(row: number, x: number): number | null {
    const box = this.promptBox;
    const line = box?.rows.find((candidate) => candidate.row === row);
    if (!box || !line) return null;
    return Math.max(line.start, Math.min(line.end, line.start + (x - box.textLeft)));
  }

  private click(event: MouseKey): boolean {
    if (event.wheel) {
      // Moving the view moves the text a highlight is over, so the two cannot
      // both be true. The selection goes.
      this.selection = null;
      const delta = event.wheel === "up" ? -3 : 3;
      // Over the `/` palette the wheel walks the list, the way ↑↓ do: the
      // list is what is on screen there, so scrolling the transcript behind
      // it would move something invisible.
      if (this.paletteOpen()) {
        // One row per notch, like ↑↓: the transcript behind keeps ±3 lines,
        // but a list that jumps three rows per tick overshoots short lists
        // (and wraps straight back onto the row it started on).
        const items = this.paletteItems();
        this.paletteSelected = stepSelectable(items, this.paletteSelected, delta < 0 ? -1 : 1);
        return true;
      }
      if (this.clipboardMenu) {
        const len = this.clipboardMenu.items.length;
        this.clipboardMenu.selected = (this.clipboardMenu.selected + (delta < 0 ? -1 : 1) + len) % len;
        return true;
      }
      if (this.picker) {
        this.picker.selected = stepPick(this.picker.items, this.picker.selected, delta < 0 ? -1 : 1);
        this.picker.preview?.(this.picker.items[this.picker.selected]?.value ?? "");
        return true;
      }
      if (this.settingsMenu) {
        const last = Math.max(this.visibleSettings().length - 1, 0);
        this.settingsMenu.selected =
          delta < 0
            ? (this.settingsMenu.selected <= 0 ? last : this.settingsMenu.selected - 1)
            : (this.settingsMenu.selected >= last ? 0 : this.settingsMenu.selected + 1);
        return true;
      }
      if (this.connectMenu) {
        this.connectMenu.selected = stepMenuRow(this.connectMenu.rows, this.connectMenu.selected, delta < 0 ? -1 : 1);
        return true;
      }
      // A question's options are short, so the wheel steps one row — enough
      // to move, not enough to wrap past the answer being read.
      if (this.askState && !this.askTyping) {
        const state = this.askState;
        const last = Math.max(this.askOptions(state.questions[state.index]).length - 1, 0);
        state.selected = delta < 0 ? (state.selected <= 0 ? last : state.selected - 1) : state.selected >= last ? 0 : state.selected + 1;
        return true;
      }
      // A permission prompt is deliberately not scrollable by mouse: a click
      // must never answer it, and a wheel that does nothing is the honest
      // version of that.
      if (this.modal) return false;
      this.scrollBy(delta);
      return true;
    }

    if (event.hover) {
      let changed = false;

      // Tab hover tracking
      if (event.y === 1 && this.tabHits.length > 0 && !this.modal && !this.askState) {
        const column = event.x - 1;
        const hit = this.tabHits.find((tab) => column >= tab.start && column < tab.end);
        if (hit) {
          const close = column >= hit.closeStart;
          if (this.hoverTab?.id !== hit.id || this.hoverTab?.close !== close) {
            this.hoverTab = { id: hit.id, close };
            changed = true;
          }
        } else if (this.hoverTab !== null) {
          this.hoverTab = null;
          changed = true;
        }
      } else if (this.hoverTab !== null) {
        this.hoverTab = null;
        changed = true;
      }

      // Panel rows hover tracking (palette, picker, menu, ask)
      const row = this.panelRows.find((candidate) => candidate.row === event.y);
      if (row) {
        if (row.kind === "palette" && this.paletteSelected !== row.index) {
          this.paletteSelected = row.index;
          changed = true;
        } else if (row.kind === "picker" && this.picker && this.picker.selected !== row.index) {
          this.picker.selected = row.index;
          this.picker.preview?.(this.picker.items[this.picker.selected]?.value ?? "");
          changed = true;
        } else if (row.kind === "menu") {
          if (this.settingsMenu && this.settingsMenu.selected !== row.index) {
            this.settingsMenu.selected = row.index;
            changed = true;
          }
          if (this.connectMenu && this.connectMenu.selected !== row.index) {
            this.connectMenu.selected = row.index;
            changed = true;
          }
        } else if (row.kind === "clipboard_menu" && this.clipboardMenu && this.clipboardMenu.selected !== row.index) {
          this.clipboardMenu.selected = row.index;
          changed = true;
        } else if (row.kind === "ask" && this.askState && this.askState.selected !== row.index) {
          this.askState.selected = row.index;
          changed = true;
        }
      }

      return changed;
    }

    if (event.drag) {
      if (this.scrollingScrollbar && this.scrollbarInfo) {
        const trackHeight = this.scrollbarInfo.bottomRow - this.scrollbarInfo.topRow + 1;
        const relY = clamp(event.y - this.scrollbarInfo.topRow, 0, trackHeight - 1);
        const fraction = relY / Math.max(trackHeight - 1, 1);
        this.scroll = Math.round((1 - fraction) * this.scrollbarInfo.maxScroll);
        this.anchor = null;
        return true;
      }
      // A drag that started in the prompt extends the editor's own selection,
      // on whatever row of a wrapped prompt the pointer is over.
      const overPrompt = this.editor.selectionStart !== null ? this.promptClickOffset(event.y, event.x) : null;
      if (overPrompt !== null) {
        this.editor.selectionEnd = overPrompt;
        this.editor.cursor = overPrompt;
        return true;
      }
      if (this.dragging && this.selection) {
        if (this.selection.to.row !== event.y || this.selection.to.col !== event.x) {
          this.selection = { ...this.selection, to: { row: event.y, col: event.x } };
          return true;
        }
      }
      return false;
    }

    if (event.release) {
      if (this.scrollingScrollbar) {
        this.scrollingScrollbar = false;
        return true;
      }
      if (this.dragging) {
        this.dragging = false;
        if (this.selection) {
          if (this.selection.from.row === this.selection.to.row && this.selection.from.col === this.selection.to.col) {
            this.selection = null;
          } else {
            const text = this.selectedText();
            if (text.trim()) {
              void this.writeSelection(text);
            }
          }
        }
        if (this.editor.hasSelection()) {
          const text = this.editor.selectedText();
          if (text.trim()) {
            void this.writeSelection(text);
          }
        }
        return true;
      }
      return false;
    }

    if (this.clipboardMenu) {
      const cmHit = this.panelRows.find((c) => c.kind === "clipboard_menu" && c.row === event.y);
      if (cmHit) {
        const item = this.clipboardMenu.items[cmHit.index];
        this.clipboardMenu = null;
        if (item) void this.executeClipboardAction(item.value);
        return true;
      }
      this.clipboardMenu = null;
      return true;
    }

    // Scrollbar clicking
    if (!this.paletteOpen() && !this.coveredBy() && this.scrollbarInfo) {
      if (
        (event.x === this.scrollbarInfo.col || event.x === this.scrollbarInfo.col - 1) &&
        event.y >= this.scrollbarInfo.topRow &&
        event.y <= this.scrollbarInfo.bottomRow
      ) {
        this.scrollingScrollbar = true;
        this.selection = null;
        const trackHeight = this.scrollbarInfo.bottomRow - this.scrollbarInfo.topRow + 1;
        const relY = clamp(event.y - this.scrollbarInfo.topRow, 0, trackHeight - 1);
        const fraction = relY / Math.max(trackHeight - 1, 1);
        this.scroll = Math.round((1 - fraction) * this.scrollbarInfo.maxScroll);
        this.anchor = null;
        return true;
      }
    }

    // Tab bar clicks
    if (event.y === 1 && this.tabHits.length > 0 && !this.modal && !this.askState) {
      const column = event.x - 1;
      const hit = this.tabHits.find((tab) => column >= tab.start && column < tab.end);
      if (!hit) return false;

      this.selection = null;

      // Right-click opens Tab context menu
      if (event.rightClick || event.button === 2) {
        this.lastRightClickTime = Date.now();
        if (hit.id !== NEW_TAB) {
          this.openTabContextMenu(hit.id);
          return true;
        }
        return false;
      }

      if (hit.id === NEW_TAB) this.run(this.newSession());
      else if (column >= hit.closeStart) this.run(this.closeSession(hit.id));
      else this.run(this.switchSession(hit.id));
      return true;
    }

    // Right-click anywhere in conversation/editor: open Clipboard Context Menu
    if (event.rightClick || event.button === 2) {
      this.lastRightClickTime = Date.now();
      if (!this.modal && !this.askState && !this.picker) {
        void this.openClipboardContextMenu();
        return true;
      }
    }

    // "Go to Bottom" button click
    const jumpHit = this.panelRows.find(
      (c) =>
        c.kind === "jump_bottom" &&
        c.row === event.y &&
        (!c.colStart || !c.colEnd || (event.x >= c.colStart && event.x <= c.colEnd)),
    );
    if (jumpHit) {
      this.scroll = 0;
      this.anchor = null;
      this.selection = null;
      this.draw();
      return true;
    }

    // Picker tab click (all, free, paid)
    const pickerTabHit = this.panelRows.find(
      (c) =>
        c.kind === "picker_tab" &&
        c.row === event.y &&
        (!c.colStart || !c.colEnd || (event.x >= c.colStart && event.x <= c.colEnd)),
    );
    if (pickerTabHit && this.picker?.tabs) {
      this.picker.tabs.active = pickerTabHit.index;
      this.picker.all = this.picker.tabs.rows(pickerTabHit.index);
      this.picker.items = filterPickItems(this.picker.all, this.picker.query);
      this.picker.selected = stepPick(this.picker.items, 0, 0);
      this.picker.preview?.(this.picker.items[this.picker.selected]?.value ?? "");
      this.draw();
      return true;
    }

    // Picker item row click
    const pickerRowHit = this.panelRows.find(
      (c) =>
        c.kind === "picker" &&
        c.row === event.y &&
        (!c.colStart || !c.colEnd || (event.x >= c.colStart && event.x <= c.colEnd)),
    );
    if (pickerRowHit && this.picker) {
      const item = this.picker.items[pickerRowHit.index];
      if (item && !item.disabled) {
        const picker = this.picker;
        this.picker = null;
        picker.onClose?.(true);
        this.run(picker.pick(item.value));
        return true;
      }
    }

    // Clicking on the prompt's first text row: the row the badges and the
    // `[+]` control are drawn on. A wrapped prompt's lower rows carry text and
    // nothing else, so a press there is only ever a caret (handled below).
    if (this.promptBox && this.promptBox.rows[0]?.row === event.y) {
      const margin = this.output.columns && this.output.columns >= 50 ? 2 : 0;
      const usable = (this.output.columns ?? 80) - 1;
      const promptLeft = margin + 3;

      // 1. Check if clicking attached image badge
      if (this.attached.length > 0) {
        let badgeStart = promptLeft;
        for (let i = 0; i < this.attached.length; i++) {
          const badgeLen = `[Image ${i + 1}] `.length;
          if (event.x >= badgeStart && event.x < badgeStart + badgeLen) {
            this.attached.splice(i, 1);
            this.notice = this.attached.length > 0 ? span(`attached images: ${this.attached.length}`, this.styles.dim) : null;
            this.draw();
            return true;
          }
          badgeStart += badgeLen;
        }
      }

      // 2. Check [+] button click
      if (this.editor.text.length === 0 && this.attached.length === 0 && event.x >= promptLeft && event.x <= promptLeft + 3) {
        void this.openClipboardContextMenu();
        return true;
      }

      // 3. Check [+] attach button click. It sits at the right edge of the
      // prompt row — the only control the row carries, now that send has no
      // button of its own (enter sends) and the variant has none either
      // (`/effort` changes it). `event.x` is a 1-based column, and the glyph is
      // the last three cells before the padding one — so its first cell is
      // `usable - attachLen`, which is where the drawn `[+]` actually starts.
      const attachLen = 3;
      const attachStart = usable - attachLen;
      if (event.x >= attachStart && event.x < attachStart + attachLen) {
        void this.attachFromPicker();
        return true;
      }
    }

    // Clicking inside the prompt's text: the caret lands where the press did,
    // on whichever row of a wrapped prompt the press was on.
    if (this.editor.text.length > 0) {
      const placed = this.promptClickOffset(event.y, event.x);
      if (placed !== null) {
        if (!this.dragging) {
          this.editor.cursor = placed;
          this.editor.selectionStart = placed;
          this.editor.selectionEnd = placed;
          this.dragging = true;
        } else {
          this.editor.selectionEnd = placed;
          this.editor.cursor = placed;
        }
        return true;
      }
    }

    // A chip is an answer, not a selection: it names the key that does the work
    // and the loop above runs it, so it never goes through `clickRow`. A row can
    // carry several of them, so the column decides which one was pressed.
    const chip = this.panelRows.find(
      (candidate) =>
        (candidate.kind === "close" || candidate.kind === "modal_choice") &&
        candidate.row === event.y &&
        (candidate.colStart === undefined ||
          candidate.colEnd === undefined ||
          (event.x >= candidate.colStart && event.x <= candidate.colEnd)),
    );
    if (chip?.kind === "close") {
      this.clickedKey = { type: "escape" };
      return true;
    }
    if (chip?.kind === "modal_choice") {
      const choice = this.modal?.choices[chip.index];
      if (choice) this.clickedKey = chipKey(choice.key);
      return true;
    }

    const row = this.panelRows.find((candidate) => candidate.row === event.y);
    if (
      row &&
      row.kind !== "picker" &&
      row.kind !== "picker_tab" &&
      row.kind !== "jump_bottom"
    ) {
      this.selection = null;
      this.run(this.clickRow(row));
      return true;
    }

    // If not clicking an interactive control, begin text selection anywhere on
    // screen — except the chrome under the rule: the prompt box, the state row
    // and the footer are not text anyone would paste as the conversation.
    const maxRow = this.frameText.length || (this.selectable ? this.selectable.bottom : 50);
    // Everything from the rule under the transcript down is chrome, and the
    // box's top row is the only thing that says where it starts — the caret's
    // row moves as the prompt wraps, so it is not a fixed two rows down.
    const chromeTop = this.promptBox ? this.promptBox.top - 1 : Number.POSITIVE_INFINITY;
    if (event.y >= 1 && event.y <= maxRow && event.y < chromeTop) {
      this.selection = { from: { row: event.y, col: event.x }, to: { row: event.y, col: event.x } };
      this.editor.clearSelection();
      this.dragging = true;
      return true;
    }

    return false;
  }

  /**
   * Opens a context menu for a tab when right-clicked.
   */
  private openTabContextMenu(tabId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    const title = tab ? `Tab: ${tab.title}` : "Tab Options";

    const items: PickItem[] = [
      { label: "Close Tab", value: "close", description: "Close this session tab" },
      { label: "Close Others", value: "close_others", description: "Close all other session tabs" },
      { label: "Close to Right", value: "close_right", description: "Close session tabs to the right" },
      { label: "Rename Session", value: "rename", description: "Rename the title of this session" },
      { label: "Delete Session", value: "delete", description: "Permanently delete this session from disk" },
      { label: "Switch to Tab", value: "switch", description: "Switch to this session" },
      { label: "New Session", value: "new", description: "Create a fresh session tab" },
    ];

    this.openPicker(
      title,
      items,
      async (action: string) => {
        switch (action) {
          case "close":
            await this.closeSession(tabId);
            break;
          case "close_others":
            for (const other of [...this.tabs]) {
              if (other.id !== tabId) await this.closeSession(other.id);
            }
            break;
          case "close_right": {
            const index = this.tabs.findIndex((t) => t.id === tabId);
            if (index !== -1) {
              const toRight = this.tabs.slice(index + 1);
              for (const r of toRight) await this.closeSession(r.id);
            }
            break;
          }
          case "rename":
            this.editor.setText(`/rename `);
            this.notice = span("Type new title for session and press Enter", this.styles.dim);
            break;
          case "delete":
            await this.deleteSession(tabId);
            break;
          case "switch":
            await this.switchSession(tabId);
            break;
          case "new":
            await this.newSession();
            break;
        }
      },
      undefined,
      undefined,
      false, // Non-searchable context menu (ignores accidental paste)
      "top",
    );
  }

  /**
   * The dragged text, onto the clipboard.
   *
   * A drag that never moved is not a selection: a plain click on the transcript
   * would otherwise copy whichever character it happened to land on, which is
   * noise rather than help. So a one-cell "selection" is dropped in silence.
   */
  private copySelection(): void {
    const selection = this.selection;
    if (!selection) return;
    if (selection.from.row === selection.to.row && selection.from.col === selection.to.col) {
      this.selection = null;
      return;
    }

    const text = this.selectedText();
    if (!text.trim()) {
      this.selection = null;
      return;
    }
    this.run(this.writeSelection(text));
  }

  /**
   * Opens clipboard options context menu in the chat input area on right click or [+] button click.
   */
  private async openClipboardContextMenu(): Promise<void> {
    this.clipboardMenuOpening = true;
    try {
      const selected = this.selectedText();
      const hasSelection = Boolean(this.selection && selected.trim());
      const hasAttached = this.attached.length > 0;

      let preview: ClipboardMenuState["preview"] = { kind: "empty" };
      if (this.options.readClipboard) {
        try {
          const read = await this.options.readClipboard();
          if (read && read.kind === "image") {
            const imgInfo = decodeImagePreview(read.image);
            preview = {
              kind: "image",
              image: imgInfo,
            };
          } else if (read && read.kind === "text") {
            const textInfo = formatTextPreview(read.text);
            preview = {
              kind: "text",
              text: textInfo.text,
              lines: textInfo.lines,
              totalLines: textInfo.totalLines,
              totalChars: textInfo.totalChars,
            };
          }
        } catch {
          preview = { kind: "empty" };
        }
      }

      const items: PickItem[] = [];
      if (preview.kind === "text") {
        items.push({
          label: "Paste Text from Clipboard",
          value: "paste_text",
          description: `Paste ${preview.totalChars ?? 0} chars into editor`,
        });
      }
      if (preview.kind === "image") {
        items.push({
          label: "Paste Image from Clipboard",
          value: "paste_image",
          description: `Attach image (${Math.max(Math.round((preview.image?.bytes ?? 0) / 1024), 1)} KB)`,
        });
      }
      items.push({
        label: "Paste from Clipboard (Smart)",
        value: "paste",
        description: "Auto-detect text or image",
      });
      if (preview.kind !== "text") {
        items.push({
          label: "Paste Text from Clipboard",
          value: "paste_text",
          description: "Paste clipboard text into editor",
        });
      }
      if (preview.kind !== "image") {
        items.push({
          label: "Paste Image from Clipboard",
          value: "paste_image",
          description: "Attach copied screenshot or image",
        });
      }
      if (hasSelection) {
        items.push({
          label: "Copy Selection",
          value: "copy_selection",
          description: `Copy ${selected.length} characters (Ctrl+C)`,
        });
        items.push({
          label: "Clear Selection",
          value: "clear_selection",
          description: "Deselect highlighted text",
        });
      }
      if (hasAttached) {
        items.push({
          label: "Remove Attached Images",
          value: "clear_images",
          description: `Detach ${this.attached.length} image(s)`,
        });
      }
      if (this.attachedDocs.length > 0) {
        items.push({
          label: "Remove Attached Documents",
          value: "clear_docs",
          description: `Detach ${this.attachedDocs.length} document(s)`,
        });
      }
      items.push({
        label: "Copy Entire Conversation",
        value: "copy_transcript",
        description: "Copy full conversation transcript",
      });

      this.clipboardMenu = {
        items,
        selected: 0,
        preview,
      };
      this.draw();
    } finally {
      this.clipboardMenuOpening = false;
    }
  }

  private async executeClipboardAction(action: string): Promise<void> {
    switch (action) {
      case "copy_selection":
        this.copySelection();
        this.selection = null;
        this.draw();
        break;
      case "paste_text": {
        if (!this.options.readClipboard) {
          this.note("this run cannot read the clipboard", "warn");
          this.draw();
          break;
        }
        const read = await this.options.readClipboard().catch(() => null);
        if (!read || read.kind === "empty") {
          this.note("clipboard is empty", "warn");
        } else if (read.kind === "text") {
          this.editor.insert(read.text);
          this.notice = null;
        } else if (read.kind === "image") {
          this.note("clipboard contains an image — choose 'Paste Image' to attach it", "warn");
        }
        this.draw();
        break;
      }
      case "paste_image": {
        if (!this.options.readClipboard) {
          this.note("this run cannot read the clipboard", "warn");
          this.draw();
          break;
        }
        const read = await this.options.readClipboard().catch(() => null);
        if (!read || read.kind === "empty") {
          this.note("clipboard is empty", "warn");
        } else if (read.kind === "image") {
          this.attached = [...this.attached, read.image];
          this.notice = span(`attached image ${this.attached.length} · ${Math.max(Math.round(read.image.bytes / 1024), 1)} KB`, this.styles.dim);
        } else if (read.kind === "text") {
          this.note("clipboard contains text — choose 'Paste Text' to paste it", "warn");
        }
        this.draw();
        break;
      }
      case "paste":
        await this.pasteFromClipboard();
        break;
      case "clear_selection":
        this.selection = null;
        this.draw();
        break;
      case "clear_images":
        this.attached = [];
        this.notice = span("removed attached images", this.styles.dim);
        this.draw();
        break;
      case "clear_docs":
        this.attachedDocs = [];
        this.notice = span("removed attached documents", this.styles.dim);
        this.draw();
        break;
      case "copy_transcript":
        await this.copyTranscript();
        break;
    }
  }

  private async handleClipboardMenuKey(key: Key): Promise<boolean> {
    const cm = this.clipboardMenu;
    if (!cm) return false;

    switch (key.type) {
      case "escape":
        this.clipboardMenu = null;
        return true;
      case "up":
        cm.selected = (cm.selected - 1 + cm.items.length) % cm.items.length;
        return true;
      case "down":
        cm.selected = (cm.selected + 1) % cm.items.length;
        return true;
      case "enter": {
        const item = cm.items[cm.selected];
        this.clipboardMenu = null;
        if (item) await this.executeClipboardAction(item.value);
        return true;
      }
      case "text": {
        const num = Number.parseInt(key.text, 10);
        if (num >= 1 && num <= cm.items.length) {
          const item = cm.items[num - 1];
          this.clipboardMenu = null;
          if (item) await this.executeClipboardAction(item.value);
        }
        return true;
      }
      case "paste":
        return true;
      default:
        return true;
    }
  }

  /**
   * The selection as it reads on screen.
   *
   * Taken from the frame's own rows rather than from the transcript's entries:
   * what was dragged over is what is on screen — wrapped exactly as it is drawn,
   * with the tool output and the reasoning blocks in their places — and
   * rebuilding it from the model would be a second rendering to disagree with.
   */
  private selectedText(): string {
    const selection = this.selection;
    if (!selection) return "";

    const from = selection.from;
    const to = selection.to;
    const startRow = Math.min(from.row, to.row);
    const endRow = Math.max(from.row, to.row);

    const rows: string[] = [];
    for (let row = startRow; row <= endRow; row++) {
      const text = this.frameText[row - 1];
      if (text === undefined) continue;
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
      rows.push(sliceCells(text, Math.max(left, 0), Math.max(right, 0)).trimEnd());
    }

    return rows.join("\n");
  }

  private lastCopiedText: string | null = null;

  private async writeSelection(text: string): Promise<void> {
    if (this.lastCopiedText === text) return;
    this.lastCopiedText = text;
    const copied = await this.options.copyToClipboard?.(text).catch(() => false);
    const lines = text.split("\n").length;
    const what = lines === 1 ? "1 line" : `${lines} lines`;
    if (copied) {
      this.copiedNotice = `${what} (${text.length} chars)`;
      if (this.copiedTimer) clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => {
        this.copiedNotice = null;
        this.copiedTimer = null;
        this.draw();
      }, 2500);
      this.notice = span(`✓ copied ${what} (${text.length} characters) to clipboard`, this.styles.ok);
    } else {
      this.notice = span(`could not write to clipboard — /export writes a file`, this.styles.warn);
    }
    this.draw();
  }

  /**
   * A click on a row of a panel: put the cursor on it, then press Enter.
   *
   * Both halves go through the handlers the keyboard already uses, so a click
   * is not a second implementation of "choose this row" — it is the same one
   * with the cursor moved first. Everything that works from the keyboard
   * therefore works from the mouse, including the parts that deliberately
   * refuse: a disabled picker row, a command that cannot run here, a settings
   * row whose value has nowhere to be saved.
   */
  private async clickRow(hit: PanelRow): Promise<void> {
    if (hit.kind === "picker" && this.picker) this.picker.selected = hit.index;
    if (hit.kind === "menu") {
      // Only one of the two can be up, and both keep their cursor in `selected`.
      if (this.settingsMenu) this.settingsMenu.selected = hit.index;
      if (this.connectMenu) this.connectMenu.selected = hit.index;
    }
    if (hit.kind === "ask" && this.askState) this.askState.selected = hit.index;
    if (hit.kind === "palette") this.paletteSelected = hit.index;

    await this.handleKeys([{ type: "enter" }]);
    this.draw();
  }

  /**
   * Runs an action in the background and redraws when it lands.
   *
   * A click and a picker both start work that finishes after the key that began
   * it has been handled — loading a session, writing a file — and the frame has
   * to be drawn again or the screen would keep showing the old state.
   */
  private run(action: Promise<void> | void): void {
    void Promise.resolve(action).then(
      () => this.draw(),
      (error: unknown) => {
        // A rejection that only redraws is indistinguishable from a key that did
        // nothing, which is the worst thing a command can look like — say why.
        this.note(`failed: ${(error as Error).message}`, "error");
        this.draw();
      },
    );
  }

  /**
   * Closes a tab, and moves the session elsewhere if it was the one on screen.
   *
   * The last tab is not special-cased away: closing it leaves a fresh session,
   * because a tab bar with nothing in it has nothing to type into.
   */
  private async closeSession(id: string): Promise<void> {
    this.closedSessions.add(id);
    this.tabs = this.tabs.filter((tab) => tab.id !== id);

    if (id === this.sessionId) {
      const other = this.tabs[0];
      if (!other) {
        await this.newSession();
        return;
      }
      await this.switchSession(other.id);
      return;
    }

    this.draw();
  }

  /**
   * Permanently deletes a session file and removes it from tabs.
   */
  private async deleteSession(id: string): Promise<void> {
    this.deletedSessions.add(id);
    this.closedSessions.add(id);
    this.tabs = this.tabs.filter((t) => t.id !== id);

    if (this.options.deleteSession) {
      await this.options.deleteSession(id).catch(() => false);
    }

    if (id === this.sessionId) {
      const other = this.tabs[0];
      if (!other) {
        await this.newSession();
      } else {
        await this.switchSession(other.id);
      }
      if (this.options.deleteSession) {
        await this.options.deleteSession(id).catch(() => false);
      }
      this.notice = span("session deleted", this.styles.dim);
      this.draw();
      return;
    }

    this.notice = span("session deleted", this.styles.dim);
    this.draw();
  }

  private async chooseSessionToDelete(): Promise<void> {
    const sessions = await this.options.listSessions(this.cwd).catch(() => []);
    const available = sessions.filter((s) => !this.deletedSessions.has(s.id));
    if (available.length === 0) {
      this.notice = span("no sessions to delete", this.styles.faint);
      this.draw();
      return;
    }

    this.openPicker(
      "Delete Session · select a session to permanently delete",
      available.map((session) => ({
        label: session.title,
        description: session.id === this.sessionId ? `${session.id} (current)` : session.id,
        value: session.id,
      })),
      async (id) => {
        await this.deleteSession(id);
      },
      undefined,
      undefined,
      false,
    );
  }

  private async save(): Promise<void> {
    // A deleted session must never be saved back to disk
    if (this.deletedSessions.has(this.sessionId)) return;
    // An empty session is not worth keeping, and writing one would make
    // `--continue` resume a blank conversation.
    if (this.agent.turns.length === 0) return;
    await this.options.saveSession({
      id: this.sessionId,
      createdAt: this.createdAt,
      cwd: this.cwd,
      messages: this.agent.turns,
      ...(this.title ? { title: this.title } : {}),
    });
  }

  // ---- approval ---------------------------------------------------------------

  /**
   * The settings an agent is built with: the channels it reaches the user
   * through, and the session's model, directory and variant.
   */
  private settings(): AgentSettings {
    return {
      approve: this.approver(),
      ask: this.asker(),
      model: this.model,
      baseUrl: this.baseUrl,
      cwd: this.cwd,
      variant: this.variant,
      mode: this.mode,
      // Gateways that route per conversation (OpenCode Go's
      // `x-opencode-session`) get the id this transcript is saved under, so
      // every rebuild of the same session keeps the same identity.
      sessionId: this.sessionId,
    };
  }

  /** A fresh agent over the same transcript, after a setting changed. */
  private rebuild(history: readonly ChatMessage[]): void {
    this.agent = this.options.createAgent([...history], this.settings());
  }

  private approver(): ApproveFn {
    return (request) =>
      new Promise<ApprovalDecision>((resolve) => {
        this.pending = { request, resolve };
        this.modal = {
          title: `${request.name} wants to run`,
          body: this.modalBody(request),
          question: "allow?",
          choices: [
            { key: "y", label: "yes" },
            { key: "a", label: "always" },
            { key: "n", label: "no" },
          ],
          // Escape and Ctrl+C are the ones the card does not name: both mean no,
          // but only Ctrl+C also stops the turn behind the prompt.
          footer: [
            ["esc", "deny"],
            ["ctrl+c", "deny + stop"],
          ],
        };
        this.draw();
      });
  }

  private modalBody(request: ApprovalRequest): Span[] {
    if (!request.preview) return [span(flatten(JSON.stringify(request.args)), this.styles.dim)];

    return request.preview.split("\n").map((line, index) => {
      const style = line.startsWith("+") ? this.styles.ok : line.startsWith("-") ? this.styles.error : this.styles.dim;
      return span(`${index === 0 ? "" : "\n"}${line}`, style);
    });
  }

  // ---- drawing ----------------------------------------------------------------

  private scheduleDraw(): void {
    if (this.redrawPending || this.closed) return;
    this.redrawPending = setTimeout(() => {
      this.redrawPending = null;
      this.draw();
    }, REDRAW_MS);
  }

  private draw(): void {
    if (this.closed) return;

    const size = terminalSize(this.output);
    const state = this.state();
    const frame = renderFrame(state, size, this.styles, this.theme);
    this.tabHits = frame.tabs;
    this.panelRows = frame.rows;
    this.frameText = frame.text;
    this.selectable = frame.selectable;
    this.promptRow = frame.caret ? frame.caret.row : null;
    this.promptBox = frame.prompt;
    this.scrollbarInfo = frame.scrollbar ?? null;

    this.output.write(CURSOR_HOME + frame.lines.join("\r\n"));
    if (frame.caret) {
      this.output.write(SHOW_CURSOR + cursorTo(frame.caret.row, frame.caret.col));
    } else {
      this.output.write(HIDE_CURSOR);
    }
  }

  /**
   * The panel that is open, as the renderer wants it.
   *
   * Built on every draw from the state it describes — the settings rows carry
   * the value in effect, so a row cannot show a value that is not the one being
   * used, which is the whole reason to draw them from `this.view` rather than
   * keep a copy beside it.
   */
  private menuPanel(): MenuPanel | null {
    if (this.settingsMenu) {
      const menu = this.settingsMenu;
      const defs = this.visibleSettings();
      const selected = Math.min(Math.max(menu.selected, 0), Math.max(defs.length - 1, 0));
      const current = defs[selected];
      return {
        title: "Settings",
        rows: settingRows(defs, this.view),
        selected,
        query: menu.query,
        footer: "‹/› change · enter value · ↑↓ move · esc close",
        ...(current ? { description: `${current.description}${this.options.saveView ? "" : " (not saved)"}` } : {}),
      };
    }

    if (this.connectMenu) {
      const menu = this.connectMenu;
      return {
        title: "Connect an integration",
        rows: menu.rows,
        selected: Math.min(Math.max(menu.selected, 0), Math.max(menu.rows.length - 1, 0)),
        query: menu.query,
        footer: "enter connect · ↑↓ move · esc close",
      };
    }

    return null;
  }

  private state(): TuiState {
    return {
      tabs: this.tabs,
      hoverTabId: this.hoverTab?.id ?? null,
      hoverClose: this.hoverTab?.close ?? false,
      entries: this.entries,
      editor: this.editor,
      attachedImages: this.attached.length,
      attachedDocs: this.attachedDocs.map((doc) => doc.name),
      busy: this.busy,
      spinnerFrame: this.spinnerFrame,
      model: this.model,
      messageCount: this.agent.turns.length,
      compacting: this.options.compacting,
      cwd: this.cwd,
      version: this.options.version,
      mcp: this.options.mcp ?? null,
      config: this.config,
      notice: this.notice,
      modal: this.modal,
      menu: this.menuPanel(),
      clipboardMenu: this.clipboardMenu,
      isPaused: this.isPaused,
      queuedCount: this.queuedPrompts.length,
      settings: this.view,
      scroll: this.scroll,
      anchor: this.anchor,
      picker: this.picker
        ? {
            title: this.picker.title,
            items: this.picker.items,
            selected: this.picker.selected,
            query: this.picker.query,
            searchable: this.picker.searchable,
            placeholder: this.picker.placeholder,
            onSubmitQuery: this.picker.onSubmitQuery,
            ...(this.picker.tabs ? { tabs: { labels: this.picker.tabs.labels, active: this.picker.tabs.active } } : {}),
            ...(this.picker.hints
              ? { hints: this.picker.hints }
              : this.picker.tabs || (this.picker.extras && this.picker.extras.length > 0)
              ? {
                  hints: [
                    ...(this.picker.tabs ? ([['tab', 'filter']] as [string, string][]) : []),
                    ...(this.picker.extras ?? []).map((extra) => extra.hint),
                  ],
                }
              : {}),
          }
        : null,
      variant: this.variant,
      mode: this.mode,
      goalActive: this.goalRun,
      usage: { tokens: this.agent.contextTokens, budget: this.options.contextTokens, tools: this.toolCalls() },
      palette: this.paletteOpen() ? { items: this.paletteItems(), selected: this.paletteSelected } : null,
      mentions:
        this.mention && !this.paletteOpen()
          ? {
              items: this.mention.items.map((item) => ({
                label: item.label,
                ...(item.description ? { description: item.description } : {}),
                kind: item.kind,
              })),
              selected: this.mention.selected,
            }
          : null,
      ask: this.askState
        ? {
            questions: this.askState.questions.map((question) => ({
              header: question.header,
              question: question.question,
              options: this.askOptions(question),
            })),
            index: this.askState.index,
            selected: this.askState.selected,
            answers: this.askState.answers,
          }
        : null,
      askTyping: this.askTyping,
      copiedNotice: this.copiedNotice,
      // Without this the renderer never hears about a drag, and the highlight
      // code — fully tested with an explicit selection — never runs live.
      selection: this.selection,
    };
  }

  /**
   * Leaves the loop. Deliberately does *not* mark the app closed: teardown
   * still has to run, or the terminal is left in raw mode and the last turn is
   * never saved. `shutdown()` is what sets `closed`.
   */
  private quit(): void {
    this.finish?.();
  }
}

/**
 * The settings rows as the panel wants them: a value on the right, and the
 * group heading carried only by the first row of each run.
 */
function settingRows(defs: readonly SettingDef[], view: ViewSettings): MenuRow[] {
  let group = "";
  return defs.map((def) => {
    const row: MenuRow = { label: def.label, value: def.id, trailing: String(view[def.id]) };
    if (def.group !== group) {
      row.group = def.group;
      group = def.group;
    }
    return row;
  });
}

/** `thinking hide` from a patch, for a notice under the prompt. */
function describePatch(patch: Partial<ViewSettings>): string {
  return Object.entries(patch)
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(" · ");
}

/** The endpoint, as short as it can honestly be. */
function shortHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** One route's line, the one in use marked as such. */
function routeLine(line: RouteHealthLine, current: boolean): string {
  return `${line.ref.model} @ ${shortHost(line.ref.baseUrl)} — ${line.state}${current ? " (in use)" : ""} · ${line.detail}`;
}

/** Home-screen state, used by `--tui-preview`. */
function blankState(options: TuiOptions): TuiState {
  return {
    tabs: [{ id: options.initial.id, title: "new session", current: true }],
    hoverTabId: null,
    hoverClose: false,
    entries: [],
    editor: new LineEditor(),
    attachedImages: 0,
    busy: null,
    spinnerFrame: 0,
    model: options.model,
    messageCount: options.initial.messages?.length ?? 0,
    compacting: options.compacting,
    cwd: options.cwd,
    version: options.version,
    mcp: options.mcp ?? null,
    config: options.config ?? null,
    notice: null,
    modal: null,
    menu: null,
    settings: options.view ?? defaultViewSettings(),
    scroll: 0,
    anchor: null,
    picker: null,
    variant: DEFAULT_VARIANT,
    mode: "build",
    usage: { tokens: 0, budget: options.contextTokens, tools: 0 },
    palette: null,
    ask: null,
    askTyping: false,
  };
}

/**
 * Terminal size, in cells.
 *
 * Falls back to `COLUMNS`/`LINES` so a piped or captured render still has a
 * sane, controllable geometry.
 */
export function terminalSize(output: { columns?: number; rows?: number }): { cols: number; rows: number } {
  return {
    cols: positive(output.columns) ?? positive(process.env.COLUMNS) ?? 80,
    rows: positive(output.rows) ?? positive(process.env.LINES) ?? 24,
  };
}

function positive(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}
