import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_BASE_URL,
  DEFAULT_COMPACT_AT_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_KEEP_TURNS,
  DEFAULT_RESERVE_TOKENS,
  MOCK_BASE_URL,
  type Config,
} from "../config";
import { stripBom } from "../config-file";
import { DEFAULT_THEME } from "../tui/theme";
import { CONFIG_FILENAME } from "../paths";

/**
 * `kicode --init` — writes the settings in effect right now into the project's
 * `kicode.json`, so the next run needs no flags and no environment variables.
 *
 * The file is *merged*, never replaced. An `mcp` block is hand-written and
 * awkward to recreate, so re-running `--init` after switching model must not
 * throw it away. Only the keys below are ever touched, and only those that are
 * not already the built-in defaults — a config file that restates every default
 * is noise that goes stale.
 *
 * Because flags beat the file, which beats the environment, `--model` and
 * `--base-url` are how you change what gets recorded:
 *
 *     kicode --init --model deepseek-v4-flash:free
 */
export type InitOutcome =
  | { status: "written" | "updated" | "unchanged"; file: string; keys: string[] }
  | { status: "blocked"; file: string; reason: string };

export async function writeProjectConfig(cwd: string, config: Config): Promise<InitOutcome> {
  const file = path.join(cwd, CONFIG_FILENAME);

  let raw: string | null = null;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    raw = null; // absent is the normal case
  }

  let existing: Record<string, unknown> | null = null;
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripBom(raw));
    } catch {
      // Merging needs to read it, and overwriting a file we could not parse
      // would silently discard whatever was in there — so refuse. The parse
      // error itself was already reported by the config-file reader, so this
      // message points at it rather than repeating it.
      return {
        status: "blocked",
        file,
        reason: `Refusing to touch ${file} — fix the JSON error above, or delete the file, then run --init again.`,
      };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "blocked", file, reason: `Refusing to touch ${file} — expected a JSON object at the top level.` };
    }
    existing = parsed as Record<string, unknown>;
  }

  const projection = project(config);
  // Merge into an existing block rather than replacing it, so a key this
  // version does not know about survives a re-run.
  const tuning = projection.compaction as Record<string, unknown> | undefined;
  if (tuning !== undefined && isPlainObject(existing?.compaction)) {
    projection.compaction = { ...existing.compaction, ...tuning };
  }

  const next: Record<string, unknown> = { ...(existing ?? {}), ...projection };

  // `mock` and `baseUrl` contradict each other — an explicit baseUrl wins and
  // the shorthand is ignored — so leaving a stale one behind would be a trap.
  if (projection.mock === true) delete next.baseUrl;
  if (projection.baseUrl !== undefined) delete next.mock;

  const keys = Object.keys(projection);

  if (existing !== null && JSON.stringify(existing) === JSON.stringify(next)) {
    return { status: "unchanged", file, keys };
  }

  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { status: existing === null ? "written" : "updated", file, keys };
}

/** The subset of the effective config that belongs to a project, not a shell. */
function project(config: Config): Record<string, unknown> {
  const settings: Record<string, unknown> = { model: config.model };

  if (config.baseUrl === MOCK_BASE_URL) settings.mock = true;
  else if (config.baseUrl !== DEFAULT_BASE_URL) settings.baseUrl = config.baseUrl;

  // Only when it has been chosen: writing the default would pin a project to
  // today's default theme, which is the one thing a theme should not be.
  if (config.theme !== DEFAULT_THEME) settings.theme = config.theme;

  const compaction: Record<string, unknown> = {};
  if (config.compaction.contextTokens !== DEFAULT_CONTEXT_TOKENS) {
    compaction.contextTokens = config.compaction.contextTokens;
  }
  if (config.compaction.reserveTokens !== DEFAULT_RESERVE_TOKENS) {
    compaction.reserveTokens = config.compaction.reserveTokens;
  }
  if (config.compaction.keepRecentTurns !== DEFAULT_KEEP_TURNS) {
    compaction.keepRecentTurns = config.compaction.keepRecentTurns;
  }
  if (config.compaction.compactAt !== DEFAULT_COMPACT_AT_TOKENS) {
    compaction.compactAt = config.compaction.compactAt;
  }
  if (!config.compaction.enabled) compaction.enabled = false;

  return Object.keys(compaction).length > 0 ? { ...settings, compaction } : settings;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
