import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { boolArg, intArg } from "./args";
import { resolveToolPath } from "./fs";
import { escapeRegExp, globToRegExp, toPosix } from "./glob-match";
import type { Tool, ToolResult } from "./types";
import { walkFiles } from "./walk";

const DEFAULT_MAX_RESULTS = 100;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 300;

export const grepTool: Tool = {
  name: "grep",
  // Reads change nothing, so they may overlap each other within one turn.
  concurrencySafe: true,
  description:
    "Search file contents with a regular expression. Returns `path:line: text` matches. Use the glob argument to limit which files are searched. Skips node_modules, .git, and build output.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression, or literal text when `literal` is true.",
      },
      path: {
        type: "string",
        description: "File or directory to search. Defaults to the working directory.",
      },
      glob: {
        type: "string",
        description: "Only search files whose path matches this glob, e.g. `**/*.ts`.",
      },
      literal: {
        type: "boolean",
        description: "Treat `pattern` as literal text instead of a regular expression.",
      },
      ignore_case: {
        type: "boolean",
        description: "Case-insensitive search.",
      },
      max_results: {
        type: "integer",
        description: `Cap on matches returned. Defaults to ${DEFAULT_MAX_RESULTS}.`,
      },
    },
    required: ["pattern"],
  },

  async run(args, context): Promise<ToolResult> {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    if (!pattern) return { content: "Error: `pattern` is required.", isError: true };

    const literal = boolArg(args.literal);
    const flags = boolArg(args.ignore_case) ? "i" : "";

    let regex: RegExp;
    try {
      regex = new RegExp(literal ? escapeRegExp(pattern) : pattern, flags);
    } catch (error) {
      return {
        content: `Error: invalid regular expression "${pattern}": ${(error as Error).message}. Pass literal: true to search for it as plain text.`,
        isError: true,
      };
    }

    let fileFilter: RegExp | null = null;
    if (typeof args.glob === "string" && args.glob.trim() !== "") {
      try {
        fileFilter = globToRegExp(args.glob.trim());
      } catch (error) {
        return { content: `Error: invalid glob "${args.glob}": ${(error as Error).message}`, isError: true };
      }
    }

    // Resolve what to search: one file, or a walked directory.
    const base = args.path === undefined ? null : await resolveToolPath(args.path, context);
    if (args.path !== undefined && !base) return { content: "Error: `path` was empty.", isError: true };

    const root = base ? base.absolute : context.cwd;
    const info = await stat(root).catch(() => null);
    if (!info) return { content: `Error: no such path: ${base ? base.relative : root}`, isError: true };

    let files: string[];
    let truncated = false;
    if (info.isFile()) {
      files = [root];
    } else if (info.isDirectory()) {
      const walked = await walkFiles({ root });
      files = walked.files;
      truncated = walked.truncated;
    } else {
      return { content: `Error: ${base ? base.relative : root} is neither a file nor a directory.`, isError: true };
    }

    if (fileFilter) {
      const filterRoot = info.isDirectory() ? root : path.dirname(root);
      files = files.filter((absolute) => fileFilter.test(toPosix(path.relative(filterRoot, absolute))));
    }

    const max = Math.max(intArg(args.max_results, DEFAULT_MAX_RESULTS), 1);
    const matches: string[] = [];
    let scanned = 0;
    let skipped = 0;
    let hitLimit = false;

    for (const absolute of files) {
      if (hitLimit) break;

      const fileInfo = await stat(absolute).catch(() => null);
      if (!fileInfo || fileInfo.size > MAX_FILE_BYTES) {
        skipped++;
        continue;
      }

      let text: string;
      try {
        text = await readFile(absolute, "utf8");
      } catch {
        skipped++;
        continue;
      }
      // A NUL byte means the "text" is really a binary blob.
      if (text.includes("\u0000")) {
        skipped++;
        continue;
      }

      scanned++;
      const display = toPosix(path.relative(context.cwd, absolute));
      const lines = text.split(/\r?\n/);

      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? "";
        if (!regex.test(line)) continue;

        matches.push(`${display}:${index + 1}: ${trimLine(line)}`);
        if (matches.length >= max) {
          hitLimit = true;
          break;
        }
      }
    }

    if (matches.length === 0) {
      const scope = base ? base.relative : ".";
      const skipNote = skipped > 0 ? ` (${skipped} unreadable, binary, or oversized file${skipped === 1 ? "" : "s"} skipped)` : "";
      return { content: `No matches for ${describe(pattern, literal, flags)} in ${scope} — searched ${scanned} file${scanned === 1 ? "" : "s"}${skipNote}.` };
    }

    const notes: string[] = [];
    if (hitLimit) notes.push(`stopped at ${max} matches — raise max_results or narrow the search`);
    if (truncated) notes.push("search stopped early — narrow the path or glob");

    return {
      content: matches.join("\n") + (notes.length > 0 ? `\n\n[${notes.join("; ")}]` : ""),
      isError: false,
    };
  },
};

function trimLine(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS - 1)}…` : trimmed;
}

function describe(pattern: string, literal: boolean, flags: string): string {
  const body = literal ? `"${pattern}"` : `/${pattern}/`;
  return flags.includes("i") ? `${body}i` : body;
}
