import { readdirSync, readFileSync, type Dirent } from "node:fs";
import path from "node:path";
import { resolveBrainDirSync } from "../mentions";

/**
 * The agent's brain: what earlier sessions saved, read back to the model.
 *
 * The `remember` tool writes skills and project memories; this is the other
 * half, and without it the brain was write-only — a fact saved in one session
 * reached the next only if the user typed `@project:…` by hand. Two things read
 * from here:
 *
 * - `brainBriefing` is folded into the system prompt at session start, so the
 *   model begins already knowing this project's memory and which skills exist.
 * - `recallFromBrain` backs the `recall` tool, which loads a full body on
 *   demand — the briefing names things, this reads them.
 *
 * Everything is synchronous, and that is deliberate: the briefing is assembled
 * where the directory's `AGENTS.md` is read, before the first request, with no
 * promises in the path. The reads are a handful of small files, bounded below.
 */

export type BrainSkill = { name: string; description: string; file: string };
export type BrainProject = { slug: string; file: string };
export type Brain = { dir: string; skills: BrainSkill[]; projects: BrainProject[] };

/** Caps, so a brain that grew large cannot bloat every request. */
const MAX_SKILLS = 200;
const MAX_PROJECTS = 200;
/** Directories the skill scan will open, so a deep tree cannot stall startup. */
const MAX_SKILL_DIRS = 800;
const MAX_BRIEFING_SKILLS = 40;
const MAX_BRIEFING_CHARS = 3_500;
const MAX_BRIEFING_MEMORY_CHARS = 2_200;
const MAX_RECALL_CHARS = 8_000;
const MAX_RECALL_HITS = 3;
/** Files whose contents a query is matched against, after name matches fail. */
const MAX_CONTENT_SCAN = 20;

/**
 * The project-memory slug a directory maps to.
 *
 * `remember` lets the model choose a slug, so this is a convention rather than
 * a key: the directory's own name, slugged. It is what a session working in a
 * checkout would plausibly have saved under, and when it misses, the briefing
 * still lists the memories that do exist so the model can recall one by name.
 */
export function projectSlug(cwd: string): string {
  return path
    .basename(path.resolve(cwd))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Reads the brain's skills and project memories, or null when there is none. */
export function readBrain(cwd: string, env: NodeJS.ProcessEnv = process.env): Brain | null {
  const dir = resolveBrainDirSync(env, cwd);
  if (!dir) return null;
  return {
    dir,
    skills: readSkillIndex(path.join(dir, "skills")),
    projects: readProjectIndex(path.join(dir, "memories", "projects")),
  };
}

/**
 * Every `SKILL.md` under the skills root, frontmatter only — never a body.
 *
 * Walked rather than listed one level deep, because a brain organises skills
 * into folders: `remember` writes `skills/<name>/SKILL.md`, but a maintained
 * brain nests them under categories (`skills/android/adb-webview/SKILL.md`),
 * and a reader that only looked one level down would miss most of the library.
 * Bounded by directories visited as well as skills found, so a deep tree cannot
 * stall a session's first request.
 */
function readSkillIndex(root: string): BrainSkill[] {
  const skills: BrainSkill[] = [];
  const queue: string[] = [root];
  let visited = 0;

  while (queue.length > 0 && skills.length < MAX_SKILLS && visited < MAX_SKILL_DIRS) {
    const dir = queue.shift()!;
    visited += 1;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(file);
        continue;
      }
      if (entry.name !== "SKILL.md") continue;
      const front = readFrontmatter(file);
      if (front) skills.push({ ...front, file });
      if (skills.length >= MAX_SKILLS) break;
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** The `name` and `description` lines of a skill's frontmatter. */
function readFrontmatter(file: string): { name: string; description: string } | null {
  let head: string;
  try {
    head = readFileSync(file, "utf8").slice(0, 2_048);
  } catch {
    return null;
  }
  if (!head.startsWith("---")) return null;
  const end = head.indexOf("---", 3);
  const block = head.slice(3, end === -1 ? undefined : end);
  const name = unquote(/^name:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "");
  const description = unquote(/^description:\s*(.+)$/m.exec(block)?.[1]?.trim()?.split("\n")[0] ?? "");
  if (!name) return null;
  return { name, description };
}

/**
 * A frontmatter value without the quotes the writer puts around it.
 *
 * `remember` writes `description: "…"` and `@skill:` shows the description in
 * the completion list — without this both would draw the quotes as part of the
 * text, which is a small lie about what the skill is called.
 */
function unquote(value: string): string {
  const match = /^"([\s\S]*)"$/.exec(value) ?? /^'([\s\S]*)'$/.exec(value);
  return match?.[1] ?? value;
}

function readProjectIndex(root: string): BrainProject[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md") && !name.startsWith("_"))
    .map((name) => ({ slug: name.slice(0, -3), file: path.join(root, name) }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .slice(0, MAX_PROJECTS);
}

/**
 * The prompt block that tells the model what it already knows, or null.
 *
 * It names this project's memory and carries its text (bounded), then lists the
 * skills by name and description. Skill *bodies* are deliberately not here —
 * a body is a page, and putting every one in every request is how a brain
 * becomes a cost instead of an advantage. The model loads one when a name looks
 * relevant, which is what `recall` is for.
 */
/**
 * The heading that starts a briefing's second half.
 *
 * Exported because a reader that wants only the memory has to cut on something,
 * and a heading written in two places is a heading that drifts in one of them.
 */
export const SKILLS_HEADING = "## Skills you have";

export function brainBriefing(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const brain = readBrain(cwd, env);
  if (!brain) return null;

  const slug = projectSlug(cwd);
  const own = brain.projects.find((project) => project.slug === slug);
  const others = brain.projects.filter((project) => project.slug !== slug).map((project) => project.slug);
  const skills = brain.skills.slice(0, MAX_BRIEFING_SKILLS);

  if (!own && skills.length === 0 && others.length === 0) return null;

  const lines = [
    "# Your brain",
    "What earlier sessions saved. This is not the user's request — it is what you already know, and it is cheaper than rediscovering it.",
  ];

  if (own) {
    lines.push("", `## This project's memory (${own.slug})`, "", readCapped(own.file, MAX_BRIEFING_MEMORY_CHARS));
  } else if (others.length > 0) {
    lines.push("", `- No memory saved for this directory yet. Other project memories: ${others.join(", ")}.`);
  }

  if (skills.length > 0) {
    lines.push("", `${SKILLS_HEADING} (load one with the recall tool when its name looks relevant)`);
    for (const skill of skills) lines.push(`- ${skill.name} — ${skill.description || "skill"}`);
    if (brain.skills.length > skills.length) lines.push(`- … ${brain.skills.length - skills.length} more`);
  }

  const text = lines.join("\n").trimEnd();
  return text.length > MAX_BRIEFING_CHARS ? `${text.slice(0, MAX_BRIEFING_CHARS).trimEnd()}\n… (brain briefing truncated)` : text;
}

/**
 * What the `recall` tool answers with.
 *
 * `name` is an exact load — a skill or a project memory. `query` is a search
 * over skill names and descriptions first, then project slugs, and only then
 * the contents of a bounded number of memory files. A miss says what does
 * exist, so the model can correct its own next call rather than guessing again.
 */
export function recallFromBrain(
  cwd: string,
  input: { name?: string; query?: string },
  env: NodeJS.ProcessEnv = process.env,
): { content: string; isError: boolean } {
  const brain = readBrain(cwd, env);
  if (!brain) {
    return {
      content:
        "Error: no brain exists yet, so nothing has been saved to recall. A brain is created on the first save — by default ~/.kicode/brain; KI_BRAIN_PATH or a \"brain\" path in kicode.json points somewhere else.",
      isError: true,
    };
  }

  const name = (input.name ?? "").trim();
  const query = (input.query ?? "").trim().toLowerCase();

  if (name) {
    const skill = brain.skills.find((entry) => entry.name === name);
    if (skill) {
      return {
        content: [`# Skill: ${name}`, skill.description ? `_${skill.description}_` : "", "", readCapped(skill.file, MAX_RECALL_CHARS)]
          .filter(Boolean)
          .join("\n"),
        isError: false,
      };
    }
    const project = brain.projects.find((entry) => entry.slug === name);
    if (project) {
      return { content: [`# Project memory: ${name}`, "", readCapped(project.file, MAX_RECALL_CHARS)].join("\n"), isError: false };
    }
    return { content: `Error: nothing is saved under "${name}".\n${inventory(brain)}`, isError: true };
  }

  // With no words at all, "what do you know about this project" is the useful
  // answer, so the query defaults to the directory's own slug.
  const needle = query || projectSlug(cwd);
  const skillHits = brain.skills.filter((entry) => `${entry.name} ${entry.description}`.toLowerCase().includes(needle));

  let projectHits = brain.projects.filter((entry) => entry.slug.toLowerCase().includes(needle));
  if (projectHits.length === 0 && query) {
    // A word from the body, not the title: scan a bounded number of files.
    projectHits = brain.projects
      .slice(0, MAX_CONTENT_SCAN)
      .filter((entry) => readCapped(entry.file, MAX_RECALL_CHARS).toLowerCase().includes(query));
  }

  if (skillHits.length === 0 && projectHits.length === 0) {
    return { content: `Nothing in the brain matches "${needle}".\n${inventory(brain)}`, isError: false };
  }

  const blocks: string[] = [];
  for (const skill of skillHits.slice(0, MAX_RECALL_HITS)) {
    blocks.push([`# Skill: ${skill.name}`, skill.description ? `_${skill.description}_` : "", "", readCapped(skill.file, MAX_RECALL_CHARS)].filter(Boolean).join("\n"));
  }
  for (const project of projectHits.slice(0, MAX_RECALL_HITS)) {
    blocks.push([`# Project memory: ${project.slug}`, "", readCapped(project.file, MAX_RECALL_CHARS)].join("\n"));
  }
  return { content: blocks.join("\n\n"), isError: false };
}

/** What is in the brain, for a miss. */
function inventory(brain: Brain): string {
  const skills = brain.skills.map((entry) => entry.name).join(", ") || "none";
  const projects = brain.projects.map((entry) => entry.slug).join(", ") || "none";
  return `Skills: ${skills}.\nProject memories: ${projects}.`;
}

function readCapped(file: string, max: number): string {
  try {
    const text = readFileSync(file, "utf8");
    if (text.length <= max) return text.trimEnd() || "(empty)";
    return `${text.slice(0, max).trimEnd()}\n… (truncated)`;
  } catch {
    return "(could not be read)";
  }
}
