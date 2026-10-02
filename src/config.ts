/**
 * Configuration resolution: CLI flags > environment > defaults.
 *
 * The key is deliberately environment-only — `kicode.json` carries settings but
 * never a credential, so there is no on-disk secret to leak or commit.
 */

import { COMPACT_TARGET_PERCENT } from "./agent/compaction";
import { DEFAULT_MAX_TURNS } from "./agent/loop";
import type { FileSettings } from "./settings-file";
import { DEFAULT_THEME } from "./tui/theme";
import { type ViewSettings, viewFrom } from "./tui/settings";

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "deepseek-v4-flash";
/**
 * The turn budget, owned by the loop that spends it.
 *
 * Re-exported rather than restated: `--init` and the config file name it, and a
 * second copy of the number is how the two would drift apart.
 */
export { DEFAULT_MAX_TURNS };
export const DEFAULT_CONTEXT_TOKENS = 128_000;
export const DEFAULT_RESERVE_TOKENS = 8_000;
/** The estimate at which a session is compacted, even inside a larger window. */
export const DEFAULT_COMPACT_AT_TOKENS = 100_000;
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
};

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
   * Whether a finished turn runs the learning pass over the transcript.
   *
   * On by default: a brain that only fills when the model remembers to call
   * `remember` is the half-built version this pass exists to finish. `off`
   * turns it back into a strict BYO-attention bargain — no extra request.
   */
  learning: "off" | "auto";
  compaction: CompactionSettings;
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
 * Resolution order: flags > `kicode.json` > environment > defaults.
 *
 * A config file beats the environment deliberately. An ambient variable like
 * `OPENAI_BASE_URL` is usually there for some other tool, and silently
 * redirecting KiCode to a different gateway is a confusing failure — an
 * explicit project file is the thing that should win.
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
  const chosen = selectProvider(providers, overrides.provider ?? undefined, file.provider, env.KICODE_PROVIDER);

  const baseUrl = stripTrailingSlashes(
    overrides.baseUrl ??
      file.baseUrl ??
      chosen.baseUrl ??
      (mock ? MOCK_BASE_URL : env.KICODE_BASE_URL ?? env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL),
  );

  // The mock gets a placeholder key rather than a real one, so a real key can
  // never be sent to a local server by accident.
  const apiKey = (
    overrides.apiKey ??
    (mock ? MOCK_API_KEY : file.apiKey ?? chosen.apiKey ?? env.KICODE_API_KEY ?? env.OPENAI_API_KEY ?? "")
  ).trim();

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
    maxTurns: overrides.maxTurns ?? DEFAULT_MAX_TURNS,
    fallback: readFallback(env, file, providers, chosen.name, baseUrl, apiKey, model),
    fallbackAuto: readFallbackAuto(env, file),
    maxTokens: overrides.maxTokens ?? file.maxTokens ?? intFrom(env.KICODE_MAX_TOKENS, 0),
    learning: readLearning(env, file),
    compaction: {
      enabled: overrides.compact === false ? false : compaction.enabled !== false,
      contextTokens: compaction.contextTokens ?? intFrom(env.KICODE_CONTEXT_TOKENS, DEFAULT_CONTEXT_TOKENS),
      reserveTokens: compaction.reserveTokens ?? intFrom(env.KICODE_RESERVE_TOKENS, DEFAULT_RESERVE_TOKENS),
      targetPercent: compaction.targetPercent ?? intFrom(env.KICODE_COMPACT_TARGET, DEFAULT_COMPACT_TARGET_PERCENT),
      compactAt: compaction.compactAt ?? intFrom(env.KICODE_COMPACT_AT, DEFAULT_COMPACT_AT_TOKENS),
    },
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
function readProviders(
  env: NodeJS.ProcessEnv,
  declared: Record<string, { baseUrl: string; apiKey?: string; apiKeyEnv?: string; models?: string[] }>,
  mock: boolean,
): ProviderConfig[] {
  const providers: ProviderConfig[] = [];

  for (const [name, entry] of Object.entries(declared)) {
    const apiKeyEnv = entry.apiKeyEnv ?? `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
    let apiKey = (entry.apiKey ?? env[apiKeyEnv] ?? "").trim();
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
