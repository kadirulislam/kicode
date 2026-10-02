import type { AskFn } from "../ask";
import type { ToolSpec } from "../../types";

export type ToolContext = {
  cwd: string;
  /** Absent when nobody can answer, in which case the ask tool is not offered. */
  ask?: AskFn;
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
