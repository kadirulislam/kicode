import { describe, expect, it } from "vitest";
import {
  SUBAGENT_SYSTEM_PROMPT,
  SubagentRegistry,
  childRunner,
  delegateTool,
  DELEGATION_PROMPT,
  EMPTY_REPORT,
  namedSubagentPrompt,
  type ChildRunnerOptions,
  type DelegateSettings,
  type SubagentRequest,
  type SubagentResult,
} from "./subagent";
import { SUBAGENT_TOOLS, createDefaultTools } from "./tools";
import { DEFAULT_SYSTEM_PROMPT } from "./loop";
import { ToolRegistry } from "./tools/types";
import type { AgentProfile } from "../agents";
import type { Agent, AgentEvent } from "./loop";
import { PERMISSION_LABELS, PERMISSION_MODES, permissionAllows } from "./loop";

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

  it("has a prompt that matches the tool list it is actually given", () => {
    // The prompt claimed the child could "run commands that only read" while it
    // is never given `bash` — so a child followed the instruction, called a tool
    // that did not exist, and spent a turn on the answer "unknown tool". What
    // the prompt may promise is exactly what the toolset contains.
    const capabilities: Record<string, RegExp> = {
      read: /\bread files\b/i,
      glob: /\blist them\b/i,
      grep: /\bsearch them\b/i,
    };

    for (const [name, promised] of Object.entries(capabilities)) {
      expect(SUBAGENT_TOOLS).toContain(name);
      expect(SUBAGENT_SYSTEM_PROMPT).toMatch(promised);
    }
    // And it must not *grant* anything the toolset took away. The `\b` after
    // `can` matters: without it the pattern matches inside "You **can**not",
    // which is the opposite of a promise.
    for (const gone of ["bash", "write", "edit"]) {
      expect(SUBAGENT_TOOLS).not.toContain(gone);
    }
    expect(SUBAGENT_SYSTEM_PROMPT).not.toMatch(/you can\b[^.]*\b(run|execute|change|write|edit)\b/i);
    expect(SUBAGENT_SYSTEM_PROMPT).toMatch(/you cannot run commands/i);
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

  /**
 * A request with nothing named and nothing resolved, which is the generic case:
 * the tool fills these in from the session's own delegation pin.
 */
const request = (
  over: Partial<SubagentRequest> = {},
): SubagentRequest => ({
  id: "sa-1",
  goal: "find it",
  signal: new AbortController().signal,
  model: "child-model",
  tools: ["read"],
  instructions: "",
  ...over,
});

  it("runs without a screen, which is what the one-shot path gives it", async () => {
    // `kicode -p "…"` has no panel to repaint. The runner must not require an
    // `onProgress` hook or the one-shot path would need a fake one to exist.
    const result = await childRunner(options())(request());

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
    )(request());

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
    )(request());

    expect(result.tokens).toBe(1_500);
  });

  it("leaves the token count off rather than claiming zero was spent", async () => {
    // A gateway that reports no usage is not the same as a child that spent
    // nothing, and `0` would read as the second.
    const result = await childRunner(options())(request());

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
    )(request());

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
    )({ id: "sa-1", goal: "g", signal: caller.signal, model: "", tools: [], instructions: "" });

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
    )({ id: "sa-1", goal: "g", signal: caller.signal, model: "", tools: [], instructions: "" });

    expect(childSignal!.aborted).toBe(true);
  });
});

describe("named agents", () => {
  const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
    name: "cody-git",
    description: "GitHub and git work",
    instructions: "Focus on branches, commits and PRs.",
    model: "",
    permissions: "read",
    scope: "global",
    file: "agents.json",
    ...over,
  });

  const tool = (profiles: AgentProfile[], seen: SubagentRequest[] = []) =>
    delegateTool({
      spawn: spawner((request) => ok(request.goal), seen),
      registry: new SubagentRegistry(),
      settings: settings(),
      spawnCount: () => 0,
      profiles,
    });

  it("tells the model what the named agents are for", () => {
    // The description is the only place a model learns `cody-git` exists — the
    // system prompt says it too, but a model that never reads the roster still
    // has to find the names here.
    const described = tool([profile()]).description;

    expect(described).toContain("cody-git");
    expect(described).toContain("GitHub and git work");
  });

  it("names each agent's skills in the tool description too", () => {
    // Both places the model can look, because a model that reads one and not the
    // other must still find the capability. The skill list is what makes the
    // choice — this is where a session decides `cody-git` fits.
    const described = tool([
      profile({
        skills: [
          { name: "pr-review", description: "Review a pull request diff", file: "/a/pr-review.md" },
        ],
      }),
    ]).description;

    expect(described).toContain("pr-review");
    expect(described).toContain("Review a pull request diff");
  });

  it("hands a granted agent the github tool, and an ungranted one nothing", async () => {
    const granted: SubagentRequest[] = [];
    await tool([profile({ github: true })], granted).run(
      { goal: "audit my repos", agent: "cody-git" },
      { signal: new AbortController().signal } as never,
    );

    const plain: SubagentRequest[] = [];
    await tool([profile()], plain).run(
      { goal: "audit my repos", agent: "cody-git" },
      { signal: new AbortController().signal } as never,
    );

    // Resolved once, here, and handed to the builder — the grant is read in exactly
    // one place, so there is no second reading that could disagree.
    expect(granted[0]?.tools).toContain("github");
    expect(plain[0]?.tools).not.toContain("github");
    // And never a shell, either way.
    for (const request of [...granted, ...plain]) {
      expect(request.tools).not.toContain("bash");
    }
  });

  it("points the child at its own skill files, by path", async () => {
    const seen: SubagentRequest[] = [];
    const runner = tool([profile({ skills: [{ name: "pr-review", description: "", file: "/s/pr-review.md" }] })], seen);

    await runner.run({ goal: "review PR 12", agent: "cody-git" }, { signal: new AbortController().signal } as never);

    // The roster names the skills so the parent can route; this names the paths
    // so the child can open one. A child told a skill exists but not where would
    // have to guess a path and grep — burning the turns delegation exists to save.
    expect(seen[0]?.instructions).toContain("/s/pr-review.md");
    expect(seen[0]?.instructions).toContain("before you start");
  });

  it("says nothing about skills for an agent that has none", async () => {
    const seen: SubagentRequest[] = [];
    const runner = tool([profile()], seen);

    await runner.run({ goal: "look around", agent: "cody-git" }, { signal: new AbortController().signal } as never);

    // A line about skills on an agent with none reads as a folder that failed to
    // load, and invites the child to go looking for files that are not there.
    expect(seen[0]?.instructions).not.toContain("skills are on disk");
  });

  it("says to prefer a named agent over doing the work itself", () => {
    // A list of names with no steering is a menu the model may never order from.
    expect(tool([profile()]).description).toContain("prefer one over doing the work yourself");
  });

  it("says not to check whether one exists, or to ask whether to", () => {
    const described = tool([profile()]).description;

    expect(described).toContain("Do not check whether it exists");
    expect(described).toContain("do not ask whether to");
  });

  it("offers the names as an enum, so a model cannot invent one", () => {
    const parameters = tool([profile(), profile({ name: "cody-frontend" })]).parameters as {
      properties: { agent?: { enum: string[] } };
    };

    expect(parameters.properties.agent?.enum).toEqual(["cody-git", "cody-frontend"]);
  });

  it("says nothing about `agent` when there are none", () => {
    const parameters = tool([]).parameters as { properties: Record<string, unknown> };

    expect(parameters.properties).not.toHaveProperty("agent");
    expect(tool([]).description).not.toContain("Set `agent`");
  });

  it("runs a child under the profile it was given", async () => {
    const seen: SubagentRequest[] = [];

    await tool([profile()], seen).run({ goal: "check the branch", agent: "cody-git" }, context());

    console.log("RESULT:", JSON.stringify(await tool([profile()], seen).run({ goal: "x", agent: "cody-git" }, context()), null, 1), "SEEN:", seen.length);
    expect(seen[0]?.instructions).toContain("branches, commits and PRs");
  });

  it("names the agent in the report, so a batch is attributable", async () => {
    const result = await tool([profile()]).run({ goal: "check the branch", agent: "cody-git" }, context());

    expect(result.content).toContain("TASK 1/1 [cody-git]: check the branch");
  });

  it("refuses an agent that does not exist, and lists the ones that do", async () => {
    const seen: SubagentRequest[] = [];

    // Falling back to a general-purpose child would be a substitution the model
    // never asked for and would not know about — so it would report a
    // general-purpose result as the specialist it never ran.
    const result = await tool([profile()], seen).run({ goal: "check", agent: "cody-gitt" }, context());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('no agent named "cody-gitt"');
    expect(result.content).toContain("cody-git");
    expect(seen).toHaveLength(0);
  });

  it("refuses the whole batch when one task names an agent that does not exist", async () => {
    const seen: SubagentRequest[] = [];

    const result = await tool([profile()], seen).run(
      { tasks: [{ goal: "ok", agent: "cody-git" }, { goal: "typo", agent: "nope" }] },
      context(),
    );

    // Half a batch, where the other half silently lost its specialisation, is
    // worse than none.
    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("says there are none when none are defined, rather than only the error", async () => {
    const result = await tool([]).run({ goal: "check", agent: "cody-git" }, context());

    expect(result.content).toContain("no agents are defined");
  });

  it("lets a batch use a different agent per task", async () => {
    const seen: SubagentRequest[] = [];

    await tool([profile(), profile({ name: "cody-frontend" })], seen).run(
      { tasks: [{ goal: "a", agent: "cody-git" }, { goal: "b", agent: "cody-frontend" }] },
      context(),
    );

    expect(seen.map((request) => request.agent?.name)).toEqual(["cody-git", "cody-frontend"]);
  });

  it("gives a read-only agent no way to write", async () => {
    const seen: SubagentRequest[] = [];

    await tool([profile()], seen).run({ goal: "audit", agent: "cody-git" }, context());

    expect(seen[0]?.tools).toEqual(["read", "glob", "grep", "recall"]);
  });

  it("gives a write agent edit, and never a shell", async () => {
    const seen: SubagentRequest[] = [];

    await tool([profile({ permissions: "write" })], seen).run({ goal: "fix", agent: "cody-git" }, context());

    expect(seen[0]?.tools).toContain("write");
    expect(seen[0]?.tools).toContain("edit");
    // A child has no approval channel, so a shell would mean arbitrary code
    // running unsupervised — which is why it is not grantable at any level.
    expect(seen[0]?.tools).not.toContain("bash");
  });

  it("uses the profile's own model over the session's pin", async () => {
    const seen: SubagentRequest[] = [];

    await tool([profile({ model: "flash" })], seen).run({ goal: "a", agent: "cody-git" }, context());

    expect(seen[0]?.model).toBe("flash");
  });

  it("falls back to the session's pin when the profile names no model", async () => {
    const seen: SubagentRequest[] = [];

    await tool([profile({ model: "" })], seen).run({ goal: "a", agent: "cody-git" }, context());

    expect(seen[0]?.model).toBe("child-model");
  });

  it("accepts the name whatever case the model used", async () => {
    const seen: SubagentRequest[] = [];

    await tool([profile()], seen).run({ goal: "a", agent: "Cody-Git" }, context());

    expect(seen[0]?.agent?.name).toBe("cody-git");
  });

  it("runs the general-purpose child when no agent is named", async () => {
    const seen: SubagentRequest[] = [];

    await tool([profile()], seen).run({ goal: "just look" }, context());

    expect(seen[0]?.agent).toBeUndefined();
    expect(seen[0]?.tools).toEqual(["read", "glob", "grep", "recall"]);
  });

  it("refuses an `agent` that is not a name at all", async () => {
    const result = await tool([profile()]).run({ goal: "a", agent: 7 as unknown as string }, context());

    expect(result.isError).toBe(true);
  });
});

describe("the roster in the system prompt", () => {
  const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
    name: "cody-git",
    description: "GitHub and git work",
    instructions: "",
    model: "",
    permissions: "read",
    scope: "global",
    file: "",
    ...over,
  });

  it("says nothing at all when there are none", () => {
    // A session with no subagents should not be told the possibility exists.
    expect(namedSubagentPrompt([])).toBeNull();
  });

  it("names each one with what it is for and what it may do", () => {
    const prompt = namedSubagentPrompt([
      profile({ name: "cody-git", description: "GitHub work", permissions: "write" }),
      profile({ name: "cody-ui", description: "The renderer", permissions: "read" }),
    ]);

    expect(prompt).toContain("cody-git — GitHub work");
    expect(prompt).toContain("cody-ui — The renderer");
    expect(prompt).toContain("can: read files, search them, and edit files");
    expect(prompt).toContain("can: read files, search them (cannot edit)");
  });

  it("says a child cannot run commands, because the model cannot know that", () => {
    // The observed failure: `cody-git` was handed "audit this GitHub account",
    // which needs `gh`. No child has a shell, so it had nothing to work with and
    // came back empty. A limit the parent cannot see is a trap, not a policy.
    const prompt = namedSubagentPrompt([profile()]);

    expect(prompt).toContain("cannot: run commands");
    expect(prompt).toContain("cannot run commands");
    expect(prompt).toMatch(/needs one.*run the command yourself/s);
  });

  it("tells the model not to go looking for one", () => {
    // The failure this exists to stop: asked about GitHub work, a session that
    // knew `agent` accepted a name went and grepped the filesystem for
    // `cody-git` before it would use one.
    const prompt = namedSubagentPrompt([profile()]);

    expect(prompt).toContain("without checking whether it");
    expect(prompt).toContain("on disk is a wasted turn");
  });

  it("says to do the work itself when none of them fit", () => {
    // Without this the roster reads as "always delegate", which is its own
    // failure: the wrong subagent costs more than none.
    expect(namedSubagentPrompt([profile()])).toContain("do the work yourself");
  });

  it("reminds the model a child starts with no memory of the conversation", () => {
    const prompt = namedSubagentPrompt([profile()]);

    expect(prompt).toContain("no memory of this conversation");
    expect(prompt).toContain("context");
  });

  it("does not promise a command a child was never given", () => {
    // The same trap the child's own prompt fell into once, in the other
    // direction: telling the parent to expect a bash-capable child would have it
    // ask for work the child cannot do.
    expect(namedSubagentPrompt([profile()])).not.toMatch(/you can run commands/i);
  });

  it("lists an agent's skills, because the routing decision is made against them", async () => {
    // The observed failure: a session asked about GitHub work audited thirteen
    // repositories itself when `cody-git` was right there. The roster named the
    // agent, and the model still judged the fit from one sentence.
    const prompt = namedSubagentPrompt([
      profile({
        name: "cody-git",
        description: "GitHub work",
        skills: [
          { name: "pr-review", description: "Review a pull request diff", file: "/a/pr-review.md" },
          { name: "ci-triage", description: "Find why a build is red", file: "/a/ci-triage.md" },
        ],
      }),
    ]);

    expect(prompt).toContain("pr-review (Review a pull request diff)");
    expect(prompt).toContain("ci-triage (Find why a build is red)");
  });

  it("says the skills decide, not that delegating is always right", async () => {
    const prompt = namedSubagentPrompt([
      profile({ skills: [{ name: "pr-review", description: "", file: "/a.md" }] }),
    ]);

    // Both halves, or the roster overcorrects into "always delegate" — its own
    // failure, since the wrong subagent costs more than none.
    expect(prompt).toContain("Read each agent's skills before deciding");
    expect(prompt).toContain("do the work yourself");
  });

  it("says so when an agent can reach GitHub, because that is what it is for", () => {
    const prompt = namedSubagentPrompt([profile({ github: true })]);

    // The point of the grant: the model has to know this agent can answer
    // GitHub questions, or it will do the work itself and read the wrong files.
    expect(prompt).toContain("read the GitHub API with the `github` tool");
    expect(prompt).toContain("Use it for anything about");
  });

  it("says nothing about GitHub for an agent that was not granted it", () => {
    expect(namedSubagentPrompt([profile()])).not.toContain("github");
  });

  it("leaves the skills line out for an agent that has none", async () => {
    // An empty "skills:" line reads as a folder that failed to load rather than
    // an agent that has none.
    expect(namedSubagentPrompt([profile()])).not.toContain("skills:");
    expect(namedSubagentPrompt([profile({ skills: [] })])).not.toContain("skills:");
  });
});

describe("a child that reports nothing", () => {
  /** A child that finishes saying whatever it was scripted to say. */
  const saying =
    (...lines: string[]) =>
    (): Agent =>
      ({
        async *send(): AsyncGenerator<AgentEvent> {
          for (const line of lines) yield { type: "text", delta: line };
          yield { type: "done", reason: "complete" };
        },
      }) as unknown as Agent;

  const runChild = async (create: () => Agent): Promise<SubagentResult> => {
    const run = childRunner({
      create,
      registry: new SubagentRegistry(),
      model: "m",
      maxIterations: 4,
      limits: { staleMs: 60_000, staleToolMs: 120_000 },
    });
    return run({
      id: "s1",
      goal: "audit the account",
      model: "",
      tools: [],
      instructions: "",
      signal: new AbortController().signal,
    });
  };

  it("says it ran and found nothing, rather than returning silence", async () => {
    // The observed failure, verbatim from the transcript: [(it reported nothing)].
    // An empty string is indistinguishable from a child that died mid-turn or one
    // still working, so the parent had no result *and* no idea why.
    const result = await runChild(saying());

    expect(result.summary).not.toBe("");
    // And it names the reason that actually bit: no child can run a command.
    expect(result.summary).toMatch(/no child can run one/i);
  });

  it("still reports what the child did say", async () => {
    // The fallback is for silence only — a real report must survive untouched, or
    // the safety net would overwrite the answer.
    const result = await runChild(saying("Found three repos with unpushed branches."));

    expect(result.summary).toBe("Found three repos with unpushed branches.");
  });

  it("still says so when the child stopped without reporting", async () => {
    // The failure text is what the panel shows; the summary is what the model
    // reads. A child that stopped without saying anything must still say something.
    const result = await runChild(
      () =>
        ({
          async *send(): AsyncGenerator<AgentEvent> {
            yield { type: "done", reason: "cancelled" as never };
          },
        }) as unknown as Agent,
    );

    expect(result.summary).not.toBe("");
  });
});

describe("the delegation prompt", () => {

  it("chains onto the todo rule the model already follows", () => {
    // An instruction attached to an existing habit is worth more than a lone one.
    // The observed failure was a session tracking four steps and then doing all
    // four itself, so the new advice has to meet it where it already goes.
    expect(DELEGATION_PROMPT).toContain("tracked steps");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("track the steps with the todo tool");
  });

  it("says what not to delegate, so the advice cannot cause over-delegation", () => {
    // The wrong response to "delegate more" is delegating a single lookup, which
    // costs a child and saves nothing.
    expect(DELEGATION_PROMPT).toContain("Do not delegate a decision, a single lookup");
  });

  it("tells the model one batch beats several calls", () => {
    expect(DELEGATION_PROMPT).toContain("single");
    expect(DELEGATION_PROMPT).toContain("run at once");
  });
});

describe("the delegate tool's own description", () => {
  const described = (profiles: AgentProfile[] = []) =>
    delegateTool({
      spawn: async (request) => ({ id: request.id, goal: request.goal, requests: 1, status: "completed", summary: "x" }),
      registry: new SubagentRegistry(),
      settings: { model: "", maxConcurrent: 2, maxPerTurn: 4 },
      spawnCount: () => 0,
      profiles,
    }).description;

  it("leads with the batch form, because that is the shape being nudged toward", () => {
    // The tool description is what a model reads when it is deciding whether to
    // reach for the tool at all, so the order of its sentences is the order of the
    // decision.
    const text = described();
    expect(text).toContain("tasks");
    expect(text).toContain("in parallel");
  });

  it("gives a worked example, so the split is pattern-matchable", () => {
    // An example is worth more than another adjective: it shows the shape of a
    // good batch rather than describing it.
    expect(described()).toMatch(/audit every repo.*two tasks in one call/s);
  });

  it("says a single goal is for one thing only", () => {
    expect(described()).toContain("only when there is genuinely one thing to do");
  });

  it("describes each task in the batch, not just the array", () => {
    const schema = (
      delegateTool({
        spawn: async (request) => ({ id: request.id, goal: request.goal, requests: 1, status: "completed", summary: "x" }),
        registry: new SubagentRegistry(),
        settings: { model: "", maxConcurrent: 2, maxPerTurn: 4 },
        spawnCount: () => 0,
      }).parameters as {
        properties: Record<
          string,
          { description: string; items?: { properties?: Record<string, { description?: string }> } }
        >;
      }
    ).properties.tasks;

    expect(schema?.description ?? "").toMatch(/several separate pieces/);
    // The per-task goal is where "narrow enough to finish on its own" has to be,
    // or the model writes one-word tasks and gets one-word reports.
    expect(schema?.items?.properties?.goal?.description ?? "").toContain("Narrow enough");
  });
});

describe("a task that does not finish", () => {
  /** A child that reports the same thing every time it is called. */
  const fixed = (
    replies: readonly SubagentResult[],
  ): ((request: SubagentRequest) => Promise<SubagentResult>) => {
    let at = 0;
    return async (request) => {
      const next = replies[Math.min(at, replies.length - 1)]!;
      at += 1;
      return { ...next, id: request.id, goal: request.goal, requests: 1 };
    };
  };

  const settings = (retryUnfinished?: number) => ({
    model: "",
    maxConcurrent: 2,
    maxPerTurn: 8,
    ...(retryUnfinished === undefined ? {} : { retryUnfinished }),
  });

  const stalled: SubagentResult = {
    id: "x",
    goal: "g",
    status: "stalled",
    summary: "I got through part of it.",
    requests: 60,
    error: "it ran out of turns",
  };

  const done: SubagentResult = {
    id: "x",
    goal: "g",
    status: "completed",
    summary: "Finished: three repos have unpushed branches.",
    requests: 4,
  };

  const run = async (replies: readonly SubagentResult[], retryUnfinished?: number) => {
    const tool = delegateTool({
      spawn: fixed(replies),
      registry: new SubagentRegistry(),
      settings: settings(retryUnfinished),
      spawnCount: () => 0,
    });
    return tool.run({ goal: "audit the repos" }, { signal: new AbortController().signal } as never);
  };

  it("tries a stalled task again, and reports the finished one", async () => {
    const result = await run([stalled, done], 1);

    // The whole feature. Before this a stalled task ended there, and the parent
    // got a sentence about it and a hole where the answer should have been.
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Finished: three repos have unpushed branches.");
    expect(result.content).not.toContain("UNFINISHED");
  });

  it("says a task was tried twice, because that is a different fact", async () => {
    const result = await run([stalled, done], 1);

    expect(result.content).toContain("tried 2x");
  });

  it("marks a task UNFINISHED when the retry does not finish it either", async () => {
    const result = await run([stalled], 1);

    // Honesty is the whole contract. A second attempt that also failed must not be
    // presented as a result — the parent has to be able to see at a glance that it
    // is being handed incomplete work.
    expect(result.content).toContain("UNFINISHED, stalled");
    expect(result.content).toContain("tried 2x");
  });

  it("does not try a completed task again", async () => {
    const seen: string[] = [];
    const tool = delegateTool({
      spawn: async (request) => {
        seen.push(request.id);
        return { ...done, id: request.id, goal: request.goal, requests: 2 };
      },
      registry: new SubagentRegistry(),
      settings: settings(1),
      spawnCount: () => 0,
    });

    await tool.run({ goal: "audit" }, { signal: new AbortController().signal } as never);

    // Retrying work that succeeded would double the cost of every delegation.
    expect(seen).toHaveLength(1);
  });

  it("does not try a task that crashed, because a crash does not fix itself", async () => {
    const seen: string[] = [];
    const tool = delegateTool({
      spawn: async (request) => {
        seen.push(request.id);
        return {
          id: request.id,
          goal: request.goal,
          requests: 0,
          status: "failed",
          summary: "It could not run: no key",
          error: "no key",
        };
      },
      registry: new SubagentRegistry(),
      settings: settings(1),
      spawnCount: () => 0,
    });

    const result = await tool.run({ goal: "audit" }, { signal: new AbortController().signal } as never);

    expect(seen).toHaveLength(1);
    expect(result.content).toContain("UNFINISHED, failed");
  });

  it("does not retry when the setting is off, and says nothing about trying", async () => {
    const result = await run([stalled], 0);

    // It costs tokens, so a user who would rather have the honest failure can say so.
    expect(result.content).toContain("UNFINISHED, stalled");
    expect(result.content).not.toContain("tried");
  });

  it("is off unless it was asked for", async () => {
    const result = await run([stalled, done]);

    // Absent is not one. Delegation that silently doubles its own cost is worse
    // than delegation that admits when it could not finish.
    expect(result.content).toContain("UNFINISHED, stalled");
  });

  it("hands the retry what the first attempt managed to say", async () => {
    const contexts: string[] = [];
    const tool = delegateTool({
      spawn: async (request) => {
        if (request.context) contexts.push(request.context);
        return { ...stalled, id: request.id, goal: request.goal, requests: 1 };
      },
      registry: new SubagentRegistry(),
      settings: settings(1),
      spawnCount: () => 0,
    });

    await tool.run(
      { goal: "audit", context: "the workspace is C:/work" },
      { signal: new AbortController().signal } as never,
    );

    // Without this it is not a retry, it is the first attempt again with tokens
    // spent — and the work already done would be done twice.
    const retry = contexts[1] ?? "";
    expect(retry).toContain("the workspace is C:/work");
    expect(retry).toContain("second attempt");
    expect(retry).toContain("ran out of turns");
    expect(retry).toContain("I got through part of it.");
  });

  it("retries a task that came back with nothing at all", async () => {
    let calls = 0;
    const tool = delegateTool({
      spawn: async (request) => {
        calls += 1;
        // The ADR-061 case: a child handed a task needing a command it cannot run
        // comes back with the empty report. This is the one the retry is most for.
        return calls === 1
          ? {
              id: request.id,
              goal: request.goal,
              requests: 2,
              status: "completed",
              summary: EMPTY_REPORT,
            }
          : { ...done, id: request.id, goal: request.goal, requests: 1 };
      },
      registry: new SubagentRegistry(),
      settings: settings(1),
      spawnCount: () => 0,
    });

    const result = await tool.run({ goal: "audit github" }, { signal: new AbortController().signal } as never);

    expect(calls).toBe(2);
    expect(result.content).toContain("Finished: three repos");
    expect(result.content).toContain("tried 2x");
  });

  it("marks an empty report UNFINISHED when the retry is empty too", async () => {
    const tool = delegateTool({
      spawn: async (request) => ({
        id: request.id,
        goal: request.goal,
        requests: 1,
        status: "completed",
        summary: EMPTY_REPORT,
      }),
      registry: new SubagentRegistry(),
      settings: settings(1),
      spawnCount: () => 0,
    });

    const result = await tool.run({ goal: "audit github" }, { signal: new AbortController().signal } as never);

    // Honesty again: two empty reports is a task that could not be done, and the
    // parent is being told to run the command itself.
    expect(result.content).toContain("UNFINISHED");
    expect(result.content).toContain("no child can run one");
  });

  it("gives up rather than retrying forever", async () => {
    const seen: string[] = [];
    const tool = delegateTool({
      spawn: async (request) => {
        seen.push(request.id);
        return { ...stalled, id: request.id, goal: request.goal, requests: 1 };
      },
      registry: new SubagentRegistry(),
      settings: settings(99),
      spawnCount: () => 0,
    });

    await tool.run({ goal: "audit" }, { signal: new AbortController().signal } as never);

    // Clamped, because a task that cannot be done would otherwise spend the turn's
    // whole budget learning that a second time.
    expect(seen.length).toBeLessThanOrEqual(3);
  });

  it("keeps one roster row for a task that is tried twice", async () => {
    // Found by the chip: a retry given its own row made one unfinished task read as
    // two, so the counter said `[AGENTS 0/2]` for a single delegated task. A retry
    // is the same task — it has to be one row that records the attempt.
    const ids: string[] = [];
    const tool = delegateTool({
      spawn: async (request) => {
        ids.push(request.id);
        return { ...stalled, id: request.id, goal: request.goal, requests: 1 };
      },
      registry: new SubagentRegistry(),
      settings: settings(1),
      spawnCount: () => 0,
    });

    await tool.run({ goal: "audit" }, { signal: new AbortController().signal } as never);

    expect(new Set(ids).size).toBe(1);
  });

  it("records the attempt on the row, since there is only one row", async () => {
    const registry = new SubagentRegistry();
    const tool = delegateTool({
      spawn: async (request) => ({ ...stalled, id: request.id, goal: request.goal, requests: 1 }),
      registry,
      settings: settings(1),
      spawnCount: () => 0,
    });

    await tool.run({ goal: "audit" }, { signal: new AbortController().signal } as never);

    const rows = registry.snapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempts).toBe(2);
  });

  it("does not record an attempt on a task that only ran once", async () => {
    const registry = new SubagentRegistry();
    const tool = delegateTool({
      spawn: async (request) => ({ ...done, id: request.id, goal: request.goal, requests: 1 }),
      registry,
      settings: settings(1),
      spawnCount: () => 0,
    });

    await tool.run({ goal: "audit" }, { signal: new AbortController().signal } as never);

    // Absent rather than 1: most tasks are never retried, and a field that says
    // "1" on every row is a field nobody reads.
    expect(registry.snapshot()[0]?.attempts).toBeUndefined();
  });

  it("does not spend the turn's budget again on a retry", async () => {
    let charged = 0;
    const tool = delegateTool({
      spawn: async (request) => {
        charged += 1;
        return { ...stalled, id: request.id, goal: request.goal, requests: 1 };
      },
      registry: new SubagentRegistry(),
      settings: settings(1),
      // The parent charges once per task it hands out, and a retry is the same
      // task -- otherwise a batch of four that all stalled would quietly spawn
      // eight and break the promise the model was given.
      spawnCount: () => 0,
    });

    await tool.run({ goal: "audit" }, { signal: new AbortController().signal } as never);

    expect(charged).toBe(2);
  });
});
describe("the permission ladder", () => {
  it("starts at ask, and ask waives nothing", () => {
    expect(PERMISSION_MODES[0]).toBe("ask");
    for (const name of ["write", "edit", "bash"]) {
      expect(permissionAllows("ask", name)).toBe(false);
    }
  });

  it("lets edits through without asking, but not commands", () => {
    // The middle rung is the point: an edit shows a diff and can be read before it
    // lands; a command runs arbitrary code with no preview at all. Answering
    // "always" to one and never to the other is a reasonable position, and a
    // single on/off switch cannot express it.
    expect(permissionAllows("edits", "write")).toBe(true);
    expect(permissionAllows("edits", "edit")).toBe(true);
    expect(permissionAllows("edits", "bash")).toBe(false);
  });

  it("lets everything through at the top rung", () => {
    for (const name of ["write", "edit", "bash"]) {
      expect(permissionAllows("all", name)).toBe(true);
    }
  });

  it("names every rung, in an order that goes from safest to least", () => {
    expect(PERMISSION_MODES).toEqual(["ask", "edits", "all"]);
    for (const mode of PERMISSION_MODES) {
      expect(PERMISSION_LABELS[mode].label.length).toBeGreaterThan(0);
      expect(PERMISSION_LABELS[mode].description.length).toBeGreaterThan(10);
    }
  });

  it("does not decide on the arguments, only on the tool", () => {
    // A rung that read the arguments would be a policy the user cannot reason
    // about from the label on the chip.
    expect(permissionAllows("edits", "write")).toBe(permissionAllows("edits", "write"));
    expect(permissionAllows("edits", "bash")).toBe(false);
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
