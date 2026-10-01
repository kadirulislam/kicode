import type { McpServerConfig } from "./config";
import { createHttpTransport } from "./http-transport";
import { CLIENT_INFO, PROTOCOL_VERSION, type McpTransport } from "./protocol";
import { createStdioTransport } from "./stdio-transport";

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type McpCallResult = {
  content: string;
  isError: boolean;
};

export type McpClient = {
  /** Config key this server was declared under. */
  name: string;
  serverInfo: { name?: string; version?: string };
  tools: McpToolDefinition[];
  /** True when this server's tools should skip the approval prompt. */
  autoApprove: boolean;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
};

export type ConnectOptions = {
  cwd: string;
  timeoutMs?: number;
  onDiagnostic?: (line: string) => void;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TOOLS = 500;

/**
 * Performs the MCP handshake and loads the tool list.
 *
 * The handshake order matters: `initialize`, then the `initialized`
 * notification, and only then `tools/list` — a server is not required to answer
 * anything else before it has been told the client finished initialising.
 */
export async function connectMcpClient(
  name: string,
  config: McpServerConfig,
  options: ConnectOptions,
): Promise<McpClient> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const transport: McpTransport =
    config.type === "local"
      ? createStdioTransport({
          command: config.command,
          cwd: options.cwd,
          environment: config.environment,
          timeoutMs,
          onDiagnostic: options.onDiagnostic,
        })
      : createHttpTransport({ url: config.url, headers: config.headers, timeoutMs });

  try {
    const initialized = (await transport.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })) as { serverInfo?: { name?: string; version?: string } } | undefined;

    await transport.notify("notifications/initialized");

    const tools = await listTools(transport);

    return {
      name,
      serverInfo: initialized?.serverInfo ?? {},
      tools,
      autoApprove: config.autoApprove === true,

      async callTool(toolName, args) {
        try {
          const result = await transport.request("tools/call", { name: toolName, arguments: args });
          return flattenResult(result);
        } catch (error) {
          // A protocol-level failure still has to reach the model as text, so it
          // can decide whether to retry or work around it.
          return { content: `Error: ${(error as Error).message}`, isError: true };
        }
      },

      async close() {
        await transport.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
}

async function listTools(transport: McpTransport): Promise<McpToolDefinition[]> {
  const tools: McpToolDefinition[] = [];
  let cursor: string | undefined;

  do {
    const page = (await transport.request("tools/list", cursor ? { cursor } : {})) as
      | { tools?: unknown; nextCursor?: unknown }
      | undefined;

    if (Array.isArray(page?.tools)) {
      for (const entry of page.tools) {
        if (entry === null || typeof entry !== "object") continue;
        const candidate = entry as { name?: unknown; description?: unknown; inputSchema?: unknown };
        if (typeof candidate.name !== "string" || candidate.name === "") continue;
        tools.push({
          name: candidate.name,
          description: typeof candidate.description === "string" ? candidate.description : undefined,
          inputSchema: candidate.inputSchema,
        });
      }
    }

    cursor = typeof page?.nextCursor === "string" && page.nextCursor !== "" ? page.nextCursor : undefined;
  } while (cursor && tools.length < MAX_TOOLS);

  return tools;
}

const MAX_CONTENT_CHARS = 30_000;

/** Flattens MCP content blocks into the plain text a model can read. */
export function flattenResult(result: unknown): McpCallResult {
  const record = (result ?? {}) as { content?: unknown; isError?: unknown; structuredContent?: unknown };
  const parts: string[] = [];

  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      const block = (item ?? {}) as {
        type?: unknown;
        text?: unknown;
        mimeType?: unknown;
        uri?: unknown;
        resource?: { text?: unknown; uri?: unknown };
      };

      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block.type === "image") {
        parts.push(`[image ${typeof block.mimeType === "string" ? block.mimeType : "unknown"}]`);
      } else if (block.type === "audio") {
        parts.push(`[audio ${typeof block.mimeType === "string" ? block.mimeType : "unknown"}]`);
      } else if (block.type === "resource") {
        if (typeof block.resource?.text === "string") parts.push(block.resource.text);
        else parts.push(`[resource ${typeof block.resource?.uri === "string" ? block.resource.uri : "unknown"}]`);
      } else {
        parts.push(JSON.stringify(item));
      }
    }
  }

  if (parts.length === 0 && record.structuredContent !== undefined) {
    parts.push(JSON.stringify(record.structuredContent));
  }

  const joined = parts.join("\n").trim();
  const content = joined.length === 0 ? "(no output)" : joined;

  return {
    content: content.length > MAX_CONTENT_CHARS ? `${content.slice(0, MAX_CONTENT_CHARS)}\n… truncated` : content,
    isError: record.isError === true,
  };
}
