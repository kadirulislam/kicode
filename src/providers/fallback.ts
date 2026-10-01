import type { FallbackRoute } from "../config";
import type { RouteOutcome } from "../routes/health";
import { preferredSnapshot, type QuotaReading, type QuotaSnapshot } from "../routes/quota";
import type { ChatRequest, Provider, StreamEvent } from "../types";
import { OpenAIProvider, ProviderError } from "./openai";

/**
 * A chain of routes, tried in order until one answers.
 *
 * This is the answer to "the free model's daily quota just ran out": every
 * route speaks the same OpenAI-compatible wire format, so the *same* request
 * can be replayed on the next one. The fallback is deliberately only taken
 * before the model has said anything — once text or a tool call has been
 * streamed, switching routes would rewrite an answer the user is already
 * reading, so that failure is reported instead.
 *
 * It is also the only place that knows exactly which route a request went to
 * and how it ended, so it is where the route-health store is told — through
 * `onOutcome`, which is optional because a chain that is not being watched is
 * still a chain.
 */

/**
 * Statuses worth trying another route for: a quota, a model this endpoint does
 * not serve, or a gateway that is briefly unwell.
 *
 * Authentication (401/403) is not here on purpose — a wrong key is a
 * configuration mistake that should be seen, not routed around.
 */
const RETRYABLE_STATUS = new Set([402, 404, 408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

/** Whether a failure is worth another route. */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  // No status at all is a connection or DNS failure — the next route may reach.
  if (error.status === undefined) return true;
  return RETRYABLE_STATUS.has(error.status);
}

/** A short, human reason for the route change. */
export function fallbackReason(error: unknown): string {
  const status = error instanceof ProviderError ? error.status : undefined;
  if (status === 429) return "rate-limited (HTTP 429)";
  if (status === 402) return "out of credit (HTTP 402)";
  if (status === 404) return "no such model there (HTTP 404)";
  if (status !== undefined) return `HTTP ${status}`;
  return "unreachable";
}

export type FallbackProviderOptions = {
  /** The first route is the one the session asked for; the rest are backups. */
  routes: readonly FallbackRoute[];
  /** Injected in tests, so no network is touched. */
  makeProvider?: (route: FallbackRoute) => Provider;
  /**
   * Passed to every route's provider: a per-conversation id (OpenCode Go's
   * `x-opencode-session`) and an honest `User-Agent`. Both are properties of
   * the caller, not of any one route, so they are given once here.
   */
  sessionId?: string;
  userAgent?: string;
  /**
   * Told about every request's result, on the route it actually went to.
   *
   * A callback rather than a store so this file stays a router: what is done
   * with the observation — remembering it for next time, drawing it — is not
   * its business. It cannot throw into a turn either, because recording is
   * memory work with the disk behind a debounce.
   */
  onOutcome?: (route: FallbackRoute, outcome: RouteOutcome) => void;
};

export class FallbackProvider implements Provider {
  private readonly hops: { route: FallbackRoute; provider: Provider }[];
  private readonly onOutcome?: (route: FallbackRoute, outcome: RouteOutcome) => void;

  constructor(options: FallbackProviderOptions) {
    const make =
      options.makeProvider ??
      ((route: FallbackRoute) =>
        new OpenAIProvider({
          apiKey: route.apiKey,
          baseUrl: route.baseUrl,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          ...(options.userAgent ? { userAgent: options.userAgent } : {}),
        }));
    this.hops = options.routes.map((route) => ({ route, provider: make(route) }));
    if (options.onOutcome) this.onOutcome = options.onOutcome;
  }

  get routes(): readonly FallbackRoute[] {
    return this.hops.map((hop) => hop.route);
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    const failures: string[] = [];
    // With one route there is nothing to switch to, so "every route failed — x"
    // would only restate the error the gateway already gave.
    const single = this.hops.length === 1;

    for (let index = 0; index < this.hops.length; index++) {
      const hop = this.hops[index];
      if (!hop) break;
      if (request.signal?.aborted) throw abortError();

      let started = false;
      let reading: QuotaReading | null = null;
      try {
        for await (const event of hop.provider.stream({ ...request, model: hop.route.model })) {
          // Text or a tool call has left the gateway: the turn has begun, and
          // another route would be answering a different question. A quota
          // reading is *not* the turn starting — a 429 emits one and then
          // throws, and that must still be retried on the next route.
          if (event.type === "quota") reading = event.reading;
          else started = true;
          yield event;
        }
        this.report(hop.route, { ok: true, status: 200, ...quotaFields(reading) });
        return;
      } catch (error) {
        // A cancellation is a decision, not a failure to route around — and it
        // is not the route's fault either, so it is not recorded against it.
        if (request.signal?.aborted || isAbort(error)) throw error;
        this.report(hop.route, { ok: false, ...failureFields(error, reading) });
        if (started || !isRetryable(error)) throw error;

        failures.push(`${hop.route.label} (${fallbackReason(error)})`);
        const next = this.hops[index + 1];
        if (!next) {
          if (single) throw error;
          break;
        }
        yield { type: "route", from: hop.route.label, to: next.route.label, reason: fallbackReason(error) };
      }
    }

    throw new ProviderError(`Every route failed — ${failures.join(", ")}.`);
  }

  private report(route: FallbackRoute, outcome: RouteOutcome): void {
    this.onOutcome?.(route, outcome);
  }
}

/** What a reading adds to an outcome, when it carried anything. */
function quotaFields(reading: QuotaReading | null): { quota?: QuotaSnapshot; retryAfterMs?: number } {
  if (!reading) return {};
  const quota = preferredSnapshot(reading);
  return {
    ...(quota ? { quota } : {}),
    ...(reading.retryAfterMs !== null ? { retryAfterMs: reading.retryAfterMs } : {}),
  };
}

function failureFields(error: unknown, reading: QuotaReading | null): Omit<RouteOutcome, "ok"> {
  const status = error instanceof ProviderError ? error.status : undefined;
  return {
    ...(status !== undefined ? { status } : {}),
    reason: fallbackReason(error),
    ...quotaFields(reading),
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}
