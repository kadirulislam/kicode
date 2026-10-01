import { readConfigFiles, type ConfigFileEntry } from "../config-file";

/**
 * The `mcp` block of `kicode.json`, shaped like OpenCode's so muscle memory
 * carries over:
 *
 * ```jsonc
 * {
 *   "mcp": {
 *     "local-server": {
 *       "type": "local",
 *       "command": ["node", "server.js"],
 *       "environment": { "TOKEN": "…" }
 *     },
 *     "remote-server": {
 *       "type": "remote",
 *       "url": "https://example.com/mcp",
 *       "headers": { "Authorization": "Bearer …" }
 *     }
 *   }
 * }
 * ```
 */

export type McpLocalConfig = {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  /** Skip the approval prompt for this server's tools. */
  autoApprove?: boolean;
};

export type McpRemoteConfig = {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  autoApprove?: boolean;
};

export type McpServerConfig = McpLocalConfig | McpRemoteConfig;

export type LoadedMcpConfig = {
  servers: Record<string, McpServerConfig>;
  /** Non-fatal problems, for the caller to surface. */
  warnings: string[];
  /** Config files that were actually read. */
  files: string[];
};

export type McpServersResult = {
  servers: Record<string, McpServerConfig>;
  warnings: string[];
};

/**
 * Convenience wrapper that reads the config files itself. The CLI uses
 * `mcpServersFromEntries` instead, so settings and servers come from one read.
 */
export async function loadMcpConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedMcpConfig> {
  const { entries, files, warnings } = await readConfigFiles(cwd, env);
  const parsed = mcpServersFromEntries(entries);

  return { servers: parsed.servers, warnings: [...warnings, ...parsed.warnings], files };
}

/** Global first, then project — so a project server replaces a global one of the same name. */
export function mcpServersFromEntries(entries: readonly ConfigFileEntry[]): McpServersResult {
  const servers: Record<string, McpServerConfig> = {};
  const warnings: string[] = [];

  for (const entry of entries) {
    const block = entry.json.mcp;
    if (block === undefined) continue;

    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      warnings.push(`Ignoring "mcp" in ${entry.file}: expected an object of server definitions.`);
      continue;
    }

    for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
      const result = parseServer(name, value, entry.file);
      if (typeof result === "string") warnings.push(result);
      else if (result) servers[name] = result;
    }
  }

  return { servers, warnings };
}

/** Returns a config, a warning string, or null when the server is disabled. */
function parseServer(name: string, value: unknown, file: string): McpServerConfig | string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `Ignoring MCP server "${name}" in ${file}: expected an object.`;
  }

  const entry = value as Record<string, unknown>;
  if (entry.enabled === false) return null;
  if (entry.type === "disabled") return null;

  const autoApprove = entry.autoApprove === true;

  if (entry.type === "remote") {
    if (typeof entry.url !== "string" || !/^https?:\/\//i.test(entry.url)) {
      return `Ignoring MCP server "${name}" in ${file}: a remote server needs an http(s) "url".`;
    }
    const headers = stringMap(entry.headers);
    return { type: "remote", url: entry.url, headers, autoApprove };
  }

  if (entry.type === "local") {
    const command = Array.isArray(entry.command) ? entry.command.filter((part): part is string => typeof part === "string") : [];
    if (command.length === 0) {
      return `Ignoring MCP server "${name}" in ${file}: a local server needs a non-empty "command" array.`;
    }
    const environment = stringMap(entry.environment);
    return { type: "local", command, environment, autoApprove };
  }

  return `Ignoring MCP server "${name}" in ${file}: "type" must be "local" or "remote".`;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
