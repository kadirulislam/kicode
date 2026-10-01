import { readFile, writeFile } from "node:fs/promises";
import { diffLines } from "./diff";
import { resolveToolPath } from "./fs";
import type { Tool, ToolResult } from "./types";

/**
 * Replaces an exact string in a file.
 *
 * Deliberately strict: an ambiguous match is refused rather than guessed at,
 * because silently editing the wrong occurrence is the most expensive mistake
 * a coding agent can make.
 */
export const editTool: Tool = {
  name: "edit",
  description:
    "Replace an exact string in an existing file. Fails if the text is absent or ambiguous. The change is shown as a diff and must be approved.",
  requiresApproval: true,

  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory." },
      old_string: {
        type: "string",
        description: "Exact text to replace. Include surrounding lines when the text is not unique.",
      },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence instead of requiring exactly one.",
      },
    },
    required: ["path", "old_string", "new_string"],
  },

  async preview(args, context) {
    const target = await resolveToolPath(args.path, context);
    if (!target) return "edit: missing `path`";
    if (!target.exists) return `edit ${target.relative}: file not found`;

    const before = await readIfExists(target.absolute);
    if (before === null) return `edit ${target.relative}: file not found`;

    const planned = planEdit(before, args);
    if (!planned.ok) return `edit ${target.relative}\n${planned.error}`;

    return `edit ${target.relative}\n${diffLines(before, planned.after) || "(no changes)"}`;
  },

  async run(args, context): Promise<ToolResult> {
    const target = await resolveToolPath(args.path, context);
    if (!target) return { content: "Error: `path` is required.", isError: true };

    const before = await readIfExists(target.absolute);
    if (before === null) return { content: `Error: no such file: ${target.relative}`, isError: true };

    const planned = planEdit(before, args);
    if (!planned.ok) return { content: `Error: ${planned.error}`, isError: true };

    try {
      await writeFile(target.absolute, planned.after, "utf8");
    } catch (error) {
      return { content: `Error writing ${target.relative}: ${(error as Error).message}`, isError: true };
    }

    return {
      content: `Edited ${target.relative} (${planned.replacements} replacement${planned.replacements === 1 ? "" : "s"}).`,
    };
  },
};

export type EditPlan = { ok: true; after: string; replacements: number } | { ok: false; error: string };

/** Pure so both `preview` and `run` agree on exactly what would happen. */
export function planEdit(before: string, args: Record<string, unknown>): EditPlan {
  const oldString = typeof args.old_string === "string" ? args.old_string : "";
  const newString = typeof args.new_string === "string" ? args.new_string : "";

  if (!oldString) return { ok: false, error: "`old_string` is required and must not be empty." };
  if (oldString === newString) return { ok: false, error: "`old_string` and `new_string` are identical." };

  const occurrences = countOccurrences(before, oldString);
  if (occurrences === 0) {
    return { ok: false, error: "`old_string` not found. Read the file first and copy the exact text, including indentation." };
  }

  const replaceAll = args.replace_all === true;
  if (occurrences > 1 && !replaceAll) {
    return {
      ok: false,
      error: `\`old_string\` matches ${occurrences} places. Include surrounding lines to make it unique, or pass replace_all: true.`,
    };
  }

  // A replacer function, not a string: `$&`/`$1` in the replacement must stay literal.
  const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, () => newString);

  return { ok: true, after, replacements: replaceAll ? occurrences : 1 };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

async function readIfExists(absolute: string): Promise<string | null> {
  return readFile(absolute, "utf8").catch(() => null);
}
