import type { AskFn } from "./ask";
import { environmentPrompt } from "./environment";
import { imageUrl, type PastedImage } from "../clipboard";
import type { AssistantMessage, ChatMessage, ContentPart, FinishReason, Provider, Usage } from "../types";
import type { QuotaReading } from "../routes/quota";
import { compactMessages, estimateTokens, shouldCompact, type CompactionOptions } from "./compaction";
import { learnFromSession, type LearnResult } from "./learn";
import type { PlanSnapshot, SubagentView, ToolContext, ToolRegistry } from "./tools/types";

/**
 * A user turn's content: the words, and any pasted images beside them.
 *
 * A plain string when there are no images, so every message in every session
 * stays as readable as it was before this existed.
 */
export function userContent(text: string, images: readonly PastedImage[]): string | ContentPart[] {
  if (images.length === 0) return text;
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...images.map((image) => ({ type: "image_url" as const, image_url: { url: imageUrl(image) } })),
  ];
}

/**
 * The heart of the CLI.
 *
 * One `send()` call drives as many model turns as it takes: stream a turn,
 * execute every tool call it asked for, append the results, and go again until
 * the model answers without calling a tool (or the turn budget runs out).
 */

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool-start"; id: string; name: string; args: unknown }
  | { type: "tool-result"; id: string; name: string; content: string; isError: boolean }
  | { type: "compacted"; before: number; after: number; summarized: number; target: number }
  /** The request moved to a backup route, before any of it was seen. */
  | { type: "route"; from: string; to: string; reason: string }
  /** The router is pausing before its next attempt, waiting out a rate limit. */
  | { type: "route-wait"; ms: number; from: string; reason: string }
  /** What the gateway said about the quota it is enforcing. */
  | { type: "quota"; reading: QuotaReading }
  /** The session's token ceiling stopped the turn. */
  | { type: "budget"; spent: number; limit: number }
  /**
   * The reply was not an answer, so another one was asked for.
   *
   * The endpoint's output cap cut it off, or it arrived with neither words nor
   * a tool call. Said out loud because the user watched the model stop
   * mid-sentence, and "the cap did that" is not the same news as "the model
   * was finished".
   */
  | { type: "continued"; reason: "truncated" | "empty" | "work" | "steered"; attempt: number }
  /**
   * The plan or goal tools' own state, as data, after they ran.
   *
   * The text they return is what the model reads and the transcript shows;
   * this is the same state as plain data, so a screen can draw a checklist's
   * progress instead of parsing the tree the model was handed. Only tools that
   * hold such state emit it.
   */
  | { type: "plan"; snapshot: PlanSnapshot }
  /**
   * The child agents this turn has running, as data.
   *
   * Same reason as the `plan` event: the model is told a summary in prose, but a
   * screen needs to draw *who is working on what* — role, goal, model, how long
   * it has been going — and parsing the prose to get that is how a panel ends up
   * showing something the user can read but not trust. Emitted after any tool
   * that owns children, so the list is the runner's state and never a copy.
   */
  | { type: "subagents"; state: SubagentView[] }
  /**
   * The model thinking, before it answered. Only from endpoints that stream it.
   *
   * Kept apart from the answer all the way up: it is not what the model said,
   * and it must not end up in the transcript that the next request is built
   * from.
   */
  | { type: "reasoning"; delta: string }
  /**
   * The turn is over.
   *
   * `ms` and `completionTokens` are what the per-answer line is made of: how
   * long the model took, and how fast it wrote. Both are absent when they are
   * not known, and the line is simply not drawn.
   */
  | { type: "done"; reason: "complete" | "max-turns" | "budget"; ms?: number; completionTokens?: number; model?: string; promptTokens?: number; toolCalls?: number };

export type ApprovalRequest = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Diff or summary rendered by the tool, or null when it has no preview. */
  preview: string | null;
};

export type ApprovalDecision = "allow" | "deny" | "always";

export type ApproveFn = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export type AgentOptions = {
  provider: Provider;
  tools: ToolRegistry;
  model: string;
  cwd: string;
  systemPrompt?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  /**
   * Approval channel for tools marked `requiresApproval`. When absent, those
   * tools are refused rather than run.
   */
  approve?: ApproveFn;
  /**
   * Channel for the `ask` tool. Without it the tool is not registered, so the
   * model never sees a question it cannot get an answer to.
   */
  ask?: AskFn;
  /**
   * Refuse every tool that would change files or run commands, so the session
   * can investigate and plan without touching anything.
   */
  readOnly?: boolean;
  /**
   * Says whether this call may run without being put to the user.
   *
   * Asked only for a tool that is gated, and before the approval channel — so
   * an endpoint with no approval channel still refuses everything it would
   * have refused. The policy lives with the caller that knows the config
   * (`run.ts`); the loop only knows to ask.
   */
  allow?: (name: string, args: Record<string, unknown>) => boolean;
  /** Reasoning effort for this session, when it has been chosen. */
  reasoningEffort?: string;
  /** Session token ceiling; 0 or absent means none. */
  maxTokens?: number;
  /** Prior conversation to restore, excluding the system prompt. */
  history?: readonly ChatMessage[];
  /** Summarise older turns when the context window fills up. Off when omitted. */
  compaction?: CompactionOptions;
};

export const DEFAULT_SYSTEM_PROMPT = [
  "You are KiCode, a terminal coding assistant working in the user's current directory.",
  "",
  "Rules:",
  "- Inspect the real files with the read tool before answering questions about code. Never guess at file contents.",
  "- Prefer small, targeted changes over broad rewrites.",
  "- After using a tool, explain what you found or did in one or two sentences.",
  "- When the system prompt shows a brain (a project memory, a skills list), read it before you plan: it is what earlier sessions learned, and using it is cheaper than rediscovering it. Load a full skill or memory with the recall tool when a name looks relevant.",
  "- Save with the remember tool when the session produced something durable: the user stated a preference or made a decision (\"use pnpm\", \"never touch X\"); you hit a non-obvious gotcha and found the fix; you learned a project convention the code does not show (how to build, test or deploy it, a required env var); or you finished a procedure of three or more steps you would plausibly run again (a skill). When the briefing already showed this project's memory, add to it rather than repeating what is there.",
  "- Do not save one-off command output, file contents, code restated back, speculation, or transient errors (network, rate limits). Never save secrets, keys or tokens. When you do save, say in one sentence what you saved and where.",
  "- For work that spans several steps, track the steps with the todo tool: add them up front and mark each one done as it finishes, so the user watches the list move as you work.",
  "- Work to the end of the task in one turn: keep using tools until every tracked step is done, then answer. Do not stop mid-task to report progress or to ask whether to continue.",
  "- Ask the user (ask tool) only when the decision is genuinely theirs — a preference, a trade-off, a name, or how far a destructive change should reach. When a reasonable default exists, choose it, say in one sentence what you assumed, and continue. Use the ask tool over ending your turn with a prose question.",
  "- When the task is done, stop and wait for the user. Do not invent follow-up work.",
  "- If the user says 'pause' or requests a pause, immediately stop what you are doing, acknowledge that execution is paused, and wait for further instructions.",
  "- Responses go to a terminal: keep them concise and skip decorative formatting.",
].join("\n");

/**
 * Appended to the system prompt in plan mode.
 *
 * The tools are refused either way, but the model should know before it calls
 * one: a refusal it did not expect wastes a turn and reads as a failure.
 */
export const PLAN_MODE_PROMPT = [
  "Plan mode is on: this session is read-only.",
  "- Do not change anything. A tool or command that would is refused.",
  "- Commands that only read — ls, cat, grep, git status, git diff — are allowed and worth using.",
  "- Investigate with read, glob, grep and those commands, then present the plan with the `plan` tool (goal plus numbered steps) and track its steps with the `todo` tool.",
  "- When the plan is presented, stop. The user switches back to build mode with shift+tab.",
].join("\n");

/**
 * How many requests one turn may make before it stops of its own accord.
 *
 * A request is one model turn, and a task needs several: look, read, change,
 * verify. Twelve was the old bound and ordinary work reached it — the task was
 * not done, the model had not said it was, and the run simply ended. Forty is
 * still a bound, but it is one a real task does not hit by accident.
 */
export const DEFAULT_MAX_TURNS = 100;

/**
 * How many times one turn may re-ask a reply that was not an answer.
 *
 * Bounded because an endpoint that always cuts its replies off would otherwise
 * be asked forever; three is enough room for a long answer to arrive in
 * instalments.
 */
const MAX_CONTINUATIONS = 3;

/**
 * The error a cancelled turn ends with.
 *
 * Named `AbortError` so it is indistinguishable from the one an aborted fetch
 * throws: the UI tells a cancellation from a failure by that name alone, and a
 * turn stopped while a tool ran must not read as a crash.
 */
function abortError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

/** Whether an error is a cancellation, which is a decision and not a failure. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * What the tracked work still has outstanding, or null when there is none.
 *
 * The plan tools (todo, goal) know what they are holding; the loop only asks.
 * A registry with no such tool answers null, so this costs nothing by default.
 */
function pendingWork(tools: ToolRegistry): string | null {
  for (const tool of tools.list()) {
    const pending = tool.pendingWork?.();
    if (pending) return pending;
  }
  return null;
}

export class Agent {
  private readonly messages: ChatMessage[] = [];
  private readonly provider: Provider;
  private readonly tools: ToolRegistry;
  private readonly model: string;
  private readonly cwd: string;
  private readonly maxTurns: number;
  private readonly signal: AbortSignal | undefined;
  private readonly approve: ApproveFn | undefined;
  private readonly ask: AskFn | undefined;
  private readonly compaction: CompactionOptions | undefined;
  private readonly reasoningEffort: string | undefined;
  /** True in plan mode: the approval-gated tools are refused, not prompted. */
  private readonly readOnly: boolean;
  /** The caller's allow policy, asked before the approval channel. */
  private readonly allow?: (name: string, args: Record<string, unknown>) => boolean;
  /** Tokens reported by the provider this session, and the ceiling on them. */
  private spent = 0;
  private budgetTokens = 0;
  /** Tools the user answered "always" for, for the rest of this session. */
  private readonly sessionApprovals = new Set<string>();
  /**
   * The turn in flight, so it can be stopped on its own.
   *
   * A session's own signal may never be aborted at all; the thing the user
   * actually reaches for with Ctrl+C is the turn.
   */
  private turn: AbortController | null = null;
  /**
   * Messages the user pushed into the turn in flight, from the queue's `[Add+]`.
   *
   * Counted rather than set to a flag, because a reply already on its way has to
   * be told apart from one that answered these words: the count is read as a
   * high-water mark before each request, and a later reading that is higher
   * means the model has not seen them yet — so the reply cannot be the last word
   * on the turn.
   */
  private steered = 0;
  /**
   * Steered messages waiting for a safe moment to join the transcript.
   *
   * They cannot be appended where they arrived: words slipped between an
   * assistant's tool calls and the results that answer them would break the
   * pairing every endpoint insists on. The top of a loop iteration is the one
   * point where that pairing is always whole.
   */
  private readonly pendingSteers: Array<{ text: string; images: readonly PastedImage[] }> = [];

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.model = options.model;
    this.cwd = options.cwd;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.signal = options.signal;
    this.approve = options.approve;
    this.ask = options.ask;
    this.compaction = options.compaction;
    this.reasoningEffort = options.reasoningEffort;
    this.readOnly = options.readOnly === true;
    this.allow = options.allow;
    this.budgetTokens = Math.max(options.maxTokens ?? 0, 0);

    // The environment block is appended to whatever prompt the run was given,
    // so a directory's AGENTS.md adds to the picture rather than replacing it —
    // and the model always knows which shell `bash` will use.
    const system = [options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, environmentPrompt()];
    if (this.readOnly) system.push(PLAN_MODE_PROMPT);
    this.messages.push({ role: "system", content: system.join("\n\n") });
    if (options.history) this.messages.push(...options.history);
  }

  get history(): readonly ChatMessage[] {
    return this.messages;
  }

  /**
   * Everything after the system prompt — exactly what gets persisted. The
   * system prompt is code, not conversation, so it is not saved with it.
   */
  get turns(): ChatMessage[] {
    return this.messages.slice(1);
  }

  /** Estimated size of the transcript, for the status line. */
  get contextTokens(): number {
    return estimateTokens(this.messages);
  }

  /** How many tools the next request offers — the `/context` system row. */
  get toolCount(): number {
    return this.tools.list().length;
  }

  /** What this session can call — names and one-line descriptions, for a screen that lists them. */
  get toolList(): { name: string; description: string }[] {
    return this.tools.list().map((tool) => ({ name: tool.name, description: tool.description }));
  }

  /** The tool declarations, in request shape — estimated into the system row. */
  get toolSpecTokens(): number {
    return estimateTokens(this.tools.specs());
  }

  /** Tokens the provider has reported for this session. */
  get spentTokens(): number {
    return this.spent;
  }

  /** The session's token ceiling, or 0 when there is none. */
  get tokenBudget(): number {
    return this.budgetTokens;
  }

  /** Raises or lowers the ceiling mid-session. 0 removes it. */
  setBudget(tokens: number): void {
    this.budgetTokens = Math.max(Math.trunc(tokens) || 0, 0);
  }

  /** The window compaction keeps the transcript inside, or 0 when it is off. */
  get contextBudget(): number {
    return this.compaction?.contextTokens ?? 0;
  }

  /**
   * Replaces the conversation after the system prompt.
   *
   * `/undo` and `/fork` move the transcript, and the model has to be looking at
   * the same thing the user is.
   */
  rewind(turns: readonly ChatMessage[]): void {
    this.messages.splice(1, this.messages.length - 1, ...turns);
  }

  /**
   * Summarises now, whether or not the window is full, so `/compact` can be
   * asked for rather than only waited for. Returns null when there is nothing
   * to summarise or the summariser failed. A signal stops a summariser that is
   * not answering — the caller (Ctrl+C on a manual run) owns it.
   */
  async compactNow(signal?: AbortSignal): Promise<{ before: number; after: number; summarized: number; target: number } | null> {
    const before = estimateTokens(this.messages);
    // Explicit, so the pass runs whether or not the window is full: this is the
    // one compaction the user asked for by name.
    const result = await this.summarise(true, signal);
    if (!result) return null;
    return { before, after: estimateTokens(this.messages), summarized: result.summarized, target: result.target };
  }

  /**
   * One question answered from the conversation so far, recorded nowhere.
   *
   * No tools and no mutation: `/btw` is for asking without changing what the
   * model will see on the next real turn.
   */
  async *sideQuestion(text: string): AsyncGenerator<string, void, void> {
    const messages: ChatMessage[] = [...this.messages, { role: "user", content: text }];
    const controller = new AbortController();
    const end = this.beginTurn(controller);

    try {
      for await (const event of this.provider.stream({ model: this.model, messages, signal: controller.signal })) {
        if (event.type === "text") yield event.delta;
      }
    } finally {
      end();
    }
  }

  /**
   * The learning pass over this session, for a caller to run after a turn.
   *
   * Deliberately not part of `send()`: a turn ends when the answer does, and a
   * second request that exists to help a *future* session must not delay the
   * one the user is reading. The caller fires this off and forgets it.
   */
  async learn(signal?: AbortSignal): Promise<LearnResult> {
    return learnFromSession({
      messages: this.turns,
      provider: this.provider,
      model: this.model,
      cwd: this.cwd,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Stops the turn in flight, if there is one.
   *
   * The stop is felt where the turn next talks to the provider: that request is
   * aborted, its stream ends there, and everything that had already happened is
   * kept — the reply so far on screen, and the tools that ran with their
   * results in the transcript, because they did.
   */
  cancel(): void {
    this.turn?.abort();
  }

  /**
   * Puts a message (and any images with it) into the turn in flight, to be
   * answered before it ends.
   *
   * This is what the queue's `[Add+]` reaches for. A queue is right when the
   * next words can wait; this is for when they cannot — the model is a step
   * away from the wrong thing and the correction is worth more now than after
   * the turn. The words join the transcript at the end, so the model reads them
   * on its very next request, rather than after everything already queued.
   *
   * Nothing is sent here. A turn talks to the provider in exactly one place, and
   * a request fired from here would race the one already in flight — the words
   * are held until the loop reaches the next request. Returns false when no turn
   * is running, which is the caller's cue to just run it.
   */
  steer(text: string, images: readonly PastedImage[] = []): boolean {
    if (!this.turn || this.turn.signal.aborted) return false;
    this.pendingSteers.push({ text, images });
    this.steered += 1;
    return true;
  }

  /**
   * Moves held steers into the transcript, and reports how many landed.
   *
   * Called at the top of every loop iteration — the one point where the
   * transcript is whole, with no tool call still waiting on its result — and
   * once more when the turn has run out of iterations, so words the user added
   * are never dropped on the floor.
   */
  private flushSteers(): number {
    if (this.pendingSteers.length === 0) return 0;
    const added = this.pendingSteers.length;
    for (const held of this.pendingSteers) {
      this.messages.push({ role: "user", content: userContent(held.text, held.images) });
    }
    this.pendingSteers.length = 0;
    return added;
  }

  /**
   * One turn.
   *
   * `images` are pasted screenshots, already base64. They travel beside the
   * words as content parts, which is the only shape an image can take here.
   *
   * A turn can be stopped while it runs (`cancel`), which is what `Ctrl+C` in the
   * UI does: the aborted request is what ends the generator.
   */
  async *send(userText: string, images: readonly PastedImage[] = []): AsyncGenerator<AgentEvent, void, void> {
    const controller = new AbortController();
    const end = this.beginTurn(controller);

    try {
      yield* this.run(controller.signal, userText, images);
    } finally {
      end();
    }
  }

  /**
   * Registers a controller as the thing in flight, and returns the undo.
   *
   * The session's signal is folded in, so a caller that aborts the whole session
   * still stops this turn — there are two reasons to stop, and one signal per
   * request to carry them.
   */
  private beginTurn(controller: AbortController): () => void {
    const session = this.signal;
    const abort = (): void => controller.abort();
    if (session) {
      if (session.aborted) controller.abort();
      else session.addEventListener("abort", abort);
    }
    this.turn = controller;

    return () => {
      session?.removeEventListener("abort", abort);
      if (this.turn === controller) this.turn = null;
    };
  }

  /** The turn itself, under the signal that can stop it. */
  private async *run(signal: AbortSignal, userText: string, images: readonly PastedImage[]): AsyncGenerator<AgentEvent, void, void> {
    this.messages.push({ role: "user", content: userContent(userText, images) });
    // A turn starts with nothing held over from the last one. Words pushed into
    // a turn that was cancelled were never sent, so carrying them into the next
    // turn would answer a message the user has since re-thought — the UI puts
    // them back in the queue instead.
    this.pendingSteers.length = 0;

    // The clock for the turn's own line. Taken here rather than per request so
    // a turn that ran six tools reports the whole turn, which is the wait the
    // user actually sat through.
    const startedAt = Date.now();
    let completionTokens = 0;
    // The turn's own cost ledger, for the machine-wide usage file: what the
    // provider reported across this turn's requests, and how many tools ran.
    let promptTokens = 0;
    let toolCalls = 0;
    const done = (reason: "complete" | "max-turns" | "budget"): AgentEvent => ({
      type: "done",
      reason,
      ms: Date.now() - startedAt,
      model: this.model,
      ...(completionTokens > 0 ? { completionTokens } : {}),
      ...(promptTokens > 0 ? { promptTokens } : {}),
      ...(toolCalls > 0 ? { toolCalls } : {}),
    });

    // How many replies in a row were not answers. Reset by any turn that ran a
    // tool, because that is progress — the thing this counter exists to bound.
    let continuations = 0;
    // The same bound on "stopped while tracked work was still open": a model
    // that keeps declining the work is asked three times, then the turn ends.
    let workNudges = 0;

    for (let turn = 0; turn < this.maxTurns; turn++) {
      yield* this.maybeCompact();

      // Words the user pushed into this turn while it was working. They join the
      // transcript here, where whatever tools ran last have already appended
      // their results, and never mid-stream — see `steer`. The event fires from
      // this same point, not from where the click landed, so a message added
      // during a slow tool is reported too: without it the tile simply vanished
      // and the wait had no explanation.
      const added = this.flushSteers();
      if (added > 0) yield { type: "continued", reason: "steered", attempt: added };

      // The ceiling is checked between requests, never mid-stream: a turn
      // already under way is finished, because stopping it would leave the
      // user with a half answer they did not ask to stop.
      if (this.budgetTokens > 0 && this.spent >= this.budgetTokens) {
        yield { type: "budget", spent: this.spent, limit: this.budgetTokens };
        yield done("budget");
        return;
      }

      // Read before the request is built, so a message pushed while this reply
      // streams is recognised afterwards as one the model has not seen.
      const steeredAtRequest = this.steered;

      let assistant: AssistantMessage | null = null;
      // Why the endpoint stopped writing. `length` means its own output cap cut
      // the reply off mid-thought, which is not the same thing as an answer.
      let finishReason: FinishReason = "stop";
      // The reply as it streams, so a stopped turn can keep it. The provider's
      // `finish` message is the authoritative copy, but a cancelled stream
      // never sends one — these deltas are all there is of what it said.
      let partial = "";

      try {
        for await (const event of this.provider.stream({
          model: this.model,
          // Snapshot the transcript: the provider must see the turn as it was,
          // not the array as it mutates while tools run.
          messages: [...this.messages],
          tools: this.tools.specs(),
          ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
          signal,
        })) {
          if (event.type === "text") {
            partial += event.delta;
            yield { type: "text", delta: event.delta };
          } else if (event.type === "route" || event.type === "route-wait" || event.type === "quota" || event.type === "reasoning") {
            yield event;
          } else if (event.type === "finish") {
            assistant = event.message;
            finishReason = event.finishReason;
            this.countUsage(event.usage);
            promptTokens += event.usage?.promptTokens ?? 0;
            completionTokens += event.usage?.completionTokens ?? 0;
          }
        }
      } catch (error) {
        // A cancelled turn keeps the words it had already produced. They are on
        // screen and the user read them, so leaving them out of the transcript
        // would make "continue" start from nothing — and the next request is
        // built from exactly this transcript.
        if (isAbort(error)) this.keepPartial(partial);
        throw error;
      }

      // A provider that ends a turn without a `finish` event produced nothing
      // usable; stopping is safer than looping.
      if (!assistant) {
        yield done("complete");
        return;
      }

      const calls = assistant.tool_calls ?? [];
      const said = (assistant.content ?? "").trim().length > 0;

      // A turn ends at an answer — not merely at the absence of a tool call.
      // Two kinds of reply are not answers and both used to end the turn in
      // silence: one the endpoint cut off at its output cap (`length`), and one
      // that arrived with neither words nor a tool call. The work was not done
      // and the model had not said it was, so the turn asks again.
      if (calls.length === 0 && (finishReason !== "stop" || !said) && continuations < MAX_CONTINUATIONS) {
        continuations += 1;
        // Words that were cut off are kept and built on — they are what the
        // model had written, and the next request continues from them. A reply
        // with no words at all is not kept: an empty assistant message is a
        // turn the model never really made, and some endpoints refuse one back.
        if (said) this.messages.push(assistant);
        yield { type: "continued", reason: said ? "truncated" : "empty", attempt: continuations };
        continue;
      }

      // Progress, so the allowance is fresh for whatever comes next.
      if (calls.length > 0) {
        continuations = 0;
        workNudges = 0;
      }

      if (calls.length === 0) {
        // The words, when there were any, are the answer and are kept. An
        // empty reply that has run out of allowances is dropped rather than
        // recorded as a turn that said nothing.
        if (said) this.messages.push(assistant);

        // The user pushed a message into this turn while the reply was being
        // written. That reply answers the turn as it stood *before* those words
        // arrived, so it cannot end the turn: they are in the transcript and
        // nothing has answered them yet. The message is its own instruction, so
        // it is not nudged or re-asked — the next request simply carries it.
        if (this.steered > steeredAtRequest) {
          // No event here: the words have not joined the transcript yet, and the
          // next iteration says so from where they actually do.
          continue;
        }

        // A turn ends at an answer — unless the work being tracked is not
        // finished. A reply that stops mid-task is not the end of the task,
        // and "the agent stopped" is the single loudest complaint there is.
        // Plan mode is exempt: an open list there is the plan itself, whose
        // deliverable is stopping for review. The nudge is bounded the same
        // way the re-ask is — a model that refuses the work gets three tries,
        // not an infinite loop — and any tool call hands the allowance back,
        // because that is progress.
        const pending = this.readOnly ? null : pendingWork(this.tools);
        if (pending && workNudges < MAX_CONTINUATIONS) {
          workNudges += 1;
          this.messages.push({
            role: "user",
            content:
              `The task is not finished: ${pending}.\n` +
              "Continue working on it now — do not stop to report progress. " +
              "If the user's request is actually complete, or the remaining steps are no longer wanted, mark them done or clear the list with the todo tool and say what changed. " +
              "If you are blocked on a decision only the user can make, use the ask tool instead of stopping.",
          });
          yield { type: "continued", reason: "work", attempt: workNudges };
          continue;
        }

        yield done("complete");
        return;
      }

      this.messages.push(assistant);

      for (const call of calls) {
        const name = call.function.name;

        const tool = this.tools.get(name);
        if (!tool) {
          yield* this.rejectToolCall(call.id, name, `Error: unknown tool "${name}".`);
          continue;
        }

        let args: Record<string, unknown>;
        try {
          const parsed: unknown = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("arguments must be a JSON object");
          }
          args = parsed as Record<string, unknown>;
        } catch (error) {
          // Never let a truncated or malformed argument string kill the run —
          // tell the model what happened so it can retry with valid JSON.
          yield* this.rejectToolCall(call.id, name, `Error: invalid JSON arguments for "${name}" — ${(error as Error).message}`);
          continue;
        }

        // A gated tool that reports this particular call as read-only is exempt
        // from both gates below: nothing can happen either way, and a prompt
        // about `git status` is noise. The tool decides, because only it knows
        // what its own arguments mean — and the classifier is its own,
        // conservative one.
        //
        // Deliberately not conditioned on plan mode any more: reading a file is
        // as harmless in build mode as it is in plan mode, and asking about it
        // every time is what made the approval prompt something people learn to
        // dismiss without reading.
        const readsOnly = tool.readsOnly?.(args) === true;
        // The caller's own policy (config `allow` rules). Asked here rather than
        // inside the approval channel so that a run with no channel still
        // refuses what it always refused.
        const allowed = this.allow?.(name, args) === true;

        // Plan mode refuses what would change anything, before the approval
        // prompt rather than through it: a dialog the user is expected to
        // refuse every time is worse than a refusal the model can read.
        if (this.readOnly && tool.requiresApproval === true && !readsOnly) {
          // The tool may know exactly what is wrong with this call, and saying
          // so saves the model from guessing at the same mistake again. A tool
          // that throws while explaining itself must not kill the turn.
          let because = "it would change something";
          try {
            because = tool.readOnlyRefusal?.(args) ?? because;
          } catch {
            // Keep the general sentence.
          }
          yield* this.rejectToolCall(
            call.id,
            name,
            `Error: "${name}" was refused because plan mode is on — ${because}. ` +
              "Describe what you would do instead, and stop so the user can switch to build mode (shift+tab).",
          );
          continue;
        }

        // Destructive tools are gated. With no approval channel the answer is
        // always no — silence must never mean "go ahead and overwrite files".
        if (!readsOnly && !allowed && tool.requiresApproval === true && !this.sessionApprovals.has(name)) {
          if (!this.approve) {
            yield* this.rejectToolCall(
              call.id,
              name,
              `Error: "${name}" needs the user's approval, but this session has no approval channel. Re-run with --yes to allow it.`,
            );
            continue;
          }

          let preview: string | null = null;
          if (tool.preview) {
            try {
              preview = await tool.preview(args, this.toolContext(signal));
            } catch {
              // A broken preview must not block the approval prompt itself.
              preview = null;
            }
          }

          const decision = await this.approve({ id: call.id, name, args, preview });
          if (decision === "deny") {
            yield* this.rejectToolCall(call.id, name, `Error: the user denied permission to run "${name}".`);
            continue;
          }
          if (decision === "always") this.sessionApprovals.add(name);
        }

        yield { type: "tool-start", id: call.id, name, args };
        // Past approval and refusal: this call runs, so it counts — toward
        // the turn's own ledger, not just the session total.
        toolCalls += 1;

        let content: string;
        let isError = false;
        try {
          const result = await tool.run(args, this.toolContext(signal));
          content = result.content;
          isError = result.isError === true;
        } catch (error) {
          content = `Error: ${(error as Error).message}`;
          isError = true;
        }

        this.messages.push({ role: "tool", tool_call_id: call.id, content });
        yield { type: "tool-result", id: call.id, name, content, isError };

        // A tool with state of its own (the plan tools) hands it over as data
        // too, so the screen can show progress without reading the text.
        const snapshot = tool.snapshot?.();
        if (snapshot) yield { type: "plan", snapshot };

        // The same, for the child agents a tool is running: the panel needs to
        // know who is working on what while it is happening, not only once the
        // tool has returned a summary of all of it.
        const children = tool.subagents?.();
        if (children && children.length > 0) yield { type: "subagents", state: children };

        // The tool may have been stopped by the cancellation it was just
        // handed — a killed command still owes the model its result, but the
        // turn is over, so end it here rather than asking the provider for
        // another turn it would have to abort.
        if (signal.aborted) throw abortError();
      }
    }

    // Out of iterations with words still held: they never reached a request, but
    // they are the user's and they are kept, so the next turn is asked them
    // rather than the message being lost with the tile that carried it.
    this.flushSteers();
    yield done("max-turns");
  }

  /**
   * Saves the reply a stopped turn had already produced.
   *
   * Recorded verbatim, as the assistant's own message: it is what the model
   * wrote, so it reads as its half-finished thought and "continue" picks up
   * from there. An empty stream adds nothing — that turn said nothing, and an
   * empty assistant message would be a turn the model never made.
   */
  private keepPartial(text: string): void {
    if (text.length === 0) return;
    this.messages.push({ role: "assistant", content: text });
  }

  /**
   * Adds a provider's reported usage to the session total.
   *
   * `totalTokens` is used when the gateway sends it; otherwise the parts are
   * added, which is what every OpenAI-compatible endpoint provides. A gateway
   * that reports nothing counts as zero — an invented number would be worse
   * than an honest gap.
   */
  private countUsage(usage: Usage | undefined): void {
    if (!usage) return;
    this.spent += usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
  }

  /**
   * Replaces older turns with a summary when the transcript outgrows the
   * window. Runs between turns, never mid-tool-sequence, so tool-call pairing
   * is never broken. If the summary call fails we continue over budget rather
   * than losing the conversation.
   */
  /** What the tools are given: where they run, how to reach the user, how to
   * spawn a child agent, and the signal that stops the turn they belong to. */
  private toolContext(signal?: AbortSignal): ToolContext {
    return {
      cwd: this.cwd,
      ...(this.ask ? { ask: this.ask } : {}),
      ...(signal ? { signal } : {}),
    };
  }

  private async *maybeCompact(): AsyncGenerator<AgentEvent, void, void> {
    if (!this.compaction || !shouldCompact(this.messages, this.compaction)) return;

    const before = estimateTokens(this.messages);
    const result = await this.summarise();
    if (!result) return;

    yield { type: "compacted", before, after: estimateTokens(this.messages), summarized: result.summarized, target: result.target };
  }

  /**
   * Summarises the transcript in place, or returns null.
   *
   * A failed summary is not fatal: going over budget is better than losing the
   * conversation, so the caller carries on either way.
   */
  private async summarise(manual = false, signal?: AbortSignal): Promise<{ summarized: number; target: number } | null> {
    if (!this.compaction) return null;

    try {
      const options = manual ? { ...this.compaction, manual: true } : this.compaction;
      const result = await compactMessages(this.provider, this.model, this.messages, options, signal);
      if (!result) return null;
      this.messages.splice(0, this.messages.length, ...result.messages);
      return { summarized: result.summarized, target: result.target };
    } catch {
      return null;
    }
  }

  private async *rejectToolCall(id: string, name: string, content: string): AsyncGenerator<AgentEvent, void, void> {
    this.messages.push({ role: "tool", tool_call_id: id, content });
    yield { type: "tool-result", id, name, content, isError: true };
  }
}
