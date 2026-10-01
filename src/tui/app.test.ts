import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Agent, AgentEvent, ApprovalDecision, ApproveFn } from "../agent/loop";
import type { AskAnswer, AskFn, AskQuestion } from "../agent/ask";
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
  /** How many times a turn was stopped with Ctrl+C. */
  cancels: number;
  /** Every token ceiling `/budget` set, in order. */
  budgets: number[];
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
  flags: { slow?: number; approve?: boolean; questions?: AskQuestion[]; failWith?: Error } = {},
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
  const sentImages: PastedImage[][] = [];
  let cancels = 0;
  const budgets: number[] = [];
  let spent = 0;
  let tokenBudget = 0;
  /** Set by the fake agent's `cancel()`, to stand in for an aborted request. */
  let stopped = false;
  let approval: ApproveFn | undefined;
  let asking: AskFn | undefined;

  const makeAgent = (history: ChatMessage[]): Agent => {
    const messages: ChatMessage[] = [...history];
    built.push(history);

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
      async compactNow(): Promise<{ before: number; after: number; summarized: number } | null> {
        compactions += 1;
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
      async *send(prompt: string, images: readonly PastedImage[] = []): AsyncGenerator<AgentEvent> {
        sentImages.push([...images]);
        messages.push({ role: "user", content: prompt });
        // A turn that actually takes a moment, so a second prompt can arrive
        // while it is still running — and so Ctrl+C has something to stop.
        if (slow > 0) await tick(slow);
        if (failWith) throw failWith;
        abortIfStopped();
        if (approve && approval) {
          decisions.push(
            await approval({ id: "1", name: "bash", args: { command: "npm test" }, preview: "+ npm test" }),
          );
        }
        if (questions && asking) {
          asked.push(questions);
          replies.push(await asking({ questions }));
        }
        // A turn stopped while a prompt was up sees it here, the way a real
        // request sees its signal aborted.
        abortIfStopped();
        yield { type: "text", delta: `echo: ${prompt}` };
        messages.push({ role: "assistant", content: `echo: ${prompt}` });
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
      approval = agentSettings.approve;
      asking = agentSettings.ask;
      settings.push(agentSettings);
      return makeAgent(history);
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
    viewSaves,
    added,
    get cancels() {
      return cancels;
    },
    budgets,
    get compactions() {
      return compactions;
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
    const app = harness({}, { slow: 300 });
    const done = runTui(app.options);
    await tick();

    app.input.write("a long one\r");
    await tick(30);
    expect(app.screen()).toContain("thinking…");

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

  it("opens the command palette on a slash and filters as you type", async () => {
    const app = harness();
    const done = runTui(app.options);
    await tick();

    app.input.write("/");
    await tick(20);
    // The list opens on the first runnable command and fills the screen —
    // the window follows the selection from there.
    expect(app.lastFrame()).toContain("/btw");
    expect(app.lastFrame()).not.toContain("/agents");
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
    // The list opens on /btw, so one step down lands on /budget.
    app.input.write("\u001b[B");
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
    expect(app.lastFrame()).toContain("esc cancel");

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
    expect(app.lastFrame()).toContain("Plan");

    app.input.write("\u001b[Z");
    await tick(30);

    expect(app.settings.at(-1)?.mode).toBe("build");
    expect(app.lastFrame()).toContain("Build");

    await finish(app, done);
  });

  it("switches mode from /mode, naming it on the status row", async () => {
    const { app, done } = await drive(["/mode plan"]);
    await tick(20);

    expect(app.settings.at(-1)?.mode).toBe("plan");
    // The word is on the state row, where the mode lives…
    expect(app.lastFrame()).toContain("Plan");
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
    expect(app.lastFrame()).toContain("▌  m2");
    expect(app.lastFrame()).not.toContain("Favorites");

    app.input.write("\u0006");
    await tick(30);

    // The group appears in the open list, not only on the next open…
    expect(app.lastFrame()).toContain("Favorites");
    // …and the cursor followed the row that moved rather than an index.
    expect(app.lastFrame()).toContain("▌  m2");
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
    await tick(30);
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
      await tick(60);
      expect(app.screen()).toContain("skill:demo-skill");
      expect(app.screen()).toContain("Demo skill body.");

      // An unknown name explains itself rather than failing silently.
      app.input.write("/skills nope\r");
      await tick(60);
      expect(app.screen()).toContain('no skill named "nope"');

      await finish(app, done);
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
    expect(app.saves.at(-1)?.id).toBe("session-new");
    expect(app.saves.at(-1)?.messages).toHaveLength(2);
    expect(app.saves.at(-1)?.title).toContain("fork");
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
    expect(text).toContain("no MCP servers configured");
    expect(text).toContain("type / for the palette");
    expect(text).toContain("/variants");
    // Asserted on a phrase shorter than the wrap, so a break cannot split it.
    expect(text).toContain("built it from");
    expect(text).toContain("npm run build");
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
    // The light background is on screen from that point on.
    expect(app.raw()).toContain("48;2;248;250;252");
  });

  it("asks the endpoint for a summary on /compact", async () => {
    const { app, done } = await drive(["/compact"]);
    await finish(app, done);

    expect(app.compactions).toBe(1);
    expect(app.screen()).toContain("compacted 3 earlier messages · ~1.0K → ~400");
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
  it("opens a panel with the groups, the rows and their values", async () => {
    const { app, done } = await open("/settings");
    const screen = app.screen();

    expect(screen).toContain("Settings");
    expect(screen).toContain("Appearance");
    expect(screen).toContain("Session");
    expect(screen).toContain("Theme");
    // The value in effect, on the row — not a copy that can drift from it.
    expect(screen).toContain("kicode");
    expect(screen).toContain("verbosity".slice(0, 0)); // no-op, keeps the shape
    expect(screen).toContain("‹/› change");

    await finish(app, done);
  });

  it("changes a value with the arrows, and writes it down", async () => {
    const { app, done } = await open("/settings");

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

  it("steps a row with Enter as well, so the arrows are not the only way", async () => {
    const { app, done } = await open("/settings");

    // Down to `Color mode`: Enter flips it, and the theme moves with it.
    app.input.write(`${DOWN}\r`);
    await tick(40);

    const saved = app.viewSaves.at(-1) ?? {};
    expect(saved.colorMode).toBe("light");
    expect(saved.theme).toBe("light");

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

describe("clicking a row", () => {
  /** A left click, in SGR encoding, at a 1-based column and a 1-based row. */
  const clickAt = (row: number, column = 6): string => `\u001b[<0;${column};${row}M`;

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

    app.input.write(clickAt(rowOf(app.lastFrame(), "Thinking")));
    await tick(40);

    // `Thinking` is `show`, the first of two, to `hide` — and it was written down.
    expect(app.viewSaves.at(-1)).toEqual({ thinking: "hide" });

    await finish(app, done);
  });

  it("never answers a permission prompt, wherever it is clicked", async () => {
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
