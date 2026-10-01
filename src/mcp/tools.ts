import type { Tool } from "../agent/tools/types";
import type { McpClient, McpToolDefinition } from "./client";

/**
 * OpenAI-compatible function names must match `^[a-zA-Z0-9_-]{1,64}$`, which
 * rules out the `server/tool` and `server.tool` spellings. Namespacing with an
 * underscore keeps them distinguishable while staying legal.
 */
export const MAX_TOOL_NAME = 64;

export function mcpToolName(server: string, tool: string): string {
  const combined = `${sanitize(server)}_${sanitize(tool)}`;
  return combined.length <= MAX_TOOL_NAME ? combined : combined.slice(0, MAX_TOOL_NAME);
}

/** Turns every server's tools into KiCode tools, renaming any that collide. */
export function mcpTools(clients: McpClient[]): Tool[] {
  const used = new Set<string>();
  const tools: Tool[] = [];

  for (const client of clients) {
    for (const definition of client.tools) {
      let name = mcpToolName(client.name, definition.name);
      if (used.has(name)) {
        // Two servers exposing the same tool must not silently overwrite each
        // other in the registry.
        const suffix = `_${client.name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 8)}`;
        name = mcpToolName(client.name, `${definition.name}${suffix}`);
        let counter = 2;
        while (used.has(name)) name = mcpToolName(client.name, `${definition.name}${suffix}${counter++}`);
      }
      used.add(name);
      tools.push(toTool(client, definition, name));
    }
  }

  return tools;
}

function toTool(client: McpClient, definition: McpToolDefinition, name: string): Tool {
  const description = definition.description?.trim();

  return {
    name,
    description: `${description && description.length > 0 ? description : `The "${definition.name}" tool`} (from the "${client.name}" MCP server).`,
    parameters: normalizeSchema(definition.inputSchema),
    // MCP servers can do anything — shell out, hit the network, write files — so
    // they are gated unless the user opted this server out.
    requiresApproval: !client.autoApprove,

    async preview(args) {
      const rendered = JSON.stringify(args);
      return `call ${client.name}/${definition.name}(${rendered.length > 300 ? `${rendered.slice(0, 299)}…` : rendered})`;
    },

    async run(args) {
      const result = await client.callTool(definition.name, args);
      return { content: result.content, isError: result.isError };
    },
  };
}

function normalizeSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    const candidate = schema as Record<string, unknown>;
    if (candidate.type === "object" && candidate.properties !== undefined) return candidate;
    if (candidate.type === "object") return candidate;
  }
  // A tool with no usable schema still needs a valid object schema, or the
  // provider rejects the whole tools array.
  return { type: "object", properties: {} };
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
