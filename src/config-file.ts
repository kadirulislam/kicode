import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILENAME, resolveHome } from "./paths";

/**
 * Both `kicode.json` files — the per-user one and the per-project one.
 *
 * Read once and shared by every consumer, so settings and MCP servers can never
 * disagree about which files exist or what they contained.
 */

export type ConfigScope = "global" | "project";

export type ConfigFileEntry = {
  file: string;
  scope: ConfigScope;
  json: Record<string, unknown>;
};

export type ReadConfigFilesResult = {
  /** Global first, then project — later entries override earlier ones. */
  entries: ConfigFileEntry[];
  files: string[];
  warnings: string[];
};

export async function readConfigFiles(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReadConfigFilesResult> {
  const candidates: { file: string; scope: ConfigScope }[] = [
    { file: path.join(resolveHome(env), CONFIG_FILENAME), scope: "global" },
    { file: path.join(cwd, CONFIG_FILENAME), scope: "project" },
  ];

  const entries: ConfigFileEntry[] = [];
  const files: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const key = path.resolve(candidate.file);
    // Comparing paths rather than strings: with KICODE_HOME unset and KiCode
    // run from the home directory these would be the same file.
    if (seen.has(key)) continue;
    seen.add(key);

    let raw: string;
    try {
      raw = await readFile(candidate.file, "utf8");
    } catch {
      continue; // absent is normal — every setting has a default
    }
    files.push(candidate.file);

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripBom(raw));
    } catch (error) {
      warnings.push(`Ignoring ${candidate.file}: not valid JSON — ${(error as Error).message}`);
      continue;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`Ignoring ${candidate.file}: expected a JSON object at the top level.`);
      continue;
    }

    entries.push({ file: candidate.file, scope: candidate.scope, json: parsed as Record<string, unknown> });
  }

  return { entries, files, warnings };
}

/**
 * The `brain` path a config declares, read synchronously.
 *
 * The brain briefing is assembled before the first request — in the same place
 * the directory's `AGENTS.md` is read — where there is no await to be had, so
 * the two files `readConfigFiles` reads (per-user first, the project's after
 * it) are read here without promises. Only that one key is looked at, and every
 * failure is a miss: a config that will not parse has already been reported by
 * `readConfigFiles`, and this is not the place to report it twice.
 */
export function readConfigBrainSync(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [path.join(resolveHome(env), CONFIG_FILENAME), path.join(cwd, CONFIG_FILENAME)];
  let value: string | null = null;

  for (const file of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripBom(readFileSync(file, "utf8")));
    } catch {
      continue; // absent, unreadable, or unparseable is all just "no brain key"
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const brain = (parsed as Record<string, unknown>).brain;
    if (typeof brain === "string" && brain.trim() !== "") value = brain.trim();
  }

  return value;
}

/**
 * Windows editors — Notepad, and PowerShell's `Set-Content -Encoding utf8` on
 * 5.1 — write a UTF-8 BOM. `JSON.parse` rejects it as an unexpected token, so a
 * perfectly valid config would be reported as broken.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
