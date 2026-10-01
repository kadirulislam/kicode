import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../agent/loop";
import { defaultViewSettings } from "./settings";
import { buildStyles, darkTheme } from "./theme";
import {
  applyEvent,
  entriesToText,
  entrySpans,
  formatElapsed,
  lastThoughtFragment,
  summarizeArgs,
  type Entry,
  type EventTiming,
} from "./transcript";

const styles = buildStyles(darkTheme);
const view = defaultViewSettings();
const text = (entries: readonly Entry[]): string =>
  entries.flatMap((entry) => entrySpans(entry, styles, view).map((item) => item.text)).join("");

function feed(events: readonly AgentEvent[], timing: Partial<EventTiming> = {}): Entry[] {
  const entries: Entry[] = [];
  for (const event of events) applyEvent(entries, event, { at: 0, turn: null, ...timing });
  return entries;
}

const turn = { at: 0, turn: { startedAt: 0, mode: "Build", model: "m", tps: true } };

describe("the model's reasoning", () => {
  it("collects every delta into one entry, not one entry per token", () => {
    const entries = feed([
      { type: "reasoning", delta: "The file " },
      { type: "reasoning", delta: "is missing a default." },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "thought", text: "The file is missing a default." });
  });

  it("measures how long it took, and stops the clock at the answer", () => {
    const entries: Entry[] = [];
    applyEvent(entries, { type: "reasoning", delta: "thinking" }, { at: 1000, turn: null });
    applyEvent(entries, { type: "reasoning", delta: " more" }, { at: 1900, turn: null });
    applyEvent(entries, { type: "text", delta: "answer" }, { at: 2100, turn: null });

    expect(entries[0]).toMatchObject({ kind: "thought", ms: 1100, open: false });
    // The answer is its own entry: reasoning is not part of what was said.
    expect(entries[1]).toEqual({ kind: "assistant", text: "answer" });
  });

  it("closes the reasoning when the turn ends without an answer", () => {
    const entries = feed([{ type: "reasoning", delta: "hmm" }, { type: "done", reason: "complete" }], turn);
    expect(entries[0]).toMatchObject({ kind: "thought", ms: 0, open: false });
  });

  it("is kept out of the transcript that is copied or exported", () => {
    const entries = feed([
      { type: "reasoning", delta: "scratchpad" },
      { type: "text", delta: "answer" },
      { type: "done", reason: "complete", ms: 100, model: "m" },
    ], turn);

    const copied = entriesToText(entries);
    expect(copied).toContain("answer");
    expect(copied).not.toContain("scratchpad");
    expect(copied).not.toContain("Build ·");
  });

  it("ticks one live line while running, instead of the stream", () => {
    const open: Entry = { kind: "thought", text: "First I read the config. Now checking the schema.", ms: 0, open: true, since: 0 };
    const rendered = text([open]);

    expect(rendered).toContain("thinking");
    // The newest sentence is what it is doing now…
    expect(rendered).toContain("Now checking the schema.");
    // …and the older ones are not on screen.
    expect(rendered).not.toContain("First I read the config");
  });

  it("shows the full stream only at verbosity high", () => {
    const open: Entry = { kind: "thought", text: "one. two.", ms: 0, open: true, since: 0 };
    const high = { ...view, verbosity: "high" as const };
    const spans = entrySpans(open, styles, high).map((item) => item.text).join("");

    expect(spans).toContain("one.");
    expect(spans).toContain("two.");
  });

  it("collapses to the elapsed time once the answer starts", () => {
    const closed: Entry = { kind: "thought", text: "done thinking", ms: 4200, open: false, since: 0 };
    const rendered = text([closed]);

    expect(rendered).toContain("Thought: 4.2s");
    expect(rendered).not.toContain("thinking ");
  });
});

describe("the router's own lines", () => {
  it("says when the answer moved to another route", () => {
    const entries = feed([{ type: "route", from: "a", to: "b", reason: "rate-limited (HTTP 429)" }]);
    expect(text(entries)).toContain("switched to b");
    expect(text(entries)).toContain("rate-limited");
  });

  it("leaves a rate-limit pause to the busy row rather than the transcript", () => {
    // A wait is seconds, not history: an entry per pause would bury the
    // conversation in lines about the weather at the gateway.
    const entries = feed([{ type: "route-wait", ms: 5_000, from: "a", reason: "rate-limited (HTTP 429)" }]);
    expect(entries).toEqual([]);
  });
});

describe("attached documents", () => {
  it("marks a request with the files it carried", () => {
    const entries: Entry[] = [{ kind: "user", text: "summarise this", docs: ["notes.md", "spec.txt"] }];
    const spans = entrySpans(entries[0]!, styles, view).map((item) => item.text).join("");
    expect(spans).toContain("[notes.md]");
    expect(spans).toContain("[spec.txt]");
    expect(spans).toContain("summarise this");
  });
});

describe("lastThoughtFragment", () => {
  it("returns the newest sentence", () => {
    expect(lastThoughtFragment("Read the file. Found the bug. Fixing it now.")).toBe("Fixing it now.");
  });

  it("caps a long clause, dropping the partial word at the cap", () => {
    const fragment = lastThoughtFragment(`${"word ".repeat(60)}end.`);

    expect(fragment.length).toBeLessThanOrEqual(96);
    expect(fragment.endsWith("end.")).toBe(true);
  });

  it("flattens newlines into one line", () => {
    expect(lastThoughtFragment("step one\nstep two")).toBe("step one step two");
  });
});

describe("the live todo card", () => {
  const todo = (content: string): AgentEvent => ({ type: "tool-result", id: "todo", name: "todo", content, isError: false });

  it("rewrites one card in place instead of logging every update", () => {
    const entries = feed([
      todo("● Todos (0/2)\n\n├── ◐ First\n└── ○ Second"),
      { type: "text", delta: "working" },
      todo("● Todos (1/2)\n\n├── ✓ First\n└── ◐ Second"),
    ]);

    const cards = entries.filter((entry) => entry.kind === "result" && entry.name === "todo");
    expect(cards).toHaveLength(1);
    // The one card carries the newest state, and it sits at the end — where
    // the work is — rather than frozen where the list was first written.
    expect(entries.at(-1)).toMatchObject({
      kind: "result",
      name: "todo",
      content: expect.stringContaining("✓ First"),
    });
  });

  it("leaves every other tool's output in the log", () => {
    const entries = feed([
      { type: "tool-result", id: "r1", name: "read", content: "one", isError: false },
      { type: "tool-result", id: "r2", name: "read", content: "two", isError: false },
    ]);

    expect(entries.filter((entry) => entry.kind === "result")).toHaveLength(2);
  });
});

describe("result lines", () => {
  const result = (content: string): Entry => ({ kind: "result", name: "read", content, isError: false });

  it("summarises a long result to one line at medium verbosity", () => {
    const rendered = text([result("line one\nline two\nline three\nline four\nline five")]);

    expect(rendered).toContain("line one");
    expect(rendered).toContain("5 lines");
    expect(rendered).not.toContain("line three");
  });

  it("keeps the whole result at high verbosity", () => {
    const high = { ...view, verbosity: "high" as const };
    const rendered = entrySpans(result("a\nb\nc\nd\ne\nf"), styles, high).map((item) => item.text).join("");

    expect(rendered).toContain("a\nb\nc");
  });
});

describe("the line under an answer", () => {
  const answered: AgentEvent[] = [
    { type: "text", delta: "done" },
    { type: "done", reason: "complete", ms: 3900, completionTokens: 69, model: "glm-4.7-flash" },
  ];

  it("names the mode, the model, the time and the rate", () => {
    expect(feed(answered, turn).at(-1)).toEqual({
      kind: "meta",
      text: "Build · glm-4.7-flash · 3.9s · 17.7 tok/s",
    });
  });

  it("leaves out the rate when the endpoint reported no usage", () => {
    const entries = feed([
      { type: "text", delta: "done" },
      { type: "done", reason: "complete", ms: 2100, model: "m" },
    ], turn);

    expect(entries.at(-1)).toEqual({ kind: "meta", text: "Build · m · 2.1s" });
  });

  it("says nothing at all when the setting is off", () => {
    const off = { at: 0, turn: { startedAt: 0, mode: "Build", model: "m", tps: false } };
    expect(feed(answered, off).some((entry) => entry.kind === "meta")).toBe(false);
  });

  it("says what a compaction aimed at, not only how far it fell", () => {
    const entries = feed([{ type: "compacted", before: 108_400, after: 43_100, summarized: 12, target: 51_200 }]);

    expect(entries.at(-1)).toEqual({
      kind: "note",
      text: "compacted 12 earlier messages · ~108400 → ~43100 tokens (target ~51200)",
      tone: "dim",
    });
  });

  it("does not repeat the budget note it comes after", () => {
    const entries = feed([
      { type: "budget", spent: 10, limit: 10 },
      { type: "done", reason: "budget", ms: 100, model: "m" },
    ], turn);

    expect(entries.some((entry) => entry.kind === "meta")).toBe(false);
    expect(entries.at(-1)).toMatchObject({ kind: "note", tone: "warn" });
  });

  it("uses the turn's model when the event does not name one", () => {
    const entries = feed([{ type: "done", reason: "complete", ms: 1000 }], turn);
    expect(entries.at(-1)).toEqual({ kind: "meta", text: "Build · m · 1.0s" });
  });
});

describe("summarizing tool arguments", () => {
  const askArgs = {
    questions: [
      {
        header: "Topic",
        question: "What do you want me to help you with right now?",
        options: [{ label: "kicode project", description: "Work inside the terminal AI assistant." }],
      },
      { header: "Project", question: "Which codebase?", options: [] },
      { header: "Scope", question: "How deep?", options: [] },
    ],
  };

  it("shows ask as a question count, not a JSON wall", () => {
    const summary = summarizeArgs(askArgs, "ask");

    expect(summary).toContain("3 questions");
    expect(summary).toContain("What do you want me to help you with right now?");
    expect(summary).not.toContain("header");
    expect(summary).not.toContain("options");
    expect(summary).not.toContain("{");
  });

  it("still summarizes other tools argument by argument", () => {
    expect(summarizeArgs({ file_path: "src/app.ts", mode: "edit" }, "edit")).toBe("file_path: src/app.ts, mode: edit");
  });

  it("caps every value so one long argument cannot flood the line", () => {
    const summary = summarizeArgs({ content: "x".repeat(300) }, "write");

    expect(summary.length).toBeLessThan(120);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("handles a string payload and empty objects plainly", () => {
    expect(summarizeArgs("just a command", "bash")).toBe("just a command");
    expect(summarizeArgs({}, "read")).toBe("");
    expect(summarizeArgs(null)).toBe("");
  });
});

describe("formatting an elapsed time", () => {
  it("picks a unit that fits the length", () => {
    expect(formatElapsed(700)).toBe("700ms");
    expect(formatElapsed(3900)).toBe("3.9s");
    expect(formatElapsed(61_000)).toBe("1m 01s");
    expect(formatElapsed(3_630_000)).toBe("60m 30s");
  });
});

describe("what the view settings change", () => {
  const result: Entry = { kind: "result", name: "read", content: "one\ntwo\nthree\nfour", isError: false };
  /** One entry's spans, in the plain text a person would actually read. */
  const render = (entry: Entry, over: Partial<typeof view> = {}): string =>
    entrySpans(entry, styles, { ...view, ...over })
      .map((item) => item.text)
      .join("");

  it("shows more of a tool's output as verbosity rises", () => {
    expect(render(result, { verbosity: "low" })).not.toContain("three");
    expect(render(result, { verbosity: "high" })).toContain("four");
  });

  it("drops a thought entirely when thinking is hidden", () => {
    const thought: Entry = { kind: "thought", text: "hmm", ms: 500, open: false, since: 0 };
    expect(entrySpans(thought, styles, { ...view, thinking: "hide" })).toEqual([]);
    expect(render(thought)).toContain("Thought: 500ms");
  });

  it("prints an answer as typed when markdown is raw", () => {
    const answer: Entry = { kind: "assistant", text: "a **bold** word" };
    expect(render(answer)).not.toContain("**");
    expect(render(answer, { markdown: "raw" })).toContain("**bold**");
  });

  it("leaves the picture marker off a request when asked", () => {
    const request: Entry = { kind: "user", text: "look", images: 2 };
    expect(render(request)).toContain("[2 images]");
    expect(render(request, { transcriptImages: "off" })).not.toContain("images");
  });

  it("draws a note in the tone it was given, and a meta line without brackets", () => {
    expect(render({ kind: "note", text: "denied", tone: "warn" })).toContain("[denied]");
    expect(render({ kind: "meta", text: "Build · m · 1.0s" })).toContain("Build · m · 1.0s");
  });

  it("folds a repeated note into one row that admits the count", () => {
    expect(render({ kind: "note", text: "Provider rate-limited the request", tone: "error" })).toContain(
      "[Provider rate-limited the request]",
    );
    expect(render({ kind: "note", text: "Provider rate-limited the request", tone: "error", count: 7 })).toContain(
      "[Provider rate-limited the request ×7]",
    );
  });
});
