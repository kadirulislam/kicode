import { describe, expect, it } from "vitest";
import type { ChatMessage, Provider } from "../types";
import {
  COMPACT_TARGET_BAND,
  SUMMARY_HEADER,
  clampTargetPercent,
  compactMessages,
  compactionTarget,
  estimateTokens,
  planCompaction,
  shouldCompact,
  transcriptToText,
  type CompactionOptions,
} from "./compaction";

const system: ChatMessage = { role: "system", content: "you are helpful" };
const user = (text: string): ChatMessage => ({ role: "user", content: text });
const assistant = (text: string): ChatMessage => ({ role: "assistant", content: text });
/** The same message, padded out to roughly `tokens` tokens, so a size can be aimed at on purpose. */
const sized = (message: ChatMessage, tokens: number): ChatMessage => ({
  ...message,
  content: `${String(message.content)} ${"x".repeat(tokens * 4)}`,
});
const call = (id: string): ChatMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" } }],
});
const toolResult = (id: string, content: string): ChatMessage => ({ role: "tool", tool_call_id: id, content });

/** A 3,000-token window aiming at 40% of it: a 1,200-token session, 944 of them the tail's. */
const options: CompactionOptions = { contextTokens: 3_000, reserveTokens: 0 };

/** `turns` requests and answers, about `perTurn` tokens between the two. */
function session(turns: number, perTurn = 100): ChatMessage[] {
  const messages: ChatMessage[] = [system];
  for (let index = 1; index <= turns; index++) {
    messages.push(
      sized(user(`request ${index}`), Math.round(perTurn * 0.4)),
      sized(assistant(`answer ${index}`), Math.round(perTurn * 0.6)),
    );
  }
  return messages;
}

/** Alternating requests and answers of one size, so a cut boundary can be counted. */
function ladder(count: number, tokens: number): ChatMessage[] {
  const messages: ChatMessage[] = [system];
  for (let index = 1; index <= count; index++) {
    messages.push(sized(index % 2 === 1 ? user(`m${index}`) : assistant(`m${index}`), tokens));
  }
  return messages;
}

function summarizer(text: string): Provider {
  return {
    async *stream() {
      yield { type: "text", delta: text };
      yield { type: "finish", message: { role: "assistant", content: text }, finishReason: "stop" };
    },
  };
}

/** A `tool` message is only legal directly after the assistant call it answers. */
function assertToolPairing(messages: readonly ChatMessage[]): void {
  let openCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      openCalls = new Set((message.tool_calls ?? []).map((toolCall) => toolCall.id));
    } else if (message.role === "tool") {
      expect(openCalls.has(message.tool_call_id)).toBe(true);
      openCalls.delete(message.tool_call_id);
    } else {
      openCalls.clear();
    }
  }
}

describe("estimateTokens", () => {
  it("approximates four characters per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("returns 0 for something it cannot serialise", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(estimateTokens(circular)).toBe(0);
  });

  it("measures a transcript", () => {
    expect(estimateTokens([user("hello world")])).toBeGreaterThan(0);
  });
});

describe("shouldCompact", () => {
  it("is false while there is room", () => {
    expect(shouldCompact([user("short")], { contextTokens: 10_000, reserveTokens: 1_000 })).toBe(false);
  });

  it("is true once the transcript passes the budget", () => {
    // ~2,500 tokens against a 1,500-token budget (2,000 window − 500 reserve).
    const big = [user("x".repeat(10_000))];

    expect(shouldCompact(big, { contextTokens: 2_000, reserveTokens: 500 })).toBe(true);
  });

  it("is false when the reserve leaves no budget at all", () => {
    expect(shouldCompact([user("x".repeat(4_000))], { contextTokens: 1_000, reserveTokens: 1_000 })).toBe(false);
  });

  it("compacts past compactAt even inside a larger window", () => {
    // ~2,500 tokens: room under the 9,000-token window budget, past a 1,000 cap.
    const big = [user("x".repeat(10_000))];

    expect(shouldCompact(big, { contextTokens: 10_000, reserveTokens: 1_000, compactAt: 1_000 })).toBe(true);
  });

  it("leaves the window deciding when compactAt is absent", () => {
    const big = [user("x".repeat(10_000))];

    expect(shouldCompact(big, { contextTokens: 20_000, reserveTokens: 1_000 })).toBe(false);
  });

  it("ignores a compactAt wider than the window", () => {
    const big = [user("x".repeat(10_000))];

    expect(shouldCompact(big, { contextTokens: 2_000, reserveTokens: 500, compactAt: 100_000 })).toBe(true);
  });
});

describe("the compaction target", () => {
  it("is a share of the window, and 40% by default", () => {
    expect(compactionTarget({ contextTokens: 100_000, reserveTokens: 0 })).toBe(40_000);
    expect(compactionTarget({ contextTokens: 128_000, reserveTokens: 8_000 })).toBe(51_200);
  });

  it("is kept inside the band, whatever it is asked for", () => {
    expect(compactionTarget({ contextTokens: 100_000, reserveTokens: 0, targetPercent: 5 })).toBe(30_000);
    expect(compactionTarget({ contextTokens: 100_000, reserveTokens: 0, targetPercent: 90 })).toBe(50_000);

    expect(clampTargetPercent(0)).toBe(COMPACT_TARGET_BAND[0]);
    expect(clampTargetPercent(Number.NaN)).toBe(40);
    expect(clampTargetPercent(37.6)).toBe(38);
  });

  it("never aims past the window the reserve leaves", () => {
    // A 100K reserve leaves 28K of a 128K window, and a 40% target would not fit.
    expect(compactionTarget({ contextTokens: 128_000, reserveTokens: 100_000 })).toBe(28_000);
  });
});

describe("planCompaction", () => {
  it("keeps the longest tail that still fits the target", () => {
    const messages = session(20);
    const plan = planCompaction(messages, options)!;
    const tailBudget = plan.target - plan.summaryBudget;
    const kept = estimateTokens(messages.slice(plan.cut));

    expect(plan.target).toBe(1_200);
    expect(kept).toBeLessThanOrEqual(tailBudget);
    // And the next turn back would not have fitted: as long a tail as the
    // target allows, rather than as many turns as a count would have guessed.
    expect(estimateTokens(messages.slice(plan.cut - 2))).toBeGreaterThan(tailBudget);
    // Which is more than the six turns the count used to keep.
    expect(messages.slice(plan.cut).filter((message) => message.role === "user").length).toBeGreaterThan(6);
    assertToolPairing(messages.slice(plan.cut));
  });

  it("prefers a cut on a request over an older cut inside a turn", () => {
    // Nineteen messages of one size: the target leaves room for four of them,
    // so the boundary falls on `m16` — an answer — while `m17`, the request
    // after it, fits too. A tail should never open on an answer to a question
    // that has been summarised away.
    const messages = ladder(19, 200);
    const plan = planCompaction(messages, options)!;

    expect(plan.cut).toBe(17);
    expect(messages[plan.cut]?.role).toBe("user");
  });

  it("cuts inside a turn when one enormous turn is all there is", () => {
    // One request, then twelve tool calls and their results: no request cut
    // fits, and a turn count would have refused to compact at all.
    const messages: ChatMessage[] = [system, user("read everything"), assistant("starting")];
    for (let index = 1; index <= 12; index++) {
      messages.push(call(`c${index}`), toolResult(`c${index}`, "z".repeat(1_000)));
    }

    const plan = planCompaction(messages, options)!;

    expect(messages[plan.cut]?.role).toBe("assistant");
    expect(estimateTokens(messages.slice(plan.cut))).toBeLessThanOrEqual(plan.target - plan.summaryBudget);
    assertToolPairing(messages.slice(plan.cut));
  });

  it("moves the cut back rather than keep a tool result without its call", () => {
    // A transcript that should not happen: a result with a request between it
    // and the call behind it. The pairing is a hard API error, so the cut is
    // moved back to the call — or past the whole thing — but never left there.
    const messages: ChatMessage[] = [
      system,
      user("a"),
      call("c1"),
      toolResult("c1", "w".repeat(8_000)),
      user("b"),
      toolResult("c1", "orphan"),
      sized(assistant("last"), 10),
    ];

    const plan = planCompaction(messages, options)!;

    // Four is where an unguarded scan would have cut, opening the tail on it.
    expect(plan.cut).not.toBe(4);
    assertToolPairing(messages.slice(plan.cut));
  });

  it("has nothing to do when the session already fits the target", () => {
    expect(planCompaction([system, user("short"), assistant("and short")], options)).toBeNull();
  });

  it("has nothing to do when there is no turn to cut at", () => {
    expect(planCompaction([system, sized(user("only"), 1_000)], options)).toBeNull();
  });

  it("has nothing to do when the reserve leaves no window", () => {
    expect(planCompaction(session(20), { contextTokens: 1_000, reserveTokens: 1_000 })).toBeNull();
  });
});

describe("compactMessages", () => {
  it("replaces the older turns with the summary and keeps the tail verbatim", async () => {
    const messages = session(20);
    const plan = planCompaction(messages, options)!;
    const result = await compactMessages(summarizer("the summary"), "m", messages, options);

    expect(result).not.toBeNull();
    const compacted = result?.messages ?? [];

    expect(compacted[0]).toEqual(system);
    expect(compacted[1]?.content).toContain(SUMMARY_HEADER);
    expect(compacted[1]?.content).toContain("the summary");
    // The tail is the one the plan chose, message for message.
    expect(compacted.slice(2)).toEqual(messages.slice(plan.cut));
    expect(result?.summarized).toBe(plan.cut - 1);
    expect(result?.target).toBe(plan.target);
  });

  it("leaves the session at its target, summary and all", async () => {
    const messages = session(20);
    const result = await compactMessages(summarizer("brief"), "m", messages, options);

    // The briefing is prose of the length it was asked for, so the session
    // lands inside the target rather than wherever the cut happened to fall.
    expect(estimateTokens(result?.messages ?? [])).toBeLessThanOrEqual(result?.target ?? 0);
  });

  it("asks the summariser for a briefing that fits the room it was given", async () => {
    const prompts: string[] = [];
    const provider: Provider = {
      async *stream(request) {
        prompts.push(String(request.messages[0]?.content ?? ""));
        yield { type: "text", delta: "brief" };
      },
    };
    // A 10,000-token window: a 4,000-token target, a fifth of it the briefing's.
    const wide: CompactionOptions = { contextTokens: 10_000, reserveTokens: 0 };
    const compacted = await compactMessages(provider, "m", session(60), wide);

    expect(compacted?.target).toBe(4_000);
    // A fifth of the target, said out loud: a briefing that runs long is what
    // would push the session back over its target after compacting.
    expect(prompts[0]).toContain("under about 800 tokens");
  });

  it("keeps tool pairing intact when the cut lands next to a tool result", async () => {
    const messages: ChatMessage[] = [
      system,
      user("a"),
      call("c1"),
      toolResult("c1", "one"),
      user("b"),
      call("c2"),
      toolResult("c2", "two"),
      user("c"),
      assistant("last"),
    ];

    const result = await compactMessages(summarizer("s"), "m", messages, { contextTokens: 60, reserveTokens: 0 });

    expect(result).not.toBeNull();
    assertToolPairing(result?.messages ?? []);
  });

  it("returns null when there is nothing safe to cut", async () => {
    expect(await compactMessages(summarizer("s"), "m", [system, sized(user("only"), 400)], options)).toBeNull();
  });

  it("returns null when the model produces no summary", async () => {
    expect(await compactMessages(summarizer("   "), "m", session(20), options)).toBeNull();
  });

  it("propagates a failed summary so the caller can carry on over budget", async () => {
    const broken: Provider = {
      async *stream() {
        throw new Error("summariser down");
      },
    };

    await expect(compactMessages(broken, "m", session(20), options)).rejects.toThrow("summariser down");
  });
});

describe("transcriptToText", () => {
  it("records the tool calls that were made, not just the prose", () => {
    const text = transcriptToText([
      user("read it"),
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }],
      },
      toolResult("c1", "file body"),
    ]);

    expect(text).toContain("read({\"path\":\"a.ts\"})");
    expect(text).toContain("file body");
  });
});
