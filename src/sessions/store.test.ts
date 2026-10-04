import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatMessage } from "../types";
import { clearActiveSessionId, latestSessionFor, listSessions, loadSession, newSessionId, pruneSessions, readActiveSessionId, saveSession, sessionPreview, sessionsDir, writeActiveSessionId } from "./store";

let home = "";
const env = (): NodeJS.ProcessEnv => ({ ...process.env, KICODE_HOME: home });

const record = (id: string, cwd: string, updatedAt: string) => ({
  id,
  createdAt: updatedAt,
  updatedAt,
  cwd,
  model: "m",
  baseUrl: "https://example.com/v1",
  messages: [{ role: "user", content: `hello from ${id}` } as ChatMessage],
});

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "kicode-sessions-"));
});

afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

describe("session store", () => {
  it("keeps the fact of a pasted image, and not the pixels", async () => {
    // Its own home: the other tests in this file count what is in the shared
    // one, and this record would be a third session to them.
    const own = await mkdtemp(path.join(tmpdir(), "kicode-image-"));
    const onlyVisible = { ...process.env, KICODE_HOME: own };

    try {
      const screenshot = "A".repeat(20_000);
      await saveSession(
        {
          ...record("s-image", "/project/one", "2026-01-01T00:00:00.000Z"),
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "why is this broken?" },
                { type: "image_url", image_url: { url: `data:image/png;base64,${screenshot}` } },
              ],
            },
          ],
        },
        onlyVisible,
      );

      const raw = await readFile(path.join(sessionsDir(onlyVisible), "s-image.json"), "utf8");
      expect(raw).not.toContain(screenshot);
      expect(raw).toContain("1 image not kept in the session");

      // The words survive, so the transcript still reads as it did, and the
      // session is named after the request rather than after the picture.
      const loaded = await loadSession("s-image", onlyVisible);
      expect(loaded?.messages[0]).toEqual({
        role: "user",
        content: "why is this broken?\n[1 image not kept in the session]",
      });
      expect(loaded?.title).toBe("why is this broken?");
    } finally {
      await rm(own, { recursive: true, force: true });
    }
  });

  it("round-trips a session", async () => {
    await saveSession(record("s1", "/project/one", "2026-01-01T00:00:00.000Z"), env());

    const loaded = await loadSession("s1", env());

    expect(loaded?.id).toBe("s1");
    expect(loaded?.messages[0]).toEqual({ role: "user", content: "hello from s1" });
  });

  it("keeps a session's mode and variant, and tolerates a record without them", async () => {
    // Its own home: the counts above are about the shared one.
    const own = await mkdtemp(path.join(tmpdir(), "kicode-mode-"));
    const onlyVisible = { ...process.env, KICODE_HOME: own };

    try {
      await saveSession(
        { ...record("s-mode", "/project/one", "2026-01-01T00:00:00.000Z"), mode: "plan", variant: "high" },
        onlyVisible,
      );
      const loaded = await loadSession("s-mode", onlyVisible);
      expect(loaded?.mode).toBe("plan");
      expect(loaded?.variant).toBe("high");

      // A record written before these existed simply has neither, and reads
      // back with neither rather than with a placeholder.
      await saveSession(record("s-old", "/project/one", "2026-01-01T00:00:00.000Z"), onlyVisible);
      const older = await loadSession("s-old", onlyVisible);
      expect(older?.mode).toBeUndefined();
      expect(older?.variant).toBeUndefined();
    } finally {
      await rm(own, { recursive: true, force: true });
    }
  });

  it("returns null for an unknown id", async () => {
    expect(await loadSession("nope", env())).toBeNull();
  });

  it("leaves nothing behind but JSON", async () => {
    await saveSession(record("s2", "/project/two", "2026-01-02T00:00:00.000Z"), env());

    const names = await readdir(sessionsDir(env()));

    expect(names.every((name) => name.endsWith(".json"))).toBe(true);
  });

  it("lists newest first", async () => {
    const ids = (await listSessions(env())).map((session) => session.id);

    expect(ids).toEqual(["s2", "s1"]);
  });

  it("resumes the newest session for a directory", async () => {
    expect((await latestSessionFor("/project/one", env()))?.id).toBe("s1");
    expect(await latestSessionFor("/project/none", env())).toBeNull();
  });

  it("ignores a corrupt session file instead of failing", async () => {
    await writeFile(path.join(sessionsDir(env()), "broken.json"), "{ not json", "utf8");
    await writeFile(path.join(sessionsDir(env()), "wrong-shape.json"), JSON.stringify({ id: "x" }), "utf8");

    const ids = (await listSessions(env())).map((session) => session.id);

    expect(ids).toEqual(["s2", "s1"]);
  });

  it("prunes to the newest N", async () => {
    for (let index = 0; index < 5; index++) {
      await saveSession(record(`p${index}`, "/project/three", `2026-02-0${index + 1}T00:00:00.000Z`), env());
    }

    await pruneSessions(env(), 3);

    expect((await listSessions(env())).map((session) => session.id)).toEqual(["p4", "p3", "p2"]);
  });

  it("generates unique, filename-safe ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));

    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9-]+$/);
  });
});

describe("active tab pointer", () => {
  it("round-trips the tab that was in front", async () => {
    await writeActiveSessionId("/project/front", "s-front", env());

    expect(await readActiveSessionId("/project/front", env())).toBe("s-front");
  });

  it("keeps one pointer per directory", async () => {
    await writeActiveSessionId("/project/a", "s-a", env());
    await writeActiveSessionId("/project/b", "s-b", env());

    expect(await readActiveSessionId("/project/a", env())).toBe("s-a");
    expect(await readActiveSessionId("/project/b", env())).toBe("s-b");
  });

  it("misses when the pointer names another directory", async () => {
    await writeActiveSessionId("/project/here", "s-here", env());

    expect(await readActiveSessionId("/project/elsewhere", env())).toBeNull();
  });

  it("ignores a pointer whose directory moved out from under it", async () => {
    const own = await mkdtemp(path.join(tmpdir(), "kicode-moved-"));
    const onlyVisible = { ...process.env, KICODE_HOME: own };
    try {
      await writeActiveSessionId("/project/there", "s-moved", onlyVisible);
      const names = await readdir(sessionsDir(onlyVisible));
      const pointer = names.find((name) => name.startsWith("active-")) ?? "";
      await writeFile(path.join(sessionsDir(onlyVisible), pointer), JSON.stringify({ id: "s-moved", cwd: "/project/gone" }), "utf8");

      expect(await readActiveSessionId("/project/there", onlyVisible)).toBeNull();
    } finally {
      await rm(own, { recursive: true, force: true });
    }
  });

  it("misses when there is nothing or garbage to read", async () => {
    expect(await readActiveSessionId("/project/never", env())).toBeNull();

    // Its own home: the other tests in this file count what is in the shared
    // one, and stray files there would be picked up by the listing tests.
    const own = await mkdtemp(path.join(tmpdir(), "kicode-active-"));
    const onlyVisible = { ...process.env, KICODE_HOME: own };
    try {
      await writeActiveSessionId("/project/x", "s-x", onlyVisible);
      const names = await readdir(sessionsDir(onlyVisible));
      const pointer = names.find((name) => name.startsWith("active-")) ?? "";
      await writeFile(path.join(sessionsDir(onlyVisible), pointer), "{ not json", "utf8");

      expect(await readActiveSessionId("/project/x", onlyVisible)).toBeNull();
    } finally {
      await rm(own, { recursive: true, force: true });
    }
  });

  it("clears only the pointer it names", async () => {
    await writeActiveSessionId("/project/clear", "s-old", env());
    await clearActiveSessionId("/project/clear", "s-other", env());

    expect(await readActiveSessionId("/project/clear", env())).toBe("s-old");

    await clearActiveSessionId("/project/clear", "s-old", env());

    expect(await readActiveSessionId("/project/clear", env())).toBeNull();
  });
});

describe("sessionPreview", () => {
  const previewRecord = (messages: ChatMessage[]) => ({
    id: "s",
    createdAt: "",
    updatedAt: "",
    cwd: "",
    model: "",
    baseUrl: "",
    messages,
  });

  it("returns the flattened opening request", () => {
    expect(sessionPreview(previewRecord([{ role: "user", content: "why is\n  this broken?" }]))).toBe(
      "why is this broken?",
    );
  });

  it("skips leading assistant turns and caps a long request", () => {
    const long = sessionPreview(
      previewRecord([
        { role: "assistant", content: "hello" },
        { role: "user", content: `${"x".repeat(200)} tail` },
      ]),
    );

    expect(long).toHaveLength(100);
    expect(long.endsWith("…")).toBe(true);
  });

  it("is empty when there is nothing to quote", () => {
    expect(sessionPreview(previewRecord([]))).toBe("");
    expect(sessionPreview(previewRecord([{ role: "user", content: "   " }]))).toBe("");
  });
});
