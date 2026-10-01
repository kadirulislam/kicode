import type { Tool } from "../agent/tools/types";
import { connectMcpClient, type McpClient } from "./client";
import type { McpServerConfig } from "./config";
import { mcpTools } from "./tools";

export type McpRuntime = {
  clients: McpClient[];
  tools: Tool[];
  /** One line per problem; MCP is opt-in and must never block startup. */
  warnings: string[];
  close(): Promise<void>;
};

/**
 * Connects every configured server in parallel.
 *
 * A server that fails to start is reported and skipped — a broken MCP entry
 * must not stop the user from talking to the model.
 */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  options: { cwd: string },
): Promise<McpRuntime> {
  const entries = Object.entries(servers);
  if (entries.length === 0) return { clients: [], tools: [], warnings: [], close: async () => undefined };

  const warnings: string[] = [];
  const clients: McpClient[] = [];

  // A healthy server's stderr is usually noise (npx progress, startup banners),
  // so diagnostics are buffered and only surfaced when a connection fails —
  // which is exactly when that output explains what went wrong.
  const diagnostics = new Map<string, string[]>();

  const results = await Promise.allSettled(
    entries.map(([name, config]) =>
      connectMcpClient(name, config, {
        cwd: options.cwd,
        onDiagnostic: (line) => {
          const bucket = diagnostics.get(name) ?? [];
          bucket.push(line);
          if (bucket.length > 20) bucket.shift();
          diagnostics.set(name, bucket);
        },
      }),
    ),
  );

  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const name = entries[index]?.[0] ?? "unknown";

    if (result?.status === "fulfilled") {
      clients.push(result.value);
      if (result.value.tools.length === 0) warnings.push(`MCP server "${name}" connected but exposes no tools.`);
      continue;
    }

    const tail = diagnostics.get(name) ?? [];
    const detail = tail.length > 0 ? `\n  ${tail.slice(-5).join("\n  ")}` : "";
    warnings.push(`Could not connect to MCP server "${name}": ${describe(result?.reason)}${detail}`);
  }

  return {
    clients,
    tools: mcpTools(clients),
    warnings,
    async close() {
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
}

export function summarizeClients(clients: McpClient[]): string {
  return clients.map((client) => `${client.name} (${client.tools.length} tools)`).join(", ");
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
