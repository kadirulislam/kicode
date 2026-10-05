import type { AskFn } from "../ask";
import type { SubagentSpawner } from "../subagent";

/**
 * One child agent, as the screen draws it.
 *
 * Re-exported here rather than imported by the renderer so the frame depends on
 * the tool layer's shape and not on the runner that produces it — the same
 * boundary the plan snapshot keeps.
 */
export type SubagentView = {
  id: string;
  /** One line: what the child was asked to do. */
  goal: string;
  /** Which model it is actually on — the parent's, or the delegated pin. */
  model: string;
  /** The named agent running it, when the model chose one. */
  agent?: string;
  status: "running" | "completed" | "failed" | "interrupted" | "stalled";
  /** How long it has run, or took. */
  ms: number;
  /** Requests spent, which is the only number that says it is moving. */
  toolCalls: number;
  /**
   * How many times this task has been attempted, once it has needed a second.
   *
   * On the view because the retry does not get its own row — it is the same task,
   * and a second row made one unfinished task look like two. So this is the only
   * way the panel can say a child had to be tried again.
   */
  attempts?: number;
  summary?: string;
  error?: string;
};
import type { ToolSpec } from "../../types";

export type ToolContext = {
  cwd: string;
  /** Absent when nobody can answer, in which case the ask tool is not offered. */
  ask?: AskFn;
  /**
   * Spawns a child agent, when delegation is on.
   *
   * Carried on the context rather than closed over by the tool, because the
   * factory belongs to the run — it holds the provider, the config and the
   * working directory — and the tool list is built once per agent from a static
   * array.
   */
  delegate?: SubagentSpawner;
  /**
   * The turn's signal, so a tool that runs for a long time can stop when the
   * turn is cancelled. A short tool can ignore it; `bash` kills the child.
   */
  signal?: AbortSignal;
};

export type ToolResult = {
  /** Goes back to the model verbatim as the `tool` message content. */
  content: string;
  /** Marks the result as a failure so the UI can render it differently. */
  isError?: boolean;
};

/** One tracked task, as a UI needs it to draw a checklist. */
export type PlanTodo = { text: string; done: boolean; inProgress?: boolean };

/** One subtask of an autonomous goal. */
export type PlanTask = { id: string; title: string; status: "open" | "in_progress" | "done" };

/**
 * The plan tools' own state, as plain data.
 *
 * The rendered text a tool returns is for the model and the transcript; this is
 * for a screen that wants to draw progress — a checklist's `n/m`, a goal's
 * subtask bar. It is deliberately just data: the renderer decides what it looks
 * like, and neither the loop nor the tool knows anything about a terminal.
 */
export type PlanSnapshot = {
  todos: PlanTodo[];
  goal: {
    title: string;
    status: "running" | "completed" | "paused";
    tasks: PlanTask[];
    current?: string;
  } | null;
};

export type Tool = {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  /** When true, the loop must ask before running this tool. */
  requiresApproval?: boolean;
  /**
   * True when this tool may run **at the same time as** the others in one turn.
   *
   * Absent means no — the safe default, because a tool nobody has thought about
   * overlapping should not start overlapping the moment it is registered. Only
   * the tools that provably change nothing carry it (`read`, `glob`, `grep`,
   * `recall`), and those are exactly the ones a model emits a dozen of at once
   * when it is exploring: run in sequence, eighteen reads cost eighteen round
   * trips, and that is the whole of the wait.
   *
   * Deliberately *not* inferred from `requiresApproval`. An MCP tool on an
   * auto-approved server has no gate and can still write, so "ungated" is not
   * the same question as "cannot change anything".
   */
  concurrencySafe?: boolean;
  /**
   * True when this particular call only reads, and so may run in plan mode.
   *
   * A tool that is gated but sometimes harmless says which invocations are:
   * refusing `git status` is as wrong as allowing `rm -rf`, and only the tool
   * knows the difference. Absent means "never" — the safe default, since an
   * unknown call must not slip past the read-only gate.
   */
  readsOnly?(args: Record<string, unknown>): boolean;
  /**
   * Why this call would change something, for the refusal the model reads in
   * plan mode.
   *
   * Only consulted when the call is actually refused, so a tool that can say
   * precisely what is wrong with one invocation says it here — `"bash" was
   * refused because plan mode is on — \`git push\` is not a read-only git
   * subcommand` tells the model where to go next, where a bare "it would change
   * something" sends it guessing again. Null, or absent, falls back to that
   * general sentence.
   */
  readOnlyRefusal?(args: Record<string, unknown>): string | null;
  /**
   * Tracked work this tool still holds open, or null when there is none.
   *
   * The loop reads this when a turn would otherwise end: a reply that stops
   * while work the tool is tracking is unfinished is not the end of the task,
   * and the turn is asked to carry on (bounded). The tool knows, because the
   * list lives in its own session state.
   */
  pendingWork?(): string | null;
  /**
   * The child agents this tool currently has running, as data.
   *
   * The same contract as `snapshot()`, and for the same reason: the loop draws
   * from this rather than parsing what the tool returned, so a panel showing
   * "who is working on what" is reading the runner's own state rather than a
   * sentence about it. Only the `delegate` tool implements it.
   */
  subagents?(): SubagentView[];
  /**
   * The tool's own state as plain data, or null when it has none to show.
   *
   * Only the plan tools implement this: a checklist and a goal are the two
   * things a screen wants to draw progress for. The loop forwards whatever it
   * finds as a `plan` event, so a tool with no state costs nothing.
   */
  snapshot?(): PlanSnapshot | null;
  /** Human-readable preview (e.g. a diff) shown to the user before approving. */
  preview?(args: Record<string, unknown>, context: ToolContext): Promise<string | null>;
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
};

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /**
   * The same tools under different names — what a child agent gets.
   *
   * Isolation by absence rather than by policy: a child is handed a registry
   * that does not contain `write`, `edit` or `bash`, so it has nothing to be
   * talked into using. A flag that says "don't write files" is a check that has
   * to be right; a missing tool cannot be misused, and there is nothing to get
   * wrong. Names that are not here are simply absent — the registry never had
   * them — so passing an unknown name is a no-op rather than an error.
   */
  subset(names: readonly string[]): ToolRegistry {
    return new ToolRegistry(names.flatMap((name) => (this.tools.has(name) ? [this.tools.get(name)!] : [])));
  }

  /** Tool declarations in the exact shape the completions API expects. */
  specs(): ToolSpec[] {
    return this.list().map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
}
