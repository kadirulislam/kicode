# Quota and route-health layer — design

> Companion to [`kicode-vision-spec.md`](kicode-vision-spec.md); built by M1–M6
> of [`v1-milestones.md`](v1-milestones.md). Design only; no code changes. Facts about gateway behaviour were checked in September 2026 and
> are cited inline — they are the kind of thing that drifts, so each assumption
> names what happens when it is wrong.

## 1. What this layer is for

Two questions the failover chain cannot answer today:

1. **"Will this route answer?"** — before a request is sent, so a route near its
   cap can be skipped rather than discovered dead. (The spec's *usage
   threshold* trigger.)
2. **"When will this route answer again?"** — after it fails, so exhaustion can
   report a time instead of a shrug.

It answers both from two sources, in this order of trust:

- **headers on the response** — exact, free, but often absent;
- **a provider probe** — a documented endpoint, used sparingly;
- **observation** — what happened last time, remembered per machine.

What it must never do: invent a number. "unknown" is a legitimate answer and has
to be shown as one. The whole product promise is cost honesty.

## 2. What gateways actually send

### 2.1 Header families

Normalise all of these into one snapshot. Per RFC, header names are
case-insensitive; Node's `Headers` already lowercases them.

| Family | Headers | Meaning | Notes |
| --- | --- | --- | --- |
| OpenAI / Groq / most | `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests` | the **RPD** window | Groq: "always refers to Requests Per Day" |
| " | `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-tokens` | the **TPM** window | reset is a duration (`7.66s`) |
| " | `retry-after`, `retry-after-ms` | wait this long | Groq sets it **only** on 429; others use it on 429 and 503 |
| IETF draft / some gateways | `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset` | one window | no `x-` prefix |
| OpenRouter (error only) | `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` | the platform limit that was hit | only on 429/402 |
| diagnostic | `x-request-id` | correlate with the gateway's logs | keep it in the health record's last reason |

**Reset values are not one format.** Accept, in order:

1. a duration string in any concatenated form: `1s`, `7.66s`, `6m0s`, `2m59.56s`,
   `14h12m`, with `ms|s|m|h|d` units;
2. a bare integer or float → **seconds**;
3. an HTTP-date (`Wed, 21 Oct 2026 07:28:00 GMT`) → absolute;
4. an epoch-seconds integer → absolute (only when it is `> 10^9`, which cannot
   be a plausible duration).

A value that parses as none of these is **ignored**, not defaulted — a 0-result
would look like "resets now" and cause a retry storm.

### 2.2 OpenRouter is the awkward one

Verified from the OpenRouter limits documentation (Sept 2026):

- **Successful responses carry no `X-RateLimit-*` headers at all.** Only a
  platform-limit 429 or a 402 does. So a healthy OpenRouter route tells us
  *nothing* from headers alone.
- **`GET https://openrouter.ai/api/v1/key`** (with the same bearer key) returns,
  among other fields:
  `limit`, `limit_reset`, `limit_remaining`, `usage`, `usage_daily`,
  `usage_weekly`, `usage_monthly`, `is_free_tier`, and — the one that matters —
  **`free_model_daily_requests: { used, limit, remaining }`**, the daily counter
  and ceiling that gate `:free` requests. The per-minute limit is **not**
  reported there.
- A 402 error body carries `error.metadata.limit_source`, one of
  `openrouter_in_flight_budget`, `openrouter_key_limit`, or `openrouter_credits`,
  and a `Retry-After` header for the transient case. Branch on `limit_source`,
  not the prose.
- **Mid-stream limits arrive as SSE**, not HTTP: a chunk with
  `finish_reason: "error"` and an `error: { code: 429, … }` object, because the
  200 status was already sent. This is a real case the current provider does not
  detect (see §7).

So OpenRouter needs the **probe** path; the allow-list of providers that do is
small and can grow.

### 2.3 Groq / OpenAI shape (the common case)

Verified from Groq's rate-limits documentation (Sept 2026):

```
retry-after: 2                       # seconds, only on 429
x-ratelimit-limit-requests: 14400    # RPD
x-ratelimit-remaining-requests: 14370
x-ratelimit-reset-requests: 2m59.56s # duration to RPD reset
x-ratelimit-limit-tokens: 18000      # TPM
x-ratelimit-remaining-tokens: 17997
x-ratelimit-reset-tokens: 7.66s
```

Note the asymmetry: **`limit-requests` means per-day, `limit-tokens` means
per-minute.** A snapshot must carry its scope, or "remaining 3" is meaningless.
The token window is a *rate* limit; the request window is a *quota*. They are
different triggers (spec §4.1) and are treated differently (§6).

## 3. The model

```ts
/** Which window a snapshot describes. Guessing wrong is worse than null. */
type QuotaScope = "requests" | "tokens" | "credits";
type QuotaWindow = "minute" | "day" | "month" | "unknown";

type QuotaSnapshot = {
  scope: QuotaScope;
  window: QuotaWindow;
  limit: number | null;
  remaining: number | null;
  /** Absolute ms since epoch when the window resets, or null when unknown. */
  resetAt: number | null;
  /** What the gateway asked us to wait, when it asked. */
  retryAfterMs: number | null;
  source: "headers" | "probe" | "error";
  /** Gateway correlation id, kept so a failure can be traced. */
  requestId?: string;
};

/** How a route may be used, declared by the user (spec §4.7). Fail closed. */
type Retention = "zero" | "may-train" | "unknown";
```

`retryAfterMs` is the one value that may be honoured blindly: it is an explicit
instruction, not an inference, and it is capped (default 60 s) so a gateway
cannot park the session for an hour.

## 4. Capture

### 4.1 On every response

In `src/providers/openai.ts`, the response object is in hand before the first
SSE frame. Read headers there:

```ts
const quota = readQuotaSnapshot(response.headers);   // null when nothing usable
if (quota) yield { type: "quota", snapshot: quota };
```

A new `StreamEvent`/`AgentEvent` pair, `quota`, is additive: providers that send
nothing never emit it, and the agent can carry it to the route store.

For a **non-2xx** response, parse the body's `error.metadata` (OpenRouter) and
merge: the status becomes the failure reason, and the body may carry the
`limit_source` that tells a transient budget from a dead key.

### 4.2 On a 429 or 402

Always produce a snapshot, even when the only facts are the status and a
`retry-after`:

- 429 + `retry-after` → `{ scope: "requests", remaining, retryAfterMs, resetAt: now + retryAfterMs, source: "error" }`.
- 402 + `limit_source: openrouter_credits` → **exhausted**, no retry (adding
  credit is the fix; retrying is not).
- 402 + `limit_source: openrouter_in_flight_budget` → **throttled**, honour
  `Retry-After`, retry the same route.

### 4.3 Probes

A probe is a documented, cheap read that returns the account's remaining quota,
run lazily and cached:

| Gateway kind | Probe | Cost | Staleness |
| --- | --- | --- | --- |
| OpenRouter | `GET {base}/key` | one request, no tokens | 60 s, or after any 429/402 |
| OpenRouter | `GET {base}/endpoints/zdr` | one public metadata read | 6 h, or on demand |
| anything else | none | — | — |

Detection is by `baseUrl` host (`openrouter.ai`), not by name. A probe failure
is silent: no snapshot is better than a wrong one, and a probe must never turn
into a second failure the user sees.

**Probes are only run when a route is a candidate** for an actual request — never
on a timer, never at startup for every configured route. A tool that quietly
polls six gateways on launch is a tool that gets rate-limited for existing.

### 4.4 When there are no headers and no probe

The route is `unknown`. It is still eligible — it just cannot be skipped
pre-emptively, and rotation after it fails is reactive. The HUD says
`quota unknown`, not `100%`.

## 5. The local store

**File:** `$KICODE_HOME/routes.json` (default `~/.kicode/routes.json`), beside
sessions and favourites. Same rules as those: written atomically (temp file +
rename), never a key written, tolerant of a corrupt file (parse failure =
start empty, warn once).

```jsonc
{
  "version": 1,
  "routes": {
    "https://openrouter.ai/api/v1#deepseek/deepseek-v4-flash:free": {
      "model": "deepseek/deepseek-v4-flash:free",
      "baseUrl": "https://openrouter.ai/api/v1",
      "retention": "unknown",
      "lastOkAt": "2026-09-30T10:00:00.000Z",
      "lastFailAt": "2026-09-30T10:04:00.000Z",
      "lastReason": "rate-limited (HTTP 429)",
      "consecutiveFailures": 2,
      "quota": { "scope": "requests", "window": "day", "limit": 50, "remaining": 3,
                 "resetAt": "2026-10-01T00:00:00.000Z", "source": "probe" },
      "recent": [ { "at": "…", "status": 429 }, { "at": "…", "status": 200 } ]
    }
  }
}
```

- **Key**: `${baseUrl}#${model}` — the same identity the model picker already
  uses, so a row and its health are the same thing.
- **`recent`** keeps a bounded ring (32 entries) for "flaky" detection. It is
  per-machine and never leaves it (spec §9: no telemetry).
- **Pruning**: entries untouched for 30 days are dropped on load, so an
  abandoned gateway does not accumulate forever.
- **Concurrency**: one process, one writer; reads on demand, writes debounced
  (at most once per 5 s) so a streaming session is not doing file I/O per token.

### 5.1 Health states

Derived, not stored — a pure function of the record plus `now`:

| State | Condition | Effect on ordering |
| --- | --- | --- |
| `unknown` | no record | eligible; last in its tier |
| `healthy` | last event 200, or failures < 2 | normal |
| `flaky` | `recent` alternates ok/fail | eligible but ranked after healthy peers |
| `throttled` | last failure had `retryAfterMs`, `now < resetAt` | deferred until `resetAt` |
| `capped` | a quota snapshot with `remaining === 0`, `now < resetAt` | deferred until `resetAt` |
| `broken` | 401/403, or 404 with a configured model, or ≥3 consecutive 5xx | **excluded**, and surfaced in the UI |

`capped` vs `throttled` matters: a capped route is deferred by hours; a throttled
one by seconds. The spec's "brief pause, then switch" is the throttled case.

## 6. How it drives failover

```ts
function order(routes, now, consent): { try: Route[]; deferred: Route[] } {
  const eligible = routes.filter((r) => retentionSafe(r));          // §7
  const allowed  = eligible.filter((r) => isFree(r) || consent.has(r.id));

  const { ready, held } = partition(allowed, (r) => !isDeferred(r, now));
  ready.sort(byTierThenDeclaredOrder);        // free first, then cheapest, then declared order
  held.sort((a, b) => (a.resetAt ?? Infinity) - (b.resetAt ?? Infinity));
  return { try: [...ready, ...held.filter(stillWorthTrying)], deferred: held };
}
```

Rules:

1. **Free before paid** — `isFree(r)` is the only price fact KiCode trusts, and
   the one the audience cares about.
2. **Cheapest after that** — endpoint-reported price when present, "unknown"
   otherwise; unknown ranks *below* known-cheap paid routes but *above* nothing.
3. **Paid needs consent** — a route is only in `allowed` with a per-session
   yes (spec §4.1). Consent is asked once per route, not per request.
4. **Retention filter runs first** — a route that may train is not a route.
5. **Deferred routes are not deleted** — they are what the exhaustion message
   names, with their reset times. `stillWorthTrying` is true for `throttled`
   routes whose `resetAt` has passed during the current turn.

### 6.1 Decide: pause, retry, or switch

| Situation | Action |
| --- | --- |
| 429, `remaining > 0`, `retryAfterMs <= 5 s` | **Pause the same route** and retry once. It is a rate limit, not a quota; switching away wastes a healthy route. |
| 429, `remaining > 0`, no/long `retry-after` | **Switch** to the next ready route; mark `throttled` for `retryAfterMs` or a short default (30 s). |
| 429/402, `remaining === 0` | **Switch**, mark `capped` until `resetAt`. |
| 5xx | Switch; if three in a row, mark `broken` and exclude for the session. |
| 401/403 | **Never switch silently past a bad key** — surface it (existing rule). Another route may still answer, but the key must be named. |
| Nothing ready | **Exhaustion**: save, keep the partial work, report the soonest `resetAt` (spec §4.1). |

The visible "brief pause" (spec) is the first row's wait and the switch's UI
announcement — one mechanism, two cases.

## 7. Mid-stream failures (must not be missed)

Once tokens have streamed, nothing can be rerouted — the answer is already on
screen. But the failure must still be *seen*:

- **OpenRouter** signals a mid-stream limit with an SSE chunk whose
  `finish_reason` is `"error"` and which carries an `error` object. The current
  provider treats an unknown `finish_reason` as `"stop"` and would end the turn
  as if it completed.
- Fix: detect `chunk.error` (and `finish_reason === "error"`) in the SSE loop
  and throw a `ProviderError(…, error.code)`.
- The existing partial-reply behaviour then keeps what was written, and the
  route is marked `throttled`. The UI reports the interruption and offers the
  next route as an explicit retry.

## 8. Privacy and retention

- `retention` is declared per provider/route in `kicode.json`
  (`"zero"`, `"may-train"`, `"unknown"`), defaulting to **`unknown`**, which is
  treated exactly like `may-train`: not eligible for automatic use.
- A route may be used anyway with an explicit per-run consent
  (`--allow-training-routes` or a prompt), which is recorded in the session, not
  assumed.
- The store keeps `retention` so the picker can show why a route is greyed out.
  Greyed-out with a reason, never silently missing (existing KiCode rule).

**Enforcement is delegated to the gateway, not guessed locally.** See
[`free-route-retention.md`](free-route-retention.md), which verified this:

- For an endpoint that supports it (OpenRouter today), a request on a
  `retention: "zero"` route carries `provider: { "zdr": true }`. The gateway
  then refuses to route to a retaining endpoint, so KiCode never has to know
  which provider would have served the request. The flag ORs with account
  settings and cannot be turned off per request.
- `GET {base}/endpoints/zdr` (public, cached like the `/key` probe) is the
  advance check: it marks a configured route in `/models` before a request is
  spent on a failure.
- **A ZDR refusal is a route failure, never a privacy downgrade.** If asking for
  ZDR leaves no provider for a route, the request fails and the chain moves on;
  there is no path that retries the same request without `zdr`.

## 9. Config surface

```jsonc
{
  "rotateAtRemaining": 2,          // skip a route with fewer than this many left (default 2)
  "retryAfterCapMs": 60000,        // never honour a longer Retry-After than this
  "routes": {
    "openrouter": { "retention": "unknown", "price": "free" },
    "groq":       { "retention": "zero",    "price": "paid" }
  }
}
```

Environment equivalents only where they are genuinely useful:
`KICODE_ROTATE_AT_REMAINING`. Everything else lives in `kicode.json`, because it
is per-project policy, not per-shell state.

## 10. Acceptance tests

Unit (new `src/routes/quota.test.ts`, `src/routes/health.test.ts`):

1. Groq's exact header set → `{scope:"requests", window:"day", limit:14400,
   remaining:14370, resetAt: now+179.56s}` and the token headers produce a second
   snapshot with `window:"minute"`.
2. Reset parsing: `1s`, `7.66s`, `6m0s`, `2m59.56s`, `14h12m`, `"60"`, an
   HTTP-date, and `"banana"` → the last is ignored, never `0`.
3. `retry-after` beyond `retryAfterCapMs` is clamped.
4. OpenRouter success with no headers → no snapshot, `source` stays absent.
5. OpenRouter 402 body `limit_source: "openrouter_in_flight_budget"` →
   `throttled` with `retryAfterMs`; `"openrouter_credits"` → `capped`, no retry.
6. Health derivation: 3× 5xx → `broken`; alternating ok/fail → `flaky`; a
   `resetAt` in the future → `deferred`; a past one → `ready`.
7. Pruning drops a 31-day-old entry and keeps a 29-day-old one.
8. The store never writes a key: assert the JSON contains none of the keys in
   the environment.

Integration (`src/providers/fallback.test.ts`, `src/agent/loop.test.ts`):

9. Two routes, first 429 with `retry-after: 2` and `remaining > 0` → the same
   route is retried once after a pause, and no switch event is emitted.
10. First route capped (`remaining: 0`, reset in an hour) → second route
    answers, one `route` event, and the first is not tried again this session.
11. All routes capped → the turn ends with an `exhausted` event naming each
    route and the soonest reset; the session is saved; the partial work is kept.
12. A paid route is never entered without consent, even when it is the only one
    that could answer (assert a consent prompt, and a refusal on "no").
13. A `may-train` route is never entered automatically.
14. Mid-stream `finish_reason: "error"` → the turn fails with the gateway's
    status, the partial reply is kept, and the route is marked throttled.

Live (manual, one provider that sends headers and one that does not):

15. Set a shape-matching fake or a real Groq key, run a turn, and confirm the
    HUD shows a remaining count that moves after the request.
16. Point at OpenRouter with a free key, run `kicode --models`, and confirm a
    capped route is marked from the `/key` probe — then that a 429 switches
    routes with a named reason.

## 11. Non-goals

- **Predicting a cap that nothing reports.** No learning from "it failed at
  request 50 last Tuesday" in this phase; that is a heuristic with a bad failure
  mode (it defers a route that is actually fine).
- **Polling gateways on a timer.** Probes are candidate-driven and cached.
- **Sharing health.** Local file only (spec §9).
- **Modelling price windows.** Cost is endpoint-reported or "unknown"; the layer
  never estimates money.

## 12. Risks

1. **Header semantics vary and are undocumented for some gateways.** Mitigation:
   scope is carried explicitly and a mis-scoped snapshot is only ever used to
   *defer*, never to hard-block a route for long.
2. **The OpenRouter probe is provider-specific and may change.** Mitigation: it
   is one function, it degrades to "unknown", and a failed probe is silent.
3. **Deferring a route that is actually fine** costs a better-quality model for
   the rest of the session. Mitigation: deferrals last until the reported
   `resetAt` (bounded, default ≤ 1 hour) and `/routes` can clear one by hand.
4. **`recent` history grows.** Bounded ring per route, pruned on load.
5. **Two writers** if two KiCode processes share a `KICODE_HOME`. Mitigation:
   read-merge-write with a debounce, last-writer-wins per route key; a lost
   health entry is cosmetic, never correctness.
