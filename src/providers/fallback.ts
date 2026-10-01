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

/**
 * The pause between a rate limit and the next attempt, when the gateway said
 * nothing about how long. Grows by one step per hop already tried, so a chain
 * that is being churned through backs off rather than hammering each route in
 * turn.
 */
const RETRY_PAUSE_MS = 1_500;
/** The longest wait honoured, whatever the gateway asked for. */
const RETRY_AFTER_CEILING_MS = 60_000;

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
  /**
   * More backup routes, discovered lazily.
   *
   * The auto free→free chain is built from the endpoint's own model list, and
   * asking for that list is a network call nobody wants at startup — most
   * sessions never hit a 429. It is fetched once, the first time the primary
   * route fails, and whatever it returns is appended after the routes above.
   * An error here is swallowed: implicit backups are a courtesy, and a gateway
   * too unwell to list its models is too unwell to answer either.
   */
  moreRoutes?: () => Promise<readonly FallbackRoute[]>;
  /**
   * How a rate-limit pause is taken. Injected in tests so a backoff that is
   * real seconds on the wire costs none of them.
   */
  wait?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
};

export class FallbackProvider implements Provider {
  private readonly hops: { route: FallbackRoute; provider: Provider }[];
  private readonly onOutcome?: (route: FallbackRoute, outcome: RouteOutcome) => void;
  private readonly makeProvider: (route: FallbackRoute) => Provider;
  private readonly moreRoutes?: () => Promise<readonly FallbackRoute[]>;
  private readonly wait: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  /** Guards the one lazy fetch: concurrent failures must not ask twice. */
  private extraRoutes: Promise<readonly FallbackRoute[]> | null = null;

  constructor(options: FallbackProviderOptions) {
    this.makeProvider =
      options.makeProvider ??
      ((route: FallbackRoute) =>
        new OpenAIProvider({
          apiKey: route.apiKey,
          baseUrl: route.baseUrl,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          ...(options.userAgent ? { userAgent: options.userAgent } : {}),
        }));
    this.hops = options.routes.map((route) => ({ route, provider: this.makeProvider(route) }));
    if (options.onOutcome) this.onOutcome = options.onOutcome;
    if (options.moreRoutes) this.moreRoutes = options.moreRoutes;
    this.wait = options.wait ?? interruptibleWait;
  }

  get routes(): readonly FallbackRoute[] {
    return this.hops.map((hop) => hop.route);
  }

  /**
   * The lazily discovered backups, appended to the chain once.
   *
   * Resolved on the first failure of a route that has no successor yet, so a
   * healthy session never pays for the model list. A gateway that will not or
   * cannot answer the list question contributes nothing, and the chain carries
   * on with what it had — the error the user sees is the real one, not a
   * failure of the discovery.
   */
  private async extend(): Promise<void> {
    if (!this.moreRoutes || this.extraRoutes) return;
    const pending = this.moreRoutes()
      .then((routes) => {
        const known = new Set(this.hops.map((hop) => `${hop.route.baseUrl}\u0000${hop.route.model}`));
        for (const route of routes) {
          if (known.has(`${route.baseUrl}\u0000${route.model}`)) continue;
          known.add(`${route.baseUrl}\u0000${route.model}`);
          this.hops.push({ route, provider: this.makeProvider(route) });
        }
      })
      .catch(() => undefined);
    this.extraRoutes = pending.then(() => []);
    await pending;
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
        // Out of declared chain: ask for the implicit backups once, before
        // giving up, so a free route that has just run dry can still be
        // followed by the endpoint's other free models.
        if (!this.hops[index + 1] && this.moreRoutes) await this.extend();
        const next = this.hops[index + 1];
        if (!next) {
          if (single) throw error;
          break;
        }

        // A rate limit is worth waiting out before touching the next route —
        // a short backoff here keeps one busy gateway from churning the whole
        // chain. The gateway's own `Retry-After` wins when it gave one, capped
        // so a "come back tomorrow" parks nothing; without it, a brief pause
        // that grows with each hop. The wait is cancellable mid-sleep, and it
        // is only taken when a route is actually next: with nowhere to go the
        // pause would only delay the error the user has to act on.
        if (error instanceof ProviderError && error.status === 429) {
          const wait = Math.min(reading?.retryAfterMs ?? RETRY_PAUSE_MS * (index + 1), RETRY_AFTER_CEILING_MS);
          yield { type: "route-wait", ms: wait, from: hop.route.label, reason: fallbackReason(error) };
          await this.wait(wait, request.signal);
        }
        yield { type: "route", from: hop.route.label, to: next.route.label, reason: fallbackReason(error) };
      }
    }

    // A chain that ended only in rate limits is a different message from one
    // that ended in anything else: the quota refills on its own schedule, and
    // the useful advice is to wait or pick another model, not to debug.
    const allLimited = failures.length > 0 && failures.every((failure) => failure.includes("rate-limited"));
    throw new ProviderError(
      allLimited
        ? `Every route is rate-limited — ${failures.join(", ")}. Free quotas refill on their own schedule; wait a bit and send again, or /models to pick another route.`
        : `Every route failed — ${failures.join(", ")}.`,
    );
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

/**
 * Sleeps for `ms`, waking early if the request is cancelled.
 *
 * A plain `setTimeout` would hold a cancelled turn hostage for the whole wait;
 * polling a short slice lets Ctrl+C land within a second of being pressed.
 */
async function interruptibleWait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  const slice = 250;
  let waited = 0;
  while (waited < ms && !signal?.aborted) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(slice, ms - waited)));
    waited += slice;
  }
}

function abortError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}
