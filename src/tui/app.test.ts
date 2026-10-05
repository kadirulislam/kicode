import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { projectSlug } from "../agent/brain";
import type { LearnResult } from "../agent/learn";
import type { Agent, AgentEvent, ApprovalDecision } from "../agent/loop";
import type { AskAnswer, AskQuestion } from "../agent/ask";
import type { PlanSnapshot, Tool } from "../agent/tools/types";
import type { AgentProfile } from "../agents";
import type { PastedImage } from "../clipboard";
import type { ChatMessage } from "../types";
import { bg } from "./ansi";
import { runTui, terminalSize, type AgentSettings, type ModelRef, type TuiOptions } from "./app";
import type { MenuRow } from "./menu";
import { defaultViewSettings, type ViewSettings } from "./settings";
import { DEFAULT_THEME, buildStyles, themeByName, themeNames } from "./theme";

/**
 * Drives the real TUI with a fake terminal.
 *
 * The app never touches `process.stdin` itself — streams are injected — so the
 * whole loop is testable: keystrokes in, frames out, and the transcript that
 * gets saved.
 */

const strip = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
const tick = (ms = 8): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for the screen to say something, rather than guessing how long it takes.
 *
 * A fixed sleep is a bet on how fast the machine is, and this suite runs fifty
 * files at once: the same `tick(30)` that is generous alone is not enough under
 * load, so a test that passed a moment ago fails on the next run. Polling makes
 * the wait about the thing being waited for. It does not *assert* — the
 * assertion stays in the test, where its failure can say what it expected.
 */
async function until(app: { screen: () => string }, text: string, timeout = 3_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (app.screen().includes(text)) return;
    await tick(10);
  }
}

type Harness = {
  input: PassThrough;
  output: PassThrough;
  options: TuiOptions;
  /** Everything the UI drew, escape codes removed. */
  screen: () => string;
  /** The raw bytes, for asserting on terminal control sequences. */
  raw: () => string;
  /** Only the most recently painted frame, as text. */
  lastFrame: () => string;
  saves: { id: string; messages: ChatMessage[]; cwd?: string; title?: string }[];
  decisions: ApprovalDecision[];
  /** Questions the fake turn put to the user, and what came back. */
  asked: AskQuestion[][];
  replies: AskAnswer[][];
  built: ChatMessage[][];
  /** The settings each rebuilt agent was handed. */
  settings: AgentSettings[];
  /** What `/btw` asked, and how many times `/compact` was called. */
  sideQuestions: string[];
  compactions: number;
  /** The attached images each turn was sent with. */
  sentImages: PastedImage[][];
  /** The prompt text each turn was sent with, after mentions and docs. */
  sentPrompts: string[];
  /** Messages pushed into the turn in flight, by the queue's `[Add+]`. */
  steers: string[];
  /** How many times the learning pass ran, automatic or asked for. */
  learns: number;
  /** How many times a turn was stopped with Ctrl+C. */
  cancels: number;
  /** Every token ceiling `/budget` set, in order. */
  budgets: number[];
  /** Whether a `/compact` that never answers was stopped with Ctrl+C. */
  compactAborted: boolean;
  /** What `/settings` asked to have written down. */
  viewSaves: Partial<ViewSettings>[];
  /** The services `/connect` was told to add. */
  added: string[];
};

/**
 * `approve` makes the fake turn request approval first, `questions` makes it ask
 * the user something, and `slow` (milliseconds) keeps it running — which is how
 * the modal and busy paths get exercised. The delay is spelled out in
 * milliseconds so a test can be comfortably longer than the scheduler jitter
 * when the whole suite is running in parallel.
 */
function harness(
  over: Partial<TuiOptions> = {},
  flags: {
    slow?: number;
    approve?: boolean;
    questions?: AskQuestion[];
    failWith?: Error;
    plan?: PlanSnapshot;
    learn?: LearnResult;
    /** Yield the answer as separate text events with a pause between, like a real stream. */
    streamChunks?: string[];
    /** Make `/compact` hang until its signal aborts, like a summariser gone quiet. */
    compactHang?: boolean;
  } = {},
): Harness {
  const { slow = 0, approve = false, questions, failWith } = flags;
  const input = new PassThrough();
  const output = new PassThrough();
  // A terminal size the layout can be asserted against.
  Object.assign(output, { columns: 80, rows: 24, isTTY: true });

  let seen = "";
  output.on("data", (chunk: Buffer) => {
    seen += chunk.toString("utf8");
  });

  const saves: Harness["saves"] = [];
  const decisions: ApprovalDecision[] = [];
  const asked: AskQuestion[][] = [];
  const replies: AskAnswer[][] = [];
  const built: ChatMessage[][] = [];
  const settings: AgentSettings[] = [];
  const sideQuestions: string[] = [];
  let compactions = 0;
  let compactAborted = false;
  const sentImages: PastedImage[][] = [];
  const sentPrompts: string[] = [];
  const steers: string[] = [];
  let learns = 0;
  let cancels = 0;
  const budgets: number[] = [];
  let spent = 0;
  let tokenBudget = 0;
  /** Set by the fake agent's `cancel()`, to stand in for an aborted request. */
  let stopped = false;

  const makeAgent = (history: ChatMessage[], agentSettings: AgentSettings): Agent => {
    const messages: ChatMessage[] = [...history];
    built.push(history);
    // This agent's own channels, bound when it was built — as in the real app,
    // and the reason a turn left running in one session can never reach the
    // prompt of another. Held per agent, not on the harness, for that reason.
    const approves = agentSettings.approve;
    const asks = agentSettings.ask;

    /** What a real provider does when its request is aborted. */
    const abortIfStopped = (): void => {
      if (!stopped) return;
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      throw error;
    };

    return {
      get turns(): ChatMessage[] {
        return messages;
      },
      get history(): ChatMessage[] {
        return messages;
      },
      get toolCount(): number {
        // The fake offers a fixed set: `/context` costs it out by number.
        return 9;
      },
      get toolList(): { name: string; description: string }[] {
        return [
          { name: "read", description: "Read a file." },
          { name: "bash", description: "Run a command." },
          { name: "ask", description: "Ask the user a question." },
        ];
      },
      get contextTokens(): number {
        return 1000;
      },
      get spentTokens(): number {
        return spent;
      },
      get tokenBudget(): number {
        return tokenBudget;
      },
      setBudget(tokens: number): void {
        tokenBudget = tokens;
        budgets.push(tokens);
      },
      rewind(turns: readonly ChatMessage[]): void {
        messages.splice(0, messages.length, ...turns);
      },
      async compactNow(signal?: AbortSignal): Promise<{ before: number; after: number; summarized: number } | null> {
        compactions += 1;
        // A summariser gone quiet: nothing resolves until the signal aborts,
        // the way the real provider stream ends on Ctrl+C.
        if (flags.compactHang) {
          await new Promise<void>((_, reject) => {
            const onAbort = (): void => {
              compactAborted = true;
              reject(new Error("aborted"));
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          });
          throw new Error("aborted");
        }
        return { before: 1000, after: 400, summarized: 3 };
      },
      async *sideQuestion(text: string): AsyncGenerator<string, void, void> {
        sideQuestions.push(text);
        yield `side: ${text}`;
      },
      cancel(): void {
        cancels += 1;
        stopped = true;
      },
      steer(text: string): boolean {
        steers.push(text);
        messages.push({ role: "user", content: text });
        return !stopped;
      },
      async learn(): Promise<LearnResult> {
        learns += 1;
        return flags.learn ?? { added: [], skipped: [] };
      },
      async *send(prompt: string, images: readonly PastedImage[] = []): AsyncGenerator<AgentEvent> {
        sentImages.push([...images]);
        sentPrompts.push(prompt);
        messages.push({ role: "user", content: prompt });
        // A turn that actually takes a moment, so a second prompt can arrive
        // while it is still running — and so Ctrl+C has something to stop.
        if (slow > 0) await tick(slow);
        if (failWith) throw failWith;
        abortIfStopped();
        if (approve && approves) {
          decisions.push(
            await approves({ id: "1", name: "bash", args: { command: "npm test" }, preview: "+ npm test" }),
          );
        }
        if (questions && asks) {
          asked.push(questions);
          replies.push(await asks({ questions }));
        }
        // A turn stopped while a prompt was up sees it here, the way a real
        // request sees its signal aborted.
        abortIfStopped();
        // A streamed answer arrives in pieces, with time passing between them —
        // the shape a live speed estimate needs, which one instant delta is not.
        // The dwell after the last chunk matters: the spinner paints on its own
        // 90ms tick, so without it the turn is done before any frame carries
        // the rate the last chunk set.
        if (flags.streamChunks) {
          for (const chunk of flags.streamChunks) {
            await tick(400);
            abortIfStopped();
            yield { type: "text", delta: chunk };
            messages.push({ role: "assistant", content: chunk });
          }
          await tick(400);
          abortIfStopped();
        } else {
          yield { type: "text", delta: `echo: ${prompt}` };
          messages.push({ role: "assistant", content: `echo: ${prompt}` });
        }
        // A turn that ran a plan tool hands its state over as data too.
        if (flags.plan) yield { type: "plan", snapshot: flags.plan };
        yield { type: "done", reason: "complete" };
      },
    } as unknown as Agent;
  };

  const viewSaves: Partial<ViewSettings>[] = [];
  const added: string[] = [];

  const options: TuiOptions = {
    cwd: "C:\\dev\\projects\\kicode",
    baseUrl: "https://api.example/v1",
    contextTokens: 128_000,
    version: "0.1.0",
    model: "deepseek-v4-flash:free",
    compacting: true,
    newSessionId: () => "session-new",
    initial: { id: "session-1", createdAt: "2026-09-30T00:00:00.000Z" },
    // The tab bar is a setting; the tests that click it ask for it to be up.
    view: { ...defaultViewSettings(), sidebar: "on" },
    saveView: async (patch) => {
      viewSaves.push(patch);
      return { ok: true, file: "C:\\Users\\me\\.kicode\\kicode.json" };
    },
    connect: {
      list: async (): Promise<MenuRow[]> => [
        { label: "OpenAI", value: "openai", group: "Popular", checked: true, trailing: "key in OPENAI_API_KEY" },
        { label: "Groq", value: "groq", group: "Popular", trailing: "set GROQ_API_KEY" },
      ],
      add: async (name) => {
        added.push(name);
        return {
          ok: true,
          provider: name,
          baseUrl: `https://${name}.example/v1`,
          apiKey: "k",
          apiKeyEnv: "GROQ_API_KEY",
          file: "C:\\Users\\me\\.kicode\\kicode.json",
          ready: true,
        };
      },
    },
    listSessions: async () => [],
    loadSession: async () => null,
    createAgent: (history, agentSettings) => {
      settings.push(agentSettings);
      return makeAgent(history, agentSettings);
    },
    saveSession: async ({ id, messages, cwd, title }) => {
      saves.push({ id, messages, cwd, title });
    },
    streams: {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    },
    ...over,
  };

  const lastFrame = (): string => strip(seen.split("\u001b[H").at(-1) ?? "");

  return {
    input,
    output,
    options,
    screen: () => strip(seen),
    raw: () => seen,
    lastFrame,
    saves,
    decisions,
    asked,
    replies,
    built,
    settings,
    sideQuestions,
    sentImages,
    sentPrompts,
    steers,
    get learns() {
      return learns;
    },
    viewSaves,
    added,
    get cancels() {
      return cancels;
    },
    budgets,
    get compactions() {
      return compactions;
    },
    get compactAborted() {
      return compactAborted;
    },
  };
}

describe("runTui", () => {
  it("draws a turn and saves the transcript", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick();

    app.input.write("hello\r");
    await tick(20);
    app.input.write("/exit\r");

    expect(await done).toBe(0);

    expect(app.screen()).toContain("echo: hello");
    const last = app.saves.at(-1);
    expect(last?.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "echo: hello" },
    ]);
  });

  it("holds the caller's notice for the first chat, so a first run opens on home", async () => {
    // The case this exists for: no key, so `run.ts` opens the UI instead of
    // exiting — the UI is where `/connect` and `/key` are. The warning must
    // not claim the transcript of a fresh session: with any entry at all the
    // home screen gives way to a page carrying only the warning.
    const app = harness({ notice: "No API key found. Add one with /connect, or /key to paste it for this session." });
    const done = runTui(app.options);
    await tick();

    expect(app.screen()).toContain("Where should we begin?");
    expect(app.screen()).not.toContain("No API key found");

    app.input.write("hello\r");
    await tick(20);
    app.input.write("/exit\r");
    expect(await done).toBe(0);

    expect(app.screen()).toContain("No API key found");
    expect(app.screen()).toContain("/connect");
    expect(app.screen()).toContain("echo: hello");
  });

  it("shows the caller's notice at once on a resumed session", async () => {
    const app = harness({
      notice: "No API key found. Add one with /connect, or /key to paste it for this session.",
      initial: {
        id: "session-1",
        createdAt: "2026-09-30T00:00:00.000Z",
        messages: [{ role: "user", content: "earlier" }],
      },
    });
    const done = runTui(app.options);
    await tick();

    // A transcript is already on screen, so there is no home to protect.
    expect(app.screen()).toContain("No API key found");

    app.input.write("/exit\r");
    expect(await done).toBe(0);
  });

  it("takes over the alternate screen and hands it back", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick();
    expect(app.raw()).toContain("\u001b[?1049h");

    app.input.write("\u0003");
    await done;

    // Restoring the screen and the cursor is what keeps the terminal usable.
    expect(app.raw()).toContain("\u001b[?1049l");
    expect(app.raw()).toContain("\u001b[?25h");
    expect(app.screen()).toContain("deepseek-v4-flash:free");
  });

  it("quits on ctrl+c and saves what happened", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick();

    app.input.write("hi\r");
    await tick(20);
    app.input.write("\u0003");

    expect(await done).toBe(0);
    expect(app.saves.at(-1)?.messages).toHaveLength(2);
  });

  it("stops the turn on ctrl+c instead of quitting, and quits on the next press", async () => {
    // Short on purpose, unlike the queue tests: this one waits the turn *out*
    // after cancelling it, and the wait is a fixed `tick(400)` below.
    const app = harness({}, { slow: 300 });
    const done = runTui(app.options);
    await tick();

    app.input.write("a long one\r");
    await tick(30);
    expect(app.screen()).toContain("Agent is Thinking");

    // The first press is about the work, not the window: it stops the turn.
    app.input.write("\u0003");
    await tick(20);
    expect(app.cancels).toBe(1);
    expect(app.screen()).toContain("stopping…");
    expect(app.raw()).not.toContain("\u001b[?1049l");

    await tick(400);
    expect(app.screen()).toContain("stopped — that turn was cancelled");
    // What the turn had done stays: the request was made.
    expect(app.saves.at(-1)?.messages).toEqual([{ role: "user", content: "a long one" }]);

    // Nothing is running now, so the same key means what it always did.
    app.input.write("\u0003");
    expect(await done).toBe(0);
  });

  it("stops the turn from the permission prompt, rather than quitting on it", async () => {
    // The fake turn asks for approval after its `slow` wait, so the wait here is
    // longer than that one.
    const app = harness({}, { approve: true, slow: 150 });
    const done = runTui(app.options);
    await tick();

    app.input.write("run the tests\r");
    await tick(300);
    expect(app.screen()).toContain("bash wants to run");

    app.input.write("\u0003");
    await tick(400);

    // The tool is refused — closing a prompt must never mean yes — and the turn
    // behind it is over.
    expect(app.decisions).toEqual(["deny"]);
    expect(app.screen()).toContain("stopped — that turn was cancelled");

    app.input.write("\u0003");
    expect(await done).toBe(0);
  });

  it("ends when the input stream does", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick();

    app.input.end();

    expect(await done).toBe(0);
  });

  it("shows Goal on the pill while a goal run executes", async () => {
    // A /goal run is not a session mode — shift+tab does not cycle through it —
    // but while it is executing, the box's pill has to say Goal, the way it
    // says Plan.
    const app = harness({}, { slow: 250 });
    const done = runTui(app.options);
    await tick();

    app.input.write("/goal ship it\r");
    await tick(60);
    expect(app.screen()).toContain("[GOAL]");

    // Transient: the run is over, so the pill is the session's own mode again.
    await tick(400);
    const lines = app.lastFrame().split(/\r?\n/);
    // The goal card may still be in the transcript, so the check is on the box
    // itself: the row under the transcript, which is the one the pill rides.
    expect(lines.filter((line) => line.includes("[GOAL]")).length).toBe(0);
    expect(lines.filter((line) => line.includes("[BUILD]")).length).toBe(1);

    app.input.write("\u0003");
    expect(await done).toBe(0);
  }, 15000);

  it("highlights a live mouse drag with the accent selection fill", async () => {
    // A regression guard for a bug the frame tests could not see: the drag
    // highlight was fully implemented in the renderer, but the app never handed
    // its selection to the frame, so nothing ever ran. The fill must reach the
    // real screen, and inverse video must not come back as a fallback.
    const app = harness();
    const done = runTui(app.options);
    await tick(15);

    const press = (col: number, row: number): string => `\u001b[<0;${col};${row}M`;
    const drag = (col: number, row: number): string => `\u001b[<32;${col};${row}M`;
    const release = (col: number, row: number): string => `\u001b[<0;${col};${row}m`;

    // The drag crosses several rows — art, taglines — so one blank layout row
    // cannot make the assertion pass by accident.
    app.input.write(press(4, 4));
    await tick(20);
    app.input.write(drag(40, 14));
    await tick(20);
    app.input.write(release(40, 14));
    await tick(20);

    // The app's own theme, not the test file's default: the fill is theme-coloured.
    const fill = buildStyles(themeByName(DEFAULT_THEME)).selection;
    expect(fill).not.toBe("");
    // `screen()`/`lastFrame()` strip escape codes — the fill IS an escape code —
    // so this assertion has to read the raw bytes.
    const rawLast = app.raw().split("\u001b[H").at(-1) ?? "";
    expect(rawLast).toContain(fill);
    for (const row of rawLast.split("\r\n")) expect(row).not.toContain("\u001b[7m");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("opens the settings panel from the footer \u2699 glyph", async () => {
    const app = harness({});
    const done = runTui(app.options);
    await tick(20);

    // The glyph trails the footer's last row past the usage, so the press
    // way a mouse would — the mouse way to reach what `/settings` does.
    const lines = app.lastFrame().split(/\r?\n/);
    const row = lines.findIndex((line) => line.includes("\u2699"));
    expect(row).toBeGreaterThanOrEqual(0);
    const col = (lines[row] ?? "").indexOf("\u2699") + 1;
    app.input.write(clickAt(row + 1, col));
    await tick(40);

    expect(app.lastFrame()).toContain("Settings");

    app.input.write("\u001b");
    await tick(120);
    expect(app.lastFrame()).not.toContain("‹/› change");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("opens the usage card on alt+u, and ctrl+u still clears a line", async () => {
    const app = harness({});
    const done = runTui(app.options);
    await tick();

    // The keystroke the [USAGE] chip answers to by mouse. Alt owns no
    // editing job, so unlike a plain `u` (which would eat the first letter
    // of every word starting with one) or ctrl+u (which clears the line)
    // it collides with nothing — empty box or not.
    app.input.write("\u001bu");
    await tick(30);
    expect(app.lastFrame()).toContain("Session usage");
    expect(app.lastFrame()).toContain("System tools");

    app.input.write("\u001b");
    await tick(120);

    // With words in the box it keeps its old job: clear back to the caret.
    app.input.write("hello");
    await tick(20);
    app.input.write("\u0015");
    await tick(20);
    expect(app.lastFrame()).toContain("Ask anything");
    expect(app.lastFrame()).not.toContain("hello");

    app.input.write("/exit\r");
    await done;
  });

  it("offers a failed turn back as a modal — retry, another model, or let it go", async () => {
    const app = harness({}, { failWith: new Error("Provider rate-limited the request (HTTP 429)") });
    const done = runTui(app.options);
    await tick();

    app.input.write("try me\r");
    await tick(30);
    // The error stays in the transcript, and the modal asks what to do —
    // naming the gateway's message, since that is usually the diagnosis.
    expect(app.screen()).toContain("Provider rate-limited the request (HTTP 429)");
    expect(app.lastFrame()).toContain("Rate limited — what now?");
    // The three answers are chips, so a mouse can pick any of them.
    expect(app.lastFrame()).toContain("[r] retry · [m] choose model · [×] dismiss");

    // Esc keeps the error and drops the question: the prompt takes typing again.
    // A lone Esc is held briefly as a possible escape sequence, so this waits
    // past that flush before reading the frame.
    app.input.write("\u001b");
    await tick(80);
    expect(app.lastFrame()).not.toContain("Rate limited — what now?");
    expect(app.screen()).toContain("Provider rate-limited the request (HTTP 429)");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("gives every line of the gateway's message its own row", async () => {
    const app = harness(
      {},
      {
        failWith: new Error(
          "Provider returned HTTP 402 for\nhttps://opencode.ai/zen/v1/chat/completions: Upstream request failed:\nInsufficient account funds",
        ),
      },
    );
    const done = runTui(app.options);
    await tick();

    app.input.write("try me\r");
    await tick(30);
    const rows = app.lastFrame().split(/\r?\n/);

    // The message is a paragraph written as lines. A row's spans are glued
    // together, so a body that forgot the newline in front of each line after
    // the first printed the whole diagnosis as one run-on row.
    expect(rows.some((line) => line.includes("Provider returned HTTP 402 for"))).toBe(true);
    expect(rows.some((line) => line.includes("Insufficient account funds"))).toBe(true);
    expect(rows.some((line) => line.includes("402 forhttps"))).toBe(false);

    // The card owns every key while it is up, so quit from under it — which is
    // also the one thing the card deliberately does not claim.
    app.input.write("\u0003");
    expect(await done).toBe(0);
  });

  it("answers the card with the mouse: [m] opens the picker, its chip closes it", async () => {
    const app = harness(
      {
        listProviders: async () => [{ label: "TestGW", value: "https://api.example/v1" }],
        listModels: async () => [{ id: "m2", free: true }],
      },
      { failWith: new Error("Provider rate-limited the request (HTTP 429)") },
    );
    const done = runTui(app.options);
    await tick();

    app.input.write("try me\r");
    await tick(30);
    expect(app.lastFrame()).toContain("[r] retry · [m] choose model · [×] dismiss");

    // A click on `[m]` is the `m` key — the same handler runs — so the picker
    // opens with the failed turn still set aside for whatever it lands on.
    clickOn(app, "[m] choose model");
    await tick(60);
    expect(app.lastFrame()).toContain("Select model");
    expect(app.lastFrame()).not.toContain("Rate limited — what now?");

    // And the picker's own way out is a chip in its footer.
    clickOn(app, "[×] close");
    await tick(60);
    expect(app.lastFrame()).not.toContain("Select model");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("lets the error go when the card's own close chip is clicked", async () => {
    const app = harness({}, { failWith: new Error("Provider rate-limited the request (HTTP 429)") });
    const done = runTui(app.options);
    await tick();

    app.input.write("try me\r");
    await tick(30);
    expect(app.lastFrame()).toContain("[×] dismiss");

    clickOn(app, "[×] dismiss");
    await tick(60);

    expect(app.lastFrame()).not.toContain("Rate limited — what now?");
    // Dismissing the question is not forgetting the failure: the error stays.
    expect(app.screen()).toContain("Provider rate-limited the request (HTTP 429)");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("retries the exact failed message on r — words, attachments and model", async () => {
    const app = harness({}, { failWith: new Error("Provider rate-limited the request (HTTP 429)") });
    const done = runTui(app.options);
    await tick();

    app.input.write("try me\r");
    await tick(30);
    expect(app.sentPrompts).toEqual(["try me"]);

    app.input.write("r");
    await tick(40);
    // The same request ran again — and since it failed the same way, the
    // question is back rather than the error being the end.
    expect(app.sentPrompts).toEqual(["try me", "try me"]);
    expect(app.lastFrame()).toContain("Rate limited — what now?");

    app.input.write("\u0003");
    expect(await done).toBe(0);
  }, 15000);

  it("retries the failed message on whatever model the modal's picker lands on", async () => {
    const app = harness(
      {
        listProviders: async () => [{ label: "TestGW", value: "https://api.example/v1" }],
        listModels: async () => [{ id: "m2", free: true }],
      },
      { failWith: new Error("Provider rate-limited the request (HTTP 429)") },
    );
    const done = runTui(app.options);
    await tick();

    app.input.write("try me\r");
    await tick(30);
    expect(app.sentPrompts).toEqual(["try me"]);

    app.input.write("m");
    await tick(120);
    expect(app.lastFrame()).toContain("Select model");

    // Enter takes the highlighted row; the model move and the retry are one act.
    app.input.write("\r");
    await tick(60);
    expect(app.settings.at(-1)?.model).toBe("m2");
    expect(app.sentPrompts).toEqual(["try me", "try me"]);

    app.input.write("\u0003");
    expect(await done).toBe(0);
  }, 15000);

  it("folds repeated failures into one note that admits the count", async () => {
    // A gateway that rate-limits every turn used to stack identical error
    // blocks down the transcript — one row that says "×3" says the same thing
    // without burying what happened before it.
    const app = harness({}, { failWith: new Error("Provider rate-limited the request (HTTP 429)") });
    const done = runTui(app.options);
    await tick();

    for (const prompt of ["first", "second", "third"]) {
      app.input.write(`${prompt}\r`);
      await tick(30);
      // Every failure asks what to do next; the question is dismissed so the
      // next message can be typed. The notes still fold.
      app.input.write("\u001b");
      await tick(80);
    }

    expect(app.screen()).toContain("Provider rate-limited the request (HTTP 429) ×3");
    // The final frame carries the note exactly once — one row, not three.
    expect(app.lastFrame().split("Provider rate-limited")).toHaveLength(2);

    app.input.write("\u0003");
    expect(await done).toBe(0);
  }, 15000);

  it("shows the approval modal and passes the answer to the agent", async () => {
    const app = harness({}, { approve: true });
    const done = runTui(app.options);
    await tick();

    app.input.write("run the tests\r");
    await tick(20);
    expect(app.screen()).toContain("bash wants to run");
    expect(app.screen()).toContain("npm test");

    app.input.write("a");
    await tick(20);
    app.input.write("/exit\r");
    await done;

    expect(app.decisions).toEqual(["always"]);
    expect(app.screen()).toContain("echo: run the tests");
  });

  it("asks again after a mode switch — an 'always' does not survive it", async () => {
    // The build notice promises "changes and commands need approval again" on
    // the way back from plan mode. The agent is rebuilt on a switch (clearing
    // its own approvals), so the app-level shortcut has to go too — otherwise
    // the second turn is auto-allowed and no modal ever appears.
    const app = harness({}, { approve: true });
    const done = runTui(app.options);
    await tick();

    app.input.write("run the tests\r");
    await tick(20);
    expect(app.screen()).toContain("bash wants to run");

    app.input.write("a");
    await tick(20);
    expect(app.decisions).toEqual(["always"]);

    // Build → plan → build, the round trip the notice describes.
    app.input.write("[Z");
    await tick(30);
    app.input.write("[Z");
    await tick(30);
    expect(app.lastFrame()).toContain("[BUILD]");

    app.input.write("run the tests again\r");
    await tick(20);
    // Still waiting on the user — without the clear above this would already
    // be ["always", "always"], auto-allowed with no modal ever drawn.
    expect(app.decisions).toEqual(["always"]);
    expect(app.screen()).toContain("bash wants to run");

    app.input.write("y");
    await tick(20);
    app.input.write("/exit\r");
    await done;

    expect(app.decisions).toEqual(["always", "allow"]);
  });

  it("names the live streaming speed on the state row while the answer arrives", async () => {
    // Two chunks 400ms apart: the first sets the clock, the second is past
    // the quarter-second floor, so the spinner row carries a rate mid-stream.
    // `screen()` is cumulative, so the mid-stream frame is still in it.
    const app = harness(
      {},
      { streamChunks: ["hello world, this is chunk one of the answer. ", "and this is chunk two arriving later."] },
    );
    const done = runTui(app.options);
    await tick();

    app.input.write("go\r");
    await tick(1500);
    expect(app.screen()).toContain("tok/s");

    app.input.write("/exit\r");
    await done;
  });

  it("keeps the spinner plain while streaming when TPS is off", async () => {
    const app = harness(
      { view: { ...defaultViewSettings(), sidebar: "on", tps: "off" } },
      { streamChunks: ["hello world, this is chunk one of the answer. ", "and this is chunk two arriving later."] },
    );
    const done = runTui(app.options);
    await tick();

    app.input.write("go\r");
    await tick(1500);
    // Neither the live row nor the per-answer line names a speed.
    expect(app.screen()).not.toContain("tok/s");

    app.input.write("/exit\r");
    await done;
  });

  it("treats escape as a refusal, never a yes", async () => {
    const app = harness({}, { approve: true });
    const done = runTui(app.options);
    await tick();

    app.input.write("run the tests\r");
    await tick(20);
    app.input.write("\u001b");
    // A bare escape is held briefly in case it starts a sequence.
    await tick(80);
    expect(app.decisions).toEqual(["deny"]);

    app.input.write("/exit\r");
    await done;
  });

  it("switches sessions on tab", async () => {
    const other: ChatMessage[] = [
      { role: "user", content: "earlier work" },
      { role: "assistant", content: "done that" },
    ];
    const app = harness({
      listSessions: async () => [
        { id: "session-1", title: "current work" },
        { id: "session-2", title: "earlier work" },
      ],
      loadSession: async (id) => (id === "session-2" ? other : null),
    });

    const done = runTui(app.options);
    await tick(15);

    app.input.write("\t");
    await tick(20);
    app.input.write("/exit\r");
    await done;

    expect(app.screen()).toContain("earlier work");
    expect(app.screen()).toContain("done that");
    // The reopened session's history was handed to a fresh agent.
    expect(app.built.at(-1)).toEqual(other);
  });

  it("names the card's own keys, and deletes the session under the cursor with ctrl+d", async () => {
    const deleted: string[] = [];
    const app = harness({
      listSessions: async () => [
        { id: "session-1", title: "current work" },
        { id: "session-2", title: "earlier work" },
        { id: "session-3", title: "oldest work" },
      ],
      deleteSession: async (id) => {
        deleted.push(id);
        return true;
      },
    });
    const done = runTui(app.options);
    await tick();

    app.input.write("/sessions\r");
    await tick(40);
    // The card says what its own keys are, on its own last row.
    expect(app.lastFrame()).toContain("Sessions");
    expect(app.lastFrame()).toContain("ctrl+d delete");

    // Move onto the second row, then delete it: the key acts on the row under
    // the cursor, not on the first one. The card stays up, one row shorter,
    // with the search and the cursor's place intact.
    app.input.write("\u001b[B");
    await tick(20);
    app.input.write("\u0004");
    await tick(60);

    expect(deleted).toEqual(["session-3"]);
    expect(app.lastFrame()).toContain("current work");
    expect(app.lastFrame()).toContain("earlier work");
    expect(app.lastFrame()).not.toContain("oldest work");
    expect(app.lastFrame()).toContain("ctrl+d delete");

    await finish(app, done);
  });

  it("opens the command palette on a slash and filters as you type", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick();

    app.input.write("/");
    await tick(20);
    // The list opens on the first runnable command and fills the screen —
    // the window follows the selection from there. `/agents` runs now, so it is
    // in the list and sorted ahead of `/btw`.
    expect(app.lastFrame()).toContain("/agents");
    expect(app.lastFrame()).toContain("/btw");
    expect(app.lastFrame()).not.toContain("/sessions");

    app.input.write("sessi");
    await tick(20);
    expect(app.lastFrame()).toContain("/sessions");
    expect(app.lastFrame()).not.toContain("/compact");
    expect(app.lastFrame()).not.toContain("/mcps");

    // Enter runs the highlighted command rather than sending the text.
    app.input.write("\r");
    await tick(25);
    expect(app.lastFrame()).toContain("no other sessions in");

    app.input.write("/exit\r");
    await done;
  });

  it("moves the selection with the arrow keys and runs it", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick();

    app.input.write("/");
    await tick(20);
    // The list opens on /agents — one step down lands on /btw, a second on
    // /budget, the command this test runs.
    app.input.write("\u001b[B\u001b[B");
    await tick(20);

    app.input.write("\r");
    await tick(25);
    // /budget with no argument reports where the session stands — enough to
    // prove which command ran.
    expect(app.lastFrame()).toContain("budget none");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("closes the palette on escape without running anything", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick();

    app.input.write("/");
    await tick(20);
    expect(app.lastFrame()).toContain("/btw");

    app.input.write("\u001b");
    await tick(80);
    expect(app.lastFrame()).not.toContain("/btw");

    app.input.write("/exit\r");
    await done;
  });

  it("reports an unknown slash command instead of sending it", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick();

    app.input.write("/nope\r");
    await tick(20);
    // The unknown line is left in place to be corrected, so it has to be
    // cleared before the next command rather than appended to.
    app.input.write("\u0015/exit\r");
    await done;

    expect(app.screen()).toContain("unknown command: /nope");
    // Nothing was sent to the model for it.
    expect(app.saves.at(-1)?.messages ?? []).toHaveLength(0);
  });

  it("picks another session from a list", async () => {
    const other: ChatMessage[] = [
      { role: "user", content: "earlier work" },
      { role: "assistant", content: "done that" },
    ];
    const app = harness({
      listSessions: async () => [
        { id: "session-1", title: "this one" },
        { id: "session-2", title: "another one" },
      ],
      loadSession: async (id) => (id === "session-2" ? other : null),
    });

    const done = runTui(app.options);
    await tick();
    app.input.write("/sessions\r");
    await tick(20);
    expect(app.lastFrame()).toContain("another one");
    expect(app.lastFrame()).toContain("session-2");

    // Enter takes the highlighted session.
    app.input.write("\r");
    await tick(20);
    expect(app.screen()).toContain("earlier work");
    expect(app.built.at(-1)).toEqual(other);

    app.input.write("/exit\r");
    await done;
  });

  it("dates a session in the user's own format, read off the local clock", async () => {
    // Ten days back, late in the local evening: a stamp read as UTC would land
    // this on the following day for anyone east of Greenwich.
    const when = new Date();
    when.setDate(when.getDate() - 10);
    when.setHours(23, 30, 0, 0);

    const app = harness({
      listSessions: async () => [
        { id: "session-9", title: "a while back", updatedAt: when.toISOString(), messageCount: 2 },
      ],
    });

    const done = runTui(app.options);
    await tick();
    app.input.write("/sessions\r");
    await tick(20);

    // `DD-MM-YYYY` on the local clock, and not the ISO stamp the record stores,
    // which is UTC and reads as data.
    const pad = (value: number): string => String(value).padStart(2, "0");
    const expected = `${pad(when.getDate())}-${pad(when.getMonth() + 1)}-${when.getFullYear()}`;
    expect(app.lastFrame()).toContain(expected);
    expect(app.lastFrame()).not.toContain(when.toISOString().slice(0, 10));

    // Past the app's escape grace, which exists to tell a lone Escape from the
    // front of an escape sequence.
    app.input.write("\u001b");
    await tick(80);
    app.input.write("/exit\r");
    await done;
  });

  it("searches sessions by title and preview, showing when and how long", async () => {
    const other: ChatMessage[] = [
      { role: "user", content: "earlier work" },
      { role: "assistant", content: "done that" },
    ];
    const app = harness({
      listSessions: async () => [
        { id: "session-1", title: "this one" },
        {
          id: "session-2",
          title: "another one",
          updatedAt: new Date().toISOString(),
          messageCount: 4,
          model: "deepseek-v4-flash:free",
          preview: "the oauth redirect loops forever",
        },
        { id: "session-3", title: "third", messageCount: 1, preview: "typo on the pricing page" },
      ],
      loadSession: async (id) => (id === "session-2" ? other : null),
    });

    const done = runTui(app.options);
    await tick();
    app.input.write("/sessions\r");
    await tick(20);
    // The trailing note says when it ran and how long it is…
    expect(app.lastFrame()).toContain("today · 4 msgs");
    expect(app.lastFrame()).toContain("1 msg");
    // …but the preview itself takes no column.
    expect(app.lastFrame()).not.toContain("oauth redirect");

    // Typing a word from the opening request finds the session anyway — its
    // row stays while the other session's row goes (matched on picker rows,
    // since "third" also sits in the tab bar above).
    app.input.write("oauth");
    await tick(20);
    expect(app.lastFrame()).toContain("another one");
    expect(app.lastFrame()).toContain("session-2");
    expect(app.lastFrame()).not.toContain("session-3");

    app.input.write("\r");
    await tick(20);
    expect(app.screen()).toContain("earlier work");
    expect(app.built.at(-1)).toEqual(other);

    app.input.write("/exit\r");
    await done;
  });

  it("queues a second prompt while a turn is running, and runs it after the first", async () => {
    // Short on purpose: this one waits the turns out with a fixed `tick(500)`
    // below, so a longer turn than that wait would simply never finish in time.
    const app = harness({}, { slow: 400 });
    const done = runTui(app.options);
    await tick(20);

    app.input.write("first\r");
    await tick(40);
    app.input.write("second\r");
    await tick(40);

    // Second prompt is queued in the conversation while the first runs…
    expect(app.screen()).toContain("queued");

    // Wait for the first turn and the queued second turn to run…
    await tick(500);
    await tick(500);

    // Both prompts reached the transcript and completed in sequence.
    expect(app.saves.at(-1)?.messages).toHaveLength(4);

    app.input.write("/exit\r");
    await done;
  });

  it("keeps a half-received escape sequence out of the prompt", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick();

    // The three bytes of an arrow key, delivered separately.
    app.input.write("ab");
    await tick(8);
    app.input.write("\u001b");
    await tick(8);
    app.input.write("[D");
    await tick(8);
    app.input.write("!\r");
    await tick(20);
    app.input.write("/exit\r");
    await done;

    // The left arrow moved the caret, so the "!" landed before "b".
    expect(app.saves.at(-1)?.messages[0]).toEqual({ role: "user", content: "a!b" });
  });
});

/** The question from the reference panel, trimmed to two options. */
const TYPOGRAPHY: AskQuestion[] = [
  {
    header: "Typography",
    question: "The reference is clean sans-serif, not monospace. Which way?",
    options: [
      { label: "Sans-serif (Recommended)", description: "Clean sans-serif throughout, like the reference." },
      { label: "Keep monospace", description: "Keep IBM Plex Mono from ki-code-v1.0." },
    ],
  },
];

describe("the question panel", () => {
  it("asks the user and hands the answer back to the model", async () => {
    const app = harness({}, { questions: TYPOGRAPHY });
    const done = runTui(app.options);
    await tick();

    app.input.write("start\r");
    await tick(20);

    const frame = app.lastFrame();
    expect(frame).toContain("Questions");
    expect(frame).toContain("The reference is clean sans-serif, not monospace. Which way?");
    expect(frame).toContain("1. Sans-serif (Recommended) ✓");
    // The descriptions hang under their label.
    expect(frame).toContain("   Keep IBM Plex Mono from ki-code-v1.0.");
    // The free-text row is the UI's own, not the model's.
    expect(frame).toContain("3. Type your own answer");
    expect(frame).toContain("↑↓ select");

    // Down, then Enter: the second option was highlighted, not the first.
    app.input.write("\u001b[B");
    await tick(20);
    expect(app.lastFrame()).toContain("2. Keep monospace ✓");

    app.input.write("\r");
    await tick(20);

    expect(app.replies.at(-1)).toEqual([{ header: "Typography", answer: "Keep monospace", dismissed: false }]);
    // The question is gone and the turn finished with the answer behind it.
    expect(app.lastFrame()).not.toContain("Questions");
    expect(app.screen()).toContain("echo: start");

    app.input.write("/exit\r");
    await done;
  });

  it("walks several questions and sends them together", async () => {
    const two: AskQuestion[] = [
      { header: "Base stack", question: "Which stack?", options: [{ label: "Next.js" }, { label: "Vite" }] },
      { header: "Layout scope", question: "How far?", options: [{ label: "One page" }, { label: "Whole site" }] },
    ];
    const app = harness({}, { questions: two });
    const done = runTui(app.options);
    await tick();

    app.input.write("start\r");
    await tick(20);
    expect(app.lastFrame()).toContain("Base stack");
    expect(app.lastFrame()).toContain("Submit");

    // Choosing an option advances by itself, so no key is wasted on it.
    app.input.write("\u001b[B\r");
    await tick(20);
    expect(app.lastFrame()).toContain("How far?");

    // Tab brings the first question back with the cursor on the answer it has.
    app.input.write("\t");
    await tick(20);
    expect(app.lastFrame()).toContain("2. Vite ✓");

    app.input.write("\t");
    await tick(20);
    app.input.write("1");
    await tick(20);

    expect(app.replies.at(-1)).toEqual([
      { header: "Base stack", answer: "Vite", dismissed: false },
      { header: "Layout scope", answer: "One page", dismissed: false },
    ]);

    app.input.write("/exit\r");
    await done;
  });

  it("reports a dismissed question rather than staying silent", async () => {
    const app = harness({}, { questions: TYPOGRAPHY });
    const done = runTui(app.options);
    await tick();

    app.input.write("start\r");
    await tick(20);
    app.input.write("\u001b");
    // A bare escape is held briefly in case it starts a sequence.
    await tick(80);

    // Silence would read as agreement with whatever the model proposed.
    expect(app.replies.at(-1)).toEqual([{ header: "Typography", answer: "", dismissed: true }]);
    expect(app.lastFrame()).not.toContain("Questions");

    app.input.write("/exit\r");
    await done;
  });

  it("takes an answer typed by hand when none of the options fit", async () => {
    const app = harness({}, { questions: TYPOGRAPHY });
    const done = runTui(app.options);
    await tick();

    app.input.write("start\r");
    await tick(20);

    // The free-text row is the last one, so its number is the options plus one.
    app.input.write("3");
    await tick(20);
    expect(app.lastFrame()).toContain("Type your answer…");
    expect(app.lastFrame()).toContain("[×] cancel");

    app.input.write("Inter, with a mono accent");
    await tick(20);
    app.input.write("\r");
    await tick(20);

    expect(app.replies.at(-1)).toEqual([
      { header: "Typography", answer: "Inter, with a mono accent", dismissed: false },
    ]);

    app.input.write("/exit\r");
    await done;
  });

  it("escape while typing goes back to the options instead of answering", async () => {
    const app = harness({}, { questions: TYPOGRAPHY });
    const done = runTui(app.options);
    await tick();

    app.input.write("start\r");
    await tick(20);
    app.input.write("3");
    await tick(20);
    app.input.write("half a thought");
    await tick(20);
    app.input.write("\u001b");
    await tick(80);

    expect(app.lastFrame()).toContain("Type your own answer");
    expect(app.lastFrame()).not.toContain("half a thought");
    // Nothing was answered, so the model is still waiting.
    expect(app.replies).toHaveLength(0);

    app.input.write("\u001b");
    await tick(80);
    expect(app.replies.at(-1)).toEqual([{ header: "Typography", answer: "", dismissed: true }]);

    app.input.write("/exit\r");
    await done;
  });
});

/**
 * Runs `lines` as prompts and commands, one after another, and hands back the
 * harness so the test can assert on what the screen ended up showing.
 */
/** The last frame exactly as it went to the terminal, escapes included. */
const painted = (app: Harness): string => app.raw().split("\u001b[H").at(-1) ?? "";

async function drive(
  lines: string[],
  over: Partial<TuiOptions> = {},
  flags: { slow?: number; approve?: boolean; questions?: AskQuestion[] } = {},
) {
  const app = harness(over, flags);
  const done = runTui(app.options);
  await tick();
  for (const line of lines) {
    app.input.write(`${line}\r`);
    await tick(30);
  }
  return { app, done };
}

describe("the queue and the commands that fill it", () => {
  it("fills the box for a command that needs an argument instead of running it", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick(20);

    // `/go` narrows the palette to /goal, which needs an objective. Choosing it
    // must not run it — a usage line in the transcript is a dead end, while
    // `/goal ` with the cursor waiting is the next step.
    app.input.write("/go");
    await tick(20);
    app.input.write("\r");
    await tick(20);

    expect(app.lastFrame()).toContain("/goal ");
    expect(app.sentPrompts).toHaveLength(0);

    // The argument finishes the command, and enter runs it.
    app.input.write("ship it\r");
    await tick(60);
    expect(app.sentPrompts.at(-1)).toContain("Execute this goal autonomously");
    expect(app.sentPrompts.at(-1)).toContain("ship it");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("runs /insert at once when no turn is running", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick(20);

    // With nothing in flight there is nothing to insert ahead of, so the
    // message is simply the next turn — not a queue entry no turn will drain.
    app.input.write("/insert do the thing\r");
    await tick(60);

    expect(app.sentPrompts.at(-1)).toBe("do the thing");
    expect(app.screen()).not.toContain("[queued in conversation]");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("runs a slash command that was queued behind a turn", async () => {
    const app = harness({}, { slow: 250 });
    const done = runTui(app.options);
    await tick(20);

    app.input.write("first\r");
    await tick(40);
    // Typed while the first turn runs, so it goes into the queue as given.
    app.input.write("/goal ship it\r");
    await tick(40);
    expect(app.screen()).toContain("queued");

    await tick(500);
    await tick(500);

    // The queued line ran as a command when its turn came, not as prose handed
    // to the model to read out.
    expect(app.sentPrompts.at(-1)).toContain("Execute this goal autonomously");
    expect(app.sentPrompts.at(-1)).toContain("ship it");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("opens this session's usage from the [USAGE] chip, and escape closes it", async () => {
    const app = harness({});
    const done = runTui(app.options);
    await tick(20);

    // The chip reports its own columns, so the press lands on it the way a
    // mouse would.
    const lines = app.lastFrame().split(/\r?\n/);
    const row = lines.findIndex((line) => line.includes("[USAGE]"));
    expect(row).toBeGreaterThanOrEqual(0);
    const col = (lines[row] ?? "").indexOf("[USAGE]") + 3;
    app.input.write(clickAt(row + 1, col));
    await tick(40);

    expect(app.lastFrame()).toContain("Session usage");
    expect(app.lastFrame()).toContain("messages");
    // The chip answers with both halves now: the context breakdown above the
    // session's own numbers.
    expect(app.lastFrame()).toContain("System tools");
    expect(app.lastFrame()).toContain("9 tools");

    // The start reads as `DD-MM-YYYY HH:mm` on the local clock. It used to print
    // the stored stamp verbatim — `2026-10-02T05:38:58.828Z` — which is UTC, so
    // it named the wrong hour and read as data rather than a time.
    expect(app.lastFrame()).toMatch(/session started \d{2}-\d{2}-\d{4} \d{2}:\d{2} \(/);
    expect(app.lastFrame()).not.toMatch(/session started \d{4}-\d{2}-\d{2}T/);

    // The card has nothing to answer, so escape — or the chip it names — is the
    // only key it owns. A lone ESC is ambiguous on the wire, so it is held for
    // `ESCAPE_GRACE_MS` (40) before it is flushed — wait past that.
    app.input.write("\u001b");
    await tick(120);
    expect(app.lastFrame()).not.toContain("Session usage");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("drops one queued message when its [x] is clicked", async () => {
    // Deliberately generous: what these tests need is a turn that is still
    // running when the next prompt arrives, and how long that takes is the one
    // thing a loaded machine cannot be trusted to hold to. The margin is set so
    // the turn outlasts the few ticks of setup by a wide factor.
    const app = harness({}, { slow: 1_200 });
    const done = runTui(app.options);
    await tick(20);

    app.input.write("first\r");
    await tick(40);
    app.input.write("second\r");
    await tick(40);
    app.input.write("third\r");
    await tick(40);
    expect(app.lastFrame()).toContain("Queued (2)");

    // The `[x]` of the first tile only, not the whole queue. The tile is the
    // row under the panel's own header, which is where the queue begins.
    const lines = app.lastFrame().split(/\r?\n/);
    const header = lines.findIndex((line) => line.includes("Queued ("));
    expect(header).toBeGreaterThanOrEqual(0);
    const tileRow = header + 1;
    expect(lines[tileRow] ?? "").toContain("[x]");
    const col = (lines[tileRow] ?? "").indexOf("[x]") + 2;
    app.input.write(clickAt(tileRow + 1, col));
    await tick(60);

    // The first tile is gone and the second has moved up: the count and the
    // remaining message both say one was dropped, not the whole queue.
    expect(app.lastFrame()).toContain("Queued (1)");
    const after = app.lastFrame().split(/\r?\n/);
    const afterHeader = after.findIndex((line) => line.includes("Queued ("));
    const remaining = after[afterHeader + 1] ?? "";
    expect(remaining).toContain("[x]");
    expect(remaining).toContain("third");
    expect(remaining).not.toContain("second");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("hands a queued message to the running turn when its [Add+] is clicked", async () => {
    // Deliberately generous: what these tests need is a turn that is still
    // running when the next prompt arrives, and how long that takes is the one
    // thing a loaded machine cannot be trusted to hold to. The margin is set so
    // the turn outlasts the few ticks of setup by a wide factor.
    const app = harness({}, { slow: 1_200 });
    const done = runTui(app.options);
    await tick(20);

    app.input.write("first\r");
    await tick(40);
    app.input.write("second\r");
    await tick(40);
    app.input.write("third\r");
    await tick(40);
    expect(app.lastFrame()).toContain("Queued (2)");

    const lines = app.lastFrame().split(/\r?\n/);
    const header = lines.findIndex((line) => line.includes("Queued ("));
    const tileRow = header + 1;
    expect(lines[tileRow] ?? "").toContain("[Add+]");
    const col = (lines[tileRow] ?? "").indexOf("[Add+]") + 3;
    app.input.write(clickAt(tileRow + 1, col));
    await tick(60);

    // The words went into the turn that was already running — so the model reads
    // them on its next request — and left the queue, so the drain cannot send
    // them a second time as a turn of their own.
    expect(app.steers).toEqual(["second"]);
    // The spinner names it while it waits: the tile vanishing is the only other
    // sign, and a tile vanishing reads as a deletion.
    expect(app.lastFrame()).toContain("+1 to read");
    expect(app.lastFrame()).toContain("Queued (1)");
    const after = app.lastFrame().split(/\r?\n/);
    const afterHeader = after.findIndex((line) => line.includes("Queued ("));
    expect(after[afterHeader + 1] ?? "").toContain("third");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("opens the queue as a list whose rows the keyboard can steer and drop", async () => {
    const app = harness({}, { slow: 1_200 });
    const done = runTui(app.options);
    await tick(20);

    app.input.write("first\r");
    await tick(40);
    app.input.write("second\r");
    await tick(40);
    app.input.write("third\r");
    await tick(40);

    // A bare `/queue` runs while the turn is in flight — it is about the queue,
    // and the queue is only ever full while a turn runs.
    app.input.write("\u0015/queue\r");
    await tick(40);
    expect(app.lastFrame()).toContain("Queued messages (2)");
    expect(app.lastFrame()).toContain("2. third");

    // `ctrl+x` drops the row under the cursor, and the list rebuilds so the next
    // action cannot resolve an index against a queue that moved.
    app.input.write("\u0018");
    await tick(40);
    expect(app.lastFrame()).toContain("Queued messages (1)");
    // Rebuilt, not merely redrawn: the dropped message is gone from the list and
    // the one behind it has moved up to row 1.
    expect(app.lastFrame()).toContain("1. third");

    // `ctrl+a` is the tile's `[Add+]`, from the keyboard.
    app.input.write("\u0001");
    await tick(40);
    expect(app.steers).toEqual(["third"]);
    expect(app.lastFrame()).toContain("the queue is empty");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("takes a queued message back into the prompt to rewrite it with enter", async () => {
    const app = harness({}, { slow: 1_200 });
    const done = runTui(app.options);
    await tick(20);

    app.input.write("first\r");
    await tick(40);
    app.input.write("second\r");
    await tick(40);

    app.input.write("\u0015/queue\r");
    await tick(40);
    app.input.write("\r");
    await tick(40);

    // Out of the queue and into the box, where it can be changed — a queue you
    // cannot take anything back out of is a place messages go to be lost.
    expect(app.lastFrame()).toContain("taken back from the queue");
    expect(app.lastFrame()).not.toContain("Queued messages");

    // Sent again, it queues behind the running turn — which could only happen if
    // the editor really holds those words.
    app.input.write("\r");
    await tick(40);
    expect(app.lastFrame()).toContain("Queued (1)");
    expect(app.lastFrame()).toContain("second");

    app.input.write("\u0015/exit\r");
    await done;
  });
});

describe("the plan panel", () => {
  const plan: PlanSnapshot = {
    todos: [
      { text: "read the code", done: true },
      { text: "change the loop", done: false },
    ],
    goal: null,
  };

  it("opens from the TODO chip and closes with escape", async () => {
    const app = harness({}, { plan });
    const done = runTui(app.options);
    await tick(20);

    // The chip only exists once a plan tool has run, so the turn comes first.
    app.input.write("go\r");
    await tick(60);
    expect(app.lastFrame()).toContain("[TODO 1/2]");
    // Shut, the panel is not drawn: its rows are not on screen.
    expect(app.lastFrame()).not.toContain("change the loop");

    // The chip is a button on the state row; press the middle of it.
    const lines = app.lastFrame().split(/\r?\n/);
    const row = lines.findIndex((line) => line.includes("[TODO 1/2]"));
    const col = (lines[row] ?? "").indexOf("[TODO 1/2]") + 3;
    app.input.write(clickAt(row + 1, col));
    await tick(40);
    expect(app.lastFrame()).toContain("change the loop");

    // Escape closes the most recent thing that was opened. A bare ESC is held
    // for the decoder's grace window before it is read as Escape at all.
    app.input.write("\u001b");
    await tick(90);
    expect(app.lastFrame()).not.toContain("change the loop");

    app.input.write("\u0015/exit\r");
    await done;
  });
});

describe("delegation", () => {
  /**
   * A child agent that reports a fixed thing, and records what it was asked.
   *
   * Shaped as an `Agent` because that is what the app holds: the parent's
   * events are what the dock is drawn from, so a child that never emits one
   * would leave the panel untested rather than tested-and-empty.
   */
  function child(sent: string[], body: () => AsyncGenerator<AgentEvent>): Agent {
    return {
      async *send(prompt: string): AsyncGenerator<AgentEvent> {
        sent.push(prompt);
        yield* body();
      },
    } as unknown as Agent;
  }

  const answering = (report: string, tools = 1): (() => AsyncGenerator<AgentEvent>) =>
    async function* answering(): AsyncGenerator<AgentEvent> {
      for (let at = 0; at < tools; at += 1) {
        yield { type: "tool-start", id: `t${at}`, name: "read", args: {} };
        yield { type: "tool-result", id: `t${at}`, name: "read", content: "x", isError: false };
      }
      yield { type: "text", delta: report };
      yield { type: "done", reason: "complete" };
    }

  const delegation = (over: Partial<NonNullable<TuiOptions["delegation"]>> = {}): NonNullable<
    TuiOptions["delegation"]
  > => ({
    enabled: true,
    model: "child-flash",
    maxConcurrent: 2,
    maxPerTurn: 4,
    maxIterations: 20,
    staleMs: 60_000,
    staleToolMs: 120_000,
    ...over,
  });

  /** The `delegate` tool the app actually registered, as the loop would find it. */
  function tool(app: Harness): Tool {
    // Built in the constructor and handed to every agent, so the first settings
    // the harness collected is where it is.
    const registered = app.settings[0]?.extraTools?.[0];
    if (!registered) throw new Error("no delegate tool was registered");
    return registered;
  }

  describe("registration", () => {
    it("registers the delegate tool when delegation is on", async () => {
      const { app, done } = await drive([], {
        delegation: delegation(),
        createSubagent: ({ goal }) => child([], answering(goal)),
      });

      expect(await tool(app)).toBeDefined();
      app.input.write("\u001b");
      await tick(20);
      app.input.write("\u0015/exit\r");
      await done;
    });

    it("registers nothing when delegation is off", async () => {
      // A tool the model can see but cannot use costs it a wasted turn every
      // time it reaches for one, so the absence has to be the absence.
      const { app, done } = await drive([], {
        delegation: delegation({ enabled: false }),
        createSubagent: ({ goal }) => child([], answering(goal)),
      });

      expect(app.settings[0]?.extraTools).toBeUndefined();
      app.input.write("\u001b");
      await tick(20);
      app.input.write("\u0015/exit\r");
      await done;
    });

    it("registers nothing when the run cannot build a child", async () => {
      // Delegation without a factory is a promise, not a capability.
      const { app, done } = await drive([], { delegation: delegation() });

      expect(app.settings[0]?.extraTools).toBeUndefined();
      app.input.write("\u001b");
      await tick(20);
      app.input.write("\u0015/exit\r");
      await done;
    });
  });

  describe("running a child", () => {
    it("hands the child the delegated model, and the goal as its prompt", async () => {
      const sent: string[] = [];
      const models: string[] = [];
      const { app, done } = await drive([], {
        delegation: delegation({ model: "child-flash" }),
        createSubagent: ({ goal, model }) => {
          models.push(model);
          return child(sent, answering("found it"));
        },
      });

      const result = await (await tool(app)).run(
        { goal: "find the retry logic", context: "src/agent" },
        { cwd: "C:\\dev" },
      );

      expect(result.content).toContain("found it");
      expect(models).toEqual(["child-flash"]);
      expect(sent).toEqual(["find the retry logic"]);
      app.input.write("\u001b");
      await tick(20);
      app.input.write("\u0015/exit\r");
      await done;
    });

    it("falls back to the session's own model when no pin is set", async () => {
      // The default shape is a frontier parent with cheaper children, and a
      // project that has not chosen a cheaper one should not accidentally get
      // an expensive child by a name it never wrote.
      const models: string[] = [];
      const { app, done } = await drive([], {
        delegation: delegation({ model: "" }),
        createSubagent: ({ goal, model }) => {
          models.push(model);
          return child([], answering(goal));
        },
      });

      await (await tool(app)).run({ goal: "look around" }, { cwd: "C:\\dev" });

      expect(models).toEqual(["deepseek-v4-flash:free"]);
      app.input.write("\u001b");
      await tick(20);
      app.input.write("\u0015/exit\r");
      await done;
    });

    it("shows a row for a child while it is still working", async () => {
      // The whole point of the dock: a child can run for minutes with the
      // parent's own words silent, and a row that only filled in at the end
      // would be a receipt rather than a progress display.
      const sent: string[] = [];
      let release = (): void => {};
      const held = new Promise<void>((done_) => {
        release = done_;
      });
      const { app, done } = await drive([], {
        delegation: delegation(),
        createSubagent: ({ goal }) =>
          child(sent, (async function* (): AsyncGenerator<AgentEvent> {
            yield { type: "tool-start", id: "t0", name: "read", args: {} };
            yield { type: "tool-result", id: "t0", name: "read", content: "x", isError: false };
            await held;
            yield { type: "text", delta: "found it" };
            yield { type: "done", reason: "complete" };
          })),
      });

      const running = (await tool(app)).run({ goal: "read the whole tree" }, { cwd: "C:\\dev" });
      await tick(40);

      // The goal, the pinned model and the request count are all on screen.
      expect(app.lastFrame()).toContain("read the whole tree");
      expect(app.lastFrame()).toContain("child-flash");

      release();
      expect((await running).content).toContain("found it");
      app.input.write("\u001b");
      await tick(20);
      app.input.write("\u0015/exit\r");
      await done;
    });

    it("files the report so /agents can still show it after the turn", async () => {
      const { app, done } = await drive([], {
        delegation: delegation(),
        createSubagent: ({ goal }) => child([], answering("the answer is 42")),
      });

      await (await tool(app)).run({ goal: "what is the port" }, { cwd: "C:\\dev" });
      await tick(20);
      app.input.write("/agents running\r");
      await tick(30);

      // The roster row is a summary line, so it is cut to fit — the dock says
      // work happened, and choosing the row is where the report is read.
      const listed = app.lastFrame();
      expect(listed).toContain("Subagents");
      expect(listed).toContain("what is the port");
      expect(listed).toContain("child-flash");

      app.input.write("\r");
      await tick(30);
      expect(app.lastFrame()).toContain("the answer is 42");

      app.input.write("\u001b");
      await tick(20);
      app.input.write("\u0015/exit\r");
      await done;
    });
  });

  describe("when a child does not finish", () => {
    it("names the failure in the parent's report rather than swallowing it", async () => {
      const { app, done } = await drive([], {
        delegation: delegation(),
        createSubagent: () => {
          throw new Error("no route to that gateway");
        },
      });

      const result = await (await tool(app)).run({ goal: "check upstream" }, { cwd: "C:\\dev" });

      expect(result.content).toContain("failed: no route to that gateway");
      app.input.write("\u001b");
      await tick(20);
      app.input.write("\u0015/exit\r");
      await done;
    });

    it("says a child stopped mid-run rather than calling it a clean finish", async () => {
      const { app, done } = await drive([], {
        delegation: delegation(),
        createSubagent: ({ goal }) =>
          child([], (async function* (): AsyncGenerator<AgentEvent> {
            yield { type: "tool-start", id: "t0", name: "read", args: {} };
            yield { type: "done", reason: "max-turns" };
          })),
      });

      const result = await (await tool(app)).run({ goal: "an endless grep" }, { cwd: "C:\\dev" });

      // A child that ran out of turns has still seen the task; claiming a clean
      // finish on partial work is how a parent ends up trusting a truncated
      // report.
      expect(result.content).toContain("stalled: it ran out of turns");
      app.input.write("\u001b");
      await tick(20);
      app.input.write("\u0015/exit\r");
      await done;
    });

    it("calls a child stopped with its turn interrupted, not failed", async () => {
      const { app, done } = await drive([], {
        delegation: delegation(),
        createSubagent: ({ goal, signal }) =>
          child([], (async function* (): AsyncGenerator<AgentEvent> {
            yield { type: "tool-start", id: "t0", name: "read", args: {} };
            await new Promise<void>((_, reject) => {
              const onAbort = (): void => {
                const error = new Error("This operation was aborted");
                error.name = "AbortError";
                reject(error);
              };
              if (signal.aborted) onAbort();
              else signal.addEventListener("abort", onAbort, { once: true });
            });
          })),
      });

      const controller = new AbortController();
      const running = (await tool(app)).run({ goal: "long read" }, { cwd: "C:\\dev", signal: controller.signal });
      await tick(20);
      controller.abort();

      expect((await running).content).toContain("interrupted: stopped with the turn");
      app.input.write("\u001b");
      await tick(20);
      app.input.write("\u0015/exit\r");
      await done;
    });
  });

  describe("a child that stops making progress", () => {
    it("cuts it loose rather than holding the turn open", async () => {
      // A wedged child would otherwise hold the parent's turn open until the
      // session's own ceiling, which is the one thing a batch must never do.
      const { app, done } = await drive([], {
        delegation: delegation({ staleMs: 1_000, staleToolMs: 1_000 }),
        createSubagent: ({ goal, signal }) =>
          child([], (async function* (): AsyncGenerator<AgentEvent> {
            yield { type: "tool-start", id: "t0", name: "read", args: {} };
            await new Promise<void>((_, reject) => {
              const onAbort = (): void => {
                const error = new Error("This operation was aborted");
                error.name = "AbortError";
                reject(error);
              };
              if (signal.aborted) onAbort();
              else signal.addEventListener("abort", onAbort, { once: true });
            });
          })),
      });

      const result = await (await tool(app)).run({ goal: "a read that never returns" }, { cwd: "C:\\dev" });

      // `stalled`, not `interrupted`: nobody asked for this to stop, it simply
      // stopped moving, and the parent is told which it was.
      expect(result.content).toContain("stalled: no progress for");
      app.input.write("\u001b");
      await tick(20);
      app.input.write("\u0015/exit\r");
      await done;
    });

    it("leaves a child alone while it is still moving", async () => {
      const { app, done } = await drive([], {
        delegation: delegation({ staleMs: 1_000, staleToolMs: 1_000 }),
        createSubagent: ({ goal }) =>
          child([], (async function* (): AsyncGenerator<AgentEvent> {
            for (let at = 0; at < 3; at += 1) {
              yield { type: "tool-start", id: `t${at}`, name: "read", args: {} };
              // Each request takes longer than the idle limit on its own; only
              // the silence between them counts.
              await tick(1_400);
            }
            yield { type: "text", delta: "slow but finished" };
            yield { type: "done", reason: "complete" };
          })),
      });

      const result = await (await tool(app)).run({ goal: "a long but live read" }, { cwd: "C:\\dev" });

      expect(result.content).toContain("slow but finished");
      expect(result.content).not.toContain("stalled");
      app.input.write("\u001b");
      await tick(20);
      app.input.write("\u0015/exit\r");
      await done;
    });
  });

  describe("/agents", () => {
    it("says there are none, rather than opening an empty panel", async () => {
      const { app, done } = await drive(["/agents running"], { delegation: delegation() });
      await finish(app, done);

      expect(app.screen()).toContain("no subagents yet");
    });
  });

  describe("the per-turn budget", () => {
    it("starts again with each turn, rather than running out for the session", async () => {
      // `maxPerTurn` is a per-turn promise to the model. A session-wide counter
      // would have the second turn of a short session refused for children the
      // first turn spawned — and the model would be told a budget it still had.
      const { app, done } = await drive([], {
        delegation: delegation({ maxPerTurn: 1 }),
        createSubagent: ({ goal }) => child([], answering(goal)),
      });
      const delegate = tool(app);
      const spawn = (goal: string): Promise<{ content: string; isError?: boolean }> =>
        delegate.run({ goal }, { cwd: "C:\\dev" });

      expect((await spawn("first turn")).isError).toBeFalsy();

      // The same turn may not exceed its budget.
      expect((await spawn("still the first turn")).isError).toBe(true);

      // A new turn gets a new budget. Sending a message is what starts a turn.
      app.input.write("go\r");
      await tick(60);
      expect((await spawn("second turn")).isError).toBeFalsy();

      app.input.write("\u001b");
      await tick(20);
      app.input.write("\u0015/exit\r");
      await done;
    });
  });
});

describe("the subagent editor", () => {
  const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
    name: "cody-git",
    description: "GitHub and git work",
    instructions: "Review branches and PRs.",
    model: "",
    permissions: "read",
    scope: "global",
    file: "",
    ...over,
  });

  /** A session whose only definition is what `profiles` says. */
  const session = (profiles: AgentProfile[] = [], cwd = "C:\\dev\\projects\\kicode"): Partial<TuiOptions> => ({
    delegation: {
      enabled: true,
      model: "",
      profiles,
      maxConcurrent: 2,
      maxPerTurn: 4,
      maxIterations: 20,
      staleMs: 60_000,
      staleToolMs: 120_000,
    },
    cwd,
  });

  const open = async (profiles: AgentProfile[] = [], cwd?: string) => {
    const { app, done } = await drive([], session(profiles, cwd));
    app.input.write("/agents\r");
    await tick(25);
    return { app, done };
  };

  const leave = async (app: Harness, done: Promise<number>): Promise<void> => {
    // Two escapes: one steps out of a field being typed into, the next closes the
    // form. Harmless when nothing is open, which is why it is unconditional
    // rather than something each test has to remember.
    app.input.write("\u001b");
    await tick(90);
    app.input.write("\u001b");
    await tick(90);
    app.input.write("\u0015/exit\r");
    await done;
  };

  it("opens on the list, with a New row even when nothing is defined", async () => {
    const { app, done } = await open();

    const screen = app.lastFrame();
    expect(screen).toContain("Subagents");
    expect(screen).toContain("New agent");
    expect(screen).toContain("No subagents yet");
    await leave(app, done);
  });

  it("lists what is defined, with its permission level", async () => {
    const { app, done } = await open([
      profile({ name: "cody-git", permissions: "read" }),
      profile({ name: "cody-frontend", permissions: "write" }),
    ]);

    const screen = app.lastFrame();
    expect(screen).toContain("cody-git");
    expect(screen).toContain("cody-frontend");
    expect(screen).toContain("read only");
    expect(screen).toContain("can edit");
    await leave(app, done);
  });

  it("says where a project agent lives, so two of the same name are not confusing", async () => {
    const { app, done } = await open([
      profile({ name: "cody-git", scope: "global" }),
      profile({ name: "cody-api", scope: "project" }),
    ]);

    expect(app.lastFrame()).toContain("All projects");
    expect(app.lastFrame()).toContain("This project");
    await leave(app, done);
  });

  /**
   * A key that walks the form down to `field`.
   *
   * The fields in order: name, for, how it works, model, permissions, where,
   * save, and delete on an agent that already exists. The editor opens with the
   * cursor on the name, so a form this tall is navigated rather than read — and
   * a test has to navigate it exactly as a person would.
   */
  const down = (field: number): string => "\u001b[B".repeat(field);

  it("opens the editor on New, and it starts read-only", async () => {
    // The grant is opt-in: an editor that opened on "yes" would make it the
    // default by being the first thing anyone sees.
    const { app, done } = await open();

    app.input.write("\u001b[B"); // down to New agent
    await tick(20);
    app.input.write("\r");
    await tick(25);

    expect(app.lastFrame()).toContain("New subagent");

    // Four fields down to the permission level.
    app.input.write(down(4));
    await tick(25);
    expect(app.lastFrame()).toContain("[no] / yes");
    expect(app.lastFrame()).toContain("Read-only");
    await leave(app, done);
  });

  it("opens the editor on an existing agent with what is stored", async () => {
    const { app, done } = await open([profile({ instructions: "Review branches and PRs." })]);

    app.input.write("\r");
    await tick(25);

    expect(app.lastFrame()).toContain("Subagent · cody-git");
    expect(app.lastFrame()).toContain("GitHub and git work");

    // Delete is the last field, and only an existing agent has one.
    app.input.write(down(7));
    await tick(25);
    expect(app.lastFrame()).toContain("Delete");
    await leave(app, done);
  });

  it("flips a permission with the arrows, and says what the new level means", async () => {
    const { app, done } = await open();

    app.input.write("\u001b[B");
    await tick(20);
    app.input.write("\r");
    await tick(25);
    app.input.write(down(4));
    await tick(20);
    app.input.write("\u001b[C"); // right
    await tick(25);

    expect(app.lastFrame()).toContain("no / [yes]");
    // The warning travels with the grant: a child that can write has no undo.
    expect(app.lastFrame()).toContain("no undo");
    await leave(app, done);
  });

  it("steps past a toggle with enter rather than changing it", async () => {
    // Enter means "next field" on every kind of field. If it flipped a toggle and
    // moved on a text one, the same key would do two different things depending
    // on where the cursor was — and `Where` would silently change scope.
    const { app, done } = await open();

    app.input.write("\u001b[B");
    await tick(20);
    app.input.write("\r");
    await tick(25);
    app.input.write(down(4));
    await tick(20);
    app.input.write("\r"); // on May edit files
    await tick(25);

    // Unchanged…
    expect(app.lastFrame()).toContain("[no] / yes");
    // …and now on the field after it.
    expect(app.lastFrame()).toContain("enter next/edit");
    await leave(app, done);
  });

  it("cycles the scope between everywhere and here", async () => {
    const { app, done } = await open();

    app.input.write("\u001b[B");
    await tick(20);
    app.input.write("\r");
    await tick(25);
    app.input.write(down(5));
    await tick(20);
    app.input.write("\u001b[C"); // right
    await tick(25);

    expect(app.lastFrame()).toContain("all projects / [this project]");
    // The file it will be written to, because "this project" is a choice with
    // a consequence and the consequence is a path.
    expect(app.lastFrame()).toContain("Saved to");
    await leave(app, done);
  });

  it("refuses to save a name it cannot use, and keeps the form open", async () => {
    const { app, done } = await open();

    app.input.write("\u001b[B");
    await tick(20);
    app.input.write("\r");
    await tick(25);
    app.input.write("cody git");
    await tick(25);
    // Enter ends the field and steps on, carrying the value with it. Four Enters
    // reach a toggle, and a toggle does not open for typing — so from there the
    // arrow keys move again.
    app.input.write("\r");
    await tick(20);
    app.input.write("\r");
    await tick(20);
    app.input.write("\r");
    await tick(20);
    app.input.write("\r");
    await tick(20);
    app.input.write(down(2)); // → Save
    await tick(20);
    app.input.write("\r"); // press Save
    await tick(40);

    // Still open, with the reason — closing here would throw away the name.
    expect(app.lastFrame()).toContain("Cannot save");
    expect(app.lastFrame()).toContain("Save");
    await leave(app, done);
  });

  it("shows a name problem on the field itself, before a save is attempted", async () => {
    const { app, done } = await open();

    app.input.write("\u001b[B");
    await tick(20);
    app.input.write("\r");
    await tick(25);
    app.input.write("2fast");
    await tick(20);
    // A bare ESC is held for the decoder's grace window before it reads as
    // Escape, so this needs the long wait or it arrives as part of a sequence.
    app.input.write("\u001b");
    await tick(90);

    expect(app.lastFrame()).toContain("starting with a letter");
    await leave(app, done);
  });

  it("names the keys it answers to", async () => {
    const { app, done } = await open();

    app.input.write("\u001b[B");
    await tick(20);
    app.input.write("\r");
    await tick(25);

    // A form whose footer promises nothing is a form the user has to guess at.
    expect(app.lastFrame()).toContain("enter next/edit");
    expect(app.lastFrame()).toContain("‹/› change");
    expect(app.lastFrame()).toContain("cancel");
    await leave(app, done);
  });

  it("writes the agent where the scope says, and says what it saved", async () => {
    // The whole point of the editor: an agent the model can then be told about.
    // Written into a real KICODE_HOME so the test proves the file, not the note.
    const own = await mkdtemp(path.join(tmpdir(), "kicode-agents-"));
    const previous = process.env.KICODE_HOME;
    process.env.KICODE_HOME = own;
    const { app, done } = await drive([], session([], own));
    app.input.write("/agents\r");
    await tick(25);
    app.input.write("\u001b[B"); // New
    await tick(20);
    app.input.write("\r");
    await tick(25);
    app.input.write("cody-git");
    await tick(20);
    // Enter ends the name and steps on to For, already open for typing.
    app.input.write("\r");
    await tick(25);
    app.input.write("\r"); // For → How it works
    await tick(25);
    app.input.write("\r"); // How it works → Model
    await tick(25);
    app.input.write("\r"); // Model → May edit files
    await tick(25);
    app.input.write("\r"); // → Where
    await tick(25);
    app.input.write("\r"); // → Save
    await tick(25);
    app.input.write("\r");
    await tick(60);

    const written = JSON.parse(
      await readFile(path.join(own, "agents.json"), "utf8"),
    ) as { agents: Record<string, { permissions: string }> };
    expect(Object.keys(written.agents)).toEqual(["cody-git"]);
    // Read-only by default, in the file as well as on screen.
    expect(written.agents["cody-git"]?.permissions).toBe("read");
    // The list it returns to now holds the agent — a save the user cannot see
    // have worked is a save they have to go and check for.
    expect(app.lastFrame()).toContain("cody-git");
    expect(app.lastFrame()).toContain("read only");
    await leave(app, done);
    if (previous === undefined) delete process.env.KICODE_HOME;
    else process.env.KICODE_HOME = previous;
    await rm(own, { recursive: true, force: true });
  });

it("shows what you type while you are typing it", async () => {
    // The bug this pins: the row drew the *committed* value, so the editor held
    // the text and the screen did not. It looked like a dead keyboard, and
    // nothing in the panel said otherwise.
    const { app, done } = await open();

    app.input.write("\u001b[B");
    await tick(20);
    app.input.write("\r"); // open the editor on Name
    await tick(25);
    app.input.write("cody-git");
    await tick(30);

    const screen = app.lastFrame();
    expect(screen).toContain("cody-git");
    // And the caret, after what has been typed rather than at the row's end.
    expect(screen).toContain("cody-git▌");
    // One caret, not two: the width measurement must not draw the caret the row
    // already places, or every field being typed into grows a second block.
    expect(screen).not.toContain("▌▌");
    await leave(app, done);
  });

  it("puts the caret where the edit is, not at the end of the row", async () => {
    const { app, done } = await open();

    app.input.write("\u001b[B");
    await tick(20);
    app.input.write("\r");
    await tick(25);
    app.input.write("cody-git");
    await tick(25);
    app.input.write("\u001b[D"); // left, to sit before the last character
    await tick(25);

    expect(app.lastFrame()).toContain("cody-gi▌t");
    await leave(app, done);
  });

  it("keeps the placeholder off the row being typed into", async () => {
    const { app, done } = await open();

    app.input.write("\u001b[B");
    await tick(20);
    app.input.write("\r"); // open the form, cursor on Name
    await tick(25);
    app.input.write("\r"); // and start editing it
    await tick(25);

    // The other empty fields keep saying "(empty)" — that is right. The one under
    // the cursor must not, because `(empty)` beside a live caret reads as a
    // value rather than as a hint.
    expect(app.lastFrame()).toContain("▌");
    expect(app.lastFrame()).not.toContain("(empty)▌");
    await leave(app, done);
  });

  it("shows only the line the caret is on, so a long field cannot break the card", async () => {
    const { app, done } = await open();

    app.input.write("\u001b[B");
    await tick(20);
    app.input.write("\r"); // open the form on Name
    await tick(25);
    app.input.write("one"); // Name → For, open for typing
    await tick(20);
    app.input.write("\r");
    await tick(20);
    app.input.write("\r"); // For → How it works, open for typing
    await tick(20);
    // Shift+Enter is the line break; Enter ends the field and steps on.
    app.input.write("AAA");
    await tick(20);
    app.input.write("\u001b[13;2u");
    await tick(25);
    app.input.write("BBB");
    await tick(30);

    // Two lines in the buffer; the row shows the one the caret is on, and the
    // line above it is nowhere on screen.
    expect(app.lastFrame()).toContain("BBB▌");
    expect(app.lastFrame()).not.toContain("AAA");
    for (const line of app.lastFrame().split(/\r?\n/)) expect(line.length).toBeLessThanOrEqual(80);
    await leave(app, done);
  });

  it("does not ask the panel what field it is on", async () => {
    // The bug this pins: `agentFieldKey()` read the field key out of the rendered
    // panel, and the panel's footer called `agentFieldKey()`. That loop blew the
    // stack, `draw()` threw, and the screen kept showing the last good frame —
    // which looks exactly like a form that ignores the keyboard. Nothing about
    // the failure names the cycle, so it needs a test that keeps rendering while
    // a field is being edited.
    const { app, done } = await open();

    app.input.write("\u001b[B");
    await tick(20);
    app.input.write("\r");
    await tick(25);
    app.input.write("\r"); // editing: the footer now asks for the field key
    await tick(25);
    app.input.write("cody-git");
    await tick(30);
    app.input.write("\u001b");
    await tick(90);

    // Still alive, still the same form, and the name survived the round trip.
    expect(app.lastFrame()).toContain("New subagent");
    expect(app.lastFrame()).toContain("cody-git");
    await leave(app, done);
  });

it("ends the field and steps to the next one on enter", async () => {
    // Filling a form should be typing, Enter, typing, Enter. Making the user
    // stop and press Escape between every field turns a five-field form into
    // twenty keystrokes of ceremony.
    const { app, done } = await open();

    app.input.write("\u001b[B");
    await tick(20);
    app.input.write("\r"); // open the form on Name
    await tick(25);
    app.input.write("cody-git");
    await tick(25);
    app.input.write("\r"); // end Name
    await tick(25);

    // The value is kept and the cursor is on the next field, editing.
    expect(app.lastFrame()).toContain("cody-git");
    expect(app.lastFrame()).toContain("enter next");

    app.input.write("GitHub work");
    await tick(25);
    app.input.write("\r"); // end For, on to How it works
    await tick(25);
    app.input.write("Branches and PRs.");
    await tick(25);
    app.input.write("\r");
    await tick(25);

    // Three fields filled by typing and Enter alone.
    expect(app.lastFrame()).toContain("GitHub work");
    expect(app.lastFrame()).toContain("Branches and PRs.");
    await leave(app, done);
  });

  it("carries every field's value through to the save", async () => {
    const own = await mkdtemp(path.join(tmpdir(), "kicode-agents-"));
    const previous = process.env.KICODE_HOME;
    process.env.KICODE_HOME = own;
    const { app, done } = await drive([], session([], own));

    app.input.write("/agents\r");
    await tick(25);
    app.input.write("\u001b[B");
    await tick(20);
    app.input.write("\r");
    await tick(25);
    app.input.write("cody-git");
    await tick(20);
    app.input.write("\r"); // → For
    await tick(20);
    app.input.write("GitHub and git work");
    await tick(20);
    app.input.write("\r"); // → How it works
    await tick(20);
    app.input.write("Review branches and PRs.");
    await tick(20);
    app.input.write("\r"); // → Model
    await tick(20);
    app.input.write("\r"); // → May edit files
    await tick(20);
    app.input.write("\u001b[C"); // flip the permission to yes
    await tick(20);
    app.input.write("\r"); // → Where
    await tick(20);
    app.input.write("\r"); // → Save
    await tick(20);
    app.input.write("\r");
    await tick(60);

    const written = JSON.parse(await readFile(path.join(own, "agents.json"), "utf8")) as {
      agents: Record<string, { description: string; instructions: string; permissions: string }>;
    };
    // Every field arrived, and the grant flipped on the way past.
    expect(written.agents["cody-git"]?.description).toBe("GitHub and git work");
    expect(written.agents["cody-git"]?.instructions).toBe("Review branches and PRs.");
    expect(written.agents["cody-git"]?.permissions).toBe("write");

    await leave(app, done);
    if (previous === undefined) delete process.env.KICODE_HOME;
    else process.env.KICODE_HOME = previous;
    await rm(own, { recursive: true, force: true });
  });

  it("keeps every row inside the card, toggle options included", async () => {
    // The bug: the card was sized from each field's *value*, but a toggle draws
    // both of its options. `Where` is worth "all projects" and renders
    // "[all projects] / this project", so the row spilled past the card's right
    // edge and the highlight ran off into the page.
    const { app, done } = await open();

    app.input.write("\u001b[B");
    await tick(20);
    app.input.write("\r");
    await tick(25);

    const lines = app.lastFrame().split(/\r?\n/);
    // The card's rows are the ones carrying its fill; find its left and right
    // edges from a row that is definitely inside it.
    const cardRows = lines.filter((line) => line.includes("May edit files") || line.includes("Where"));
    expect(cardRows.length).toBe(2);
    // The widest toggle renders in full, and nothing is longer than a terminal.
    expect(app.lastFrame()).toContain("[all projects] / this project");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    await leave(app, done);
  });

it("closes without saving when escape is pressed", async () => {
    const { app, done } = await open([profile()]);

    app.input.write("\r");
    await tick(25);
    expect(app.lastFrame()).toContain("Subagent · cody-git");

    await leave(app, done);
    // Back to the list, not the transcript.
    expect(app.screen()).toContain("Subagents");
  });

  it("draws inside the terminal on a short screen", async () => {
    const { app, done } = await open([profile()]);

    app.input.write("\u001b[B");
    await tick(20);
    app.input.write("\r");
    await tick(25);
    for (const line of app.lastFrame().split(/\r?\n/)) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    await leave(app, done);
  });
});

describe("the tab bar", () => {
  /** Two sessions for this directory, the first of them current. */
  const twoSessions: Partial<TuiOptions> = {
    listSessions: async () => [
      { id: "session-1", title: "this one" },
      { id: "session-2", title: "another one" },
    ],
    loadSession: async (id) =>
      id === "session-2"
        ? [
            { role: "user", content: "earlier work" },
            { role: "assistant", content: "done that" },
          ]
        : null,
  };

  /** A left click, in SGR encoding, at a 1-based column on the first row. */
  const click = (column: number): string => `\u001b[<0;${column};1M`;

  it("closes a tab when its close box is clicked", async () => {
    const app = harness(twoSessions);
    const done = runTui(app.options);
    await tick(15);

    // ` this one  ×  ` is 14 columns, so the second tab starts at 14 and its
    // × sits on 28 — column 29 to a terminal, which counts from one.
    app.input.write(click(29));
    await tick(30);

    expect(app.lastFrame()).toContain("this one");
    expect(app.lastFrame()).not.toContain("another one");
    // Nothing was deleted: the session is still there to reopen.
    expect(app.saves.some((save) => save.id === "session-2")).toBe(false);

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("switches tab when the body of one is clicked", async () => {
    const app = harness(twoSessions);
    const done = runTui(app.options);
    await tick(15);

    // Somewhere inside the second tab's title, not its close box.
    app.input.write(click(20));
    await tick(30);

    expect(app.screen()).toContain("earlier work");
    expect(app.built.at(-1)).toEqual([
      { role: "user", content: "earlier work" },
      { role: "assistant", content: "done that" },
    ]);

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("runs the learning pass on /learn, and says what it kept and what it skipped", async () => {
    // The automatic pass is silent by design — it exists to help a future
    // session and must never interrupt this one. Asking for it is the other
    // case, and then "nothing was added" is an answer the user is owed.
    const app = harness({}, {
      learn: {
        added: [{ kind: "skill", name: "git-bisect", text: "Find the commit that broke it: git bisect start, then mark good and bad." }],
        skipped: [{ kind: "memory", name: "kicode", text: "this was already recorded" }],
      },
    });
    const done = runTui(app.options);
    await tick(20);

    app.input.write("first\r");
    await tick(30);

    app.input.write("\u0015/learn\r");
    await tick(40);

    expect(app.lastFrame()).toContain("learned 1 thing(s)");
    expect(app.lastFrame()).toContain("git-bisect");
    expect(app.lastFrame()).toContain("already known");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("says so on /learn when there is no conversation to learn from", async () => {
    const app = harness({});
    const done = runTui(app.options);
    await tick(20);

    app.input.write("/learn\r");
    await tick(30);

    expect(app.lastFrame()).toContain("nothing to learn from yet");

    app.input.write("/exit\r");
    await done;
  });

  it("reads the brain back on /memory, from wherever KI_BRAIN_PATH points", async () => {
    // Pointed at a temporary brain so the answer is this test's rather than
    // whatever happens to be on the machine running it.
    const home = await mkdtemp(path.join(tmpdir(), "kicode-memory-"));
    const slug = projectSlug("C:\\dev\\projects\\kicode");
    await mkdir(path.join(home, "memories", "projects"), { recursive: true });
    await writeFile(path.join(home, "memories", "projects", `${slug}.md`), "# notes\n\n- prefers tabs\n", "utf8");

    const previous = process.env.KI_BRAIN_PATH;
    process.env.KI_BRAIN_PATH = home;
    try {
      const app = harness({});
      const done = runTui(app.options);
      await tick(20);

      app.input.write("/memory\r");
      await tick(30);

      // The text the agent is actually handed — not a description of it — and
      // then where it came from, which is what you want once you have read it.
      expect(app.lastFrame()).toContain("prefers tabs");
      expect(app.lastFrame()).toContain(`this directory is ${slug}`);
      expect(app.lastFrame()).toContain(`brain ${home}`.replace(/\\/g, "\\"));
      expect(app.lastFrame()).toContain("/memory full");

      app.input.write("\u0015/exit\r");
      await done;
    } finally {
      if (previous === undefined) delete process.env.KI_BRAIN_PATH;
      else process.env.KI_BRAIN_PATH = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("shows the tracked work a session already carries when it comes back", async () => {
    // The plan tools are built fresh with every agent, so a session being
    // switched back to knows nothing about its own checklist until it is read
    // back out of the transcript — which is exactly what the chip draws. This
    // was the "[TODO] sometimes not showing": the work was never lost, the
    // button just could not see it.
    const tracked: ChatMessage[] = [
      { role: "user", content: "tidy the repo" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "todo",
              arguments: JSON.stringify({ action: "add", items: ["read the config", "rename the flag"] }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "1. read the config\n2. rename the flag" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "todo", arguments: JSON.stringify({ action: "done", ids: [1] }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_2", content: "1. [x] read the config\n2. [ ] rename the flag" },
    ];

    const app = harness({
      listSessions: async () => [
        { id: "session-1", title: "this one" },
        { id: "session-2", title: "with a checklist" },
      ],
      loadSession: async (id) => (id === "session-2" ? tracked : null),
    });

    const done = runTui(app.options);
    await tick(15);
    // The session that is open tracks nothing, so there is no button at all.
    expect(app.lastFrame()).not.toContain("[TODO");

    app.input.write(click(20)); // over to the session with the checklist
    await tick(30);
    expect(app.lastFrame()).toContain("[TODO 1/2]");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("keeps a session's name after switching away and back", async () => {
    // A store that remembers whatever title a save carried, so `listSessions`
    // answers with the real one rather than a fixture's fixed string.
    const store = new Map<string, string>([
      ["session-1", "this one"],
      ["session-2", "another one"],
    ]);
    const app = harness({
      listSessions: async () => [...store].map(([id, title]) => ({ id, title })),
      loadSession: async (id) =>
        id === "session-2"
          ? [
              { role: "user" as const, content: "earlier work" },
              { role: "assistant" as const, content: "done that" },
            ]
          : [
              { role: "user" as const, content: "hello" },
              { role: "assistant" as const, content: "hi" },
            ],
      saveSession: async ({ id, title }) => {
        if (title) store.set(id, title);
      },
    });
    const done = runTui(app.options);
    await tick(15);

    app.input.write("hello\r");
    await tick(30);
    app.input.write("/rename renamed one\r");
    await tick(30);
    expect(store.get("session-1")).toBe("renamed one");

    app.input.write(click(20)); // away to the other session
    await tick(30);
    app.input.write(click(2)); // and back
    await tick(30);

    // The stored title comes back with the session rather than being re-derived
    // from its first message when the next turn saves it.
    app.input.write("again\r");
    await tick(30);
    expect(store.get("session-1")).toBe("renamed one");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("does not carry one session's queue into the next", async () => {
    const app = harness({ ...twoSessions }, { slow: 150 });
    const done = runTui(app.options);
    await tick(20);

    app.input.write("first\r");
    await tick(30);
    app.input.write("queued for the first\r");
    await tick(30);
    expect(app.lastFrame()).toContain("Queued (1)");

    // Let the turn and the queued prompt behind it run out first: a switch made
    // under a running turn is now deferred so the turn is not abandoned
    // (ADR-039), and what this test is about is the queue's isolation rather
    // than how fast the machine switched.
    await until(app, "echo: queued for the first");
    await tick(300);

    // What was queued behind this session's turn belongs to this session: the
    // one being opened must not inherit it.
    app.input.write(click(20));
    await tick(40);
    expect(app.lastFrame()).toContain("earlier work");
    expect(app.lastFrame()).not.toContain("Queued (1)");
    expect(app.lastFrame()).not.toContain("queued for the first");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("closes the current tab with ctrl+w, and leaves a fresh session if it was the last", async () => {
    const app = harness({ listSessions: async () => [{ id: "session-1", title: "this one" }] });
    const done = runTui(app.options);
    await tick(15);

    app.input.write("hello\r");
    await tick(30);
    app.input.write("\u0017");
    await tick(30);

    // The conversation went to disk on the way out…
    expect(app.saves.at(0)?.messages).toHaveLength(2);
    // …and the screen is a new session, not an empty frame.
    expect(app.lastFrame()).not.toContain("echo: hello");

    app.input.write("/status\r");
    await tick(30);
    expect(app.screen()).toContain("0 messages");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("starts a new session from the button in the tab bar", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick(15);

    app.input.write("hello\r");
    await tick(30);
    // ` new session  ×  ` is 17 columns, so `+NEW` sits on 17–20 — column 19
    // to a terminal, which counts from one.
    app.input.write(click(19));
    await tick(30);

    expect(app.screen()).toContain("new session");
    expect(app.lastFrame()).not.toContain("echo: hello");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("marks the tab in front, so a restart can return to it", async () => {
    const marked: Array<{ cwd: string; id: string }> = [];
    const app = harness({
      saveActiveSession: async (cwd, id) => {
        marked.push({ cwd, id });
      },
    });
    const done = runTui(app.options);
    await tick(20);

    app.input.write("hello\r");
    await tick(30);
    // A new front tab: the pointer moves at once, not only at exit — a crash
    // between the switch and the quit would otherwise lose it.
    app.input.write("/new\r");
    await tick(30);
    expect(marked.at(-1)).toEqual({ cwd: "C:\\dev\\projects\\kicode", id: "session-new" });

    app.input.write("second hello\r");
    await tick(30);
    app.input.write("/exit\r");
    expect(await done).toBe(0);
    // And the quit leaves the pointer on the tab that was in front.
    expect(marked.at(-1)).toEqual({ cwd: "C:\\dev\\projects\\kicode", id: "session-new" });
  });

  it("clears the remembered tab when its session is deleted", async () => {
    const cleared: Array<{ cwd: string; id: string }> = [];
    const app = harness({
      // Two sessions: the picker never lists the one on screen, so the row
      // under the cursor is the other one.
      listSessions: async () => [
        { id: "session-1", title: "this one" },
        { id: "session-2", title: "the other one" },
      ],
      clearActiveSession: async (cwd, id) => {
        cleared.push({ cwd, id });
      },
    });
    const done = runTui(app.options);
    await tick(20);

    // The picker's own delete key, which is the supported path: typing
    // `/delete-session <id>` by hand goes through the palette, which drops a
    // typed argument when it fills the command in.
    app.input.write("/sessions\r");
    await tick(30);
    app.input.write("");
    await tick(30);

    expect(cleared).toEqual([{ cwd: "C:\\dev\\projects\\kicode", id: "session-2" }]);

    await finish(app, done);
  });

  it("keeps a running turn going in the background when a new session is opened", async () => {
    // Generous for the same reason the queue tests are: what matters is a turn
    // still running when the click arrives, which is the one thing a loaded
    // machine cannot be trusted to hold to.
    const app = harness({}, { slow: 1_200 });
    const done = runTui(app.options);
    await tick(20);

    app.input.write("hello\r");
    await tick(40);

    // `+NEW` mid-turn. This used to wait for the turn to finish before moving.
    // Now the turn belongs to the session that started it, so the old session
    // is parked and finishes there while the user works on the new one.
    app.input.write(click(19));
    await tick(40);

    // The switch happened at once — no waiting — and the tab shows the session
    // still working behind the new one.
    expect(app.lastFrame()).not.toContain("switching when it finishes");
    expect(app.lastFrame()).not.toContain("echo: hello");
    expect(app.lastFrame()).toContain("◐");

    await tick(1_600);
    app.input.write("\u0015/exit\r");
    expect(await done).toBe(0);

    // The turn finished and its own session kept the answer.
    expect(
      app.saves.some((save) =>
        save.messages.some(
          (message) => message.role === "assistant" && String(message.content).includes("echo: hello"),
        ),
      ),
    ).toBe(true);
  });

  it("drains a background session's queue without waiting for a visit", async () => {
    const app = harness({}, { slow: 250 });
    const done = runTui(app.options);
    await tick(20);

    app.input.write("first\r");
    await tick(40);
    // Queued while the first turn runs, so it belongs to session-1's queue.
    app.input.write("second\r");
    await tick(20);

    // Leave for a new session; session-1 keeps its turn and its queue, and works
    // through both on its own.
    app.input.write(click(19));
    await tick(1_400);

    app.input.write("\u0015/exit\r");
    expect(await done).toBe(0);

    // Both answers were saved under session-1, while the user was in
    // session-new the whole time.
    const text = app.saves
      .filter((save) => save.id === "session-1")
      .flatMap((save) => save.messages.map((message) => String(message.content)))
      .join("\n");
    expect(text).toContain("echo: first");
    expect(text).toContain("echo: second");
  });

  it("marks only the session running a goal as Goal", async () => {
    // A goal belongs to one session. A global flag made a second session show
    // [GOAL] for work it had nothing to do with.
    const app = harness({}, { slow: 500 });
    const done = runTui(app.options);
    await tick(20);

    app.input.write("/goal ship it\r");
    await tick(60);
    expect(app.lastFrame()).toContain("[GOAL]");

    // Leave while the goal runs: this session is not the one in a goal.
    app.input.write(click(19));
    await tick(40);
    expect(app.lastFrame()).not.toContain("[GOAL]");

    // The goal finishes off screen. Coming back, it is a session again — not
    // stuck as Goal forever, which a flag only cleared on screen would do.
    await tick(900);
    app.input.write(click(24));
    await tick(40);
    expect(app.lastFrame()).not.toContain("[GOAL]");

    app.input.write("\u0015/exit\r");
    expect(await done).toBe(0);
  });

  it("does not drain a paused session's queue while it is in the background", async () => {
    const app = harness({}, { slow: 250 });
    const done = runTui(app.options);
    await tick(20);

    app.input.write("first\r");
    await tick(40);
    app.input.write("second\r");
    await tick(20);
    // Pausing stops the turn and holds what was queued behind it.
    app.input.write("pause\r");
    await tick(20);

    // Leave the paused session: a pause is a decision, wherever you are looking.
    app.input.write(click(19));
    await tick(600);

    expect(app.sentPrompts).not.toContain("second");

    app.input.write("\u0015/exit\r");
    expect(await done).toBe(0);
  });

  it("auto-denies an approval for a turn in a background session", async () => {
    const app = harness({}, { slow: 400, approve: true });
    const done = runTui(app.options);
    await tick(20);

    app.input.write("hello\r");
    await tick(40);
    // Leave mid-turn, before the approval the turn is about to ask for.
    app.input.write(click(19));

    await until(app, "bash needs approval, denied");

    // Denied, not raised: the session on screen must never see a card meant for
    // the one left running behind it.
    expect(app.decisions).toContain("deny");
    expect(app.screen()).not.toContain("wants to run");

    app.input.write("\u0015/exit\r");
    expect(await done).toBe(0);
  });

  it("skips a question asked by a turn in a background session", async () => {
    const question: AskQuestion = { header: "Pick", question: "Which one?", options: [{ label: "A" }, { label: "B" }] };
    const app = harness({}, { slow: 400, questions: [question] });
    const done = runTui(app.options);
    await tick(20);

    app.input.write("hello\r");
    await tick(40);
    app.input.write(click(19));

    await until(app, "a question was skipped");

    // Dismissed rather than shown: the turn carries on with no answer instead
    // of stalling on a prompt nobody can see.
    expect(app.replies.some((reply) => reply.every((answer) => answer.dismissed))).toBe(true);
    expect(app.screen()).not.toContain("Which one?");

    app.input.write("\u0015/exit\r");
    expect(await done).toBe(0);
  });

  it("keeps a parked session's own mode when another session changes its own", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick(20);

    // Session-1 goes to plan mode.
    app.input.write("\u001b[Z");
    await tick(20);
    expect(app.lastFrame()).toContain("[PLAN]");

    // A new session inherits what was on screen…
    app.input.write(click(19));
    await tick(30);
    expect(app.lastFrame()).toContain("[PLAN]");

    // …and moving its mode must not reach back into the parked session.
    app.input.write("\u001b[Z");
    await tick(20);
    expect(app.lastFrame()).toContain("[BUILD]");

    // Back to session-1 — its own mode, not the one session-new moved to.
    app.input.write(click(24));
    await tick(30);
    expect(app.lastFrame()).toContain("[PLAN]");

    app.input.write("\u0015/exit\r");
    expect(await done).toBe(0);
  });

  it("keeps a parked session's own directory when another session changes its own", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "kicode-cwd-"));
    await mkdir(path.join(home, "inner"));
    const app = harness({ cwd: home });
    const done = runTui(app.options);
    await tick(20);

    // Session-1 moves into a subdirectory.
    app.input.write("/cd inner\r");
    await tick(30);
    expect(app.lastFrame()).toContain("inner");

    // A new session inherits the directory…
    app.input.write(click(19));
    await tick(30);

    // …leaves it, and session-1 must still be inside it on return.
    app.input.write("/cd ..\r");
    await tick(30);
    expect(app.lastFrame()).not.toContain("inner");

    app.input.write(click(24));
    await tick(30);
    expect(app.lastFrame()).toContain("inner");

    app.input.write("\u0015/exit\r");
    expect(await done).toBe(0);
    await rm(home, { recursive: true, force: true });
  });

  it("restores a session's own settings when switching to it", async () => {
    const app = harness({
      listSessions: async () => [
        {
          id: "session-2",
          title: "second",
          model: "other-model",
          baseUrl: "https://other.example/v1",
          mode: "plan",
          variant: "high",
        },
      ],
      loadSession: async () => [{ role: "user", content: "hi" }],
    });
    const done = runTui(app.options);
    await tick(20);

    // ` new session  ×  ` is 17 columns, so the second tab starts at column 17.
    app.input.write(click(24));
    await tick(30);

    // The session came back on the settings it was saved with, not the ones this
    // run started on — model, endpoint, mode and variant all of them.
    expect(app.settings.at(-1)?.model).toBe("other-model");
    expect(app.settings.at(-1)?.baseUrl).toBe("https://other.example/v1");
    expect(app.settings.at(-1)?.mode).toBe("plan");
    expect(app.settings.at(-1)?.variant).toBe("high");
    expect(app.lastFrame()).toContain("[PLAN]");

    app.input.write("\u0015/exit\r");
    expect(await done).toBe(0);
  });

  it("scrolls the transcript with the wheel", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick(15);

    // Enough turns that there is somewhere to scroll to.
    for (const prompt of ["one", "two", "three", "four", "five", "six", "seven", "eight"]) {
      app.input.write(`${prompt}\r`);
      await tick(30);
    }

    app.input.write("\u001b[<64;10;12M");
    await tick(30);
    const scrolled = app.lastFrame();
    app.input.write("\u001b[<65;10;12M");
    await tick(30);

    // Up shows older lines; back down returns to the tail.
    expect(scrolled).not.toBe(app.lastFrame());

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("opens a context menu when a tab is right-clicked", async () => {
    const app = harness(twoSessions);
    const done = runTui(app.options);
    await tick(15);

    // Right-click on the second tab (column 20)
    app.input.write("\u001b[<2;20;1M");
    await tick(30);

    expect(app.lastFrame()).toContain("Tab: another one");
    expect(app.lastFrame()).toContain("Close Tab");
    expect(app.lastFrame()).toContain("Close Others");

    // Press enter on Close Tab
    app.input.write("\r");
    await tick(30);

    expect(app.lastFrame()).not.toContain("another one");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("stops a running turn when the session it is in is deleted", async () => {
    const app = harness(twoSessions, { slow: 1_200 });
    const done = runTui(app.options);
    await tick(20);

    app.input.write("hello\r");
    await tick(40);

    // Right-click the current tab, move to Delete Session, and pick it.
    app.input.write("\u001b[<2;5;1M");
    await tick(30);
    for (let i = 0; i < 4; i += 1) {
      app.input.write("\u001b[B");
      await tick(10);
    }
    app.input.write("\r");
    await tick(60);

    // The work stopped: there is no file left for its answer to go to.
    expect(app.cancels).toBe(1);

    app.input.write("\u0015/exit\r");
    expect(await done).toBe(0);
  });

  it("keeps a running turn's answer when its tab is closed", async () => {
    const app = harness(twoSessions, { slow: 1_200 });
    const done = runTui(app.options);
    await tick(20);

    app.input.write("hello\r");
    await tick(40);

    // Right-click the current tab and choose Close Tab (the first row).
    app.input.write("\u001b[<2;5;1M");
    await tick(30);
    app.input.write("\r");
    await tick(60);

    await tick(1_600);
    app.input.write("\u0015/exit\r");
    expect(await done).toBe(0);

    // Closing hides a tab; it does not throw the work away — the answer still
    // lands in the session that was closed.
    const closed = app.saves
      .filter((save) => save.id === "session-1")
      .flatMap((save) => save.messages.map((message) => String(message.content)))
      .join("\n");
    expect(closed).toContain("echo: hello");
  });

  it("updates hover state when moving mouse over tabs", async () => {
    const app = harness(twoSessions);
    const done = runTui(app.options);
    await tick(15);

    // Hover motion over second tab
    app.input.write("\u001b[<35;20;1M");
    await tick(30);

    // Frame re-renders with hover styling
    expect(app.lastFrame()).toContain("another one");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("takes the mouse only while it owns the screen", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick(15);

    expect(app.raw()).toContain("\u001b[?1000h");
    app.input.write("\u0003");
    await done;

    // Handing the mouse back is what lets the user select text again.
    expect(app.raw()).toContain("\u001b[?1000l");
  });
});

describe("the slash commands", () => {
  /**
   * Closes whatever is open, clears the line and quits. Escape first, because a
   * picker or a panel swallows typing — and the line has to be cleared, because
   * an unknown command leaves its text behind to be corrected.
   */
  const finish = async (app: Harness, done: Promise<number>): Promise<void> => {
    app.input.write("\u001b");
    await tick(60);
    app.input.write("\u0015/exit\r");
    await done;
  };

  it("switches to plan mode on shift+tab, and back to build", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick();

    // Shift+Tab is CSI Z on the wire.
    app.input.write("\u001b[Z");
    await tick(30);

    // The mode is a capability, so it is the agent that has to change, not a
    // word on the status row.
    expect(app.settings.at(-1)?.mode).toBe("plan");
    expect(app.screen()).toContain("plan mode");
    expect(app.lastFrame()).toContain("[PLAN]");

    app.input.write("\u001b[Z");
    await tick(30);

    expect(app.settings.at(-1)?.mode).toBe("build");
    expect(app.lastFrame()).toContain("[BUILD]");

    await finish(app, done);
  });

  it("switches mode from /mode, naming it in the pill", async () => {
    const { app, done } = await drive(["/mode plan"]);
    await tick(20);

    expect(app.settings.at(-1)?.mode).toBe("plan");
    // The word is in the pill, where the mode lives while there is a box…
    expect(app.lastFrame()).toContain("[PLAN]");
    // …and the announcement is transient: a line per keypress would bury the
    // conversation it is meant to accompany.
    expect(app.saves).toHaveLength(0);

    await finish(app, done);
  });

  it("opens a picker from /mode when it is given no argument", async () => {
    const { app, done } = await drive(["/mode"]);

    expect(app.lastFrame()).toContain("Mode");
    expect(app.lastFrame()).toContain("Build");

    app.input.write("\u001b[B\r");
    await tick(30);

    expect(app.settings.at(-1)?.mode).toBe("plan");

    await finish(app, done);
  });

  it("rejects a mode it does not have", async () => {
    const { app, done } = await drive(["/mode sideways"]);
    await tick(20);

    expect(app.screen()).toContain("usage: /mode [build|plan]");
    expect(app.settings.at(-1)?.mode).toBe("build");

    await finish(app, done);
  });

  it("shows a new favorite in the list as it happens, without moving the cursor", async () => {
    const saved: ModelRef[][] = [];
    const app = harness({
      listModels: async () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      favorites: {
        list: async () => [],
        save: async (favorites) => {
          saved.push([...favorites]);
        },
      },
    });
    const done = runTui(app.options);
    await tick();

    app.input.write("/models\r");
    await tick(40);
    // Move onto m2 before favouriting it.
    app.input.write("\u001b[B");
    await tick(20);
    // The cursor is on m2: the row the keys act on is the row that is filled.
    const fill = buildStyles(themeByName(DEFAULT_THEME)).paletteSelected;
    expect(painted(app)).toContain(`${fill}m2`);
    expect(app.lastFrame()).not.toContain("Favorites");

    app.input.write("\u0006");
    await tick(30);

    // The group appears in the open list, not only on the next open…
    expect(app.lastFrame()).toContain("Favorites");
    // …and the cursor followed the row that moved rather than an index.
    expect(painted(app)).toContain(`${fill}m2`);
    expect(saved.at(-1)).toEqual([{ baseUrl: "https://api.example/v1", model: "m2" }]);

    await finish(app, done);
  });

  it("favorites the highlighted model with ctrl+f, and keeps the list open", async () => {
    const saved: ModelRef[][] = [];
    const app = harness({
      listModels: async () => [{ id: "m1" }, { id: "m2" }],
      favorites: {
        list: async () => [],
        save: async (favorites) => {
          saved.push([...favorites]);
        },
      },
    });
    const done = runTui(app.options);
    await tick();

    app.input.write("/models\r");
    await tick(40);
    app.input.write("\u0006");
    await tick(30);

    expect(app.screen()).toContain("favorited m1");
    expect(saved.at(-1)).toEqual([{ baseUrl: "https://api.example/v1", model: "m1" }]);
    // Marking a model to keep must not throw away the search that found it.
    expect(app.lastFrame()).toContain("Select model");

    await finish(app, done);
  });

  it("shows stored favorites as their own group", async () => {
    const app = harness({
      listModels: async () => [{ id: "m1" }, { id: "m2" }],
      favorites: {
        list: async () => [{ baseUrl: "https://api.example/v1", model: "m2" }],
        save: async () => undefined,
      },
    });
    const done = runTui(app.options);
    await tick();

    app.input.write("/models\r");
    await tick(40);

    expect(app.lastFrame()).toContain("Favorites");
    expect(app.lastFrame()).toContain("ctrl+f");

    await finish(app, done);
  });

  it("does not offer favoriting when this run has no store", async () => {
    const { app, done } = await drive(["/models"], { listModels: async () => [{ id: "m1" }] });

    expect(app.lastFrame()).toContain("m1");
    expect(app.screen()).not.toContain("ctrl+f");

    await finish(app, done);
  });

  it("holds a key until the list it was aimed at exists", async () => {
    // The list is a round trip (or a directory read), and Enter arrives while
    // it is still in flight. Reading the two chunks at once looked at the key
    // before there was a list to pick from and dropped it — which is exactly
    // what "Enter does nothing" looks like.
    const app = harness({
      listModels: async () => {
        await tick(80);
        return [{ id: "m1" }, { id: "m2" }];
      },
    });
    const done = runTui(app.options);
    await tick();

    app.input.write("/models\r");
    // Nothing to pick from yet: this is the Enter the old code threw away.
    await tick(20);
    app.input.write("\r");
    await tick(160);

    await finish(app, done);

    expect(app.settings.at(-1)?.model).toBe("m1");
  });

  it("attaches the clipboard's image to the next prompt, and only that one", async () => {
    const image: PastedImage = { data: "AAAA", mime: "image/png", bytes: 4096 };
    // Written key by key rather than through `drive`, which ends every line
    // with an Enter — the point is that the paste and the prompt are separate.
    const app = harness({ readClipboard: async () => ({ kind: "image", image }) });
    const done = runTui(app.options);
    await tick();

    app.input.write("look at this");
    await tick(20);
    app.input.write("\u0016");
    await tick(40);
    app.input.write("\r");
    await tick(40);
    app.input.write("and now?\r");
    await tick(40);

    await finish(app, done);

    expect(app.screen()).toContain("attached image 1");
    expect(app.screen()).toContain("[1 image] look at this");
    // It went with the prompt that followed it; the turn after is words again.
    expect(app.sentImages[0]).toEqual([image]);
    expect(app.sentImages[1]).toEqual([]);
  });

  it("renders [Image 1] chip in the prompt line when an image is attached and removes on backspace", async () => {
    const image: PastedImage = { data: "AAAA", mime: "image/png", bytes: 4096 };
    const app = harness({ readClipboard: async () => ({ kind: "image", image }) });
    const done = runTui(app.options);
    await tick();

    // Paste image with ctrl+v
    app.input.write("\u0016");
    await tick(30);

    expect(app.lastFrame()).toContain("[Image 1]");

    // Backspace on empty prompt removes the image badge
    app.input.write("\x7f");
    await tick(30);

    expect(app.lastFrame()).not.toContain("[Image 1]");

    app.input.write("/exit\r");
    await done;
  });

  it("says so when the clipboard is empty", async () => {
    const { app, done } = await drive(["hello\u0016"], { readClipboard: async () => ({ kind: "empty" }) });
    await finish(app, done);

    expect(app.screen()).toContain("the clipboard is empty");
  });

  it("pastes clipboard text onto the prompt line, the way ctrl+v means everywhere", async () => {
    const { app, done } = await drive(["\u0016"], {
      readClipboard: async () => ({ kind: "text", text: "why is bash failing here", truncated: false }),
    });
    await finish(app, done);

    expect(app.screen()).toContain("echo: why is bash failing here");
    // Text belongs in the prompt, not in the attachment list.
    expect(app.sentImages[0]).toEqual([]);
  });

  it("says when it pasted only part of a long clipboard", async () => {
    const app = harness({ readClipboard: async () => ({ kind: "text", text: "x".repeat(100_000), truncated: true }) });
    const done = runTui(app.options);
    await tick();

    app.input.write("\u0016");
    await until(app, "pasted the first 100000 characters");
    await finish(app, done);

    expect(app.screen()).toContain("pasted the first 100000 characters");
  });

  it("pastes the clipboard on /paste too, for keyboards ctrl+v does not reach", async () => {
    const { app, done } = await drive(["/paste"], {
      readClipboard: async () => ({ kind: "text", text: "from the palette", truncated: false }),
    });
    await tick(20);
    app.input.write("\r");
    await finish(app, done);

    expect(app.screen()).toContain("echo: from the palette");
  });

  it("previews each theme as the list is walked, and puts the old one back on escape", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick();

    app.input.write("/themes\r");
    await tick(30);

    // The list names every theme, and marks the one in use.
    const opened = app.screen();
    for (const name of themeNames()) expect(opened).toContain(name);
    expect(app.lastFrame()).toContain(`● ${DEFAULT_THEME}`);
    expect(painted(app)).toContain(bg(themeByName(DEFAULT_THEME).bg));

    // The second theme is the one below it, so one press walks onto it — and
    // the whole screen repaints in it, which is the point of a preview.
    app.input.write("\u001b[B");
    await tick(30);
    expect(painted(app)).toContain(bg(themeByName("dark").bg));

    // Leaving without choosing is not a choice: the screen goes back. A lone
    // escape is held for its grace period before it counts as one.
    app.input.write("\u001b");
    await tick(60);
    expect(painted(app)).toContain(bg(themeByName(DEFAULT_THEME).bg));
    expect(painted(app)).not.toContain(bg(themeByName("dark").bg));

    await finish(app, done);
  });

  it("adopts the theme it was given, and writes it down", async () => {
    const { app, done } = await drive(["/themes nord"]);
    await tick(20);

    expect(app.screen()).toContain("theme nord");
    expect(painted(app)).toContain(bg(themeByName("nord").bg));
    // `/themes` and the settings panel keep the same key, so a theme chosen
    // from either one survives the run.
    expect(app.viewSaves).toEqual([{ theme: "nord" }]);

    await finish(app, done);
  });

  it("refuses a theme it does not have, and names the ones it does", async () => {
    const { app, done } = await drive(["/themes chartreuse"]);
    await tick(20);

    const screen = app.screen();
    // The list wraps at this width, so only its first word is certain.
    expect(screen).toContain("usage: /themes");
    expect(screen).toContain("tokyo-night");
    // The theme in use is untouched by a typo.
    expect(painted(app)).toContain(bg(themeByName(DEFAULT_THEME).bg));

    await finish(app, done);
  });

  it("lists each route's state and reason on /routes, marking the one in use", async () => {
    let flushed = 0;
    const { app, done } = await drive(["/routes"], {
      routeHealth: {
        list: async () => [
          {
            ref: { baseUrl: "https://api.example/v1", model: "deepseek-v4-flash:free" },
            state: "capped",
            detail: "out of quota (0 of 50 requests left), resets in 1h 0m",
          },
          {
            ref: { baseUrl: "https://gw.example/v1", model: "only" },
            state: "broken",
            detail: "will not answer: the key was refused (HTTP 403) (just now)",
          },
        ],
        flush: async () => {
          flushed += 1;
        },
      },
    });
    await tick(20);

    const screen = app.screen();
    expect(screen).toContain("route health — 2 routes remembered on this machine");
    // In fragments, because a row wraps at the transcript column's width and a
    // whole line asserted here would make this a test about the gutter rather
    // than about `/routes`.
    expect(screen).toContain("deepseek-v4-flash:free @ api.example — capped (in use)");
    expect(screen).toContain("out of quota");
    expect(screen).toContain("resets in 1h 0m");
    expect(screen).toContain("only @ gw.example — broken · will not answer: the key was refused");
    expect(screen).toContain("just now");

    await finish(app, done);
    // The debounce batches writes; it is not a reason to lose them on the way out.
    expect(flushed).toBeGreaterThan(0);
  });

  it("says route health is unknown rather than inventing a state", async () => {
    const { app, done } = await drive(["/routes"], { routeHealth: { list: async () => [], flush: async () => undefined } });
    await tick(20);

    expect(app.screen()).toContain("nothing recorded yet — the file fills in as requests are made");

    await finish(app, done);
  });

  it("says so when this run is not recording route health at all", async () => {
    const { app, done } = await drive(["/routes"]);
    await tick(20);

    expect(app.screen()).toContain("route health is not being recorded in this run");

    await finish(app, done);
  });

  it("completes @ mentions and expands them into context on submit", async () => {
    // A tiny directory, not the repo: the walk over `process.cwd()` is what
    // made Tab arrive before the list existed (and made the test about how
    // many files the checkout has rather than about `@`).
    const dir = await mkdtemp(path.join(tmpdir(), "kicode-mention-"));
    await mkdir(path.join(dir, "src", "tui"), { recursive: true });
    await writeFile(path.join(dir, "src", "tui", "frame.test.ts"), "// mention fixture\n");
    try {
      const { app, done } = await drive([], { cwd: dir });
      // The index is warmed on startup in the background; give slow CI room
      // to finish the walk before the query is typed.
      await tick(120);

      app.input.write("@frame.test");
      // Poll rather than a fixed sleep: suite load stalls a single tick.
      let opened = false;
      for (let i = 0; i < 30 && !opened; i++) {
        await tick(40);
        opened = app.lastFrame().includes("src/tui/frame.test.ts");
      }
      // The list offers the file the query names.
      expect(app.lastFrame()).toContain("src/tui/frame.test.ts");

      // Tab accepts the highlighted row back into the prompt.
      app.input.write("\t");
      await tick(40);
      expect(app.lastFrame()).toContain("@src/tui/frame.test.ts");

      app.input.write(" read this\r");
      await tick(80);
      // The model receives the file's contents after the words…
      expect(app.screen()).toContain("Context from @src/tui/frame.test.ts");
      // …while the transcript keeps exactly what was typed.
      expect(app.screen()).toContain("read this");

      app.input.write("\u0015/exit\r");
      await done;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("attaches a document through the [+] button's file picker and sends it as context", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kicode-attach-"));
    const notes = path.join(dir, "notes.md");
    await writeFile(notes, "# Notes\nthe fixture body\n");
    try {
      const { app, done } = await drive([], {
        cwd: dir,
        // The platform's file-selection window, faked: the click on [+] opens
        // it, and "choosing" notes.md is what this test's dialog returns.
        pickFile: async () => { return { path: notes }; },
      });

      await tick(60);
      const frame = app.lastFrame();
      const promptRow = frame.split(/\r?\n/).findIndex((line) => line.includes("[+]")) + 1;
      const plusCol = (frame.split(/\r?\n/)[promptRow - 1] ?? "").indexOf("[+]") + 2;
      app.input.write(clickAt(promptRow, plusCol));
      // Poll rather than a fixed sleep: suite load stalls a single tick.
      let attached = false;
      for (let i = 0; i < 30 && !attached; i++) {
        await tick(40);
        attached = app.lastFrame().includes("[notes.md]");
      }
      // The badge says what is waiting to be sent.
      expect(app.lastFrame()).toContain("[notes.md]");

      app.input.write("summarise this\r");
      await tick(80);
      // The model receives the file's text in a named block…
      expect(app.sentPrompts.at(-1)).toContain('Context from attached file "notes.md"');
      expect(app.sentPrompts.at(-1)).toContain("the fixture body");
      // …and the transcript keeps the words that were typed, plus the marker.
      expect(app.screen()).toContain("summarise this");
      expect(app.screen()).toContain("[notes.md]");

      app.input.write("\u0015/exit\r");
      await done;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cycles the mode from the pill in the prompt box", async () => {
    const { app, done } = await drive([]);
    await tick(30);

    // The pill is a button, so the mode is not the keyboard's alone.
    expect(app.lastFrame()).toContain("[BUILD]");
    clickOn(app, "[BUILD]");
    await tick(40);

    expect(app.settings.at(-1)?.mode).toBe("plan");
    expect(app.lastFrame()).toContain("[PLAN]");

    // And back: it is a cycle, not a one-way switch.
    clickOn(app, "[PLAN]");
    await tick(40);

    expect(app.settings.at(-1)?.mode).toBe("build");
    expect(app.lastFrame()).toContain("[BUILD]");

    await finish(app, done);
  });

  it("leaves the prompt untouched when the file picker is cancelled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kicode-attach-"));
    try {
      const { app, done } = await drive([], { cwd: dir, pickFile: async () => null });

      await tick(60);
      const frame = app.lastFrame();
      const promptRow = frame.split(/\r?\n/).findIndex((line) => line.includes("[+]")) + 1;
      const plusCol = (frame.split(/\r?\n/)[promptRow - 1] ?? "").indexOf("[+]") + 2;
      app.input.write(clickAt(promptRow, plusCol));
      await tick(60);
      // A closed dialog is not an error: nothing attached, nothing announced.
      expect(app.lastFrame()).not.toContain("[notes.md]");
      expect(app.lastFrame()).not.toContain("could not attach");

      app.input.write("\u0015/exit\r");
      await done;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("asks for a path in the prompt when no file picker is available", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kicode-attach-"));
    await writeFile(path.join(dir, "notes.md"), "# Notes\nthe fixture body\n");
    try {
      const { app, done } = await drive([], { cwd: dir });

      await tick(60);
      const frame = app.lastFrame();
      const promptRow = frame.split(/\r?\n/).findIndex((line) => line.includes("[+]")) + 1;
      const plusCol = (frame.split(/\r?\n/)[promptRow - 1] ?? "").indexOf("[+]") + 2;
      app.input.write(clickAt(promptRow, plusCol));
      // Poll rather than a fixed sleep: suite load stalls a single tick.
      let opened = false;
      for (let i = 0; i < 30 && !opened; i++) {
        await tick(40);
        opened = app.lastFrame().includes("Attach a file");
      }
      // The fallback is the prompt-input box, not a dead click.
      expect(app.lastFrame()).toContain("Attach a file");

      app.input.write(`notes.md\r`);
      // Poll rather than a fixed sleep: suite load stalls a single tick.
      let attached2 = false;
      for (let i = 0; i < 30 && !attached2; i++) {
        await tick(40);
        attached2 = app.lastFrame().includes("[notes.md]");
      }
      expect(app.lastFrame()).toContain("[notes.md]");

      app.input.write("\u0015\u0015/exit\r");
      await done;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a bad attach path instead of swallowing it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kicode-attach-"));
    try {
      const { app, done } = await drive([], {
        cwd: dir,
        pickFile: async () => ({ path: path.join(dir, "nope.txt") }),
      });

      await tick(60);
      const frame = app.lastFrame();
      const promptRow = frame.split(/\r?\n/).findIndex((line) => line.includes("[+]")) + 1;
      const plusCol = (frame.split(/\r?\n/)[promptRow - 1] ?? "").indexOf("[+]") + 2;
      app.input.write(clickAt(promptRow, plusCol));
      // Poll rather than a fixed sleep: suite load stalls a single tick.
      let reported = false;
      for (let i = 0; i < 30 && !reported; i++) {
        await tick(40);
        reported = app.screen().includes("could not attach");
      }
      expect(app.screen()).toContain("could not attach");
      expect(app.screen()).toContain("no file at");

      app.input.write("\u0015/exit\r");
      await done;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("closes the @ list on escape without touching the prompt", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kicode-mention-"));
    await mkdir(path.join(dir, "src", "tui"), { recursive: true });
    await writeFile(path.join(dir, "src", "tui", "frame.test.ts"), "// mention fixture\n");
    try {
      const { app, done } = await drive([], { cwd: dir });
      await tick(120);

      app.input.write("@frame.test");
      let opened = false;
      for (let i = 0; i < 30 && !opened; i++) {
        await tick(40);
        opened = app.lastFrame().includes("src/tui/frame.test.ts");
      }
      expect(app.lastFrame()).toContain("src/tui/frame.test.ts");

      app.input.write("\u001b");
      await tick(80);
      expect(app.lastFrame()).not.toContain("src/tui/frame.test.ts");

      app.input.write("\u0015/exit\r");
      await done;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("moves the palette selection with the wheel", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick();

    // "/b" narrows the palette to btw then budget; the highlight starts on
    // the first row, the way the arrow keys find it.
    app.input.write("/b");
    await tick(30);
    expect(app.lastFrame()).toContain("/btw");

    // One wheel notch moves one row, onto budget.
    app.input.write("\u001b[<65;10;12M");
    await tick(30);
    app.input.write("\r");
    await tick(30);

    // /budget with no argument reports where the session stands — enough to
    // prove the wheel, not the arrows, chose the command.
    expect(app.lastFrame()).toContain("budget none");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("moves a picker selection with the wheel", async () => {
    const app = harness({ listModels: async () => [{ id: "m1" }, { id: "m2" }] });
    const done = runTui(app.options);
    await tick();

    app.input.write("/models\r");
    await tick(40);
    expect(app.lastFrame()).toContain("m1");

    // One notch down moves one row, onto m2.
    app.input.write("\u001b[<65;10;12M");
    await tick(30);
    app.input.write("\r");
    await tick(40);

    expect(app.settings.at(-1)?.model).toBe("m2");

    app.input.write("\u001b");
    await tick(60);
    app.input.write("\u0015/exit\r");
    await done;
  });

  it("lists brain skills from /skills and inserts the chosen one as a mention", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kicode-skills-"));
    await mkdir(path.join(dir, "ki-agent-brain", "skills", "demo"), { recursive: true });
    await writeFile(
      path.join(dir, "ki-agent-brain", "skills", "demo", "SKILL.md"),
      "---\nname: demo-skill\ndescription: Does a demo.\n---\n\nDemo skill body.\n",
    );
    try {
      const { app, done } = await drive([], { cwd: dir });
      await tick(120);

      app.input.write("/skills\r");
      await tick(60);
      expect(app.lastFrame()).toContain("demo-skill");

      // Choosing the row writes the mention back into the prompt…
      app.input.write("\r");
      await tick(40);
      expect(app.lastFrame()).toContain("@skill:demo-skill");

      // …and submitting expands it into context for the model.
      app.input.write("\r");
      await tick(80);
      expect(app.screen()).toContain("Context from @skill:demo-skill");

      app.input.write("\u0015/exit\r");
      await done;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shows one skill card from /skills <name>", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kicode-skills-"));
    await mkdir(path.join(dir, "ki-agent-brain", "skills", "demo"), { recursive: true });
    await writeFile(
      path.join(dir, "ki-agent-brain", "skills", "demo", "SKILL.md"),
      "---\nname: demo-skill\ndescription: Does a demo.\n---\n\nDemo skill body.\n",
    );
    try {
      const { app, done } = await drive([], { cwd: dir });
      await tick(120);

      app.input.write("/skills demo-skill\r");
      // Polled, not slept on: the walk to read the skill is the thing being
      // waited for, and a fixed sleep is a bet on how loaded the machine is.
      await until(app, "skill:demo-skill");
      expect(app.screen()).toContain("skill:demo-skill");
      expect(app.screen()).toContain("Demo skill body.");

      // An unknown name explains itself rather than failing silently.
      app.input.write("/skills nope\r");
      await until(app, 'no skill named "nope"');
      expect(app.screen()).toContain('no skill named "nope"');

      await finish(app, done);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("names each skill's provenance in /skills, and refuses to delete an installed one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kicode-skills-"));
    await mkdir(path.join(dir, "ki-agent-brain", "skills", "demo"), { recursive: true });
    await writeFile(
      path.join(dir, "ki-agent-brain", "skills", "demo", "SKILL.md"),
      "---\nname: demo-skill\ndescription: Does a demo.\n---\n\nDemo skill body.\n",
    );
    await mkdir(path.join(dir, ".agents", "skills", "review"), { recursive: true });
    await writeFile(
      path.join(dir, ".agents", "skills", "review", "SKILL.md"),
      "---\nname: review-skill\ndescription: Reviews diffs.\n---\n\nReview body.\n",
    );
    try {
      const { app, done } = await drive([], { cwd: dir });
      await tick(120);

      app.input.write("/skills\r");
      await tick(60);
      // Each row names where it came from: learned or installed.
      expect(app.lastFrame()).toContain("demo-skill");
      expect(app.lastFrame()).toContain("learned");
      expect(app.lastFrame()).toContain("review-skill");
      expect(app.lastFrame()).toContain("installed");
      await finish(app, done);

      // Installed skills belong to their installer: the retire path refuses.
      const second = await drive(["/skills delete review-skill"], { cwd: dir });
      await finish(second.app, second.done);
      expect(second.app.screen()).toContain("is installed, not learned");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("starts an empty session on /new", async () => {
    const { app, done } = await drive(["hello", "/new", "/status"]);
    await finish(app, done);

    expect(app.screen()).toContain("new session");
    // A fresh session opens on the home screen, not on an empty transcript.
    expect(app.screen()).toContain("Where should we begin?");
    expect(app.screen()).toContain("0 messages");
    // The turn that was on screen belongs to the session that was left behind.
    expect(app.lastFrame()).not.toContain("echo: hello");
  });

  it("drops the last request on /undo", async () => {
    const { app, done } = await drive(["first", "second", "/undo", "/status"]);
    await finish(app, done);

    expect(app.screen()).toContain("undid the last request · 2 messages left");
    // The model sees what the screen shows: one turn, not two.
    expect(app.screen()).toContain("session session-1 · 2 messages");
  });

  it("copies the conversation into a new session on /fork", async () => {
    const { app, done } = await drive(["hello", "/fork"]);
    await finish(app, done);

    expect(app.screen()).toContain("forked into a new session · 2 messages");
    // The fork's own save, not the last save overall: the session it was forked
    // from is parked and flushed on the way out, which lands after this one.
    const forked = app.saves.filter((save) => save.id === "session-new").at(-1);
    expect(forked?.messages).toHaveLength(2);
    expect(forked?.title).toContain("fork");
  });

  it("renames the session, and keeps the name on the next save", async () => {
    const { app, done } = await drive(["hello", "/rename release notes", "again"]);
    await finish(app, done);

    expect(app.screen()).toContain('renamed to "release notes"');
    expect(app.saves.at(-1)?.title).toBe("release notes");
    expect(app.saves.at(-1)?.messages).toHaveLength(4);
  });

  it("explains a name KiCode does not have instead of ignoring it", async () => {
    const { app, done } = await drive(["/plugins"]);
    await finish(app, done);

    expect(app.screen()).toContain("/plugins is not available in KiCode");
    expect(app.screen()).toContain("Zero runtime dependencies");
  });

  it("still reports an unknown name", async () => {
    const { app, done } = await drive(["/nope"]);
    await finish(app, done);

    expect(app.screen()).toContain("unknown command: /nope");
  });

  it("answers the informational commands", async () => {
    const { app, done } = await drive(["/status", "/stats", "/debug", "/mcps", "/update", "/help"]);
    await finish(app, done);

    const text = app.screen();
    expect(text).toContain("endpoint https://api.example/v1");
    expect(text).toContain("session-1 · 0 messages");
    expect(text).toContain("~1.0K tokens");
    expect(text).toContain("tool calls");
    expect(text).toContain("node ");
    // Asserted on a phrase shorter than the wrap, so a break cannot split it.
    expect(text).toContain("built it from");
    expect(text).toContain("npm run build");
  });

  it("prints the whole help block on a screen that fits it", async () => {
    // On its own, so the assertion is about `/help` and not about where six
    // commands' worth of scrollback left the viewport. Six informational
    // commands push the top of a ten-row help block off a 24-row terminal, which
    // is the terminal scrolling, not a line going missing.
    const { app, done } = await drive(["/help"]);
    await finish(app, done);

    const text = app.screen();
    expect(text).toContain("type / for the palette");
    expect(text).toContain("alt+u usage card");
    expect(text).toContain("+NEW for a fresh one");
    // The command list is not spelled out here — the palette owns it — so the
    // block stays six rows and fits a short terminal with the keymap intact.
    expect(text).toMatch(/\d+ commands — press \/ or ctrl\+p to list them/);
    expect(text).not.toContain("/variants");
  });

  it("shows the machine rollup on /usage", async () => {
    const history = [
      {
        at: "2026-09-30T10:00:00.000Z",
        model: "deepseek-v4-flash:free",
        host: "api.example.com",
        promptTokens: 100,
        completionTokens: 50,
        toolCalls: 1,
        ms: 10_000,
      },
    ];
    const { app, done } = await drive(["/usage"], { usage: { record: async () => {}, history: async () => history } });
    await finish(app, done);

    expect(app.screen()).toContain("all time: 1 turn");
    expect(app.screen()).toContain("deepseek-v4-flash:free");
  });

  it("says so on /usage when nothing is recording it", async () => {
    const { app, done } = await drive(["/usage"]);
    await finish(app, done);

    expect(app.screen()).toContain("not being recorded");
  });

  it("opens the context breakdown on /context", async () => {
    // No brain on the test machine: the skill and memory rows are absent, and
    // the system row is the bare prompt beside its tools.
    const { app, done } = await drive(["hello", "/context"]);
    await tick(300);

    expect(app.lastFrame()).toContain("Context");
    expect(app.screen()).toContain("9 tools");
    expect(app.screen()).toContain("Messages");

    await finish(app, done);
  });

  it("adds the machine total to /stats when usage is recorded", async () => {
    const history = [
      {
        at: "2026-09-30T10:00:00.000Z",
        model: "m",
        host: "api.example.com",
        promptTokens: 1000,
        completionTokens: 500,
        toolCalls: 4,
        ms: 60_000,
      },
    ];
    const { app, done } = await drive(["hello", "/stats"], {
      usage: { record: async () => {}, history: async () => history },
    });
    await finish(app, done);

    expect(app.screen()).toContain("across sessions: 1 turn");
  });

  it("puts a free and a paid tab on the model list", async () => {
    const app = harness({
      listModels: async () => [
        { id: "deepseek-v4-flash:free", description: "FREE · tools" },
        { id: "glm-5.3", description: "paid · tools" },
        { id: "qwen3:free", description: "FREE · tools" },
      ],
    });
    const done = runTui(app.options);
    await tick();

    app.input.write("/models\r");
    await tick(30);

    // Everything is on the `all` tab at first.
    expect(app.lastFrame()).toContain("all   free   paid");
    expect(app.lastFrame()).toContain("glm-5.3");
    expect(app.lastFrame()).toContain("qwen3:free");

    // Tab moves to free: only the free routes are left.
    app.input.write("\t");
    await tick(30);
    expect(app.lastFrame()).toContain("deepseek-v4-flash:free");
    expect(app.lastFrame()).not.toContain("glm-5.3");

    // Tab again is paid, and shift+tab goes back — the list is still open.
    app.input.write("\t");
    await tick(30);
    expect(app.lastFrame()).toContain("glm-5.3");
    expect(app.lastFrame()).not.toContain("qwen3:free");

    app.input.write("\u001b[Z");
    await tick(30);
    expect(app.lastFrame()).toContain("deepseek-v4-flash:free");

    // The search survives the switch, and the tab is not a one-way door.
    app.input.write("deepseek");
    await tick(30);
    expect(app.lastFrame()).toContain("deepseek-v4-flash:free");

    await finish(app, done);
  });

  it("opens on the free tab from /models free", async () => {
    const app = harness({
      listModels: async () => [{ id: "deepseek-v4-flash:free" }, { id: "glm-5.3" }],
    });
    const done = runTui(app.options);
    await tick();

    app.input.write("/models free\r");
    await tick(30);

    expect(app.lastFrame()).toContain("deepseek-v4-flash:free");
    expect(app.lastFrame()).not.toContain("glm-5.3");

    await finish(app, done);
  });

  it("moves a model with 0.00 token pricing to the free tab even without free in its id", async () => {
    const app = harness({
      listModels: async () => [
        { id: "custom-zero-priced-model", promptPrice: 0, completionPrice: 0, description: "FREE ($0.00) · tools" },
        { id: "expensive-model", promptPrice: 0.000005, completionPrice: 0.000015, description: "$5.00/$15.00/M · tools" },
      ],
    });
    const done = runTui(app.options);
    await tick();

    app.input.write("/models free\r");
    await tick(30);

    expect(app.lastFrame()).toContain("custom-zero-priced-model");
    expect(app.lastFrame()).toContain("FREE · tools");
    expect(app.lastFrame()).not.toContain("$0.00");
    expect(app.lastFrame()).not.toContain("expensive-model");

    await finish(app, done);
  });

  it("filters models by provider dropdown and tab", async () => {
    const app = harness({
      listProviders: async () => [
        { label: "tokenharbor", value: "https://api.tokenharbor.com" },
        { label: "opencode", value: "https://api.opencode.ai" },
      ],
      listModels: async (url) => {
        if (url?.includes("tokenharbor")) {
          return [{ id: "claude-3-7-sonnet" }, { id: "gpt-4o" }];
        }
        return [{ id: "mimo-v2" }];
      },
    });
    const done = runTui(app.options);
    await tick();

    app.input.write("/models\r");
    await tick(30);

    expect(app.lastFrame()).toContain("provider: all ▾");
    expect(app.lastFrame()).toContain("ctrl+p select provider");

    // Open provider dropdown with ctrl+p
    app.input.write("\u0010");
    await tick(30);

    expect(app.lastFrame()).toContain("Select Provider");
    expect(app.lastFrame()).toContain("All Providers");
    expect(app.lastFrame()).toContain("tokenharbor");
    expect(app.lastFrame()).toContain("opencode");

    // Select tokenharbor (row 1)
    app.input.write("\u001b[B\r");
    await tick(30);

    expect(app.lastFrame()).toContain("provider: tokenharbor ▾");
    expect(app.lastFrame()).toContain("claude-3-7-sonnet");
    expect(app.lastFrame()).not.toContain("mimo-v2");

    await finish(app, done);
  });

  it("shows and sets the session token budget", async () => {
    const { app, done } = await drive(["/budget", "/budget 5000"]);

    expect(app.screen()).toContain("budget none");
    expect(app.budgets).toEqual([5000]);
    expect(app.screen()).toContain("token budget set to 5.0K");

    await finish(app, done);
  });

  it("refuses a budget that is not a number", async () => {
    const { app, done } = await drive(["/budget lots"]);

    expect(app.screen()).toContain("usage: /budget");
    expect(app.budgets).toEqual([]);

    await finish(app, done);
  });

  it("switches model from the list", async () => {
    const { app, done } = await drive(["/models", "2"], {
      listModels: async () => [
        { id: "deepseek-v4-flash:free", description: "FREE · tools" },
        { id: "glm-5.3", description: "paid · tools" },
      ],
    });
    await finish(app, done);

    // The picker was on screen with both models, and the second was taken.
    expect(app.screen()).toContain("deepseek-v4-flash:free");
    expect(app.screen()).toContain("model glm-5.3");
    // The agent is rebuilt with it: the provider is chosen at construction.
    expect(app.settings.at(-1)?.model).toBe("glm-5.3");
    expect(app.lastFrame()).toContain("glm-5.3");
  });

  it("narrows the list as you type, and takes what is left", async () => {
    const { app, done } = await drive(["/models", "glm"], {
      listModels: async () => [{ id: "deepseek-v4-flash:free" }, { id: "glm-5.3" }],
    });
    await finish(app, done);

    expect(app.settings.at(-1)?.model).toBe("glm-5.3");
  });

  it("searches the tier beside a model too, not only its name", async () => {
    const { app, done } = await drive(["/models", "paid"], {
      listModels: async () => [
        { id: "deepseek-v4-flash:free", description: "FREE · tools" },
        { id: "claude-opus-5", description: "paid · tools" },
      ],
    });
    await finish(app, done);

    expect(app.settings.at(-1)?.model).toBe("claude-opus-5");
  });

  it("widens the search again when a character is deleted", async () => {
    // The stray character matches nothing, so only the delete can bring the
    // model back — a filter that cannot widen again is a dead end.
    const { app, done } = await drive(["/models", "glmz\u007f"], {
      listModels: async () => [{ id: "glm-5.3" }, { id: "glm-5.4" }],
    });
    await finish(app, done);

    expect(app.settings.at(-1)?.model).toBe("glm-5.3");
  });

  it("still takes a number as a shortcut while nothing has been typed", async () => {
    const { app, done } = await drive(["/models", "2"], {
      listModels: async () => [{ id: "m1" }, { id: "m2" }],
    });
    await finish(app, done);

    expect(app.settings.at(-1)?.model).toBe("m2");
  });

  it("moves the session to another endpoint from the model list", async () => {
    const asked: string[] = [];
    // Written key by key rather than by `drive`, which ends every line with an
    // Enter — that would pick a provider before the second key arrived.
    const app = harness({
      baseUrl: "https://one.example/v1",
      listModels: async (baseUrl) => {
        asked.push(baseUrl);
        return [{ id: "m1" }, { id: "m2" }];
      },
      listProviders: async () => [
        { label: "one.example", value: "https://one.example/v1" },
        { label: "two.example", value: "https://two.example/v1" },
      ],
    });
    const done = runTui(app.options);
    await tick();

    app.input.write("/models\r");
    await tick(40);
    app.input.write("\u0001");
    await tick(40);
    app.input.write("2");
    await tick(60);

    await finish(app, done);

    expect(app.screen()).toContain("Select provider");
    expect(app.screen()).toContain("two.example");
    // The agent is rebuilt against it, which is how a session changes endpoint.
    expect(app.settings.at(-1)?.baseUrl).toBe("https://two.example/v1");
    // And the list is fetched again from there, not left as the old one's.
    expect(asked).toContain("https://two.example/v1");
    expect(asked[0]).toBe("https://one.example/v1");
  });

  it("does not offer the provider key when there is only one endpoint", async () => {
    const { app, done } = await drive(["/models"], {
      listModels: async () => [{ id: "m1" }],
      listProviders: async () => [{ label: "one.example", value: "https://one.example/v1" }],
    });
    await finish(app, done);

    expect(app.screen()).not.toContain("change provider");
  });

  it("says so when there are no models to switch to", async () => {
    const { app, done } = await drive(["/models"]);
    await finish(app, done);

    expect(app.screen()).toContain("cannot list the endpoint's models");
  });

  it("names the endpoint when the model list comes back empty", async () => {
    const { app, done } = await drive(["/models"], { listModels: async () => [] });
    await finish(app, done);

    expect(app.screen()).toContain("no models from");
    expect(app.screen()).toContain("api.example");
  });

  it("passes on why the model list could not be read", async () => {
    // An unreachable or unauthorised gateway and an endpoint that serves
    // nothing must not look the same — only one of them is fixable.
    const { app, done } = await drive(["/models"], {
      listModels: async () => {
        throw new Error("401 Unauthorized");
      },
    });
    await finish(app, done);

    expect(app.screen()).toContain("no models from");
    expect(app.screen()).toContain("401 Unauthorized");
  });

  it("keeps a provider that failed in the list, without letting the cursor stop on it", async () => {
    const { app, done } = await drive(["/models", "1"], {
      listProviders: async () => [
        { label: "good", value: "https://good.example/v1" },
        { label: "bad", value: "https://bad.example/v1" },
      ],
      listModels: async (baseUrl) => {
        if (baseUrl.includes("bad")) throw new Error("401 Unauthorized");
        return [{ id: "m1" }];
      },
    });
    await finish(app, done);

    // The reason is on screen, under the provider it belongs to…
    expect(app.screen()).toContain("bad");
    expect(app.screen()).toContain("401 Unauthorized");
    // …and the only choosable row can still be taken, which is what makes the
    // list usable rather than stuck on a row that cannot be chosen.
    expect(app.settings.at(-1)?.baseUrl).toBe("https://good.example/v1");
    expect(app.settings.at(-1)?.model).toBe("m1");
  });

  it("passes on why a session could not be switched to, instead of doing nothing", async () => {
    const { app, done } = await drive(["/sessions", "1"], {
      listSessions: async () => [
        { id: "session-1", title: "current", createdAt: "2026-09-30T00:00:00.000Z" },
        { id: "session-2", title: "older", createdAt: "2026-09-29T00:00:00.000Z" },
      ],
      // Selected with the digit, so the pick has to run through `run()`.
      loadSession: async () => {
        throw new Error("EACCES: from the store");
      },
    });
    await finish(app, done);

    // A rejection that only redrew the frame would look like a key that did
    // nothing at all.
    expect(app.screen()).toContain("failed: EACCES");
  });

  it("changes the reasoning variant, in the status row too", async () => {
    const { app, done } = await drive(["/variants high"]);
    await finish(app, done);

    expect(app.screen()).toContain("variant high — sent as reasoning_effort");
    expect(app.settings.at(-1)?.variant).toBe("high");
    expect(app.lastFrame()).toContain("· high");
  });

  it("rejects a variant it does not have", async () => {
    const { app, done } = await drive(["/effort enormous"]);
    await finish(app, done);

    expect(app.screen()).toContain("usage: /variants [default|low|medium|high]");
  });

  it("changes the theme, and keeps drawing", async () => {
    const { app, done } = await drive(["/themes light"]);
    await finish(app, done);

    expect(app.screen()).toContain("theme light");
    // The light background is on screen from that point on — read off the theme
    // rather than typed in, so a palette change is not a test change.
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(themeByName("light").bg.slice(i, i + 2), 16));
    expect(app.raw()).toContain(`48;2;${r};${g};${b}`);
  });

  it("asks the endpoint for a summary on /compact", async () => {
    const { app, done } = await drive(["/compact"]);
    await finish(app, done);

    expect(app.compactions).toBe(1);
    expect(app.screen()).toContain("compacted 3 earlier messages · ~1.0K → ~400");
  });

  it("stays usable while compacting, and stops it on ctrl+c", async () => {
    // The summariser gone quiet used to hang the whole CLI: the input loop
    // awaited the request, so no key — not even Ctrl+C — was ever read.
    const app = harness({}, { compactHang: true });
    const done = runTui(app.options);
    await tick();

    app.input.write("/compact\r");
    await tick(60);
    // The wait says what it is instead of a frozen screen.
    expect(app.screen()).toContain("compacting");

    app.input.write("");
    await tick(60);
    expect(app.compactAborted).toBe(true);
    expect(app.screen()).toContain("compaction stopped");

    app.input.write("/exit\r");
    await done;
  });

  it("answers a side question without recording it", async () => {
    const { app, done } = await drive(["/btw is this idiomatic?"]);
    await finish(app, done);

    expect(app.sideQuestions).toEqual(["is this idiomatic?"]);
    expect(app.screen()).toContain("side: is this idiomatic?");
    // Nothing was added to the conversation itself.
    expect(app.saves).toHaveLength(0);
  });

  it("shows the diffs it approved on /diff", async () => {
    const { app, done } = await drive(["run the tests", "a", "/diff"], {}, { approve: true });
    await finish(app, done);

    expect(app.screen()).toContain("bash command: npm test");
    expect(app.screen()).toContain("+ npm test");
  });

  it("says there is nothing to show when nothing changed", async () => {
    const { app, done } = await drive(["/diff"]);
    await finish(app, done);

    expect(app.screen()).toContain("no file changes were approved");
  });

  it("jumps to a message with /timeline", async () => {
    const { app, done } = await drive(["first request", "second request", "/timeline 1"]);
    await finish(app, done);

    expect(app.screen()).toContain("jumped to message");
    // The view is anchored rather than following the tail…
    expect(app.lastFrame()).toContain("first request");
  });

  it("lists the messages to jump to when given no number", async () => {
    const { app, done } = await drive(["first request", "/timeline"]);

    // Asserted before anything closes the list: it is what is on screen now.
    expect(app.lastFrame()).toContain("Messages");
    expect(app.lastFrame()).toContain("1. first request");

    await finish(app, done);
  });

  it("writes the transcript out on /export", async () => {
    const exported: ChatMessage[][] = [];
    const { app, done } = await drive(["hello", "/export"], {
      exportTranscript: async (messages) => {
        exported.push([...messages]);
        return "C:\\dev\\kicode-session-1.md";
      },
    });
    await finish(app, done);

    expect(app.screen()).toContain("exported to C:\\dev\\kicode-session-1.md");
    expect(exported[0]).toHaveLength(2);
  });

  it("copies the transcript, and falls back when there is no clipboard", async () => {
    const copied: string[] = [];
    const withClipboard = await drive(["hello", "/copy"], {
      copyToClipboard: async (text) => {
        copied.push(text);
        return true;
      },
    });
    await finish(withClipboard.app, withClipboard.done);
    expect(copied[0]).toContain("> hello");
    expect(copied[0]).toContain("echo: hello");
    expect(withClipboard.app.screen()).toContain("characters to the clipboard");

    const without = await drive(["/copy"]);
    await finish(without.app, without.done);
    expect(without.app.screen()).toContain("no clipboard here");
  });

  it("writes kicode.json on /init, and reports a refusal", async () => {
    const blocked = await drive(["/init"], {
      initialise: async () => ({ file: "kicode.json", status: "blocked", agents: null, blocked: true }),
    });
    await finish(blocked.app, blocked.done);
    expect(blocked.app.screen()).toContain("not valid JSON");

    const written = await drive(["/init"], {
      initialise: async () => ({ file: "kicode.json", status: "written", agents: "AGENTS.md" }),
    });
    await finish(written.app, written.done);
    expect(written.app.screen()).toContain("kicode.json written");
    expect(written.app.screen()).toContain("AGENTS.md");
  });

  it("reloads the config files on /reload", async () => {
    const { app, done } = await drive(["/reload"], {
      reload: async () => ({ model: "glm-5.3", files: ["C:\\dev\\kicode\\kicode.json"] }),
    });
    await finish(app, done);

    expect(app.screen()).toContain("reloaded C:\\dev\\kicode\\kicode.json");
    expect(app.screen()).toContain("model is now glm-5.3");
    expect(app.settings.at(-1)?.model).toBe("glm-5.3");
  });

  it("changes directory on /cd, and moves the agent with it", async () => {
    const { app, done } = await drive(["/cd nope"], { cwd: process.cwd() });
    await tick(20);

    expect(app.screen()).toContain("cannot change to");

    app.input.write("/cd .\r");
    await tick(30);
    await finish(app, done);

    expect(app.screen()).toContain(`cwd ${process.cwd()}`);
    // The tools run where the agent does, so it is rebuilt around the new one.
    expect(app.settings.at(-1)?.cwd).toBe(process.cwd());
  });

  it("reviews the change set when git has one", async () => {
    const { app, done } = await drive(["/review"], {
      gitDiff: async () => "--- a/src/app.ts\n+++ b/src/app.ts\n+const x = 1;",
    });
    await finish(app, done);

    expect(app.screen()).toContain("reviewing uncommitted changes");
    expect(app.screen()).toContain("echo: Review the changes below");
  });

  it("says so when there is nothing to review", async () => {
    const { app, done } = await drive(["/review branch"], { gitDiff: async () => null });
    await finish(app, done);

    expect(app.screen()).toContain("no branch changes to review");
  });

  it("refuses to open an editor that is not there", async () => {
    const { app, done } = await drive(["/editor"], { cwd: process.cwd() });
    await finish(app, done);

    // There is no real terminal in a test, so the editor is never spawned.
    expect(app.screen()).toContain("no editor here");
  });

  it("quits on any of the names that mean quit", async () => {
    for (const name of ["/exit", "/quit", "/q"]) {
      const app = harness();
      const done = runTui(app.options);
      await tick();
      app.input.write(`${name}\r`);
      expect(await done).toBe(0);
    }
  });
});

describe("--tui-preview", () => {
  it("prints one frame without touching the terminal mode", async () => {
    const output = new PassThrough();
    Object.assign(output, { columns: 60, rows: 12, isTTY: false });
    let seen = "";
    output.on("data", (chunk: Buffer) => {
      seen += chunk.toString("utf8");
    });

    const code = await runTui({
      cwd: "C:\\dev",
      baseUrl: "https://api.example/v1",
      contextTokens: 128_000,
      version: "9.9.9",
      model: "test-model",
      compacting: true,
      newSessionId: () => "s",
      preview: true,
      initial: { id: "s", createdAt: "" },
      listSessions: async () => [],
      loadSession: async () => null,
      createAgent: () => {
        throw new Error("should not run");
      },
      saveSession: async () => undefined,
      streams: {
        input: new PassThrough() as unknown as NodeJS.ReadStream,
        output: output as unknown as NodeJS.WriteStream,
      },
    });

    expect(code).toBe(0);
    expect(strip(seen).trimEnd().split("\n")).toHaveLength(12);
    expect(strip(seen)).toContain("test-model");
    // No alternate screen, no raw mode: the preview must be pipe-safe.
    expect(seen).not.toContain("\u001b[?1049h");
  });
});

describe("terminalSize", () => {
  it("prefers what the terminal reports", () => {
    expect(terminalSize({ columns: 100, rows: 50 })).toEqual({ cols: 100, rows: 50 });
  });

  it("falls back to the defaults", () => {
    expect(terminalSize({})).toEqual({ cols: 80, rows: 24 });
  });

  it("ignores nonsense dimensions", () => {
    expect(terminalSize({ columns: 0, rows: Number.NaN })).toEqual({ cols: 80, rows: 24 });
  });
});

/**
 * The two full-screen menus. They own the keyboard while they are up, so a key
 * that acts on a row has to be sent as the arrow it is, not as a prompt line.
 */
const RIGHT = "\u001b[C";
const LEFT = "\u001b[D";
const DOWN = "\u001b[B";
const ESC = "\u001b";

async function open(line: string, over: Partial<TuiOptions> = {}) {
  const app = harness(over);
  const done = runTui(app.options);
  await tick();
  app.input.write(`${line}\r`);
  await tick(30);
  return { app, done };
}

/** Closes whatever is open, clears the line and quits. */
async function finish(app: Harness, done: Promise<number>): Promise<void> {
  app.input.write("\u001b");
  await tick(60);
  app.input.write("\u0015/exit\r");
  await done;
}

describe("/settings", () => {
  it("opens a panel with the shortcuts, the groups, the rows and their values", async () => {
    const { app, done } = await open("/settings");
    const screen = app.screen();

    expect(screen).toContain("Settings");
    // The doors ride first, in panel order, ahead of every value.
    expect(screen).toContain("Shortcuts");
    for (const label of [
      "Connect / Provider",
      "Models",
      "Sessions",
      "Compact",
      "Skills",
      "Tools",
      "MCP",
      "Subagents",
    ]) {
      expect(screen).toContain(label);
    }
    const shortcutsAt = screen.indexOf("Shortcuts");
    expect(shortcutsAt).toBeGreaterThanOrEqual(0);
    expect(shortcutsAt).toBeLessThan(screen.indexOf("Appearance"));
    expect(screen).toContain("Session");
    // On a twenty-four-row terminal the eight doors fill the card, so the first
    // values start below the fold. The panel scrolls with the cursor, which is
    // what the next step checks.
    expect(app.lastFrame()).not.toContain("Theme");
    // The value in effect, on the row — not a copy that can drift from it.
    expect(screen).toContain("kicode");
    // On a shortcut row the footer names opening, not changing.
    expect(app.lastFrame()).toContain("enter open");

    // Down past the shortcuts, the values scroll into view — the first one is
    // Theme — and the footer names changing again.
    app.input.write(`${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}`);
    await tick(30);
    expect(app.lastFrame()).toContain("‹/› change");
    expect(app.lastFrame()).toContain("Theme");

    await finish(app, done);
  });

  it("changes a value with the arrows, and writes it down", async () => {
    const { app, done } = await open("/settings");

    // Down past the eight shortcut rows: the first value is the theme, and a
    // dark theme steps to the next dark one.
    app.input.write(`${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}`);
    await tick(30);
    app.input.write(RIGHT);
    await tick(30);

    // The first row is the theme, and a dark theme steps to the next dark one.
    expect(app.viewSaves.at(-1)).toEqual({ theme: "dark" });
    expect(painted(app)).toContain(bg(themeByName("dark").bg));

    app.input.write(LEFT);
    await tick(30);
    expect(app.viewSaves.at(-1)).toEqual({ theme: "kicode" });

    await finish(app, done);
  });

  it("sizes the card by the longest description, so moving never resizes it", async () => {
    // Down past the shortcuts to `Sidebar`, whose sentence is the longest of
    // the list. Sized by the row under the cursor, the card would jump on
    // every step — and this sentence would be cut short on rows narrower than
    // it. Sized by the longest, it fits in full and the card never moves.
    const { app, done } = await open("/settings");

    app.input.write(`${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}`);
    await tick(30);
    expect(app.screen()).toContain("Auto shows it once a second session exists.");

    await finish(app, done);
  });

  it("moves at once even when the write is slow, and still saves", async () => {    // Every arrow used to await the file write, so a slow disk held the panel
    // hostage between steps. The value is adopted before the write lands; the
    // write follows behind and is still owed.
    const saved: Partial<ViewSettings>[] = [];
    const app = harness({
      saveView: async (patch) => {
        await tick(200);
        saved.push(patch);
        return { ok: true, file: "C:\\Users\\me\\.kicode\\kicode.json" };
      },
    });
    const done = runTui(app.options);
    await tick();
    app.input.write("/settings\r");
    await tick(30);

    // Down past the shortcuts: the first value is the theme.
    app.input.write(`${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}`);
    await tick(30);
    app.input.write(RIGHT);
    await tick(30);
    // The screen already moved on, while the write is still in flight.
    expect(painted(app)).toContain(bg(themeByName("dark").bg));
    expect(saved).toHaveLength(0);

    await tick(250);
    expect(saved.at(-1)).toEqual({ theme: "dark" });

    await finish(app, done);
  });

  it("steps a row with Enter as well, so the arrows are not the only way", async () => {
    const { app, done } = await open("/settings");

    // Down past the shortcuts to `Color mode`: Enter flips it, and the theme moves with it.
    app.input.write(`${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}\r`);
    await tick(40);

    const saved = app.viewSaves.at(-1) ?? {};
    expect(saved.colorMode).toBe("light");
    expect(saved.theme).toBe("light");

    await finish(app, done);
  });

  it("opens the subagent list from the Subagents door", async () => {
    // A door that is a row rather than a value has to run the same call its
    // slash command runs, or the two ways in can drift apart.
    const { app, done } = await open("/settings");

    app.input.write("subagents");
    await tick(30);
    expect(app.lastFrame()).toContain("Subagents");

    app.input.write("\r");
    await tick(30);
    // Settings is gone and the subagent list is up.
    expect(app.lastFrame()).toContain("New agent");
    expect(app.lastFrame()).not.toContain("Appearance");

    await finish(app, done);
  });

  it("narrows the rows to what is typed, and keeps the cursor on a real row", async () => {
    const { app, done } = await open("/settings");

    app.input.write("scroll");
    await tick(30);
    // The last frame only: every frame before it had the whole list in it.
    expect(app.lastFrame()).toContain("Scrollbar");
    expect(app.lastFrame()).not.toContain("Verbosity");

    // The list is one row long now, so this changes the scrollbar, not the theme.
    app.input.write(RIGHT);
    await tick(30);
    expect(app.viewSaves.at(-1)).toEqual({ scrollbar: "off" });

    await finish(app, done);
  });

  it("keeps a change that is not the theme to the one key", async () => {
    const { app, done } = await open("/settings");

    app.input.write("tps");
    await tick(30);
    app.input.write(RIGHT);
    await tick(30);

    expect(app.viewSaves.at(-1)).toEqual({ tps: "off" });
    // The screen is untouched by a setting that is only about a line of text.
    expect(painted(app)).toContain(bg(themeByName(DEFAULT_THEME).bg));

    await finish(app, done);
  });

  it("closes on escape, leaving the session alone", async () => {
    const { app, done } = await open("/settings");
    app.input.write(ESC);
    await tick(60);

    // The prompt is back: the panel had taken its place.
    expect(app.screen()).toContain("Ask anything");

    await finish(app, done);
  });

  it("sets one value outright when it is named", async () => {
    const { app, done } = await open("/settings thinking hide");

    expect(app.viewSaves.at(-1)).toEqual({ thinking: "hide" });
    expect(app.screen()).toContain("thinking hide");

    await finish(app, done);
  });

  it("refuses a value that is not one of the row's, and keeps the row it has", async () => {
    const { app, done } = await open("/settings verbosity shouty");

    expect(app.viewSaves).toEqual([]);
    expect(app.screen()).toContain("usage: /settings verbosity");

    await finish(app, done);
  });

  it("says a setting is not kept when there is nowhere to write it", async () => {
    const { app, done } = await open("/settings thinking hide", { saveView: undefined });

    expect(app.screen()).toContain("not saved");

    await finish(app, done);
  });

  it("still lets Ctrl+C out, so a panel cannot trap anybody in it", async () => {
    const { app, done } = await open("/settings");

    app.input.write("\u0003");
    expect(await done).toBe(0);
    expect(app.raw()).toContain("\u001b[?1049l");
  });

  it("stops the spinner ticking when animations are off", async () => {
    const still = harness(
      { view: { ...defaultViewSettings(), sidebar: "on", animations: "off" } },
      { slow: 250 },
    );
    const stillDone = runTui(still.options);
    await tick();
    still.input.write("hello\r");
    await tick(400);
    still.input.write("\u0015/exit\r");
    await stillDone;

    const spinning = harness({}, { slow: 250 });
    const spinningDone = runTui(spinning.options);
    await tick();
    spinning.input.write("hello\r");
    await tick(400);
    spinning.input.write("\u0015/exit\r");
    await spinningDone;

    // The glyph is the only thing on screen that moves on its own, so a still
    // spinner is exactly one frame's worth of it.
    const glyphs = (text: string): number => new Set(text.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g) ?? []).size;
    expect(glyphs(still.screen())).toBe(1);
    expect(glyphs(spinning.screen())).toBeGreaterThan(1);
  });
});

describe("settings shortcuts", () => {
  it("opens the connect menu from its shortcut, closing settings first", async () => {
    const { app, done } = await open("/settings");
    app.input.write("\r");
    await tick(60);

    // The settings panel is gone, replaced by the screen the shortcut names.
    expect(app.lastFrame()).toContain("Connect an integration");
    expect(app.lastFrame()).toContain("OpenAI");

    await finish(app, done);
  });

  it("opens the model picker from its shortcut", async () => {
    const { app, done } = await open("/settings", {
      listModels: async () => [{ id: "m1" }, { id: "m2" }],
    });
    app.input.write(`${DOWN}\r`);
    await tick(60);

    expect(app.lastFrame()).toContain("Select model");
    expect(app.lastFrame()).toContain("m2");

    await finish(app, done);
  });

  it("opens the session picker from its shortcut", async () => {
    const { app, done } = await open("/settings", {
      listSessions: async () => [{ id: "session-2", title: "the other one" }],
    });
    app.input.write(`${DOWN}${DOWN}\r`);
    await tick(60);

    expect(app.lastFrame()).toContain("Sessions");
    expect(app.lastFrame()).toContain("the other one");

    await finish(app, done);
  });

  it("compacts from its shortcut, closing the panel first", async () => {
    const { app, done } = await open("/settings");
    app.input.write(`${DOWN}${DOWN}${DOWN}\r`);
    await tick(60);

    expect(app.compactions).toBe(1);
    expect(app.screen()).toContain("compacted 3 earlier messages");

    await finish(app, done);
  });

  it("opens the skills picker from its shortcut", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kicode-skills-"));
    await mkdir(path.join(dir, "ki-agent-brain", "skills", "demo"), { recursive: true });
    await writeFile(
      path.join(dir, "ki-agent-brain", "skills", "demo", "SKILL.md"),
      "---\nname: demo-skill\ndescription: Does a demo.\n---\n\nDemo skill body.\n",
    );
    try {
      const { app, done } = await open("/settings", { cwd: dir });
      await tick(120);
      app.input.write(`${DOWN}${DOWN}${DOWN}${DOWN}\r`);
      await tick(120);

      expect(app.lastFrame()).toContain("demo-skill");

      await finish(app, done);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lists the session's tools from its shortcut, and reads one back", async () => {
    const { app, done } = await open("/settings");
    app.input.write(`${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}\r`);
    await tick(60);

    expect(app.lastFrame()).toContain("Tools · 3");
    expect(app.lastFrame()).toContain("read");

    // Picking a tool reads its line back: tools run for the model, and the
    // panel is for looking.
    app.input.write("\r");
    await tick(40);
    expect(app.screen()).toContain("read — Read a file.");

    await finish(app, done);
  });

  it("reports the MCP servers from its shortcut", async () => {
    const { app, done } = await open("/settings");
    app.input.write(`${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}\r`);
    await tick(40);

    expect(app.screen()).toContain("no MCP servers configured for this project");

    await finish(app, done);
  });

  it("leaves a shortcut alone on ‹/›: there is no value to step", async () => {
    const { app, done } = await open("/settings");

    app.input.write(RIGHT);
    await tick(30);
    app.input.write(LEFT);
    await tick(30);

    expect(app.viewSaves).toEqual([]);
    // Still open on the same row: nothing moved, nothing saved.
    expect(app.lastFrame()).toContain("Connect / Provider");

    await finish(app, done);
  });

  it("narrows the doors to what is typed, then opens the one row left", async () => {
    const { app, done } = await open("/settings");

    app.input.write("comp");
    await tick(30);
    expect(app.lastFrame()).toContain("Compact");
    expect(app.lastFrame()).not.toContain("Models");
    expect(app.lastFrame()).not.toContain("Theme");

    app.input.write("\r");
    await tick(60);
    expect(app.screen()).toContain("compacted 3 earlier messages");

    await finish(app, done);
  });

  it("opens the door a click lands on, because a click is Enter after a move", async () => {
    const { app, done } = await open("/settings", {
      listModels: async () => [{ id: "m1" }, { id: "m2" }],
    });

    clickOn(app, "Models");
    await tick(60);
    expect(app.lastFrame()).toContain("Select model");

    await finish(app, done);
  });
});

describe("/connect", () => {
  it("lists the services with their state, grouped", async () => {
    const { app, done } = await open("/connect");
    const screen = app.screen();

    expect(screen).toContain("Connect an integration");
    expect(screen).toContain("Popular");
    expect(screen).toContain("OpenAI");
    expect(screen).toContain("key in OPENAI_API_KEY");
    expect(screen).toContain("set GROQ_API_KEY");

    await finish(app, done);
  });

  it("declares the chosen service and moves the session onto it", async () => {
    const { app, done } = await open("/connect");
    app.input.write("\r");
    await tick(60);

    expect(app.added).toEqual(["openai"]);
    expect(app.screen()).toContain("added openai to");

    await finish(app, done);
  });

  it("narrows the list to what is typed before choosing", async () => {
    const { app, done } = await open("/connect");
    app.input.write("groq");
    await tick(30);
    expect(app.lastFrame()).toContain("Groq");
    expect(app.lastFrame()).not.toContain("OpenAI");

    app.input.write("\r");
    await tick(60);
    expect(app.added).toEqual(["groq"]);

    await finish(app, done);
  });

  it("adds a service named on the command line", async () => {
    const { app, done } = await open("/connect openai");
    await tick(40);

    expect(app.added).toEqual(["openai"]);

    await finish(app, done);
  });

  it("says so when the run cannot add providers", async () => {
    const { app, done } = await open("/connect", { connect: undefined });

    expect(app.screen()).toContain("cannot add providers");

    await finish(app, done);
  });
});

/** A left click, in SGR encoding, at a 1-based column and a 1-based row. */
const clickAt = (row: number, column = 6): string => `\u001b[<0;${column};${row}M`;

/**
 * A left click on the first cell of a piece of text, read off the frame.
 *
 * Deliberately not a hardcoded row and column: what these tests are for is that
 * a click lands where the thing looks like it is, and numbers typed in here
 * would agree with a broken layout just as happily as with a working one.
 */
const clickOn = (app: Harness, text: string): void => {
  const lines = app.lastFrame().split(/\r?\n/);
  const row = lines.findIndex((line) => line.includes(text));
  const column = (lines[row] ?? "").indexOf(text) + 1;
  if (row < 0 || column < 1) throw new Error(`no "${text}" on screen`);
  app.input.write(clickAt(row + 1, column));
};

describe("clicking a row", () => {
  /**
   * The screen row a piece of text was drawn on, read back off the frame.
   *
   * Deliberately not a hardcoded number: what these tests are for is that a
   * click lands on the row it looks like it should, and a number typed in here
   * would agree with a broken layout just as happily as with a working one.
   */
  const rowOf = (frame: string, text: string): number =>
    frame.split(/\r?\n/).findIndex((line) => line.includes(text)) + 1;

  it("chooses the model on the row that was clicked, not the one under the cursor", async () => {
    const { app, done } = await drive(["/models"], {
      listModels: async () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
    });

    const row = rowOf(app.lastFrame(), "m3");
    expect(row).toBeGreaterThan(1);
    app.input.write(clickAt(row));
    await tick(40);

    // The cursor was on m1, and a click on m3 is a move then Enter.
    expect(app.settings.at(-1)?.model).toBe("m3");

    await finish(app, done);
  });

  it("runs the palette command that was clicked", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick(15);

    app.input.write("/");
    await tick(20);
    app.input.write("budg");
    await tick(20);
    app.input.write(clickAt(rowOf(app.lastFrame(), "/budget")));
    await tick(40);

    expect(app.lastFrame()).toContain("budget none");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("moves to a settings row and steps it, because a click is a cursor move plus Enter", async () => {
    const { app, done } = await open("/settings");

    // Down to `Thinking` first: the shortcuts pushed it below the panel's
    // visible window, and a click can only land on a row that is drawn.
    app.input.write(`${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}`);
    await tick(30);
    app.input.write(clickAt(rowOf(app.lastFrame(), "Thinking")));
    await tick(40);

    // `Thinking` is `show`, the first of two, to `hide` — and it was written down.
    expect(app.viewSaves.at(-1)).toEqual({ thinking: "hide" });

    await finish(app, done);
  });

  it("never answers a permission prompt when the click is not on a chip", async () => {
    const app = harness({}, { approve: true });
    const done = runTui(app.options);
    await tick();

    app.input.write("run the tests\r");
    await tick(20);
    expect(app.screen()).toContain("bash wants to run");

    // Straight at the prompt, its body and its options row.
    for (let row = 1; row <= 8; row++) app.input.write(clickAt(row, 4));
    await tick(30);

    expect(app.decisions).toEqual([]);
    expect(app.screen()).toContain("bash wants to run");

    app.input.write("n");
    await tick(20);
    app.input.write("/exit\r");
    await done;

    expect(app.decisions).toEqual(["deny"]);
  });

  it("answers the prompt from the chip the mouse clicks", async () => {
    const app = harness({}, { approve: true });
    const done = runTui(app.options);
    await tick();

    app.input.write("run the tests\r");
    await tick(20);
    expect(app.lastFrame()).toContain("[y] yes · [a] always · [n] no");
    expect(app.decisions).toEqual([]);

    clickOn(app, "[a] always");
    await tick(30);

    // The chip *is* the key, so the answer the agent receives is the same one
    // pressing `a` would have produced.
    expect(app.decisions).toEqual(["always"]);
    expect(app.screen()).toContain("echo: run the tests");

    app.input.write("/exit\r");
    await done;
  });

  it("denies from the close chip, exactly as escape does", async () => {
    const app = harness({}, { approve: true });
    const done = runTui(app.options);
    await tick();

    app.input.write("run the tests\r");
    await tick(20);
    expect(app.lastFrame()).toContain("[×] deny");

    clickOn(app, "[×] deny");
    await tick(30);

    // Closing a prompt must never mean yes, from the keyboard or from the mouse.
    expect(app.decisions).toEqual(["deny"]);

    app.input.write("/exit\r");
    await done;
  });
});

describe("clicking a wrapped prompt", () => {
  /**
   * The rows the prompt's own text fills, read off the frame.
   *
   * Found by the text rather than by a row number: the first of them opens with
   * the mode pill and the last is a bare wall of it, and the run of the typed
   * character is what they have in common. Nothing else on screen carries five
   * of it in a row.
   */
  const textRows = (frame: string): { index: number; line: string }[] =>
    frame
      .split(/\r?\n/)
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes("fffff"));

  it("puts the caret on the row that was clicked, not at the start of the prompt", async () => {
    const { app, done } = await drive([]);

    app.input.write("f".repeat(150));
    await tick(60);

    const rows = textRows(app.lastFrame());
    // The prompt wrapped rather than being cut off, and the click is aimed at
    // the second of its rows.
    expect(rows).toHaveLength(3);
    const second = rows[1]!;
    app.input.write(clickAt(second.index + 1, second.line.indexOf("f") + 1));
    await tick(40);
    app.input.write("Z");
    await tick(40);

    // The character landed on the row the pointer was over. Reading the offset
    // wrong would put it at the start of the prompt, on the first row.
    const after = app.lastFrame().split(/\r?\n/);
    expect((after[second.index] ?? "").trimStart().startsWith("Z")).toBe(true);

    // The line is 150 characters and the caret is in the middle of it, where
    // `finish`'s ctrl+u would only clear back to the caret: select all first,
    // so the session is left the way it was found.
    app.input.write("\u001b");
    await tick(60);
    app.input.write("\u0001\u0015/exit\r");
    await done;
  });

  it("selects the text between two rows of a wrapped prompt", async () => {
    const copied: string[] = [];
    const { app, done } = await drive([], {
      copyToClipboard: async (text) => {
        copied.push(text);
        return true;
      },
    });

    app.input.write("f".repeat(150));
    await tick(60);

    const rows = textRows(app.lastFrame());
    expect(rows).toHaveLength(3);
    const first = rows[0]!;
    const second = rows[1]!;
    const third = rows[2]!;
    // The first row holds the pill, the gap and the upload button around its
    // share of the text, so how much a row carries is counted off the row
    // rather than worked out here: the budget is the renderer's to say.
    const perRow = first.line.match(/f+/)?.[0]?.length ?? 0;
    // From the first cell of the second row to the cell after the last one on
    // the third: everything past the first row.
    const to = third.line.trimEnd().length + 1;
    app.input.write(
      `\u001b[<0;${second.line.indexOf("f") + 1};${second.index + 1}M` +
        `\u001b[<32;${to};${third.index + 1}M` +
        `\u001b[<0;${to};${third.index + 1}m`,
    );
    // Releasing over the prompt copies the editor's own selection, which is the
    // span the drag covered. Poll rather than sleep once: a loaded runner
    // stalls a tick.
    for (let i = 0; i < 30 && copied.length === 0; i++) await tick(40);
    expect(copied).toEqual(["f".repeat(150 - perRow)]);

    await finish(app, done);
  });
});

describe("dragging over the transcript", () => {
  /** A left press, a move with the button held, and the release, in SGR. */
  const press = (row: number, col: number): string => `\u001b[<0;${col};${row}M`;
  const drag = (row: number, col: number): string => `\u001b[<32;${col};${row}M`;
  const release = (row: number, col: number): string => `\u001b[<0;${col};${row}m`;

  const rowOf = (frame: string, text: string): number =>
    frame.split(/\r?\n/).findIndex((line) => line.includes(text)) + 1;

  it("copies the text dragged over, row by row", async () => {
    const copied: string[] = [];
    const { app, done } = await drive(["hello"], {
      copyToClipboard: async (text) => {
        copied.push(text);
        return true;
      },
    });

    const frame = app.lastFrame();
    const from = rowOf(frame, "hello");
    const to = rowOf(frame, "echo: hello");
    expect(from).toBeGreaterThan(1);
    expect(to).toBeGreaterThan(from);

    app.input.write(press(from, 1) + drag(to, 40) + release(to, 40));
    await tick(40);

    // Ctrl+C copies the mouse selection
    app.input.write("\u0003");
    await tick(40);

    // One copy, of everything between the two ends of the drag: a read of the
    // frame, not a second rendering of the transcript.
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain("hello");
    expect(copied[0]).toContain("echo: hello");
    expect(app.lastFrame()).toContain("copied");

    await finish(app, done);
  });

  it("copies nothing when the button goes down and comes up without moving", async () => {
    const copied: string[] = [];
    const { app, done } = await drive(["hello"], {
      copyToClipboard: async (text) => {
        copied.push(text);
        return true;
      },
    });

    const row = rowOf(app.lastFrame(), "echo: hello");
    app.input.write(press(row, 6) + release(row, 6));
    await tick(40);

    // A one-cell selection is noise, so it is dropped in silence rather than
    // copying whichever character the click happened to land on.
    expect(copied).toEqual([]);

    await finish(app, done);
  });

  it("gives up the highlight the moment a key is pressed", async () => {
    const copied: string[] = [];
    const { app, done } = await drive(["hello"], {
      copyToClipboard: async (text) => {
        copied.push(text);
        return true;
      },
    });

    const frame = app.lastFrame();
    const from = rowOf(frame, "hello");
    const to = rowOf(frame, "echo: hello");
    app.input.write(press(from, 1) + drag(to, 40));
    await tick(20);
    // Typing takes the keyboard back, which ends the selection — so the release
    // that follows has nothing to commit.
    app.input.write("x");
    await tick(20);
    app.input.write(release(to, 40));
    await tick(30);

    expect(copied).toEqual([]);

    await finish(app, done);
  });

  it("does not select the chrome under the rule", async () => {
    const copied: string[] = [];
    const { app, done } = await drive(["hello"], {
      copyToClipboard: async (text) => {
        copied.push(text);
        return true;
      },
    });

    // The rule closes the transcript; the prompt box and the status line live
    // below it, and neither is text anyone would paste.
    const rule = rowOf(app.lastFrame(), "─");
    app.input.write(press(rule + 1, 6) + drag(rule + 2, 30) + release(rule + 2, 30));
    await tick(40);

    expect(copied).toEqual([]);

    await finish(app, done);
  });
});

describe("pasting", () => {
  it("asks the terminal for bracketed paste, and gives it back", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick(15);

    // Without this a paste is delivered as if it had been typed, so every
    // newline inside it is a real Enter and the prompt goes off half-way down
    // the snippet — which reads as "pasting does not work".
    expect(app.raw()).toContain("\u001b[?2004h");

    app.input.write("\u0003");
    await done;
    expect(app.raw()).toContain("\u001b[?2004l");
  });

  it("takes a whole paste as one thing, newlines and all", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick(15);

    app.input.write("\u001b[200~one\ntwo\nthree\u001b[201~");
    await tick(30);

    // Flattened onto the prompt line, and — the point of the brackets — none
    // of the newlines inside it submitted anything.
    expect(app.lastFrame()).toContain("one two three");
    expect(app.screen()).not.toContain("echo: one");

    app.input.write("\r");
    await tick(30);
    expect(app.screen()).toContain("echo: one two three");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("takes alt+v too, because a terminal that binds ctrl+v never sends it", async () => {
    const { app, done } = await drive(["\u001bv"], {
      readClipboard: async () => ({ kind: "text", text: "pasted with alt", truncated: false }),
    });
    await finish(app, done);

    expect(app.screen()).toContain("echo: pasted with alt");
  });

  it("reads the clipboard on an empty paste, so ctrl+v with an image attaches it", async () => {
    const image: PastedImage = { data: "AAAA", mime: "image/png", bytes: 4096 };
    const app = harness({ readClipboard: async () => ({ kind: "image", image }) });
    const done = runTui(app.options);
    await tick(15);

    // What a terminal forwards when ctrl+v had no text to paste with — an
    // image has no text form, so without this the key silently dies.
    app.input.write("\u001b[200~\u001b[201~");
    await tick(40);

    expect(app.lastFrame()).toContain("attached image 1");
    expect(app.lastFrame()).toContain("[Image 1]");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("stays silent on an empty paste with an empty clipboard", async () => {
    const app = harness({ readClipboard: async () => ({ kind: "empty" }) });
    const done = runTui(app.options);
    await tick(15);

    app.input.write("\u001b[200~\u001b[201~");
    await tick(40);

    // Nothing was pasted and nothing was asked for: no warning blaming the
    // wrong key, and the prompt is untouched.
    expect(app.lastFrame()).not.toContain("clipboard is empty");
    expect(app.lastFrame()).toContain("Ask anything");

    app.input.write("\u0015/exit\r");
    await done;
  });

  it("pastes into a panel search field, not into the prompt hidden behind it", async () => {
    const { app, done } = await drive(["/models"], {
      listModels: async () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      readClipboard: async () => ({ kind: "text", text: "m3", truncated: false }),
    });

    app.input.write("\u0016");
    await tick(30);

    // Whoever has the keyboard gets the paste, which is the same code path the
    // terminal's own paste takes.
    expect(app.lastFrame()).toContain("m3");
    expect(app.lastFrame()).not.toContain("m1");

    await finish(app, done);
  });

  it("attaches a screenshot pasted while a list is open, where it can be seen", async () => {
    const image: PastedImage = { data: "AAAA", mime: "image/png", bytes: 4096 };
    const { app, done } = await drive(["/models"], {
      listModels: async () => [{ id: "m1" }, { id: "m2" }],
      readClipboard: async () => ({ kind: "image", image }),
    });

    app.input.write("\u0016");
    await tick(40);

    // The list stays up — a search you have half typed is worth more than the
    // convenience of seeing the note straight away — so the answer has to be on
    // the state row and not only in the transcript behind the panel.
    expect(app.lastFrame()).toContain("Select model");
    expect(app.lastFrame()).toContain("attached image 1");

    // Close the list and send: the image was attached, not merely announced.
    app.input.write("\u001b");
    await tick(60);
    app.input.write("look at this\r");
    await tick(40);
    expect(app.sentImages.at(-1)).toHaveLength(1);

    app.input.write("\u0015/exit\r");
    await done;
  });
});
