import { readdir } from "node:fs/promises";
import path from "node:path";

/** Directories that never hold source worth searching. */
export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
  ".mypy_cache",
]);

export type WalkOptions = {
  root: string;
  maxEntries?: number;
  skipDirs?: ReadonlySet<string>;
};

export type WalkResult = {
  /** Absolute paths, sorted for deterministic output. */
  files: string[];
  /** True when the entry cap stopped the walk early. */
  truncated: boolean;
};

/**
 * Depth-first walk over regular files.
 *
 * Symlinks are deliberately not followed: a link cycle would otherwise trap the
 * walk, and a link out of the tree is not what "search my project" means. An
 * unreadable directory is skipped rather than failing the whole search.
 */
export async function walkFiles(options: WalkOptions): Promise<WalkResult> {
  const skip = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const maxEntries = options.maxEntries ?? 20_000;
  const files: string[] = [];
  const stack: string[] = [options.root];
  let visited = 0;
  let truncated = false;

  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (++visited > maxEntries) {
        truncated = true;
        stack.length = 0;
        break;
      }

      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        files.push(path.join(dir, entry.name));
      }
    }
  }

  files.sort();
  return { files, truncated };
}
