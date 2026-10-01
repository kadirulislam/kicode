import { parseSse } from "../providers/sse";
import {
  JsonRpcError,
  PROTOCOL_VERSION,
  createRequestId,
  toJsonRpcResponse,
  type JsonRpcId,
  type JsonRpcResponse,
  type McpTransport,
} from "./protocol";

export type HttpTransportOptions = {
  url: string;
  headers?: Record<string, string>;
  timeoutMs: number;
};

/**
 * MCP "Streamable HTTP" transport.
 *
 * Each JSON-RPC message is POSTed. The server may answer with a plain JSON body
 * or with an SSE stream, so both are accepted and the matching response is
 * picked out by id in either case. A session id handed back in
 * `mcp-session-id` is echoed on later requests.
 */
export function createHttpTransport(options: HttpTransportOptions): McpTransport {
  let sessionId: string | null = null;
  let closed = false;

  const headersFor = (): Record<string, string> => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    ...options.headers,
  });

  const post = async (message: unknown): Promise<Response> => {
    if (closed) throw new Error("MCP transport is closed.");
    return fetch(options.url, {
      method: "POST",
      headers: headersFor(),
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  };

  const rememberSession = (response: Response): void => {
    const header = response.headers.get("mcp-session-id");
    if (header) sessionId = header;
  };

  return {
    async request(method, params) {
      const id = createRequestId();

      let response: Response;
      try {
        response = await post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
      } catch (error) {
        throw new Error(`MCP request "${method}" failed: ${(error as Error).message}`);
      }

      rememberSession(response);

      if (!response.ok) {
        throw new Error(`MCP server returned HTTP ${response.status} for "${method}".`);
      }

      const message = await readResponse(response, id);
      if (!message) {
        throw new Error(`MCP server returned no response for "${method}".`);
      }
      if (message.error) throw new JsonRpcError(message.error);
      return message.result;
    },

    async notify(method, params) {
      const response = await post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
      rememberSession(response);
      // A notification is answered with 202 and an empty body; the body is
      // drained so the socket is not left hanging.
      await response.text().catch(() => undefined);
    },

    async close() {
      closed = true;
    },
  };
}

/** Reads either a JSON body or an SSE stream and returns the response with `id`. */
async function readResponse(response: Response, id: JsonRpcId): Promise<JsonRpcResponse | null> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    if (!response.body) return null;
    for await (const data of parseSse(response.body)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const candidate = toJsonRpcResponse(parsed);
      if (candidate && candidate.id === id) return candidate;
    }
    return null;
  }

  const text = await response.text();
  if (text.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`MCP server returned a body that is not JSON: ${text.slice(0, 200)}`);
  }

  // A batch is legal JSON-RPC; take the entry that answers this request.
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const candidate = toJsonRpcResponse(entry);
      if (candidate && candidate.id === id) return candidate;
    }
    return null;
  }

  return toJsonRpcResponse(parsed);
}
