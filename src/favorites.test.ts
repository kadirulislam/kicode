import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { favoritesFile, loadFavorites, saveFavorites } from "./favorites";

let home = "";
const env = (): NodeJS.ProcessEnv => ({ ...process.env, KICODE_HOME: home });

const ref = (model: string, baseUrl = "https://api.example/v1") => ({ baseUrl, model });

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "kicode-favorites-"));
});

afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

describe("favorites store", () => {
  it("is empty when nothing has been saved", async () => {
    expect(await loadFavorites(env())).toEqual([]);
  });

  it("round-trips a list, keeping one name per endpoint", async () => {
    await saveFavorites([ref("glm-5.3"), ref("m1", "https://other.example/v1")], env());

    expect(await loadFavorites(env())).toEqual([ref("glm-5.3"), ref("m1", "https://other.example/v1")]);
  });

  it("keeps the order it was given", async () => {
    await saveFavorites([ref("newest"), ref("older")], env());

    expect((await loadFavorites(env())).map((entry) => entry.model)).toEqual(["newest", "older"]);
  });

  it("survives a corrupt file rather than stopping the model list", async () => {
    await saveFavorites([ref("m1")], env());
    await writeFile(favoritesFile(env()), "{ not json", "utf8");

    expect(await loadFavorites(env())).toEqual([]);
  });

  it("drops entries that are not a model on an endpoint", async () => {
    await saveFavorites([ref("m1")], env());
    await writeFile(favoritesFile(env()), JSON.stringify([ref("m1"), { model: "no url" }, { baseUrl: "" , model: "x" }, "nope"]), "utf8");

    expect(await loadFavorites(env())).toEqual([ref("m1")]);
  });

  it("writes valid JSON that a person could edit", async () => {
    await saveFavorites([ref("m1")], env());

    const raw = await readFile(favoritesFile(env()), "utf8");
    expect(JSON.parse(raw)).toEqual([ref("m1")]);
    expect(raw).toContain("\n");
  });
});
