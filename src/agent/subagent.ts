/**
 * Child agents: work the main session hands to a fresh context.
 *
 * A child is an ordinary `Agent` built with different values — a cheaper model,
 * a subset of the tools, and no approval or question channel — so isolation is
 * structural rather than a policy a call could slip past. It cannot write a
 * file or run a command because it is never given the tools that would, and it
 * cannot ask the user a question because `ask` is not registered without a
 * channel to answer it.
 *
 * Only the summary comes back. A child reads forty files so the parent does not
 * have to, and the parent receives a bounded report of what it found — which is
 * the whole reason a cheap model is usable here at all: the tokens are spent
 * where nobody has to read them, and the parent stays small.
 *
 * Flat by construction: a child's registry has no `delegate` tool, so there is
 * no second level to bound.
 */

import type { Agent } from "./loop";
import type { DelegationSettings } from "../config";
import type { SubagentView, Tool } from "./tools/types";

/**
 * One child, as the screen needs it: who it is, what it was asked, and how it
 * is going.
 *
 * The same shape the renderer takes, under the name the runner uses — one
 * definition, because two would drift and the drift would show up as a panel
 * that silently stops drawing a field.
 */
export type SubagentState = SubagentView;

/** What a finished child hands back to its parent. */
export type SubagentResult = {
  id: string;
  goal: string;
  status: SubagentState["status"];
  summary: string;
  /** How many requests it spent, so a batch can be judged for its cost. */
  requests: number;
  /**
   * Tokens the child was billed, when the provider reported them.
   *
   * Carried on the result rather than charged to the parent because a child is a
   * separate `Agent` with its own ledger, and folding it in would need a seam
   * from the tool back through the loop into the session's budget. Reported
   * instead, so the cost of a delegation is at least visible in the text the
   * parent reads — see ADR-053 for what is still missing.
   */
  tokens?: number;
  error?: string;
};

/** One task in a batch: what to do, and everything needed to do it. */
export type SubagentTask = {
  goal: string;
  /**
   * Everything the child cannot know.
   *
   * A child starts with an empty conversation: no history, no tool output, no
   * idea what was being discussed. This is the only thing it has, so a parent
   * that delegates "fix the bug we were looking at" has delegated nothing —
   * file paths, error text, and the constraint that matters all go here.
   */
  context?: string;
};

export type SubagentRequest = {
  /** The registry row this child is showing up in, so the runner can update it. */
  id: string;
  goal: string;
  context?: string;
  /** Stops the child with the turn it belongs to. */
  signal: AbortSignal;
};

/** Builds and runs one child to completion. */
export type SubagentSpawner = (request: SubagentRequest) => Promise<SubagentResult>;

/** What the runner needs to build a child, handed in by the run that owns it. */
/**
 * What the caller needs to supply to run children.
 *
 * Both callers — the TUI and the one-shot `--print` path — go through this, so
 * a child is built, watched and reported the same way whichever door it came in
 * by. Duplicating the runner per caller would have meant one of them quietly
 * losing the staleness cut-off.
 */
export type ChildRunnerOptions = {
  /** Builds a child: read-only tools, no approval, no question channel. */
  create: (input: {
    goal: string;
    context: string;
    model: string;
    maxTurns: number;
    signal: AbortSignal;
  }) => Agent;
  /** Where the child's progress is recorded for the panel and `/agents`. */
  registry: SubagentRegistry;
  /** Already resolved by the caller: the pin, or the parent's own model. */
  model: string;
  maxIterations: number;
  limits: { staleMs: number; staleToolMs: number };
  /**
   * Called on each event that moves the child, so a screen can repaint.
   *
   * Not called for every streamed word: the panel does not show them, and a
   * repaint per delta would redraw the frame hundreds of times to move a number
   * that had not moved.
   */
  onProgress?: () => void;
};

/**
 * Runs one child to its answer, and files what happened.
 *
 * Staleness is measured from the last sign of life and enforced by stopping the
 * child, not by refusing to wait for it: a wedged request would otherwise hold
 * the parent's turn open until the session's own ceiling, which is the one
 * thing a batch must never do. The turn's cancellation is relayed into the
 * child's own signal, so Ctrl+C still reaches everything.
 */
export function childRunner(options: ChildRunnerOptions): (request: SubagentRequest) => Promise<SubagentResult> {
  const { create, registry, limits } = options;

  return async (request: SubagentRequest): Promise<SubagentResult> => {
    const startedAt = Date.now();
    let requests = 0;
    let summary = "";
    let tokens = 0;
    let status: SubagentState["status"] = "completed";
    let error: string | undefined;

    const stop = new AbortController();
    const relaying = (): void => stop.abort();
    if (request.signal.aborted) stop.abort();
    else request.signal.addEventListener("abort", relaying, { once: true });

    const child = create({
      goal: request.goal,
      context: request.context ?? "",
      model: options.model,
      maxTurns: options.maxIterations,
      signal: stop.signal,
    });

    let lastSeen = Date.now();
    let inTool = false;
    let givenUp = false;
    const watchdog = setInterval(() => {
      if (givenUp || stop.signal.aborted) return;
      const idle = Date.now() - lastSeen;
      // A tool may be slower than a request: a long grep or a fetch is also
      // silent, and cutting one off would throw away work that was about to
      // land.
      if (idle < (inTool ? limits.staleToolMs : limits.staleMs)) return;
      givenUp = true;
      stop.abort();
      // Polled at a fraction of the shorter limit rather than on a flat
      // interval, so a configured `staleMs` is honoured as the number the user
      // wrote: a flat five-second tick would quietly turn one thousand into
      // five, and the setting would be lying about the only thing it promises.
    }, Math.min(5_000, Math.max(250, Math.floor(limits.staleMs / 6))));

    try {
      for await (const event of child.send(request.goal)) {
        lastSeen = Date.now();
        let moved = false;
        if (event.type === "text") {
          summary += event.delta;
        } else if (event.type === "tool-start") {
          requests += 1;
          inTool = true;
          moved = true;
        } else if (event.type === "tool-result") {
          inTool = false;
        } else if (event.type === "budget") {
          status = "stalled";
          error = `it spent its token budget (${event.spent} of ${event.limit})`;
          moved = true;
        } else if (event.type === "done" && event.reason !== "complete") {
          // A child that ran out of turns has still seen the task; saying so is
          // better than reporting a clean finish on partial work.
          if (status === "completed") {
            status = "stalled";
            error = event.reason === "max-turns" ? "it ran out of turns" : "it ran out of budget";
          }
          moved = true;
        } else if (event.type === "done") {
          tokens = (event.promptTokens ?? 0) + (event.completionTokens ?? 0);
        }
        if (!moved) continue;
        registry.progress(request.id, requests, Date.now() - startedAt);
        options.onProgress?.();
      }
    } catch (cause) {
      if (isAbortLike(cause)) {
        status = givenUp ? "stalled" : "interrupted";
        error = givenUp
          ? `no progress for ${Math.round((Date.now() - lastSeen) / 1000)}s`
          : "stopped with the turn";
      } else {
        status = "failed";
        error = (cause as Error).message;
      }
    } finally {
      clearInterval(watchdog);
      request.signal.removeEventListener("abort", relaying);
    }

    return {
      id: request.id,
      goal: request.goal,
      status,
      summary: summary.trim(),
      requests,
      ...(tokens > 0 ? { tokens } : {}),
      ...(error ? { error } : {}),
    };
  };
}

/**
 * Whether a thrown error is the work being stopped rather than failing.
 *
 * A child stopped with its turn says `interrupted`; one abandoned for going
 * quiet says `stalled`. The distinction is the parent's: it is what tells the
 * user whether to retry the delegation or press on.
 */
export function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}

/** How long a child's final answer may be before it is cut with a marker. */
const MAX_SUMMARY_CHARS = 8_000;
/** What a batch reports per child when its summary is long enough to need a name. */
const MAX_GOAL_CHARS = 120;

/**
 * How many children a session keeps.
 *
 * Bounded because the registry is the only record: the dock reads it, `/agents`
 * reads it, and a long session that delegated in every turn would otherwise grow
 * it without limit. Children are dropped oldest-settled-first, so nothing in
 * flight is ever the thing that disappears.
 */
const MAX_TRACKED = 12;

/** Ids are short, stable within a turn, and never reused. */
let childSeq = 0;

function nextId(): string {
  childSeq += 1;
  return `sa-${childSeq}`;
}

/**
 * The system prompt a child works under.
 *
 * Different from the parent's on purpose. The parent's rules are about a
 * conversation with a person — ask when it is their decision, track the work,
 * save what was learned. A child has no user to ask and nothing to remember, so
 * those rules would be instructions it cannot follow, and every one of them is a
 * chance to waste a turn.
 */
export const SUBAGENT_SYSTEM_PROMPT = [
  "You are a subagent working inside KiCode, on one delegated task.",
  "",
  "Rules:",
  "- You start with no memory of the conversation that sent you. Everything you need is in the task.",
  "- Inspect the real files before you conclude anything. Never guess at file contents.",
  "- You can read, search and run commands that only read. You cannot change anything, and asking for it is a wasted turn — if the task needs a change made, report what the change should be and stop.",
  "- Answer with a report, not a conversation: what you found, where (file paths and line numbers), and anything you could not determine.",
  "- If the task is ambiguous or you hit something only the user can decide, say so in a line under open questions rather than guessing.",
  "- Be brief. Your report is read by another agent with a full task of its own; detail you do not need is cost paid twice.",
].join("\n");

/** Trims a child's answer to something a parent can afford to read. */
function clampSummary(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_SUMMARY_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_SUMMARY_CHARS).trimEnd()}\n… (truncated — the child wrote ${trimmed.length} characters)`;
}

/** One line of a goal, for a panel row. */
function shortGoal(goal: string): string {
  const flat = goal.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_GOAL_CHARS ? flat : `${flat.slice(0, MAX_GOAL_CHARS - 1)}…`;
}

/**
 * Tracks every child this agent has spawned, so the screen can be told who is
 * working on what while it is happening.
 *
 * Held by the tool rather than by the run, because one tool instance belongs to
 * one agent: a session's children cannot appear in another's panel, and nothing
 * here is global.
 */
export class SubagentRegistry {
  private readonly live = new Map<string, SubagentState>();

  /** The panel's view: live children first, most recently started first. */
  snapshot(): SubagentState[] {
    return [...this.live.values()].sort((a, b) => (a.status === b.status ? 0 : a.status === "running" ? -1 : 1));
  }

  /**
   * The named children, in the order asked for.
   *
   * What the loop emits after a `delegate` call. Deliberately not
   * `snapshot()`: the registry is cumulative for the session, so the whole of it
   * would make a second delegation's count include the first one's children —
   * and a transcript row that says "delegated 5 tasks" for two delegations of
   * two is worse than no row.
   */
  of(ids: readonly string[]): SubagentState[] {
    return ids.flatMap((id) => {
      const current = this.live.get(id);
      return current ? [current] : [];
    });
  }

  start(id: string, goal: string, model: string): void {
    this.live.set(id, { id, goal: shortGoal(goal), model, status: "running", ms: 0, toolCalls: 0 });
    this.evict();
  }

  /**
   * Drops the oldest settled children once there are too many to keep.
   *
   * Only settled ones: a child in flight is the thing the panel exists to show,
   * so it is never the one that goes — even if that means the list grows past
   * the bound for the length of one batch.
   */
  private evict(): void {
    if (this.live.size <= MAX_TRACKED) return;
    const settled = [...this.live.values()].filter((child) => child.status !== "running");
    const excess = this.live.size - MAX_TRACKED;
    for (const child of settled.slice(0, excess)) this.live.delete(child.id);
  }

  progress(id: string, toolCalls: number, ms: number): void {
    const current = this.live.get(id);
    if (!current) return;
    this.live.set(id, { ...current, toolCalls, ms });
  }

  finish(id: string, patch: Partial<SubagentState>): void {
    const current = this.live.get(id);
    if (!current) return;
    this.live.set(id, { ...current, ...patch });
    this.evict();
  }
}

/**
 * What the tool itself enforces.
 *
 * A narrow slice of `DelegationSettings` rather than the whole block: the
 * staleness figures belong to whoever *runs* a child, because deciding that one
 * is wedged means stopping it, and that is the runner's job. Listing them here
 * would only invite the tool to look like it enforces something it does not.
 */
export type DelegateSettings = Pick<DelegationSettings, "model" | "maxConcurrent" | "maxPerTurn">;

export type DelegateToolOptions = {
  spawn: SubagentSpawner;
  registry: SubagentRegistry;
  settings: DelegateSettings;
  /** Charged against the parent's own turn so a runaway batch is refused early. */
  spawnCount: () => number;
};

/**
 * The `delegate` tool: one task, or a batch of independent ones.
 *
 * A batch is one call that runs several children at once, which is the whole
 * reason delegation pays. The parent would otherwise spend a round trip per
 * task; here the tasks overlap, so N of them cost roughly what one does plus N
 * cheap models' worth of work.
 */
export function delegateTool(options: DelegateToolOptions): Tool {
  const { spawn, registry, settings, spawnCount } = options;

  // The children of the call in flight, in the order the model asked for them.
  // The loop reads this after the call returns, so the transcript can count one
  // delegation's children rather than every child this session has ever spawned.
  let batch: string[] = [];

  const runOne = async (task: SubagentTask, signal: AbortSignal, into: string[]): Promise<SubagentResult> => {
    const id = nextId();
    into.push(id);
    const model = settings.model;
    registry.start(id, task.goal, model);
    const startedAt = Date.now();
    try {
      const result = await spawn({
        id,
        goal: task.goal,
        ...(task.context ? { context: task.context } : {}),
        signal,
      });
      const summary = clampSummary(result.summary);
      registry.finish(id, {
        status: result.status,
        summary,
        ms: Date.now() - startedAt,
        ...(result.error ? { error: result.error } : {}),
      });
      return { ...result, id, summary };
    } catch (error) {
      const message = (error as Error).message;
      registry.finish(id, { status: "failed", error: message, ms: Date.now() - startedAt });
      // A child that dies is never silent: the parent is told what failed and
      // why, and the rest of the batch still reports.
      return { id, goal: task.goal, status: "failed", summary: "", requests: 0, error: message };
    }
  };

  return {
    name: "delegate",
    description: [
      "Delegate a task to a child agent: a fresh context, a read-only toolset, and its own model.",
      "Use it when the work is broad (many files or locations), exploratory (where is X handled),",
      "or splittable into independent parts worth doing at once — a batch of tasks runs in parallel",
      "and only their reports come back.",
      "A child starts with no memory of this conversation: put everything it needs in `context`,",
      "including paths, error text and the constraint that matters. Delegating \"the bug we were",
      "looking at\" delegates nothing.",
      "Do not delegate a single file lookup, a decision, or anything that depends on something the",
      "user said earlier in this conversation — a child cannot see it and cannot ask them.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the child should do, in one sentence." },
        context: {
          type: "string",
          description: "Everything the child needs: paths, errors, constraints, the test command.",
        },
        tasks: {
          type: "array",
          description: "Independent tasks to run in parallel. Each is { goal, context }.",
          items: {
            type: "object",
            properties: {
              goal: { type: "string" },
              context: { type: "string" },
            },
            required: ["goal"],
          },
        },
      },
    },
    async run(args: Record<string, unknown>, context) {
      const tasks: SubagentTask[] = Array.isArray(args.tasks)
        ? (args.tasks as SubagentTask[]).filter((task) => typeof task?.goal === "string" && task.goal.trim() !== "")
        : [];
      const single: SubagentTask | null =
        typeof args.goal === "string" && args.goal.trim() !== ""
          ? { goal: args.goal, ...(typeof args.context === "string" ? { context: args.context } : {}) }
          : null;

      const wanted = tasks.length > 0 ? tasks : single ? [single] : [];
      if (wanted.length === 0) {
        return { content: 'Error: delegate needs a `goal`, or a `tasks` array of { goal, context }.', isError: true };
      }

      // The cap is refused, never silently applied: a batch quietly cut to four
      // is four tasks the model believes are running and are not.
      const room = settings.maxPerTurn - spawnCount();
      if (room <= 0) {
        return {
          content: `Error: this turn has already spawned its ${settings.maxPerTurn} subagents. Do the work directly, or wait for the next turn.`,
          isError: true,
        };
      }
      if (wanted.length > room) {
        return {
          content: `Error: ${wanted.length} tasks asked for but only ${room} subagents remain in this turn's budget of ${settings.maxPerTurn}. Delegate fewer, or do the rest directly.`,
          isError: true,
        };
      }

      const signal = context.signal ?? new AbortController().signal;
      const width = Math.max(1, Math.min(settings.maxConcurrent, wanted.length));
      const results: SubagentResult[] = [];
      // A fresh list per call: two `delegate` calls in one turn are two
      // delegations, and the second must not inherit the first's children.
      batch = [];
      const thisCall = batch;
      for (let at = 0; at < wanted.length; at += width) {
        const slice = wanted.slice(at, at + width);
        const settled = await Promise.all(slice.map((task) => runOne(task, signal, thisCall)));
        // In input order, not completion order: the model wrote them that way and
        // reads them that way.
        results.push(...settled);
      }

      return { content: renderReport(results) };
    },
    subagents: () => registry.of(batch),
  };
}

/**
 * The parent's report: one block per child, in the order they were asked for.
 *
 * A failure is a line of its own and never swallowed — a child that dies is the
 * one thing the parent must not have to go looking for.
 */
function renderReport(results: readonly SubagentResult[]): string {
  return results
    .map((result, index) => {
      const label = `TASK ${index + 1}/${results.length}: ${result.goal}`;
      if (result.status === "failed" || result.status === "interrupted" || result.status === "stalled") {
        return `${label}\n— ${result.status}: ${result.error ?? "no reason given"}`;
      }
      const cost = [
        result.requests > 0 ? `${result.requests} request${result.requests === 1 ? "" : "s"}` : "",
        result.tokens && result.tokens > 0 ? `${result.tokens} tokens` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return `${label}\n${result.summary || "(the child returned nothing)"}${cost ? `\n(${cost})` : ""}`;
    })
    .join("\n\n");
}
