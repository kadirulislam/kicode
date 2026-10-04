/**
 * Configuration resolution: flags > `kicode.json` > defaults.
 *
 * The environment is not a provider. It can only hold the *key* for a provider
 * the config already declares, in the variable that provider names as its
 * `apiKeyEnv`. Nothing in the environment — `OPENAI_API_KEY`, `OPENAI_BASE_URL`
 * or KiCode's own `KICODE_*` names — can call an endpoint into existence,
 * because an ambient variable belongs to whatever else set it: a first run that
 * silently borrowed one talked to a gateway its owner never chose, and could
 * not say why it worked. A fresh install has no provider until its owner adds
 * one with `/connect`.
 *
 * The key is deliberately environment-only — `kicode.json` carries settings but
 * never a credential, so there is no on-disk secret to leak or commit. That is
 * enforced in both directions: nothing writes one (`settings-write.ts` has no
 * field for it) and one found in a file is reported and ignored
 * (`settings-file.ts`), which is what makes the sentence above true rather
 * than aspirational.
 */

import { COMPACT_TARGET_PERCENT } from "./agent/compaction";
import { DEFAULT_MAX_TURNS } from "./agent/loop";
import type { FileSettings } from "./settings-file";
import { DEFAULT_THEME } from "./tui/theme";
import { type ViewSettings, viewFrom } from "./tui/settings";

/**
 * The model a session starts on before anything names one.
 *
 * There is no default *endpoint* to pair it with any more — a provider has to be
 * declared (ADR-041) — so this is a first guess rather than a promise. It is
 * what the box shows until `/models` reads the endpoint's own list, and
 * `KICODE_MODEL` or `"model"` in `kicode.json` replace it.
 */
export const DEFAULT_MODEL = "gpt-4o-mini";
/**
 * The turn budget, owned by the loop that spends it.
 *
 * Re-exported rather than restated: `--init` and the config file name it, and a
 * second copy of the number is how the two would drift apart.
 */
export { DEFAULT_MAX_TURNS };
export const DEFAULT_CONTEXT_TOKENS = 200_000;
export const DEFAULT_RESERVE_TOKENS = 8_000;
/**
 * The estimate at which a session is compacted, even inside a larger window.
 *
 * This is the number that actually fires, not the window: `shouldCompact` takes
 * the smaller of the two, so the default window has to stay comfortably above
 * it or the window would decide instead and this ceiling would never be the one
 * to trigger. It is set to where a session is worth summarising rather than to
 * the line where it stops fitting — compaction that waits for the edge has no
 * room left for the reply or the next round of tool results, which is what the
 * reserve is for.
 */
export const DEFAULT_COMPACT_AT_TOKENS = 150_000;
/**
 * Where a compacted session is left sitting in its window, as a percentage.
 *
 * The same number `compaction.ts` defaults to, re-exported so `--init` and the
 * config file can name it rather than each carrying their own copy.
 */
export const DEFAULT_COMPACT_TARGET_PERCENT = COMPACT_TARGET_PERCENT;

export type CompactionSettings = {
  enabled: boolean;
  contextTokens: number;
  reserveTokens: number;
  /** Where a compacted session sits in the window. Clamped to the 30–50 band. */
  targetPercent: number;
  compactAt: number;
};

/**
 * One endpoint KiCode can talk to, and where its key comes from.
 *
 * The key is resolved from the environment when the config is loaded, so a
 * provider that is declared but unconfigured is still listed — with no key —
 * and can say so rather than looking like it does not exist.
 */
export type ProviderConfig = {
  name: string;
  baseUrl: string;
  apiKey: string;
  /** The variable the key was looked for in, for an honest error message. */
  apiKeyEnv: string;
  /** Only these models, when the endpoint cannot be asked. */
  models?: string[];
};

/**
 * One backup route: an endpoint and the model to ask for there.
 *
 * Everything the fallback provider needs to replay a request, resolved at
 * load time so a route with no usable key is a quiet, visible gap rather than
 * a 401 halfway through a conversation.
 */
export type FallbackRoute = {
  /** For the UI: `provider/model`, or just the model when nothing was named. */
  label: string;
  provider: string | null;
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * What to say when the route has no key to send. Set when the caller knows
   * which variable is missing; absent means keyless is legitimate and the
   * request goes out as before.
   */
  keyHint?: string;
};

/**
 * How this session hands work to child agents.
 *
 * A single pin rather than a per-role one, deliberately: the model that spawns
 * children is not the thing that should decide which endpoint they run on, and
 * one predictable pin is one less thing to get wrong. Decomposing a problem
 * needs frontier judgement; executing a well-specified subtask usually does not —
 * so the default shape is a frontier parent with cheaper children, and
 * `model`/`baseUrl` left empty simply mean "whatever the parent is using".
 */
export type DelegationSettings = {
  /** Off means the `delegate` tool is not registered at all, rather than refused. */
  enabled: boolean;
  /** Model every child runs on. Empty means the parent's own model. */
  model: string;
  /** Endpoint every child runs on. Empty means the parent's own endpoint. */
  baseUrl: string;
  /** Children allowed to run at once within one `delegate` call. */
  maxConcurrent: number;
  /** Children one parent turn may spawn in total. */
  maxPerTurn: number;
  /** Requests one child may make before it returns whatever it has. */
  maxIterations: number;
  /**
   * Idle time after which a child counts as wedged and is abandoned.
   *
   * A wall-clock cap is the wrong instrument: it kills legitimate long work —
   * a deep review needs minutes and keeps making progress the whole time. This
   * measures *silence*, so a slow child is never touched and a stuck one is
   * caught. The in-tool figure is higher because a legitimate long command or
   * fetch is also silent.
   */
  staleMs: number;
  staleToolMs: number;
};

export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 4;
export const DEFAULT_MAX_SUBAGENTS_PER_TURN = 8;
export const DEFAULT_SUBAGENT_ITERATIONS = 60;
export const DEFAULT_SUBAGENT_STALE_MS = 450_000;
export const DEFAULT_SUBAGENT_STALE_TOOL_MS = 1_200_000;

export type Config = {
  apiKey: string;
  baseUrl: string;
  /** The provider `baseUrl`/`apiKey` came from, or null for the ambient one. */
  provider: string | null;
  providers: ProviderConfig[];
  model: string;
  /** The colour theme by name. `/themes` lists what is available. */
  theme: string;
  /**
   * Everything `/settings` shows — the theme, and what the transcript draws.
   * `theme` above is the same value, kept because it was here first.
   */
  view: ViewSettings;
  maxTurns: number;
  /** Routes to try, in order, when the one in use fails. Empty when off. */
  fallback: FallbackRoute[];
  /**
   * Whether a free model implicitly falls back to the endpoint's other free
   * models when it fails, instead of the turn failing into the recovery modal.
   * Explicit `fallback` routes always come first; this only ever adds free
   * routes, never a paid one. Off unless asked for.
   */
  fallbackAuto: boolean;
  /** Session token ceiling. 0 means no ceiling. */
  maxTokens: number;
  /**
   * Command prefixes that skip the approval prompt, per tool name.
   *
   * Checked before the prompt, and only for a tool that is gated at all. This
   * is the one setting that can let something run without being read first, so
   * it is an exact, explicit prefix match and nothing cleverer — and the prompt
   * it skips is the only place the command would have been shown.
   */
  allow: Record<string, string[]>;
  /**
   * Whether a finished turn runs the learning pass over the transcript.
   *
   * On by default: a brain that only fills when the model remembers to call
   * `remember` is the half-built version this pass exists to finish. `off`
   * turns it back into a strict BYO-attention bargain — no extra request.
   */
  learning: "off" | "auto";
  compaction: CompactionSettings;
  delegation: DelegationSettings;
};

/** What the bundled mock provider serves, for the `mock` shorthand. */
export const MOCK_BASE_URL = "http://localhost:8787/v1";
export const MOCK_API_KEY = "local";

export type ConfigOverrides = Partial<
  Pick<Config, "apiKey" | "baseUrl" | "model" | "theme" | "maxTurns" | "provider" | "maxTokens">
> & {
  compact?: boolean;
};

/**
 * Resolution order: flags > `kicode.json` > defaults.
 *
 * A provider has to be *declared* to exist. The environment cannot add one and
 * cannot redirect the one in use: `OPENAI_BASE_URL` is usually set for some
 * other tool, and a first run that quietly borrowed it talked to a gateway its
 * owner never chose. Declaring a provider is one deliberate act — `/connect`
 * writes it, or the file is edited — and until that happens there is nothing to
 * talk to.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  file: FileSettings = {},
  overrides: ConfigOverrides = {},
): Config {
  // An explicit baseUrl beats the shorthand, and `mock` then does nothing.
  const mock = file.mock === true && file.baseUrl === undefined;

  const providers = readProviders(env, file.providers ?? {}, mock);
  // The named provider is picked before anything else is looked at, so
  // `providers` is what selects an endpoint and `baseUrl` stays an override.
  const asked = overrides.provider ?? file.provider ?? env.KICODE_PROVIDER;
  const picked = selectProvider(providers, overrides.provider ?? undefined, file.provider, env.KICODE_PROVIDER);
  // One declared provider and no name given is not ambiguous: it is the only
  // place to go. It is also exactly the shape `/connect` leaves behind — it
  // declares a provider and does not name one — so a service added from the UI
  // is in use as soon as it is added, rather than leaving the session
  // configured and still unstartable.
  const only = providers.length === 1 ? providers[0] : undefined;
  const chosen =
    picked.name === null && only && !asked
      ? { name: only.name, baseUrl: only.baseUrl, apiKey: only.apiKey }
      : picked;

  // No environment fallback, on purpose: an endpoint KiCode was never told
  // about is not a configured endpoint. Empty means "no provider yet", which
  // `validateConfig` reports as its own problem with its own remedy.
  const baseUrl = stripTrailingSlashes(
    overrides.baseUrl ?? file.baseUrl ?? chosen.baseUrl ?? (mock ? MOCK_BASE_URL : ""),
  );

  // The mock gets a placeholder key rather than a real one, so a real key can
  // never be sent to a local server by accident.
  // No `file.apiKey` in this chain, deliberately: a key found in a config file
  // is reported and ignored (`settings-file.ts`). Only a declared provider's own
  // `apiKeyEnv` — read in `readProviders` — or an explicit flag supplies one, so
  // a key in the environment is only ever used because a provider asked for it
  // by name.
  const apiKey = (overrides.apiKey ?? (mock ? MOCK_API_KEY : chosen.apiKey ?? "")).trim();

  const compaction = file.compaction ?? {};
  const model = (overrides.model ?? file.model ?? env.KICODE_MODEL ?? DEFAULT_MODEL).trim();
  const theme = (overrides.theme ?? file.theme ?? env.KICODE_THEME ?? DEFAULT_THEME).trim() || DEFAULT_THEME;

  return {
    apiKey,
    baseUrl,
    provider: chosen.name,
    providers: providers.map((provider) =>
      provider.baseUrl === baseUrl ? { ...provider, apiKey: provider.apiKey || apiKey } : provider,
    ),
    model,
    // A theme is a preference, not a capability, so a name that is not one of
    // ours is reported at startup and never blocks the run — see `run.ts`.
    theme,
    view: viewFrom(theme, file.view ?? {}),
    // How many requests one turn may spend. A real task can run long, so this
    // is a settable ceiling rather than a constant: `kicode.json` `maxTurns`,
    // then `KICODE_MAX_TURNS`, then the default. Hitting it is not a failure —
    // the turn stops and says so, and anything sent next carries on.
    maxTurns: overrides.maxTurns ?? file.maxTurns ?? intFrom(env.KICODE_MAX_TURNS, DEFAULT_MAX_TURNS),
    fallback: readFallback(env, file, providers, chosen.name, baseUrl, apiKey, model),
    fallbackAuto: readFallbackAuto(env, file),
    maxTokens: overrides.maxTokens ?? file.maxTokens ?? intFrom(env.KICODE_MAX_TOKENS, 0),
    allow: file.allow ?? {},
    learning: readLearning(env, file),
    compaction: {
      enabled: overrides.compact === false ? false : compaction.enabled !== false,
      contextTokens: compaction.contextTokens ?? intFrom(env.KICODE_CONTEXT_TOKENS, DEFAULT_CONTEXT_TOKENS),
      reserveTokens: compaction.reserveTokens ?? intFrom(env.KICODE_RESERVE_TOKENS, DEFAULT_RESERVE_TOKENS),
      targetPercent: compaction.targetPercent ?? intFrom(env.KICODE_COMPACT_TARGET, DEFAULT_COMPACT_TARGET_PERCENT),
      compactAt: compaction.compactAt ?? intFrom(env.KICODE_COMPACT_AT, DEFAULT_COMPACT_AT_TOKENS),
    },
    delegation: readDelegation(env, file),
  };
}

/**
 * Whether child agents may be spawned at all, and on what.
 *
 * `KICODE_DELEGATION=off` (or `"enabled": false` in `kicode.json`) turns it off;
 * anything else leaves it on. An environment switch as well as a setting,
 * because the thing it spends is the user's money per turn and needs to be
 * stoppable without editing a file that may be committed.
 */
function readDelegation(env: NodeJS.ProcessEnv, file: FileSettings): DelegationSettings {
  const declared = file.delegation ?? {};
  const flag = env.KICODE_DELEGATION?.trim().toLowerCase();
  const enabled =
    flag === "off" || flag === "false" || flag === "0" || flag === "no"
      ? false
      : flag !== undefined && flag !== ""
        ? true
        : declared.enabled !== false;
  return {
    enabled,
    model: (declared.model ?? env.KICODE_DELEGATION_MODEL ?? "").trim(),
    baseUrl: (declared.baseUrl ?? "").trim(),
    maxConcurrent: intFrom(
      String(declared.maxConcurrent ?? env.KICODE_DELEGATION_CONCURRENT ?? ""),
      DEFAULT_MAX_CONCURRENT_SUBAGENTS,
    ),
    maxPerTurn: intFrom(
      String(declared.maxPerTurn ?? env.KICODE_DELEGATION_PER_TURN ?? ""),
      DEFAULT_MAX_SUBAGENTS_PER_TURN,
    ),
    maxIterations: intFrom(
      String(declared.maxIterations ?? env.KICODE_DELEGATION_ITERATIONS ?? ""),
      DEFAULT_SUBAGENT_ITERATIONS,
    ),
    staleMs: intFrom(String(declared.staleMs ?? ""), DEFAULT_SUBAGENT_STALE_MS),
    staleToolMs: intFrom(String(declared.staleToolMs ?? ""), DEFAULT_SUBAGENT_STALE_TOOL_MS),
  };
}

/**
 * The backup routes a config declares, in the order they will be tried.
 *
 * Two shapes, because the common cases are different:
 *
 * - `fallbackModels` names other models on the endpoint already in use — the
 *   one-line way to say "when this free route is used up, try the other free
 *   ones".
 * - `fallback` is a list of `{ provider, model }` (or `{ baseUrl, model }`)
 *   for routing across gateways, where the backup lives somewhere else.
 *
 * The model in use is never a backup for itself: the same request to the same
 * route that just failed only burns the wait again.
 */
function readFallback(
  env: NodeJS.ProcessEnv,
  file: FileSettings,
  providers: readonly ProviderConfig[],
  primaryProvider: string | null,
  primaryBaseUrl: string,
  primaryKey: string,
  primaryModel: string,
): FallbackRoute[] {
  const routes: FallbackRoute[] = [];
  const seen = new Set<string>([routeKey(primaryBaseUrl, primaryModel)]);

  const add = (provider: string | null, baseUrl: string, apiKey: string, model: string): void => {
    const trimmed = model.trim();
    if (!trimmed) return;
    const key = routeKey(baseUrl, trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({ label: provider ? `${provider}/${trimmed}` : trimmed, provider, baseUrl, apiKey, model: trimmed });
  };

  const sameEndpoint = [...(file.fallbackModels ?? []), ...splitList(env.KICODE_FALLBACK_MODELS)];
  for (const model of sameEndpoint) add(primaryProvider, primaryBaseUrl, primaryKey, model);

  for (const entry of file.fallback ?? []) {
    const named = entry.provider
      ? providers.find((provider) => provider.name.toLowerCase() === entry.provider?.toLowerCase())
      : undefined;
    const baseUrl = named?.baseUrl ?? entry.baseUrl ?? primaryBaseUrl;
    // The key follows the endpoint: a declared provider knows its own, the
    // endpoint in use borrows the session's, and a bare URL has none to borrow.
    const apiKey =
      named?.apiKey ??
      (baseUrl === primaryBaseUrl ? primaryKey : providers.find((provider) => provider.baseUrl === baseUrl)?.apiKey ?? "");
    add(named?.name ?? entry.provider ?? null, baseUrl, apiKey, entry.model);
  }

  return routes;
}

/**
 * Whether a free model may pick up the endpoint's other free models on its own.
 *
 * Off by default: a failed turn is a decision the user makes — the recovery
 * modal offers retry and another model — not something the router settles
 * alone. `"fallbackAuto": true` in `kicode.json`, or `KICODE_FALLBACK_AUTO=on`,
 * hands it back to the router. Only free models are ever added, whatever this
 * says; explicitly declared `fallback` routes are unaffected and always tried.
 */
function readFallbackAuto(env: NodeJS.ProcessEnv, file: FileSettings): boolean {
  const declared = env.KICODE_FALLBACK_AUTO?.trim().toLowerCase();
  if (declared === "on" || declared === "true" || declared === "1" || declared === "yes") return true;
  if (declared !== undefined && declared !== "") return false;
  return file.fallbackAuto === true;
}

/**
 * Whether the automatic learning pass runs.
 *
 * `KICODE_LEARNING=off` (or `"learning": "off"` in `kicode.json`) turns it off;
 * anything else leaves it on. Kept as an environment escape hatch as well as a
 * setting, because the thing it spends is the user's money per turn.
 */
function readLearning(env: NodeJS.ProcessEnv, file: FileSettings): "off" | "auto" {
  const declared = env.KICODE_LEARNING?.trim().toLowerCase();
  if (declared === "off" || declared === "false" || declared === "0" || declared === "no") return "off";
  if (declared !== undefined && declared !== "") return "auto";
  return file.learning === "off" ? "off" : "auto";
}

/** Identifies a route for de-duplication: an endpoint plus a model. */
function routeKey(baseUrl: string, model: string): string {
  return `${baseUrl}\u0000${model}`;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function intFrom(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

/** Returns a human-readable problem, or null when the config is usable. */
export function validateConfig(config: Config): string | null {
  // Two different first-run states with two different remedies — declaring an
  // endpoint, and setting the key for one that exists. Collapsing them would
  // send someone to fix the wrong thing; and with no endpoint there is no
  // variable to name, so the key message has to come second.
  if (!config.baseUrl) {
    return config.providers.length
      ? 'No provider is selected — name the one to use with "provider" in kicode.json.'
      : "No provider is configured yet.";
  }
  if (!config.apiKey) {
    // A named provider knows which variable it wanted, so it says so: "no key"
    // and "the wrong variable name in kicode.json" are different problems.
    const named = config.providers.find((provider) => provider.name === config.provider);
    return named
      ? `No API key for provider "${named.name}" — set ${named.apiKeyEnv}.`
      : "No API key found.";
  }
  if (!/^https?:\/\//i.test(config.baseUrl)) {
    return `Base URL must start with http:// or https:// — got "${config.baseUrl}".`;
  }
  if (!config.model) return "No model selected.";
  return null;
}

function stripTrailingSlashes(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * The providers a config declares, in declaration order.
 *
 * A key is looked for in the variable the provider names, then in the one its
 * name suggests (`TOKENHARBOR_API_KEY` for `tokenharbor`). A provider with no
 * key is kept: it belongs in the list so the model picker can say which one is
 * missing a credential rather than quietly omitting it.
 */
/**
 * The environment variable a provider's key is read from.
 *
 * One rule, one place: the name the provider declared, or the one its own name
 * suggests. `run.ts` names the variable to the user after `/key`, and the
 * settings reader uses the same rule to reject a key written into a file.
 */
export function apiKeyEnvFor(name: string): string {
  return `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function readProviders(
  env: NodeJS.ProcessEnv,
  declared: Record<string, { baseUrl: string; apiKeyEnv?: string; models?: string[] }>,
  mock: boolean,
): ProviderConfig[] {
  const providers: ProviderConfig[] = [];

  for (const [name, entry] of Object.entries(declared)) {
    const apiKeyEnv = entry.apiKeyEnv ?? apiKeyEnvFor(name);
    let apiKey = (env[apiKeyEnv] ?? "").trim();
    if (!apiKey && (name === "tokenharbor" || name === "tokenharbour")) {
      apiKey = (env.TOKENHARBOR_API_KEY ?? env.TOKENHARBOUR_API_KEY ?? "").trim();
    }
    providers.push({
      name,
      baseUrl: stripTrailingSlashes(entry.baseUrl),
      apiKey,
      apiKeyEnv,
      ...(entry.models ? { models: [...entry.models] } : {}),
    });
  }

  if (mock) {
    providers.push({ name: "mock", baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY, apiKeyEnv: "(bundled)" });
  }

  return providers;
}

/** The provider a name points at, or nothing when none was named. */
function selectProvider(
  providers: readonly ProviderConfig[],
  ...names: (string | undefined)[]
): { name: string | null; baseUrl: string | undefined; apiKey: string | undefined } {
  for (const name of names) {
    if (!name) continue;
    const match = providers.find((provider) => provider.name.toLowerCase() === name.toLowerCase());
    if (match) return { name: match.name, baseUrl: match.baseUrl, apiKey: match.apiKey };
  }
  return { name: null, baseUrl: undefined, apiKey: undefined };
}
