# KiCode Vision — spec

> Status: **spec, not built.** This document is the result of an interview with
> the owner, not a description of the code that exists. Where a decision was made
> in the interview, it is marked **[D]**; where it is my inference that still
> needs confirmation, it is marked **[?]**.

---

## 1. Mission (why this exists)

**Everyone should be able to code with AI, whether or not they can pay for it.**

The owner's own experience is the origin: a year was lost to AI coding because
the tools were expensive and the quotas ran out. A single session of a paid CLI
("few messages, Muse 1.3") consumed 70% of a weekly allowance and 30% of a
monthly one and hit a daily cap — the work simply stopped, mid-flow. Everyone
building today will hit that wall, and it will price people out of learning.

The bet that makes a different answer possible: **there is always a free model
somewhere.** New ones appear every week — gateways publish free routes (`:free`
suffixed ids), and anonymous "stealth" previews show up and are free for a while
(Space Bunny Alpha is the current example: strong at coding, 1M context,
multimodal, free while the deal runs). No single one is reliable, but the set of
them is. A tool that treats routes as replaceable and rotates between them can
ride that supply for $0.

So KiCode's reason to exist is not "another coding agent". It is: **the coding
agent that does not stop when a quota runs out, and does not make you pay to
start.**

### The four things the mission implies

1. **Reach** — it must be easy enough that a developer who has never used an AI
   coding CLI gets value on day one.
2. **Continuity** — a quota hit is a routing event, not an ending. The
   conversation never restarts.
3. **Cost honesty** — real numbers where they exist, an honest "unknown" where
   they don't, and never a silent payment.
4. **Control** — the user's keys, the user's routes, the user's data, on the
   user's machine. No gatekeeper, no relay, no account.

## 2. Identity and audience

| | |
| --- | --- |
| Identity **[D]** | **Evolve KiCode** — same project, same name. This is its next phase, not a new product. |
| Primary audience **[D]** | **Developers who can code but can't or won't pay for AI.** Not beginners first, not non-programmers. |
| Success **[D]** | **It replaces a paid CLI** — good enough that paying for another coding CLI feels unnecessary. |
| Distribution **[D]** | **npm single file.** `npx kicode` / `npm i -g`. (Later: an installer and prebuilt binaries — not required for this phase.) |
| Runtime | Node, one bundled `dist/cli.js` (as today). |

## 3. Design principles

These are the rules every feature in this spec is measured against.

1. **The free route is the default route.** Anything that only works on a paid
   route is a feature that only works for some users.
2. **A quota hit is a pause, not an error.** The user should *see* it happen and
   the task should continue. **[D]** "Brief pause, then switch."
3. **Nothing is spent silently.** Free routes are used automatically; anything
   that costs money needs a yes. **[D]** "Never without asking."
4. **When everything is gone, hand back cleanly.** Save the work, keep the
   transcript, say when routes free up. **[D]** "Save and hand back."
5. **The agent suggests; it does not act uninvited.** **[D]**
6. **Your code is yours.** Free routes that train on input are refused by
   default; only zero-retention routes are eligible. **[D]**
7. **Never fail silently** (existing KiCode rule). A route change, a refusal, an
   empty result — each names itself.
8. **Zero runtime dependencies, by default.** The single-file install and the
   hand-rolled TUI are part of the answer (they're what makes `npx kicode` work
   anywhere). A dependency is allowed only when it beats the alternative and the
   argument is written down. **[D]** "Default, with argued exceptions."
9. **Own the loop.** No relay, no reseller, no pooled/quota-sharing service —
   that breaks provider terms and inverts "you own the conversation".

## 4. Core features

### 4.1 Route registry and failover

**The route** is the unit: an endpoint + model + key. Providers are a way to
group routes; the thing that answers a request is a route.

- A session is a **chain**: the route in use, then backups. Failover already
  exists in embryo (`src/providers/fallback.ts`: replays the same request on the
  next route before the first token, reports the swap).
- **Trigger conditions** **[D]** — rotate on:
  - an HTTP error code (402/404/429/5xx or a connection failure) — *a "code hit"*;
  - a **usage threshold** read from **gateway response headers**
    (`X-RateLimit-*` / `Retry-After`) — rotate *before* the limit is hit;
  - a **request-rate limit** (per-minute throttling) even when quota remains.
- **Ordering** **[D]** — **free routes first, cheapest after that.** In practice:
  - all free routes in the user's declared order;
  - then paid routes, cheapest first, **but a paid route is never entered
    automatically** — it pauses and asks. "Cheapest" therefore only ever ranks
    *candidate* paid routes when the user has said yes.
- **The switch is visible** **[D]** — "brief pause, then switch": a moment that
  says the limit was hit and which route is taking over. Not silent, not a
  blocking dialog.
- **Exhaustion** **[D]** — when no route can answer: stop the turn cleanly, keep
  the transcript, keep the partial work, tell the user which routes are
  exhausted and when the nearest one frees up. No auto-wait, no local-model
  fallback by default (see 4.6).
- **Route health is remembered locally** **[D]** — which route worked, when it
  died, why. Surfaced in `/models` and `/status` so the same dead route is not
  tried twice. **Never shared** (no telemetry).
- **Quota knowledge comes from headers only** **[D]** — no invented caps. A
  route that reports nothing has no pre-emptive threshold; it rotates only after
  it fails.

Config shape (extends what exists):

```jsonc
{
  "model": "deepseek-v4-flash:free",
  "fallbackModels": ["qwen3-coder:free", "glm-5.3:free"],   // same endpoint
  "fallback": [{ "provider": "groq", "model": "llama-3.3-70b" }],
  "allowPaidFallback": false,        // [?] paid routes always need a yes anyway
  "routes": {
    "groq": { "baseUrl": "…", "apiKeyEnv": "GROQ_API_KEY", "retention": "zero" }
  }
}
```

### 4.2 Cost honesty and the budget HUD

- **Prices are endpoint-reported** **[D]**. When a gateway returns price/tier
  metadata, show it; when it returns nothing, show **"unknown"** — never invent
  a price, never silently rank on a made-up number.
- The free/paid split is the one thing KiCode knows for certain, and it is the
  one that matters most to this audience. The model picker already has
  `all` / `free` / `paid` tabs; keep them and make them the front door.
- **A visible HUD** **[D, v1]**: tokens, cost-or-unknown, active route, and the
  session's budget state, always on screen (the footer is the natural home).
- The **token budget** already exists (ceiling checked between requests, never
  mid-stream, `/budget`, `KICODE_MAX_TOKENS`, `--max-tokens`). Extend it with a
  **money cap** for users who opt into paid routes.
- **No surprise spend, ever** **[D]**: crossing into paid is a prompt.

### 4.3 Interactivity (the reason to switch from a paid CLI)

All five are in v1 **[D]**:

- **Mouse everywhere** — clickable picker rows, tabs, diffs, and buttons, not
  just the tab bar.
- **Live previews** — see the file, diff, or rendered result as the cursor
  moves, without running a command.
- **Smarter streaming** — richer answer rendering: syntax-aware code blocks,
  tables, inline command output, tool results that expand in place.
- **Instant task control** — pause, branch, undo, rewind a running task from a
  panel, mid-run.
- **The budget HUD** (4.2).
- **Clipboard, extended** **[D, named explicitly]** — the "paste anything"
  branch keeps growing: clipboard text and images already paste; the spec should
  keep treating the clipboard as a first-class input surface.

### 4.4 Memory and skills — via Hermes, recommended not required

- **Hermes Agent is recommended and guided** **[D]**: KiCode detects it, offers
  to set it up, and works without it. It is not a hard dependency and not
  bundled.
- **Both directions** **[D]**: an **MCP bridge** (each agent can call the
  other's tools) *and* **shared files** — KiCode reads Hermes' `MEMORY.md` /
  `USER.md` and its skills, and can write them back so both agents benefit.
- Concretely, Hermes (Nous Research, MIT-licensed, self-hosted, state in
  `~/.hermes/`) keeps agent-curated memory and self-improving skills, and is
  MCP-native. That is exactly the layer KiCode lacks, so building a *parallel*
  memory store instead of using it would be duplicated work.
- **[?]** Open question below: how far KiCode goes writing into `~/.hermes/`
  versus reading it, and what happens when the formats drift between versions.
- If Hermes is absent: no memory layer in v1; KiCode says what to install.

### 4.5 Sub-agents — delegation the model decides

- **Trigger** **[D]**: **the model decides**, by calling a sub-agent tool when it
  judges a task separable. No automatic splitting behind the user's back beyond
  what the model chooses.
- A sub-agent is **a tool, not a second UI**: its own context, its own
  transcript, one summary string back.
- It must **route to a free/cheap model by default** (spending is the thing this
  project exists to avoid).
- It **inherits plan mode, the approval gate, and the token budget** — a
  sub-agent must never be a way around a prompt the parent would have shown.
- The dimmed `/agents` row becomes real when this lands.

### 4.6 Autonomy — suggest, don't act

**[D]** The agent does not act uninvited. The shape of "Hermes-style
intelligence" that KiCode adopts is **advisory**: after a task, it can say what
it would do next and what looks broken; it never starts work on its own. A
background/watcher mode is **out of scope** for this phase (and would need its
own budget and consent model to exist at all).

### 4.7 Privacy

- **Only zero-retention routes are eligible for automatic use** **[D]**. A route
  that may train on input is never entered without an explicit choice.
- This will cost real free options. That is accepted: the audience is developers
  using this for work, and silently shipping their employer's code to a training
  pipeline is not a trade the project can make.
- `retention` should be a declared/known route property, with `unknown` treated
  as unsafe (fail closed).
- **Enforcement is delegated to the gateway** rather than guessed: a request on
  a `retention: "zero"` route asks the endpoint itself to route only to
  zero-retention providers (`provider: { "zdr": true }` on OpenRouter), and the
  published ZDR endpoint list is the advance check. Verified in
  [`free-route-retention.md`](free-route-retention.md).

### 4.8 Model metadata — capabilities from a catalogue, prices from the endpoint

[models.dev](https://models.dev) is an open-source database of model specs —
context limits, modalities, tool calling, reasoning, open weights, and per-1M-token
pricing per provider — with a public JSON API. It is a good fit for three things
KiCode currently cannot know:

1. **Eligibility before a request.** A model that cannot call tools will thrash
the agent loop; a model with a 32K context cannot hold a session. The catalogue
answers both, which makes routing *capability-aware* rather than trial-and-error.
2. **Picker annotations.** Context size, tool support, and modality belong on the
row beside the model name (the picker already has a `trailing` column).
3. **Filling cost gaps — labelled.** Where an endpoint reports no price, the
catalogue can show a **clearly-marked estimate**. It never overrides a price the
endpoint actually reported.

### The API, verified

Read from `packages/core/src/schema.ts` and `packages/sdk/README.md` in
[`anomalyco/models.dev`](https://github.com/anomalyco/models.dev) on 2026-09-30
(the live `/api.json` is over 2 MB, so it cannot be read whole from here — the
schema and the SDK are the authority instead):

| Endpoint | Shape | Use |
| --- | --- | --- |
| `GET /api.json` | `Record<providerId, Provider>` | per-provider serving facts — the one KiCode wants |
| `GET /models.json` | `Record<"provider/model", ModelMetadata>` | provider-agnostic model facts |
| `GET /catalog.json` | both, in one request | when both are needed |
| `GET /model-schema.json` | JSON Schema (draft 2020-12) | validating our own generated artefact |

`Provider` = `{ id, env: string[], npm, api?, name, doc, models: Record<modelId, Model> }`.
The served `Model` record carries what routing actually needs:

- **`tool_call: boolean` and `attachment: boolean` — required fields**, so
  eligibility is a fact rather than a guess;
- `limit: { context: number, input?: number, output: number }`;
- `modalities: { input: Modality[], output: Modality[] }` with `Modality =
  text | audio | image | video | pdf`;
- `reasoning: boolean` plus `reasoning_options` (`toggle` / `effort` /
  `budget_tokens`), `structured_output?`, `temperature?`, `open_weights: boolean`;
- `cost?: { input, output, reasoning?, cache_read?, cache_write?, input_audio?,
  output_audio?, context_over_200k?, tiers? }` — **USD per 1M tokens**, with the
  long-context premium as separate `context_over_200k` and `tiers` entries;
- `status?: "alpha" | "beta" | "deprecated"`, `release_date`, `last_updated`,
  `knowledge?`, and **`canonical_model_id?`** — which links a gateway's model ID
  back to the underlying lab model, i.e. the exact piece a router needs to
  compare "this gateway's `deepseek-v4-flash`" with the same lab model served
  somewhere else, and to attribute a price to a model rather than to a name.

Three consequences that shape the design:

- **`cost` is optional, and "no price" is a real state.** Some served models
  simply have no cost record. That agrees with §4's rule — it stays *unknown*,
  never filled with a guess.
- **"Free" is not a field.** The catalogue has no free flag; free-ness can only
  be *inferred* from zero cost, and an inference is not an authority. The route
  in use stays the authority (the existing `isFree()` `:free`-suffix rule is
  unchanged), and the catalogue at most *annotates* a row.
- **Specialised model types are omitted by default** and selected by `?type=`
  (`decision`, `all`); the default set is the chat/reasoning models a coding CLI
  wants, so the plain request is the right one — and it keeps the payload from
  carrying image and embedding models nobody will route to.
- **A whole-catalogue fetch is not a startup cost.** Over 2 MB from a cold
  start is a real pause, which is why the plan below bakes it rather than
  fetching it.

### Shipping it without a package

The official typed client is
[`@opencode-ai/models`](https://www.npmjs.com/package/@opencode-ai/models), and
it does ship a **snapshot** entrypoint (`@opencode-ai/models/snapshot` —
`providers`, `models`, `generatedAt`, at most ~24 h behind the live API). That is
precisely the "build-time artefact" shape this section asks for, but it is still
a package in the tree for data, so it is **declined as a dependency**
(`ROADMAP.md` §5). The measured plan instead: a `scripts/` job fetches
`/api.json?type=…` at build time and emits a trimmed
`src/generated/models.ts` — only the fields above, only for providers KiCode can
actually talk to — and the result is committed. Same freshness, no dependency,
and still offline after `npx kicode`.

**It is not v1.** No milestone owns it, deliberately: in v1 the route set is
*declared by the user*, so the declaration is the capability filter, and every
price shown is the endpoint's own or the word *unknown*. The catalogue is an
enhancement on top of a working route layer, not a dependency of it — and this
ordering also keeps a community-maintained database from becoming an oracle the
routing decisions rest on (see the accuracy caveat below).

Rules that keep this honest and inside the existing design:

- **It is a catalogue, not a runtime dependency.** The data is generated into a
  build-time artefact (or fetched once and cached), not imported as a package —
  zero-dep stays intact and `npx kicode` keeps working offline with whatever was
  shipped.
- **Endpoint-reported wins, always.** An estimate is a different thing from a
  fact and is labelled differently (`est.` vs the reported price).
- **A registry, not an oracle.** The data is community-maintained and can lag a
  provider by days. So it is used for *discovery and normalisation* (which models
  exist, which can call tools, how big the context is) and never as the last word
  where money or reliability is at stake: the endpoint's own report wins, and a
  capability the runtime has already seen fail (a model that errors on `tools`)
  outranks a `tool_call: true` in a file someone edited last Tuesday.
- **Unavailable is not the same as unknown.** A model the catalogue has never
  heard of is shown without metadata, not hidden.
- **A fetch is a network call, so it is opt-in and cached.** Reading a public
  metadata file is not telemetry and carries no user content, but it is still a
  request the user did not make, so it follows the same rule as the quota probes:
  candidate-driven, cached, silent on failure, never on a timer.

## 5. Where it lands in the existing code

Starting points from what is already built (not a full design):

| Area | Existing piece | Change |
| --- | --- | --- |
| Failover | `src/providers/fallback.ts`, `FallbackProvider` | Add header-driven quota tracking, request-rate limits, free-then-cheapest ordering, paid-needs-consent, exhaustion state |
| Config | `config.ts` `fallback` / `fallbackModels` / `maxTokens`, `settings-file.ts` | Route metadata: `retention`, price tier, declared limits |
| Provider | `src/providers/openai.ts` | Capture `X-RateLimit-*` / `Retry-After` from the response and pass a quota snapshot up |
| Loop | `src/agent/loop.ts` `AgentEvent` (`route`, `budget`) | Events for pause/switch/exhausted, money cap, sub-agent tool |
| TUI | `src/tui/frame.ts` (`Picker.tabs`, footer, `renderFrame` is pure) | Budget HUD, mouse hit-testing beyond the tab bar, live previews, task-control panel |
| Memory/skills | `src/mcp/` client (tools only today) | MCP bridge to Hermes, shared memory/skills files |
| Cost | `Agent.spentTokens` | Money alongside tokens when the endpoint reports it |

## 6. Non-goals (explicitly out)

- **A relay, a reseller, or a shared key pool.** Breaks provider terms and the
  whole premise. **[D]**
- **Telemetry of any kind.** Route health is per-machine. **[D]**
- **A background agent that works while you're away** (this phase). **[D]**
- **A hosted service or account system.**
- **Chasing a specific paid model's quality.** The product is continuity at $0,
  not the best possible answer at any price.

## 7. Open questions and risks

1. **[?] Hermes file writing** — read-only vs read-write into `~/.hermes/`;
   format drift between Hermes versions; what KiCode does when the format
   changes under it.
2. **[?] The abandoned library list** — chalk/commander/clack/oclif were raised
   then set aside by the dependency rule. If "whatever wins" ever overrides it,
   the TUI is a pure `renderFrame(state, size)` that a framework would fight, so
   the bar to add one is genuinely high.
3. **Free-route supply is volatile.** Space Bunny Alpha is free "while the deal
   runs". The design must assume any specific free route disappears without
   notice, and the *set* is the asset, not any member.
4. **Header-driven quotas are inconsistent.** Many gateways send nothing. When
   they don't, there is no pre-emptive threshold — rotation is reactive. The
   HUD must not imply knowledge it doesn't have.
5. ~~**Zero-retention filtering shrinks the free list.**~~ **Answered** in
   [`free-route-retention.md`](free-route-retention.md): the rule is enforced
   *by the gateway* per request (`provider: { "zdr": true }`) against a
   published, broad ZDR endpoint list, so the design does not depend on
   counting which free routes are safe. Some free routes are still lost, and the
   explicit `retention: "may-train"` escape hatch is the documented trade.
6. **Money caps need a price to cap.** With endpoint-reported prices, a paid
   route that reports nothing cannot be capped. Likely answer: uncapped-price
   paid routes are refused, i.e. same fail-closed logic as retention.
7. **Sub-agent cost.** "The model decides" plus "free model by default" interact:
   if the only eligible model is weak, delegation may be worse than not
   delegating. Needs a test case, not a guess.

## 8. v1 scope **[D — all of these]**

> Broken into ordered, testable milestones in
> [`v1-milestones.md`](v1-milestones.md). The quota and route-health layer
> those milestones depend on is designed in
> [`quota-route-health-design.md`](quota-route-health-design.md).

1. **Failover polish** — visible pause-then-switch, free-then-cheapest ordering,
   endpoint prices, save-and-hand-back on exhaustion, local route health.
2. **Budget HUD** — tokens / cost-or-unknown / active route, always visible.
3. **Mouse everywhere + live previews.**
4. **Instant task control** — pause / branch / undo / rewind mid-run.
5. **Smarter streaming** — richer answer and tool-result rendering.
6. **Memory + skills via Hermes** — recommended/guided setup, MCP bridge, shared
   memory and skills files.
7. **Sub-agents** — model-decided delegation on free/cheap models, inheriting
   plan mode, approval, and the budget.
8. **Clipboard, extended** — the paste-anything surface, kept growing.

## 9. Appendix — interview decision log

| # | Question | Answer |
| --- | --- | --- |
| 1 | What I got most wrong | **All of it**: mission, autonomy, economics, control, and interactivity |
| 2 | KiCode or new? | **Evolve KiCode** |
| 3 | Audience | **Developers who can code but can't/won't pay** |
| 4 | Success | **It replaces paid CLIs** |
| 5 | A quota hit should feel like | **Brief pause, then switch** |
| 6 | Route order | **Free first, then cheapest** |
| 7 | All routes exhausted | **Save and hand back** |
| 8 | Autonomy | **Suggest, don't act** |
| 9 | Hermes fit | **Both** — MCP bridge *and* shared files |
| 10 | Delegation trigger | **The model decides** |
| 11 | Free-route privacy | **Only zero-retention routes** |
| 12 | Cost model | **Endpoint-reported**, "unknown" otherwise |
| 13 | Distribution | **npm single file** |
| 14 | Dependency rule | **Zero-dep default, argued exceptions** |
| 15 | Interactivity | **All**: mouse everywhere, live previews, smarter streaming, instant task control, budget HUD |
| 16 | Memory sequencing | Initially "wait for Hermes", refined to **recommended + guided** |
| 17 | What is a "code hit" | **HTTP error code**, **usage threshold**, and **request-rate limit** |
| 18 | Hermes required? | **Recommended, guided** (works without) |
| 19 | Paid routes | **Never without asking** |
| 20 | Quota source | **Gateway headers** |
| 21 | Local models | **Just another endpoint** (already works via `baseUrl`) |
| 22 | Telemetry | **Local only** — route health per machine, never shared |
| 23 | Spec tone | **Both**, mission first |
| 24 | v1 scope | **All listed items**, plus clipboard features |

### External context gathered

- **Hermes Agent** (Nous Research) — open-source, self-hosted, MIT-licensed;
  agent-curated memory (`MEMORY.md` / `USER.md`), self-improving skills, FTS5
  session search, MCP-native, state under `~/.hermes/`.
- **Space Bunny Alpha** — anonymous "stealth" model, strong coding + 1M context +
  multimodal, free for a limited promotional run; listed on OpenRouter and
  cloned across gateways (aimlapi, kilo, commandcode). Illustrates the
  "free this week" supply the design depends on.
- **OpenRouter free tier** — roughly 20 requests/min and a daily cap (raised by
  holding a paid balance), and an `openrouter/free` router that picks a free
  model at random. Free routes typically train on input — the reason for the
  zero-retention rule.
