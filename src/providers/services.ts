import type { MenuRow } from "../tui/menu";

/**
 * The services `/connect` can add.
 *
 * KiCode talks to any OpenAI-compatible endpoint, so "connecting" is two facts:
 * a base URL, and the environment variable the key is read from. This is the
 * list of those pairs we have actually checked — a catalogue entry that guessed
 * at a base URL would produce a 404 the moment somebody used it, which is worse
 * than the service not being listed.
 *
 * The key itself is never here and never written anywhere: KiCode reads keys
 * from the environment, and a service names the variable to look in. That is
 * why connecting a service whose variable is not set is still allowed — it
 * declares the endpoint so the next run finds it, and says which variable is
 * missing rather than pretending to authenticate.
 *
 * `name` is the key written into the `providers` block, so it has to be usable
 * as an identifier — `302.AI` is labelled that way and named `ai302`, because a
 * variable called `302AI_API_KEY` cannot be set from a PowerShell prompt.
 */

export type Service = {
  /** The name used in `kicode.json`, and in `/connect <name>`. */
  name: string;
  label: string;
  group: "Popular" | "Services";
  baseUrl: string;
  /** The variable holding the key. Absent for a server that needs none. */
  apiKeyEnv?: string;
  /** Where its own documentation is, for the note after adding it. */
  doc: string;
  /** A line of context for the panel, when the name alone is not enough. */
  note?: string;
};

export const SERVICES: readonly Service[] = [
  {
    name: "tokenharbor",
    label: "TokenHarbor",
    group: "Popular",
    baseUrl: "https://tokenharbor.ai/v1",
    apiKeyEnv: "TOKENHARBOR_API_KEY",
    doc: "https://tokenharbor.ai/",
    note: "AI model aggregator and router",
  },
  {
    name: "tokenharbour",
    label: "TokenHarbour",
    group: "Popular",
    baseUrl: "https://api.tokenharbour.com/v1",
    apiKeyEnv: "TOKENHARBOUR_API_KEY",
    doc: "https://tokenharbour.com/",
    note: "AI model aggregator and router",
  },
  {
    name: "opencode-go",
    label: "OpenCode Go",
    group: "Popular",
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
    doc: "https://opencode.ai/docs/go/",
    note: "subscription models, OpenAI-compatible",
  },
  {
    name: "opencode",
    label: "OpenCode Zen",
    group: "Popular",
    baseUrl: "https://opencode.ai/zen/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
    doc: "https://opencode.ai/docs/zen/",
    note: "the curated model list",
  },
  {
    name: "openai",
    label: "OpenAI",
    group: "Popular",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    doc: "https://platform.openai.com/docs/api-reference",
  },
  {
    name: "openrouter",
    label: "OpenRouter",
    group: "Popular",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    doc: "https://openrouter.ai/docs",
    note: "many free models, reached with a :free suffix",
  },
  {
    name: "groq",
    label: "Groq",
    group: "Popular",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    doc: "https://console.groq.com/docs/openai",
    note: "fast, and reports its own rate limits",
  },
  {
    name: "github-copilot",
    label: "Github Copilot",
    group: "Popular",
    baseUrl: "https://api.githubcopilot.com",
    apiKeyEnv: "GITHUB_TOKEN",
    doc: "https://docs.github.com/en/copilot",
    note: "a fine-grained token with the Copilot scope",
  },
  {
    name: "anthropic",
    label: "Anthropic",
    group: "Popular",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    doc: "https://docs.anthropic.com/en/api/openai-sdk",
    note: "through its OpenAI-compatible surface",
  },
  {
    name: "google",
    label: "Google",
    group: "Popular",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
    doc: "https://ai.google.dev/gemini-api/docs/openai",
  },
  {
    name: "ai302",
    label: "302.AI",
    group: "Services",
    baseUrl: "https://api.302.ai/v1",
    apiKeyEnv: "AI302_API_KEY",
    doc: "https://doc-en.302.ai/",
  },
  {
    name: "abacus",
    label: "Abacus",
    group: "Services",
    baseUrl: "https://routellm.abacus.ai/v1",
    apiKeyEnv: "ABACUS_API_KEY",
    doc: "https://abacus.ai/help/route-llm/",
    note: "self-serve organisations only",
  },
  {
    name: "abliteration",
    label: "abliteration.ai",
    group: "Services",
    baseUrl: "https://api.abliteration.ai/v1",
    apiKeyEnv: "ABLITERATION_API_KEY",
    doc: "https://abliteration.ai/docs/openai-compatibility",
  },
  {
    name: "agentrouter",
    label: "AgentRouter",
    group: "Services",
    baseUrl: "https://agentrouter.org/v1",
    apiKeyEnv: "AGENTROUTER_API_KEY",
    doc: "https://agentrouter.org/",
  },
  {
    name: "kenari",
    label: "Kenari",
    group: "Popular",
    baseUrl: "https://api.kenari.ai/v1",
    apiKeyEnv: "KENARI_API_KEY",
    doc: "https://kenari.ai/",
  },
  {
    name: "experiential",
    label: "Experiential Labs",
    group: "Services",
    baseUrl: "https://api.experiential.ai/v1",
    apiKeyEnv: "EXPERIENTIAL_LABS_API_KEY",
    doc: "https://experiential.ai/",
  },
  {
    name: "ollama",
    label: "Ollama (local)",
    group: "Services",
    baseUrl: "http://localhost:11434/v1",
    doc: "https://docs.ollama.com/openai",
    note: "no key — a local server",
  },
];

/**
 * Parses user input for custom API routers.
 * Supports:
 *   - `/connect <name> <baseUrl> [apiKeyEnv]` (e.g. `myrouter https://api.myrouter.ai/v1 MY_KEY`)
 *   - `/connect <baseUrl>` (e.g. `https://my-proxy.com/v1`)
 */
export function parseCustomService(input: string): Service | undefined {
  const trimmed = input.trim();
  const parts = trimmed.split(/\s+/);
  const part0 = parts[0];
  const part1 = parts[1];
  if (!part0) return undefined;

  // Single URL: e.g. https://api.proxy.ai/v1
  if (/^https?:\/\//i.test(part0)) {
    const rawUrl = part0.replace(/\/+$/, "");
    try {
      const parsed = new URL(rawUrl);
      const name = parsed.hostname.replace(/\./g, "-").replace(/[^a-zA-Z0-9-]/g, "") || "custom";
      const apiKeyEnv = `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
      return {
        name,
        label: parsed.hostname,
        group: "Services",
        baseUrl: rawUrl,
        apiKeyEnv,
        doc: rawUrl,
        note: "custom router",
      };
    } catch {
      return undefined;
    }
  }

  // Name and URL: e.g. "myrouter https://api.myrouter.ai/v1 [KEY_ENV]"
  if (part1 && /^https?:\/\//i.test(part1)) {
    const name = part0.toLowerCase().replace(/[^a-zA-Z0-9-]/g, "");
    if (!name) return undefined;
    const rawUrl = part1.replace(/\/+$/, "");
    const apiKeyEnv = parts[2] ? parts[2].trim() : `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
    return {
      name,
      label: part0,
      group: "Services",
      baseUrl: rawUrl,
      apiKeyEnv,
      doc: rawUrl,
      note: "custom router",
    };
  }

  return undefined;
}

/**
 * What came of adding a service.
 *
 * `ready` is the useful half: the endpoint is declared either way, but the
 * session can only move to it when a key was actually found. A caller that
 * switched anyway would trade a clear message for a 401.
 */
export type AddProviderResult =
  | {
      ok: true;
      provider: string;
      baseUrl: string;
      apiKey: string;
      /** The variable the key came from, when the service needs one. */
      apiKeyEnv?: string;
      /** Where the declaration was written, so the user can go and look. */
      file: string;
      ready: boolean;
    }
  | { ok: false; reason: string };

/** The catalogue entry a name points at, by config name or by label. */
export function serviceByName(name: string): Service | undefined {
  const needle = name.trim().toLowerCase();
  return SERVICES.find((service) => service.name.toLowerCase() === needle || service.label.toLowerCase() === needle);
}

export function serviceApiKey(env: NodeJS.ProcessEnv, service: Service): string {
  if (!service.apiKeyEnv) return "";
  const direct = (env[service.apiKeyEnv] ?? "").trim();
  if (direct) return direct;
  if (service.name === "tokenharbor" || service.name === "tokenharbour") {
    return (env.TOKENHARBOR_API_KEY ?? env.TOKENHARBOUR_API_KEY ?? "").trim();
  }
  return "";
}

/**
 * The catalogue as panel rows, given what the environment already holds and
 * what the config already declares.
 *
 * `ready` is the honest marker: the tick means the variable the service needs
 * is set now, so choosing it can move the session there. A service that is
 * declared but not configured still shows, marked as missing its key, because
 * that is the state somebody most needs to see.
 */
export function serviceRows(
  env: NodeJS.ProcessEnv,
  declared: readonly string[] = [],
  services: readonly Service[] = SERVICES,
): MenuRow[] {
  const already = new Set(declared.map((name) => name.toLowerCase()));

  return services.map((service) => {
    const key = service.apiKeyEnv ? serviceApiKey(env, service) : "keyless";
    const ready = service.apiKeyEnv === undefined || key !== "";
    const trailing = service.apiKeyEnv === undefined ? "no key needed" : ready ? `key in ${service.apiKeyEnv}` : `set ${service.apiKeyEnv}`;

    return {
      label: service.label,
      value: service.name,
      group: service.group,
      checked: ready,
      trailing: already.has(service.name) ? `${trailing} · declared` : trailing,
    };
  });
}
