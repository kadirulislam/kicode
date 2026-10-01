import { describe, expect, it } from "vitest";
import type { McpClient } from "./client";
import { MAX_TOOL_NAME, mcpToolName, mcpTools } from "./tools";

function client(overrides: Partial<McpClient> = {}): McpClient {
  return {
    name: "docs",
    serverInfo: {},
    autoApprove: false,
    tools: [],
    callTool: async () => ({ content: "ok", isError: false }),
    close: async () => undefined,
    ...overrides,
  };
}

describe("mcpToolName", () => {
  it("namespaces with an underscore, because dots are illegal in tool names", () => {
    const name = mcpToolName("docs", "search");

    expect(name).toBe("docs_search");
    // The provider rejects any name outside this alphabet.
    expect(/^[a-zA-Z0-9_-]{1,64}$/.test(name)).toBe(true);
  });

  it("replaces illegal characters", () => {
    expect(mcpToolName("my server!", "read.file")).toBe("my_server__read_file");
  });

  it("truncates to the 64-character limit", () => {
    const name = mcpToolName("a".repeat(50), "b".repeat(50));

    expect(name).toHaveLength(MAX_TOOL_NAME);
    expect(/^[a-zA-Z0-9_-]{1,64}$/.test(name)).toBe(true);
  });
});

describe("mcpTools", () => {
  it("exposes each server tool with its schema and origin in the description", () => {
    const tools = mcpTools([
      client({
        tools: [{ name: "search", description: "Search the docs", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
      }),
    ]);

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("docs_search");
    expect(tools[0]?.description).toContain("Search the docs");
    expect(tools[0]?.description).toContain('"docs" MCP server');
    expect(tools[0]?.parameters).toMatchObject({ type: "object" });
  });

  it("gates tools behind approval by default", () => {
    const tools = mcpTools([client({ tools: [{ name: "search" }] })]);

    expect(tools[0]?.requiresApproval).toBe(true);
  });

  it("respects an auto-approved server", () => {
    const tools = mcpTools([client({ autoApprove: true, tools: [{ name: "search" }] })]);

    expect(tools[0]?.requiresApproval).toBe(false);
  });

  it("supplies an object schema when the server gives none", () => {
    // A malformed schema would make the provider reject the whole tools array.
    for (const inputSchema of [undefined, {}, "nonsense", { type: "string" }]) {
      const tools = mcpTools([client({ tools: [{ name: "x", inputSchema }] })]);
      expect(tools[0]?.parameters).toEqual({ type: "object", properties: {} });
    }
  });

  it("forwards calls and results", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const tools = mcpTools([
      client({
        tools: [{ name: "search" }],
        callTool: async (name, args) => {
          calls.push({ name, args });
          return { content: "found it", isError: false };
        },
      }),
    ]);

    const result = await tools[0]?.run({ q: "x" }, { cwd: process.cwd() });

    expect(calls).toEqual([{ name: "search", args: { q: "x" } }]);
    expect(result).toEqual({ content: "found it", isError: false });
  });

  it("does not let two servers collide on one tool name", () => {
    const tools = mcpTools([
      client({ name: "one", tools: [{ name: "search" }] }),
      client({ name: "two", tools: [{ name: "search" }] }),
    ]);

    const names = tools.map((tool) => tool.name);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toBe("one_search");
    expect(names[1]).toContain("two");
  });

  it("shows what it is about to do in the preview", async () => {
    const tools = mcpTools([client({ tools: [{ name: "search" }] })]);

    const preview = await tools[0]?.preview?.({ q: "hello" }, { cwd: process.cwd() });

    expect(preview).toContain("docs/search");
    expect(preview).toContain("hello");
  });
});
