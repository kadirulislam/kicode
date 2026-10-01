import { describe, expect, it } from "vitest";
import type { ChatRequest, Provider, StreamEvent, ToolCall } from "../types";
import { Agent, type AgentEvent } from "./loop";
import { createDefaultTools } from "./tools";
import { ToolRegistry, type Tool } from "./tools/types";

/** Replays a scripted list of turns and records the request it was given. */
class FakeProvider implements Provider {
  readonly requests: ChatRequest[] = [];

  constructor(private readonly turns: StreamEvent[][]) {}

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    this.requests.push(request);
    // A request that was stopped before it was made fails the way a real one
    // does, rather than answering as if nothing had happened.
    if (request.signal?.aborted) throw abortError();
    for (const event of this.turns[this.requests.length - 1] ?? []) yield event;
  }
}

/**
 * The turn's last event, without the timing every `done` carries.
 *
 * `ms` and the token count are what the per-answer line is made of, and a test
 * that asserted on them would be asserting on how fast the machine ran.
 */
function finished(events: readonly AgentEvent[]): unknown {
  const last = events.at(-1);
  return last?.type === "done" ? { type: last.type, reason: last.reason } : last;
}

/** What the fetch layer throws when its signal is aborted. */
function abortError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

/** Streams one sentence, then goes on writing until the request is aborted. */
class HangingProvider implements Provider {
  readonly requests: ChatRequest[] = [];

  constructor(private readonly first = "I was in the middle of say") {}

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    this.requests.push(request);
    if (this.first) yield { type: "text", delta: this.first };
    await new Promise<void>((resolve, reject) => {
      const signal = request.signal;
      if (!signal) {
        resolve();
        return;
      }
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  }
}

function toolCallTurn(id: string, name: string, args: string): StreamEvent[] {
  const call: ToolCall = { id, type: "function", function: { name, arguments: args } };
  return [
    { type: "tool-call", call },
    { type: "finish", message: { role: "assistant", content: null, tool_calls: [call] }, finishReason: "tool_calls" },
  ];
}

function answerTurn(text: string): StreamEvent[] {
  return [
    { type: "text", delta: text },
    { type: "finish", message: { role: "assistant", content: text }, finishReason: "stop" },
  ];
}

const echoTool: Tool = {
  name: "read",
  description: "read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  async run(args) {
    return { content: `read ${JSON.stringify(args)}` };
  },
};

const gatedTool: Tool = {
  name: "write",
  description: "write a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  requiresApproval: true,
  async preview() {
    return "@@ -1,1 +1,1 @@\n+hello";
  },
  async run(args) {
    return { content: `wrote ${String(args.path)}` };
  },
};

/** A tool that runs until the turn is cancelled, like a hung command. */
const slowTool: Tool = {
  name: "bash",
  description: "run a command",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  async run(_args, context) {
    return new Promise((resolve) => {
      const stop = (): void => resolve({ content: "stopped", isError: true });
      const signal = context.signal;
      // Without the turn's signal it could only be waited out, which is what
      // this test exists to rule out.
      if (!signal || signal.aborted) {
        stop();
        return;
      }
      signal.addEventListener("abort", stop, { once: true });
    });
  },
};

async function collect(agent: Agent, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.send(prompt)) events.push(event);
  return events;
}

describe("Agent.send", () => {
  it("runs a tool, feeds the result back, and stops when the model answers", async () => {
    const provider = new FakeProvider([
      toolCallTurn("call_1", "read", '{"path":"a.txt"}'),
      answerTurn("It says hello."),
    ]);
    const agent = new Agent({
      provider,
      tools: new ToolRegistry([echoTool]),
      model: "m",
      cwd: process.cwd(),
    });

    const events = await collect(agent, "read a.txt");

    expect(events.map((event) => event.type)).toEqual(["tool-start", "tool-result", "text", "done"]);
    expect(finished(events)).toEqual({ type: "done", reason: "complete" });
    expect(provider.requests).toHaveLength(2);
  });

  it("appends the tool result as a tool message before the next turn", async () => {
    const provider = new FakeProvider([toolCallTurn("call_1", "read", '{"path":"a.txt"}'), answerTurn("ok")]);
    const agent = new Agent({ provider, tools: new ToolRegistry([echoTool]), model: "m", cwd: process.cwd() });

    await collect(agent, "read a.txt");
    const second = provider.requests[1];

    expect(second?.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: 'read {"path":"a.txt"}',
    });
    expect(second?.messages[1]).toEqual({ role: "user", content: "read a.txt" });
  });

  it("sends the tool specs on every request", async () => {
    const provider = new FakeProvider([answerTurn("hi")]);
    const agent = new Agent({ provider, tools: new ToolRegistry([echoTool]), model: "m", cwd: process.cwd() });

    await collect(agent, "hello");

    expect(provider.requests[0]?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read",
          description: "read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      },
    ]);
  });

  it("reports malformed tool arguments back to the model instead of throwing", async () => {
    const provider = new FakeProvider([toolCallTurn("call_1", "read", '{"path":'), answerTurn("retrying")]);
    const agent = new Agent({ provider, tools: new ToolRegistry([echoTool]), model: "m", cwd: process.cwd() });

    const events = await collect(agent, "read a.txt");
    const result = events.find((event) => event.type === "tool-result");

    expect(result).toMatchObject({ type: "tool-result", isError: true });
    if (result?.type === "tool-result") expect(result.content).toContain("invalid JSON arguments");
    expect(events.map((event) => event.type)).not.toContain("tool-start");
    expect(provider.requests).toHaveLength(2);
  });

  it("reports an unknown tool back to the model", async () => {
    const provider = new FakeProvider([toolCallTurn("call_1", "bash", "{}"), answerTurn("sorry")]);
    const agent = new Agent({ provider, tools: new ToolRegistry([echoTool]), model: "m", cwd: process.cwd() });

    const events = await collect(agent, "run ls");
    const result = events.find((event) => event.type === "tool-result");

    if (result?.type === "tool-result") expect(result.content).toContain('unknown tool "bash"');
    expect(provider.requests).toHaveLength(2);
  });

  it("stops at maxTurns when the model never answers without a tool", async () => {
    const provider = new FakeProvider([
      toolCallTurn("call_1", "read", "{}"),
      toolCallTurn("call_2", "read", "{}"),
      toolCallTurn("call_3", "read", "{}"),
    ]);
    const agent = new Agent({
      provider,
      tools: new ToolRegistry([echoTool]),
      model: "m",
      cwd: process.cwd(),
      maxTurns: 3,
    });

    const events = await collect(agent, "loop forever");

    expect(finished(events)).toEqual({ type: "done", reason: "max-turns" });
    expect(provider.requests).toHaveLength(3);
  });
});

describe("a pasted image", () => {
  const image = { data: "AAAA", mime: "image/png", bytes: 3 };

  it("travels beside the words as the endpoint expects to find it", async () => {
    const provider = new FakeProvider([answerTurn("ok")]);
    const agent = new Agent({ provider, tools: new ToolRegistry([echoTool]), model: "m", cwd: "." });

    for await (const _event of agent.send("what is wrong here?", [image])) {
      // The events are not what this is about.
    }

    expect(provider.requests[0]?.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is wrong here?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
  });

  it("leaves a plain turn as a plain string", async () => {
    // Every session and every line of every transcript is one of these, so the
    // common case must not grow a shape of its own.
    const provider = new FakeProvider([answerTurn("ok")]);
    const agent = new Agent({ provider, tools: new ToolRegistry([echoTool]), model: "m", cwd: "." });

    await collect(agent, "just words");

    expect(provider.requests[0]?.messages.at(-1)).toEqual({ role: "user", content: "just words" });
  });

  it("can be the whole turn, with no words at all", async () => {
    const provider = new FakeProvider([answerTurn("ok")]);
    const agent = new Agent({ provider, tools: new ToolRegistry([echoTool]), model: "m", cwd: "." });

    for await (const _event of agent.send("", [image])) {
      // As above.
    }

    // An empty text part is not sent: it is not a part of the message.
    expect(provider.requests[0]?.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
    });
  });
});

describe("Agent.send approval gate", () => {
  const writeTurn = (id: string): StreamEvent[] =>
    toolCallTurn(id, "write", '{"path":"a.txt","content":"x"}');

  it("refuses a gated tool when there is no approval channel", async () => {
    const provider = new FakeProvider([writeTurn("call_1"), answerTurn("ok")]);
    const agent = new Agent({ provider, tools: new ToolRegistry([gatedTool]), model: "m", cwd: process.cwd() });

    const events = await collect(agent, "write a file");
    const result = events.find((event) => event.type === "tool-result");

    expect(result).toMatchObject({ type: "tool-result", isError: true });
    if (result?.type === "tool-result") expect(result.content).toContain("--yes");
    expect(events.map((event) => event.type)).not.toContain("tool-start");
  });

  it("runs a gated tool once the approver allows it", async () => {
    const provider = new FakeProvider([writeTurn("call_1"), answerTurn("ok")]);
    const agent = new Agent({
      provider,
      tools: new ToolRegistry([gatedTool]),
      model: "m",
      cwd: process.cwd(),
      approve: async () => "allow",
    });

    const events = await collect(agent, "write a file");

    expect(events.map((event) => event.type)).toContain("tool-start");
    expect(events.find((event) => event.type === "tool-result" && event.isError)).toBeUndefined();
  });

  it("passes the preview to the approver, then remembers `always`", async () => {
    const provider = new FakeProvider([writeTurn("call_1"), writeTurn("call_2"), answerTurn("done")]);
    const previews: (string | null)[] = [];
    const agent = new Agent({
      provider,
      tools: new ToolRegistry([gatedTool]),
      model: "m",
      cwd: process.cwd(),
      approve: async (request) => {
        previews.push(request.preview);
        return "always";
      },
    });

    await collect(agent, "write two files");

    expect(previews).toHaveLength(1); // asked once, then remembered
    expect(previews[0]).toContain("+hello");
    expect(provider.requests).toHaveLength(3);
  });

  it("tells the model when the user denies", async () => {
    const provider = new FakeProvider([writeTurn("call_1"), answerTurn("ok")]);
    const agent = new Agent({
      provider,
      tools: new ToolRegistry([gatedTool]),
      model: "m",
      cwd: process.cwd(),
      approve: async () => "deny",
    });

    const events = await collect(agent, "write a file");
    const result = events.find((event) => event.type === "tool-result");

    if (result?.type === "tool-result") expect(result.content).toContain("denied");
    expect(events.map((event) => event.type)).not.toContain("tool-start");
    expect(provider.requests).toHaveLength(2);
  });

  it("does not gate a tool that does not ask for it", async () => {
    const provider = new FakeProvider([toolCallTurn("call_1", "read", "{}"), answerTurn("ok")]);
    let asked = 0;
    const agent = new Agent({
      provider,
      tools: new ToolRegistry([echoTool]),
      model: "m",
      cwd: process.cwd(),
      approve: async () => {
        asked++;
        return "deny";
      },
    });

    await collect(agent, "read a file");

    expect(asked).toBe(0);
  });
});

describe("plan mode", () => {
  const writeTurn = (id: string): StreamEvent[] =>
    toolCallTurn(id, "write", '{"path":"a.txt","content":"x"}');

  it("refuses a tool that changes something, without asking the user", async () => {
    const provider = new FakeProvider([writeTurn("call_1"), answerTurn("here is my plan")]);
    let asked = 0;
    const agent = new Agent({
      provider,
      tools: new ToolRegistry([gatedTool, echoTool]),
      model: "m",
      cwd: process.cwd(),
      readOnly: true,
      approve: async () => {
        asked++;
        return "allow";
      },
    });

    const events = await collect(agent, "change it");
    const result = events.find((event) => event.type === "tool-result");

    // The refusal is the model's to read, and names how to get out of it.
    expect(result).toMatchObject({ type: "tool-result", isError: true });
    if (result?.type === "tool-result") expect(result.content).toContain("plan mode");
    expect(events.map((event) => event.type)).not.toContain("tool-start");
    // A prompt the user would have to refuse every time is worse than a refusal.
    expect(asked).toBe(0);
  });

  /** A gated tool that knows which of its invocations only read. */
  const probingTool: Tool = {
    name: "bash",
    description: "run a command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    requiresApproval: true,
    readsOnly: (args) => args.command === "git status",
    async run(args) {
      return { content: `ran ${String(args.command)}` };
    },
  };

  it("runs the invocations a gated tool calls read-only, and refuses the rest", async () => {
    const provider = new FakeProvider([
      toolCallTurn("call_1", "bash", '{"command":"git status"}'),
      toolCallTurn("call_2", "bash", '{"command":"rm -rf src"}'),
      answerTurn("done"),
    ]);
    const agent = new Agent({
      provider,
      tools: new ToolRegistry([probingTool]),
      model: "m",
      cwd: process.cwd(),
      readOnly: true,
    });

    const events = await collect(agent, "look around");
    const results = events.filter((event) => event.type === "tool-result");

    // The safe one actually ran…
    expect(results[0]).toMatchObject({ type: "tool-result", isError: false });
    // …and the other is refused, in a message the model can act on.
    expect(results[1]).toMatchObject({ type: "tool-result", isError: true });
    if (results[1]?.type === "tool-result") expect(results[1].content).toContain("plan mode");
    expect(events.filter((event) => event.type === "tool-start")).toHaveLength(1);
  });

  it("still lets a read-only tool run", async () => {
    const provider = new FakeProvider([toolCallTurn("call_1", "read", "{}"), answerTurn("ok")]);
    const agent = new Agent({
      provider,
      tools: new ToolRegistry([echoTool]),
      model: "m",
      cwd: process.cwd(),
      readOnly: true,
    });

    const events = await collect(agent, "read a file");

    expect(events.map((event) => event.type)).toContain("tool-start");
    expect(events.find((event) => event.type === "tool-result" && event.isError)).toBeUndefined();
  });

  it("tells the model up front, so it does not waste a turn discovering it", async () => {
    const provider = new FakeProvider([answerTurn("ok")]);
    const agent = new Agent({
      provider,
      tools: new ToolRegistry([echoTool]),
      model: "m",
      cwd: process.cwd(),
      readOnly: true,
    });

    await collect(agent, "what would you do?");

    const system = provider.requests[0]?.messages[0];
    expect(system?.role).toBe("system");
    if (system?.role === "system") expect(system.content).toContain("Plan mode is on");
  });

  it("leaves the system prompt alone in build mode", async () => {
    const provider = new FakeProvider([answerTurn("ok")]);
    const agent = new Agent({ provider, tools: new ToolRegistry([echoTool]), model: "m", cwd: process.cwd() });

    await collect(agent, "hello");

    const system = provider.requests[0]?.messages[0];
    if (system?.role === "system") expect(system.content).not.toContain("Plan mode is on");
  });

  /** A gated tool that can say exactly what is wrong with a call. */
  const explainingTool: Tool = {
    name: "bash",
    description: "run a command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    requiresApproval: true,
    readOnlyRefusal: (args) => `\`${String(args.command)}\` is not a read-only git subcommand`,
    async run() {
      return { content: "ran" };
    },
  };

  it("names the tool's own reason for the refusal when it has one", async () => {
    const provider = new FakeProvider([toolCallTurn("call_1", "bash", '{"command":"git push"}'), answerTurn("ok")]);
    const agent = new Agent({ provider, tools: new ToolRegistry([explainingTool]), model: "m", cwd: process.cwd(), readOnly: true });

    const events = await collect(agent, "push it");
    const result = events.find((event) => event.type === "tool-result");

    expect(result).toMatchObject({ type: "tool-result", isError: true });
    if (result?.type === "tool-result") {
      expect(result.content).toContain("plan mode");
      expect(result.content).toContain("git push");
      expect(result.content).toContain("shift+tab");
    }
  });

  it("keeps the general sentence when explaining the refusal throws", async () => {
    const broken: Tool = {
      ...explainingTool,
      readOnlyRefusal: () => {
        throw new Error("boom");
      },
    };
    const provider = new FakeProvider([toolCallTurn("call_1", "bash", '{"command":"git push"}'), answerTurn("ok")]);
    const agent = new Agent({ provider, tools: new ToolRegistry([broken]), model: "m", cwd: process.cwd(), readOnly: true });

    const events = await collect(agent, "push it");
    const result = events.find((event) => event.type === "tool-result");

    // A tool that cannot explain itself must not take the turn down with it.
    if (result?.type === "tool-result") expect(result.content).toContain("it would change something");
  });
});

describe("the environment the model is told about", () => {
  it("names the platform and the shell the bash tool will use", async () => {
    const provider = new FakeProvider([answerTurn("ok")]);
    const agent = new Agent({ provider, tools: new ToolRegistry([echoTool]), model: "m", cwd: process.cwd() });

    await collect(agent, "hello");

    const system = provider.requests[0]?.messages[0];
    expect(system?.role).toBe("system");
    if (system?.role === "system") {
      expect(system.content).toContain("# Environment");
      expect(system.content).toContain(process.platform);
      expect(system.content).toContain("`bash` tool runs commands through");
      // Without this the model opens with `ls -la` on a cmd.exe machine.
      if (process.platform === "win32") expect(system.content).toMatch(/cmd\.exe|bash\.exe/);
    }
  });

  it("keeps the environment block whatever prompt the run supplied, and before the plan notice", async () => {
    const provider = new FakeProvider([answerTurn("ok")]);
    const agent = new Agent({
      provider,
      tools: new ToolRegistry([echoTool]),
      model: "m",
      cwd: process.cwd(),
      readOnly: true,
      systemPrompt: "You are a haiku-writing assistant.",
    });

    await collect(agent, "hello");

    const system = provider.requests[0]?.messages[0];
    if (system?.role === "system") {
      expect(system.content).toContain("You are a haiku-writing assistant.");
      expect(system.content).toContain("# Environment");
      expect(system.content.indexOf("# Environment")).toBeLessThan(system.content.indexOf("Plan mode is on"));
    }
  });
});

describe("cancelling a turn", () => {
  it("stops where it is, keeping everything that had already happened", async () => {
    const provider = new FakeProvider([toolCallTurn("call_1", "read", '{"path":"a.txt"}'), answerTurn("done")]);
    const agent = new Agent({ provider, tools: new ToolRegistry([echoTool]), model: "m", cwd: process.cwd() });

    const events: AgentEvent[] = [];
    // Ctrl+C arrives while the tool result is on screen — mid-turn, which is
    // where a real user presses it, not before the turn starts.
    const consume = (async () => {
      for await (const event of agent.send("read it")) {
        events.push(event);
        if (event.type === "tool-result") agent.cancel();
      }
    })();

    await expect(consume).rejects.toThrow(/abort/i);

    // The turn is over, and what it did is kept: the request was made.
    expect(events.map((event) => event.type)).toContain("tool-result");
    expect(agent.turns).toHaveLength(3);
    expect(agent.turns.at(-1)?.role).toBe("tool");
  });

  it("stops a tool that is still running, and records the result it gave", async () => {
    const provider = new FakeProvider([toolCallTurn("call_1", "bash", '{"command":"sleep 30"}'), answerTurn("done")]);
    const agent = new Agent({ provider, tools: new ToolRegistry([slowTool]), model: "m", cwd: process.cwd() });

    const events: AgentEvent[] = [];
    const consume = (async () => {
      for await (const event of agent.send("run it")) {
        events.push(event);
        // Ctrl+C arrives while the command is running, not once it has finished.
        if (event.type === "tool-start") setTimeout(() => agent.cancel(), 0);
      }
    })();

    await expect(consume).rejects.toThrow(/abort/i);

    // The killed tool still owes the model a result, so the assistant's tool
    // call is never left unanswered — the transcript stays valid.
    expect(events.filter((event) => event.type === "tool-result")).toHaveLength(1);
    expect(agent.turns).toHaveLength(3);
    expect(agent.turns.at(-1)?.role).toBe("tool");
    // And the turn ends there rather than asking the provider for another one.
    expect(provider.requests).toHaveLength(1);
  });

  it("kills a real bash command, through the loop, when the turn is cancelled", async () => {
    // The two halves — the loop handing the signal over, and `exec` dying with
    // it — are each covered above; this proves they meet.
    const provider = new FakeProvider([
      toolCallTurn(
        "call_1",
        "bash",
        JSON.stringify({ command: 'node -e "setTimeout(() => {}, 30000)"', timeout_ms: 60_000 }),
      ),
      answerTurn("done"),
    ]);
    const agent = new Agent({
      provider,
      tools: createDefaultTools(),
      model: "m",
      cwd: process.cwd(),
      approve: async () => "allow",
    });

    const started = Date.now();
    const events: AgentEvent[] = [];
    const consume = (async () => {
      for await (const event of agent.send("run it")) {
        events.push(event);
        if (event.type === "tool-start") setTimeout(() => agent.cancel(), 150);
      }
    })();

    await expect(consume).rejects.toThrow(/abort/i);

    const result = events.find((event) => event.type === "tool-result");
    expect(result).toMatchObject({ name: "bash", isError: true });
    expect((result as { content: string }).content).toContain("cancelled");
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(provider.requests).toHaveLength(1);
  }, 30_000);

  it("keeps the reply it had already streamed, so continue has somewhere to start", async () => {
    const provider = new HangingProvider();
    const agent = new Agent({ provider, tools: new ToolRegistry([echoTool]), model: "m", cwd: process.cwd() });

    const events: AgentEvent[] = [];
    const consume = (async () => {
      for await (const event of agent.send("explain")) {
        events.push(event);
        if (event.type === "text") setTimeout(() => agent.cancel(), 0);
      }
    })();

    await expect(consume).rejects.toThrow(/abort/i);

    expect(events).toContainEqual({ type: "text", delta: "I was in the middle of say" });
    // The half-written reply is in the transcript the next request is built
    // from — verbatim, because it is what the model said.
    expect(agent.turns).toHaveLength(2);
    expect(agent.turns.at(-1)).toEqual({ role: "assistant", content: "I was in the middle of say" });
  });

  it("adds nothing when a cancelled turn had said nothing yet", async () => {
    // A turn stopped before its first token has no reply to keep, and an empty
    // assistant message would be a turn the model never made.
    const provider = new HangingProvider("");
    const agent = new Agent({ provider, tools: new ToolRegistry([echoTool]), model: "m", cwd: process.cwd() });

    const consume = collect(agent, "hello");
    setTimeout(() => agent.cancel(), 0);
    await expect(consume).rejects.toThrow(/abort/i);

    expect(agent.turns).toHaveLength(1);
    expect(agent.turns[0]?.role).toBe("user");
  });

  it("is a no-op when nothing is running, so the key can still mean quit", () => {
    const agent = new Agent({
      provider: new FakeProvider([answerTurn("ok")]),
      tools: new ToolRegistry([echoTool]),
      model: "m",
      cwd: process.cwd(),
    });

    expect(() => agent.cancel()).not.toThrow();
  });

  it("still stops for a session-level abort", async () => {
    // The signal the agent was built with is the other reason to stop, and both
    // have to reach the request.
    const controller = new AbortController();
    const agent = new Agent({
      provider: new FakeProvider([answerTurn("ok")]),
      tools: new ToolRegistry([echoTool]),
      model: "m",
      cwd: process.cwd(),
      signal: controller.signal,
    });

    controller.abort();

    await expect(collect(agent, "hello")).rejects.toThrow(/abort/i);
  });

  it("leaves the turn's own cancellation behind it", async () => {
    const provider = new FakeProvider([answerTurn("first"), answerTurn("second")]);
    const agent = new Agent({ provider, tools: new ToolRegistry([echoTool]), model: "m", cwd: process.cwd() });

    await collect(agent, "one");
    // A turn that has finished is not a turn that can be cancelled: the next
    // request must go out untouched.
    agent.cancel();
    const events = await collect(agent, "two");

    expect(finished(events)).toEqual({ type: "done", reason: "complete" });
    expect(provider.requests).toHaveLength(2);
  });
});

/** Answers every call with prose, and "summarises" when it is asked to. */
class ProseProvider implements Provider {
  readonly requests: ChatRequest[] = [];

  constructor(private readonly failSummary = false) {}

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    this.requests.push(request);

    const isSummary = request.messages.some(
      (message) => message.role === "system" && message.content.includes("compress a coding session transcript"),
    );

    if (isSummary) {
      if (this.failSummary) throw new Error("summariser unavailable");
      const text = "Earlier: the user asked about files.";
      yield { type: "text", delta: text };
      yield { type: "finish", message: { role: "assistant", content: text }, finishReason: "stop" };
      return;
    }

    yield { type: "text", delta: "answer" };
    yield { type: "finish", message: { role: "assistant", content: "answer" }, finishReason: "stop" };
  }
}

describe("routing and the token budget", () => {
  /** A tool turn that also reports what it cost, the way a gateway does. */
  const costlyToolTurn = (tokens: number): StreamEvent[] => {
    const call: ToolCall = { id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } };
    return [
      { type: "tool-call", call },
      {
        type: "finish",
        message: { role: "assistant", content: null, tool_calls: [call] },
        finishReason: "tool_calls",
        usage: { totalTokens: tokens },
      },
    ];
  };

  it("passes a route change through, so the list can name it", async () => {
    const provider: Provider = {
      async *stream(): AsyncGenerator<StreamEvent, void, void> {
        yield { type: "route", from: "gw/used-up", to: "gw/free", reason: "rate-limited (HTTP 429)" };
        yield { type: "text", delta: "hi" };
        yield { type: "finish", message: { role: "assistant", content: "hi" }, finishReason: "stop" };
      },
    };
    const agent = new Agent({ provider, tools: new ToolRegistry([echoTool]), model: "m", cwd: process.cwd() });

    const events = await collect(agent, "hi");

    expect(events[0]).toEqual({ type: "route", from: "gw/used-up", to: "gw/free", reason: "rate-limited (HTTP 429)" });
  });

  it("stops before the next request once the ceiling is passed", async () => {
    const provider = new FakeProvider([costlyToolTurn(900), answerTurn("more")]);
    const agent = new Agent({ provider, tools: new ToolRegistry([echoTool]), model: "m", cwd: process.cwd(), maxTokens: 500 });

    const events = await collect(agent, "go");

    expect(events.some((event) => event.type === "budget")).toBe(true);
    expect(finished(events)).toEqual({ type: "done", reason: "budget" });
    // The tool ran and was recorded, but no further request was made.
    expect(provider.requests).toHaveLength(1);
    expect(agent.spentTokens).toBe(900);
  });

  it("keeps going while there is room under the ceiling", async () => {
    const provider = new FakeProvider([costlyToolTurn(900), answerTurn("done")]);
    const agent = new Agent({ provider, tools: new ToolRegistry([echoTool]), model: "m", cwd: process.cwd(), maxTokens: 5_000 });

    const events = await collect(agent, "go");

    expect(finished(events)).toEqual({ type: "done", reason: "complete" });
    expect(provider.requests).toHaveLength(2);
  });

  it("adds the parts when a gateway reports no total", async () => {
    const provider: Provider = {
      async *stream(): AsyncGenerator<StreamEvent, void, void> {
        yield {
          type: "finish",
          message: { role: "assistant", content: "ok" },
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        };
      },
    };
    const agent = new Agent({ provider, tools: new ToolRegistry([echoTool]), model: "m", cwd: process.cwd() });

    await collect(agent, "hi");

    expect(agent.spentTokens).toBe(15);
  });

  it("can be set and removed while the session runs", () => {
    const agent = new Agent({
      provider: new FakeProvider([answerTurn("ok")]),
      tools: new ToolRegistry([echoTool]),
      model: "m",
      cwd: process.cwd(),
    });

    expect(agent.tokenBudget).toBe(0);
    agent.setBudget(1_000);
    expect(agent.tokenBudget).toBe(1_000);
    // A negative or nonsense ceiling is no ceiling, not a tripwire.
    agent.setBudget(-5);
    expect(agent.tokenBudget).toBe(0);
  });
});

describe("Agent.send and the question channel", () => {
  const question = {
    header: "Typography",
    question: "Which way?",
    options: [{ label: "Sans" }, { label: "Mono" }],
  };
  const askTurn: StreamEvent[] = toolCallTurn("call_1", "ask", JSON.stringify({ questions: [question] }));

  it("hands the user's answer back to the model", async () => {
    const provider = new FakeProvider([askTurn, answerTurn("using mono")]);
    const agent = new Agent({
      provider,
      tools: createDefaultTools([], { ask: true }),
      model: "m",
      cwd: process.cwd(),
      ask: async () => [{ header: "Typography", answer: "Mono", dismissed: false }],
    });

    const events = await collect(agent, "build the page");
    const result = events.find((event) => event.type === "tool-result");

    if (result?.type !== "tool-result") throw new Error("no tool result");
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Typography: Mono");
    expect(provider.requests.at(-1)?.messages.at(-1)).toMatchObject({ role: "tool" });
  });

  it("is not offered when there is nobody to answer", async () => {
    const provider = new FakeProvider([askTurn, answerTurn("guessed")]);
    const agent = new Agent({
      provider,
      tools: createDefaultTools(),
      model: "m",
      cwd: process.cwd(),
    });

    const events = await collect(agent, "build the page");
    const result = events.find((event) => event.type === "tool-result");

    if (result?.type !== "tool-result") throw new Error("no tool result");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unknown tool");
    // And the turn still finishes, so a model that asks anyway is not stuck.
    expect(finished(events)).toEqual({ type: "done", reason: "complete" });
  });
});

describe("Agent.send compaction", () => {
  // Small enough that the budget is passed after a couple of short turns.
  const compaction = { contextTokens: 200, reserveTokens: 100, keepRecentTurns: 1 };

  it("summarises older turns once the budget is exceeded", async () => {
    const provider = new ProseProvider();
    const agent = new Agent({ provider, tools: new ToolRegistry(), model: "m", cwd: process.cwd(), compaction });

    await collect(agent, "first question");
    const events = await collect(agent, "second question");

    expect(events.some((event) => event.type === "compacted")).toBe(true);

    const latest = JSON.stringify(provider.requests.at(-1)?.messages);
    expect(latest).toContain("Earlier conversation, summarised");
    expect(latest).toContain("the user asked about files");
    expect(latest).toContain("second question");
  });

  it("carries on over budget when the summariser fails", async () => {
    const provider = new ProseProvider(true);
    const agent = new Agent({ provider, tools: new ToolRegistry(), model: "m", cwd: process.cwd(), compaction });

    await collect(agent, "first question");
    const events = await collect(agent, "second question");

    expect(events.some((event) => event.type === "compacted")).toBe(false);
    expect(events.some((event) => event.type === "text")).toBe(true);
    expect(finished(events)).toEqual({ type: "done", reason: "complete" });
  });

  it("leaves the transcript alone when compaction is not configured", async () => {
    const provider = new ProseProvider();
    const agent = new Agent({ provider, tools: new ToolRegistry(), model: "m", cwd: process.cwd() });

    await collect(agent, "first question");
    await collect(agent, "second question");

    expect(JSON.stringify(provider.requests.at(-1)?.messages)).not.toContain("Earlier conversation");
  });
});

