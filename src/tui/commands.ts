/**
 * The slash commands, in the order the palette shows them.
 *
 * This is the single list: the palette, `/help`, and the dispatcher all read
 * it, so a command cannot exist in one and be missing from another.
 *
 * The catalogue follows OpenCode's, including its aliases, because a list you
 * have learned somewhere else should not have to be re-learned. Names that
 * cannot work here are kept and marked `unavailable` with the reason: they are
 * drawn dimmed and cannot be chosen, and typing one explains itself rather than
 * failing silently. A name that is missing entirely is a worse answer than a
 * name that tells you why.
 */

export type Command = {
  /** Without the leading slash. */
  name: string;
  description: string;
  /** Shown in the palette for anything needing an argument. */
  usage?: string;
  /** Why this one is not available, when it is one of OpenCode's we do not have. */
  unavailable?: string;
  /** The command this one really runs. */
  alias?: string;
};

export const COMMANDS: readonly Command[] = [
  { name: "agents", description: "Define subagents, or watch the running ones", usage: "[running]" },
  { name: "btw", description: "One-shot answer from the session's context, not added to it", usage: "<question>" },
  { name: "budget", description: "Show or set the session token budget", usage: "[tokens]" },
  { name: "cd", description: "Change working directory", usage: "<directory>" },
  { name: "clear", description: "Clear session" },
  { name: "compact", description: "Compact session" },
  { name: "context", description: "Context window breakdown" },
  {
    name: "connect",
    description: "Connect an integration",
    usage: "[service]",
  },
  { name: "continue", description: "Switch session" },
  { name: "copy", description: "Copy session transcript" },
  { name: "debug", description: "View debug info" },
  { name: "diff", description: "Open diff viewer" },
  { name: "editor", description: "Open editor", usage: "[file]" },
  { name: "effort", description: "Switch model variant", alias: "variants" },
  { name: "exit", description: "Exit the app" },
  { name: "export", description: "Export session transcript" },
  { name: "fork", description: "Fork session" },
  { name: "goal", description: "Autonomous goal execution", usage: "<objective>" },
  { name: "help", description: "Help" },
  { name: "init", description: "guided AGENTS.md setup" },
  { name: "insert", description: "Push message in between the conversation", usage: "<message>" },
  { name: "learn", description: "Run the learning pass now, and report what it kept" },
  { name: "mcps", description: "MCP servers" },
  { name: "memory", description: "Show what the brain holds for this project", usage: "[full]" },
  { name: "mode", description: "Switch between build and plan", usage: "[build|plan]" },
  { name: "models", description: "Switch model", usage: "[free]" },
  { name: "new", description: "New session" },
  { name: "open", description: "Open session or project", alias: "sessions" },
  { name: "pair", description: "Pair device", unavailable: "There is no device to pair: KiCode is a single terminal process." },
  { name: "paste", description: "Paste the clipboard: text onto the prompt, an image onto the next turn" },
  { name: "permission", description: "How much this session may do without asking", usage: "[ask|edits|all]" },
  { name: "pause", description: "Pause model execution or active session" },
  {
    name: "plugins",
    description: "Plugins",
    unavailable: "Zero runtime dependencies is a design rule, so there is no plugin loader. Tools live in src/agent/tools/.",
  },
  { name: "project", description: "Open session or project", alias: "sessions" },
  { name: "projects", description: "Open session or project", alias: "sessions" },
  { name: "q", description: "Exit the app", alias: "exit" },
  { name: "quit", description: "Exit the app", alias: "exit" },
  { name: "reload", description: "Reload configuration" },
  { name: "rename", description: "Rename session", usage: "<name>" },
  {
    name: "restart",
    description: "Restart service",
    unavailable: "There is no service: the agent loop runs in this process.",
  },
  { name: "resume", description: "Switch session", alias: "continue" },
  {
    name: "review",
    description: "review changes [commit|branch|pr], defaults to uncommitted",
    usage: "[scope]",
  },
  {
    name: "routes",
    description: "Which endpoints answered, and which ran out",
  },
  { name: "sessions", description: "Switch session" },
  { name: "settings", description: "Open settings", usage: "[key] [value]" },
  {
    name: "share",
    description: "Share session",
    unavailable: "Sessions are local files; there is no server to share them through.",
  },
  {
    name: "skills",
    description: "List skills, or show one",
    usage: "[name]",
  },
  { name: "stats", description: "Usage statistics" },
  { name: "status", description: "View status" },
  { name: "themes", description: "Switch theme" },
  { name: "thinking", description: "Switch model variant", alias: "variants" },
  { name: "timeline", description: "Jump to message", usage: "[number]" },
  { name: "undo", description: "Undo previous message" },
  { name: "update", description: "How to update KiCode" },
  { name: "usage", description: "Token usage across sessions" },
  { name: "variants", description: "Switch model variant" },
  {
    name: "web",
    description: "Pair device",
    unavailable: "There is no web client to pair with.",
  },
  {
    name: "worktrees",
    description: "Manage workspaces",
    unavailable: "KiCode is not a git client; it works in one directory at a time.",
  },
];

/** Longest name, so the palette can align its descriptions. */
export const COMMAND_WIDTH = COMMANDS.reduce((max, command) => Math.max(max, command.name.length), 0);

/** The command a name really runs, following one alias hop. */
export function resolveCommand(name: string): Command | undefined {
  const command = COMMANDS.find((entry) => entry.name === name);
  if (!command?.alias) return command;
  return COMMANDS.find((entry) => entry.name === command.alias);
}

/** True when the command does something here, rather than only explaining itself. */
export function isAvailable(command: Command): boolean {
  return command.unavailable === undefined;
}

/**
 * Ranked matches for what has been typed after the slash.
 *
 * Only commands that actually run here are listed: aliases (`/q`, `/open`, …)
 * still work when typed in full, and names KiCode does not have (`/agents`,
 * `/plugins`, …) still explain themselves — but neither belongs in the list,
 * which is for choosing what to run, not for reading about what cannot.
 */
export function filterCommands(query: string): Command[] {
  const runnable = COMMANDS.filter((command) => isAvailable(command) && !command.alias);
  const needle = query.trim().toLowerCase();
  if (!needle) return [...runnable];

  const prefix = runnable.filter((command) => command.name.startsWith(needle));
  const inner = runnable.filter((command) => !command.name.startsWith(needle) && command.name.includes(needle));
  return [...prefix, ...inner];
}

/**
 * The nearest selectable row, so the keys never land on a name that cannot run.
 * Returns the original index when nothing is selectable at all.
 */
export function stepSelectable(items: readonly Command[], from: number, delta: number): number {
  if (items.length === 0) return 0;

  const start = Math.min(Math.max(from, 0), items.length - 1);
  for (let step = 1; step <= items.length; step++) {
    const index = (((start + delta * step) % items.length) + items.length) % items.length;
    if (isAvailable(items[index]!)) return index;
  }
  return start;
}

/** The text a command needs, given what the user has typed. */
export function commandQuery(line: string): string | null {
  if (!line.startsWith("/")) return null;
  // Only the first word: once there is a space the argument has started, and
  // the palette should stop filtering on it.
  if (line.includes(" ")) return null;
  return line.slice(1);
}
