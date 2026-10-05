import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { brainBriefing } from "../agent/brain";
import { Agent, DEFAULT_SYSTEM_PROMPT, type AgentEvent, type ApproveFn } from "../agent/loop";
import type { AskAnswer, AskFn } from "../agent/ask";
import { allowPredicate } from "../agent/allow";
import { createDefaultTools, SUBAGENT_TOOLS } from "../agent/tools";
import { readAgentProfiles } from "../agents";
import { SUBAGENT_SYSTEM_PROMPT, SubagentRegistry, childRunner, delegateTool } from "../agent/subagent";
import type { Tool } from "../agent/tools/types";
import { apiKeyEnvFor, loadConfig, validateConfig, type Config, type FallbackRoute } from "../config";
import { addGlobalProvider, writeGlobalSettings } from "../settings-write";
import { keysFilePath, readStoredKeys, writeStoredKey } from "../keys-file";
import { type AddProviderResult, parseCustomService, serviceByName, serviceRows, SERVICES, serviceApiKey } from "../providers/services";
import { readConfigFiles } from "../config-file";
import { writeProjectConfig } from "./init";
import { connectMcpServers, summarizeClients, type McpRuntime } from "../mcp";
import { mcpServersFromEntries } from "../mcp/config";
import { fileSettingsFromEntries } from "../settings-file";
import { loadFavorites, saveFavorites } from "../favorites";
import { renderModelsTable } from "./models-table";
import { probeEndpoint, renderProbe } from "./probe";
import { runTui } from "../tui/app";
import { resolveCommand } from "../tui/commands";
import type { SessionMode } from "../tui/frame";
import { listModels, formatModelPrice } from "../providers/openai";
import { RouteHealth } from "../routes/health";
import { DEFAULT_THEME, canonicalThemeName, isThemeName } from "../tui/theme";
import { FallbackProvider } from "../providers/fallback";
import { readClipboard } from "../clipboard";
import { pickFile } from "../pickFile";
import {
  clearActiveSessionId,
  deleteSession,
  latestSessionFor,
  listSessions,
  loadSession,
  newSessionId,
  pruneSessions,
  readActiveSessionId,
  samePath,
  saveSession,
  sessionPreview,
  sessionTitle,
  writeActiveSessionId,
} from "../sessions/store";
import { withoutImages, type ChatMessage } from "../types";
import { readUsage, recordUsage, renderUsage, summarizeUsage, turnRecord, usageReportJson, type UsageRecord } from "../usage";
import { buildMentionIndex, expandMentions } from "../mentions";
import { VERSION } from "../version";

export type Io = {
  cwd: string;
  /** True only on a real terminal, where prompts can actually be answered. */
  interactive: boolean;
  /** Streams assistant text without a trailing newline. */
  write(text: string): void;
  writeLine(line?: string): void;
  writeError(line: string): void;
  /** Resolves to null at end of input. */
  readLine(prompt: string): Promise<string | null>;
  close(): void;
};

export type IoStreams = {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
};

/**
 * Lines are queued rather than read with `rl.question`.
 *
 * `question` only observes lines that arrive while a question is pending, so
 * piped input that lands before the first prompt — which is exactly what
 * `printf ... | kicode` does — was silently discarded. Buffering instead makes
 * delivery order irrelevant.
 */
export function createIo(cwd: string, streams: IoStreams = {}): Io {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;

  const rl = createInterface({
    input,
    output,
    terminal: (input as { isTTY?: boolean }).isTTY === true,
  });
  let closed = false;
  let ended = false;
  const queue: string[] = [];
  let waiting: ((value: string | null) => void) | null = null;

  const settle = (value: string | null): void => {
    const resolve = waiting;
    waiting = null;
    resolve?.(value);
  };

  rl.on("line", (line: string) => {
    if (waiting) settle(line);
    else queue.push(line);
  });

  rl.on("close", () => {
    ended = true;
    // Hand back anything still buffered before reporting end of input — but only
    // to a pending readLine. Shifting with nobody waiting would drop the line.
    if (waiting) settle(queue.length > 0 ? (queue.shift() ?? null) : null);
  });
  // `kicode ... | head` closes stdout early, which surfaces as an asynchronous
  // EPIPE on the socket rather than a throw. Left unhandled it crashes the CLI
  // mid-turn — at exactly the moment a session still needs saving.
  let broken = false;
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") broken = true;
    });
  }

  return {
    cwd,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    write(text) {
      if (closed || broken) return;
      output.write(text);
    },
    writeLine(line = "") {
      if (closed || broken) return;
      output.write(`${line}\n`);
    },
    writeError(line) {
      if (broken) return;
      process.stderr.write(`${line}\n`);
    },
    readLine(prompt) {
      if (closed || broken) return Promise.resolve(null);
      if (queue.length > 0) {
        output.write(prompt);
        return Promise.resolve(queue.shift() ?? null);
      }
      if (ended) return Promise.resolve(null);

      output.write(prompt);
      return new Promise<string | null>((resolve) => {
        waiting = resolve;
      });
    },
    close() {
      if (closed) return;
      closed = true;
      ended = true;
      settle(null);
      rl.close();
    },
  };
}

/**
 * How many implicit free models the auto chain may add.
 *
 * A cap rather than the whole list: a free endpoint can serve a dozen models,
 * and a request that walks all of them is a long wait before the same error.
 * Four is enough to ride out one busy route without hiding the failure.
 */
const FREE_HOPS_MAX = 4;

const USAGE = [
  "kicode — bring-your-own-key terminal coding agent",
  "",
  "Usage:",
  "  kicode                     Start an interactive session",
  "  kicode <prompt>            Run one prompt and exit",
  "  echo <text> | kicode -p    Read the prompt from stdin",
  "",
  "Options:",
  "  -p, --print                One-shot mode (implies reading stdin when no prompt is given)",
  "  -y, --yes                  Approve file changes and commands automatically",
  "  -c, --continue             Resume the most recent session for this directory",
  "      --session <id>         Resume a specific session (or `latest`)",
  "      --models               List the models the endpoint serves, then exit",
  "      --usage                Show recorded token usage (daily and per-model), then exit",
  "      --json                 With --usage: print the rollup as JSON",
  "      --probe                Test the endpoint: model list, then a tiny chat request,",
  "      --init                 Write the current settings to ./kicode.json",
  "      --no-tui               Use the plain prompt instead of the full-screen UI",
  "      --tui-preview          Draw one frame of the UI and exit (for bug reports);",
  "                             needs no key and no valid config",
  "      --no-mcp               Do not start the MCP servers in kicode.json",
  "      --no-compact           Never summarise old turns, even when the context fills",
  "      --model <model>        Model id (default: kicode.json, then $KICODE_MODEL)",
  "      --provider <name>      Which kicode.json provider to use (default: $KICODE_PROVIDER)",
  "      --base-url <url>       OpenAI-compatible base URL for this run only",
  "      --api-key <key>        Key for this run only; otherwise the provider's apiKeyEnv",
  "      --max-tokens <n>       Stop before this many session tokens (0 = no limit)",
  "      --theme <name>         Colour theme (/themes lists them; default: opencode)",
  "  -v, --version              Print the version",
  "  -h, --help                 Print this help",
  "",
  "Project settings:",
  "  kicode.json in the working directory, or in ~/.kicode/ for every project,",
  "  sets \"model\", \"provider\", \"providers\", \"fallbackModels\", \"fallback\",",
  "  \"fallbackAuto\", \"maxTokens\", \"maxTurns\", \"allow\", \"theme\", \"baseUrl\",",
  "  \"compaction\", \"brain\",",
  "  \"learning\" (\"auto\" or \"off\"), \"mcp\", and \"mock\": true. A provider declares a",
  "  baseUrl and the environment",
  "  variable holding its key (\"apiKeyEnv\"); the file has no place for a key,",
  "  and one found in a file is reported and ignored.",
  "  A failed turn asks what to do next (retry / another model / dismiss).",
  "  \"fallbackAuto\": true, or KICODE_FALLBACK_AUTO=on, instead lets a free",
  "  model move to the endpoint's other free models on its own.",
  "  Precedence: flags > kicode.json > defaults. The environment holds a key,",
  "  but it cannot declare an endpoint.",
  "",
  "Project instructions:",
  "  AGENTS.md in the working directory is read into the system prompt. The",
  "  /init command writes it (and kicode.json) from inside a session.",
  "",
  "Environment:",
  "  Keys are read from the variable a provider names (\"apiKeyEnv\"), so e.g.",
  "  an \"openai\" provider reads OPENAI_API_KEY. With no provider declared",
  "  there is no endpoint at all: add one with /connect, or one-off with",
  "  --base-url and --api-key. An ambient OPENAI_API_KEY or OPENAI_BASE_URL is",
  "  never used on its own.",
  "  KICODE_PROVIDER  which declared provider to use, when the file names none",
  "  KICODE_MODEL     optional, and overridden by kicode.json",
  "  KICODE_FALLBACK_MODELS  comma-separated models to try when the one in use",
  "                   is rate-limited or out of credit (same endpoint)",
  "  KICODE_MAX_TOKENS       stop before this many session tokens (0 = no limit)",
  "  KICODE_MAX_TURNS        requests one turn may spend (default 100; kicode.json",
  "                   \"maxTurns\" wins over it)",
  "  KICODE_THEME            colour theme by name (/themes lists them)",
  "  KICODE_HOME      optional, where sessions are stored (default ~/.kicode)",
  "  KI_BRAIN_PATH    optional, where skills and memories are saved (default",
  "                   ~/.kicode/brain, created on the first save; an existing",
  "                   ki-agent-brain at or above the working directory is used)",
  "  KICODE_LEARNING  off disables the extra learning request after a turn",
  "  KICODE_SHELL     optional, which shell the bash tool runs commands through",
  "                   (default: a Git Bash on Windows when one is installed,",
  "                   otherwise Node's own default — set it to cmd.exe to",
  "                   keep the Windows commands)",
  "  KICODE_CONTEXT_TOKENS  model context window used for compaction (default 200000)",
  "  KICODE_COMPACT_AT      compact once the estimate passes this many tokens (default 150000;",
  "                   this is the one that fires, so keep it under the window)",
  "  KICODE_COMPACT_TARGET where a compacted session should sit, as a percentage",
  "                   of the window (default 40; clamped to 30-50)",
].join("\n");

// Printed in both PowerShell and bash, so it cannot assume either syntax. The
// variable is named because a declared provider may want its own, and telling
// someone to set KICODE_API_KEY when the config asked for TH_KEY is a dead end.
const setupHint = (variable: string): string =>
  [
    `Set ${variable} and try again:`,
    "",
    `  PowerShell:   $env:${variable} = "sk-..."`,
    `  bash / zsh:   export ${variable}=sk-...`,
    "",
    "The endpoint and model can also live in kicode.json — but never the key.",
    "Any OpenAI-compatible endpoint works, including OpenRouter, Groq, and local Ollama.",
].join("\n");

/**
 * The remedy when there is no endpoint at all: a fresh install with nothing
 * declared.
 *
 * It names `/connect` and the two flags rather than a variable, because with no
 * provider declared there is no variable to set. Telling someone to export a key
 * would send them to a value with nowhere to go — which is exactly how an
 * ambient `OPENAI_API_KEY` came to look like configuration.
 */
const noProviderHint = (): string =>
  [
    "KiCode needs a declared endpoint to start — a key in the environment is not",
    "enough on its own.",
    "",
    "  In the UI:  /connect                    (endpoints already known to work)",
    "  One-off:    kicode --base-url <url> --api-key <key>",
    '  In a file:  "providers": { "openai": { "apiKeyEnv": "OPENAI_API_KEY" } }',
    '  Choosing:   "provider": "openai"       (when more than one is declared)',
    "",
    "The key itself stays in the environment — it is never written to kicode.json.",
    "Any OpenAI-compatible endpoint works, including OpenRouter, Groq, and local Ollama.",
  ].join("\n");

export async function runCli(argv: string[], io: Io): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    io.writeError(parsed.error);
    io.writeError("Run `kicode --help` for usage.");
    return 2;
  }
  const { flags } = parsed;

  if (flags.help) {
    io.writeLine(USAGE);
    return 0;
  }
  if (flags.version) {
    io.writeLine(VERSION);
    return 0;
  }

  // Needs nothing — no config, no key, no endpoint — so it runs before all of
  // them: usage is a local log being read back, not a session.
  if (flags.usage) {
    const records = await readUsage().catch((): UsageRecord[] => []);
    const summary = summarizeUsage(records);
    if (flags.json) io.writeLine(usageReportJson(summary));
    else for (const line of renderUsage(summary)) io.writeLine(line);
    return 0;
  }

  const configFiles = await readConfigFiles(io.cwd);
  const fileSettings = fileSettingsFromEntries(configFiles.entries);
  // The named subagents, read once here so the tool description, the roster and
  // the editor all see the same list. A file that could not be read is a warning
  // rather than a failure — a typo in one agent must not stop the session.
  const profiles = await readAgentProfiles(io.cwd);
  const agentProfiles = profiles.agents;
  for (const warning of [...configFiles.warnings, ...fileSettings.warnings, ...profiles.warnings]) {
    io.writeError(warning);
  }

  // Keys a previous `/key` (or `/connect` with a pasted key) kept in
  // `~/.kicode/keys.json` rejoin the environment here, before anything reads
  // it — so every lookup below behaves as if they had been exported. Only
  // gaps are filled: a variable the shell already sets wins, and the stored
  // copy is ignored for the run rather than overwriting it.
  for (const [name, value] of Object.entries(await readStoredKeys(process.env))) {
    if (!(process.env[name] ?? "").trim() && value.trim()) process.env[name] = value;
  }

  const config = loadConfig(process.env, fileSettings.settings, {
    apiKey: flags.apiKey,
    provider: flags.provider,
    baseUrl: flags.baseUrl,
    model: flags.model,
    compact: flags.compact,
    ...(flags.theme !== undefined ? { theme: flags.theme } : {}),
    ...(flags.maxTokens !== undefined ? { maxTokens: flags.maxTokens } : {}),
  });

  // A theme is a preference, so an unknown name is reported and worked around
  // rather than being a reason to refuse to start.
  if (!isThemeName(config.theme)) {
    io.writeError(`Unknown theme "${config.theme}" — using ${DEFAULT_THEME}. /themes lists them all.`);
  }
  const themeName = isThemeName(config.theme) ? canonicalThemeName(config.theme) : DEFAULT_THEME;

  // Handled before the key check on purpose: setting up a project should not
  // require already having a credential.
  if (flags.init) {
    const outcome = await writeProjectConfig(io.cwd, config);
    if (outcome.status === "blocked") {
      io.writeError(outcome.reason);
      return 1;
    }

    const keys = outcome.keys.join(", ");
    if (outcome.status === "unchanged") {
      io.writeLine(`${outcome.file} already records the current settings (${keys}).`);
      return 0;
    }

    io.writeLine(`${outcome.status === "written" ? "Wrote" : "Updated"} ${outcome.file} — ${keys}`);
    io.writeLine("Flags still override it, and the key stays in the environment.");
    if (outcome.keys.includes("mock")) io.writeLine('"mock": true points this project at `npm run mock`.');
    return 0;
  }

  // Whether the full-screen UI is about to run. Decided here because it changes
  // what a missing key means below.
  const tuiWanted = canUseTui(io) && flags.tui;

  const problem = validateConfig(config);
  // A missing provider, or a declared one with no key, is the kind of config
  // problem the UI can fix by itself: `/connect` and `/key` are inside it.
  // Refusing to open the screen that holds the remedy is a poor way to ask for a
  // credential, so the run continues and the UI says what to do instead.
  const tuiCanFixConfig = tuiWanted && (!config.baseUrl || !config.apiKey);
  // `--tui-preview` draws a frame and exits. It needs no credential, and it is
  // what someone runs when KiCode is misbehaving — so config never stops it.
  if (problem && !flags.tuiPreview && !tuiCanFixConfig) {
    const named = config.providers.find((provider) => provider.name === config.provider);
    io.writeError(problem);
    io.writeError("");
    // A declared provider knows which variable it wanted, so it is named. With
    // no provider there is no variable to name, and pointing at one would send
    // someone to export a key they have nowhere to send.
    io.writeError(named?.apiKeyEnv ? setupHint(named.apiKeyEnv) : noProviderHint());
    return 1;
  }
  /**
   * Shown inside the UI, which is the only place it can be acted on.
   *
   * A fresh install gets the remedy and not just the complaint: "No provider is
   * configured yet" is true but does not say what to do about it.
   */
  const configNotice = tuiCanFixConfig
    ? !config.baseUrl
      ? "No provider is configured yet. Add one with /connect — it declares the endpoint and names the environment variable your key is read from."
      : problem
    : null;

  // A diagnosis runs before anything session-shaped: it needs only the
  // endpoint and the key, and its whole point is to be read before a session
  // fails confusingly.
  if (flags.probe) {
    for (const line of renderProbe(
      await probeEndpoint({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        ...(config.model ? { model: config.model } : {}),
      }),
    )) {
      io.writeLine(line);
    }
    return 0;
  }

  const resuming = flags.continue || flags.session !== undefined;
  const oneShot = flags.print || flags.prompt.length > 0;
  /** Scripted one-shot runs stay out of the session store unless asked to resume. */
  const persist = !oneShot || resuming;

  let restored: ChatMessage[] | null = null;
  // The settings a resumed session was using. Carried out of the block below so
  // the resume opens on them, rather than on whatever the config says now.
  let restoredModel: string | undefined;
  let restoredBaseUrl: string | undefined;
  let restoredMode: "build" | "plan" | undefined;
  let restoredVariant: string | undefined;
  let sessionId = newSessionId();
  let createdAt = new Date().toISOString();

  if (resuming) {
    const requested = flags.session && flags.session !== "latest" ? flags.session : null;
    let record = requested ? await loadSession(requested) : null;
    if (!record && !requested) {
      // The tab that was in front when the UI last closed, rather than the
      // newest session: a restart returns to where the user was. Anything
      // unreadable — no pointer, a pruned session, another directory's file —
      // falls back to the newest session for this directory.
      const activeId = await readActiveSessionId(io.cwd).catch(() => null);
      const active = activeId ? await loadSession(activeId).catch(() => null) : null;
      record = active && samePath(active.cwd, io.cwd) ? active : await latestSessionFor(io.cwd);
    }

    if (record) {
      restored = record.messages;
      sessionId = record.id;
      createdAt = record.createdAt || createdAt;
      restoredModel = record.model || undefined;
      restoredBaseUrl = record.baseUrl || undefined;
      restoredMode = record.mode === "plan" || record.mode === "build" ? record.mode : undefined;
      restoredVariant = record.variant || undefined;
    } else if (requested) {
      io.writeError(`No session found with id "${requested}".`);
      return 1;
    } else {
      io.writeError("No previous session for this directory — starting a new one.");
    }
  }

  if (flags.models) {
    try {
      const models = await listModels({ apiKey: config.apiKey, baseUrl: config.baseUrl });
      io.writeLine(renderModelsTable(models, { currentModel: config.model }));
      return models.length === 0 ? 1 : 0;
    } catch (error) {
      io.writeError((error as Error).message);
      return 1;
    }
  }

  if (flags.tuiPreview) {
    return await runTui({
      cwd: io.cwd,
      baseUrl: config.baseUrl,
      contextTokens: config.compaction.contextTokens,
      version: VERSION,
      model: config.model,
      compacting: config.compaction.enabled,
      newSessionId,
      themeName,
      view: config.view,
      preview: true,
      mcp: null,
      config: configFiles.files.length > 0 ? configFiles.files.join("  ") : null,
      listSessions: async () => [],
      loadSession: async () => null,
      createAgent: () => {
        throw new Error("preview does not run an agent");
      },
      saveSession: async () => undefined,
      // With --continue this renders the resumed transcript instead of the logo.
      initial: { id: sessionId, createdAt, messages: restored ?? [] },
    });
  }

  const { servers, warnings: mcpConfigWarnings } = mcpServersFromEntries(configFiles.entries);
  for (const warning of mcpConfigWarnings) io.writeError(warning);

  const mcp = flags.mcp ? await connectMcpServers(servers, { cwd: io.cwd }) : null;
  for (const warning of mcp?.warnings ?? []) io.writeError(warning);

  // A factory rather than one agent: the TUI swaps sessions, and each session
  // needs its own agent with its own history and its own approval channel.
  const tui = tuiWanted;
  // Questions need somebody to answer them; a piped run has nobody, so the ask
  // tool is not registered at all rather than failing when it is called.
  const canAsk = tui || io.interactive;

  // Every endpoint this run can talk to, with the key that goes with it.
  //
  // The list is what `kicode.json` declares (`providers`) plus the endpoint in
  // use, so a named provider can be picked from the model list and a declared
  // one with no key says so instead of quietly doing a 401.
  const endpoints = new Map<string, string>();
  if (config.apiKey) endpoints.set(config.baseUrl, config.apiKey);

  for (const service of SERVICES) {
    const key = serviceApiKey(process.env, service);
    if (key && !endpoints.has(service.baseUrl)) endpoints.set(service.baseUrl, key);
  }
  for (const provider of config.providers) {
    if (provider.apiKey) endpoints.set(provider.baseUrl, provider.apiKey);
  }

  // `/connect` adds to these while the session runs, so they are `let` rather
  // than read back out of the config: re-reading the file would not help, since
  // a provider added a second ago is not in the copy `loadConfig` produced at
  // startup.
  let providers = [...config.providers];
  let activeProvider = config.provider;

  const resolveApiKey = (baseUrl: string): string => {
    const fromMap = endpoints.get(baseUrl);
    if (fromMap) return fromMap;
    const fromProvider = providers.find((p) => p.baseUrl === baseUrl)?.apiKey;
    if (fromProvider) return fromProvider;
    const matchedService = SERVICES.find((s) => s.baseUrl === baseUrl);
    if (matchedService) {
      const sKey = serviceApiKey(process.env, matchedService);
      if (sKey) {
        endpoints.set(baseUrl, sKey);
        return sKey;
      }
    }
    if (baseUrl === config.baseUrl) return config.apiKey;
    return "";
  };

  // What this machine has learned about each route, so "that one was out of
  // quota an hour ago" survives a restart. A file that will not read starts
  // empty and says so; it never stops the run.
  const routeHealth = await RouteHealth.load({ warn: (message) => io.writeError(message) });

  const createAgent = (
    history: ChatMessage[] | undefined,
    settings: {
      approve?: ApproveFn;
      ask?: AskFn;
      model?: string;
      baseUrl?: string;
      cwd?: string;
      variant?: string;
      mode?: SessionMode;
      /** What the OpenCode session header carries; one id per conversation. */
      sessionId?: string;
      /**
       * A different system prompt and a different toolset — how a child agent
       * is built.
       *
       * The prompt and the tool list are the isolation. A child that keeps the
       * parent's rules is told to ask the user questions it has no way to ask,
       * and given tools it cannot use; the read-only subset means it holds
       * nothing to be talked into using.
       */
      systemPrompt?: string;
      tools?: readonly string[];
      /** The child's own request ceiling, rather than the session's. */
      maxTurns?: number;
      /**
       * Stops this agent's work — a child's own signal, so a wedged child can be
       * cut loose without cancelling the turn that delegated it.
       */
      signal?: AbortSignal;
      /**
       * Tools this agent adds on top of the defaults — the `delegate` tool.
       *
       * Passed in rather than built here because the tool carries the caller's
       * live child registry, and this factory has never heard of the caller.
       */
      extraTools?: Tool[];
    } = {},
  ): Agent => {
    const cwd = settings.cwd ?? io.cwd;
    // `/models` can move the session to another endpoint, and the key has to
    // move with it — the provider is built here, so this is where it is chosen.
    const baseUrl = settings.baseUrl ?? config.baseUrl;
    const apiKey = resolveApiKey(baseUrl);
    // Read on every build, so switching directory (`/cd`) picks up that
    // directory's AGENTS.md as well.
    const instructions = instructionsFor(cwd);

    const model = settings.model ?? config.model;
    // Which variable a keyless route is missing, so the turn fails naming it
    // instead of sending an empty Bearer and reading the gateway's 401 back. A
    // URL nobody named a variable for is keyless by design (a local server)
    // and gets no hint — its request goes out as before.
    const keyHintFor = (url: string): string | undefined => {
      const variable =
        providers.find((p) => p.baseUrl === url)?.apiKeyEnv ?? SERVICES.find((s) => s.baseUrl === url)?.apiKeyEnv;
      if (!variable) return undefined;
      return `No API key for ${hostOf(url)} — set ${variable} in this shell and send again${tuiWanted ? ", or /key to paste one for this session" : ""}.`;
    };
    const hinted = (route: FallbackRoute): FallbackRoute => {
      const hint = keyHintFor(route.baseUrl);
      return hint ? { ...route, keyHint: hint } : route;
    };
    // The route in use leads the chain, then whatever `kicode.json` declared as
    // a backup. A single route stays a plain provider, so a session with no
    // fallbacks behaves and errors exactly as it did before this existed.
    const routes: FallbackRoute[] = [hinted({ label: activeProvider ? `${activeProvider}/${model}` : model, provider: activeProvider, baseUrl, apiKey, model }), ...config.fallback.map(hinted)];
    // Auto free→free: a free model that just hit its quota is followed by the
    // endpoint's other free models, discovered from its own `/models` list the
    // first time the chain runs dry. Never a paid model, never configured
    // routes — those already lead the chain — and a gateway that will not list
    // its models simply contributes nothing. The fetch is lazy and cached, so
    // a session that never sees a 429 never pays for it.
    const moreRoutes =
      config.fallbackAuto && /free/i.test(model)
        ? async (): Promise<readonly FallbackRoute[]> => {
            try {
              const models = await listModels({ apiKey, baseUrl });
              const free = models.filter((entry) => entry.free && entry.id !== model).slice(0, FREE_HOPS_MAX);
              return free.map((entry) => ({
                label: activeProvider ? `${activeProvider}/${entry.id}` : entry.id,
                provider: activeProvider,
                baseUrl,
                apiKey,
                model: entry.id,
              }));
            } catch {
              return [];
            }
          }
        : undefined;
    // Always the chain, even for one route: it is the same request path, and it
    // is the one place that knows which route a request went to and how it
    // ended, so it is where the route store is told.
    const provider = new FallbackProvider({
      routes,
      ...(moreRoutes ? { moreRoutes } : {}),
      // OpenCode Go validates clients by an honest User-Agent and a stable
      // per-conversation session header (their docs list both as requirements);
      // every other gateway ignores both.
      ...(settings.sessionId ? { sessionId: settings.sessionId } : {}),
      userAgent: `kicode/${VERSION}`,
      onOutcome: (route, outcome) => routeHealth.record(route, outcome),
    });

    return new Agent({
      provider,
      tools: settings.tools
        ? createDefaultTools(mcp?.tools ?? []).subset(settings.tools)
        : createDefaultTools([...(mcp?.tools ?? []), ...(settings.extraTools ?? [])], { ask: canAsk }),
      // The roster names the subagents this agent may reach, so it knows when to
      // reach for one. A child is built with `tools`, and gets no roster: the tree
      // stays flat, and a child must never be told it can delegate further.
      ...(settings.tools || agentProfiles.length === 0 ? {} : { namedSubagents: agentProfiles }),
      model,
      cwd,
      // A child carries its own, smaller ceiling: a delegated task should be
      // finished, not expanded, and a runaway child should stop on its own
      // budget rather than on the session's.
      maxTurns: settings.maxTurns ?? config.maxTurns,
      maxTokens: config.maxTokens,
      ...(settings.signal ? { signal: settings.signal } : {}),
      // The `allow` rules from kicode.json. Read-only calls bypass the prompt on
      // their own (`loop.ts`); these are the ones the user named explicitly.
      allow: allowPredicate(config.allow),
      ...(instructions ? { systemPrompt: instructions } : {}),
      // A child's own prompt wins over the directory's: the AGENTS.md block
      // describes how the user's project is worked on, and a delegated task is
      // already scoped tightly enough that the block is mostly noise it would
      // have to spend a turn reading past.
      ...(settings.systemPrompt ? { systemPrompt: settings.systemPrompt } : {}),
      ...(settings.variant && settings.variant !== "default" ? { reasoningEffort: settings.variant } : {}),
      // Plan mode is enforced inside the agent: the approval-gated tools are
      // refused outright rather than prompted for and refused every time.
      ...(settings.mode === "plan" ? { readOnly: true } : {}),
      ...(settings.approve ? { approve: settings.approve } : {}),
      ...(settings.ask ? { ask: settings.ask } : {}),
      ...(history && history.length > 0 ? { history } : {}),
      ...(config.compaction.enabled ? { compaction: config.compaction } : {}),
    });
  };

  /**
   * A child agent: this same factory with a different model, a read-only
   * toolset, and no approval or question channel.
   *
   * The prompt and the tool list are the isolation. A child that kept the
   * parent's rules would be told to ask the user questions it has no way to ask,
   * and given tools it cannot use; `--yes` is deliberately not forwarded,
   * because a child that could self-approve would be a child that could write.
   *
   * Shared by both doors — the TUI and the one-shot path — so a child is the
   * same thing whichever way the work arrived.
   */
  const buildChild = ({ goal, model, maxTurns, tools, instructions, signal }: {
    goal: string;
    context: string;
    model: string;
    maxTurns: number;
    tools: readonly string[];
    instructions: string;
    signal: AbortSignal;
  }): Agent =>
    createAgent(undefined, {
      model: model || config.delegation.model || config.model,
      baseUrl: config.delegation.baseUrl || undefined,
      cwd: io.cwd,
      // The profile's specialisation plus the standing rules, assembled once by
      // the delegate tool. Re-derived here it would be a second place for the
      // grant to be re-read.
      systemPrompt: instructions || SUBAGENT_SYSTEM_PROMPT,
      tools: tools.length > 0 ? tools : SUBAGENT_TOOLS,
      maxTurns,
      signal,
      // A distinct session id per child: a gateway that routes per conversation
      // sees each child's work as its own thread, which is what it is.
      sessionId: `subagent-${goal.slice(0, 12)}`,
    });

  /**
   * The `delegate` tool, when delegation is on.
   *
   * Built here as well as for the TUI because `kicode -p "…"` is a supported way
   * to run, and a capability that silently exists in one of the two doors is
   * worse than one that exists in neither.
   */
  const delegateToolForRun = (): Tool | null => {
    if (!config.delegation.enabled) return null;
    const registry = new SubagentRegistry();
    // One turn, so the counter only has to survive this run.
    let spawned = 0;
    const run = childRunner({
      create: buildChild,
      registry,
      model: config.delegation.model || config.model,
      maxIterations: config.delegation.maxIterations,
      limits: {
        staleMs: Math.max(1_000, config.delegation.staleMs),
        staleToolMs: Math.max(1_000, config.delegation.staleToolMs),
      },
      // Nothing to repaint here — the print path's own tool line is the only
      // feedback, and it is already saying a tool is running.
    });
    return delegateTool({
      registry,
      settings: {
        model: config.delegation.model || config.model,
        maxConcurrent: Math.max(1, config.delegation.maxConcurrent),
        maxPerTurn: Math.max(1, config.delegation.maxPerTurn),
      },
      profiles: agentProfiles,
      spawnCount: () => spawned,
      spawn: (request) => {
        spawned += 1;
        return run(request);
      },
    });
  };

  const delegate = delegateToolForRun();

  const agent = createAgent(restored ?? undefined, {
    approve: createApprover(io, flags.yes),
    ask: createAsker(io),
    ...(delegate ? { extraTools: [delegate] } : {}),
  });

  try {
    const save = async (): Promise<void> => {
      // Route health is worth writing whether or not the transcript is being
      // kept: it is what makes the next run's first choice a better one.
      await routeHealth.flush();
      if (!persist) return;
      // Nothing was asked, so there is nothing to resume. Writing an empty
      // record would make `--continue` load a blank conversation and quietly
      // look like it had lost the previous one.
      if (agent.turns.length === 0) return;
      try {
        await saveSession({
          id: sessionId,
          createdAt,
          updatedAt: new Date().toISOString(),
          cwd: io.cwd,
          model: config.model,
          baseUrl: config.baseUrl,
          messages: agent.turns,
        });
      } catch (error) {
        io.writeError(`Warning: could not save the session — ${(error as Error).message}`);
      }
    };

    if (persist) await pruneSessions().catch(() => undefined);

    // One finished turn's numbers, filed to the machine-wide log. Best-effort:
    // a usage line is convenience, and a full disk must not fail the run that
    // produced it. Outside the TUI the session never moves endpoints, so the
    // config's model and URL are the turn's.
    const recordTurn = (done: Extract<AgentEvent, { type: "done" }>): void => {
      const record = turnRecord({
        model: done.model ?? config.model,
        baseUrl: config.baseUrl,
        promptTokens: done.promptTokens ?? 0,
        completionTokens: done.completionTokens ?? 0,
        toolCalls: done.toolCalls ?? 0,
        ms: done.ms ?? 0,
      });
      if (record) void recordUsage(record).catch(() => undefined);
    };

    const inlinePrompt = flags.prompt.join(" ").trim();
    if (oneShot) {
      const prompt = inlinePrompt || (await readStdin());
      if (!prompt) {
        io.writeError("No prompt given. Pass text as an argument or pipe it on stdin.");
        return 2;
      }
      await render(agent.send(await withMentions(prompt, io.cwd)), io, recordTurn);
      await save();
      return 0;
    }

    if (tui) {
      // readline owns stdin from the moment `createIo` runs, so it has to let go
      // before the TUI can put the terminal into raw mode.
      io.close();
      /**
       * Adds one service: declares it, then reports whether it can be used yet.
       *
       * Declaring is unconditional — a base URL and the name of the variable
       * holding its key is a fact worth recording even before the key exists.
       * Whether the session can move there is a different question, and it is
       * answered by looking at the environment rather than by assuming.
       */
      const addService = async (name: string, directApiKey?: string): Promise<AddProviderResult> => {
        const service = serviceByName(name) ?? parseCustomService(name);
        if (!service) {
          return {
            ok: false,
            reason: `no service called "${name}" — use \`/connect <name> <baseUrl> [apiKeyEnv]\` or \`/connect <url>\``,
          };
        }

        const apiKey = directApiKey?.trim() || serviceApiKey(process.env, service);

        const written = await addGlobalProvider(service.name, {
          baseUrl: service.baseUrl,
          // No key in the declaration: it is read from `apiKeyEnv` on every
          // run. A key pasted here is kept in the key file alongside, and
          // `addService` returns the value for this session either way.
          ...(service.apiKeyEnv ? { apiKeyEnv: service.apiKeyEnv } : {}),
        });
        if (!written.ok) return { ok: false, reason: written.reason };
        if (directApiKey?.trim() && service.apiKeyEnv) {
          const kept = await writeStoredKey(service.apiKeyEnv, directApiKey.trim(), process.env);
          if (!kept.ok) io.writeError(kept.reason);
        }

        const ready = service.apiKeyEnv === undefined || apiKey !== "";
        endpoints.set(service.baseUrl, apiKey);
        providers = providers.filter((p) => p.name !== service.name && p.baseUrl !== service.baseUrl);
        providers.push({
          name: service.name,
          baseUrl: service.baseUrl,
          apiKey,
          apiKeyEnv: service.apiKeyEnv ?? "(no key)",
        });
        if (ready) activeProvider = service.name;

        return {
          ok: true,
          provider: service.name,
          baseUrl: service.baseUrl,
          apiKey,
          file: written.file,
          ready,
          ...(service.apiKeyEnv ? { apiKeyEnv: service.apiKeyEnv } : {}),
        };
      };

      return await runTui({
        cwd: io.cwd,
        ...(configNotice ? { notice: configNotice } : {}),
        baseUrl: restoredBaseUrl ?? config.baseUrl,
        contextTokens: config.compaction.contextTokens,
        version: VERSION,
        model: restoredModel ?? config.model,
        ...(restoredMode ? { mode: restoredMode } : {}),
        ...(restoredVariant ? { variant: restoredVariant } : {}),
        compacting: config.compaction.enabled,
        newSessionId,
        themeName,
        view: config.view,
        /** `/settings` writes to the user's own kicode.json, one key at a time. */
        saveView: (patch) => writeGlobalSettings(patch),
        saveProvider: async (name, provider) => {
          // The declaration carries no key — `addGlobalProvider` has nowhere
          // to put one — but a pasted key is still kept in the key file, so
          // adding a custom endpoint is a one-time act like `/key` is.
          const apiKeyEnv = provider.apiKeyEnv ?? apiKeyEnvFor(name);
          await addGlobalProvider(name, {
            baseUrl: provider.baseUrl,
            apiKeyEnv,
            ...(provider.models ? { models: provider.models } : {}),
          });
          if (provider.apiKey) {
            endpoints.set(provider.baseUrl, provider.apiKey);
            const kept = await writeStoredKey(apiKeyEnv, provider.apiKey, process.env);
            if (!kept.ok) io.writeError(kept.reason);
          }
          providers = providers.filter((p) => p.name !== name && p.baseUrl !== provider.baseUrl);
          providers.push({
            name,
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey ?? "",
            apiKeyEnv,
            ...(provider.models ? { models: provider.models } : {}),
          });
          activeProvider = name;
        },
        saveApiKey: async (apiKey, baseUrl = config.baseUrl) => {
          // Usable at once and kept for the next runs: the endpoint is
          // declared with the variable its key belongs in, and the value
          // itself is stored beside it in `~/.kicode/keys.json` — never in
          // `kicode.json`, which is shown and copied around. Returns that
          // variable so the UI can name it.
          endpoints.set(baseUrl, apiKey);
          const matched = providers.find((p) => p.baseUrl === baseUrl);
          const name = matched?.name ?? providerNameFor(baseUrl);
          const declared = matched?.apiKeyEnv;
          const apiKeyEnv = declared && !declared.startsWith("(") ? declared : apiKeyEnvFor(name);
          const written = await addGlobalProvider(name, { baseUrl, apiKeyEnv });
          if (!written.ok) io.writeError(written.reason);
          const kept = await writeStoredKey(apiKeyEnv, apiKey, process.env);
          if (!kept.ok) io.writeError(kept.reason);
          const entry = providers.find((p) => p.name === name);
          if (entry) {
            entry.baseUrl = baseUrl;
            entry.apiKey = apiKey;
            entry.apiKeyEnv = apiKeyEnv;
          } else {
            providers.push({ name, baseUrl, apiKey, apiKeyEnv });
          }
          return apiKeyEnv;
        },
        /**
         * `/connect` declares an endpoint, then the session moves to it.
         */
        connect: {
          list: async () => serviceRows(process.env, providers.map((provider) => provider.name)),
          add: async (name, apiKey) => addService(name, apiKey),
        },
        mcp: mcpSummary(mcp),
        config: configFiles.files.length > 0 ? configFiles.files.join("  ") : null,
        learning: config.learning,
        initial: { id: sessionId, createdAt, messages: restored ?? [] },
        listSessions: async (cwd) =>
          (await listSessions())
            .filter((record) => samePath(record.cwd, cwd))
            .map((record) => {
              const preview = sessionPreview(record);
              return {
                id: record.id,
                title: sessionTitle(record),
                ...(record.createdAt ? { createdAt: record.createdAt } : {}),
                ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
                messageCount: record.messages.length,
                ...(record.model ? { model: record.model } : {}),
                ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
                ...(record.mode === "plan" || record.mode === "build" ? { mode: record.mode } : {}),
                ...(record.variant ? { variant: record.variant } : {}),
                ...(preview ? { preview } : {}),
              };
            }),
        loadSession: async (id) => (await loadSession(id))?.messages ?? null,
        saveModel: async (model, baseUrl) => {
          await writeGlobalSettings({ model, ...(baseUrl ? { baseUrl } : {}) });
        },
        deleteSession: async (id) => {
          return await deleteSession(id);
        },
        usage: {
          record: async (record) => {
            await recordUsage(record);
          },
          history: async () => readUsage(),
        },
        saveActiveSession: async (cwd, id) => {
          await writeActiveSessionId(cwd, id);
        },
        clearActiveSession: async (cwd, id) => {
          await clearActiveSessionId(cwd, id);
        },
        // No `.catch` here on purpose: an unreachable or unauthorised gateway
        // and an endpoint that serves nothing must not look the same in /models.
        listModels: async (baseUrl) => {
          // A provider that declares its models is not asked, which is what
          // makes a small local server usable — it may serve `/chat/completions`
          // and nothing else.
          const declared = providers.find((provider) => provider.baseUrl === baseUrl)?.models;
          if (declared) return declared.map((id) => ({ id, description: describeModel({ id, free: /free/i.test(id) }) }));

          const apiKey = resolveApiKey(baseUrl);
          const models = await listModels({ apiKey, baseUrl });
          return models.map((model) => ({
            id: model.id,
            free: model.free,
            promptPrice: model.promptPrice,
            completionPrice: model.completionPrice,
            description: describeModel(model),
          }));
        },
        readClipboard,
        pickFile: () => pickFile(),
        favorites: {
          list: () => loadFavorites(),
          save: (favorites) => saveFavorites(favorites),
        },
        routeHealth: { list: async () => routeHealth.lines(), flush: () => routeHealth.flush() },
        listProviders: async () => {
          const named = providers.map((provider) => ({
            label: provider.name,
            value: provider.baseUrl,
            description: `${
              endpoints.get(provider.baseUrl) ? provider.apiKeyEnv : `no API key in ${provider.apiKeyEnv}`
            } · ${provider.baseUrl}`,
          }));
          const known = new Set(named.map((provider) => provider.value));
          // An endpoint passed with `--base-url` is a provider too: it is what
          // this session starts on, and the list has to show it or the session
          // would look like it is on nothing. There is no ambient equivalent any
          // more — an endpoint exists only because something declared it.
          return !config.baseUrl || known.has(config.baseUrl)
            ? named
            : [{ label: hostOf(config.baseUrl), value: config.baseUrl, description: config.baseUrl }, ...named];
        },
        reload: async () => {
          const files = await readConfigFiles(io.cwd);
          for (const warning of files.warnings) io.writeError(warning);
          const settings = loadConfig(process.env, fileSettingsFromEntries(files.entries).settings, {});
          return { model: settings.model, files: files.files };
        },
        exportTranscript: (messages, cwd) => exportMarkdown(messages, cwd, sessionId),
        copyToClipboard,
        gitDiff,
        initialise: (cwd) => initialiseProject(cwd, config),
        // `--yes` covers changes, not questions: asking is not a mutation.
        createAgent: (history, settings) =>
          createAgent(history, {
            ...settings,
            approve: flags.yes ? async () => "always" : settings.approve,
          }),
        delegation: {
          enabled: config.delegation.enabled,
          model: config.delegation.model,
          profiles: agentProfiles,
          maxConcurrent: config.delegation.maxConcurrent,
          maxPerTurn: config.delegation.maxPerTurn,
          maxIterations: config.delegation.maxIterations,
          staleMs: config.delegation.staleMs,
          staleToolMs: config.delegation.staleToolMs,
        },
        // A child is this same factory with a different model, a read-only
        // toolset and no approval or question channel — see `buildChild`.
        createSubagent: buildChild,
        saveSession: async ({ id, createdAt: created, cwd, messages, title, model, baseUrl: endpoint, mode, variant }) => {
          await saveSession({
            id,
            createdAt: created,
            updatedAt: new Date().toISOString(),
            cwd,
            // The session's own settings when it has them, so a later switch (or
            // a restart) can restore them; the configured defaults only for a
            // session that has never recorded any.
            model: model ?? config.model,
            baseUrl: endpoint ?? config.baseUrl,
            ...(mode ? { mode } : {}),
            ...(variant ? { variant } : {}),
            messages,
            ...(title ? { title } : {}),
          });
        },
      });
    }

    io.writeLine(`KiCode ${VERSION} — ${config.model} @ ${config.baseUrl}`);
    // Naming the files here answers "why is it using that model?" without a
    // second command — the settings are otherwise invisible at runtime.
    if (configFiles.files.length > 0) io.writeLine(`Config: ${configFiles.files.join("  ")}`);
    io.writeLine("Type a request. /exit or Ctrl+D to quit.");
    if (mcp && mcp.clients.length > 0) io.writeLine(`MCP: ${summarizeClients(mcp.clients)}`);
    if (persist) {
      io.writeLine(
        restored
          ? `Resumed session ${sessionId} (${restored.length} messages).`
          : `Session ${sessionId} — resume later with \`kicode --continue\`.`,
      );
    }
    if (!io.interactive) {
      io.writeLine("Piped input: file changes are denied. Restart in a terminal, or pass --yes.");
    }

    for (;;) {
      const line = await io.readLine("\n> ");
      if (line === null) break;
      const prompt = line.trim();
      if (!prompt) continue;

      // The catalogue is the full-screen UI's. Without it, `/models` would be
      // sent to the model as prose — which, from the outside, is exactly what a
      // command that does not work looks like.
      const command = prompt.startsWith("/") ? resolveCommand(prompt.slice(1).split(/\s+/)[0] ?? "") : undefined;
      if (command && (command.alias ?? command.name) === "exit") break;
      if (command) {
        io.writeLine(
          `/${command.name} needs the full-screen UI — run \`kicode\` in a terminal (a pipe or --no-tui has no palette).`,
        );
        continue;
      }

      await render(agent.send(await withMentions(prompt, io.cwd)), io, recordTurn);
      await save();
    }

    await save();
    return 0;
  } finally {
    await mcp?.close();
    io.close();
  }
}

/**
 * Builds the approval channel.
 *
 * `--yes` approves everything for the session. Otherwise a real terminal gets
 * an interactive prompt, and anything non-interactive gets no channel at all —
 * which the loop treats as a refusal.
 */
/**
 * The TUI takes over the alternate screen and puts the terminal into raw mode,
 * which only works on a real terminal — an `Io` that merely *can* be prompted
 * (a test harness, a piped run) has to keep the plain prompt.
 */
function canUseTui(io: Io): boolean {
  return io.interactive && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** The host of a base URL, with the scheme and the `/v1` left off. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A base URL without a trailing slash, so two spellings of it compare equal. */
function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * A provider name derived from a base URL, matching the picker's own rule.
 *
 * Used when a key is entered for an endpoint that is not in `providers` yet, so
 * the declared entry and the environment variable it names agree with what a
 * user adding the same endpoint by hand would get.
 */
function providerNameFor(baseUrl: string): string {
  return hostOf(baseUrl).replace(/\./g, "-").replace(/[^a-zA-Z0-9-]/g, "") || "custom";
}

/** The `@` index per directory, built once — the plain prompt has no `/cd`. */
const mentionIndexes = new Map<string, ReturnType<typeof buildMentionIndex>>();

/**
 * Expands `@file`, `@skill:` and `@project:` mentions into context, the same
 * expansion the full-screen prompt performs. A name that resolves to nothing
 * passes through untouched, and a directory that cannot be read never eats
 * the prompt.
 */
async function withMentions(prompt: string, cwd: string): Promise<string> {
  if (!prompt.includes("@")) return prompt;
  try {
    let cached = mentionIndexes.get(cwd);
    if (!cached) {
      cached = buildMentionIndex(cwd);
      mentionIndexes.set(cwd, cached);
    }
    return (await expandMentions(prompt, await cached)).text;
  } catch {
    return prompt;
  }
}

/** One line naming the connected MCP servers, or null when there are none. */
function mcpSummary(mcp: McpRuntime | null): string | null {
  return mcp && mcp.clients.length > 0 ? summarizeClients(mcp.clients) : null;
}

/**
 * The system prompt plus this directory's `AGENTS.md`, when it has one.
 *
 * Read synchronously because it happens inside the agent factory, which the UI
 * calls on every rebuild — and it is one small file, once per agent.
 */
function instructionsFor(cwd: string): string | undefined {
  const parts: string[] = [DEFAULT_SYSTEM_PROMPT];

  // The directory's own notes, when it has any.
  try {
    const notes = readFileSync(path.join(cwd, "AGENTS.md"), "utf8").trim();
    if (notes) {
      parts.push(
        "",
        "# AGENTS.md",
        "Instructions for this directory, written by whoever works in it. Follow them unless the user says otherwise.",
        "",
        notes,
      );
    }
  } catch {
    // No AGENTS.md: the built-in prompt already covers it.
  }

  // What earlier sessions saved. Read here, where AGENTS.md is read, so a turn
  // begins already knowing this project's memory and which skills exist —
  // rather than being told to go and look for them.
  const briefing = brainBriefing(cwd);
  if (briefing) parts.push("", briefing);

  // Nothing beyond the built-in prompt: return undefined, and the agent uses
  // its own copy of the same words rather than a second, possibly-drifted one.
  return parts.length > 1 ? parts.join("\n") : undefined;
}

/** One line about a model, for the `/models` picker. */
function describeModel(model: {
  id?: string;
  free: boolean;
  supportsTools?: boolean;
  contextLength?: number;
  promptPrice?: number;
  completionPrice?: number;
}): string {
  const hasZeroPrice =
    (model.promptPrice === 0 && model.completionPrice === 0) ||
    (model.promptPrice === 0 && model.completionPrice === undefined) ||
    (model.promptPrice === undefined && model.completionPrice === 0);
  const isFree = model.free || hasZeroPrice || (model.id ? /free/i.test(model.id) : false);
  const priceStr = formatModelPrice(model.promptPrice, model.completionPrice);
  const priceTag = isFree
    ? "FREE"
    : priceStr
      ? priceStr
      : "paid";

  return [
    priceTag,
    model.supportsTools === false ? "no tools" : "tools",
    ...(model.contextLength ? [`${Math.round(model.contextLength / 1000)}K ctx`] : []),
  ].join(" · ");
}

/** Writes the transcript as markdown next to the project, and says where. */
async function exportMarkdown(messages: readonly ChatMessage[], cwd: string, id: string): Promise<string> {
  const file = path.join(cwd, `kicode-${id}.md`);
  const lines: string[] = ["# KiCode session", "", `_${id}_`, ""];

  for (const message of messages) {
    if (message.role === "user") {
      lines.push("## You", "", withoutImages(message.content), "");
      continue;
    }
    if (message.role === "assistant") {
      if (message.content?.trim()) lines.push("## KiCode", "", message.content, "");
      for (const call of message.tool_calls ?? []) {
        lines.push("```", `→ ${call.function.name}(${call.function.arguments})`, "```", "");
      }
      continue;
    }
    if (message.role === "tool") lines.push("```", message.content, "```", "");
  }

  await writeFile(file, lines.join("\n"), "utf8");
  return file;
}

/**
 * Puts text on the system clipboard.
 *
 * Whatever the platform already ships is used rather than a dependency: a
 * clipboard is not worth breaking the zero-dependency rule over, and `/export`
 * is there when there is nothing to copy with.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  const command = process.platform === "win32" ? "clip" : process.platform === "darwin" ? "pbcopy" : "xclip";
  const args = command === "xclip" ? ["-selection", "clipboard"] : [];

  try {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    const code = await new Promise<number | null>((resolve) => {
      child.on("error", () => resolve(1));
      child.on("close", (status) => resolve(status));
      child.stdin?.end(text);
    });
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * The diff `/review` sends to the model, or null when there is nothing.
 *
 * Truncated on purpose: a review is meant to fit in the context window beside
 * the code it is about.
 */
async function gitDiff(scope: string, cwd: string): Promise<string | null> {
  const args = ["diff", "--no-color", ...(scope === "uncommitted" ? [] : [scope])];

  try {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));

    const code = await new Promise<number | null>((resolve) => {
      child.on("error", () => resolve(1));
      child.on("close", (status) => resolve(status));
    });

    if (code !== 0 || !out.trim()) return null;
    const limit = 12_000;
    return out.length > limit ? `${out.slice(0, limit)}\n… diff truncated at ${limit} characters` : out;
  } catch {
    return null;
  }
}

const STARTER_AGENTS = [
  "# AGENTS.md",
  "",
  "Notes for agents working in this project. KiCode reads this file at startup.",
  "",
  "## Commands",
  "",
  "- Build:",
  "- Test:",
  "",
  "## Conventions",
  "",
  "- ",
  "",
].join("\n");

/**
 * `/init`: the two files a fresh project wants.
 *
 * `kicode.json` records the settings in use, and a missing `AGENTS.md` gets a
 * skeleton — which the agent already reads, so the file is worth writing.
 */
async function initialiseProject(
  cwd: string,
  config: Config,
): Promise<{ file: string; status: string; agents: string | null; blocked?: boolean }> {
  const outcome = await writeProjectConfig(cwd, config);
  if (outcome.status === "blocked") {
    return { file: outcome.file, status: outcome.status, agents: null, blocked: true };
  }

  let agents: string | null = null;
  const target = path.join(cwd, "AGENTS.md");
  try {
    await readFile(target, "utf8");
  } catch {
    await writeFile(target, STARTER_AGENTS, "utf8");
    agents = "AGENTS.md";
  }

  return { file: outcome.file, status: outcome.status, agents };
}

/**
 * The plain-prompt question channel.
 *
 * The TUI draws a panel; without it the questions are printed and answered by
 * number, which keeps `--no-tui` a real fallback rather than a mode where the
 * model cannot ask anything.
 */
function createAsker(io: Io): AskFn | undefined {
  if (!io.interactive) return undefined;

  return async (request) => {
    const answers: AskAnswer[] = [];

    for (const question of request.questions) {
      io.writeLine();
      io.writeLine(`? ${question.header}: ${question.question}`);
      for (const [index, option] of question.options.entries()) {
        io.writeLine(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
      }
      io.writeLine(`  ${question.options.length + 1}. Type your own answer`);

      const choice = ((await io.readLine("  > ")) ?? "").trim();
      const number = Number(choice);

      if (!choice) {
        answers.push({ header: question.header, answer: "", dismissed: true });
      } else if (Number.isInteger(number) && number >= 1 && number <= question.options.length) {
        answers.push({ header: question.header, answer: question.options[number - 1]?.label ?? "", dismissed: false });
      } else if (Number.isInteger(number) && number === question.options.length + 1) {
        const typed = ((await io.readLine("  your answer > ")) ?? "").trim();
        answers.push({ header: question.header, answer: typed, dismissed: !typed });
      } else {
        // Anything else is taken as the answer itself, which is faster than
        // walking through the free-text option.
        answers.push({ header: question.header, answer: choice, dismissed: false });
      }
    }

    return answers;
  };
}

function createApprover(io: Io, autoApprove: boolean): ApproveFn | undefined {
  if (autoApprove) return async () => "always";
  if (!io.interactive) return undefined;

  return async (request) => {
    io.writeLine();
    io.writeLine(`⚠ ${request.name} wants to run${request.preview ? ":" : "."}`);
    if (request.preview) io.writeLine(request.preview);

    const answer = ((await io.readLine("Allow? [y]es / [n]o / [a]lways: ")) ?? "").trim().toLowerCase();
    if (answer === "a" || answer === "always") return "always";
    if (answer === "y" || answer === "yes") return "allow";
    return "deny";
  };
}

/** Renders agent events to the terminal as they arrive. */
async function render(
  events: AsyncGenerator<AgentEvent, void, void>,
  io: Io,
  record?: (done: Extract<AgentEvent, { type: "done" }>) => void,
): Promise<void> {
  for await (const event of events) {
    switch (event.type) {
      case "text":
        io.write(event.delta);
        break;
      case "tool-start":
        io.writeLine(`\u001b[2m→ ${event.name}(${preview(event.args)})\u001b[0m`);
        break;
      case "tool-result":
        io.writeLine(`\u001b[2m${event.isError ? "✕" : "✓"} ${preview(event.content, 240)}\u001b[0m`);
        break;
      case "compacted":
        io.writeLine(
          `\u001b[2m[compacted ${event.summarized} earlier messages: ~${event.before} → ~${event.after} tokens, target ~${event.target}]\u001b[0m`,
        );
        break;
      case "continued":
        io.writeLine(
          `\u001b[2m${
            event.reason === "empty"
              ? "the model answered with nothing — asking again"
              : event.reason === "steered"
                ? "you added to this turn — answering it now"
                : event.reason === "work"
                  ? "tracked work is not finished — asking it to carry on"
                  : "the reply was cut off — asking it to carry on"
          }\u001b[0m`,
        );
        break;
      case "done":
        // A turn that ran out of requests ended on its own account, and the
        // blank line underneath would otherwise be the whole explanation.
        if (event.reason === "max-turns") io.writeLine("\u001b[2mturn budget reached\u001b[0m");
        // The turn's own cost, filed where `--usage` reads it back.
        record?.(event);
        io.writeLine();
        break;
    }
  }
}

function preview(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

type Flags = {
  help: boolean;
  version: boolean;
  print: boolean;
  yes: boolean;
  models: boolean;
  usage: boolean;
  json: boolean;
  init: boolean;
  probe: boolean;
  tui: boolean;
  tuiPreview: boolean;
  mcp: boolean;
  compact: boolean;
  continue: boolean;
  session?: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  maxTokens?: number;
  theme?: string;
  prompt: string[];
};

function parseArgs(argv: string[]): { flags: Flags } | { error: string } {
  const flags: Flags = {
    help: false,
    version: false,
    print: false,
    yes: false,
    models: false,
    usage: false,
    json: false,
    init: false,
    probe: false,
    tui: true,
    tuiPreview: false,
    mcp: true,
    compact: true,
    continue: false,
    prompt: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--") {
      flags.prompt.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      flags.version = true;
      continue;
    }
    if (arg === "-p" || arg === "--print") {
      flags.print = true;
      continue;
    }
    if (arg === "-y" || arg === "--yes") {
      flags.yes = true;
      continue;
    }
    if (arg === "-c" || arg === "--continue") {
      flags.continue = true;
      continue;
    }
    if (arg === "--models") {
      flags.models = true;
      continue;
    }
    if (arg === "--usage") {
      flags.usage = true;
      continue;
    }
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--init") {
      flags.init = true;
      continue;
    }
    if (arg === "--probe") {
      flags.probe = true;
      continue;
    }
    if (arg === "--no-tui") {
      flags.tui = false;
      continue;
    }
    if (arg === "--tui-preview") {
      flags.tuiPreview = true;
      continue;
    }
    if (arg === "--no-mcp") {
      flags.mcp = false;
      continue;
    }
    if (arg === "--no-compact") {
      flags.compact = false;
      continue;
    }
    if (arg === "--theme") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) return { error: "Missing value for --theme." };
      flags.theme = value;
      i++;
      continue;
    }
    if (arg.startsWith("--theme=")) {
      flags.theme = arg.slice("--theme=".length);
      continue;
    }
    if (arg === "--session") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) return { error: "Missing value for --session." };
      flags.session = value;
      i++;
      continue;
    }
    if (arg.startsWith("--session=")) {
      flags.session = arg.slice("--session=".length);
      continue;
    }
    if (arg === "--max-tokens") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) return { error: "Missing value for --max-tokens." };
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) return { error: "--max-tokens expects a number of tokens (0 for no limit)." };
      flags.maxTokens = Math.trunc(parsed);
      i++;
      continue;
    }
    if (arg.startsWith("--max-tokens=")) {
      const value = arg.slice("--max-tokens=".length);
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) return { error: "--max-tokens expects a number of tokens (0 for no limit)." };
      flags.maxTokens = Math.trunc(parsed);
      continue;
    }
    if (arg === "--model" || arg === "--provider" || arg === "--base-url" || arg === "--api-key") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) return { error: `Missing value for ${arg}.` };
      if (arg === "--model") flags.model = value;
      else if (arg === "--provider") flags.provider = value;
      else if (arg === "--base-url") flags.baseUrl = value;
      else flags.apiKey = value;
      i++;
      continue;
    }
    if (arg.startsWith("--model=")) {
      flags.model = arg.slice("--model=".length);
      continue;
    }
    if (arg.startsWith("--base-url=")) {
      flags.baseUrl = arg.slice("--base-url=".length);
      continue;
    }
    if (arg.startsWith("--api-key=")) {
      flags.apiKey = arg.slice("--api-key=".length);
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") return { error: `Unknown option: ${arg}.` };

    flags.prompt.push(arg);
  }

  return { flags };
}
