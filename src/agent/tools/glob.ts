import { stat } from "node:fs/promises";
import path from "node:path";
import { intArg } from "./args";
import { resolveToolPath } from "./fs";
import { globToRegExp, toPosix } from "./glob-match";
import type { Tool, ToolResult } from "./types";
import { walkFiles } from "./walk";

const DEFAULT_MAX_RESULTS = 200;

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files by glob pattern, e.g. `**/*.ts` or `src/**/*.test.ts`. Returns paths relative to the working directory, sorted. Skips node_modules, .git, and build output.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern. `**/` matches across directories, `*.ts` matches only the top level; `{a,b}` and `[abc]` also work.",
      },
      path: {
        type: "string",
        description: "Directory to search from. Defaults to the working directory.",
      },
      max_results: {
        type: "integer",
        description: `Cap on returned paths. Defaults to ${DEFAULT_MAX_RESULTS}.`,
      },
    },
    required: ["pattern"],
  },

  async run(args, context): Promise<ToolResult> {
    const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
    if (!pattern) return { content: "Error: `pattern` is required.", isError: true };

    let regex: RegExp;
    try {
      regex = globToRegExp(pattern);
    } catch (error) {
      return { content: `Error: invalid glob pattern "${pattern}": ${(error as Error).message}`, isError: true };
    }

    const base = args.path === undefined ? null : await resolveToolPath(args.path, context);
    if (args.path !== undefined && !base) return { content: "Error: `path` was empty.", isError: true };

    const root = base ? base.absolute : context.cwd;
    const info = await stat(root).catch(() => null);
    if (!info) return { content: `Error: no such path: ${base ? base.relative : root}`, isError: true };
    if (!info.isDirectory()) return { content: `Error: ${base ? base.relative : root} is not a directory.`, isError: true };

    const { files, truncated } = await walkFiles({ root });

    const matches = files
      // Match against the path relative to the search root, so `path: "src"`
      // with `*.ts` behaves the way it reads.
      .filter((absolute) => regex.test(toPosix(path.relative(root, absolute))))
      .map((absolute) => toPosix(path.relative(context.cwd, absolute)));

    if (matches.length === 0) {
      const scope = base ? ` under ${base.relative}` : "";
      return { content: `No files matched "${pattern}"${scope}.` };
    }

    const max = intArg(args.max_results, DEFAULT_MAX_RESULTS);
    const shown = matches.slice(0, Math.max(max, 1));

    const notes: string[] = [];
    if (matches.length > shown.length) notes.push(`showing ${shown.length} of ${matches.length}`);
    if (truncated) notes.push("search stopped early — narrow the pattern or the path");

    return { content: shown.join("\n") + (notes.length > 0 ? `\n\n[${notes.join("; ")}]` : "") };
  },
};
