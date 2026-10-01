/**
 * Asking a gateway what is left, for the gateways that let you ask.
 *
 * OpenRouter sends no `X-RateLimit-*` headers on a *successful* response — only
 * on a platform-limit error — so a healthy OpenRouter route would otherwise be
 * invisible to the quota layer. Its documented `GET /key` reports the account's
 * remaining credit, and, the field that matters here, the daily free-model
 * request counter that gates `:free` routes.
 *
 * Two rules keep this from becoming a liability:
 *
 * - **Candidate-driven only.** A probe runs when a route is about to be used,
 *   never on a timer and never at startup for every configured route. A tool
 *   that quietly polls six gateways on launch is a tool that gets rate-limited
 *   for existing.
 * - **Silent on failure.** No snapshot is better than a wrong one, and a failed
 *   probe must not become a second failure the user sees.
 */

import type { QuotaReading, QuotaSnapshot } from "./quota";

export type ProbeRoute = {
  baseUrl: string;
  apiKey: string;
};

/** How long a probe answer is trusted. */
export const PROBE_TTL_MS = 60_000;

/**
 * Where a route's quota can be asked about, or null when it cannot.
 *
 * Detection is by host, not by the provider's configured name: the name is the
 * user's, and renaming a provider must not change its behaviour.
 */
export function probeUrl(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname !== "openrouter.ai" && !hostname.endsWith(".openrouter.ai")) return null;

  const base = baseUrl.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
  return `${base}/key`;
}

/** The payload of `GET /key` → a reading, or null when it says nothing useful. */
export function parseKeyPayload(payload: unknown, now: number): QuotaReading | null {
  if (payload === null || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return null;

  const source = data as Record<string, unknown>;
  const free = source.free_model_daily_requests;

  if (free !== null && typeof free === "object") {
    const counter = free as Record<string, unknown>;
    const limit = counter.limit;
    const remaining = counter.remaining;
    if (typeof limit === "number" || typeof remaining === "number") {
      return {
        requests: snapshot({
          scope: "requests",
          window: "day",
          limit: typeof limit === "number" ? limit : null,
          remaining: typeof remaining === "number" ? remaining : null,
          resetAt: nextUtcMidnight(now),
        }),
        tokens: null,
        retryAfterMs: null,
      };
    }
  }

  // No free-model counter: fall back to the key's credit cap, which is what a
  // paid route runs out of. Its reset period is a policy the endpoint states in
  // prose, so the window is honestly left unknown.
  const creditLimit = typeof source.limit === "number" ? source.limit : null;
  const creditRemaining = typeof source.limit_remaining === "number" ? source.limit_remaining : null;
  if (creditLimit !== null || creditRemaining !== null) {
    return {
      requests: snapshot({
        scope: "credits",
        window: "unknown",
        limit: creditLimit,
        remaining: creditRemaining,
        resetAt: null,
      }),
      tokens: null,
      retryAfterMs: null,
    };
  }

  return null;
}

function snapshot(fields: Omit<QuotaSnapshot, "source">): QuotaSnapshot {
  return { ...fields, source: "probe" };
}

/** The next UTC midnight — when OpenRouter's daily counters roll over. */
export function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export type ProbeOptions = {
  fetchImpl?: typeof fetch;
  /** For deterministic tests. */
  now?: number;
  signal?: AbortSignal;
};

/**
 * One probe per route per minute, however many turns ask for it.
 *
 * A `null` result is cached too: an endpoint that does not answer this question
 * should not be asked it again on every request in a turn.
 */
export class QuotaProbes {
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, { at: number; reading: QuotaReading | null }>();

  constructor(options: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** The route's quota, from cache when fresh, otherwise from the gateway. */
  async get(route: ProbeRoute, options: ProbeOptions = {}): Promise<QuotaReading | null> {
    const url = probeUrl(route.baseUrl);
    if (!url) return null;

    const now = options.now ?? Date.now();
    const cached = this.cache.get(route.baseUrl);
    if (cached && now - cached.at < PROBE_TTL_MS) return cached.reading;

    const reading = await this.fetchReading(url, route.apiKey, now, options.signal);
    this.cache.set(route.baseUrl, { at: now, reading });
    return reading;
  }

  /** Forgets what a route said — used after a 429, when it is known stale. */
  invalidate(baseUrl: string): void {
    this.cache.delete(baseUrl);
  }

  private async fetchReading(url: string, apiKey: string, now: number, signal: AbortSignal | undefined): Promise<QuotaReading | null> {
    try {
      const response = await this.fetchImpl(url, {
        headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      return parseKeyPayload(payload, now);
    } catch {
      // A probe is an optimisation. Failing it must not be visible.
      return null;
    }
  }
}
