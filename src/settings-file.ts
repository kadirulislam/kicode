import { apiKeyEnvFor } from "./config";
import type { ConfigFileEntry } from "./config-file";
import { MAX_SPACING, SETTING_KEYS, SPACING_KEYS, settingOptions, type Spacing, type ViewOverrides } from "./tui/settings";

/**
 * The non-MCP half of `kicode.json`:
 *
 * ```jsonc
 * {
 *   "provider": "tokenharbor",
 *   "model": "deepseek-v4-flash:free",
 *   "providers": {
 *     "tokenharbor": { "baseUrl": "https://tokenharbor.ai/v1", "apiKeyEnv": "TOKENHARBOR_API_KEY" },
 *     "local": { "baseUrl": "http://localhost:11434/v1", "models": ["qwen3:8b"] }
 *   },
 *   "compaction": { "contextTokens": 200000, "targetPercent": 40 },
 *   "thinking": "hide",
 *   "spacing": { "block": 1, "entry": 1, "turn": 2 },
 *   "mcp": { … }
 * }
 * ```
 *
 * There is deliberately no place for an API key — not even per provider. A
 * project file is committed and shared, which is exactly the wrong place for a
 * secret; a provider names the environment variable that holds its key instead
 * (`apiKeyEnv`), and a key found here is reported and ignored.
 */

export type FileCompactionSettings = {
  enabled?: boolean;
  contextTokens?: number;
  reserveTokens?: number;
  targetPercent?: number;
  compactAt?: number;
};

export type FileProvider = {
  baseUrl: string;
  /**
   * The environment variable holding this provider's key.
   *
   * There is no `apiKey` field on purpose: a key found in a file is reported
   * and ignored, and nothing here writes one (`settings-write.ts`).
   */
  apiKeyEnv?: string;
  /** Only these models, instead of asking the endpoint. For a local server. */
  models?: string[];
};

/** One backup route in `fallback`: a model, on a provider or a bare endpoint. */
export type FileFallbackRoute = {
  model: string;
  /** A name from `providers` — the usual way, since it carries the key. */
  provider?: string;
  /** Or an endpoint of its own, when it is not declared in `providers`. */
  baseUrl?: string;
};

/**
 * The `delegation` block of `kicode.json`:
 *
 * ```jsonc
 * { "delegation": { "model": "gemini-3.8-flash", "maxConcurrent": 4 } }
 * ```
 *
 * `model` and `baseUrl` left out mean the children use whatever the parent is
 * using, which is the safe default; naming a cheaper model is the whole point
 * of the block, since a parallel batch of children is where a run's tokens
 * actually go.
 */
export type FileDelegationSettings = {
  enabled?: boolean;
  model?: string;
  baseUrl?: string;
  maxConcurrent?: number;
  maxPerTurn?: number;
  maxIterations?: number;
  staleMs?: number;
  staleToolMs?: number;
  /**
   * Extra attempts a task gets when it comes back unfinished. 0 turns it off.
   *
   * Read as an optional number because it costs tokens: a user who would rather
   * have the honest failure than the second attempt can say so.
   */
  retryUnfinished?: number;
};

export type FileSettings = {
  model?: string;
  /** The colour theme by name, e.g. `tokyo-night`. `/themes` lists them. */
  theme?: string;
  /**
   * What the screen shows: animations, thinking, markdown, verbosity and the
   * rest of the `/settings` rows. Validated here so a typo is a warning at
   * startup rather than a panel showing a value that does nothing.
   */
  view?: ViewOverrides;
  baseUrl?: string;
  /** Which named provider is in use, when more than one is declared. */
  provider?: string;
  providers?: Record<string, FileProvider>;
  /** Other models on the endpoint in use, tried when it fails. */
  fallbackModels?: string[];
  /** Backup routes on other endpoints, tried in order. */
  fallback?: FileFallbackRoute[];
  /** Whether a free model may implicitly fall back to the endpoint's other free ones. */
  fallbackAuto?: boolean;
  /** Session token ceiling. Omitted or 0 means no ceiling. */
  maxTokens?: number;
  /** Requests one turn may spend before it stops and asks to carry on. */
  maxTurns?: number;
  /**
   * Command prefixes that never ask for approval, per tool.
   *
   * `{ "bash": ["npm test", "git status"] }` — a prefix match against the
   * command, checked before the prompt. Deliberately explicit and short: this
   * is the one setting that can run something without being read first.
   */
  allow?: Record<string, string[]>;
  /**
   * Whether a finished turn runs the automatic learning pass. `"auto"` (the
   * default) or `"off"`. It costs one extra request per turn, so it is a
   * setting rather than a silent decision.
   */
  learning?: "off" | "auto";
  /** Shorthand for pointing this project at the bundled mock provider. */
  mock?: boolean;
  /**
   * Where the brain lives. `~` means the home directory and a relative path is
   * resolved against the working directory. Left out, a brain found by the
   * `ki-agent-brain` walk is used and one is otherwise created in `~/.kicode`.
   */
  brain?: string;
  compaction?: FileCompactionSettings;
  delegation?: FileDelegationSettings;
};

export type FileSettingsResult = {
  settings: FileSettings;
  warnings: string[];
};

export function fileSettingsFromEntries(entries: readonly ConfigFileEntry[]): FileSettingsResult {
  const settings: FileSettings = {};
  const warnings: string[] = [];

  for (const entry of entries) {
    const json = entry.json;

    if (json.model !== undefined) {
      if (typeof json.model === "string" && json.model.trim() !== "") settings.model = json.model.trim();
      else warnings.push(`Ignoring "model" in ${entry.file}: expected a non-empty string.`);
    }

    if (json.baseUrl !== undefined) {
      if (typeof json.baseUrl === "string" && /^https?:\/\//i.test(json.baseUrl.trim())) {
        settings.baseUrl = json.baseUrl.trim();
      } else {
        warnings.push(`Ignoring "baseUrl" in ${entry.file}: expected an http(s) URL.`);
      }
    }

    if (json.theme !== undefined) {
      if (typeof json.theme === "string" && json.theme.trim() !== "") settings.theme = json.theme.trim();
      else warnings.push(`Ignoring "theme" in ${entry.file}: expected a theme name (\`/themes\` lists them).`);
    }

    for (const key of SETTING_KEYS) {
      if (json[key] === undefined) continue;
      const options = settingOptions(key);
      if (typeof json[key] === "string" && options.includes(json[key])) {
        settings.view = { ...settings.view, [key]: json[key] };
      } else {
        warnings.push(`Ignoring "${key}" in ${entry.file}: expected one of ${options.join("|")}.`);
      }
    }

    if (json.spacing !== undefined) {
      const block = json.spacing;
      if (block === null || typeof block !== "object" || Array.isArray(block)) {
        warnings.push(`Ignoring "spacing" in ${entry.file}: expected an object of { ${SPACING_KEYS.join(", ")} }.`);
      } else {
        // One number is checked at a time, so a bad `block` still leaves a good
        // `entry` in effect: the same rule the `providers` block follows.
        const source = block as Record<string, unknown>;
        const spacing: Partial<Spacing> = { ...settings.view?.spacing };
        for (const key of SPACING_KEYS) {
          if (source[key] === undefined) continue;
          const value = spacingValue(source[key]);
          if (value === null) {
            warnings.push(`Ignoring "spacing.${key}" in ${entry.file}: expected a whole number from 0 to ${MAX_SPACING}.`);
          } else {
            spacing[key] = value;
          }
        }
        if (Object.keys(spacing).length > 0) settings.view = { ...settings.view, spacing };
      }
    }

    if (json.provider !== undefined) {
      if (typeof json.provider === "string" && json.provider.trim() !== "") settings.provider = json.provider.trim();
      else warnings.push(`Ignoring "provider" in ${entry.file}: expected a non-empty string.`);
    }

    if (json.delegation !== undefined) {
      const parsed = readDelegation(json.delegation, entry.file, warnings);
      if (parsed) settings.delegation = { ...settings.delegation, ...parsed };
    }

    if (json.providers !== undefined) {
      const parsed = readProviders(json.providers, entry.file, warnings);
      if (parsed) settings.providers = { ...settings.providers, ...parsed };
    }

    if (json.fallbackModels !== undefined) {
      const models = stringList(json.fallbackModels);
      if (models) settings.fallbackModels = models;
      else warnings.push(`Ignoring "fallbackModels" in ${entry.file}: expected a non-empty array of model names.`);
    }

    if (json.fallback !== undefined) {
      const parsed = readFallbackRoutes(json.fallback, entry.file, warnings);
      if (parsed) settings.fallback = parsed;
    }

    if (json.fallbackAuto !== undefined) {
      if (typeof json.fallbackAuto === "boolean") settings.fallbackAuto = json.fallbackAuto;
      else warnings.push(`Ignoring "fallbackAuto" in ${entry.file}: expected true or false.`);
    }

    if (json.maxTokens !== undefined) {
      if (json.maxTokens === 0) settings.maxTokens = 0;
      else {
        const value = positiveInt(json.maxTokens);
        if (value === null) warnings.push(`Ignoring "maxTokens" in ${entry.file}: expected a positive number, or 0 for no limit.`);
        else settings.maxTokens = value;
      }
    }

    if (json.maxTurns !== undefined) {
      const value = positiveInt(json.maxTurns);
      if (value === null) warnings.push(`Ignoring "maxTurns" in ${entry.file}: expected a positive whole number.`);
      else settings.maxTurns = value;
    }

    if (json.allow !== undefined) {
      const parsed = readAllow(json.allow, entry.file, warnings);
      if (parsed) settings.allow = { ...settings.allow, ...parsed };
    }

    if (json.mock !== undefined) {
      if (typeof json.mock === "boolean") settings.mock = json.mock;
      else warnings.push(`Ignoring "mock" in ${entry.file}: expected true or false.`);
    }

    if (json.learning !== undefined) {
      if (json.learning === "off" || json.learning === "auto") settings.learning = json.learning;
      else warnings.push(`Ignoring "learning" in ${entry.file}: expected "off" or "auto".`);
    }

    if (json.brain !== undefined) {
      if (typeof json.brain === "string" && json.brain.trim() !== "") settings.brain = json.brain.trim();
      else warnings.push(`Ignoring "brain" in ${entry.file}: expected a path to the brain directory.`);
    }

    if (json.compaction !== undefined) {
      const block = json.compaction;
      if (block === null || typeof block !== "object" || Array.isArray(block)) {
        warnings.push(`Ignoring "compaction" in ${entry.file}: expected an object.`);
      } else {
        const source = block as Record<string, unknown>;
        const next: FileCompactionSettings = { ...settings.compaction };

        for (const key of ["contextTokens", "reserveTokens", "targetPercent", "compactAt"] as const) {
          if (source[key] === undefined) continue;
          const value = positiveInt(source[key]);
          if (value === null) warnings.push(`Ignoring "compaction.${key}" in ${entry.file}: expected a positive number.`);
          else next[key] = value;
        }

        // Named rather than silently dropped: a session compacted by a turn
        // count is not what this file is asking for any more, and a knob that
        // does nothing is worse than one that says it does nothing.
        if (source.keepRecentTurns !== undefined) {
          warnings.push(
            `Ignoring "compaction.keepRecentTurns" in ${entry.file}: the cut is chosen by size now — use "compaction.targetPercent".`,
          );
        }

        if (source.enabled !== undefined) {
          if (typeof source.enabled === "boolean") next.enabled = source.enabled;
          else warnings.push(`Ignoring "compaction.enabled" in ${entry.file}: expected true or false.`);
        }

        settings.compaction = next;
      }
    }

    // A key in a file is reported and never used — at any scope. The global
    // file sits on the same disk as the project one and is just as easy to
    // sync, back up, or paste into an issue, so "it is only mine" is not a
    // property of a file and there is no scope where this is allowed.
    const rawKey = json.apiKey ?? json.key ?? json.token;
    if (rawKey !== undefined) {
      warnings.push(
        `Ignoring the API key in ${entry.file} — KiCode never takes a key from a config file. Set the provider's apiKeyEnv in the environment instead.`,
      );
    }
  }

  if (settings.mock === true && settings.baseUrl !== undefined) {
    warnings.push('"mock" is ignored because "baseUrl" is also set.');
  }

  return { settings, warnings };
}

/**
 * A `providers` block, or null when it was not usable at all.
 *
 * Every entry is validated on its own: one malformed provider is a warning and
 * a dropped row, never a reason to lose the rest of the block.
 */
/**
 * The `allow` block: command prefixes that skip the approval prompt, per tool.
 *
 * `{ "bash": ["npm test", "git status"] }`. A bad entry is dropped with a
 * warning rather than refusing the whole block, so one typo cannot silently
 * disable every rule the user wrote — and an empty list is dropped too, because
 * a rule that matches nothing reads as if it were working.
 */
function readAllow(value: unknown, file: string, warnings: string[]): Record<string, string[]> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`Ignoring "allow" in ${file}: expected an object of tool → [prefix, …].`);
    return null;
  }

  const allow: Record<string, string[]> = {};
  for (const [tool, prefixes] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(prefixes)) {
      warnings.push(`Ignoring "allow.${tool}" in ${file}: expected a list of command prefixes.`);
      continue;
    }
    const list = prefixes
      .filter((prefix): prefix is string => typeof prefix === "string" && prefix.trim() !== "")
      .map((prefix) => prefix.trim());
    if (list.length === 0) {
      warnings.push(`Ignoring "allow.${tool}" in ${file}: expected at least one non-empty prefix.`);
      continue;
    }
    allow[tool] = list;
  }

  return Object.keys(allow).length > 0 ? allow : null;
}

/**
 * The `delegation` block, validated one key at a time.
 *
 * Per key rather than all-or-nothing, for the reason `providers` does the same:
 * a typo in `maxConcurrent` should not also throw away a perfectly good
 * `model` pin — the one line in this block that actually costs nothing to get
 * wrong would otherwise be lost to the one that does.
 */
function readDelegation(
  json: unknown,
  file: string,
  warnings: string[],
): FileDelegationSettings | null {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    warnings.push(`Ignoring "delegation" in ${file}: expected an object.`);
    return null;
  }
  const source = json as Record<string, unknown>;
  const out: FileDelegationSettings = {};

  if (source.enabled !== undefined) {
    if (typeof source.enabled === "boolean") out.enabled = source.enabled;
    else warnings.push(`Ignoring "delegation.enabled" in ${file}: expected true or false.`);
  }
  for (const key of ["model", "baseUrl"] as const) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value === "string" && value.trim() !== "") out[key] = value.trim();
    else warnings.push(`Ignoring "delegation.${key}" in ${file}: expected a non-empty string.`);
  }
  if (out.baseUrl !== undefined && !/^https?:\/\//i.test(out.baseUrl)) {
    warnings.push(`Ignoring "delegation.baseUrl" in ${file}: expected an http(s) URL.`);
    delete out.baseUrl;
  }
  for (const key of ["maxConcurrent", "maxPerTurn", "maxIterations", "staleMs", "staleToolMs"] as const) {
    const value = source[key];
    if (value === undefined) continue;
    const parsed = positiveInt(value);
    if (parsed === null) {
      warnings.push(`Ignoring "delegation.${key}" in ${file}: expected a positive number of milliseconds or count.`);
    } else {
      out[key] = parsed;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function readProviders(value: unknown, file: string, warnings: string[]): Record<string, FileProvider> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`Ignoring "providers" in ${file}: expected an object of name → { baseUrl }.`);
    return null;
  }

  const providers: Record<string, FileProvider> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[\w.-]+$/.test(name)) {
      warnings.push(`Ignoring provider "${name}" in ${file}: use letters, digits, dot, dash or underscore.`);
      continue;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`Ignoring provider "${name}" in ${file}: expected an object.`);
      continue;
    }

    const source = entry as Record<string, unknown>;
    const baseUrl = typeof source.baseUrl === "string" ? source.baseUrl.trim() : "";
    if (!/^https?:\/\//i.test(baseUrl)) {
      warnings.push(`Ignoring provider "${name}" in ${file}: "baseUrl" must be an http(s) URL.`);
      continue;
    }

    const provider: FileProvider = { baseUrl };
    if (source.apiKeyEnv !== undefined) {
      if (typeof source.apiKeyEnv === "string" && source.apiKeyEnv.trim() !== "") provider.apiKeyEnv = source.apiKeyEnv.trim();
      else warnings.push(`Ignoring "apiKeyEnv" on "${name}" in ${file}: expected the name of an environment variable.`);
    }

    if (source.models !== undefined) {
      const models = Array.isArray(source.models)
        ? source.models.filter((model): model is string => typeof model === "string" && model.trim() !== "").map((model) => model.trim())
        : null;
      if (models && models.length > 0) provider.models = models;
      else warnings.push(`Ignoring "models" on "${name}" in ${file}: expected a non-empty array of names.`);
    }

    // The same rule as a key at the top level, named rather than read. The
    // value is never echoed — the variable to use instead is what is useful.
    if (source.apiKey !== undefined || source.key !== undefined || source.token !== undefined) {
      warnings.push(
        `Ignoring the API key stored on provider "${name}" in ${file} — KiCode never takes a key from a config file. Set ${provider.apiKeyEnv ?? apiKeyEnvFor(name)} in the environment instead.`,
      );
    }

    providers[name] = provider;
  }

  return providers;
}

/**
 * A `fallback` array, or null when it was not usable at all.
 *
 * Each entry stands alone: a malformed one is a warning and a dropped row, so
 * the rest of the chain still loads. An entry with no `model` is meaningless
 * and dropped — a route must say what to ask for.
 */
function readFallbackRoutes(value: unknown, file: string, warnings: string[]): FileFallbackRoute[] | null {
  if (!Array.isArray(value)) {
    warnings.push(`Ignoring "fallback" in ${file}: expected an array of { provider, model }.`);
    return null;
  }

  const routes: FileFallbackRoute[] = [];
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`Ignoring fallback[${index}] in ${file}: expected an object.`);
      continue;
    }

    const source = entry as Record<string, unknown>;
    const model = typeof source.model === "string" ? source.model.trim() : "";
    if (!model) {
      warnings.push(`Ignoring fallback[${index}] in ${file}: "model" is required.`);
      continue;
    }

    const route: FileFallbackRoute = { model };

    if (source.provider !== undefined) {
      if (typeof source.provider === "string" && source.provider.trim() !== "") route.provider = source.provider.trim();
      else warnings.push(`Ignoring "provider" on fallback[${index}] in ${file}: expected a provider name.`);
    }

    if (source.baseUrl !== undefined) {
      if (typeof source.baseUrl === "string" && /^https?:\/\//i.test(source.baseUrl.trim())) route.baseUrl = source.baseUrl.trim();
      else warnings.push(`Ignoring "baseUrl" on fallback[${index}] in ${file}: expected an http(s) URL.`);
    }

    if (source.apiKey !== undefined || source.key !== undefined || source.token !== undefined) {
      warnings.push(
        `Ignoring the API key on fallback[${index}] in ${file} — declare the provider in "providers" and name its environment variable instead.`,
      );
    }

    routes.push(route);
  }

  return routes.length > 0 ? routes : null;
}

/** A non-empty list of non-empty strings, or null. */
function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim());
  return list.length > 0 ? list : null;
}

function spacingValue(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_SPACING ? parsed : null;
}

function positiveInt(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}
