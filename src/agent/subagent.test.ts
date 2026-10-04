import { describe, expect, it } from "vitest";
import {
  SubagentRegistry,
  childRunner,
  delegateTool,
  type ChildRunnerOptions,
  type DelegateSettings,
  type SubagentRequest,
  type SubagentResult,
} from "./subagent";
import { SUBAGENT_TOOLS, createDefaultTools } from "./tools";
import { ToolRegistry } from "./tools/types";
import type { Agent, AgentEvent } from "./loop";

const settings = (over: Partial<DelegateSettings> = {}): DelegateSettings => ({
  model: "child-model",
  maxConcurrent: 4,
  maxPerTurn: 8,
  ...over,
});

const context = (): { cwd: string; signal?: AbortSignal } => ({ cwd: process.cwd() });

/** A spawner that answers from a script, so a test can order the children. */
function spawner(
  answer: (request: SubagentRequest) => Promise<SubagentResult> | SubagentResult,
  seen: SubagentRequest[] = [],
) {
  return async (request: SubagentRequest): Promise<SubagentResult> => {
    seen.push(request);
    return answer(request);
  };
}

function ok(goal: string, summary = "found it"): SubagentResult {
  return { id: "", goal, status: "completed", summary, requests: 2 };
}

describe("ToolRegistry.subset", () => {
  it("keeps only the names asked for", () => {
    const names = new ToolRegistry([createDefaultTools().get("read")!, createDefaultTools().get("write")!])
      .subset(["read"])
      .list()
      .map((tool) => tool.name);

    expect(names).toEqual(["read"]);
  });

  it("drops a name it does not have, rather than failing", () => {
    // A tool list that grows or shrinks between versions must not turn a child's
    // toolset into a crash on startup.
    const subset = createDefaultTools().subset(["read", "no-such-tool"]);

    expect(subset.list().map((tool) => tool.name)).toEqual(["read"]);
  });
});

describe("what a child is given", () => {
  it("holds nothing that can change anything", () => {
    // The isolation is the list, not a flag: a child has no `write` to be talked
    // into using, so this test is the mechanism rather than a description of it.
    expect([...SUBAGENT_TOOLS].sort()).toEqual(["glob", "grep", "read", "recall"]);
  });

  it("leaves out the tools that would change the project or ask its owner", () => {
    for (const name of ["write", "edit", "bash", "remember", "ask", "todo", "update_plan"]) {
      expect(SUBAGENT_TOOLS).not.toContain(name);
    }
  });

  it("names every tool that exists in the default set", () => {
    // A renamed tool would otherwise silently drop the child's ability to read,
    // which is the one thing it must be able to do.
    const available = createDefaultTools([], { ask: true }).list().map((tool) => tool.name);

    for (const name of SUBAGENT_TOOLS) expect(available).toContain(name);
  });
});

describe("the delegate tool", () => {
  it("needs something to delegate", async () => {
    const tool = delegateTool({
      spawn: spawner(() => ok("x")),
      registry: new SubagentRegistry(),
      settings: settings(),
      spawnCount: () => 0,
    });

    const result = await tool.run({}, context());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("needs a `goal`");
  });

  it("runs one task and reports what came back", async () => {
    const seen: SubagentRequest[] = [];
    const tool = delegateTool({
      spawn: spawner((request) => ok(request.goal, "it is in loop.ts"), seen),
      registry: new SubagentRegistry(),
      settings: settings(),
      spawnCount: () => 0,
    });

    const result = await tool.run({ goal: "find the loop", context: "src/agent" }, context());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("find the loop");
    expect(result.content).toContain("it is in loop.ts");
    // The context travels, because it is the only thing the child knows.
    expect(seen[0]?.context).toBe("src/agent");
  });

  it("reports a batch in the order it was asked for, not the order it finished", async () => {
    const tool = delegateTool({
      // The first child takes longest, so completion order is the reverse of
      // input order. The parent wrote them in order and reads them in order.
      spawn: spawner(async (request) => {
        await new Promise((done) => setTimeout(done, request.goal === "first" ? 30 : 0));
        return ok(request.goal, `${request.goal} done`);
      }),
      registry: new SubagentRegistry(),
      settings: settings({ maxConcurrent: 4 }),
      spawnCount: () => 0,
    });

    const result = await tool.run(
      { tasks: [{ goal: "first" }, { goal: "second" }, { goal: "third" }] },
      context(),
    );

    const order = ["first", "second", "third"].map((goal) => result.content.indexOf(goal));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("runs a batch in parallel, up to the concurrent cap", async () => {
    let live = 0;
    let peak = 0;
    const tool = delegateTool({
      spawn: spawner(async (request) => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((done) => setTimeout(done, 10));
        live -= 1;
        return ok(request.goal);
      }),
      registry: new SubagentRegistry(),
      settings: settings({ maxConcurrent: 2 }),
      spawnCount: () => 0,
    });

    await tool.run({ tasks: [{ goal: "a" }, { goal: "b" }, { goal: "c" }, { goal: "d" }] }, context());

    // Two at a time: the cap is what keeps a batch from opening six connections
    // and six bills at once.
    expect(peak).toBe(2);
  });

  it("refuses a batch bigger than the turn's remaining budget, rather than cutting it", async () => {
    const seen: SubagentRequest[] = [];
    const tool = delegateTool({
      spawn: spawner((request) => ok(request.goal), seen),
      registry: new SubagentRegistry(),
      settings: settings({ maxPerTurn: 3 }),
      spawnCount: () => 0,
    });

    const result = await tool.run({ tasks: [{ goal: "a" }, { goal: "b" }, { goal: "c" }, { goal: "d" }] }, context());

    // A batch quietly trimmed to three would leave the model believing four
    // tasks are running. Three of them are not.
    expect(result.isError).toBe(true);
    expect(result.content).toContain("4 tasks asked for but only 3");
    expect(seen).toHaveLength(0);
  });

  it("spends the per-turn budget across calls, not per call", async () => {
    let spawned = 0;
    const options = {
      spawn: spawner(() => {
        spawned += 1;
        return ok("x");
      }),
      registry: new SubagentRegistry(),
      settings: settings({ maxPerTurn: 2 }),
      spawnCount: () => spawned,
    };

    await delegateTool(options).run({ goal: "a" }, context());
    const second = await delegateTool(options).run({ goal: "b" }, context());
    const third = await delegateTool(options).run({ goal: "c" }, context());

    expect(second.isError).toBeFalsy();
    expect(third.isError).toBe(true);
    expect(third.content).toContain("already spawned its 2 subagents");
  });

  it("says so when a child dies, and still reports the rest", async () => {
    const tool = delegateTool({
      spawn: spawner((request) => {
        if (request.goal === "doomed") throw new Error("model refused");
        return ok(request.goal, "fine");
      }),
      registry: new SubagentRegistry(),
      settings: settings(),
      spawnCount: () => 0,
    });

    const result = await tool.run({ tasks: [{ goal: "doomed" }, { goal: "survivor" }] }, context());

    // The failure is never swallowed: a child that dies is the one thing the
    // parent must not have to go looking for.
    expect(result.content).toContain("failed: model refused");
    // And one death does not take the batch with it.
    expect(result.content).toContain("fine");
  });

  it("reports a child that stopped as itself, not as a failure", async () => {
    const tool = delegateTool({
      spawn: spawner((request) => ({
        id: "",
        goal: request.goal,
        status: "interrupted",
        summary: "",
        requests: 3,
        error: "stopped with the turn",
      })),
      registry: new SubagentRegistry(),
      settings: settings(),
      spawnCount: () => 0,
    });

    const result = await tool.run({ goal: "long read" }, context());

    expect(result.content).toContain("interrupted: stopped with the turn");
  });

  it("tells the parent what the batch cost, so delegation is not free by surprise", async () => {
    const tool = delegateTool({
      spawn: spawner((request) => ({ ...ok(request.goal), tokens: 1_500 })),
      registry: new SubagentRegistry(),
      settings: settings(),
      spawnCount: () => 0,
    });

    const result = await tool.run({ goal: "read the tree" }, context());

    expect(result.content).toContain("2 requests, 1500 tokens");
  });

  it("truncates a child's own enormous report, and says that it did", async () => {
    const tool = delegateTool({
      spawn: spawner((request) => ok(request.goal, "x".repeat(50_000))),
      registry: new SubagentRegistry(),
      settings: settings(),
      spawnCount: () => 0,
    });

    const result = await tool.run({ goal: "read everything" }, context());

    expect(result.content.length).toBeLessThan(10_000);
    expect(result.content).toContain("truncated");
  });

  it("hands the child the turn's cancellation signal", async () => {
    const seen: SubagentRequest[] = [];
    const tool = delegateTool({
      spawn: spawner((request) => ok(request.goal), seen),
      registry: new SubagentRegistry(),
      settings: settings(),
      spawnCount: () => 0,
    });
    const controller = new AbortController();

    await tool.run({ goal: "a" }, { cwd: process.cwd(), signal: controller.signal });

    expect(seen[0]?.signal).toBe(controller.signal);
  });
});

describe("SubagentRegistry", () => {
  it("reports a child as running, then as settled", () => {
    const registry = new SubagentRegistry();

    registry.start("sa-1", "find the bug", "child-model");
    expect(registry.snapshot()).toEqual([
      { id: "sa-1", goal: "find the bug", model: "child-model", status: "running", ms: 0, toolCalls: 0 },
    ]);

    registry.progress("sa-1", 3, 1_200);
    registry.finish("sa-1", { status: "completed", summary: "line 40" });

    expect(registry.snapshot()[0]).toMatchObject({
      status: "completed",
      toolCalls: 3,
      ms: 1_200,
      summary: "line 40",
    });
  });

  it("puts the running children first", () => {
    // The panel's top row is the work in flight; a finished child belongs under
    // whatever is still going.
    const registry = new SubagentRegistry();
    registry.start("sa-1", "done", "m");
    registry.finish("sa-1", { status: "completed" });
    registry.start("sa-2", "going", "m");

    expect(registry.snapshot().map((child) => child.id)).toEqual(["sa-2", "sa-1"]);
  });

  it("flattens a goal to one line, so a panel row cannot grow three", () => {
    const registry = new SubagentRegistry();

    registry.start("sa-1", "line one\nline two\nline three", "m");

    const goal = registry.snapshot()[0]!.goal;
    expect(goal).toBe("line one line two line three");
    expect(goal).not.toContain("\n");
  });

  it("clips a goal long enough to crowd out the model and the count", () => {
    const registry = new SubagentRegistry();

    registry.start("sa-1", "x".repeat(400), "m");

    const goal = registry.snapshot()[0]!.goal;
    expect(goal.length).toBeLessThanOrEqual(120);
    expect(goal.endsWith("…")).toBe(true);
  });

  it("ignores progress for a child it never started", () => {
    const registry = new SubagentRegistry();

    // The loop can report against a tool that has already been torn down; a
    // throw here would take down the turn for a bookkeeping detail.
    expect(() => registry.progress("sa-ghost", 1, 1)).not.toThrow();
    expect(registry.snapshot()).toEqual([]);
  });

  it("keeps a bounded number of children, so a long session cannot grow it without limit", () => {
    const registry = new SubagentRegistry();
    for (let at = 0; at < 40; at += 1) {
      registry.start(`sa-${at}`, `task ${at}`, "m");
      registry.finish(`sa-${at}`, { status: "completed" });
    }

    expect(registry.snapshot().length).toBeLessThanOrEqual(12);
    // The newest survive: the roster is for what just happened.
    expect(registry.snapshot().map((child) => child.id)).toContain("sa-39");
  });

  it("never drops a child that is still running", () => {
    const registry = new SubagentRegistry();
    for (let at = 0; at < 30; at += 1) registry.start(`sa-${at}`, `task ${at}`, "m");

    // In flight is exactly what the dock exists to show, so the bound yields
    // rather than taking one out from under the user.
    expect(registry.snapshot()).toHaveLength(30);
  });

  it("keeps a batch whole even when the batch is larger than the bound", () => {
    const registry = new SubagentRegistry();
    registry.finish("sa-old", { status: "completed" });
    for (let at = 0; at < 20; at += 1) {
      registry.start(`sa-${at}`, `task ${at}`, "m");
      registry.finish(`sa-${at}`, { status: "completed" });
    }

    const ids = new Set(registry.snapshot().map((child) => child.id));
    // The last twelve are this batch; truncating it mid-flight would report a
    // delegation that lost children it never lost.
    for (let at = 8; at < 20; at += 1) expect(ids.has(`sa-${at}`)).toBe(true);
  });
});

describe("the runner", () => {
  /**
   * A child that answers a fixed script, shaped as an `Agent` because that is
   * what the runner drives.
   */
  function scripted(events: readonly AgentEvent[]): () => Agent {
    return () =>
      ({
        async *send(): AsyncGenerator<AgentEvent> {
          for (const event of events) yield event;
        },
      }) as unknown as Agent;
  }

  const options = (over: Partial<ChildRunnerOptions> = {}): ChildRunnerOptions => ({
    create: scripted([{ type: "text", delta: "the answer" }, { type: "done", reason: "complete" }]),
    registry: new SubagentRegistry(),
    model: "child-model",
    maxIterations: 20,
    limits: { staleMs: 60_000, staleToolMs: 120_000 },
    ...over,
  });

  const request = { id: "sa-1", goal: "find it", signal: new AbortController().signal };

  it("runs without a screen, which is what the one-shot path gives it", async () => {
    // `kicode -p "…"` has no panel to repaint. The runner must not require an
    // `onProgress` hook or the one-shot path would need a fake one to exist.
    const result = await childRunner(options())(request);

    expect(result).toMatchObject({ goal: "find it", status: "completed", summary: "the answer" });
  });

  it("counts the child's requests", async () => {
    const result = await childRunner(
      options({
        create: scripted([
          { type: "tool-start", id: "a", name: "read", args: {} },
          { type: "tool-result", id: "a", name: "read", content: "x", isError: false },
          { type: "tool-start", id: "b", name: "glob", args: {} },
          { type: "tool-result", id: "b", name: "glob", content: "x", isError: false },
          { type: "text", delta: "found" },
          { type: "done", reason: "complete" },
        ]),
      }),
    )(request);

    expect(result.requests).toBe(2);
  });

  it("carries the child's own token count back, because it is the user's money", async () => {
    const result = await childRunner(
      options({
        create: scripted([
          { type: "text", delta: "found" },
          { type: "done", reason: "complete", promptTokens: 1_200, completionTokens: 300 },
        ]),
      }),
    )(request);

    expect(result.tokens).toBe(1_500);
  });

  it("leaves the token count off rather than claiming zero was spent", async () => {
    // A gateway that reports no usage is not the same as a child that spent
    // nothing, and `0` would read as the second.
    const result = await childRunner(options())(request);

    expect(result).not.toHaveProperty("tokens");
  });

  it("records progress in the registry as it goes", async () => {
    const registry = new SubagentRegistry();
    registry.start("sa-1", "find it", "child-model");
    const seen: number[] = [];

    await childRunner(
      options({
        registry,
        onProgress: () => seen.push(registry.snapshot()[0]?.toolCalls ?? -1),
        create: scripted([
          { type: "tool-start", id: "a", name: "read", args: {} },
          { type: "tool-result", id: "a", name: "read", content: "x", isError: false },
          // A hundred streamed words must not mean a hundred repaints.
          ...Array.from({ length: 100 }, () => ({ type: "text" as const, delta: "w" })),
          { type: "done", reason: "complete" },
        ]),
      }),
    )(request);

    // The hook fires on movement, not on text — the panel shows neither the text
    // nor a number that did not change.
    expect(seen).toEqual([1]);
  });

  it("gives the child its own signal, not the caller's", async () => {
    let childSignal: AbortSignal | undefined;
    const caller = new AbortController();

    await childRunner(
      options({
        create: (input) => {
          childSignal = input.signal;
          return scripted([{ type: "text", delta: "x" }, { type: "done", reason: "complete" }])();
        },
      }),
    )({ id: "sa-1", goal: "g", signal: caller.signal });

    // Separate, or a child abandoned for going quiet would take the whole turn
    // with it — and one that outlives its staleness limit could never be stopped
    // at all.
    expect(childSignal).toBeDefined();
    expect(childSignal).not.toBe(caller.signal);
    expect(childSignal!.aborted).toBe(false);
  });

  it("gives an already-stopped caller an already-stopped child", async () => {
    const caller = new AbortController();
    caller.abort();
    let childSignal: AbortSignal | undefined;

    await childRunner(
      options({
        create: (input) => {
          childSignal = input.signal;
          return scripted([{ type: "text", delta: "x" }, { type: "done", reason: "complete" }])();
        },
      }),
    )({ id: "sa-1", goal: "g", signal: caller.signal });

    expect(childSignal!.aborted).toBe(true);
  });
});

describe("the roster a call hands over", () => {
  it("covers that call's children and no others", async () => {
    const registry = new SubagentRegistry();
    const tool = delegateTool({
      spawn: spawner((request) => ok(request.goal)),
      registry,
      settings: settings(),
      spawnCount: () => 0,
    });

    await tool.run({ tasks: [{ goal: "a" }, { goal: "b" }] }, context());

    const first = tool.subagents!();
    expect(first).toHaveLength(2);
    expect(first.map((child) => child.goal)).toEqual(["a", "b"]);

    // A second delegation must report its own two, not the session's four: a
    // transcript row saying "delegated 4 tasks" for two calls of two is worse
    // than no row at all.
    await tool.run({ goal: "c" }, context());
    const second = tool.subagents!();
    expect(second).toHaveLength(1);
    expect(second[0]?.goal).toBe("c");
    // …while the registry still holds the whole session, for the dock.
    expect(registry.snapshot()).toHaveLength(3);
  });
});