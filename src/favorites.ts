import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveHome } from "./paths";

/**
 * The models worth keeping to hand.
 *
 * A model is a name *and* an endpoint, because the same name can exist on two
 * providers and only one of them may answer to it. They live beside the
 * sessions in KiCode's own directory rather than in a project's `kicode.json`:
 * a favourite is a personal shortcut, not a property of the code being worked
 * on, and it should follow the user between projects.
 */

export type FavoriteModel = { baseUrl: string; model: string };

const FILENAME = "favorites.json";
/** Enough to be useful as a shortcut, few enough to stay a shortcut. */
const MAX_FAVORITES = 20;

export function favoritesFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveHome(env), FILENAME);
}

/** The saved favourites, newest first. A missing or unreadable file is empty. */
export async function loadFavorites(env: NodeJS.ProcessEnv = process.env): Promise<FavoriteModel[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(favoritesFile(env), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isFavorite).slice(0, MAX_FAVORITES);
  } catch {
    // A favourite is a convenience: an absent or corrupt file must never stop
    // the model list from opening.
    return [];
  }
}

export async function saveFavorites(favorites: readonly FavoriteModel[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = favoritesFile(env);
  await mkdir(path.dirname(file), { recursive: true });

  const temp = `${file}.tmp`;
  const body = JSON.stringify(favorites.slice(0, MAX_FAVORITES), null, 2);
  // Write then rename, so an interrupted save cannot leave a half-written list.
  await writeFile(temp, body, "utf8");
  await rename(temp, file);
}

function isFavorite(value: unknown): value is FavoriteModel {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.baseUrl === "string" && entry.baseUrl.trim() !== "" && typeof entry.model === "string" && entry.model.trim() !== ""
  );
}
