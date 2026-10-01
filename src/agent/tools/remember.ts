import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveBrainDir } from "../../mentions";
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
 * (never the checkout, never home), names are slugs so no path can escape it,
 * bodies are capped, and anything shaped like a secret is refused. In plan
 * mode the loop refuses the call outright, like every other writing tool.
 */

const MAX_SKILL_CHARS = 12_000;
const MAX_MEMORY_CHARS = 4_000;
const MAX_DESCRIPTION_CHARS = 200;

const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const MEMORY_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Shapes the tool refuses to persist: a secret must never be written to disk by anyone. */
const SECRET_PATTERNS = [/-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/, /\bsk-[A-Za-z0-9]{20,}\b/];

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
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text) || pattern.test(textOf(args.description))) return secretError();
    }

    const brain = await resolveBrainDir(process.env, context.cwd);
    if (!brain) {
      return {
        content:
          "Error: no brain found above this directory (looked for ki-agent-brain upwards, and KI_BRAIN_PATH). Tell the user to set KI_BRAIN_PATH to their brain directory, then retry.",
        isError: true,
      };
    }

    if (kind === "skill") return saveSkill(brain, name, textOf(args.description).trim(), text);
    return saveMemory(brain, name, text);
  },
};

async function saveSkill(
  brain: string,
  name: string,
  description: string,
  body: string,
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
  try {
    await readFile(file, "utf8");
    return {
      content: `Error: skill "${name}" already exists at ${file} — pick another name, or save this as a memory instead. I never overwrite a skill.`,
      isError: true,
    };
  } catch {
    // Missing is the expected case: a new skill to create.
  }

  const cappedBody =
    body.length > MAX_SKILL_CHARS ? `${body.slice(0, MAX_SKILL_CHARS).trimEnd()}\n\n… (truncated)` : body.trimEnd();
  const front = `---\nname: ${name}\ndescription: "${description.slice(0, MAX_DESCRIPTION_CHARS).replace(/"/g, "'")}"\n---\n\n`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${front}${cappedBody}\n`, "utf8");
  return {
    content: `Saved skill "${name}" to ${file} — /skills lists it and @skill:${name} expands it. Tell the user you saved it, in one sentence.`,
  };
}

async function saveMemory(
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
  const stamped = `\n## ${new Date().toISOString().slice(0, 10)}\n- ${capped.split("\n").join("\n  ")}\n`;

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
