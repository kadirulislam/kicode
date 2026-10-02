import { mkdir, readdir, readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConfigBrainSync } from "../config-file";
import { resolveHome } from "../paths";
import { walkFiles } from "../agent/tools/walk";

/**
 * `@` mentions: files, skills and project memories, completed inline and
 * expanded into context on submit.
 *
 * Typing `@` plus a query in the prompt opens the completion list; accepting
 * one writes `@label` back into the prompt. On submit every `@label` is
 * replaced by the thing it names — a file's contents, a directory listing, a
 * skill body, a project memory — appended as context blocks after the words.
 * A name that resolves to nothing is left as typed, never an error: the model
 * reads it as an ordinary word.
 */

export type MentionKind = "file" | "dir" | "skill" | "project";

export type MentionItem = {
  kind: MentionKind;
  /** What is shown and, after `@`, what goes back into the prompt. */
  label: string;
  /** One-line note beside the label, when there is one. */
  description?: string;
};

/** Everything completion and expansion read from, built once per directory. */
export type MentionIndex = {
  cwd: string;
  /** Brain root, or null when none was found (files only). */
  brain: string | null;
  files: string[];
  dirs: string[];
  skills: { name: string; description: string; file: string }[];
  projects: { slug: string; file: string }[];
};

const MAX_FILES = 1000;
const MAX_SKILL_FILES = 400;
const MAX_PROJECTS = 200;
const MAX_COMPLETIONS = 8;
const MAX_FILE_CHARS = 8000;
const MAX_DOC_CHARS = 12000;
const MAX_DIR_ENTRIES = 100;

/**
 * The `@query` under the cursor, if the cursor sits in one.
 *
 * The `@` must start the line or follow whitespace, so an email address never
 * opens the list. Only the query characters may sit between it and the cursor.
 */
export function activeToken(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, Math.max(cursor, 0));
  const match = /@([A-Za-z0-9_./:+-]*)$/.exec(before);
  if (!match) return null;
  const start = before.length - match[0].length;
  if (start > 0 && !/\s/.test(text[start - 1] ?? "")) return null;
  return { start, query: match[1] ?? "" };
}

/** The directory name a brain has always been found by, walking upwards. */
export const BRAIN_DIR_NAME = "ki-agent-brain";
/** Where a brain is created when nothing else points at one: `~/.kicode/brain`. */
export const DEFAULT_BRAIN_DIRNAME = "brain";

/**
 * Where the brain lives, in the order the four ways to have one are considered:
 *
 * 1. `KI_BRAIN_PATH` — the explicit override, for a session that wants a
 *    particular brain;
 * 2. a `brain` path in `kicode.json` — global first, the project file after it;
 * 3. `ki-agent-brain` at or above the working directory — the original layout,
 *    kept so an existing brain is never abandoned;
 * 4. `~/.kicode/brain` — where a fresh user's first save creates one.
 *
 * Synchronous because its other caller is not: the agent's system prompt is
 * assembled the same way the directory's `AGENTS.md` is read — before the
 * first request, with no promises in the path — so this has to be callable
 * without awaiting. The async form is kept for the places that already await
 * it, and both answer identically.
 */
export function resolveBrainDirSync(env: NodeJS.ProcessEnv, cwd: string): string | null {
  const configured = configuredBrainPath(env, cwd);
  if (configured && isDirSync(configured)) return configured;

  const walked = walkForBrainSync(cwd);
  if (walked) return walked;

  const fallback = defaultBrainDir(env);
  if (isDirSync(fallback)) return fallback;

  return null;
}

/**
 * The brain to write into, creating one when there is none.
 *
 * A read can honestly report that no brain exists; a save cannot, or a fresh
 * user's first `remember` call would fail and nothing would ever accumulate.
 * So a miss here becomes the configured path, or `~/.kicode/brain`, made on
 * the spot. The `ki-agent-brain` walk is deliberately not a creation target:
 * it is a way to keep using an existing brain, not a place to scatter new ones.
 */
export async function ensureBrainDir(env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const existing = resolveBrainDirSync(env, cwd);
  if (existing) return existing;

  const target = configuredBrainPath(env, cwd) ?? defaultBrainDir(env);
  await mkdir(target, { recursive: true });
  return target;
}

/** The one brain per user, inside KiCode's own home. */
export function defaultBrainDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveHome(env), DEFAULT_BRAIN_DIRNAME);
}

/** A brain named outright — `KI_BRAIN_PATH` first, then a `brain` config key. */
function configuredBrainPath(env: NodeJS.ProcessEnv, cwd: string): string | null {
  const explicit = env.KI_BRAIN_PATH?.trim();
  if (explicit) return expandBrainPath(explicit, cwd);
  const fromConfig = readConfigBrainSync(cwd, env);
  return fromConfig ? expandBrainPath(fromConfig, cwd) : null;
}

/** `~` means home; a relative path is resolved against the working directory. */
function expandBrainPath(value: string, cwd: string): string {
  const trimmed = value.trim();
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(1));
  }
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
}

/** The nearest `ki-agent-brain` at or above a directory, or null. */
function walkForBrainSync(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, BRAIN_DIR_NAME);
    if (isDirSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Where the brain lives, for a caller that is already async. */
export async function resolveBrainDir(env: NodeJS.ProcessEnv, cwd: string): Promise<string | null> {
  return resolveBrainDirSync(env, cwd);
}

function isDirSync(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Builds the completion index for a directory.
 *
 * Bounded everywhere: the file walk is capped, skill bodies are never read
 * here (frontmatter only — a body is read only when its mention is expanded),
 * and project memories are names only. The whole brain is never loaded.
 */
export async function buildMentionIndex(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<MentionIndex> {
  const brain = await resolveBrainDir(env, cwd);
  const walked = await walkFiles({ root: cwd, maxEntries: MAX_FILES }).catch(() => ({ files: [], truncated: true }));
  const files = walked.files.map((file) => path.relative(cwd, file).split(path.sep).join("/")).sort();
  const dirSet = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth++) dirSet.add(parts.slice(0, depth).join("/"));
  }

  let skills: MentionIndex["skills"] = [];
  let projects: MentionIndex["projects"] = [];
  if (brain) {
    skills = await indexSkills(path.join(brain, "skills"));
    projects = await indexProjects(path.join(brain, "memories", "projects"));
  }
  return { cwd, brain, files, dirs: [...dirSet].sort(), skills, projects };
}

async function indexSkills(root: string): Promise<MentionIndex["skills"]> {
  const walked = await walkFiles({ root, maxEntries: MAX_SKILL_FILES }).catch(() => ({ files: [], truncated: true }));
  const out: MentionIndex["skills"] = [];
  for (const file of walked.files) {
    if (path.basename(file) !== "SKILL.md") continue;
    const front = await readFrontmatter(file);
    if (!front) continue;
    out.push({ ...front, file });
    if (out.length >= MAX_SKILL_FILES) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The `name` and `description` frontmatter lines, without reading the body. */
async function readFrontmatter(file: string): Promise<{ name: string; description: string } | null> {
  let head: string;
  try {
    const handle = await readFile(file, "utf8").then((text) => text.slice(0, 2048));
    head = handle;
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

/** A frontmatter value without the quotes the writer puts around it. */
function unquote(value: string): string {
  const match = /^"([\s\S]*)"$/.exec(value) ?? /^'([\s\S]*)'$/.exec(value);
  return match?.[1] ?? value;
}

async function indexProjects(root: string): Promise<MentionIndex["projects"]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md") && !name.startsWith("_"))
    .map((name) => ({ slug: name.slice(0, -3), file: path.join(root, name) }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .slice(0, MAX_PROJECTS);
}

/** Ranked completions for a query: prefix matches first, then substring. */
export function completeMention(index: MentionIndex, query: string): MentionItem[] {
  const needle = query.toLowerCase();
  const candidates: MentionItem[] = [
    ...index.files.map((file): MentionItem => ({ kind: "file", label: file })),
    ...index.dirs.map((dir): MentionItem => ({ kind: "dir", label: `${dir}/`, description: "directory" })),
    ...index.skills.map((skill): MentionItem => ({
      kind: "skill",
      label: `skill:${skill.name}`,
      description: skill.description || "skill",
    })),
    ...index.projects.map((project): MentionItem => ({
      kind: "project",
      label: `project:${project.slug}`,
      description: "project memory",
    })),
  ];
  const scored = candidates
    .map((item) => ({ item, score: scoreMention(item, needle) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label));
  return scored.slice(0, MAX_COMPLETIONS).map((entry) => entry.item);
}

function scoreMention(item: MentionItem, needle: string): number {
  if (!needle) return item.kind === "file" || item.kind === "dir" ? 0 : 1;
  const haystack = `${item.label} ${item.description ?? ""}`.toLowerCase();
  if (item.label.toLowerCase().startsWith(needle)) return 0;
  if (haystack.includes(needle)) return 1;
  return -1;
}

/**
 * Expands every `@label` in a prompt into context blocks after the words.
 *
 * Resolution order per token: `skill:` and `project:` prefixes first, then an
 * exact file or directory match. Anything else is left as typed.
 */
export async function expandMentions(
  prompt: string,
  index: MentionIndex,
): Promise<{ text: string; applied: string[] }> {
  const tokens = [...prompt.matchAll(/@([A-Za-z0-9_./:+-]+)/g)].map((match) => match[1] ?? "");
  const seen = [...new Set(tokens)];
  const blocks: string[] = [];
  const applied: string[] = [];

  for (const token of seen) {
    const block = await resolveToken(token, index);
    if (!block) continue;
    applied.push(token);
    blocks.push(block);
  }

  if (blocks.length === 0) return { text: prompt, applied };
  return { text: `${prompt}\n\n${blocks.join("\n\n")}`, applied };
}

async function resolveToken(token: string, index: MentionIndex): Promise<string | null> {
  if (token.startsWith("skill:")) {
    const skill = index.skills.find((entry) => entry.name === token.slice("skill:".length));
    if (!skill) return null;
    const body = await readCapped(skill.file, MAX_DOC_CHARS);
    return [`Context from @${token} (skill):`, body].join("\n");
  }
  if (token.startsWith("project:")) {
    const project = index.projects.find((entry) => entry.slug === token.slice("project:".length));
    if (!project) return null;
    const body = await readCapped(project.file, MAX_DOC_CHARS);
    return [`Context from @${token} (project memory):`, body].join("\n");
  }
  const rel = token.replace(/\/+$/, "");
  if (index.dirs.includes(rel)) return resolveDir(rel, index);
  if (index.files.includes(token)) {
    const body = await readCapped(path.join(index.cwd, token), MAX_FILE_CHARS);
    return [`Context from @${token}:`, body].join("\n");
  }
  return null;
}

async function resolveDir(rel: string, index: MentionIndex): Promise<string> {
  const prefix = `${rel}/`;
  const entries = index.files.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
  const shown = entries.slice(0, MAX_DIR_ENTRIES);
  const tail = entries.length > shown.length ? `\n… ${entries.length - shown.length} more` : "";
  return [`Context from @${rel}/ (directory):`, ...shown.map((entry) => `- ${entry}`)].join("\n") + tail;
}

async function readCapped(file: string, max: number): Promise<string> {
  let buffer: Buffer;
  try {
    buffer = await readFile(file);
  } catch {
    return "(could not be read)";
  }
  if (buffer.includes(0)) return "(binary file, not included)";
  const text = buffer.toString("utf8");
  if (text.length <= max) return text.trimEnd() || "(empty file)";
  return `${text.slice(0, max).trimEnd()}\n… (truncated, ${text.length - max} more characters)`;
}
