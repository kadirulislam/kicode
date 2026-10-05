/**
 * Named subagents: `cody-git`, `cody-frontend`, and whatever else you invent.
 *
 * A bare `delegation.model` pin gives every child the same model and the same
 * instructions. That is the right default and the wrong ceiling — some work
 * wants a different model, and *all* work wants to know what the child is
 * *for*. A profile is that: a name the main agent can choose, a line describing
 * it, the specialisation to put in front of the child's prompt, and an optional
 * model of its own.
 *
 * Two files, one format — `<home>/.kicode/agents.json` and
 * `<cwd>/.kicode/agents.json` — with the project's file overriding the user's by
 * name. Deliberately *not* an `agents` block inside `kicode.json`: that file is
 * committed, so a modal that edits it would be rewriting a tracked file behind
 * the user's back, and the two would then disagree about who owns an agent.
 *
 * `bash` is never grantable. Read and edit are the file-shaped permissions; a
 * shell is arbitrary code, and a child has no approval channel to ask about it —
 * so a grantable `bash` would mean "a model you delegated to can run anything,
 * unsupervised, four at a time". Edit access is opt-in per agent and defaults to
 * off.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveHome } from "./paths";

/** What an agent is allowed to change. */
export type AgentPermissions = "read" | "write";

export type AgentProfile = {
  /** How the main agent names it in `delegate({ agent: … })`. */
  name: string;
  /** One line, shown to the model so it can tell the agents apart. */
  description: string;
  /** Prepended to the child's prompt: what this agent is for. */
  instructions: string;
  /** Empty means the parent's own model. */
  model: string;
  permissions: AgentPermissions;
  scope: "global" | "project";
  /** The file it came from, so an edit writes back where it was read from. */
  file: string;
};

/**
 * Names are what the model types into a tool call, so they are held to a shape:
 * letters, digits, `-` and `_`, starting with a letter. Anything looser invites
 * a name that is unquotable in the JSON of a tool call.
 */
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

/** A description long enough to be useless in a tool description. */
const MAX_DESCRIPTION = 160;
/** A specialisation is a paragraph or two, not an essay. */
const MAX_INSTRUCTIONS = 4_000;

export function isValidAgentName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/** The two names KiCode should never let an agent take. */
const RESERVED = new Set(["delegate", "new", "list", "rm", "delete", "default"]);

export function agentNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "a name is required";
  if (!NAME_PATTERN.test(trimmed)) {
    return "letters, digits, - and _ only, starting with a letter";
  }
  if (RESERVED.has(trimmed.toLowerCase())) return `"${trimmed}" is a reserved word`;
  return null;
}

/** Where a scope's agents live. */
export function agentsFile(scope: "global" | "project", cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return scope === "global"
    ? path.join(resolveHome(env), "agents.json")
    : path.join(cwd, ".kicode", "agents.json");
}

/** What a bad profile says about itself, or null when it is usable. */
function problem(value: unknown, where: string): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return `${where} is not an object`;
  const entry = value as Record<string, unknown>;
  if (typeof entry.name !== "string" || !isValidAgentName(entry.name.trim())) {
    return `${where} has no usable name`;
  }
  if (entry.permissions !== undefined && entry.permissions !== "read" && entry.permissions !== "write") {
    return `${where}.permissions must be "read" or "write"`;
  }
  return null;
}

/**
 * The profiles in one file, plus a warning per thing that was wrong.
 *
 * Reported rather than thrown: a typo in one agent must not cost the user the
 * other nine, and must not stop the session from opening.
 */
export async function readAgentsFile(
  file: string,
  scope: "global" | "project",
): Promise<{ agents: AgentProfile[]; warnings: string[] }> {
  const warnings: string[] = [];
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { agents: [], warnings }; // absent is normal
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    return { agents: [], warnings: [`Could not read ${file}: ${(error as Error).message}`] };
  }

  // The whole file must be an object. A bare array or a number is a file written
  // by something else, or by a mistake — reported rather than read as "no
  // agents", because a silent empty list looks exactly like a working setup.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { agents: [], warnings: [`Ignoring "${file}": expected an object of agents.`] };
  }

  // Either `{ "agents": { name: {...} } }` — keyed, which is what a hand-written
  // file naturally looks like — or `{ "agents": [ {...} ] }`.
  const container = (parsed as { agents?: unknown }).agents;
  const source: unknown[] = Array.isArray(container)
    ? container
    : container !== null && typeof container === "object"
      ? Object.entries(container as Record<string, unknown>).map(([name, body]) => ({
          ...(body as Record<string, unknown>),
          // The key is the name; a `name` inside the body cannot override it, so
          // `{"cody-git": {"name": "other"}}` is still `cody-git`.
          name,
        }))
      : [];

  const agents: AgentProfile[] = [];
  for (const [index, item] of source.entries()) {
    const where = `${file} agent #${index + 1}`;
    const bad = problem(item, where);
    if (bad) {
      warnings.push(`Ignoring ${bad}.`);
      continue;
    }
    const entry = item as Record<string, unknown>;
    const name = String(entry.name).trim();
    const text = (field: unknown, limit: number): string =>
      typeof field === "string" ? field.trim().slice(0, limit) : "";
    agents.push({
      name,
      description: text(entry.description, MAX_DESCRIPTION),
      instructions: text(entry.instructions, MAX_INSTRUCTIONS),
      model: text(entry.model, 120),
      // Read-only unless the file says otherwise: an agent that could write has
      // to have been granted it deliberately.
      permissions: entry.permissions === "write" ? "write" : "read",
      scope,
      file,
    });
  }
  return { agents, warnings };
}

/**
 * Every agent in play, the project's file winning by name.
 *
 * Both files are read so an override is visible: a project that narrows a global
 * agent's permissions should be able to show that it did.
 */
export async function readAgentProfiles(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ agents: AgentProfile[]; warnings: string[] }> {
  const global = await readAgentsFile(agentsFile("global", cwd, env), "global");
  const project = await readAgentsFile(agentsFile("project", cwd, env), "project");
  const byName = new Map<string, AgentProfile>();
  for (const agent of [...global.agents, ...project.agents]) byName.set(agent.name, agent);
  return { agents: [...byName.values()], warnings: [...global.warnings, ...project.warnings] };
}

/**
 * Writes the file atomically, so an interrupted save cannot leave a half-written
 * list where a working one was.
 */
async function writeAgentsFile(file: string, agents: readonly AgentProfile[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  // Keyed by name, because that is what a hand-edited file looks like and it
  // makes the name unique by construction.
  const keyed: Record<string, unknown> = {};
  for (const agent of agents) {
    keyed[agent.name] = {
      description: agent.description,
      instructions: agent.instructions,
      model: agent.model,
      permissions: agent.permissions,
    };
  }
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ agents: keyed }, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

/**
 * Saves a profile into the scope it should live in.
 *
 * A project's agent goes in the project's file and a personal one in the user's,
 * so `cody-git` defined for one repo does not follow you into the next — and so
 * a repo can ship its own without editing a file the user also writes to.
 */
export async function saveAgentProfile(
  agent: Omit<AgentProfile, "scope" | "file">,
  scope: "global" | "project",
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentProfile> {
  const file = agentsFile(scope, cwd, env);
  const { agents } = await readAgentsFile(file, scope);
  const next = [...agents.filter((existing) => existing.name !== agent.name), { ...agent, scope, file }];
  await writeAgentsFile(file, next);
  return { ...agent, scope, file };
}

/** Removes a profile. Returns false when that scope had no such agent. */
export async function removeAgentProfile(
  name: string,
  scope: "global" | "project",
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const file = agentsFile(scope, cwd, env);
  const { agents } = await readAgentsFile(file, scope);
  const next = agents.filter((agent) => agent.name !== name);
  if (next.length === agents.length) return false;
  await writeAgentsFile(file, next);
  return true;
}

/**
 * The tools a profile's permissions add on top of the read-only set.
 *
 * A named list rather than a count, because the whole claim "a child cannot
 * change anything" is this list — and a test reads it.
 */
export function toolsFor(permissions: AgentPermissions): readonly string[] {
  return permissions === "write" ? ["read", "glob", "grep", "recall", "write", "edit"] : ["read", "glob", "grep", "recall"];
}

/**
 * The child's prompt: the standing rules, then what this agent is for.
 *
 * The specialisation comes last on purpose — it is the part that differs, and
 * the part most likely to be overridden by a later line.
 */
export function childPrompt(instructions: string): string {
  const extra = instructions.trim();
  return extra ? `${extra}\n\n${SUBAGENT_RULES}` : SUBAGENT_RULES;
}

const SUBAGENT_RULES = [
  "You are a subagent working inside KiCode, on one delegated task.",
  "",
  "Rules:",
  "- You start with no memory of the conversation that sent you. Everything you need is in the task.",
  "- Inspect the real files before you conclude anything. Never guess at file contents.",
  "- You cannot run commands, and asking for one is a wasted turn — report what should be run instead.",
  "- Answer with a report, not a conversation: what you found, where (file paths and line numbers), and anything you could not determine.",
  "- If the task is ambiguous or you hit something only the user can decide, say so in a line under open questions rather than guessing.",
  "- Be brief. Your report is read by another agent with a full task of its own; detail you do not need is cost paid twice.",
].join("\n");