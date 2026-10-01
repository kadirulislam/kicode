# KiCode v1 — ordered milestones

> Companion to [`kicode-vision-spec.md`](kicode-vision-spec.md) (what and why),
> [`quota-route-health-design.md`](quota-route-health-design.md) (how quota and
> route health work), [`route-consent-design.md`](route-consent-design.md) (the
> money prompt) and [`free-route-retention.md`](free-route-retention.md) (the
> zero-retention answer). This file is the build order.
>
> **Baseline already in the repo, do not rebuild:** the failover provider
> (`src/providers/fallback.ts`), the token budget (`Agent.maxTokens`,
> `/budget`, `KICODE_MAX_TOKENS`, `--max-tokens`), the model picker's
> `all`/`free`/`paid` tabs, `Picker.tabs`, the `route`/`budget` agent events, the
> partial-reply keep on cancel, and clipboard text/image paste.
>
> **Already prototyped (M1–M2, done):** `src/routes/quota.ts` (the header and
> duration parser, `QuotaSnapshot`/`QuotaReading`), `src/routes/probe.ts` (the
> OpenRouter `/key` probe with a 60 s cache), the `quota` stream/agent event, and
> their tests. What remains of M1–M2 is wiring the probe into the ordering path,
> which is M3–M4's job.
>
> **Deliberately not in v1:** the models.dev capability catalogue (spec §4.8).
> No milestone owns it on purpose — in v1 the route set is *declared by the
> user*, so the declaration is the capability filter, and every price shown comes
> from the endpoint or is labelled unknown. The catalogue lands afterwards, and
> when it does it is build-time data fetched by a script, never a runtime
> dependency (`ROADMAP.md` §5).

## Definition of done (every milestone)

1. `npm run typecheck` clean.
2. `npx vitest run` green — new tests included, no existing test weakened.
3. `npm run build` succeeds; `dist/cli.js` still one file.
4. README updated for anything user-visible; a `ki-agent-brain` memory note
   appended (the project's convention).
5. A zero-dependency rule check: no new runtime dependency, *or* the argument
   for one written in `ROADMAP.md` §5.

**Verification constraint (carried from the repo's own notes):** the agent's
shell has no TTY, so interactive behaviour is verified by tests that drive the
real `runTui` through a fake terminal, and by pure `renderFrame` tests.
`--tui-preview` cannot draw a modal or a picker — use a throwaway eyeball test
for frames, then delete it.

---

## Phase 1 — Never blocked (the mission)

### M1 — Quota capture from gateways
**Goal:** the session knows what a route has left, when the gateway says so.
**Depends on:** nothing.
**Build:** `src/routes/quota.ts` (`QuotaSnapshot`, header parser, duration
parser); `src/providers/openai.ts` reads `response.headers` before the first SSE
frame and emits a new `quota` `StreamEvent`; non-2xx bodies parsed for
OpenRouter's `error.metadata.limit_source`. `Agent` carries `quota` through as
an `AgentEvent`.
**Design:** quota-route-health-design §2–§4.

**Acceptance tests**
- Groq's documented header set produces `{scope:"requests", window:"day",
  limit:14400, remaining:14370, resetAt: now+179.56s}`; the `-tokens` headers
  produce a second snapshot with `window:"minute"`.
- Reset parsing accepts `1s`, `7.66s`, `6m0s`, `2m59.56s`, `14h12m`, `"60"`,
  and an HTTP-date; `"banana"` yields **no** reset (never `0`).
- A success with no headers emits no `quota` event (OpenRouter's normal case).
- 402 with `limit_source:"openrouter_in_flight_budget"` → throttled with
  `retryAfterMs`; `"openrouter_credits"` → capped with no retry.
- `retry-after` longer than the cap is clamped.

### M2 — OpenRouter probe
**Goal:** a capped free route is known before it is used, not after.
**Depends on:** M1.
**Build:** `src/routes/probe.ts` — `GET {base}/key` for `openrouter.ai` hosts,
cached 60 s, candidate-driven only; silent on failure. A second probe,
`GET {base}/endpoints/zdr`, cached for hours, provides the zero-retention
endpoint set (see [`free-route-retention.md`](free-route-retention.md) §4.2).
**Design:** §4.3, §12.2.

**Acceptance tests**
- A probe response with `free_model_daily_requests: {remaining: 0, limit: 50}`
  marks the route capped with the day's `resetAt`.
- The probe runs **at most once per 60 s per route** (assert call count across
  three requests).
- A failing probe leaves prior state untouched and reports nothing to the user.
- No probe is attempted for a non-OpenRouter host.
- The ZDR list is fetched at most once per its TTL and marks a configured route
  as ZDR-eligible in `/models`; a model absent from the list is shown as
  not-ZDR rather than assumed safe.

### M3 — Local route health store
**Goal:** "that route was dead an hour ago" survives a restart, on this machine.
**Depends on:** M1.
**Build:** `src/routes/health.ts` — `$KICODE_HOME/routes.json`, keyed
`baseUrl#model`, atomic writes, debounced ≤1/5 s, 30-day prune, corrupt-file
tolerance; derived `unknown|healthy|flaky|throttled|capped|broken`.
**Design:** §5.

**Acceptance tests**
- Three consecutive 5xx → `broken`; alternating ok/fail → `flaky`; future
  `resetAt` → deferred; past → ready.
- A 31-day-old entry is pruned on load; a 29-day-old one survives.
- A corrupt file loads as empty with one warning, and is not overwritten until
  something changes.
- The written JSON contains no API key.
- `/status` (or `/routes`) lists each route's state and the reason.

### M4 — Ordering: free, then cheapest, with consent
**Goal:** the chain always prefers $0 routes, never spends by itself, never uses
a training route.
**Depends on:** M1, M3.
**Build:** `src/routes/order.ts` — the `order()` function; `FallbackProvider`
consumes it; `config.ts`/`settings-file.ts` gain `routes[].retention` and
`routes[].price`; a `RouteConsentFn` asks once per route per session, designed in
full in [`route-consent-design.md`](route-consent-design.md); a `retention:
"zero"` request carries `provider: { "zdr": true }` where the gateway supports
it; `retention` defaults to `unknown` (= unsafe).
**Design:** §6, §8.

**Acceptance tests**
- With `[paid-cheap, free-a, paid-expensive]` and no consent → only `free-a` is
  tried.
- Saying yes to `paid-cheap` puts it after `free-a`; the other paid route is
  still never entered.
- A `may-train` and an `unknown` route are both skipped automatically; a
  `--allow-training-routes` run uses them and records it in the session.
- "Cheapest" only ranks routes whose price the endpoint reported; unknown-price
  paid routes rank below known-cheap ones.
- Capped routes are deferred; the next ready route answers.
- A `retention: "zero"` request sends `provider: { "zdr": true }`; a ZDR refusal
  fails the route and moves on, and **no code path retries it without `zdr`**
  (assert the request body of every retry).
- No money is spent without both consent **and** a money cap (see the consent
  design for the full interaction tests).

### M5 — The visible switch and clean exhaustion
**Goal:** a quota hit is a pause and a switch; the end of all routes is a
graceful stop with a time.
**Depends on:** M4.
**Build:** `FallbackProvider` pause/retry/switch decision table; new
`AgentEvent { type: "exhausted"; routes: {label, reason, resetAt}[] }`;
`app.runTurn` renders the switch note and, on exhaustion, saves and stops
without an error tone; "brief pause" is the ≤5 s same-route retry.
**Design:** §6.1.

**Acceptance tests**
- 429 + `remaining>0` + `retry-after: 2` → the same route is retried once, and
  **no** route-switch event is emitted.
- 429 + `remaining: 0` → one switch event; the first route is not tried again
  this session.
- All routes capped → one `exhausted` event listing each route and the soonest
  reset; the session file is written; the transcript keeps the partial work; the
  turn ends with a warn note, not an error.
- The switch note names the reason ("rate-limited (HTTP 429)"), not just the new
  route.

### M6 — Mid-stream failures
**Goal:** a limit that arrives after tokens have flowed is reported, not
mistaken for a finished answer.
**Depends on:** M1.
**Build:** `src/providers/openai.ts` SSE loop detects `chunk.error` /
`finish_reason:"error"` and throws a `ProviderError` with the gateway's code;
the route is marked throttled.
**Design:** §7.

**Acceptance tests**
- A scripted SSE stream whose last chunk carries
  `{error:{code:429}, choices:[{finish_reason:"error"}]}` → the turn fails with
  that status; the partial reply is still in `agent.turns`; the route is
  throttled; the transcript is not marked complete.
- A normal `finish_reason:"stop"` is unaffected.

### M7 — Cost + the budget HUD
**Goal:** tokens, money-or-unknown, and the active route are always visible; a
money cap exists for anyone who opts into paid routes.
**Depends on:** M4.
**Build:** endpoint price captured with the quota snapshot; `TuiState.usage`
grows `route`, `cost: number | null`; footer spans show `route · cost-or-unknown`
alongside tokens; `/budget` learns a money cap for paid routes; the token
ceiling keeps its current between-requests semantics.
**Design:** §10.1–10.3 (spec §4.2).

**Acceptance tests**
- Frame tests: the footer shows the active route and `$0` for a free route;
  shows `cost unknown` when the endpoint reports no price; never invents a
  number.
- A money cap stops the turn between requests with a named note; a mid-stream
  turn finishes (same rule as tokens).
- `/budget` with no argument reports both ceilings; `/budget 500000` sets the
  token one; a money cap can be removed with 0.

---

## Phase 2 — The interface (why to switch from a paid CLI)

### M8 — Smarter streaming
**Goal:** answers and tool output render well enough that reading them is a
pleasure.
**Depends on:** nothing (independent of Phase 1; may be built in parallel).
**Build:** `src/tui/markdown.ts` — fenced-code blocks with light syntax
colouring, tables, and nested lists; tool results that expand in place
(click/key to show the full output) instead of a fixed 3-line clip.
**Design:** spec §4.3.

**Acceptance tests**
- A fenced ```ts block renders with code styling; an unterminated fence still
  renders as code (never swallowing the rest of the answer).
- A markdown table stays aligned at 80 and 60 columns, and degrades to key/value
  lines rather than wrapping badly.
- A long tool result shows a clip plus an indicator, and expanding it shows the
  whole thing; `/copy` still yields the full text.
- Every span still ends with `RESET`; the last column stays unpainted.

### M9 — Mouse everywhere
**Goal:** anything on screen that can be chosen can be clicked.
**Depends on:** M8 (shares the layout pass).
**Build:** generalise `TabHit` into `renderFrame` returning `hits: HitRegion[]`
(`{x, y, w, h, action}`); the app dispatches by region for picker rows, palette
rows, modal options, and buttons; dragging the scrollbar/transcript still works.
**Design:** spec §4.3.

**Acceptance tests**
- Clicking a picker row selects it; clicking outside the panel closes it.
- Clicking `y`/`a`/`n` in the approval modal resolves that decision, and Escape
  still denies.
- A hit region never overlaps the unpainted last column (assert
  `x + w <= cols - 1` for every region at 80 and 60 columns).
- Clicking a transcript link/row does not scroll the view unexpectedly.

### M10 — Live previews
**Goal:** see the file, diff, or result as the cursor moves.
**Depends on:** M9.
**Build:** a preview pane driven by the selection; async reads with an LRU cache
(cap by bytes, not entries); the renderer stays pure — the app fetches and hands
spans in.
**Design:** spec §4.3.

**Acceptance tests**
- Moving the cursor to a different row swaps the preview; the frame is drawn
  from cache with no await on the render path.
- A 5 MB file previews its head with a truncation note, not a hang.
- A binary file says so instead of dumping bytes.
- The pane is absent below a width/height threshold and the list gets the room.

### M11 — Instant task control
**Goal:** pause, branch, undo, and rewind a task while it runs.
**Depends on:** M9.
**Build:** a task panel; pause reuses the existing cancel/suspend and a resume;
branch forks the session at the selected message (the fork machinery already
exists); undo/rewind surface the existing `rewind`.
**Design:** spec §4.3, §4.6 (autonomy stays advisory).

**Acceptance tests**
- Pause stops after the current tool (not mid-tool), and resume continues in the
  same session with the same transcript prefix.
- Branch creates a new session whose messages are exactly the prefix up to the
  chosen point; the original is untouched.
- Undo drops the last request and everything it produced (existing behaviour),
  and the panel shows the resulting message count.
- No control action starts work the user did not ask for.

### M12 — Clipboard surface
**Goal:** the clipboard is a first-class input, whatever it holds.
**Depends on:** nothing.
**Build:** extend `ClipboardRead` beyond text/image: multiple images, pasted
file paths (a drag-and-drop path is a file reference), and a small paste history
(`/paste <n>`); keep the existing truncation and mojibake guards.
**Design:** spec §4.3.

**Acceptance tests**
- Pasting two images attaches both, and the transcript marker says `2 images`.
- Pasting a path that exists attaches it as a file reference; a path that does
  not exist says so.
- `/paste` with no clipboard still says the clipboard is empty (never silent).
- A 100 001-character paste truncates with the existing note.

---

## Phase 3 — Intelligence

### M13 — Hermes: detect and guide
**Goal:** if Hermes is installed, KiCode offers to use it; if not, it says how.
**Depends on:** nothing.
**Build:** detect `~/.hermes/` (and optionally `hermes` on `PATH`); a
`/connect hermes` command that explains and offers the setup; a `hermes` block
in `kicode.json`; no hard dependency.
**Design:** spec §4.4, ROADMAP §2.

**Acceptance tests**
- With a fake `~/.hermes/` present, `/connect hermes` reports what it found and
  writes the config block.
- With neither present, it prints install guidance and changes nothing.
- With Hermes absent, every other feature still works (no startup error, no
  banner noise).

### M14 — Hermes: MCP bridge + shared memory/skills
**Goal:** memory and skills carry across KiCode and Hermes, both directions.
**Depends on:** M13, and the existing `src/mcp/` client.
**Build:** mount a Hermes MCP server (stdio) from the config block; read
`MEMORY.md`/`USER.md` and the skills directory; a gated `remember` write path
(off by default, opt-in per run); skills loaded by name with descriptions up
front and bodies read on demand.
**Design:** spec §4.4; open question 1 in the spec.

**Acceptance tests**
- A fake stdio MCP server that serves one memory tool is mounted, and its tool
  appears in the registry with the `mcp__` prefix.
- `MEMORY.md` content is read and offered to the model without being injected
  into every prompt verbatim.
- With writes not enabled, nothing under `~/.hermes/` is modified (assert mtimes).
- A malformed/unknown Hermes file version is reported once and skipped, not
  fatal.
- A skill's body is not read until the model asks for it.

### M15 — Sub-agents
**Goal:** the model can hand a separable task to a cheaper, isolated context.
**Depends on:** M14 (memory makes delegation useful), M7 (budgets).
**Build:** a `task` tool on the tool registry; it builds a child `Agent` with
its own transcript, routed to the cheapest eligible free route, inheriting
`readOnly` (plan mode), the approval gate, and a token ceiling; one summary
string returns. `/agents` stops being a dimmed row.
**Design:** spec §4.5.

**Acceptance tests**
- A parent turn whose model calls `task` runs the child against a scripted
  provider; the child's tool calls do not enter the parent's transcript, and
  exactly one summary message does.
- In plan mode, a child's write tool call is refused with the plan-mode reason.
- The child's spend is capped by its token ceiling even if the parent's is
  higher; the parent's `spentTokens` includes the child's.
- A child is never routed to a paid or `may-train` route automatically.
- Recursion is bounded (a child may not spawn a child beyond a configured depth).

---

## Sequencing notes

- **Phase 1 is the mission** — M1→M7 is the smallest set that delivers "a quota
  hit no longer ends the work". Ship it as a version before starting Phase 2.
- **M8–M12 are independent of Phase 1** and can be interleaved by whoever is
  building; M9 gates M10 and M11 on purpose (one layout pass, one hit-test pass).
- **Phase 3 is deliberately last**: memory (M14) needs the route layer to be
  settled so a `remember` write cannot land on a `may-train` route, and
  sub-agents (M15) need both the budget (M7) and memory to be worth their cost.
- **Risk gates**: if M2 shows OpenRouter's probe is unreliable, M4's
  ordering still works reactively — do not block Phase 1 on it. If M4 finds too
  few `retention: "zero"` free routes to be useful, stop and revisit spec open
  question 5 *before* building M5's wording around a promise the routes cannot
  keep.
