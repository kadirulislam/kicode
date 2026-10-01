import { describe, expect, it } from "vitest";
import type { ChatMessage, Provider } from "../types";
import {
  SUMMARY_HEADER,
  compactMessages,
  estimateTokens,
  shouldCompact,
  splitIndex,
  transcriptToText,
  type CompactionOptions,
} from "./compaction";

const system: ChatMessage = { role: "system", content: "you are helpful" };
const user = (text: string): ChatMessage => ({ role: "user", content: text });
const assistant = (text: string): ChatMessage => ({ role: "assistant", content: text });

const options: CompactionOptions = { contextTokens: 1_000, reserveTokens: 0, keepRecentTurns: 1 };

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
  const openCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      openCalls.clear();
      for (const call of message.tool_calls ?? []) openCalls.add(call.id);
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
    expect(shouldCompact([user("short")], { contextTokens: 10_000, reserveTokens: 1_000, keepRecentTurns: 3 })).toBe(false);
  });

  it("is true once the transcript passes the budget", () => {
    // ~2,500 tokens against a 1,500-token budget (2,000 window − 500 reserve).
    const big = [user("x".repeat(10_000))];

    expect(shouldCompact(big, { contextTokens: 2_000, reserveTokens: 500, keepRecentTurns: 3 })).toBe(true);
  });

  it("is false when the reserve leaves no budget at all", () => {
    expect(shouldCompact([user("x".repeat(4_000))], { contextTokens: 1_000, reserveTokens: 1_000, keepRecentTurns: 3 })).toBe(false);
  });

  it("compacts past compactAt even inside a larger window", () => {
    // ~2,500 tokens: room under the 9,000-token window budget, past a 1,000 cap.
    const big = [user("x".repeat(10_000))];

    expect(
      shouldCompact(big, { contextTokens: 10_000, reserveTokens: 1_000, keepRecentTurns: 3, compactAt: 1_000 }),
    ).toBe(true);
  });

  it("leaves the window deciding when compactAt is absent", () => {
    const big = [user("x".repeat(10_000))];

    expect(shouldCompact(big, { contextTokens: 20_000, reserveTokens: 1_000, keepRecentTurns: 3 })).toBe(false);
  });

  it("ignores a compactAt wider than the window", () => {
    const big = [user("x".repeat(10_000))];

    expect(
      shouldCompact(big, { contextTokens: 2_000, reserveTokens: 500, keepRecentTurns: 3, compactAt: 100_000 }),
    ).toBe(true);
  });
});

describe("splitIndex", () => {
  const withToolPair: ChatMessage[] = [
    system,
    user("one"),
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "file contents" },
    assistant("done"),
    user("two"),
    assistant("ok"),
  ];

  it("cuts on a user message, so a tool result never loses its call", () => {
    const split = splitIndex(withToolPair, 1) ?? -1;

    expect(split).toBe(5);
    expect(withToolPair[split]?.role).toBe("user");
    assertToolPairing(withToolPair.slice(split));
  });

  it("refuses to cut when every turn is still inside the recent window", () => {
    expect(splitIndex([system, user("one"), assistant("a")], 2)).toBeNull();
    expect(splitIndex([system, user("one"), assistant("a")], 1)).toBeNull();
  });

  it("refuses to cut when there is nothing before the kept window", () => {
    expect(splitIndex([system, user("one")], 0)).toBeNull();
  });
});

describe("compactMessages", () => {
  const transcript: ChatMessage[] = [system, user("first"), assistant("first answer"), user("second"), assistant("second answer")];

  it("replaces the older turns with the summary and keeps the recent ones verbatim", async () => {
    const result = await compactMessages(summarizer("the summary"), "m", transcript, options);

    expect(result).not.toBeNull();
    const compacted = result?.messages ?? [];

    expect(compacted).toHaveLength(4);
    expect(compacted[0]).toEqual(system);
    expect(compacted[1]?.content).toContain(SUMMARY_HEADER);
    expect(compacted[1]?.content).toContain("the summary");
    expect(compacted.at(-2)).toEqual(user("second"));
    expect(compacted.at(-1)).toEqual(assistant("second answer"));
    expect(result?.summarized).toBe(2);
  });

  it("keeps tool pairing intact when the cut lands next to a tool result", async () => {
    const messages: ChatMessage[] = [
      system,
      user("a"),
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "one" },
      user("b"),
      { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c2", content: "two" },
      user("c"),
      assistant("last"),
    ];

    const result = await compactMessages(summarizer("s"), "m", messages, options);

    expect(result).not.toBeNull();
    assertToolPairing(result?.messages ?? []);
  });

  it("returns null when there is nothing safe to cut", async () => {
    expect(await compactMessages(summarizer("s"), "m", [system, user("only")], options)).toBeNull();
  });

  it("returns null when the model produces no summary", async () => {
    expect(await compactMessages(summarizer("   "), "m", transcript, options)).toBeNull();
  });

  it("propagates a failed summary so the caller can carry on over budget", async () => {
    const broken: Provider = {
      async *stream() {
        throw new Error("summariser down");
      },
    };

    await expect(compactMessages(broken, "m", transcript, options)).rejects.toThrow("summariser down");
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
      { role: "tool", tool_call_id: "c1", content: "file body" },
    ]);

    expect(text).toContain("read({\"path\":\"a.ts\"})");
    expect(text).toContain("file body");
  });
});
