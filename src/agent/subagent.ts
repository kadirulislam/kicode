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
import type { AgentProfile } from "../agents";
import { childPrompt, toolsFor } from "../agents";
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

/**
 * The parent session's instructions about its named subagents.
 *
 * In the **system prompt**, not only in the tool description, because a tool
 * parameter is a capability and a system prompt is a policy. A model told only
 * that `agent` accepts a name will treat the name as a thing to verify — the
 * observed failure was a session asked about GitHub work that went looking for
 * `cody-git` on disk with `grep` before it would use one.
 *
 * `null` when there are none: a session with no subagents should not be told
 * about the possibility.
 */
export function namedSubagentPrompt(profiles: readonly AgentProfile[]): string | null {
  if (profiles.length === 0) return null;
  const list = profiles
    .map(
      (profile) =>
        `- ${profile.name} — ${profile.description || "no description"} (${
          profile.permissions === "write" ? "may edit files" : "read only"
        })`,
    )
    .join("\n");
  return [
    "Subagents:",
    "This session has named subagents. Each is a child agent with its own focus and its own",
    "permissions, and you reach one through the delegate tool's `agent` field.",
    "",
    list,
    "",
    "- When the user names one of these, delegate to it by name. Do that without checking whether it",
    "  exists and without asking whether to: they are already available to you, and looking for them",
    "  on disk is a wasted turn that answers a question you should already know the answer to.",
    "- When a task is broad, exploratory, or spans many files, and one of these fits it, delegate to",
    "  that one rather than reading everything yourself. That is what they are for, and their report",
    "  comes back to you.",
    "- If none of them fit the task, do the work yourself. Delegating to the wrong one is worse than",
    "  not delegating.",
    "- A subagent has no memory of this conversation. Put everything it needs in `context`: paths,",
    "  error text, and the constraint that matters.",
  ].join("\n");
}

/** What a finished child hands back to its parent. */
export type SubagentResult = {
  id: string;
  goal: string;
  /** The named agent that ran it, when the model chose one. */
  agent?: string;
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
  /** The named agent to run this as, when the batch is not homogeneous. */
  agent?: string;
};

export type SubagentRequest = {
  /** The registry row this child is showing up in, so the runner can update it. */
  id: string;
  goal: string;
  context?: string;
  /** Stops the child with the turn it belongs to. */
  signal: AbortSignal;
  /**
   * The profile named for this child, when the model chose one.
   *
   * Carried whole rather than as its parts, because the parts that matter —
   * which prompt, which tools, which model — are resolved *once*, here, into the
   * fields below. A builder on the other side that re-derived any of them would
   * be a second place for the permission grant to be re-read.
   */
  agent?: AgentProfile;
  /** Already resolved: the profile's pin, else the session's delegation pin. */
  model: string;
  /** Already resolved from the profile's permissions. */
  tools: readonly string[];
  /** Already assembled: the profile's specialisation plus the standing rules. */
  instructions: string;
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
  /**
   * Builds a child from values the delegate tool has already resolved.
   *
   * Everything that decides what a child may do arrives as an argument —
   * `tools`, `instructions`, `model` — rather than being re-derived here. The
   * permission grant in particular is read exactly once, in the tool that holds
   * the profile, so there is no second place for it to be misread.
   */
  create: (input: {
    goal: string;
    context: string;
    model: string;
    maxTurns: number;
    tools: readonly string[];
    instructions: string;
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
  const { registry, limits } = options;

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

    const child = options.create({
      goal: request.goal,
      context: request.context ?? "",
      model: request.model || options.model,
      maxTurns: options.maxIterations,
      tools: request.tools.length > 0 ? request.tools : toolsFor("read"),
      instructions: request.instructions || childPrompt(""),
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
      ...(request.agent ? { agent: request.agent.name } : {}),
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
  // The tool list is the truth here, and the prompt has to match it: told it
  // could run commands, a child spends a turn calling `bash` — which it was
  // never given — and the call comes back "unknown tool".
  "- You can read files, list them and search them. You cannot run commands, change anything, or ask the user a question, and asking for any of those is a wasted turn — if the task needs a change made, report what the change should be and stop.",
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

  start(id: string, goal: string, model: string, agent?: string): void {
    this.live.set(id, {
      id,
      goal: shortGoal(goal),
      model,
      status: "running",
      ms: 0,
      toolCalls: 0,
      ...(agent ? { agent } : {}),
    });
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
  /**
   * The named agents this session may choose from.
   *
   * Read at tool-build time and written into the description, because the tool
   * description is the only place a model learns what `cody-git` is. An `agent`
   * parameter with no names beside it is an invitation to guess.
   */
  profiles?: readonly AgentProfile[];
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
  const profiles = options.profiles ?? [];
  const byName = new Map(profiles.map((profile) => [profile.name, profile]));

  // The children of the call in flight, in the order the model asked for them.
  // The loop reads this after the call returns, so the transcript can count one
  // delegation's children rather than every child this session has ever spawned.
  let batch: string[] = [];

  /**
   * What a named agent turns into, with every choice already made.
   *
   * Refusing an unknown name rather than falling back to the generic child is
   * deliberate: a model that asked for `cody-gitt` and got a general-purpose
   * child back would not know it had been substituted, and would report the
   * result as the specialised thing it never ran.
   */
  const resolve = (name: unknown): AgentProfile | string => {
    if (name === undefined || name === null || name === "") return null as unknown as AgentProfile;
    if (typeof name !== "string") return "`agent` must be a name, not a value.";
    const wanted = name.trim();
    if (!wanted) return null as unknown as AgentProfile;
    const found = byName.get(wanted) ?? byName.get(wanted.toLowerCase());
    if (found) return found;
    const names = [...byName.keys()];
    return names.length
      ? `There is no agent named "${wanted}". The available agents are: ${names.join(", ")}.`
      : `There is no agent named "${wanted}", and no agents are defined — omit \`agent\` for a general-purpose one.`;
  };

  const runOne = async (
    task: SubagentTask,
    signal: AbortSignal,
    into: string[],
    agent: AgentProfile | null,
  ): Promise<SubagentResult> => {
    const id = nextId();
    into.push(id);
    // The profile's own pin wins; otherwise the session's delegation pin; and
    // empty there means the parent's model, which the caller resolves.
    const model = agent?.model || settings.model;
    registry.start(id, task.goal, model, agent?.name);
    const startedAt = Date.now();
    try {
      const result = await spawn({
        id,
        goal: task.goal,
        ...(task.context ? { context: task.context } : {}),
        signal,
        model,
        tools: toolsFor(agent?.permissions ?? "read"),
        instructions: childPrompt(agent?.instructions ?? ""),
        ...(agent ? { agent } : {}),
      });
      const summary = clampSummary(result.summary);
      registry.finish(id, {
        status: result.status,
        summary,
        ms: Date.now() - startedAt,
        ...(result.error ? { error: result.error } : {}),
      });
      return { ...result, id, summary, ...(agent ? { agent: agent.name } : {}) };
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
      "Delegate a task to a child agent: a fresh context, its own toolset, and its own model.",
      "Use it when the work is broad (many files or locations), exploratory (where is X handled),",
      "or splittable into independent parts worth doing at once — a batch of tasks runs in parallel",
      "and only their reports come back.",
      "A child starts with no memory of this conversation: put everything it needs in `context`,",
      "including paths, error text and the constraint that matters. Delegating \"the bug we were",
      "looking at\" delegates nothing.",
      "Do not delegate a single file lookup, a decision, or anything that depends on something the",
      "user said earlier in this conversation — a child cannot see it and cannot ask them.",
      // The names are here because this string is the only place a model learns
      // what `cody-git` is. An `agent` parameter with nothing beside it is an
      // invitation to guess.
      ...(profiles.length
        ? [
            `Set \`agent\` when one of these fits the task — prefer one over doing the work yourself: ${profiles
              .map(
                (profile) =>
                  `${profile.name} (${profile.description || "no description"}, ${
                    profile.permissions === "write" ? "may edit files" : "read only"
                  })`,
              )
              .join("; ")}.`,
            "When the user names one of them, use that one. Do not check whether it exists and do not ask whether to.",
            "Omit `agent` for a general-purpose child that only reads.",
          ]
        : []),
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the child should do, in one sentence." },
        context: {
          type: "string",
          description: "Everything the child needs: paths, errors, constraints, the test command.",
        },
        ...(profiles.length
          ? {
              agent: {
                type: "string",
                enum: profiles.map((profile) => profile.name),
                description: "A named agent to run this as. Omit for a general-purpose one.",
              },
            }
          : {}),
        tasks: {
          type: "array",
          description: "Independent tasks to run in parallel. Each is { goal, context, agent }.",
          items: {
            type: "object",
            properties: {
              goal: { type: "string" },
              context: { type: "string" },
              ...(profiles.length ? { agent: { type: "string", enum: profiles.map((profile) => profile.name) } } : {}),
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
          ? {
              goal: args.goal,
              ...(typeof args.context === "string" ? { context: args.context } : {}),
              // Carried through as-is rather than only when it is a string: an
              // `agent` of the wrong *type* has to be refused by `resolve`, not
              // quietly dropped into a general-purpose child.
              ...(args.agent !== undefined ? { agent: args.agent as string } : {}),
            }
          : null;

      const wanted = tasks.length > 0 ? tasks : single ? [single] : [];
      if (wanted.length === 0) {
        return { content: 'Error: delegate needs a `goal`, or a `tasks` array of { goal, context }.', isError: true };
      }

      // Every named agent is resolved before anything spawns, so a batch naming
      // one that does not exist is refused in full rather than half-run with a
      // substitute the model never asked for.
      const chosen = new Map<SubagentTask, AgentProfile | null>();
      for (const task of wanted) {
        const found = resolve(task.agent);
        if (typeof found === "string") {
          return { content: `Error: ${found}`, isError: true };
        }
        chosen.set(task, found);
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
        const settled = await Promise.all(slice.map((task) => runOne(task, signal, thisCall, chosen.get(task) ?? null)));
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
      // The agent's name is in the label, so a report from four specialists is
      // attributable without the parent having to remember which was which.
      const who = result.agent ? ` [${result.agent}]` : "";
      const label = `TASK ${index + 1}/${results.length}${who}: ${result.goal}`;
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
