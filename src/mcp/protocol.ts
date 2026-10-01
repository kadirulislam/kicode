import { VERSION } from "../version";

/** The MCP revision this client speaks — the same one the other projects here target. */
export const PROTOCOL_VERSION = "2025-06-18";

export const CLIENT_INFO = { name: "kicode", version: VERSION };

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

let nextId = 1;

export function createRequestId(): JsonRpcId {
  return nextId++;
}

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: { code: number; message: string; data?: unknown }) {
    super(error.message);
    this.name = "JsonRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

/**
 * One JSON-RPC channel to an MCP server.
 *
 * `request` resolves with the `result` (or rejects with a `JsonRpcError`);
 * `notify` sends a message that must never be answered.
 */
export type McpTransport = {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
};

export function toJsonRpcResponse(value: unknown): JsonRpcResponse | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Partial<JsonRpcResponse>;
  if (candidate.jsonrpc !== "2.0") return null;
  if (candidate.result === undefined && candidate.error === undefined) return null;
  return candidate as JsonRpcResponse;
}
