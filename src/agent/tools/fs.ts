import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolContext } from "./types";

export type ResolvedPath = {
  absolute: string;
  /** Path as the user will recognise it — relative to the working directory when possible. */
  relative: string;
  exists: boolean;
};

/** Resolves a tool's `path` argument, or null when it was missing/empty. */
export async function resolveToolPath(raw: unknown, context: ToolContext): Promise<ResolvedPath | null> {
  const requested = typeof raw === "string" ? raw.trim() : "";
  if (!requested) return null;

  const absolute = path.isAbsolute(requested) ? requested : path.resolve(context.cwd, requested);
  const exists = await stat(absolute)
    .then((info) => info.isFile())
    .catch(() => false);

  return { absolute, relative: path.relative(context.cwd, absolute) || absolute, exists };
}
