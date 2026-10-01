import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripBom } from "./config-file";
import { CONFIG_FILENAME, resolveHome } from "./paths";

/**
 * Writing one key into the user's own `kicode.json`.
 *
 * This is the file `readConfigFiles` reads first, so a setting written here
 * holds for every project on the machine — which is what a preference about
 * fonts, colours and how much output to show should do. The project file still
 * wins over it, because a project is the more specific statement.
 *
 * Two rules, both learned from what goes wrong with config files:
 *
 * - a file that will not parse is never overwritten. Merging needs to read it,
 *   and replacing a file we could not understand would silently discard
 *   whatever the user had in there;
 * - the write is atomic. A half-written config is a config the next run
 *   refuses, so the new content lands in a temporary file and is renamed over
 *   the old one.
 */

export type SettingsWriteResult =
  | { ok: true; file: string; status: "written" | "updated" | "unchanged" }
  | { ok: false; file: string; reason: string };

/** The path of the global config, which may not exist yet. */
export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveHome(env), CONFIG_FILENAME);
}

/**
 * Sets one key, merging into whatever is already there.
 *
 * Keys other than the one being set are preserved verbatim — including ones
 * this version of KiCode does not know about, and the `mcp` block, which is
 * hand-written and the most annoying thing in the file to recreate.
 */
export async function writeGlobalSetting(
  key: string,
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SettingsWriteResult> {
  return writeGlobalSettings({ [key]: value }, env);
}

export async function writeGlobalSettings(
  patch: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SettingsWriteResult> {
  const file = globalConfigPath(env);

  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(stripBom(raw));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, file, reason: `Refusing to touch ${file} — expected a JSON object at the top level.` };
    }
    existing = parsed as Record<string, unknown>;
  } catch (error) {
    // Absent is the normal case for a first write; anything else means there is
    // content we could not read, and that content must not be lost.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, file, reason: `Refusing to touch ${file} — ${(error as Error).message}` };
    }
  }

  const next: Record<string, unknown> = { ...existing, ...patch };
  if (JSON.stringify(existing) === JSON.stringify(next)) {
    return { ok: true, file, status: "unchanged" };
  }

  try {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid.toString(36)}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temp, file);
  } catch (error) {
    return { ok: false, file, reason: `Could not write ${file} — ${(error as Error).message}` };
  }

  return { ok: true, file, status: Object.keys(existing).length === 0 ? "written" : "updated" };
}

/**
 * A `providers` entry, merged into whatever `providers` block is already there.
 *
 * Kept separate from the settings write above because it merges one level down:
 * adding a second endpoint must not drop the first. Nothing here can carry a
 * key — only the name of the environment variable that holds one.
 */
export async function addGlobalProvider(
  name: string,
  provider: { baseUrl: string; apiKey?: string; apiKeyEnv?: string; models?: string[] },
  env: NodeJS.ProcessEnv = process.env,
): Promise<SettingsWriteResult> {
  const file = globalConfigPath(env);

  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(stripBom(raw));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, file, reason: `Refusing to touch ${file} — expected a JSON object at the top level.` };
    }
    existing = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, file, reason: `Refusing to touch ${file} — ${(error as Error).message}` };
    }
  }

  const block =
    existing.providers !== null && typeof existing.providers === "object" && !Array.isArray(existing.providers)
      ? (existing.providers as Record<string, unknown>)
      : {};

  const next = {
    ...existing,
    providers: {
      ...block,
      [name]: {
        baseUrl: provider.baseUrl,
        ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
        ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
        ...(provider.models && provider.models.length > 0 ? { models: [...provider.models] } : {}),
      },
    },
  };

  if (JSON.stringify(existing) === JSON.stringify(next)) return { ok: true, file, status: "unchanged" };

  try {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid.toString(36)}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temp, file);
  } catch (error) {
    return { ok: false, file, reason: `Could not write ${file} — ${(error as Error).message}` };
  }

  return { ok: true, file, status: Object.keys(existing).length === 0 ? "written" : "updated" };
}
