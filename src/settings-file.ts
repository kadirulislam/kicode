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
 *   "compaction": { "contextTokens": 200000, "keepRecentTurns": 8 },
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
  keepRecentTurns?: number;
  compactAt?: number;
};

export type FileProvider = {
  baseUrl: string;
  /** Direct API key for this provider. */
  apiKey?: string;
  /** The environment variable holding this provider's key. */
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

export type FileSettings = {
  apiKey?: string;
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
  /** Shorthand for pointing this project at the bundled mock provider. */
  mock?: boolean;
  compaction?: FileCompactionSettings;
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

    if (json.mock !== undefined) {
      if (typeof json.mock === "boolean") settings.mock = json.mock;
      else warnings.push(`Ignoring "mock" in ${entry.file}: expected true or false.`);
    }

    if (json.compaction !== undefined) {
      const block = json.compaction;
      if (block === null || typeof block !== "object" || Array.isArray(block)) {
        warnings.push(`Ignoring "compaction" in ${entry.file}: expected an object.`);
      } else {
        const source = block as Record<string, unknown>;
        const next: FileCompactionSettings = { ...settings.compaction };

        for (const key of ["contextTokens", "reserveTokens", "keepRecentTurns", "compactAt"] as const) {
          if (source[key] === undefined) continue;
          const value = positiveInt(source[key]);
          if (value === null) warnings.push(`Ignoring "compaction.${key}" in ${entry.file}: expected a positive number.`);
          else next[key] = value;
        }

        if (source.enabled !== undefined) {
          if (typeof source.enabled === "boolean") next.enabled = source.enabled;
          else warnings.push(`Ignoring "compaction.enabled" in ${entry.file}: expected true or false.`);
        }

        settings.compaction = next;
      }
    }

    const rawKey = json.apiKey ?? json.key ?? json.token;
    if (rawKey !== undefined) {
      if (entry.scope === "global" && typeof rawKey === "string" && rawKey.trim() !== "") {
        settings.apiKey = rawKey.trim();
      } else {
        warnings.push(
          `Ignoring the API key in ${entry.file} — KiCode reads keys from the environment (KICODE_API_KEY) so a committed config can never leak one.`,
        );
      }
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

    if (source.apiKey !== undefined || source.key !== undefined || source.token !== undefined) {
      const directKey = source.apiKey ?? source.key ?? source.token;
      if (typeof directKey === "string" && directKey.trim() !== "") {
        provider.apiKey = directKey.trim();
      }
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
