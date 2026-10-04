import { askTool } from "./ask";
import { bashTool } from "./bash";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { createPlanTools } from "./plan";
import { readTool } from "./read";
import { recallTool } from "./recall";
import { rememberTool } from "./remember";
import { ToolRegistry, type Tool } from "./types";
import { writeTool } from "./write";

export { ToolRegistry } from "./types";
export type { Tool, ToolContext, ToolResult } from "./types";

/**
 * Reads and searches run unprompted. `write`, `edit`, and `bash` are marked
 * `requiresApproval`, so the loop gates them behind the approval channel —
 * in a terminal that is an explicit yes, and in one-shot mode `--yes` or nothing.
 *
 * `plan` and `todo` are the plan-mode deliverable: presenting and tracking a
 * plan changes nothing, so they are always registered and never gated. Each
 * call gets its own session state, so one session's list can never leak into
 * another's.
 *
 * `remember` is also always registered and never approval-gated, by explicit
 * choice: a prompt per save would train everyone to stop saving. Its safety
 * is positional instead — brain directory only, slug names, capped bodies, no
 * secrets — and plan mode refuses it like every other writing tool.
 *
 * `recall` is its other half: reading the brain back is not a change, so it is
 * ungated and works in plan mode too. Without it the brain would be write-only
 * — saved once and never seen again.
 *
 * `ask` is only included when there is somebody to answer it. Offering a
 * question channel that cannot answer would cost the model a wasted turn and
 * teach it to guess instead.
 */
export function createDefaultTools(extra: Tool[] = [], options: { ask?: boolean } = {}): ToolRegistry {
  const tools: Tool[] = [
    readTool,
    globTool,
    grepTool,
    writeTool,
    editTool,
    bashTool,
    rememberTool,
    recallTool,
    ...createPlanTools(),
  ];
  if (options.ask) tools.push(askTool);
  return new ToolRegistry([...tools, ...extra]);
}

/**
 * What a child agent is given.
 *
 * The list is the isolation. `read`, `glob`, `grep` and `recall` cannot change
 * anything; `bash` is left out on purpose even though a gated read-only command
 * would be allowed — a child with no approval channel is refused every gated
 * tool anyway, so including it would only teach the model to try.
 *
 * `remember` and the plan tools are left out too: a child's finding belongs to
 * the session that delegated it, and two agents writing the same brain file is
 * a race rather than a memory.
 */
export const SUBAGENT_TOOLS: readonly string[] = ["read", "glob", "grep", "recall"];
