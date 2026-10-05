import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { clamp, intArg } from "./args";
import type { Tool, ToolResult } from "./types";

const MAX_LINES = 2000;
/** Refuse to dump a huge or generated file into the model's context. */
const MAX_BYTES = 512 * 1024;

export const readTool: Tool = {
  name: "read",
  // Reads change nothing, so they may overlap each other within one turn.
  concurrencySafe: true,
  description:
    "Read a text file from disk. Returns the contents with 1-based line numbers so you can reference exact lines. Use offset/limit to page through large files.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path, absolute or relative to the working directory.",
      },
      offset: {
        type: "integer",
        description: "1-based line to start from. Defaults to 1.",
      },
      limit: {
        type: "integer",
        description: `Maximum number of lines to return. Defaults to ${MAX_LINES}.`,
      },
    },
    required: ["path"],
  },

  async run(args, context): Promise<ToolResult> {
    const requested = typeof args.path === "string" ? args.path.trim() : "";
    if (!requested) return { content: "Error: `path` is required.", isError: true };

    const absolute = path.isAbsolute(requested) ? requested : path.resolve(context.cwd, requested);

    let info;
    try {
      info = await stat(absolute);
    } catch {
      return { content: `Error: no such file: ${requested}`, isError: true };
    }
    if (info.isDirectory()) return { content: `Error: ${requested} is a directory, not a file.`, isError: true };
    if (!info.isFile()) return { content: `Error: ${requested} is not a regular file.`, isError: true };

    let text: string;
    try {
      text = await readFile(absolute, "utf8");
    } catch (error) {
      return { content: `Error reading ${requested}: ${(error as Error).message}`, isError: true };
    }
    if (text.includes("\u0000")) return { content: `Error: ${requested} looks like a binary file.`, isError: true };

    const truncatedBytes = info.size > MAX_BYTES;
    if (truncatedBytes) text = text.slice(0, MAX_BYTES);

    const lines = text.split(/\r?\n/);
    // A trailing newline is not a line.
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

    const total = lines.length;
    const offset = clamp(intArg(args.offset, 1), 1, Math.max(total, 1));
    const limit = clamp(intArg(args.limit, MAX_LINES), 1, MAX_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);

    const numbered = slice.map((line, index) => `${String(offset + index).padStart(5)}  ${line}`).join("\n");

    const notes: string[] = [];
    const remaining = total - (offset - 1) - slice.length;
    if (remaining > 0) {
      notes.push(`${remaining} more line${remaining === 1 ? "" : "s"} — call read again with offset=${offset + slice.length}`);
    }
    if (truncatedBytes) notes.push(`file truncated at ${Math.round(MAX_BYTES / 1024)}KB`);

    return { content: notes.length > 0 ? `${numbered}\n\n[${notes.join("; ")}]` : numbered };
  },
};
