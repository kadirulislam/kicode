import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { connectMcpClient, flattenResult } from "./client";

const FIXTURE = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

const localConfig = () => ({ type: "local" as const, command: ["node", FIXTURE] });

describe("MCP client over stdio", () => {
  it("handshakes and lists the server's tools", async () => {
    const client = await connectMcpClient("echo", localConfig(), { cwd: process.cwd() });

    try {
      expect(client.serverInfo).toEqual({ name: "echo-fixture", version: "9.9.9" });
      expect(client.tools.map((tool) => tool.name)).toEqual(["echo", "explode"]);
      expect(client.tools[0]?.inputSchema).toMatchObject({ type: "object" });
    } finally {
      await client.close();
    }
  });

  it("calls a tool and returns its text", async () => {
    const client = await connectMcpClient("echo", localConfig(), { cwd: process.cwd() });

    try {
      const result = await client.callTool("echo", { message: "hi" });

      expect(result).toEqual({ content: "echo: hi", isError: false });
    } finally {
      await client.close();
    }
  });

  it("passes a tool-level failure through as an error result", async () => {
    const client = await connectMcpClient("echo", localConfig(), { cwd: process.cwd() });

    try {
      const result = await client.callTool("explode", {});

      expect(result.isError).toBe(true);
      expect(result.content).toBe("boom");
    } finally {
      await client.close();
    }
  });

  it("keeps stderr out of the protocol stream", async () => {
    const diagnostics: string[] = [];
    const client = await connectMcpClient("echo", localConfig(), {
      cwd: process.cwd(),
      onDiagnostic: (line) => diagnostics.push(line),
    });

    try {
      // The fixture writes a greeting to stderr; it must arrive as a diagnostic
      // and must not have corrupted the JSON-RPC framing above.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(diagnostics.join("\n")).toContain("echo-fixture ready");
      expect(client.tools).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it("fails clearly when the command does not exist", async () => {
    await expect(
      connectMcpClient("missing", { type: "local", command: ["definitely-not-a-real-binary-xyz"] }, { cwd: process.cwd() }),
    ).rejects.toThrow();
  });

  it("times out rather than hanging forever", async () => {
    await expect(
      connectMcpClient("sleepy", { type: "local", command: ["node", "-e", "setInterval(() => {}, 1000)"] }, { cwd: process.cwd(), timeoutMs: 400 }),
    ).rejects.toThrow(/timed out/);
  }, 20_000);
});

describe("MCP client over streamable HTTP", () => {
  it("initialises, lists tools, and calls one, answering as plain JSON", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const request = JSON.parse(body || "{}") as { id?: number; method?: string };
        seen.push(request.method ?? "");
        if (request.method === "notifications/initialized") {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        if (request.method === "initialize") {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "http-fixture" } } }));
        } else if (request.method === "tools/list") {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] } }));
        } else {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "pong" }] } }));
        }
      });
    });

    const url = await listen(server);
    const client = await connectMcpClient("remote", { type: "remote", url }, { cwd: process.cwd() });

    try {
      expect(client.tools.map((tool) => tool.name)).toEqual(["ping"]);
      expect(await client.callTool("ping", {})).toEqual({ content: "pong", isError: false });
      expect(seen).toContain("notifications/initialized");
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reads a response delivered over an SSE stream and echoes the session id", async () => {
    const sessionIds: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const request = JSON.parse(body || "{}") as { id?: number; method?: string };
        sessionIds.push(req.headers["mcp-session-id"] as string | undefined);

        if (request.method === "notifications/initialized") {
          res.writeHead(202).end();
          return;
        }

        if (request.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-123" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "sse" } } }));
          return;
        }

        if (request.method === "tools/list") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] } }));
          return;
        }

        res.writeHead(200, { "content-type": "text/event-stream" });
        // A server notification is interleaved to prove the client picks the
        // message that answers it rather than the first one on the wire.
        res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\n\n');
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "over sse" }] } })}\n\n`);
        res.end();
      });
    });

    const url = await listen(server);
    const client = await connectMcpClient("sse", { type: "remote", url }, { cwd: process.cwd() });

    try {
      expect(await client.callTool("ping", {})).toEqual({ content: "over sse", isError: false });
      expect(sessionIds.at(-1)).toBe("session-123");
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports an HTTP failure instead of throwing something opaque", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500).end("nope");
    });
    const url = await listen(server);

    try {
      await expect(connectMcpClient("broken", { type: "remote", url }, { cwd: process.cwd() })).rejects.toThrow(/HTTP 500/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("flattenResult", () => {
  it("joins multiple text blocks", () => {
    expect(flattenResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }).content).toBe("a\nb");
  });

  it("describes an image instead of dropping it silently", () => {
    expect(flattenResult({ content: [{ type: "image", mimeType: "image/png" }] }).content).toBe("[image image/png]");
  });

  it("falls back to structured content", () => {
    expect(flattenResult({ structuredContent: { ok: true } }).content).toBe('{"ok":true}');
  });

  it("never returns an empty string", () => {
    expect(flattenResult({ content: [] }).content).toBe("(no output)");
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}
