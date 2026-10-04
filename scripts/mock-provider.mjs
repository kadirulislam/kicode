#!/usr/bin/env node
/**
 * Zero-dependency mock of an OpenAI-compatible `/chat/completions` endpoint.
 *
 * Lets you exercise the whole agent loop — streaming, tool calls, the approval
 * gate, MCP tool namespacing, and compaction — without an API key or network.
 *
 * Stop it with Ctrl+C in the foreground. If you backgrounded it, note that a
 * plain `kill` from Git Bash does not reliably terminate a Windows process:
 * `MSYS_NO_PATHCONV=1 taskkill /F /PID <pid>` does.
 *
 *   node scripts/mock-provider.mjs &
 *   KICODE_API_KEY=test KICODE_BASE_URL=http://localhost:8787/v1 \
 *     node dist/cli.js "read the package file"
 *
 * Env:
 *   MOCK_PORT        port, default 8787
 *   MOCK_TOOL        read | write | edit | glob | grep | bash | mcp | delegate | none
 *   MOCK_READ        path for `read`, default package.json
 *   MOCK_PATH        target path for write/edit, default mock-out.txt
 *   MOCK_CONTENT     content for `write`
 *   MOCK_OLD/MOCK_NEW  find/replace strings for `edit`
 *   MOCK_PATTERN     pattern for glob/grep
 *   MOCK_COMMAND     command for `bash`
 *   MOCK_MCP_TOOL    fully-qualified MCP tool name for the `mcp` mode
 *   MOCK_MCP_ARGS    JSON arguments for the `mcp` mode
 *   MOCK_DELEGATE    JSON `{ goal, context }` or `{ tasks: [...] }`, default a
 *                    two-task batch
 *   MOCK_CHILD_TEXT  what a subagent replies, default a canned report
 *   MOCK_TEXT        prose returned in `none` mode
 *   MOCK_LOG         1 to print each request's role and offered tool names —
 *                    the only way to see, from outside, that a child was
 *                    offered a read-only toolset
 */
import { createServer } from "node:http";

const port = Number(process.env.MOCK_PORT ?? 8787);
const tool = process.env.MOCK_TOOL ?? "read";

/**
 * A request from a child agent rather than the main session.
 *
 * Children get their own system prompt, which is the only thing that tells the
 * two apart on the wire — and it has to be told apart, because a child that also
 * called tools would loop forever on a script that answers every first turn with
 * another tool call.
 */
const isChild = (messages) =>
  messages.some((message) => message.role === "system" && /subagent working inside KiCode/.test(String(message.content ?? "")));

const frame = (delta, finishReason = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;

/** Returns a tool call to request, or null for a text-only reply. */
function toolCall(child) {
  const call = (name, args) => ({
    index: 0,
    id: "call_mock_1",
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  });

  // A child answers in prose. It has a read-only toolset in the real thing, and
  // a script that handed one a tool call would be testing nothing.
  if (child) return null;

  switch (tool) {
    case "none":
      return null;
    case "write":
      return call("write", {
        path: process.env.MOCK_PATH ?? "mock-out.txt",
        content: process.env.MOCK_CONTENT ?? "hello from the mock\n",
      });
    case "edit":
      return call("edit", {
        path: process.env.MOCK_PATH ?? "mock-out.txt",
        old_string: process.env.MOCK_OLD ?? "hello",
        new_string: process.env.MOCK_NEW ?? "goodbye",
      });
    case "glob":
      return call("glob", { pattern: process.env.MOCK_PATTERN ?? "**/*.ts" });
    case "grep":
      return call("grep", { pattern: process.env.MOCK_PATTERN ?? "import" });
    case "bash":
      return call("bash", { command: process.env.MOCK_COMMAND ?? "echo hello" });
    case "delegate": {
      let args;
      try {
        args = JSON.parse(
          process.env.MOCK_DELEGATE ??
            JSON.stringify({
              tasks: [
                { goal: "find the retry logic", context: "src/agent/loop.ts" },
                { goal: "find the approval gate", context: "src/agent/loop.ts" },
              ],
            }),
        );
      } catch {
        args = { goal: "find the retry logic" };
      }
      return call("delegate", args);
    }
    case "mcp": {
      let args = {};
      try {
        args = JSON.parse(process.env.MOCK_MCP_ARGS ?? "{}");
      } catch {
        args = {};
      }
      return call(process.env.MOCK_MCP_TOOL ?? "echo_echo", args);
    }
    default:
      return call("read", { path: process.env.MOCK_READ ?? "package.json" });
  }
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let messages = [];
    let wantsUsage = false;
    let offered = [];
    try {
      const parsed = JSON.parse(body);
      messages = parsed.messages ?? [];
      wantsUsage = parsed.stream_options?.include_usage === true;
      offered = (parsed.tools ?? []).map((entry) => entry.function?.name).filter(Boolean);
    } catch {
      // treat an unparseable body as a first turn
    }

    const toolMessages = messages.filter((message) => message.role === "tool");
    const child = isChild(messages);
    const call = toolMessages.length > 0 ? null : toolCall(child);

    if (process.env.MOCK_LOG === "1") {
      console.log(
        `[mock] ${child ? "child" : "parent"} · ${messages.length} messages · tools: ${offered.join(", ") || "(none)"}`,
      );
    }
    /** What this reply said, so the usage frame can be about it. */
    let spoken = "";

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    if (toolMessages.length > 0) {
      const last = String(toolMessages.at(-1)?.content ?? "");
      spoken = `[received ${messages.length} messages] Tool said: ${last.slice(0, 200)}`;
      res.write(frame({ role: "assistant", content: spoken }));
      res.write(frame({}, "stop"));
    } else if (child) {
      // A child's one report, which the parent will read as its whole result.
      spoken = process.env.MOCK_CHILD_TEXT ?? "Found it: loop.ts:676. Nothing else touches it.";
      res.write(frame({ role: "assistant", content: spoken }));
      res.write(frame({}, "stop"));
    } else if (call === null) {
      spoken = process.env.MOCK_TEXT ?? `Acknowledged (${messages.length} messages).`;
      res.write(frame({ role: "assistant", content: spoken }));
      res.write(frame({}, "stop"));
    } else {
      spoken = `Calling ${tool}. `;
      res.write(frame({ role: "assistant", content: spoken }));
      res.write(frame({ role: "assistant", tool_calls: [call] }));
      res.write(frame({}, "tool_calls"));
    }

    // The usage frame a real gateway sends last when the request opted in with
    // `stream_options`. Without one there is no rate under an answer and the
    // session's token budget never moves, so the mock has to send it or it is
    // not testing the path. The counts are this script's own arithmetic over
    // the characters it moved, not a real tokeniser's.
    if (wantsUsage) {
      const prompt = Math.max(Math.ceil(body.length / 4), 1);
      const completion = Math.max(Math.ceil(spoken.length / 4), 1);
      res.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
        })}\n\n`,
      );
    }

    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${port} is already in use — another mock provider is still listening.\n` +
        `  Stop it, or use another port:  MOCK_PORT=8788 npm run mock`,
    );
    process.exit(1);
  }
  throw error;
});

server.listen(port, () => {
  console.log(`mock provider listening on http://localhost:${port}/v1 (tool: ${tool})`);
});
