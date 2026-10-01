#!/usr/bin/env node
/**
 * Minimal MCP stdio server used by the tests.
 *
 * Not a bundle entry — the tests spawn it as a real child process, so the
 * stdio transport is exercised end to end rather than mocked.
 */
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

// Diagnostics must not go to stdout: that stream carries the protocol.
process.stderr.write("echo-fixture ready\n");

const TOOLS = [
  {
    name: "echo",
    description: "Echo the message back",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  {
    name: "explode",
    description: "Always fails, to exercise tool-level error handling",
    inputSchema: { type: "object", properties: {} },
  },
];

function handle(request) {
  const { id, method, params } = request;

  switch (method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "echo-fixture", version: "9.9.9" },
        },
      });

    case "notifications/initialized":
      return;

    case "tools/list":
      return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });

    case "tools/call": {
      if (params?.name === "explode") {
        // A tool-level failure is reported in the result, not as a protocol error.
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "boom" }], isError: true } });
      }
      if (params?.name !== "echo") {
        return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${String(params?.name)}` } });
      }
      const message = params?.arguments?.message;
      if (typeof message !== "string") {
        return send({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "message must be a string" }], isError: true },
        });
      }
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo: ${message}` }] } });
    }

    default:
      return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${String(method)}` } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  try {
    handle(JSON.parse(trimmed));
  } catch {
    // Ignore anything that is not JSON-RPC.
  }
});
