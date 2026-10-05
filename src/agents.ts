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

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveHome } from "./paths";

/** What an agent is allowed to change. */
export type AgentPermissions = "read" | "write";

/**
 * One thing an agent knows how to do, from its skill folder.
 *
 * A folder rather than a field because a specialisation is rarely one line: a
 * `cody-git` that handles "GitHub" is one line, and one line does not tell the
 * main agent whether to send it a PR review or a CI failure.
 */
export type AgentSkill = {
  /** From the file's frontmatter, falling back to the filename. */
  name: string;
  /** One line: when to reach for this skill. */
  description: string;
  /** The full file, so the child can read it on demand. */
  file: string;
};

/**
 * Whether an agent may use the `github` tool.
 *
 * Opt-in per agent, and off by default, because the tool carries the *user's*
 * GitHub token: `/user/repos` returns private repositories, and `read` already
 * reaches files but not the process environment. Adding it to every child would
 * hand every child the user's private repository list without anyone deciding
 * that — which is the difference between a capability a profile declares and one
 * the child set happens to have.
 *
 * Separate from `permissions`, which is about *changing* things. This one reads
 * somebody else's server.
 */
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
  /**
   * May use the `github` tool, which reads the API with the user's token.
   *
   * Absent means no. See `AgentProfile` for why this is not folded into
   * `permissions`.
   */
  github?: boolean;
  scope: "global" | "project";
  /** The file it came from, so an edit writes back where it was read from. */
  file: string;
  /** Its own `SKILL.md`, when the folder has one — the child's standing brief. */
  skillFile?: string;
  /** Everything else in the folder, for the roster to offer by name. */
  skills?: AgentSkill[];
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

/**
 * One agent's skill folder, beside the `agents.json` that declares it.
 *
 * `~/.kicode/agents/cody-git/` globally, `<cwd>/.kicode/agents/cody-git/` per
 * project — the same two-scope arrangement as the file, and the same override
 * rule, so an agent's skills travel with the agent and a project can ship its
 * own without touching the user's.
 */
export function agentSkillsDir(
  scope: "global" | "project",
  name: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(path.dirname(agentsFile(scope, cwd, env)), "agents", name);
}

/** A skills file long enough to be a document rather than a note. */
const MAX_SKILL_BYTES = 256 * 1024;
/** Enough of a skill folder to tell a model what an agent is good at. */
const MAX_AGENT_SKILLS = 40;
/** The `name` and `description` lines of a skill file's frontmatter. */
const MAX_SKILL_DESCRIPTION = 200;

type Frontmatter = { name: string; description: string; body: string };

/**
 * A skill file's frontmatter and body.
 *
 * The same shape the brain's skills use, read the same lenient way: a file with
 * no frontmatter is still a skill, called by its filename. Requiring frontmatter
 * would make the folder a chore, and a chore is a folder nobody fills in.
 */
function parseSkill(text: string, fallbackName: string): Frontmatter {
  if (!text.startsWith("---")) return { name: fallbackName, description: "", body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { name: fallbackName, description: "", body: text };
  const block = text.slice(3, end);
  const strip = (value: string | undefined): string => {
    const raw = (value ?? "").trim();
    const quoted = /^"([\s\S]*)"$/.exec(raw) ?? /^'([\s\S]*)'$/.exec(raw);
    return (quoted?.[1] ?? raw).slice(0, MAX_SKILL_DESCRIPTION).trim();
  };
  const name = strip(/^name:\s*(.+)$/m.exec(block)?.[1]) || fallbackName;
  // A description can wrap onto following lines as a continuation; the first line
  // plus its indented continuations is one sentence, and truncating at the first
  // line would cut it in half.
  const description = strip(
    /^description:\s*([\s\S]*?)(?=\n[a-zA-Z_-]+:\s|\n*$)/m.exec(block)?.[1]?.replace(/\n\s+/g, " "),
  );
  return { name, description, body: text.slice(end + 4).replace(/^\r?\n/, "") };
}

/**
 * Everything in one agent's folder: its own brief, and the skills beside it.
 *
 * `SKILL.md` is the one file with a fixed name and it means "this agent". Every
 * other `.md` is a skill it can be asked for. The split is what lets the child
 * read one narrow thing instead of the whole folder, and what lets the parent
 * see a list of capabilities instead of one sentence.
 */
export async function readAgentSkills(
  dir: string,
): Promise<{ skillFile?: string; instructions: string; skills: AgentSkill[]; warnings: string[] }> {
  const warnings: string[] = [];
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".md")).sort();
  } catch {
    return { instructions: "", skills: [], warnings }; // no folder is normal
  }

  let skillFile: string | undefined;
  let instructions = "";
  const skills: AgentSkill[] = [];

  for (const entry of entries) {
    const file = path.join(dir, entry);
    let text: string;
    try {
      text = (await readFile(file, "utf8")).slice(0, MAX_SKILL_BYTES);
    } catch (error) {
      warnings.push(`Could not read ${file}: ${(error as Error).message}`);
      continue;
    }
    const stem = entry.replace(/\.md$/i, "");
    const parsed = parseSkill(text, stem);
    if (entry.toUpperCase() === "SKILL.MD") {
      skillFile = file;
      // The body is the agent's standing brief — what it is for, how it works,
      // what it must never do. Prepended to the child's prompt.
      instructions = parsed.body.trim().slice(0, MAX_INSTRUCTIONS);
      continue;
    }
    if (skills.length >= MAX_AGENT_SKILLS) continue;
    skills.push({ name: parsed.name, description: parsed.description, file });
  }

  return {
    ...(skillFile ? { skillFile } : {}),
    instructions,
    skills,
    warnings,
  };
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
      // Same reasoning, and the same default: the GitHub tool speaks with the
      // user's token, so it is off until a profile asks for it by name.
      ...(entry.github === true ? { github: true } : {}),
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

  // Skills are read for both scopes, and merged per file with the same rule the
  // profiles use: the project's folder wins, so a repo can narrow what an agent
  // will do as well as who it is. The agent's own `SKILL.md` is kept when only
  // one scope has one, rather than being dropped because the other scope did not.
  const decorate = async (
    agents: readonly AgentProfile[],
    scope: "global" | "project",
    warnings: string[],
  ): Promise<void> => {
    for (const agent of agents) {
      const folder = await readAgentSkills(agentSkillsDir(scope, agent.name, cwd, env));
      warnings.push(...folder.warnings);
      agent.skillFile = folder.skillFile;
      agent.skills = folder.skills;
      // The folder's brief is prepended, not substituted: the `agents.json` line
      // is what the modal edits, and a folder that quietly replaced it would make
      // the editor lie about what the child is told.
      agent.instructions = [folder.instructions, agent.instructions].filter(Boolean).join("\n\n").slice(0, MAX_INSTRUCTIONS);
    }
  };
  await decorate(global.agents, "global", global.warnings);
  await decorate(project.agents, "project", project.warnings);

  const byName = new Map<string, AgentProfile>();
  for (const agent of [...global.agents, ...project.agents]) {
    const existing = byName.get(agent.name);
    // "Has no folder of its own" means neither file: a folder holding only skills
    // is still a folder, and treating a missing `SKILL.md` as a missing folder
    // would let the global folder overwrite skills the project did define.
    if (existing && agent.skillFile === undefined && (agent.skills?.length ?? 0) === 0) {
      // A project profile that declares no folder of its own keeps the global
      // agent's skills: overriding the *agent* is not a request to unskill it.
      agent.skillFile = existing.skillFile;
      agent.skills = existing.skills;
    }
    byName.set(agent.name, agent);
  }
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
      // Written only when granted, so a file saved by this version does not gain
      // a `github: false` on every agent — the absence is the default and should
      // stay legible as absence.
      ...(agent.github === true ? { github: true } : {}),
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
export function toolsFor(permissions: AgentPermissions, github = false): readonly string[] {
  const base = permissions === "write" ? ["read", "glob", "grep", "recall", "write", "edit"] : ["read", "glob", "grep", "recall"];
  // Appended last so the grant reads as the addition it is, and so `bash` — which
  // is not in either list and cannot be granted by any profile at any level —
  // stays absent by construction rather than by filtering.
  return github ? [...base, "github"] : base;
}

/**
 * The child's prompt: what this agent is for, then the standing rules.
 *
 * The specialisation comes **first** on purpose. It used to come last, on the
 * reasoning that a later line overrides an earlier one — but the standing rules
 * are invariants and the specialisation is not, so the wrong order is the one
 * that reads as authoritative. `cody-git`'s own brief says what to do with
 * GitHub, and the rules below said it could not touch GitHub; with the rules
 * last, the impossibility read as the policy.
 *
 * `github` says whether this child holds the `github` tool. It has to, because
 * the rules below otherwise tell the child it cannot reach GitHub while it is
 * holding a tool that does exactly that — and a prompt that contradicts its own
 * toolset is worse than either version alone.
 */
export function childPrompt(instructions: string, github = false): string {
  const extra = instructions.trim();
  const rules = github ? SUBAGENT_RULES_GITHUB : SUBAGENT_RULES;
  return extra ? `${extra}\n\n${rules}` : rules;
}

/** The parts that do not vary, so the two rule sets cannot drift apart. */
const SUBAGENT_SHARED = [
  "- Inspect the real files before you conclude anything. Never guess at file contents.",
  "- Answer with a report, not a conversation: what you found, where (file paths and line numbers), and anything you could not determine.",
  "- Answer in prose, always. A report that is a file listing or a diff with no explanation does not",
  "  tell the reader what you concluded, and they are the one who has to act on it.",
  "- If the task is ambiguous or you hit something only the user can decide, say so in a line under open questions rather than guessing.",
  "- Be brief. Your report is read by another agent with a full task of its own; detail you do not need is cost paid twice.",
];

/** For a child with no `github` tool: it cannot reach GitHub at all. */
const SUBAGENT_RULES = [
  "You are a subagent working inside KiCode, on one delegated task.",
  "",
  "Rules:",
  "- You start with no memory of the conversation that sent you. Everything you need is in the task.",
  ...SUBAGENT_SHARED.slice(0, 1),
  "- You cannot run commands. There is no `bash`, no `gh`, no `git` — nothing that executes.",
  "  If the task as given cannot be done by reading files, say so in your first line and report",
  "  what you could determine from the files, plus exactly which command would answer the rest.",
  "  Do not quietly return nothing: an empty report leaves the agent that sent you with no result",
  "  and no idea why.",
  ...SUBAGENT_SHARED.slice(1),
].join("\n");

/** For a child that was granted `github`: it can read the API, and still cannot run anything. */
const SUBAGENT_RULES_GITHUB = [
  "You are a subagent working inside KiCode, on one delegated task.",
  "",
  "Rules:",
  "- You start with no memory of the conversation that sent you. Everything you need is in the task.",
  ...SUBAGENT_SHARED.slice(0, 1),
  "- You have a `github` tool that reads the GitHub API through the authenticated `gh` CLI, using the",
  "  user's own credentials. Use it for anything about GitHub that the files on disk cannot answer:",
  "  the signed-in user, repositories, org memberships, issues, pull requests, workflow runs. Prefer it",
  "  over reading files — it is current, where a file is whatever the last session left behind.",
  "  Give it a path beginning with `/`, such as `/user` or `/user/repos`, and add a `jq` filter to keep",
  "  the payload small. It reads only: there is no way to write, comment or merge through it.",
  "- Apart from that tool you still cannot run commands. There is no `bash` and no `git`, so `git status`,",
  "  a build and a test are all things you must ask for. If the task needs one, say so in your first",
  "  line, report what you could determine, and name exactly which command would answer the rest.",
  "  Do not quietly return nothing: an empty report leaves the agent that sent you with no result and",
  "  no idea why.",
  ...SUBAGENT_SHARED.slice(1),
].join("\n");