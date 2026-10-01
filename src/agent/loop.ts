import type { AskFn } from "./ask";
import { environmentPrompt } from "./environment";
import { imageUrl, type PastedImage } from "../clipboard";
import type { AssistantMessage, ChatMessage, ContentPart, Provider, Usage } from "../types";
import type { QuotaReading } from "../routes/quota";
import { compactMessages, estimateTokens, shouldCompact, type CompactionOptions } from "./compaction";
import type { ToolRegistry } from "./tools/types";

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
  | { type: "done"; reason: "complete" | "max-turns" | "budget"; ms?: number; completionTokens?: number; model?: string };

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
  "- When you verify something reusable — a procedure that worked, a gotcha with its fix — save it with the remember tool (a skill for procedures, a memory for project facts) and say what you saved. Never save secrets.",
  "- For work that spans several steps, track the steps with the todo tool: add them up front and mark each one done as it finishes, so the user watches the list move as you work.",
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

const DEFAULT_MAX_TURNS = 12;

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
   * to summarise or the summariser failed.
   */
  async compactNow(): Promise<{ before: number; after: number; summarized: number; target: number } | null> {
    const before = estimateTokens(this.messages);
    const result = await this.summarise();
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

    // The clock for the turn's own line. Taken here rather than per request so
    // a turn that ran six tools reports the whole turn, which is the wait the
    // user actually sat through.
    const startedAt = Date.now();
    let completionTokens = 0;
    const done = (reason: "complete" | "max-turns" | "budget"): AgentEvent => ({
      type: "done",
      reason,
      ms: Date.now() - startedAt,
      model: this.model,
      ...(completionTokens > 0 ? { completionTokens } : {}),
    });

    for (let turn = 0; turn < this.maxTurns; turn++) {
      yield* this.maybeCompact();

      // The ceiling is checked between requests, never mid-stream: a turn
      // already under way is finished, because stopping it would leave the
      // user with a half answer they did not ask to stop.
      if (this.budgetTokens > 0 && this.spent >= this.budgetTokens) {
        yield { type: "budget", spent: this.spent, limit: this.budgetTokens };
        yield done("budget");
        return;
      }

      let assistant: AssistantMessage | null = null;
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
            this.countUsage(event.usage);
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

      this.messages.push(assistant);
      const calls = assistant.tool_calls ?? [];
      if (calls.length === 0) {
        yield done("complete");
        return;
      }

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

        // A gated tool that reports this particular call as read-only is
        // exempt from both gates below: nothing can happen either way, and a
        // prompt about `git status` is noise. The tool decides, because only it
        // knows what its own arguments mean — and the classifier is its own,
        // conservative one.
        const readsOnly = this.readOnly && tool.readsOnly?.(args) === true;

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
        if (!readsOnly && tool.requiresApproval === true && !this.sessionApprovals.has(name)) {
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

        // The tool may have been stopped by the cancellation it was just
        // handed — a killed command still owes the model its result, but the
        // turn is over, so end it here rather than asking the provider for
        // another turn it would have to abort.
        if (signal.aborted) throw abortError();
      }
    }

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
  /** What the tools are given: where they run, how to reach the user, and the
   * signal that stops the turn they belong to. */
  private toolContext(signal?: AbortSignal): { cwd: string; ask?: AskFn; signal?: AbortSignal } {
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
  private async summarise(): Promise<{ summarized: number; target: number } | null> {
    if (!this.compaction) return null;

    try {
      const result = await compactMessages(this.provider, this.model, this.messages, this.compaction);
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
