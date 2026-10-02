import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureBrainDir } from "../../mentions";
import type { Tool } from "./types";

/**
 * Saves what the session learned into the brain, so the next session starts
 * knowing it.
 *
 * Two kinds: a `skill` is a reusable procedure (a SKILL.md under
 * `skills/<name>/`, which `/skills` lists and `@skill:` mentions expand); a
 * `memory` is a dated entry appended to a project's memory file under
 * `memories/projects/`.
 *
 * Deliberately not approval-gated: capturing learnings is the point, and a
 * prompt per save would train the user to stop saving. The guardrails are
 * positional instead — writes land only inside the resolved brain directory
 * (KiCode's own home by default, or wherever the user pointed a brain, and
 * never the checkout), names are slugs so no path can escape it, bodies are
 * capped, and anything shaped like a secret is refused. In plan mode the loop
 * refuses the call outright, like every other writing tool.
 */

const MAX_SKILL_CHARS = 12_000;
const MAX_MEMORY_CHARS = 4_000;
const MAX_DESCRIPTION_CHARS = 200;

const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const MEMORY_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * The local calendar date, as `YYYY-MM-DD`.
 *
 * Read back by a person and sorted by a machine, so the stamp keeps its sortable
 * shape — but it is the *local* day, because one taken from UTC dates a memory
 * to yesterday for anyone west of Greenwich and to tomorrow for anyone far
 * enough east. Only the calendar is local: the format stays ISO because it is
 * data, not something to be read in a system's own style.
 */
function localDay(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Shapes the tool refuses to persist: a secret must never be written to disk by anyone. */
const SECRET_PATTERNS = [/-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/, /\bsk-[A-Za-z0-9]{20,}\b/];

/**
 * Whether any of these values looks like a credential.
 *
 * Exported so the automatic learning pass applies the same refusal. That pass
 * writes with these same functions, and a writer that trusted its caller would
 * be one careless caller away from putting a key on disk.
 */
export function looksLikeSecret(...values: readonly string[]): boolean {
  return values.some((value) => SECRET_PATTERNS.some((pattern) => pattern.test(value)));
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function secretError(): { content: string; isError: boolean } {
  return {
    content:
      "Error: that looks like it contains a secret (a private key or an API key). I never write secrets to disk — save the learning without it.",
    isError: true,
  };
}

export const rememberTool: Tool = {
  name: "remember",
  description: [
    "Save something this session verified so future sessions know it — then tell the user what you saved, in one sentence.",
    "Use it sparingly, only for durable learnings: a procedure that worked and will be needed again (kind \"skill\"), or a project fact, decision, or gotcha with its fix (kind \"memory\"). Do not save guesses, one-off outputs, or anything already in the skill or memory you read.",
    "A skill needs a short slug name, a one-line description, and the procedure as markdown. A memory needs the project slug and the entry text. Never include secrets, keys, or tokens.",
    'Use action \"update\" to correct a skill that already exists; a plain save never overwrites one.',
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["skill", "memory"],
        description: "\"skill\" for a reusable procedure, \"memory\" for a dated project entry.",
      },
      name: {
        type: "string",
        description: "Skill slug (lowercase letters, digits, dashes) or project memory slug.",
      },
      description: {
        type: "string",
        description: "One-line description of the skill. Required when kind is \"skill\".",
      },
      text: {
        type: "string",
        description: "The skill body as markdown, or the memory entry text.",
      },
      action: {
        type: "string",
        enum: ["create", "update"],
        description:
          'Skills only. \"create\" (the default) adds a new skill and refuses to overwrite one; \"update\" replaces the body of a skill that already exists. Ignored for a memory.',
      },
    },
    required: ["kind", "name", "text"],
  },

  async run(args, context) {
    const kind = textOf(args.kind);
    const name = textOf(args.name).trim();
    const text = textOf(args.text);
    if (kind !== "skill" && kind !== "memory") {
      return { content: "Error: \"kind\" must be \"skill\" or \"memory\".", isError: true };
    }
    if (!text.trim()) {
      return { content: "Error: \"text\" is empty — there is nothing to save.", isError: true };
    }
    if (looksLikeSecret(text, textOf(args.description))) return secretError();

    // A brain is created on the first save when there is none: a fresh user has
    // no skills and no brain, and a save that refused to make one would mean
    // nothing ever accumulated. `~/.kicode/brain` by default; `KI_BRAIN_PATH` or
    // a `brain` key in kicode.json says somewhere else.
    let brain: string;
    try {
      brain = await ensureBrainDir(process.env, context.cwd);
    } catch (error) {
      return {
        content: `Error: could not create a brain directory — ${(error as Error).message}. Set KI_BRAIN_PATH, or a "brain" path in kicode.json, to a writable directory and retry.`,
        isError: true,
      };
    }

    const action = textOf(args.action) === "update" ? "update" : "create";
    if (kind === "skill") return saveSkill(brain, name, textOf(args.description).trim(), text, action);
    return saveMemory(brain, name, text);
  },
};

/**
 * Writes a skill into the brain. Exported so the automatic learning pass files
 * what it extracts through exactly the same gate the tool does — slug names,
 * capped bodies, a refusal to overwrite — rather than a second, looser writer.
 */
export async function saveSkill(
  brain: string,
  name: string,
  description: string,
  body: string,
  action: "create" | "update",
): Promise<{ content: string; isError?: boolean }> {
  if (!SKILL_NAME.test(name)) {
    return {
      content: `Error: skill name "${name}" is not a slug — use lowercase letters, digits, and dashes (e.g. "vercel-deploy").`,
      isError: true,
    };
  }
  if (!description) {
    return { content: "Error: a skill needs a one-line \"description\" — it is what /skills lists.", isError: true };
  }
  const file = path.join(brain, "skills", name, "SKILL.md");
  let exists = false;
  try {
    await readFile(file, "utf8");
    exists = true;
  } catch {
    // Missing is the expected case for a new skill.
  }

  // A skill is never overwritten by accident: the default refuses, and only an
  // explicit `update` replaces one — the correction has to be deliberate.
  if (exists && action !== "update") {
    return {
      content: `Error: skill "${name}" already exists at ${file} — pass action: "update" to correct it deliberately, pick another name, or save this as a memory instead.`,
      isError: true,
    };
  }
  if (!exists && action === "update") {
    return {
      content: `Error: there is no skill "${name}" to update. Save it without an action to create it.`,
      isError: true,
    };
  }

  const cappedBody =
    body.length > MAX_SKILL_CHARS ? `${body.slice(0, MAX_SKILL_CHARS).trimEnd()}\n\n… (truncated)` : body.trimEnd();
  const front = `---\nname: ${name}\ndescription: "${description.slice(0, MAX_DESCRIPTION_CHARS).replace(/"/g, "'")}"\n---\n\n`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${front}${cappedBody}\n`, "utf8");
  return {
    content: `${exists ? "Updated" : "Saved"} skill "${name}" at ${file} — /skills lists it and @skill:${name} expands it. Tell the user you ${exists ? "updated" : "saved"} it, in one sentence.`,
  };
}

/** Appends a dated entry to a project's memory. Exported for the learning pass. */
export async function saveMemory(
  brain: string,
  slug: string,
  entry: string,
): Promise<{ content: string; isError?: boolean }> {
  if (!MEMORY_SLUG.test(slug)) {
    return {
      content: `Error: project slug "${slug}" is not valid — use letters, digits, dash or underscore.`,
      isError: true,
    };
  }
  const file = path.join(brain, "memories", "projects", `${slug}.md`);
  const capped = entry.length > MAX_MEMORY_CHARS ? `${entry.slice(0, MAX_MEMORY_CHARS).trimEnd()}\n… (truncated)` : entry.trimEnd();
  const stamped = `\n## ${localDay()}\n- ${capped.split("\n").join("\n  ")}\n`;

  let existing: string | null = null;
  try {
    existing = await readFile(file, "utf8");
  } catch {
    existing = null;
  }
  if (existing === null) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `# ${slug} — Session Notes\n\n> Captured by KiCode while working.\n${stamped}`, "utf8");
  } else {
    await writeFile(file, `${existing.trimEnd()}\n${stamped}`, "utf8");
  }
  return {
    content: `Appended to the ${slug} project memory (${file}). Tell the user what you recorded, in one sentence.`,
  };
}
