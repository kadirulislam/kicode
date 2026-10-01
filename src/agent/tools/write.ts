import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { diffLines, splitLines } from "./diff";
import { resolveToolPath } from "./fs";
import type { Tool, ToolResult } from "./types";

/**
 * Creates or overwrites a file. Gated behind approval: `preview()` renders the
 * diff, the loop asks the user, and only then does `run()` touch disk.
 */
export const writeTool: Tool = {
  name: "write",
  description:
    "Create a file or replace it entirely. The change is shown as a diff and must be approved before anything is written.",
  requiresApproval: true,

  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path, absolute or relative to the working directory. Missing directories are created.",
      },
      content: {
        type: "string",
        description: "Full file contents. This replaces the file entirely — use `edit` for small changes.",
      },
    },
    required: ["path", "content"],
  },

  async preview(args, context) {
    const target = await resolveToolPath(args.path, context);
    if (!target) return "write: missing `path`";

    const before = target.exists ? await readIfExists(target.absolute) : "";
    const after = typeof args.content === "string" ? args.content : "";

    return `${target.exists ? "overwrite" : "create"} ${target.relative}\n${diffLines(before, after) || "(no changes)"}`;
  },

  async run(args, context): Promise<ToolResult> {
    const content = typeof args.content === "string" ? args.content : null;
    if (content === null) return { content: "Error: `content` is required.", isError: true };

    const target = await resolveToolPath(args.path, context);
    if (!target) return { content: "Error: `path` is required.", isError: true };

    const info = await stat(target.absolute).catch(() => null);
    if (info?.isDirectory()) return { content: `Error: ${target.relative} is a directory.`, isError: true };

    try {
      await mkdir(path.dirname(target.absolute), { recursive: true });
      await writeFile(target.absolute, content, "utf8");
    } catch (error) {
      return { content: `Error writing ${target.relative}: ${(error as Error).message}`, isError: true };
    }

    const lines = splitLines(content).length;
    return { content: `Wrote ${target.relative} (${lines} line${lines === 1 ? "" : "s"}).` };
  },
};

async function readIfExists(absolute: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(absolute, "utf8").catch(() => "");
}
