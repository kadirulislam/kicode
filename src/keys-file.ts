import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripBom } from "./config-file";
import { resolveHome } from "./paths";

/**
 * The file a pasted key is kept in.
 *
 * `/key` used to hold the key in memory only, so every fresh run asked again —
 * and the only way out was setting the variable by hand in every shell. Now
 * the key is written here, named by the variable it belongs in, and the next
 * run reads it back before the config loads. One paste, then never again.
 *
 * Deliberately separate from `kicode.json`: that file is shown, copied and
 * talked about, while this one is only ever read at startup and written by a
 * paste. A key that is rotated is pasted again (which overwrites), and a key
 * that should be forgotten is deleted from this file — or the file itself.
 */

export const KEYS_FILENAME = "keys.json";

/** Where the key file lives, which may not exist yet. */
export function keysFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveHome(env), KEYS_FILENAME);
}

export type KeysWriteResult =
  | { ok: true; file: string }
  | { ok: false; file: string; reason: string };

/** A variable name worth storing a key under — anything `export NAME=` accepts. */
function validVarName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Every key the file holds, by variable name.
 *
 * Absent, unreadable or malformed means no stored keys — never a failed
 * startup. A file that is valid JSON but not an object of strings is treated
 * the same way: whatever it is, it is not keys.
 */
export async function readStoredKeys(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  try {
    const raw = await readFile(keysFilePath(env), "utf8");
    const parsed: unknown = JSON.parse(stripBom(raw));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const keys: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (validVarName(name) && typeof value === "string" && value.trim()) keys[name] = value;
    }
    return keys;
  } catch {
    return {};
  }
}

/**
 * Keeps one key for the next runs, merging with whatever is already stored.
 *
 * Owner-only on creation (`0600`): the file next to it holds transcripts and
 * settings, but this is the one that must not be read over a shoulder. The
 * write is atomic, the same tmp-and-rename as the settings writer, so a
 * half-written file never greets the next run.
 */
export async function writeStoredKey(
  varName: string,
  apiKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KeysWriteResult> {
  const file = keysFilePath(env);
  const name = varName.trim();
  if (!validVarName(name)) return { ok: false, file, reason: `"${varName}" is not a variable name a key can be stored under.` };
  if (!apiKey.trim()) return { ok: false, file, reason: "Refusing to store an empty key." };

  const next = { ...(await readStoredKeys(env)), [name]: apiKey };
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid.toString(36)}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    return { ok: false, file, reason: `Could not write ${file} — ${(error as Error).message}` };
  }
  return { ok: true, file };
}
