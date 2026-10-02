import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, Provider } from "../types";
import { applyLearnings, extractLearnings, parseLearnings, transcriptForLearning } from "./learn";

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });

/** A provider that answers with one fixed blob of text. */
function replying(text: string): Provider {
  return {
    async *stream() {
      yield { type: "text", delta: text };
    },
  };
}

describe("parseLearnings", () => {
  it("finds the array through a fence and a sentence in front of it", () => {
    const raw = 'Here is what I found:\n```json\n[{"kind":"skill","name":"deploy","description":"Cut a release.","text":"1. test"}]```\n';

    expect(parseLearnings(raw)).toEqual([{ kind: "skill", name: "deploy", description: "Cut a release.", text: "1. test" }]);
  });

  it("drops anything unusable rather than saving it", () => {
    const raw = JSON.stringify([
      { kind: "spell", name: "x", text: "y" },
      { kind: "memory", name: "", text: "y" },
      { kind: "memory", name: "ok", text: "   " },
      { kind: "memory", name: "kept", text: "build with pnpm" },
    ]);

    expect(parseLearnings(raw)).toEqual([{ kind: "memory", name: "kept", text: "build with pnpm" }]);
  });

  it("answers nothing for prose that holds no array", () => {
    expect(parseLearnings("Nothing durable here.")).toEqual([]);
    expect(parseLearnings("[not json]")).toEqual([]);
  });

  it("caps how much one pass may add", () => {
    const many = JSON.stringify(Array.from({ length: 9 }, (_, index) => ({ kind: "memory", name: `n${index}`, text: "x" })));

    expect(parseLearnings(many)).toHaveLength(5);
  });
});

describe("transcriptForLearning", () => {
  it("labels who said what and leaves the system prompt out", () => {
    const text = transcriptForLearning([
      { role: "system", content: "you are a coding agent" },
      user("how do I build this?"),
      assistant("with pnpm"),
    ]);

    expect(text).toContain("USER: how do I build this?");
    expect(text).toContain("ASSISTANT: with pnpm");
    expect(text).not.toContain("coding agent");
  });

  it("keeps the end of a long session, because that is where the learning is", () => {
    const messages = Array.from({ length: 40 }, (_, index) => user(`${index}`.repeat(1_000)));
    const text = transcriptForLearning(messages);

    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(text).toContain("USER: 393939");
  });
});

describe("extractLearnings", () => {
  it("asks the model and parses its array", async () => {
    const provider = replying('[{"kind":"memory","name":"shop","text":"Deploy on Fridays is banned."}]');

    const { learnings } = await extractLearnings({
      messages: [user("x".repeat(300)), assistant("noted")],
      provider,
      model: "m",
    });

    expect(learnings).toEqual([{ kind: "memory", name: "shop", text: "Deploy on Fridays is banned." }]);
  });

  it("spends no request on a transcript with nothing in it", async () => {
    let called = false;
    const provider: Provider = {
      async *stream() {
        called = true;
        yield { type: "text", delta: "[]" };
      },
    };

    const { learnings } = await extractLearnings({ messages: [user("hi")], provider, model: "m" });

    expect(learnings).toEqual([]);
    expect(called).toBe(false);
  });

  it("reports a failed request instead of inventing learnings", async () => {
    const provider: Provider = {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<never, void, void> {
        throw new Error("endpoint is down");
      },
    };

    const { learnings, error } = await extractLearnings({ messages: [user("y".repeat(300))], provider, model: "m" });

    expect(learnings).toEqual([]);
    expect(error).toContain("endpoint is down");
  });
});

describe("applyLearnings", () => {
  let home = "";

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "kicode-learn-"));
  });

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("writes a skill and a memory into the brain, creating it", async () => {
    const result = await applyLearnings(
      home,
      [
        { kind: "skill", name: "pnpm-build", description: "Build with pnpm.", text: "1. pnpm i\n2. pnpm build" },
        { kind: "memory", name: "shop", text: "Deploy on Fridays is banned." },
      ],
      { KICODE_HOME: home },
    );

    expect(result.added).toHaveLength(2);
    const skill = await readFile(path.join(home, "brain", "skills", "pnpm-build", "SKILL.md"), "utf8");
    expect(skill).toContain("name: pnpm-build");
    expect(skill).toContain("pnpm build");
    const memory = await readFile(path.join(home, "brain", "memories", "projects", "shop.md"), "utf8");
    expect(memory).toContain("Deploy on Fridays is banned.");
  });

  it("is additive: a second pass adds nothing it already knows", async () => {
    const env = { KICODE_HOME: home };
    const items = [
      { kind: "skill" as const, name: "pnpm-build", description: "Build with pnpm.", text: "1. pnpm i" },
      { kind: "memory" as const, name: "shop", text: "Deploy on Fridays is banned." },
    ];
    await applyLearnings(home, items, env);

    const second = await applyLearnings(
      home,
      [
        { kind: "skill", name: "pnpm-build", description: "Build with pnpm.", text: "a different body" },
        { kind: "memory", name: "shop", text: "Deploy on Fridays is banned." },
      ],
      env,
    );

    expect(second.added).toHaveLength(0);
    expect(second.skipped).toHaveLength(2);
    // The existing skill was not overwritten by the second pass.
    expect(await readFile(path.join(home, "brain", "skills", "pnpm-build", "SKILL.md"), "utf8")).not.toContain("a different body");
  });

  it("refuses a secret through the same gate the tool uses", async () => {
    const result = await applyLearnings(
      home,
      [{ kind: "memory", name: "shop", text: "key: -----BEGIN RSA PRIVATE KEY-----\nabc" }],
      { KICODE_HOME: home },
    );

    expect(result.added).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });
});
