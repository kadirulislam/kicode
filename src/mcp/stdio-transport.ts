import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import {
  JsonRpcError,
  createRequestId,
  toJsonRpcResponse,
  type JsonRpcId,
  type McpTransport,
} from "./protocol";

export type StdioTransportOptions = {
  command: string[];
  cwd: string;
  environment?: Record<string, string>;
  timeoutMs: number;
  onDiagnostic?: (line: string) => void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * MCP stdio transport: one JSON-RPC message per line.
 *
 * Frames are split by hand rather than with `readline` — the same reasoning as
 * the MCP server in ki-forms: a protocol buffer should not inherit a line
 * reader's opinions about very long lines or a missing trailing newline.
 */
export function createStdioTransport(options: StdioTransportOptions): McpTransport {
  const [file, ...args] = options.command;
  if (!file) throw new Error("A local MCP server needs a command.");

  // spawn cannot execute a `.cmd` shim (npx, on Windows) without a shell, so on
  // Windows the whole command line is built and quoted here. Passing an args
  // array with `shell: true` is deprecated precisely because Node would join it
  // unescaped. The command comes from the user's own config, not from the model.
  const base: SpawnOptions = {
    cwd: options.cwd,
    env: { ...process.env, ...options.environment },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };

  const child = (
    process.platform === "win32"
      ? spawn(buildCommandLine(file, args), { ...base, shell: true })
      : spawn(file, args, { ...base, shell: false })
  ) as ChildProcessWithoutNullStreams;

  const pending = new Map<JsonRpcId, Pending>();
  let buffer = "";
  let diagnosticBuffer = "";
  let failure: Error | null = null;
  let closed = false;

  const failAll = (error: Error): void => {
    failure = failure ?? error;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      handleLine(line);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    diagnosticBuffer += chunk;
    for (;;) {
      const index = diagnosticBuffer.indexOf("\n");
      if (index === -1) break;
      const line = diagnosticBuffer.slice(0, index).trim();
      diagnosticBuffer = diagnosticBuffer.slice(index + 1);
      if (line) options.onDiagnostic?.(line);
    }
  });

  child.on("error", (error: Error) => failAll(new Error(`MCP server failed to start: ${error.message}`)));
  child.on("exit", (code) => {
    if (closed) return;
    failAll(new Error(`MCP server exited (code ${code ?? "unknown"}).`));
  });

  function handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      options.onDiagnostic?.(`ignored non-JSON output: ${trimmed.slice(0, 200)}`);
      return;
    }

    const response = toJsonRpcResponse(parsed);
    // Server-initiated requests and notifications are outside this client's
    // scope; ignoring them keeps the stream aligned.
    if (!response || response.id === null) return;

    const entry = pending.get(response.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(response.id);

    if (response.error) entry.reject(new JsonRpcError(response.error));
    else entry.resolve(response.result);
  }

  const write = (message: unknown): void => {
    if (closed) throw new Error("MCP transport is closed.");
    if (failure) throw failure;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  return {
    request(method, params) {
      if (failure) return Promise.reject(failure);

      const id = createRequestId();
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request "${method}" timed out after ${options.timeoutMs}ms.`));
        }, options.timeoutMs);

        pending.set(id, { resolve, reject, timer });

        try {
          write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error as Error);
        }
      });
    },

    async notify(method, params) {
      write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
    },

    async close() {
      if (closed) return;
      closed = true;
      failAll(new Error("MCP transport closed."));
      child.stdin.end();
      child.kill();
      // Give the child a moment to exit on its own before it is left to the OS.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    },
  };
}

function buildCommandLine(file: string, args: string[]): string {
  return [file, ...args].map(quoteForWindows).join(" ");
}

function quoteForWindows(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
