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
  DISABLE_KEY_MODIFIERS,
  DISABLE_KITTY_KEYS,
  DISABLE_MOUSE,
  DISABLE_PASTE,
  DISABLE_WRAP,
  ENABLE_KEY_MODIFIERS,
  ENABLE_KITTY_KEYS,
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
  textWidth,
  type Span,
} from "./ansi";
import { COMMANDS, commandQuery, filterCommands, isAvailable, stepSelectable, type Command } from "./commands";
import { LineEditor } from "./editor";
import { keysFilePath } from "../keys-file";
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
import {
  type FormField,
  type FormPanel,
  type MenuPanel,
  type MenuRow,
  filterMenuRows,
  stepFormField,
  stepFormValue,
  stepMenuRow,
} from "./menu";
import {
  SETTING_SHORTCUTS,
  type SettingDef,
  type SettingShortcut,
  type ViewSettings,
  defaultViewSettings,
  filterSettings,
  filterShortcuts,
  setSettingValue,
  settingDefs,
  settingOptions,
  settingValue,
  stepSetting,
} from "./settings";
import type { AddProviderResult } from "../providers/services";
import {
  addToHistory,
  createHistoryItem,
  decodeImagePreview,
  formatTextPreview,
  loadSavedClipboardHistory,
  saveClipboardHistory,
  type ClipboardHistoryItem,
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
import { SKILLS_HEADING, brainBriefing, projectSlug, readBrain, trashSkill } from "../agent/brain";
import { planFromHistory } from "../agent/tools/plan";
import {
  SubagentRegistry,
  childRunner,
  delegateTool,
  type SubagentRequest,
  type SubagentResult,
  type SubagentState,
} from "../agent/subagent";
import type { SubagentView, Tool } from "../agent/tools/types";
import type { AgentProfile } from "../agents";
import {
  agentNameProblem,
  agentsFile,
  readAgentProfiles,
  removeAgentProfile,
  saveAgentProfile,
} from "../agents";
import type { PlanSnapshot } from "../agent/tools/types";
import type { RouteHealthLine } from "../routes/health";
import { renderUsage, summarizeUsage, totalsLine, turnRecord, type UsageRecord } from "../usage";
import { brainSections } from "../agent/brain";
import { renderContext, summarizeContext } from "../context";
import { applyEvent, entriesFromHistory, entriesToText, liveRate, summarizeArgs, type Entry, type Tone } from "./transcript";
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
  /** ISO timestamp the session was created, so a switch restores its age. */
  createdAt?: string;
  /** ISO timestamp of the last turn, for the picker's trailing note. */
  updatedAt?: string;
  /** Turns in the session, for the picker's trailing note. */
  messageCount?: number;
  /** Model the session used — searched, and restored on a switch. */
  model?: string;
  /** The endpoint that model was reached on, so restoring it points the same way. */
  baseUrl?: string;
  /** Session mode at its last save, so a switch (or a restart) restores it. */
  mode?: SessionMode;
  /** Reasoning variant at its last save, restored the same way. */
  variant?: string;
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
/**
 * A moment, as `DD-MM-YYYY HH:mm`, on the local clock.
 *
 * Written out rather than handed to `Intl`: a locale picks its own field order
 * and its own separators, and there is one shape this app is read in. **Local**
 * rather than UTC is the part that matters — the stamp is *stored* in UTC, and
 * printing that back is how a session started at 18:52 reads as 15:52, or as
 * the day before for half the world.
 */
function formatStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const day = `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The same shape without the clock, for a column with no room for one. */
function formatDay(date: Date): string {
  return formatStamp(date).slice(0, 10);
}

/** A stored stamp rendered for a person, or the raw value when it will not parse. */
function formatStored(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : formatStamp(parsed);
}

/** One line out of a longer piece of text, for a notice that names what happened. */
function snippet(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** How much of a memory file `/memory` prints before it points at `full`. */
const MEMORY_PREVIEW_CHARS = 900;

/**
 * A long block trimmed to fit a screen, naming what it dropped.
 *
 * A silent cut is worse than no output: the reader cannot tell a memory that
 * ends from one that was truncated on their behalf.
 */
function clipped(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n… ${text.length - max} more characters not shown`;
}

/**
 * Only the memory half of a brain briefing.
 *
 * The two halves are separated by a heading the briefing writes itself, which
 * is a pleasanter thing to cut on than a line count. If that heading is ever
 * missing the whole briefing is shown, which is a wrong answer you can read
 * rather than half of one you cannot.
 */
function memorySection(briefing: string | null): string | null {
  if (!briefing) return null;
  const at = briefing.indexOf(SKILLS_HEADING);
  const memory = at === -1 ? briefing : briefing.slice(0, at);
  // The briefing's preamble is about the briefing — "this is not the user's
  // request", and so on. What was asked for is the memory, which is the part
  // under its own heading. With no heading there is nothing to cut on, so the
  // whole thing is shown: a wrong answer you can read beats half of one.
  const heading = /^## This project's memory.*$/m.exec(memory);
  const body = (heading ? memory.slice(heading.index + heading[0].length) : memory).trim();
  return body || null;
}

/** Local midnight, to count whole days by rather than elapsed hours. */
function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function formatSessionDate(iso: string): string | null {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  const then = new Date(time);
  // Whole days between two *local* midnights. Dividing a millisecond gap by 24
  // hours instead calls a session from 11pm "2d ago" at breakfast, and counts
  // in UTC rather than where the user is — so a session started last night read
  // as the day before for anyone east of Greenwich. Rounding is what keeps it
  // right across a daylight-saving change, where a local day is 23 or 25 hours.
  const diffDays = Math.round((startOfLocalDay(new Date()) - startOfLocalDay(then)) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDay(then);
}

/** Groups sessions by calendar date: Today, Yesterday, Previous 7 Days, Previous 30 Days, Month Year. */
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
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const startOf7Days = startOfToday - 6 * 86_400_000;
  const startOf30Days = startOfToday - 29 * 86_400_000;
  const t = date.getTime();

  if (t >= startOfToday) return "Today";
  if (t >= startOfYesterday) return "Yesterday";
  if (t >= startOf7Days) return "Previous 7 Days";
  if (t >= startOf30Days) return "Previous 30 Days";

  // The month and the year, in their language and their order — a hardcoded
  // English list is the one part of a date that cannot be read at a glance by
  // someone whose system is not English.
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
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
  /**
   * Tools this session adds on top of the defaults — the `delegate` tool, when
   * delegation is on.
   *
   * Passed rather than built in `run.ts` because the tool carries the app's live
   * child registry, and the run that builds agents has never heard of the app.
   */
  extraTools?: Tool[];
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
  /** Whether a finished turn runs the automatic learning pass. `auto` unless `off`. */
  learning?: "off" | "auto";
  /**
   * Session mode to start on, from a session being resumed. Defaults to build.
   *
   * An option rather than a constant because the mode is session state: a run
   * that resumes a plan-mode conversation should open in plan mode.
   */
  mode?: SessionMode;
  /** Reasoning variant to start on, from a resumed session. Defaults per model. */
  variant?: string;
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
    /** The session's own model and endpoint, so a later switch restores them. */
    model?: string;
    baseUrl?: string;
    /** The session's own mode and variant, restored with the rest. */
    mode?: SessionMode;
    variant?: string;
  }) => Promise<void>;
  /**
   * Remembers which tab is in front for a directory, so a restart with
   * `--continue` returns to it rather than to the newest session. Absent in
   * preview renders and in tests that do not care; every call is best-effort.
   */
  saveActiveSession?: (cwd: string, id: string) => Promise<void>;
  /** Forgets the remembered tab, but only when it names `id`. */
  clearActiveSession?: (cwd: string, id: string) => Promise<void>;
  newSessionId: () => string;
  initial: { id: string; createdAt: string; messages?: ChatMessage[] };
  /** Connected MCP servers, shown on the home screen. */
  mcp?: string | null;
  /** Config files that were read, shown on the home screen. */
  config?: string | null;
  /**
   * A line shown when the session opens, for something that could not be fixed
   * on the way in — a missing key, say, which `/connect` and `/key` fix from
   * inside this screen. Shown as a warning, once.
   */
  notice?: string | null;
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
  /**
   * Remembers a key for this session and returns the environment variable that
   * would make it permanent, so the note can name it. The value is never
   * written to a file (`settings-write.ts` has no field for one).
   */
  saveApiKey?: (apiKey: string, baseUrl?: string) => Promise<string | undefined>;
  /** The services `/connect` can add, and what adding one does. */
  connect?: {
    list: () => Promise<MenuRow[]>;
    add: (name: string, apiKey?: string) => Promise<AddProviderResult>;
  };
  /**
   * Whether child agents may be spawned, and on what.
   *
   * Absent means delegation is off and the `delegate` tool is never registered:
   * a tool the model can see but cannot use costs it a wasted turn every time it
   * reaches for one.
   */
  delegation?: {
    enabled: boolean;
    /** Model every child runs on. Empty means the parent's own. */
    model: string;
    /**
     * The named subagents this session may choose from, for the tool description
     * and the `/agents` editor. Read once at startup.
     */
    profiles?: AgentProfile[];
    maxConcurrent: number;
    maxPerTurn: number;
    maxIterations: number;
    /** Idle time before a child counts as wedged, and is stopped. */
    staleMs: number;
    /** The same, while the child is inside a tool — where silence is legitimate. */
    staleToolMs: number;
  };
  /**
   * Builds the agent a delegated task runs in.
   *
   * Injected rather than built here, because a child needs the same provider,
   * config and session id the parent was built with — and because a test has no
   * gateway to talk to. The `model` passed in is already resolved.
   */
  createSubagent?: (input: {
    goal: string;
    context: string;
    model: string;
    maxTurns: number;
    /** Already resolved from the chosen profile's permissions. */
    tools: readonly string[];
    /** Already assembled: the profile's specialisation plus the standing rules. */
    instructions: string;
    signal: AbortSignal;
  }) => Agent;
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
  /**
   * Machine-wide usage tracking: counts per finished turn, filed locally.
   *
   * Absent when nothing is recording it: a preview render, or a test. `/usage`
   * then says so rather than showing a state it does not have, and `/stats`
   * stays session-scoped.
   */
  usage?: {
    /** Files one finished turn's numbers to the machine-wide log. */
    record: (record: UsageRecord) => Promise<void>;
    /** Reads the machine-wide log for `/usage` and `/stats`. */
    history: () => Promise<UsageRecord[]>;
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
/**
 * Commands that run even while a turn is in flight.
 *
 * A message typed during a turn is queued behind it, which is right for words
 * the model should read. It is wrong for a command that only reports or lists:
 * the queue is non-empty only while a turn runs, so putting `/queue` itself
 * behind that turn would make it unreachable at the one moment it is useful.
 */
const RUNS_WHILE_BUSY = new Set(["/queue"]);
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

/**
 * A session the user has moved away from.
 *
 * Everything a turn writes to, plus the agent that runs it — held together so
 * the session can keep working while another is on screen. The arrays inside
 * are shared by reference with the live fields at park time, never copied, so a
 * turn already running goes on appending to the very transcript the user will
 * find on return.
 */
type ParkedSession = {
  agent: Agent;
  entries: Entry[];
  plan: PlanSnapshot | null;
  busy: string | null;
  queuedPrompts: Array<{ prompt: string; images: PastedImage[] }>;
  steering: Array<{ prompt: string; images: PastedImage[] }>;
  recovery: { title: string; body: string; prompt: string; images: PastedImage[] } | null;
  createdAt: string;
  title: string | null;
  isPaused: boolean;
  /** True between Ctrl+C and that session's turn actually ending. */
  stopping: boolean;
  /**
   * The session's own settings: which model it runs, on which endpoint, in
   * which directory, and in which mode and variant.
   *
   * These were shared across every session, so `/models` or `/cd` in one tab
   * silently changed all of them — the exact thing a per-session setting is for.
   * A turn already running keeps the agent it was built with, so its own model
   * was always right; what was wrong is a *new* turn, which is built from these.
   */
  model: string;
  baseUrl: string;
  cwd: string;
  mode: SessionMode;
  variant: string;
};

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
  /**
   * Sessions with a `/goal` run in flight.
   *
   * A set rather than a flag because a goal belongs to the session that started
   * it. A flag would label whichever session is on screen "Goal", suppress that
   * session's recovery card, and — because only the on-screen branch cleared it
   * — stay stuck on forever once a goal session was backgrounded.
   */
  private goals = new Set<string>();
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
  /** Selected provider filter for the /models picker (null = all providers). */
  private selectedModelProvider: string | null = null;
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
  /** Reasoning variant in use; per session, and settable with `/variants`. */
  private variant: string;
  /** Shift+Tab switches it; the agent is rebuilt because the mode is read then. */
  private mode: SessionMode;
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
    tabs?: {
      labels: readonly string[];
      active: number;
      rows: (active: number) => readonly PickItem[];
      onTabClick?: (index: number) => boolean | void;
    };
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
    /**
     * Marks the queue list, so an action changing the queue rebuilds the rows it
     * was handed. It is the one list here that acts *on* its own data rather
     * than choosing from it, and a stale row is how a stale index is acted on.
     */
    queue?: true;
  } | null = null;

  private busy: string | null = null;
  /** True between Ctrl+C and the turn actually ending, so the key cannot double-cancel. */
  private stopping = false;
  /**
   * Tools the user has answered "always" for in this run.
   *
   * Kept on the app rather than in the agent because the agent is rebuilt for
   * every model switch, `/cd`, session switch and mode change — which is what
   * made "always" mean "until something unrelated happens". Per run, not per
   * session: the answer is about the tool, and being asked again by a tab you
   * just opened is the annoyance it exists to remove.
   */
  private approvedTools = new Set<string>();
  /**
   * The turns in flight, one per session.
   *
   * A turn belongs to the session that started it, and it keeps running when
   * the user moves to another session: the switch parks the session it writes
   * into rather than waiting for it. A promise per session, because a turn in a
   * background session and the one on screen are both live at once.
   */
  private running = new Map<string, Promise<void>>();
  /**
   * Sessions the user has left, each with the state a turn keeps writing to.
   *
   * A session with nothing running is parked too, so coming back is instant and
   * exact — but the reason this map exists is the running turn: parking is what
   * lets it finish after the user has moved on.
   */
  private parked = new Map<string, ParkedSession>();
  private spinnerFrame = 0;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private scroll = 0;
  private notice: Span | null = null;
  /**
   * The launch config notice (usually "no key") held back from a fresh
   * session's transcript: with any entry at all the home screen gives way to a
   * page carrying only the warning, so on an empty session it waits for the
   * first chat send instead. Cleared once shown, or once a credential is
   * established through the UI.
   */
  private deferredNotice: string | null = null;
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
  /** Recent clipboard items (last 5 text or images) saved across sessions. */
  private clipboardHistory: ClipboardHistoryItem[] = [];
  /** Timestamp of last right-click to ignore terminal's automatic paste. */
  private lastRightClickTime = 0;
  /** Whether model execution or session is currently paused. */
  private isPaused = false;
  /** Whether a finished turn runs the learning pass (see `learnAfterTurn`). */
  private learning: "off" | "auto" = "auto";
  /** True while a learning pass is running, so turns do not stack requests. */
  private learningInFlight = false;
  /** Queued prompts to execute in sequence when active turn finishes. */
  private queuedPrompts: Array<{ prompt: string; images: PastedImage[] }> = [];
  /**
   * Messages handed to the running turn that the model has not read yet.
   *
   * Held here as well as in the agent for two reasons: the spinner can say the
   * wait is accounted for, and words added to a turn that then dies are put back
   * in the queue rather than vanishing with the tile that carried them.
   */
  private steering: Array<{ prompt: string; images: PastedImage[] }> = [];
  /**
   * The plan tools' latest state, for the TODO chip and its panel.
   *
   * Held here rather than read off the agent because it is the screen's copy:
   * it survives an agent rebuild (a model switch) and is what the last turn
   * left behind, which is exactly what the button should keep showing.
   */
  private plan: PlanSnapshot | null = null;
  /** True while the plan panel is open above the box. */
  private todoPanel = false;
  /** Notice shown when text is copied. */
  private copiedNotice: string | null = null;
  private copiedTimer: NodeJS.Timeout | null = null;
  private paletteSelected = 0;
  /**
   * The child agents this session has running, and the reports they returned.
   *
   * Held on the app rather than read off the loop because the panel outlives
   * the turn that drew it: a finished child's report stays on screen after its
   * row leaves the live list, the way a tab's contents outlive the turn in it.
   */
  private subagents = new SubagentRegistry();
  /**
   * Children spawned this turn, so the per-turn cap is spent honestly.
   *
   * Reset when a turn starts rather than accumulated for the session: the cap is
   * a per-turn promise to the model, and a session-wide counter would have the
   * third turn of a session refused for children the first two spawned.
   */
  private subagentsSpawned = 0;
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
  /** The `delegate` tool for this session, when delegation is on. */
  private delegateTool: Tool | null = null;
  /** `/agents`: the list of defined subagents, with a New row. */
  private agentsMenu: { selected: number } | null = null;
  /** The subagent editor, while it is open. */
  private agentEditor: {
    original: AgentProfile | null;
    name: string;
    description: string;
    instructions: string;
    model: string;
    permissions: "no" | "yes";
    scope: "all projects" | "this project";
    selected: number;
    /** True while the cursor is inside a text field rather than on the list. */
    editing: boolean;
    error: string | null;
  } | null = null;

  /**
   * The subagents in play, as the menu and the tool agree they are.
   *
   * `reloadAgentProfiles` replaces the list on disk and rebuilds the tool
   * around it; this reads the same place, so the two cannot disagree about which
   * agents exist.
   */
  private agentProfiles(): AgentProfile[] {
    return [...(this.options.delegation?.profiles ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  }

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
    this.learning = options.learning === "off" ? "off" : "auto";
    // Session state, so a resumed conversation opens in the mode and variant it
    // was using rather than in the defaults.
    this.mode = options.mode === "plan" ? "plan" : "build";
    this.variant = options.variant ?? DEFAULT_VARIANT;
    this.clipboardHistory = loadSavedClipboardHistory();
    this.delegateTool = this.buildDelegateTool();
  }

  /**
   * The `delegate` tool for this session, or null when delegation is off.
   *
   * Built once here rather than per turn because the tool carries this
   * session's live registry — which children are running right now — and a fresh
   * registry per turn would empty the panel every time the model spoke.
   */
  private buildDelegateTool(): Tool | null {
    const delegation = this.options.delegation;
    if (!delegation?.enabled || !this.options.createSubagent) return null;
    const pin = delegation.model.trim();
    return delegateTool({
      registry: this.subagents,
      // The names go into the tool description, which is the only place the model
      // learns they exist — so a profile the user defined is actually usable.
      profiles: delegation.profiles ?? [],
      settings: {
        model: pin || this.model,
        maxConcurrent: Math.max(1, delegation.maxConcurrent),
        maxPerTurn: Math.max(1, delegation.maxPerTurn),
      },
      spawnCount: () => this.subagentsSpawned,
      spawn: (request) => {
        this.subagentsSpawned += 1;
        return this.runChild(request);
      },
    });
  }

  /**
   * Builds and wires the runner this session's children go through.
   *
   * The runner itself is `childRunner`, shared with the one-shot `--print` path:
   * a child must be built, watched and reported identically whichever door it
   * came in by, or one of them quietly loses the staleness cut-off.
   */
  private runChild(request: SubagentRequest): Promise<SubagentResult> {
    const delegation = this.options.delegation!;
    const runner = childRunner({
      create: this.options.createSubagent!,
      registry: this.subagents,
      model: delegation.model.trim() || this.model,
      maxIterations: Math.max(1, delegation.maxIterations),
      limits: {
        staleMs: Math.max(1_000, delegation.staleMs),
        staleToolMs: Math.max(1_000, delegation.staleToolMs),
      },
      // The dock is the reason a child is watched at all: it can run for minutes
      // with the parent's own words silent, so each request that moves it
      // repaints. A row that only filled in at the end would be a receipt.
      onProgress: () => this.draw(),
    });
    return runner(request);
  }
  async start(): Promise<number> {
    setColorEnabled(!process.env.NO_COLOR && this.output.isTTY === true);

    const opening = this.options.initial.messages ?? [];
    this.agent = this.options.createAgent(opening, this.settings());
    // A resumed session's tracked work is in the transcript it just came back
    // with, and in nothing else: the plan tools were built fresh a line ago.
    this.plan = planFromHistory(opening, this.cwd);
    // Warm the `@` index in the background so the first `@` is fast: the
    // walk is what made Tab arrive before the list existed in tests and on
    // large directories. Failures are ignored — the first keystroke rebuilds.
    void this.ensureMentionIndex().catch(() => undefined);
    await this.refreshTabs();

    // The launch config notice is for the first chat, not the home screen: on
    // a fresh session it waits for the first send (see runTurn), so opening
    // the app shows "Where should we begin?" instead of a page carrying only
    // the warning. A resumed session already has a transcript, so it keeps
    // the old behaviour and says it at once.
    if (this.options.notice) {
      if (this.entries.length > 0) this.note(this.options.notice, "warn");
      else this.deferredNotice = this.options.notice;
    }

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
      ENTER_ALT_SCREEN +
        DISABLE_WRAP +
        ENABLE_MOUSE +
        ENABLE_PASTE +
        // So Shift+Enter can be told from Enter. Terminals that do not know it
        // ignore it, and the decoder accepts what they send regardless. Both
        // encodings are asked for — `modifyOtherKeys` for the older terminals,
        // the kitty protocol for Windows Terminal 1.25+, Ghostty and friends —
        // because a terminal answers at most one and ignores the other.
        ENABLE_KEY_MODIFIERS +
        ENABLE_KITTY_KEYS +
        CLEAR_SCREEN +
        CURSOR_HOME +
        HIDE_CURSOR,
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
    // A compaction in flight holds its own controller, not the turn's — stop
    // it too, or its summariser keeps the process alive after the terminal.
    this.compactController?.abort();
    this.compactController = null;
    // Nor should the agent wait forever on a question nobody will answer.
    if (this.askResolver) this.settleAsk();
    // And a turn in flight is stopped, so an abandoned request cannot keep the
    // process alive or repaint a terminal that has already been handed back.
    this.agent?.cancel();
    // A background turn outlives the session on screen, so every parked agent is
    // stopped too — otherwise its request would keep the process alive after
    // the terminal has been handed back.
    for (const state of this.parked.values()) state.agent.cancel();

    this.cleanup();
    this.input.setRawMode?.(false);
    this.input.pause();
    this.output.write(
      DISABLE_KITTY_KEYS +
        DISABLE_KEY_MODIFIERS +
        DISABLE_PASTE +
        DISABLE_MOUSE +
        ENABLE_WRAP +
        SHOW_CURSOR +
        LEAVE_ALT_SCREEN,
    );
    setColorEnabled(true);

    try {
      // A setting stepped moments before quitting is still owed its write:
      // the panel saves behind, so flush what it queued before the session.
      await this.flushViewSave();
      await this.save();
      // A background session's answer is still worth keeping even though the
      // user never went back to look at it.
      for (const [id, state] of this.parked) {
        await this.saveParked(id, state).catch(() => undefined);
      }
      // The tab in front is where the next `--continue` resumes. Skipped for
      // a front session that was never saved: there is no file to resume, and
      // the pointer must keep naming one that exists.
      if (this.agent.turns.length > 0 && !this.deletedSessions.has(this.sessionId)) {
        await this.options.saveActiveSession?.(this.cwd, this.sessionId).catch(() => undefined);
      }
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
      // Alt+U opens the usage card — the keyboard way to reach what `[USAGE]`
      // does by mouse. Alt owns no editing job, so unlike a plain `u` (which
      // would eat the first letter of every word starting with one) or
      // ctrl+u (which clears the line) it collides with nothing. Covered
      // panels keep their keys: this only fires when nothing owns the screen.
      if (key.type === "alt" && key.key.toLowerCase() === "u") {
        if (!this.coveredBy() && !this.modal && !this.paletteOpen() && !this.mention && !this.clipboardMenu) {
          this.modal = this.usageModal();
          this.draw();
        }
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
      // The subagent editor claims the screen while it is open, except for the
      // two keys that must always work — Ctrl+C and Ctrl+L.
      if (this.agentEditor && (await this.handleAgentFormKey(key))) {
        this.draw();
        continue;
      }
      if (this.agentsMenu && (await this.handleAgentsMenuKey(key))) {
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
            if (this.compactController) this.compactController.abort();
            else if (this.busy !== null && !this.stopping) this.cancelTurn();
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
        case "newline":
          // Shift+Enter (or Alt+Enter). The whole point is that it does not
          // submit — the box grows a line instead (ADR-020).
          this.editor.insertNewline();
          this.notice = null;
          break;
        case "enter":
          await this.submit();
          break;
        case "paste": {
          // An empty bracketed paste carries nothing to insert — but some
          // terminals forward the keystroke even when they had no text for it.
          // The case that matters is Ctrl+V with an image on the clipboard,
          // which has no text form: the terminal pastes nothing, and without
          // this the key silently dies. So an empty paste reads the clipboard
          // itself — an image attaches, text inserts, and an empty clipboard
          // stays silent rather than reporting an action nobody took.
          if (key.text.trim() === "" && this.options.readClipboard) {
            await this.pasteFromClipboard({ silentEmpty: true });
            break;
          }
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
          // Escape closes the most recent thing that was opened. An informational
          // card (session usage) has no decision to resolve, so it is cleared
          // here rather than by `answerModal`, which owns the approval prompts.
          if (this.modal && !this.pending) {
            this.modal = null;
            this.draw();
            break;
          }
          // The plan panel is below every card and above the session, so it
          // goes next.
          if (this.todoPanel) {
            this.todoPanel = false;
            this.draw();
          }
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
    if (next) this.runQueued(next);
  }

  /**
   * Runs one message off the queue.
   *
   * A queued line that starts with a slash is a command, not words for the
   * model: a `/goal …` typed while a turn was running must start a goal when
   * its turn arrives, not be handed to the model as prose to read out. Anything
   * else is an ordinary turn.
   */
  private runQueued(entry: { prompt: string; images: readonly PastedImage[] }, sessionId = this.sessionId): void {
    if (entry.prompt.startsWith("/")) {
      // A command needs the screen it acts on. One left in a background session
      // waits there rather than running against another transcript.
      if (!this.isCurrent(sessionId)) {
        this.parkedState(sessionId).queuedPrompts.unshift({ prompt: entry.prompt, images: [...entry.images] });
        this.notifyBackground(`${this.sessionLabel(sessionId)} — a queued command is waiting for you`);
        return;
      }
      void this.command(entry.prompt);
      return;
    }
    void this.runTurn(entry.prompt, entry.images, sessionId);
  }

  /**
   * Drops one message from the queue, by the tile's `[x]`.
   *
   * Only the tile it was pressed on goes: a queue is often several messages
   * thought out in order, and clearing all of them to fix one is not a queue
   * control, it is a reset.
   */
  private removeQueued(index: number): void {
    if (index < 0 || index >= this.queuedPrompts.length) return;
    this.queuedPrompts.splice(index, 1);
    this.notice = span(`removed queued message (${this.queuedPrompts.length} queued)`, this.styles.dim);
    this.draw();
  }

  /**
   * Hands one queued message to the turn in flight, from the tile's `[Add+]`.
   *
   * A queue is right when the next words can wait; this is for when they
   * cannot — the model is half a step away from the wrong thing, and a
   * correction is worth more now than after the turn. The message is spliced
   * out of the queue first, so it cannot arrive twice: once pushed into the
   * running turn it is part of that turn's transcript, and the queue's own
   * drain would send it again as a brand-new turn.
   *
   * With nothing in flight there is no turn to steer — a queued line can sit
   * there for a while behind a paused session — and "now" is the whole promise
   * of the button, so it is simply run.
   */
  private addQueuedToTurn(index: number): void {
    const entry = this.queuedPrompts[index];
    if (!entry) return;
    this.queuedPrompts.splice(index, 1);

    // A slash line is an instruction to KiCode, not words for the model, so it
    // cannot ride along inside a turn. It keeps its ordinary path instead.
    if (!entry.prompt.startsWith("/") && this.agent.steer(entry.prompt, entry.images)) {
      this.steering.push(entry);
      this.notice = span(`added to the running turn (${this.queuedPrompts.length} queued)`, this.styles.accent);
      this.draw();
      return;
    }

    this.notice = span(`running queued message (${this.queuedPrompts.length} queued)`, this.styles.accent);
    this.runQueued(entry);
  }

  /** The queued messages as list rows, numbered the way the tiles number them. */
  private queueItems(): PickItem[] {
    return this.queuedPrompts.map((entry, index) => {
      const flat = entry.prompt.replace(/\s+/g, " ").trim();
      const images = entry.images.length;
      return {
        label: `${index + 1}. ${flat.length > 68 ? `${flat.slice(0, 67)}…` : flat}`,
        ...(images > 0 ? { description: `${images} image${images === 1 ? "" : "s"} attached` } : {}),
        value: String(index),
      };
    });
  }

  /**
   * The queue, as a list the keyboard can work.
   *
   * A tile's chips are reachable only with a mouse, and a queue is exactly what
   * someone reaches for with their hands on the keys. The two things a tile
   * offers are here — `ctrl+a` adds a message to the turn already running and
   * `ctrl+x` drops it — plus the one a list can offer and a chip cannot: `enter`
   * takes a message back out of the queue and into the box to rewrite it, which
   * is most of the reason to look at a queue you cannot change your mind about.
   *
   * The search field is off, which is what lets the digits pick a row: on a list
   * this short a number is a faster cursor than an arrow key, and there is
   * nothing to search for.
   */
  private openQueue(): void {
    if (this.queuedPrompts.length === 0) {
      this.note("no messages queued in conversation (press enter while a turn runs to queue one)");
      this.draw();
      return;
    }

    this.openPicker(
      `Queued messages (${this.queuedPrompts.length})`,
      this.queueItems(),
      (value) => this.editQueued(Number(value)),
      [
        {
          key: "a",
          hint: ["ctrl+a", "add to turn"],
          close: false,
          run: (item) => {
            if (item) this.addQueuedToTurn(Number(item.value));
            this.refreshQueuePicker();
          },
        },
        {
          key: "x",
          hint: ["ctrl+x", "drop"],
          close: false,
          run: (item) => {
            if (item) this.removeQueued(Number(item.value));
            this.refreshQueuePicker();
          },
        },
      ],
      undefined,
      false,
    );
    if (this.picker) this.picker.queue = true;
  }

  /**
   * Rebuilds the list from the queue it just changed.
   *
   * The rows are a snapshot taken when the list opened, so without this a drop
   * leaves the dropped message on screen and the next action resolves a stale
   * index against a queue it no longer matches.
   */
  private refreshQueuePicker(): void {
    const picker = this.picker;
    if (!picker?.queue) return;

    const items = this.queueItems();
    if (items.length === 0) {
      this.picker = null;
      this.note("the queue is empty");
      this.draw();
      return;
    }

    picker.title = `Queued messages (${items.length})`;
    picker.all = items;
    picker.items = [...items];
    picker.selected = Math.min(picker.selected, items.length - 1);
    this.draw();
  }

  /**
   * Takes a queued message back out of the queue and into the box.
   *
   * `enter` on the list is "give it back", not "run it now": looking at a queued
   * message is usually how you notice it says the wrong thing, and what you want
   * then is the words in front of you where they can be changed. They leave the
   * queue as they arrive, so a message being edited cannot also run behind the
   * edit — its images come back with it for the same reason.
   */
  private editQueued(index: number): void {
    const entry = this.queuedPrompts[index];
    if (!entry) return;
    this.queuedPrompts.splice(index, 1);
    if (entry.images.length > 0) this.attached = [...this.attached, ...entry.images];
    this.editor.setText(entry.prompt, entry.prompt.length);
    this.entries.push({
      kind: "note",
      text: "[taken back from the queue — the words are in the prompt, edit and press enter]",
      tone: "dim",
    });
    this.draw();
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
      tone: "error",
      // One span per line, with the newline in front of every line but the
      // first: a row's spans are glued together, so a gateway message that was
      // written as four lines would otherwise be printed as one run-on row.
      body: failed.body.split("\n").map((line, index) => span(`${index === 0 ? "" : "\n"}${line}`, this.styles.text)),
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
    // "always" is a decision about the tool, not about this one call.
    if (pending && decision === "always") this.approvedTools.add(pending.request.name);

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
    // An "always" is for the mode it was given in: the build notice promises
    // approval is needed again, and a plan-mode refusal must never be bypassed
    // by a build-mode yes. The agent is rebuilt below, which clears its own
    // approvals — but the app-level shortcut above it would otherwise survive.
    this.approvedTools.clear();
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
  private asker(sessionId = this.sessionId): AskFn {
    return (request) => {
      // A question in a background session cannot be shown: it is skipped, and
      // the turn goes on with no answer rather than stalling on a prompt nobody
      // can see.
      if (!this.isCurrent(sessionId)) {
        this.notifyBackground(`${this.sessionLabel(sessionId)} — a question was skipped`);
        return Promise.resolve(
          request.questions.map((question) => ({ header: question.header, answer: "", dismissed: true })),
        );
      }
      return new Promise<AskAnswer[]>((resolve) => {
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
    };
  }

  /** The model's options, plus the UI's own free-text row. */
  private askOptions(question: AskQuestion | undefined): AskOption[] {
    if (!question) return [];
    return [...question.options, { label: FREE_TEXT, description: "Write your own answer instead of choosing." }];
  }

  /**
   * The `/agents` list: a menu of what is defined, plus a New row.
   *
   * Its own handler rather than the settings one because it holds no search
   * field and no `‹/›` — every row here opens something, so the only question a
   * key can answer is "which one".
   */
  private async handleAgentsMenuKey(key: Key): Promise<boolean> {
    const menu = this.agentsMenu;
    if (!menu) return false;
    const rows = this.agentRows();
    switch (key.type) {
      case "up":
      case "down": {
        const last = Math.max(rows.length - 1, 0);
        menu.selected = key.type === "up" ? (menu.selected <= 0 ? last : menu.selected - 1) : menu.selected >= last ? 0 : menu.selected + 1;
        return true;
      }
      case "escape":
        this.agentsMenu = null;
        this.editor.clear();
        return true;
      case "enter":
      case "text": {
        // A digit jumps straight to a row, as it does in every other list here.
        const digit = /^([1-9])$/.exec(key.type === "text" ? key.text.trim() : "");
        const index = digit ? Number(digit[1]) - 1 : menu.selected;
        const row = rows[index];
        if (!row) return true;
        this.openAgentEditor(row.value === "new" ? undefined : row.value);
        return true;
      }
      default:
        // Ctrl+C and Ctrl+L still work; nothing else is meaningful here.
        return false;
    }
  }

  /** The rows `/agents` shows, in one place so the keys and the panel agree. */
  private agentRows(): { value: string; label: string; trailing: string; group: string }[] {
    const agents = this.agentProfiles();
    return [
      ...agents.map((agent) => ({
        value: agent.name,
        label: agent.name,
        trailing: `${agent.permissions === "write" ? "can edit" : "read only"} · ${agent.model || this.model}`,
        group: agent.scope === "project" ? "This project" : "All projects",
      })),
      { value: "new", label: "＋ New agent", trailing: "→", group: "" },
    ];
  }

  /**
   * The subagent editor's keys.
   *
   * Two modes, and which one is running decides what every key means. Inside a
   * text field the editor has the keyboard, because that is what the user is
   * using it for; outside one, the keys act on the field the cursor is on.
   *
   * Escape never discards silently: inside a field it leaves the field, and from
   * the list it closes the form — which is a cancellation, and the form is a
   * scratch pad until Save, so there is nothing to lose.
   */
  private async handleAgentFormKey(key: Key): Promise<boolean> {
    const form = this.agentEditor;
    if (!form) return false;
    const panel = this.agentForm();
    const fields = panel?.fields ?? [];
    const current = fields[Math.min(form.selected, Math.max(fields.length - 1, 0))];

    if (form.editing) {
      // Typing is ordinary typing; escape is the way out, and the editor takes
      // every other key.
      if (key.type === "escape") {
        this.commitAgentField();
        form.editing = false;
        this.editor.clear();
        return true;
      }
      return false;
    }

    switch (key.type) {
      case "up":
      case "down":
        form.selected = stepFormField(fields, form.selected, key.type === "up" ? -1 : 1);
        return true;
      case "left":
      case "right": {
        const delta = key.type === "left" ? -1 : 1;
        if (current?.kind === "toggle" || current?.kind === "choice") {
          const next = stepFormValue(current, delta);
          if (current.key === "permissions") form.permissions = next as "no" | "yes";
          if (current.key === "scope") form.scope = next as "all projects" | "this project";
          form.error = null;
          return true;
        }
        return false;
      }
      case "escape":
        this.agentEditor = null;
        this.editor.clear();
        return true;
      case "enter":
        switch (current?.kind) {
          case "text":
            // Enter opens the field rather than saving, so a value typed by
            // mistake in the name field cannot be committed by one keypress.
            this.editor.clear();
            this.editor.insert(current.value ?? "");
            form.editing = true;
            return true;
          case "toggle":
          case "choice": {
            const next = stepFormValue(current, 1);
            if (current.key === "permissions") form.permissions = next as "no" | "yes";
            if (current.key === "scope") form.scope = next as "all projects" | "this project";
            form.error = null;
            return true;
          }
          case "action":
            if (current.key === "delete") await this.deleteAgentEditor();
            else await this.saveAgentEditor();
            return true;
          default:
            return true;
        }
      case "text": {
        // Typing on the list jumps to the first field and starts editing it:
        // the common case is "open the form and name the thing", and making
        // that three keystrokes would be a tax on every new agent.
        if (current?.kind === "text") {
          this.editor.clear();
          form.editing = true;
          return false;
        }
        const digit = /^([1-9])$/.exec(key.text.trim());
        if (digit) {
          form.selected = Number(digit[1]) - 1;
          return true;
        }
        return true;
      }
      default:
        return false;
    }
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
        // A command that needs an argument is filled in rather than run: a
        // usage line is a dead end, while `/goal ` with the cursor waiting is
        // the next step. The list closes itself, because a space ends the
        // query the palette filters on.
        if (chosen.usage?.startsWith("<")) {
          this.editor.setText(`/${chosen.name} `);
          this.paletteSelected = 0;
          return true;
        }
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
        if (next) this.runQueued(next);
      }
      this.draw();
      return;
    }

    // If a turn is actively running, queue subsequent submitted messages to run in sequence
    if (this.busy !== null) {
      // Except a command that answers about the state rather than changing the
      // turn: a bare `/queue` is about the queue, and the queue only has
      // anything in it while a turn runs — so queueing it would put it out of
      // reach exactly when it is wanted.
      if (RUNS_WHILE_BUSY.has(lower.trim())) {
        this.editor.acceptHistory(prompt);
        this.editor.clear();
        await this.command(prompt);
        return;
      }

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
  private recordClipboardItem(item: ClipboardHistoryItem): void {
    this.clipboardHistory = addToHistory(this.clipboardHistory, item);
    saveClipboardHistory(this.clipboardHistory);
  }

  private async pasteFromClipboard(opts: { silentEmpty?: boolean } = {}): Promise<void> {
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
      // Silent when this ran as the empty-paste fallback: nothing was pasted
      // and nothing was asked for, so a warning would blame the wrong key.
      if (!opts.silentEmpty) this.note("the clipboard is empty — copy text or a screenshot first, then ctrl+v (or alt+v)", "warn");
      this.draw();
      return;
    }

    const historyItem = createHistoryItem(read);
    if (historyItem) this.recordClipboardItem(historyItem);

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
      this.note("no file given — use UPLOAD [+] beside the prompt");
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
      this.picker !== null ||
      this.settingsMenu !== null ||
      this.connectMenu !== null ||
      this.askState !== null ||
      this.agentsMenu !== null ||
      this.agentEditor !== null
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

  /**
   * Runs one turn, in the session it belongs to.
   *
   * `sessionId` defaults to the session on screen, but a queued prompt left in
   * a session the user has moved away from passes its own id — that is what
   * lets a background session keep working. Every piece of state the turn
   * touches is resolved *per event* rather than captured once, because the user
   * may leave the session while the turn is still running, and the answer must
   * land in the session that asked for it either way.
   */
  private async runTurn(prompt: string, images: readonly PastedImage[] = [], sessionId = this.sessionId): Promise<void> {
    // The launch config notice waited for a chat to matter to: the first send
    // on a fresh session says it, right above whatever the turn itself reports.
    // A credential established through the UI clears it first (see enterApiKey
    // and connect), so a fixed key is never followed by a stale warning.
    if (this.deferredNotice) {
      const notice = this.deferredNotice;
      this.deferredNotice = null;
      if (this.isCurrent(sessionId)) this.note(notice, "warn");
      else this.parkedState(sessionId).entries.push({ kind: "note", text: notice, tone: "warn" });
    }
    let settle: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.running.set(sessionId, finished);
    this.setTurnBusy(sessionId, "thinking…");

    // Stamped once, here, because this is the only place that knows when the
    // user's request started — and the per-answer line is about the wait they
    // sat through, not about one request inside the turn.
    const startedAt = Date.now();
    // The per-turn delegation budget starts again with the turn. A session-wide
    // counter would have the third turn of a long session refused for children
    // the first two spawned, which is not what `maxPerTurn` says.
    this.subagentsSpawned = 0;
    // What the spinner's live rate is estimated from: characters streamed so
    // far, and when the first of them arrived. A turn's tool calls reset
    // neither — the speed is the turn's, not the current answer chunk's.
    let streamedChars = 0;
    let streamStart = 0;
    const turn = {
      startedAt,
      mode: this.goals.has(sessionId) ? "Goal" : MODE_LABELS[this.mode],
      model: this.model,
      tps: this.view.tps === "on",
    };

    try {
      for await (const event of this.agentFor(sessionId).send(prompt, images)) {
        const current = this.isCurrent(sessionId);
        // Where this event belongs: on screen, or in the parked session that
        // started the turn and is still working behind the user's back.
        applyEvent(current ? this.entries : this.parkedState(sessionId).entries, event, { at: Date.now(), turn });
        // The plan tools' state as data, so the TODO chip and its panel read a
        // structure rather than parsing the checklist out of rendered text.
        if (event.type === "plan") {
          if (current) this.plan = event.snapshot;
          else this.parkedState(sessionId).plan = event.snapshot;
        }
        // The turn's own cost, filed to the machine-wide log under the
        // endpoint it actually ran on — a background session's model is its
        // own, not the one on screen.
        if (event.type === "done") this.recordTurnUsage(sessionId, event);
        // The words the user added have joined the transcript, so the wait the
        // spinner was describing is over.
        if (event.type === "continued" && event.reason === "steered") {
          (current ? this.steering : this.parkedState(sessionId).steering).splice(0, event.attempt);
        }
        if (event.type === "tool-start") this.setTurnBusy(sessionId, `${event.name}…`);
        else if (event.type === "route-wait") this.setTurnBusy(sessionId, `rate-limited on ${event.from} — waiting ${Math.ceil(event.ms / 1000)}s…`);
        else if (event.type === "tool-result") this.setTurnBusy(sessionId, "thinking…");
        else if (event.type === "text") {
          // The answer is arriving: the spinner names its live speed, when the
          // toggle wants speeds at all. Before the first quarter-second there
          // is no rate worth showing, so the row reads as it always did.
          streamedChars += event.delta.length;
          if (streamStart === 0) streamStart = Date.now();
          const rate = this.view.tps === "on" ? liveRate(streamedChars, Date.now() - streamStart) : null;
          this.setTurnBusy(sessionId, rate ? `thinking… · ${rate}` : "thinking…");
        }
        this.scheduleDraw();
      }
    } catch (error) {
      // A cancelled turn is a decision, not a failure: it says so plainly
      // instead of surfacing the AbortError underneath it.
      const failure = error as Error;
      const cancelled = failure.name === "AbortError";
      if (this.isCurrent(sessionId)) {
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
        if (!cancelled && !this.goals.has(sessionId)) {
          const limited = /rate.limit|429/i.test(failure.message);
          this.recovery = {
            title: limited ? "Rate limited — what now?" : "The turn failed — what now?",
            body: failure.message,
            prompt,
            images: [...images],
          };
          this.modal = this.recoveryModal(this.recovery);
        }
      } else if (!cancelled) {
        // There is no screen for a background failure, so it is said as news
        // rather than raised as a card the user would answer for a session
        // they are not even in.
        this.notifyBackground(`${this.sessionLabel(sessionId)} — turn failed: ${failure.message}`);
      }
    } finally {
      const current = this.isCurrent(sessionId);
      // A goal that ran here is over, whoever ended it and wherever the user is.
      this.goals.delete(sessionId);
      if (current) {
        this.stopBusy();
        // Words added to this turn that never reached a request — it was
        // cancelled, or it failed first. They are the user's, they were never
        // answered, and the tile that carried them is already gone, so they go
        // back to the front of the queue in the order they were added.
        if (this.steering.length > 0) {
          const unread = this.steering.splice(0);
          this.queuedPrompts.unshift(...unread);
          const count = unread.length;
          this.entries.push({
            kind: "note",
            text: `${count} message${count === 1 ? "" : "s"} added to that turn went unread — back in the queue`,
            tone: "warn",
          });
        }
        await this.save().catch(() => undefined);
        this.draw();
        // Off the critical path: the pass exists to help a *future* session, so
        // the user's next message must not wait on it.
        void this.learnAfterTurn(sessionId);
        // A failed turn holding the recovery modal also holds the queue: a turn
        // running behind the question would be a second thing deciding what the
        // screen is doing. The queue moves when the question is answered.
        if (!this.isPaused && !this.recovery && this.queuedPrompts.length > 0) {
          const next = this.queuedPrompts.shift();
          if (next) this.runQueued(next, sessionId);
        }
      } else {
        const state = this.parkedState(sessionId);
        state.busy = null;
        // The turn is over, so the session is no longer mid-cancel either —
        // otherwise a return would look like a Ctrl+C that never landed.
        state.stopping = false;
        if (state.steering.length > 0) {
          const unread = state.steering.splice(0);
          state.queuedPrompts.unshift(...unread);
          const count = unread.length;
          state.entries.push({
            kind: "note",
            text: `${count} message${count === 1 ? "" : "s"} added to that turn went unread — back in the queue`,
            tone: "warn",
          });
        }
        // Saved under its own id: this is what makes the answer still be there
        // when the user comes back to the session that was left running.
        await this.saveParked(sessionId, state).catch(() => undefined);
        this.notifyBackground(`${this.sessionLabel(sessionId)} — turn finished`);
        // The queue was left behind to be worked through, not to wait for a
        // visit, so a background session keeps going on its own — unless it was
        // paused, which stays a pause wherever the user is looking.
        if (!state.isPaused && state.queuedPrompts.length > 0) {
          const next = state.queuedPrompts.shift();
          if (next) this.runQueued(next, sessionId);
        }
      }
      // Settled last, after a queued prompt has had its chance to start, so a
      // waiter that loops sees the next turn rather than a moment of quiet.
      settle();
      if (this.running.get(sessionId) === finished) this.running.delete(sessionId);
    }
  }

  /** True when the session a turn belongs to is the one on screen. */
  private isCurrent(id: string): boolean {
    return this.sessionId === id;
  }

  /** The agent a session runs on, whether it is on screen or parked. */
  private agentFor(id: string): Agent {
    return this.isCurrent(id) ? this.agent : this.parkedState(id).agent;
  }

  /**
   * The parked state for a session, created empty if there is none.
   *
   * A session is parked when the user leaves it, so this is normally a lookup.
   * The empty case only covers a turn that outlived its park record, and is
   * better than dropping its output on the floor.
   */
  private parkedState(id: string): ParkedSession {
    let state = this.parked.get(id);
    if (!state) {
      state = {
        agent: this.agent,
        entries: [],
        plan: null,
        busy: null,
        queuedPrompts: [],
        steering: [],
        recovery: null,
        createdAt: this.createdAt,
        title: this.title,
        isPaused: false,
        stopping: false,
        model: this.model,
        baseUrl: this.baseUrl,
        cwd: this.cwd,
        mode: this.mode,
        variant: this.variant,
      };
      this.parked.set(id, state);
    }
    return state;
  }

  /**
   * Moves the session on screen into the parked map.
   *
   * The arrays are stored by reference, not copied: a turn still running in
   * this session holds those same objects, so it goes on appending to the
   * transcript the user will find when they return, and the plan it updates is
   * the plan that shows.
   */
  private parkCurrent(): void {
    this.parked.set(this.sessionId, {
      agent: this.agent,
      entries: this.entries,
      plan: this.plan,
      busy: this.busy,
      queuedPrompts: this.queuedPrompts,
      steering: this.steering,
      recovery: this.recovery,
      createdAt: this.createdAt,
      title: this.title,
      isPaused: this.isPaused,
      stopping: this.stopping,
      model: this.model,
      baseUrl: this.baseUrl,
      cwd: this.cwd,
      mode: this.mode,
      variant: this.variant,
    });
  }

  /** Pulls a parked session back onto the screen, keeping its running turn. */
  private async unpark(id: string, state: ParkedSession): Promise<void> {
    const movedDirectory = this.cwd !== state.cwd;
    this.sessionId = id;
    this.createdAt = state.createdAt;
    this.title = state.title;
    this.entries = state.entries;
    this.plan = state.plan;
    this.queuedPrompts = state.queuedPrompts;
    this.steering = state.steering;
    this.recovery = state.recovery;
    this.isPaused = state.isPaused;
    this.agent = state.agent;
    // The session's own settings, not whichever session happened to be on
    // screen when it was left. The agent above was built with these, so nothing
    // is rebuilt here — restoring them keeps the screen honest about it.
    this.model = state.model;
    this.baseUrl = state.baseUrl;
    this.cwd = state.cwd;
    this.mode = state.mode;
    this.variant = state.variant;
    this.stopBusy();
    // A turn still running there keeps the spinner going on return.
    if (state.busy) this.setBusy(state.busy);
    // `stopBusy` cleared the flag a moment ago; it belongs to the turn, not to
    // the screen, so the session's own value is put back.
    this.stopping = state.stopping;
    if (movedDirectory) {
      // The directory belongs to the session, and two things are per directory:
      // the `@` index and the tab bar. Both follow it back.
      this.mention = null;
      void this.ensureMentionIndex().catch(() => undefined);
      await this.refreshTabs().catch(() => undefined);
    }
  }

  /** Says something about a background session without taking over the screen. */
  private notifyBackground(text: string): void {
    this.notice = span(text, this.styles.warn);
    this.draw();
  }

  /**
   * A short, readable name for a session in a notice.
   *
   * The parked title is consulted as well as the tab bar, because a tab that
   * was closed (or a session being deleted) has no tab left to name it — and
   * the raw id in a notice reads like an error rather than a name.
   */
  private sessionLabel(id: string): string {
    return this.tabs.find((tab) => tab.id === id)?.title ?? this.parked.get(id)?.title ?? id;
  }

  /** Sets the busy label on whichever side of the screen the turn is on. */
  private setTurnBusy(id: string, label: string): void {
    if (this.isCurrent(id)) this.setBusy(label);
    else this.parkedState(id).busy = label;
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
        // With no turn in flight there is nothing for the queue to drain into,
        // so the message is simply the next turn.
        if (this.busy === null && !this.isPaused) {
          void this.runTurn(argument);
        } else {
          this.queuedPrompts.push({ prompt: argument, images: [] });
          this.entries.push({ kind: "note", text: `[queued in conversation] ${argument}`, tone: "accent" });
          this.notice = span(`pushed into conversation queue (${this.queuedPrompts.length} queued)`, this.styles.accent);
        }
      } else {
        // Bare `/queue` opens the list rather than printing one: every row there
        // can be acted on, and a printout is a dead end you have to retype from.
        this.openQueue();
      }
      this.draw();
      return;
    }

    if (word === "insert") {
      if (!argument) {
        // Fill the box rather than error: a usage line is a dead end, while
        // `/insert ` with the cursor waiting is the next step.
        this.editor.setText("/insert ");
        this.notice = span("type the message to insert, then press enter", this.styles.accent);
      } else if (this.busy === null && !this.isPaused) {
        // Nothing is running, so there is nothing to insert ahead of.
        void this.runTurn(argument);
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

    // A command whose usage is in angle brackets needs an argument. Given
    // none, fill the box and wait rather than error: typing `/goal` and being
    // told the usage is a dead end, while `/goal ` with the cursor waiting is
    // the next step. Square brackets mean the argument is optional and the
    // command runs without it.
    if (!argument && typed.usage?.startsWith("<")) {
      this.editor.setText(`/${typed.name} `);
      this.notice = span(`/${typed.name} needs an argument — type it and press enter`, this.styles.accent);
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
          if (next) this.runQueued(next);
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
        await this.stats();
        break;
      case "usage":
        await this.usage();
        break;
      case "context":
        this.modal = this.contextModal();
        this.draw();
        break;
      case "debug":
        this.notes(this.debugLines());
        break;
      case "agents":
        // `/agents` manages the definitions; `/agents running` watches the
        // children. Two things, one command, and the argument says which —
        // because the roster is worth watching and the editor is worth having,
        // and neither is more important than the other.
        if (argument.trim().toLowerCase() === "running") {
          if (this.subagents.snapshot().length === 0) {
            this.note("no subagents yet — the delegate tool spawns them when a task is broad enough to hand off");
            break;
          }
          this.openSubagentRoster();
          break;
        }
        this.agentsMenu = { selected: 0 };
        this.editor.clear();
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
        this.goals.add(this.sessionId);
        void this.runTurn(goalPrompt);
        break;
      }
      case "variants":
        this.chooseVariant(argument);
        break;
      case "skills":
        await this.skills(argument);
        break;
      case "learn":
        await this.learnNow();
        break;
      case "memory":
        this.showMemory(argument);
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
        this.compact();
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
    return [
      "type / for the palette — ↑↓ choose, enter runs, esc closes",
      "tab switches session · ctrl+w closes a tab · ctrl+p palette · ctrl+v paste text or image · alt+v or /paste when the terminal keeps ctrl+v · ctrl+u clear the line · alt+u usage card · ctrl+c stops a turn, again to quit",
      "click a tab to switch, its × to close, +NEW for a fresh one · the wheel scrolls",
      // Every command, with a description of each, one keystroke away — and the
      // only list of them that stays readable as the count grows. Spelling all
      // of them out here used to cost seven wrapped rows on an 80-column
      // terminal, which is most of a short screen spent on names the palette
      // renders better, and it pushed the keymap above them off the top.
      `${COMMANDS.filter((command) => isAvailable(command) && !command.alias).length} commands — press / or ctrl+p to list them`,
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
   * Files a finished turn's numbers to the machine-wide log.
   *
   * Best-effort and unawaited: a usage line is convenience, and a full disk
   * must not stall a turn that already finished. A turn that cost nothing
   * files nothing — providers that report no usage would otherwise fill the
   * log with zeros.
   */
  private recordTurnUsage(
    sessionId: string,
    done: { model?: string; promptTokens?: number; completionTokens?: number; toolCalls?: number; ms?: number },
  ): void {
    const recordFn = this.options.usage?.record;
    if (!recordFn) return;
    const parked = sessionId === this.sessionId ? null : this.parked.get(sessionId);
    const record = turnRecord({
      model: done.model ?? parked?.model ?? this.model,
      baseUrl: parked?.baseUrl ?? this.baseUrl,
      promptTokens: done.promptTokens ?? 0,
      completionTokens: done.completionTokens ?? 0,
      toolCalls: done.toolCalls ?? 0,
      ms: done.ms ?? 0,
    });
    if (record) void recordFn(record).catch(() => undefined);
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
    // Never the raw stamp: it is stored in UTC and in a machine's shape, so
    // printing it puts the session hours off the clock the user is reading.
    const started = formatStored(this.createdAt);

    return [
      `${this.agent.turns.length} messages · ${this.toolCalls()} tool calls · ${this.entries.length} transcript entries`,
      `~${formatTokens(tokens)} tokens${budget > 0 ? ` (${Math.round((tokens / budget) * 100)}% of ${formatTokens(budget)})` : ""}`,
      budgetLine(this.agent.spentTokens, this.agent.tokenBudget),
      `session started ${started}${Number.isNaN(minutes) ? "" : ` (${minutes} min ago)`}`,
    ];
  }

  /**
   * `/stats` — this session's numbers, plus the machine's when it is recorded.
   *
   * The machine line is best-effort: an unreadable log leaves the session's
   * own numbers standing alone rather than failing the command.
   */
  private async stats(): Promise<void> {
    const lines = this.statsLines();
    if (this.options.usage) {
      const records = await this.options.usage.history().catch((): UsageRecord[] => []);
      const total = summarizeUsage(records).total;
      if (total.turns > 0) lines.push(totalsLine("across sessions", total));
    }
    this.notes(lines);
    this.draw();
  }

  /**
   * `/usage` — the machine-wide rollup: all time, per day, per model.
   *
   * Counts only, read from the local log this machine has been appending to.
   * Capped to recent days and top models so a year of turns does not flood the
   * transcript; `--usage --json` has everything.
   */
  private async usage(): Promise<void> {
    if (!this.options.usage) {
      this.note("usage is not being recorded in this run", "warn");
      this.draw();
      return;
    }
    const records = await this.options.usage.history().catch((): UsageRecord[] => []);
    this.notes(renderUsage(summarizeUsage(records)));
    this.draw();
  }

  /** The `[USAGE]` chip: this session's own numbers, as a card. */
  /**
   * The learning pass, fired after a turn that finished.
   *
   * A second request over the transcript, on the user's own provider, asking
   * what is worth keeping — the half the `remember` tool cannot guarantee,
   * because it depends on the model choosing to call it. Everything it writes
   * goes through the same writers the tool uses.
   *
   * Deliberately quiet: a turn that taught nothing says nothing, and a pass that
   * fails is not the session's problem — the turn it followed already worked.
   */
  private async learnAfterTurn(turnSession: string): Promise<void> {
    if (this.learning === "off" || this.learningInFlight) return;
    if (this.sessionId !== turnSession) return;
    this.learningInFlight = true;
    try {
      const result = await this.agent.learn();
      // The session may have moved on while the pass ran; its news is about a
      // conversation the user is no longer looking at.
      if (result.added.length === 0 || this.sessionId !== turnSession) return;
      const names = result.added.map((item) => item.name).join(", ");
      this.note(`learned ${result.added.length === 1 ? "this" : `${result.added.length} things`}: ${names}`, "dim");
      this.draw();
    } catch {
      // A learning pass that fails is a quiet no-op, never an error card.
    } finally {
      this.learningInFlight = false;
    }
  }

  private usageModal(): Modal {
    const lines = [...this.contextLines(), "", ...this.statsLines()];
    return {
      title: "Session usage",
      body: lines.map((line, index) => span(`${index === 0 ? "" : "\n"}${line}`, this.styles.text)),
      choices: [{ key: "esc", label: "close" }],
      bodyRows: lines.length,
    };
  }

  /**
   * `/context` — the window, broken down the way it is spent.
   *
   * Estimated throughout (four characters to a token): the system prompt
   * alongside its tools, the skill list, this project's memory, and the
   * conversation. The briefing rides inside the system prompt on the wire, so
   * its rows are lifted out of the system row — the rows add up to the whole.
   */
  private contextLines(): string[] {
    const history = this.agent.history ?? [];
    const first = history[0];
    const sections = brainSections(this.cwd);
    return renderContext(
      this.model,
      summarizeContext({
        systemText: first?.role === "system" ? first.content : "",
        toolCount: this.agent.toolCount,
        toolTokens: this.agent.toolSpecTokens,
        ...(sections?.skills ? { skillText: sections.skills.text, skillsLoaded: sections.skills.loaded } : {}),
        ...(sections?.memory ? { memoryText: sections.memory.text, memoryFiles: sections.memory.files } : {}),
        turns: this.agent.turns,
        budget: this.options.contextTokens,
      }),
    );
  }

  private contextModal(): Modal {
    const lines = this.contextLines();
    return {
      title: "Context",
      body: lines.map((line, index) => span(`${index === 0 ? "" : "\n"}${line}`, this.styles.text)),
      choices: [{ key: "esc", label: "close" }],
      bodyRows: lines.length,
    };
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
        this.note(`${def.id} is ${settingValue(this.view, def.id)} — ${def.description}`, "dim");
        this.draw();
        return;
      }
      if (!def.options.includes(value)) {
        this.note(`usage: /settings ${def.id} [${def.options.join("|")}]`, "warn");
        this.draw();
        return;
      }
      await this.applyView(setSettingValue(this.view, def.id, value));
      this.draw();
      return;
    }

    this.settingsMenu = { selected: 0, query: "" };
    this.editor.clear();
    this.draw();
  }

  /**
   * Runs the screen a shortcut row names, after closing settings — one panel
   * at a time, so the target owns the screen rather than stacking over it.
   * Each target is the same call its slash command makes, so the key, the
   * click and the command can never disagree about what "Models" does.
   */
  private async openShortcut(id: string): Promise<void> {
    this.settingsMenu = null;
    this.editor.clear();
    switch (id) {
      case "shortcut:connect":
        await this.command("/connect");
        break;
      case "shortcut:models":
        await this.command("/models");
        break;
      case "shortcut:sessions":
        await this.command("/sessions");
        break;
      case "shortcut:compact":
        await this.command("/compact");
        break;
      case "shortcut:skills":
        await this.command("/skills");
        break;
      case "shortcut:tools":
        this.showTools();
        break;
      case "shortcut:mcp":
        await this.command("/mcps");
        break;
      default:
        this.draw();
        break;
    }
  }

  /**
   * What this session can call, by name with one line each — the count the
   * context card already reports, spelled out. Picking one reads its
   * description back: tools run for the model, and the panel is for looking.
   */
  private showTools(): void {
    // A foreign Agent (a test double) may not carry the list; an empty one
    // notes rather than crashing, the way an empty picker does.
    const tools = this.agent.toolList ?? [];
    this.openPicker(
      `Tools · ${tools.length}`,
      tools.map((tool) => ({ label: tool.name, description: tool.description, value: tool.name })),
      (name) => {
        const tool = tools.find((candidate) => candidate.name === name);
        if (tool) this.notes([`${tool.name} — ${tool.description}`]);
      },
    );
  }

  /**
   * One selectable row of the settings panel: a shortcut out, or a value to
   * step. Shortcuts ride first, in panel order — they are the reason the panel
   * was opened as often as the values are.
   */
  private visibleSettingsRows(): (
    | { kind: "shortcut"; shortcut: SettingShortcut }
    | { kind: "setting"; def: SettingDef }
  )[] {
    const menu = this.settingsMenu;
    if (!menu) return [];
    // Shortcuts ride first, in panel order — they are the reason the panel
    // was opened as often as the values are.
    return [
      ...filterShortcuts(menu.query).map(
        (shortcut): { kind: "shortcut"; shortcut: SettingShortcut } => ({ kind: "shortcut", shortcut }),
      ),
      ...filterSettings(settingDefs(this.view), this.view, menu.query).map(
        (def): { kind: "setting"; def: SettingDef } => ({ kind: "setting", def }),
      ),
    ];
  }

  /**
   * Adopts a set of view settings, repaints, and writes what changed.
   *
   * The write is the point of the panel: a setting that is forgotten when the
   * session ends is a keybinding, not a preference. Whatever the caller could
   * not write is said out loud rather than shown as if it had been kept.
   *
   * The screen moves first and the disk follows: every arrow press used to
   * await a full file write, so holding an arrow queued disk IO behind every
   * step and the panel felt stuck. The value is adopted (and the theme with
   * it) before this returns; the write runs behind and coalesces — ten fast
   * steps land as one write of where they ended.
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

    this.viewSaveQueued = { ...this.viewSaveQueued, ...patch };
    void this.flushViewSave();
  }

  /** Writes whatever `applyView` has queued, one write per burst of steps. */
  private viewSaveQueued: Partial<ViewSettings> | null = null;
  private viewSaveInFlight = false;

  private async flushViewSave(): Promise<void> {
    if (this.viewSaveInFlight || !this.viewSaveQueued) return;
    if (!this.options.saveView) {
      this.viewSaveQueued = null;
      return;
    }
    this.viewSaveInFlight = true;
    try {
      while (this.viewSaveQueued) {
        const patch = this.viewSaveQueued;
        this.viewSaveQueued = null;
        const result = await this.options.saveView(patch).catch((error: unknown) => ({
          ok: false as const,
          file: "",
          reason: (error as Error).message,
        }));
        this.notice = result.ok
          ? span(`${describePatch(patch)} — saved to ${result.file}`, this.styles.dim)
          : span(`${describePatch(patch)} — not saved: ${result.reason ?? "write failed"}`, this.styles.warn);
      }
    } finally {
      this.viewSaveInFlight = false;
    }
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

    const rows = this.visibleSettingsRows();
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
      // A shortcut is a door, not a value — the arrows have nothing to step,
      // so they leave it alone rather than pretending to change something.
      case "left":
      case "right": {
        const row = rows[menu.selected];
        if (!row || row.kind === "shortcut") return true;
        await this.applyView(stepSetting(this.view, row.def.id, key.type === "right" ? 1 : -1));
        return true;
      }
      case "enter": {
        // Enter steps a value forward too, so a row can be changed without the
        // arrows — and it never closes the panel, because one change is rarely
        // the only one. On a shortcut it goes through the door instead, which
        // is the one thing that does close the panel.
        const row = rows[menu.selected];
        if (row?.kind === "shortcut") {
          await this.openShortcut(row.shortcut.id);
          return true;
        }
        if (row) await this.applyView(stepSetting(this.view, row.def.id, 1));
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
    // One custom row: anything not in the catalogue is declared by URL. A key
    // for the endpoint in use is entered with `/key`, not from this list.
    const customRows: MenuRow[] = [
      {
        label: "+ Add Custom Provider / Endpoint",
        value: "__add_custom__",
        group: "Custom",
        trailing: "URL & Key",
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
    // Ready means a key is present, so the launch warning is spent.
    this.deferredNotice = null;
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

  /**
   * The state that belongs to one conversation and must not follow the user
   * into another.
   *
   * `switchSession` swaps the transcript, but the things *about* a session —
   * what is queued behind the running turn, what is attached to the next one,
   * the plan panel, a failed turn waiting on a decision — are held on the app
   * rather than in the session record, so they have to be cleared by hand.
   * Leaving any of them behind is how a message typed for one session ends up
   * running in another.
   */
  private resetSessionState(): void {
    this.queuedPrompts = [];
    // A fresh array, not a cleared one: the old array may be the very one a turn
    // left running in the session being left holds, and sharing it would make
    // this session's count move when that turn reads a message.
    this.steering = [];
    this.plan = null;
    this.recovery = null;
    this.isPaused = false;
    // A turn running in the session being left is not this session's, so its
    // spinner must not keep ticking here.
    this.stopBusy();
    this.resetTransientUi();
  }

  /**
   * The parts of the screen that belong to no session on disk.
   *
   * Cleared on every move between sessions, whether the incoming session is
   * loaded from disk or pulled back out of the parked map — a stray attachment
   * or anchor carried over is how one session's state leaks into another.
   */
  private resetTransientUi(): void {
    this.attached = [];
    this.attachedDocs = [];
    this.todoPanel = false;
    this.pendingRetry = null;
    this.changes = [];
    this.anchor = null;
    this.notice = null;
    this.scroll = 0;
  }

  /** Moves to another session, saving the one being left behind first. */
  private async switchSession(id: string): Promise<void> {
    if (id === this.sessionId) return;

    // The session being left keeps working: it is parked, not waited for. A
    // turn still running there goes on writing into the very objects parked
    // here, which is what makes the turn a *background* one rather than an
    // abandoned one.
    this.parkCurrent();
    await this.save().catch(() => undefined);
    // Explicitly switching to a session re-opens it
    this.closedSessions.delete(id);
    this.deletedSessions.delete(id);

    const parked = this.parked.get(id);
    if (parked) {
      // Already in memory: it comes back exactly as it was left, including a
      // transcript a running turn has been adding to since it was parked.
      this.editor.clear();
      this.resetTransientUi();
      await this.unpark(id, parked);
    } else {
      const messages = await this.options.loadSession(id);
      if (messages === null) {
        this.note(`session ${id} could not be read`, "error");
        return;
      }

      // The record's own title and start time, rather than a fresh `null` and
      // `now`: a session that was renamed has to come back renamed, and its age
      // is part of what `/stats` and `[USAGE]` report. Reading the title here is
      // also what stops `save()` from re-deriving one and overwriting the user's
      // choice on the next turn.
      const summaries = await this.options.listSessions(this.cwd).catch(() => []);
      const record = summaries.find((session) => session.id === id);

      this.sessionId = id;
      this.createdAt = record?.createdAt ?? new Date().toISOString();
      this.title = record?.title ?? null;
      // A session that already exists comes back on the settings it was using,
      // which is what makes them per-session across a restart too. A record with
      // none of them keeps the configured defaults, for a brand new session.
      if (record?.model) this.model = record.model;
      if (record?.baseUrl) this.baseUrl = record.baseUrl;
      if (record?.mode) this.mode = record.mode;
      if (record?.variant) this.variant = record.variant;
      this.editor.clear();
      this.resetTransientUi();
      this.resetSessionState();
      this.entries = entriesFromHistory(messages);
      this.rebuild(messages);
      this.notice = span(`switched session · ${messages.length} messages`, this.styles.dim);
    }

    for (const t of this.tabs) t.current = false;
    const existing = this.tabs.find((t) => t.id === id);
    if (existing) {
      existing.current = true;
      if (this.title) existing.title = this.title;
    } else {
      this.tabs = [
        { id, title: this.title ?? "session", current: true },
        ...this.tabs.filter((t) => !this.closedSessions.has(t.id) && !this.deletedSessions.has(t.id)),
      ];
      if (this.tabs.length > MAX_TABS) {
        this.tabs = this.tabs.slice(0, MAX_TABS);
      }
    }
    this.markActive();
  }

  private async newSession(): Promise<void> {
    // The session being left keeps running: it is parked, not waited for.
    this.parkCurrent();
    await this.save().catch(() => undefined);
    this.sessionId = this.options.newSessionId();
    this.createdAt = new Date().toISOString();
    this.title = null;
    // A new session starts empty in every sense — no queue, no attachments, no
    // plan inherited from the one being left.
    this.resetSessionState();
    this.entries = [];
    this.rebuild([]);
    this.editor.clear();

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
    this.markActive();
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
    // The session being forked from is a session of its own and keeps running:
    // park it before the id moves, so a turn in flight goes on writing into
    // *its* transcript rather than into a state invented after the switch — and
    // with the right agent, since the fork rebuilds `this.agent` a line later.
    this.parkCurrent();
    this.title = `${this.title ?? "session"} (fork)`;
    this.sessionId = this.options.newSessionId();
    this.createdAt = new Date().toISOString();
    this.rebuild(history);
    await this.save().catch(() => undefined);
    await this.refreshTabs();
    this.markActive();
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

    // Sort newest first so date groups appear in clean chronological order
    const sorted = [...others].sort((a, b) => {
      if (a.updatedAt && b.updatedAt) {
        const timeA = Date.parse(a.updatedAt);
        const timeB = Date.parse(b.updatedAt);
        if (!Number.isNaN(timeA) && !Number.isNaN(timeB) && timeA !== timeB) {
          return timeB - timeA;
        }
      }
      return 0;
    });

    this.openPicker(
      "Sessions",
      sorted.map((session) => this.sessionRow(session)),
      (id) => this.switchSession(id),
      [
        {
          hint: ["ctrl+d", "delete"],
          key: "d",
          // Deleting takes the row out of the list rather than closing it: the
          // search that found the session, and the cursor's place among the
          // rest, are both where the work is — and the list is rebuilt from what
          // is left, so the row cannot be deleted twice.
          close: false,
          run: async (item) => {
            if (!item) return;
            await this.deleteSession(item.value);
            const left = (this.picker?.all ?? []).filter((row) => row.value !== item.value);
            if (left.length === 0) {
              this.picker = null;
              this.draw();
              return;
            }
            this.replacePickerItems(left);
            this.draw();
          },
        },
      ],
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
      const historyItem = createHistoryItem({ kind: "text", text, truncated: false });
      if (historyItem) this.recordClipboardItem(historyItem);
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
  /**
   * `/skills delete <name>` — retire a skill.
   *
   * Moves the skill's own folder into the brain's `.trash/` rather than
   * removing it, so a mistaken name is recoverable, and reports where it went.
   * The mention index is dropped afterwards: it holds the skill list for `@`
   * and `/skills`, it is cached for a minute, and every consumer reads it — so
   * without this the skill would still be offered after being retired.
   */
  private async retireSkill(name: string): Promise<void> {
    if (!name) {
      this.note("which skill? — /skills delete <name>, and /skills lists them", "warn");
      this.draw();
      return;
    }

    let index: MentionIndex;
    try {
      index = await this.ensureMentionIndex();
    } catch {
      this.note("could not read the skills directory", "warn");
      this.draw();
      return;
    }

    const found = index.skills.find((skill) => skill.name === name);
    if (!found) {
      this.note(`no skill named "${name}" — /skills lists the ones there are`, "warn");
      this.draw();
      return;
    }
    // Installed skills belong to whoever installed them: retiring one here
    // would fight `npx skills` over a folder it manages.
    if (found.source !== "learned") {
      this.note(`skill:${name} is installed, not learned — remove it where it was installed (${found.file})`, "warn");
      this.draw();
      return;
    }

    const brain = readBrain(this.cwd);
    const dir = brain?.dir;
    if (!dir) {
      this.note("no brain to retire it from", "warn");
      this.draw();
      return;
    }

    try {
      const moved = await trashSkill(dir, found.file);
      this.mentionIndex = null;
      this.mentionIndexAt = 0;
      this.mentionIndexPromise = null;
      this.note(`retired skill:${name} → ${moved}`);
    } catch (error) {
      this.note(`could not retire ${name} — ${(error as Error).message}`, "error");
    }
    this.draw();
  }

  private async skills(argument: string): Promise<void> {
    // `/skills delete <name>` retires one; anything else reads.
    const [verb, ...rest] = argument.trim().split(/\s+/);
    if (verb === "delete") {
      await this.retireSkill(rest.join(" ").trim());
      return;
    }

    let index: MentionIndex;
    try {
      index = await this.ensureMentionIndex();
    } catch {
      this.note("could not read the skills directory", "warn");
      return;
    }
    if (index.skills.length === 0) {
      this.note(
        index.brain
          ? "no skills in this brain yet — a SKILL.md under skills/ is what shows up here"
          : "no skills here — neither the brain nor .agents/skills/ (here or home) has any",
        "warn",
      );
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
      this.notes([`skill:${found.name}${found.source === "installed" ? " (installed)" : ""} — ${found.description}`, body]);
      return;
    }
    this.openPicker(
      `Skills · ${index.skills.length}`,
      index.skills.map((skill) => ({
        label: skill.name,
        description: skill.description,
        value: skill.name,
        trailing: skill.source,
      })),
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

    // Available provider names from groups
    const availableProviders = Array.from(
      new Set(groups.map((g) => g.label).filter((l): l is string => Boolean(l))),
    );

    if (this.selectedModelProvider && !availableProviders.includes(this.selectedModelProvider)) {
      this.selectedModelProvider = null;
    }

    let activeFilter = initialFilter;

    const pass = (id: string, baseUrl?: string, modelMap?: Map<string, { id: string; free?: boolean }>): boolean => {
      const info = (baseUrl ? modelMap?.get(`${baseUrl}#${id}`) : undefined) ?? modelMap?.get(id);
      const free = isFree(id, info);
      return activeFilter === "all" || (activeFilter === "free" ? free : !free);
    };

    const providerMatches = (baseUrl: string, groupLabel?: string): boolean => {
      if (!this.selectedModelProvider) return true;
      if (groupLabel && groupLabel === this.selectedModelProvider) return true;
      const matched = groups.find((g) => g.baseUrl === baseUrl);
      return matched?.label === this.selectedModelProvider;
    };

    /**
     * The rows as they stand right now.
     *
     * A function rather than a value because favouriting a model has to be able
     * to rebuild the list under the user — and doing it here means the rebuild
     * keeps the same group order and the same values as the first build.
     */
    const rows = (filter: ModelFilter): PickItem[] => {
      activeFilter = filter;
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

      // A row is only worth offering if the endpoint it names still serves it.
      const serves = (entry: ModelRef): boolean =>
        groups.some((group) => {
          if (!providerMatches(group.baseUrl, group.label)) return false;
          return group.baseUrl === entry.baseUrl && group.models.some((model) => model.id === entry.model);
        });

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

      const wanted = (entry: ModelRef): boolean =>
        pass(entry.model, entry.baseUrl, modelMap) && providerMatches(entry.baseUrl);

      const recent = this.recentModels.filter((entry) => serves(entry) && wanted(entry));
      recent.forEach((entry, index) => items.push(row(entry, index === 0 ? "Recent" : null)));

      // Favourites sit under Recent so the two shortcuts read as one block at
      // the top. Only the ones this endpoint actually serves are offered: a
      // favourite from another endpoint would be a row that cannot be chosen.
      this.favorites
        .filter((entry) => serves(entry) && wanted(entry))
        .forEach((entry, index) => items.push(row(entry, index === 0 ? "Favorites" : null)));

      for (const group of groups) {
        if (!providerMatches(group.baseUrl, group.label)) continue;

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

        const listed = group.models.filter((model) => pass(model.id, group.baseUrl, modelMap));
        if (listed.length === 0) {
          items.push({ label: `no ${filter} models`, value: "", group: group.label, disabled: true });
          continue;
        }

        listed.forEach((model) => {
          const value = `${group.baseUrl}#${model.id}`;
          choice.set(value, { baseUrl: group.baseUrl, model: model.id });
          const providerSuffix = group.label ? ` (${group.label})` : "";
          items.push({
            label: `${model.id}${providerSuffix}`,
            value,
            current: model.id === this.model && group.baseUrl === this.baseUrl,
            ...(model.description ? { trailing: model.description } : {}),
            group: group.label,
          });
        });
      }

      return items;
    };

    let items = rows(initialFilter);

    // If active provider has no models at all, reset provider filter to show all
    if (!items.some((item) => !item.disabled) && this.selectedModelProvider) {
      this.selectedModelProvider = null;
      items = rows(initialFilter);
    }

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

    const getTabLabels = (): readonly string[] => {
      const providerSuffix = this.selectedModelProvider
        ? `provider: ${this.selectedModelProvider} ▾`
        : "provider: all ▾";
      return ["all", "free", "paid", providerSuffix];
    };

    const extras: PickerExtra[] = [
      {
        hint: ["ctrl+p", "select provider"],
        key: "p",
        close: false,
        run: () => openProviderDropdown(),
      },
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
          this.replacePickerItems(rows(activeFilter));
          this.draw();
        },
      });
    }

    const openProviderDropdown = (): void => {
      const totalCount = groups.reduce((acc, g) => acc + g.models.length, 0);
      const providerOptions: PickItem[] = [
        {
          label: "All Providers",
          value: "__all__",
          current: this.selectedModelProvider === null,
          trailing: `${totalCount} models`,
        },
        ...availableProviders.map((name) => {
          const g = groups.find((grp) => grp.label === name);
          const count = g?.models.length ?? 0;
          return {
            label: name,
            value: name,
            current: this.selectedModelProvider === name,
            trailing: `${count} model${count === 1 ? "" : "s"}`,
          };
        }),
      ];

      this.openPicker(
        "Select Provider",
        providerOptions,
        (chosen) => {
          this.selectedModelProvider = chosen === "__all__" ? null : chosen;
          showModelPicker(activeFilter);
        },
        [
          {
            hint: ["esc", "back to models"],
            key: "escape",
            run: () => {
              showModelPicker(activeFilter);
            },
          },
        ],
        undefined,
        true,
        "center",
        (picked) => {
          if (!picked) showModelPicker(activeFilter);
        },
      );
    };

    const showModelPicker = (currentTier: ModelFilter): void => {
      activeFilter = currentTier;
      const tabLabels = getTabLabels();
      const currentItems = rows(currentTier);

      this.openPicker(
        "Select model",
        currentItems,
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
          labels: tabLabels,
          active: MODEL_FILTERS.indexOf(currentTier) >= 0 ? MODEL_FILTERS.indexOf(currentTier) : 0,
          rows: (active) => {
            if (active < MODEL_FILTERS.length) {
              activeFilter = MODEL_FILTERS[active] ?? "all";
            }
            return rows(activeFilter);
          },
          onTabClick: (index) => {
            if (index === 3) {
              openProviderDropdown();
              return true;
            }
            if (index < MODEL_FILTERS.length) {
              activeFilter = MODEL_FILTERS[index] ?? "all";
            }
            return false;
          },
        },
      );
    };

    showModelPicker(initialFilter);
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
      this.note("this run knows of one endpoint; change it with kicode.json or /connect", "warn");
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

  private compactController: AbortController | null = null;

  private compact(): void {
    if (!this.options.compacting) {
      this.note("compaction is off (--no-compact)");
      this.draw();
      return;
    }
    // Already running: a second `/compact` would summarise the same transcript
    // twice, and the keys stay live so Ctrl+C can stop the first one.
    if (this.compactController) {
      this.note("already compacting — ctrl+c to stop it");
      this.draw();
      return;
    }
    // A turn mutates the transcript the summariser is reading; a `/compact`
    // typed mid-turn waits its turn like any command, it must not race one.
    if (this.busy !== null) {
      this.note("wait for the turn to finish before compacting");
      this.draw();
      return;
    }

    const controller = new AbortController();
    this.compactController = controller;
    this.setBusy("compacting…");
    this.draw();
    void (async () => {
      try {
        const result = await this.agent.compactNow(controller.signal);
        if (controller.signal.aborted) {
          this.note("compaction stopped");
        } else if (result) {
          // The target is named as well as the result: what a session is compacted
          // to is the setting now, and a notice that only said how far it fell would
          // leave the number nobody could check.
          this.note(
            `compacted ${result.summarized} earlier messages · ~${formatTokens(result.before)} → ~${formatTokens(result.after)} tokens (target ~${formatTokens(result.target)})`,
          );
          // The transcript changed, so the run that resumes later must find the
          // compacted one — not the sprawl it replaced. Nothing changed, nothing
          // written: a short session must not gain a file for being looked at.
          await this.save().catch(() => undefined);
        } else {
          // A named compaction now runs whatever the window holds, so this is
          // about the session being too short to be worth shrinking, or the
          // summariser call itself not landing.
          this.note("nothing to compact — this session is already short, or the summariser failed");
        }
      } catch {
        this.note(controller.signal.aborted ? "compaction stopped" : "compaction failed");
      } finally {
        if (this.compactController === controller) this.compactController = null;
        this.stopBusy();
        this.draw();
      }
    })();
  }

  /**
   * The learning pass, asked for by name.
   *
   * The automatic pass is deliberately silent: it runs after a turn and exists
   * to help a *future* session, so it reports only what it actually wrote and
   * never interrupts. Asking for it is the other case — the user is watching and
   * wants the answer — so this one waits, says what landed, and says why when
   * nothing did, which is the half the automatic pass will never tell you.
   *
   * It ignores `"learning": "off"`: that setting is about the pass that runs on
   * its own, not a refusal of one that was requested.
   */
  private async learnNow(): Promise<void> {
    if (this.learningInFlight) {
      this.note("a learning pass is already running");
      this.draw();
      return;
    }
    if (this.agent.turns.length === 0) {
      this.note("nothing to learn from yet — this session has no conversation");
      this.draw();
      return;
    }

    this.learningInFlight = true;
    this.setBusy("learning…");
    this.draw();
    try {
      const result = await this.agent.learn();
      if (result.error) {
        this.note(`the learning pass could not run: ${result.error}`, "warn");
      } else if (result.added.length === 0) {
        this.notes([
          "nothing new in this session to keep",
          ...(result.skipped.length > 0 ? [`${result.skipped.length} thing(s) were already known`] : []),
        ]);
      } else {
        this.notes([
          `learned ${result.added.length} thing(s):`,
          ...result.added.map((item) => `  · ${item.kind} ${item.name} — ${snippet(item.text, 100)}`),
          ...(result.skipped.length > 0 ? [`${result.skipped.length} thing(s) skipped as already known`] : []),
        ]);
      }
    } catch (error) {
      this.note(`the learning pass failed: ${(error as Error).message}`, "error");
    } finally {
      this.learningInFlight = false;
      this.stopBusy();
      this.draw();
    }
  }

  /**
   * What the brain holds for this project, and what the agent is told because
   * of it.
   *
   * The briefing is the honest answer to "what does it know about this?" — it is
   * the exact text assembled into the system prompt at the start of a session,
   * not a description of it. The rest is where that text comes from, which is
   * what you need in order to change it. `/skills` is the other half: this lists
   * what the brain *says*, that one browses what it can *do*.
   */
  private showMemory(argument: string): void {
    const brain = readBrain(this.cwd);
    if (!brain) {
      this.notes([
        "no brain on this machine yet — nothing has been saved, and nowhere it would have gone",
        "the first `remember` creates one at ~/.kicode/brain, or wherever KI_BRAIN_PATH or `brain` in kicode.json points",
      ]);
      this.draw();
      return;
    }

    const slug = projectSlug(this.cwd);
    const mine = brain.projects.find((project) => project.slug === slug);
    const others = brain.projects.filter((project) => project.slug !== slug).map((project) => project.slug);
    const briefing = brainBriefing(this.cwd);

    // `full` prints the briefing whole. Without it the skill list is left out —
    // on a maintained brain it is most of the text, and `/skills` exists to show
    // exactly that and nothing else — and the memory itself is trimmed to fit a
    // screen, because a transcript that scrolls its own answer off the top has
    // told you nothing.
    const full = argument.trim().toLowerCase() === "full";
    const shown = full ? briefing : memorySection(briefing);

    // Every entry costs two rows on screen, so this stays short and carries no
    // blank ones. The reference lines go last rather than first: the newest
    // lines are the ones on screen, and "where is this kept" is what you want
    // once you have read the text, not before it.
    this.notes([
      mine ? `this directory is ${slug} → ${mine.file}` : `this directory is ${slug} — no memory file for it yet`,
      ...(shown
        ? clipped(shown, full ? shown.length : MEMORY_PREVIEW_CHARS).split("\n").filter((line) => line.trim().length > 0)
        : ["nothing saved for this directory yet"]),
      `${brain.dir ? `brain ${brain.dir}` : "no brain — skills below are installed"} · ${brain.skills.length} skill(s) · ${brain.projects.length} project memory file(s)`,
      ...(full ? [] : ["`/memory full` prints the whole briefing, skills included"]),
      ...(others.length > 0 ? [`other projects recorded: ${others.join(", ")}`] : []),
    ]);
    this.draw();
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
    this.markActive();
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

  private openPicker(
    title: string,
    items: readonly PickItem[],
    pick: (value: string) => void | Promise<void>,
    extras?: readonly PickerExtra[],
    tabs?: {
      labels: readonly string[];
      active: number;
      rows: (active: number) => readonly PickItem[];
      onTabClick?: (index: number) => boolean | void;
    },
    searchable = true,
    position?: "center" | "top" | "bottom",
    onClose?: (committed: boolean) => void,
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
      ...(onClose ? { onClose } : {}),
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
      const envName = this.options.saveApiKey
        ? await this.options.saveApiKey(trimmed, targetBaseUrl)
        : undefined;
      // The key works now and is kept for the next runs, so the note names
      // the file it lives in — pasting again overwrites a rotated key, and
      // deleting the file forgets it.
      this.note(
        envName
          ? `saved for ${name} — kept in ${keysFilePath()}, working now and from the next run`
          : `using this key for ${name} now`,
      );
      // A key is now held for this endpoint, so the launch warning about it
      // being missing must not fire on the next send.
      this.deferredNotice = null;
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
        // Only with a key: without one the launch warning still applies.
        if (apiKey) this.deferredNotice = null;
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
        const nextActive = (((picker.tabs.active + step) % count) + count) % count;
        if (picker.tabs.onTabClick && nextActive === 3) {
          const handled = picker.tabs.onTabClick(3);
          if (handled) return true;
        }
        picker.tabs.active = nextActive;
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
        if (this.clipboardMenu.items[this.clipboardMenu.selected]?.label.startsWith("───")) {
          this.clipboardMenu.selected = (this.clipboardMenu.selected + (delta < 0 ? -1 : 1) + len) % len;
        }
        this.updateClipboardMenuPreview();
        return true;
      }
      if (this.picker) {
        this.picker.selected = stepPick(this.picker.items, this.picker.selected, delta < 0 ? -1 : 1);
        this.picker.preview?.(this.picker.items[this.picker.selected]?.value ?? "");
        return true;
      }
      if (this.settingsMenu) {
        const last = Math.max(this.visibleSettingsRows().length - 1, 0);
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
          this.updateClipboardMenuPreview();
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
            // A click (not a drag) on a clipped tool result toggles it expanded
            // in place. Drags keep selecting text: only a press and release in
            // the same cell on the same result row expands, so selecting across
            // a result still copies instead of toggling.
            const resultHit =
              this.selection.from.row === event.y
                ? this.panelRows.find((c) => c.kind === "result" && c.row === event.y)
                : undefined;
            const entry = resultHit ? this.entries[resultHit.index] : undefined;
            this.selection = null;
            if (entry && entry.kind === "result") {
              entry.expanded = !entry.expanded;
              this.draw();
            }
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

    // Picker tab click (all, free, paid, provider)
    const pickerTabHit = this.panelRows.find(
      (c) =>
        c.kind === "picker_tab" &&
        c.row === event.y &&
        (!c.colStart || !c.colEnd || (event.x >= c.colStart && event.x <= c.colEnd)),
    );
    if (pickerTabHit && this.picker?.tabs) {
      if (this.picker.tabs.onTabClick) {
        const handled = this.picker.tabs.onTabClick(pickerTabHit.index);
        if (handled) return true;
      }
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

    // Clicking on the prompt's first text row: the row the mode pill, the
    // badges and the upload button are drawn on. A wrapped prompt's lower rows
    // carry text and nothing else, so a press there is only ever a caret
    // (handled below).
    //
    // Where the two buttons *are* comes from the box itself: the pill is the
    // mode's own word, so its width is not knowable from here — and a second
    // copy of the arithmetic is a second thing to keep in step with the row.
    if (this.promptBox && this.promptBox.rows[0]?.row === event.y) {
      const box = this.promptBox;
      const presses = (control: { colStart: number; colEnd: number }): boolean =>
        event.x >= control.colStart && event.x <= control.colEnd;

      // 1. The mode pill on the row's left edge. The mode is a capability, so
      // changing it is worth a button — shift+tab is no longer the only way.
      if (presses(box.modeButton)) {
        this.toggleMode();
        return true;
      }

      // 2. An attached image's badge takes that image back off, drawn in the
      // badge run just before the box's own text starts.
      if (this.attached.length > 0) {
        let badgeStart = box.textLeft - box.badgeWidth;
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

      // `UPLOAD [+]` at the row's right edge: the platform's file-selection
      // window. It is the only other control the row carries — send has no
      // button of its own (enter sends) and the variant has none either
      // (`/effort` changes it). The clipboard menu it once shared this corner
      // with is on the prompt's right-click.
      if (presses(box.uploadButton)) {
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

    // A queued message's `[Add+]` hands that one message to the turn in flight.
    // Checked before the `[x]` because the two chips sit side by side and their
    // generous hit boxes meet at the space between them.
    const addChip = this.panelRows.find(
      (candidate) =>
        candidate.kind === "queued_add" &&
        candidate.row === event.y &&
        (candidate.colStart === undefined ||
          candidate.colEnd === undefined ||
          (event.x >= candidate.colStart - 1 && event.x <= candidate.colEnd + 1)),
    );
    if (addChip) {
      this.addQueuedToTurn(addChip.index);
      return true;
    }

    // A queued message's `[x]` drops that one message. It is handled before the
    // generic chip search because its kind carries an index the queue needs and
    // the others do not — and before the row fallback, which would otherwise
    // read the tile as a click that sends whatever it says.
    const queuedChip = this.panelRows.find(
      (candidate) =>
        candidate.kind === "queued" &&
        candidate.row === event.y &&
        (candidate.colStart === undefined ||
          candidate.colEnd === undefined ||
          (event.x >= candidate.colStart - 1 && event.x <= candidate.colEnd + 1)),
    );
    if (queuedChip) {
      this.removeQueued(queuedChip.index);
      return true;
    }

    // The `TODO [n/m]` chip on the state row toggles the plan panel open and
    // shut. It is the same press-the-button-opens-the-thing shape the mode pill
    // and the upload button have.
    const todoChip = this.panelRows.find(
      (candidate) =>
        candidate.kind === "todo_button" &&
        candidate.row === event.y &&
        (candidate.colStart === undefined ||
          candidate.colEnd === undefined ||
          (event.x >= candidate.colStart - 1 && event.x <= candidate.colEnd + 1)),
    );
    if (todoChip) {
      this.todoPanel = !this.todoPanel;
      this.draw();
      return true;
    }

    // The `⚙` glyph on the footer's right end opens the settings panel —
    // the mouse way to reach what `/settings` does by name.
    const settingsButton = this.panelRows.find(
      (candidate) =>
        candidate.kind === "settings_button" &&
        candidate.row === event.y &&
        (candidate.colStart === undefined ||
          candidate.colEnd === undefined ||
          (event.x >= candidate.colStart - 1 && event.x <= candidate.colEnd + 1)),
    );
    if (settingsButton) {
      void this.showSettings("");
      return true;
    }

    // The `[USAGE]` chip on the state row opens the context and this session's
    // numbers as one card. A card rather than a transcript note: a note scrolls
    // away and becomes part of the conversation, and the question the button
    // asks is about the session as it stands right now.
    const usageChip = this.panelRows.find(
      (candidate) =>
        candidate.kind === "usage_button" &&
        candidate.row === event.y &&
        (candidate.colStart === undefined ||
          candidate.colEnd === undefined ||
          (event.x >= candidate.colStart - 1 && event.x <= candidate.colEnd + 1)),
    );
    if (usageChip) {
      this.modal = this.usageModal();
      this.draw();
      return true;
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
          (event.x >= candidate.colStart - 1 && event.x <= candidate.colEnd + 1)),
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
      row.kind !== "jump_bottom" &&
      row.kind !== "result"
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

  private updateClipboardMenuPreview(): void {
    if (!this.clipboardMenu) return;
    const selectedItem = this.clipboardMenu.items[this.clipboardMenu.selected];
    if (!selectedItem) return;
    if (selectedItem.value.startsWith("history_")) {
      const idx = Number.parseInt(selectedItem.value.slice("history_".length), 10);
      const hItem = this.clipboardHistory[idx];
      if (hItem && hItem.preview) {
        this.clipboardMenu.preview = hItem.preview;
      }
    }
  }

  /**
   * Opens clipboard options context menu on a right click in the chat area.
   */
  private async openClipboardContextMenu(): Promise<void> {
    this.clipboardMenuOpening = true;
    try {
      const selected = this.selectedText();
      const hasSelection = Boolean(this.selection && selected.trim());
      const hasAttached = this.attached.length > 0;

      if (this.options.readClipboard) {
        try {
          const read = await this.options.readClipboard();
          if (read && read.kind !== "empty") {
            const item = createHistoryItem(read);
            if (item) this.recordClipboardItem(item);
          }
        } catch {
          // ignore error reading clipboard
        }
      }

      const items: PickItem[] = [];
      const historySlice = this.clipboardHistory.slice(0, 5);

      const formatAge = (ts: number): string => {
        const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (diffSec < 60) return "just now";
        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffHr = Math.floor(diffMin / 60);
        if (diffHr < 24) return `${diffHr}h ago`;
        return `${Math.floor(diffHr / 24)}d ago`;
      };

      for (let i = 0; i < historySlice.length; i++) {
        const h = historySlice[i];
        if (!h) continue;
        const num = i + 1;
        const age = formatAge(h.timestamp);
        if (h.kind === "text") {
          const text = h.text ?? "";
          const firstLine = (text.split("\n")[0] || "").trim();
          const snippet = firstLine.length > 28 ? `${firstLine.slice(0, 27)}…` : (firstLine || "empty text");
          const chars = text.length;
          const lines = text.split("\n").length;
          const lineDesc = lines > 1 ? `${lines} lines · ` : "";
          items.push({
            label: `${num}. [TXT] "${snippet}"`,
            value: `history_${i}`,
            description: `${lineDesc}${chars} chars · ${age}`,
          });
        } else if (h.kind === "image" && h.image) {
          const mime = h.image.mime.replace(/^image\//, "").toUpperCase();
          const dims = h.preview?.image?.width && h.preview?.image?.height
            ? `${h.preview.image.width}×${h.preview.image.height} `
            : "";
          const sizeKb = Math.max(Math.round(h.image.bytes / 1024), 1);
          items.push({
            label: `${num}. [IMG] ${dims}${mime} (${sizeKb} KB)`,
            value: `history_${i}`,
            description: `Copied image · ${age}`,
          });
        }
      }

      if (items.length > 0) {
        items.push({
          label: "─── Actions ───",
          value: "divider_actions",
          description: "Quick Actions",
        });
      }

      items.push({
        label: "Paste from Clipboard (Smart)",
        value: "paste",
        description: "Auto-detect text or image",
      });
      items.push({
        label: "Paste Text from Clipboard",
        value: "paste_text",
        description: "Paste clipboard text into editor",
      });
      items.push({
        label: "Paste Image from Clipboard",
        value: "paste_image",
        description: "Attach copied screenshot or image",
      });

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

      let preview: ClipboardMenuState["preview"] = { kind: "empty" };
      const first = historySlice[0];
      if (first?.preview) {
        preview = first.preview;
      }

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
    if (action.startsWith("history_")) {
      const idx = Number.parseInt(action.slice("history_".length), 10);
      const item = this.clipboardHistory[idx];
      if (item) {
        if (item.kind === "text") {
          this.editor.insert(item.text ?? "");
          this.notice = null;
        } else if (item.kind === "image" && item.image) {
          this.attached = [...this.attached, item.image];
          this.notice = span(`attached image ${this.attached.length} · ${Math.max(Math.round(item.image.bytes / 1024), 1)} KB`, this.styles.dim);
        }
        this.draw();
      }
      return;
    }

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
      case "up": {
        cm.selected = (cm.selected - 1 + cm.items.length) % cm.items.length;
        if (cm.items[cm.selected]?.label.startsWith("───")) {
          cm.selected = (cm.selected - 1 + cm.items.length) % cm.items.length;
        }
        this.updateClipboardMenuPreview();
        return true;
      }
      case "down": {
        cm.selected = (cm.selected + 1) % cm.items.length;
        if (cm.items[cm.selected]?.label.startsWith("───")) {
          cm.selected = (cm.selected + 1) % cm.items.length;
        }
        this.updateClipboardMenuPreview();
        return true;
      }
      case "enter": {
        const item = cm.items[cm.selected];
        if (item && !item.label.startsWith("───")) {
          this.clipboardMenu = null;
          await this.executeClipboardAction(item.value);
        }
        return true;
      }
      case "text": {
        const num = Number.parseInt(key.text, 10);
        if (num >= 1 && num <= cm.items.length) {
          const item = cm.items[num - 1];
          if (item && !item.label.startsWith("───")) {
            this.clipboardMenu = null;
            await this.executeClipboardAction(item.value);
          }
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
      const historyItem = createHistoryItem({ kind: "text", text, truncated: false });
      if (historyItem) this.recordClipboardItem(historyItem);
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
      if (this.agentsMenu) this.agentsMenu.selected = hit.index;
    }
    // A click on a form field is a click on a field, and Enter is what a key would
    // do next — so the mouse takes the same road as the cursor. A click on a text
    // field opens it for typing; on a toggle, flips it; on Save, saves.
    if (hit.kind === "form" && this.agentEditor) this.agentEditor.selected = hit.index;
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

    if (this.tabs.length === 0 || id === this.sessionId) {
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
    // A deleted session must not stay the remembered tab: without this the
    // next `--continue` would load a file that is gone and fall back to the
    // newest, which is correct but only by accident.
    void this.options.clearActiveSession?.(this.cwd, id).catch(() => undefined);
    // A deleted session must not keep running: there is no file left for its
    // answer to be written to. The turn in the session on screen holds the live
    // agent, so that is the one to stop; a session already parked holds its own.
    if (id === this.sessionId) this.agent.cancel();
    this.parked.get(id)?.agent.cancel();
    this.tabs = this.tabs.filter((t) => t.id !== id);

    if (this.options.deleteSession) {
      await this.options.deleteSession(id).catch(() => false);
    }

    if (this.tabs.length === 0 || id === this.sessionId) {
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
      model: this.model,
      baseUrl: this.baseUrl,
      mode: this.mode,
      variant: this.variant,
      ...(this.title ? { title: this.title } : {}),
    });
  }

  /**
   * Records the tab in front for this directory, so the next `--continue`
   * resumes it rather than the newest session. Best-effort and unawaited: a
   * pointer is convenience, and a full disk must not stall a tab switch.
   */
  private markActive(): void {
    void this.options.saveActiveSession?.(this.cwd, this.sessionId).catch(() => undefined);
  }

  /**
   * Saves a session the user is not looking at.
   *
   * The same file as `save`, but the agent and the id come from the turn's own
   * session instead of whichever happens to be on screen — which is exactly
   * what keeps a background answer from landing in the wrong transcript.
   */
  private async saveParked(
    id: string,
    state: {
      agent: Agent;
      createdAt: string;
      title: string | null;
      cwd: string;
      model: string;
      baseUrl: string;
      mode: SessionMode;
      variant: string;
    },
  ): Promise<void> {
    if (this.deletedSessions.has(id)) return;
    if (state.agent.turns.length === 0) return;
    await this.options.saveSession({
      id,
      createdAt: state.createdAt,
      cwd: state.cwd,
      messages: state.agent.turns,
      model: state.model,
      baseUrl: state.baseUrl,
      mode: state.mode,
      variant: state.variant,
      ...(state.title ? { title: state.title } : {}),
    });
  }

  // ---- approval ---------------------------------------------------------------

  /**
   * The settings an agent is built with: the channels it reaches the user
   * through, and the session's model, directory and variant.
   */
  private settings(): AgentSettings {
    return {
      // Bound to the session being built, not to whatever is on screen when a
      // callback fires: a background turn must not raise a card against the
      // session the user is actually looking at.
      approve: this.approver(this.sessionId),
      ask: this.asker(this.sessionId),
      model: this.model,
      baseUrl: this.baseUrl,
      cwd: this.cwd,
      variant: this.variant,
      mode: this.mode,
      // Gateways that route per conversation (OpenCode Go's
      // `x-opencode-session`) get the id this transcript is saved under, so
      // every rebuild of the same session keeps the same identity.
      sessionId: this.sessionId,
      ...(this.delegateTool ? { extraTools: [this.delegateTool] } : {}),
    };
  }

  /** A fresh agent over the same transcript, after a setting changed. */
  private rebuild(history: readonly ChatMessage[]): void {
    this.agent = this.options.createAgent([...history], this.settings());
    // The tools came back empty, so the tracked work is read back out of the
    // conversation. Without this the chip kept showing a list the new agent no
    // longer had — the one state where the screen and the model disagreed.
    this.plan = planFromHistory(history, this.cwd);
  }

  private approver(sessionId = this.sessionId): ApproveFn {
    return (request) => {
      // Already answered in this run: asking again is the thing this removes.
      if (this.approvedTools.has(request.name)) return Promise.resolve<ApprovalDecision>("always");

      // A turn in a session the user is not looking at has no screen to put a
      // card on. It is denied, and said so once, rather than hijacking the
      // session that *is* on screen.
      if (!this.isCurrent(sessionId)) {
        this.notifyBackground(`${this.sessionLabel(sessionId)} — ${request.name} needs approval, denied`);
        return Promise.resolve<ApprovalDecision>("deny");
      }

      return new Promise<ApprovalDecision>((resolve) => {
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
    };
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
      const rows = this.visibleSettingsRows();
      const selected = Math.min(Math.max(menu.selected, 0), Math.max(rows.length - 1, 0));
      const current = rows[selected];
      // Sized by the longest description of any row, not the current one: the
      // sentence changes with every row the cursor lands on, so the current
      // one would resize the card on every hover. Measured over the whole
      // list rather than the filtered one, so typing keeps the card still
      // too — and every sentence fits, none truncated.
      const descriptionWidth = Math.max(
        0,
        ...settingDefs(this.view).map((def) => textWidth(def.description)),
        ...SETTING_SHORTCUTS.map((shortcut) => textWidth(shortcut.description)),
      );
      const menuRows: MenuRow[] = [];
      let group = "";
      for (const row of rows) {
        const item: MenuRow =
          row.kind === "shortcut"
            ? { label: row.shortcut.label, value: row.shortcut.id, trailing: "→" }
            : {
                label: row.def.label,
                value: row.def.id,
                trailing: settingValue(this.view, row.def.id),
              };
        const rowGroup = row.kind === "shortcut" ? "Shortcuts" : row.def.group;
        if (rowGroup !== group) {
          item.group = rowGroup;
          group = rowGroup;
        }
        menuRows.push(item);
      }
      return {
        title: "Settings",
        rows: menuRows,
        selected,
        query: menu.query,
        // A shortcut opens rather than changes: naming ‹/› on one would
        // promise a gesture that does nothing there.
        footer:
          current?.kind === "shortcut"
            ? "enter open · ↑↓ move · esc close"
            : "‹/› change · enter value · ↑↓ move · esc close",
        ...(current
          ? {
              description:
                current.kind === "shortcut"
                  ? current.shortcut.description
                  : `${current.def.description}${this.options.saveView ? "" : " (not saved)"}`,
            }
          : {}),
        descriptionWidth,
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

    if (this.agentsMenu) {
      const agents = this.agentProfiles();
      // The rows come from the same place the keys read, so a row the cursor can
      // land on and a row that is drawn cannot drift apart.
      const rows: MenuRow[] = this.agentRows().map((row, index) => ({
        label: row.label,
        value: row.value,
        trailing: row.trailing,
        ...(row.group && row.group !== this.agentRows()[index - 1]?.group ? { group: row.group } : {}),
      }));
      return {
        title: "Subagents",
        rows,
        selected: Math.min(Math.max(this.agentsMenu.selected, 0), Math.max(rows.length - 1, 0)),
        query: "",
        footer: "enter open · ↑↓ move · esc close",
        description: agents.length
          ? "A subagent is a child agent with a name, a job and its own permissions. The model picks one by name when a task fits."
          : "No subagents yet. One is a child agent with a name and a job — the model picks it by name when a task fits.",
      };
    }

    return null;
  }

  /**
   * The subagent editor, as the renderer draws it.
   *
   * The values live on the app rather than in the panel because they are being
   * edited: the panel is what is drawn from them, never where they are kept.
   */
  private agentForm(): FormPanel | null {
    const form = this.agentEditor;
    if (!form) return null;
    const fields: FormField[] = [
      { key: "name", label: "Name", kind: "text", value: form.name, hint: "What the model types to pick it, e.g. cody-git" },
      {
        key: "description",
        label: "For",
        kind: "text",
        value: form.description,
        hint: "One line. This is what the model reads to decide whether it fits.",
      },
      {
        key: "instructions",
        label: "How it works",
        kind: "text",
        value: form.instructions,
        hint: "Put in front of its prompt. Shift+Enter for a new line.",
      },
      {
        key: "model",
        label: "Model",
        kind: "text",
        value: form.model,
        hint: `Empty uses this session's model (${this.model}).`,
      },
      {
        key: "permissions",
        label: "May edit files",
        kind: "toggle",
        value: form.permissions,
        options: ["no", "yes"],
        hint:
          form.permissions === "yes"
            ? "It can write and edit. There is no undo for a confused child."
            : "Read-only: it inspects and reports, and never changes anything.",
      },
      {
        key: "scope",
        label: "Where",
        kind: "toggle",
        value: form.scope,
        options: ["all projects", "this project"],
        hint:
          form.scope === "this project"
            ? `Saved to ${agentsFile("project", this.cwd).replace(this.cwd, ".")} — offered only here.`
            : "Saved to your user directory — offered everywhere.",
      },
      { key: "save", label: "✔ Save", kind: "action", value: "" },
      ...(form.original
        ? [{ key: "delete", label: "✕ Delete", kind: "action" as const, value: "", danger: true }]
        : []),
    ];
    const nameProblem = agentNameProblem(form.name);
    if (form.name && nameProblem) fields[0]!.problem = nameProblem;
    return {
      title: form.original ? `Subagent · ${form.original.name}` : "New subagent",
      subtitle: form.original ? `Created in ${form.original.scope === "project" ? "this project" : "your user directory"}` : undefined,
      fields,
      selected: Math.min(Math.max(form.selected, 0), Math.max(fields.length - 1, 0)),
      editing: form.editing,
      error: form.error,
      footer: form.editing
        ? "enter next line · shift+enter line break · esc done"
        : "enter edit · ‹/› change · ↑↓ move · esc cancel",
    };
  }

  private state(): TuiState {
    return {
      // A tab with a turn running in it is marked, so a session left working in
      // the background is visible from whichever session is on screen.
      tabs: this.tabs.map((tab) => ({ ...tab, busy: this.running.has(tab.id) })),
      hoverTabId: this.hoverTab?.id ?? null,
      hoverClose: this.hoverTab?.close ?? false,
      entries: this.entries,
      editor: this.editor,
      attachedImages: this.attached.length,
      attachedDocs: this.attachedDocs.map((doc) => doc.name),
      // What the spinner says, plus what the user added and the model has not
      // read yet. It is the only sign the message was taken: its tile is gone
      // from the queue, which on its own looks like a deletion.
      busy: this.busy && this.steering.length > 0 ? `${this.busy} · +${this.steering.length} to read` : this.busy,
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
      form: this.agentForm(),
      clipboardMenu: this.clipboardMenu,
      isPaused: this.isPaused,
      queuedCount: this.queuedPrompts.length,
      queue: this.queuedPrompts.map((entry) => entry.prompt),
      plan: this.plan,
      todoPanel: this.todoPanel,
      subagents: this.subagents.snapshot(),
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
      goalActive: this.goals.has(this.sessionId),
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
   * `/agents` — the roster, as a list whose rows are the children's reports.
   *
   * A picker rather than a bespoke panel because it already windows a long list,
   * scrolls with the selection and takes a number key, and a batch of children is
   * exactly the case it was built for. Choosing a row prints that child's report
   * in full: the dock shows that work happened, this is where it is read.
   *
   * Read straight off the registry — the same rows the dock draws — so a count
   * here and a row there cannot disagree.
   */
  /**
   * Opens the editor for a new subagent, or for one that already exists.
   *
   * Editing starts from what is stored rather than from what is on screen, so a
   * half-finished edit escaped away leaves nothing behind and a second visit
   * starts clean.
   */
  private openAgentEditor(name?: string): void {
    const existing = name ? this.agentProfiles().find((agent) => agent.name === name) : undefined;
    this.agentsMenu = null;
    this.editor.clear();
    this.agentEditor = {
      original: existing ?? null,
      name: existing?.name ?? "",
      description: existing?.description ?? "",
      instructions: existing?.instructions ?? "",
      model: existing?.model ?? "",
      // Read-only unless the stored agent says otherwise: the grant is opt-in,
      // and an editor that opened on "yes" would quietly make it the default.
      permissions: existing?.permissions === "write" ? "yes" : "no",
      scope: existing?.scope === "project" ? "this project" : "all projects",
      selected: 0,
      editing: false,
      error: null,
    };
  }

  /** The field the cursor is on, by its key rather than by its position. */
  private agentFieldKey(): string {
    const form = this.agentEditor;
    if (!form) return "";
    return this.agentForm()?.fields[form.selected]?.key ?? "";
  }

  /** Writes the editor's shared buffer into the field it is on. */
  private commitAgentField(): void {
    const form = this.agentEditor;
    if (!form) return;
    const value = this.editor.value;
    // Enter is a newline in this editor, because it is the prompt's editor — but
    // a name, a description and a model id are one line each by definition. Left
    // multi-line they would fail the name check with a message about characters,
    // when the actual mistake was pressing Enter.
    const oneLine = (text: string): string => text.split("\n")[0]?.trim() ?? "";
    switch (this.agentFieldKey()) {
      case "name":
        form.name = oneLine(value);
        break;
      case "description":
        form.description = oneLine(value);
        break;
      case "instructions":
        // The one field that wants paragraphs, and the reason there is a form
        // rather than a prompt line.
        form.instructions = value.trim();
        break;
      case "model":
        form.model = oneLine(value);
        break;
    }
    form.error = null;
  }

  /**
   * Saves the subagent, or explains why it cannot be saved yet.
   *
   * A refused save keeps the form open with its values, because closing it after
   * saying the name is taken would throw away the name just typed along with
   * everything else.
   */
  private async saveAgentEditor(): Promise<void> {
    const form = this.agentEditor;
    if (!form) return;
    this.commitAgentField();
    const name = form.name.trim();
    const problem = agentNameProblem(name);
    if (problem) {
      form.error = `Cannot save: ${problem}.`;
      return;
    }
    const scope = form.scope === "this project" ? "project" : "global";
    const clash = this.agentProfiles().find((agent) => agent.name === name && agent.scope === scope);
    if (clash) {
      form.error = `"${name}" already exists in that scope. Pick another name.`;
      return;
    }
    try {
      await saveAgentProfile(
        {
          name,
          description: form.description.trim(),
          instructions: form.instructions.trim(),
          model: form.model.trim(),
          permissions: form.permissions === "yes" ? "write" : "read",
        },
        scope,
        this.cwd,
      );
    } catch (error) {
      // A failed write must not read as a saved agent: the form stays open with
      // its values and says what went wrong.
      form.error = `Could not save: ${(error as Error).message}`;
      return;
    }
    await this.reloadAgentProfiles();
    this.agentEditor = null;
    this.editor.clear();
    this.agentsMenu = { selected: 0 };
    const saved = this.agentProfiles().find((agent) => agent.name === name);
    this.note(
      `Subagent ${name} · ${saved?.permissions === "write" ? "can edit files" : "read only"} — the model picks it by name.`,
    );
  }

  private async deleteAgentEditor(): Promise<void> {
    const original = this.agentEditor?.original;
    if (!original) return;
    await removeAgentProfile(original.name, original.scope, this.cwd).catch(() => false);
    await this.reloadAgentProfiles();
    this.agentEditor = null;
    this.editor.clear();
    this.agentsMenu = { selected: 0 };
    this.note(`Subagent ${original.name} removed.`);
  }

  /**
   * Re-reads the subagents and rebuilds the delegate tool around them.
   *
   * The tool's description names them, so a saved agent the tool did not know
   * about would be one the model cannot choose — the definition would exist and
   * be unreachable.
   */
  private async reloadAgentProfiles(): Promise<void> {
    const { agents } = await readAgentProfiles(this.cwd);
    const delegation = this.options.delegation;
    if (delegation) this.options.delegation = { ...delegation, profiles: agents };
    this.delegateTool = this.buildDelegateTool();
  }

  private openSubagentRoster(): void {
    const children = this.subagents.snapshot();
    if (children.length === 0) {
      this.note("no subagent reports yet");
      return;
    }
    this.openPicker(`Subagents · ${children.length}`, subagentRows(children), (value) => {
      const child = this.subagents.snapshot().find((entry) => entry.id === value);
      if (!child) return;
      if (child.error) this.notes([`${child.goal} — ${child.model}`, `${child.status}: ${child.error}`]);
      else this.notes([`${child.goal} — ${child.model}`, child.summary || "(it reported nothing)"]);
    });
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
 * The subagent roster: one card row per child, model and elapsed included.
 *
 * Drawn from the same registry the dock is, so a count in the panel and a row
 * in this list cannot disagree — the thing that would make both untrustworthy.
 * Scrolled with the picker's own windowing when a batch outgrows the screen.
 */
function subagentRows(children: readonly SubagentView[]): PickItem[] {
  return children.map((child) => ({
    label: `${child.status === "running" ? "◐" : child.status === "completed" ? "✓" : "✕"} ${child.goal}`,
    description:
      child.error ??
      `${child.model} · ${child.toolCalls} tool${child.toolCalls === 1 ? "" : "s"} · ${
        child.ms >= 1000 ? `${Math.round(child.ms / 1000)}s` : `${child.ms}ms`
      }${child.summary ? ` · ${child.summary.split("\n")[0]}` : ""}`,
    value: child.id,
  }));
}

/** `thinking hide` from a patch, for a notice under the prompt. */
function describePatch(patch: Partial<ViewSettings>): string {
  return Object.entries(patch)
    .map(([key, value]) => {
      // A spacing write carries the whole object (a partial one would drop its
      // siblings on disk), so it is read back out as dotted rows.
      if (key === "spacing" && typeof value === "object" && value !== null) {
        return Object.entries(value)
          .map(([inner, each]) => `spacing.${inner} ${String(each)}`)
          .join(" · ");
      }
      return `${key} ${String(value)}`;
    })
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
