# Do free routes survive the zero-retention rule?

> Answers spec open question 5: *"Confirm in practice how many free routes
> survive the privacy rule; if it is very few, the mission and the rule are in
> tension."* Findings checked September 2026.

## 1. The answer, in one line

**The mission holds, but not by counting routes up front — by making the gateway
enforce the rule.** Zero-retention enforcement is available *per request*, and
the ZDR pool is published and broad. The design should therefore ask the
gateway to route only to ZDR endpoints, rather than trying to keep a list of
which free routes are safe.

## 2. What was verified

### 2.1 ZDR means what the rule needs

From OpenRouter's ZDR documentation:

- Zero Data Retention means a provider **will not store your data for any
  period**.
- **"Providers that do not retain your data are also unable to train on your
  data."** That is the property the rule is actually about.
- But a provider *can* decline training while still retaining data (for abuse
  scanning or legal reasons), and OpenRouter exposes **separate controls for
  the two policies**. So "may train" and "may retain" are different questions
  and the design must ask the retention one.
- When OpenRouter cannot establish a clear policy for an endpoint it is
  **conservative**: it assumes the endpoint both retains and trains, and marks
  it so. That is the same fail-closed stance this spec takes, which means the
  two agree by construction.

### 2.2 Enforcement can be per request

ZDR can be enforced account-wide, per model group, per guardrail, or **per
request**:

```jsonc
{ "model": "…", "messages": [ … ], "provider": { "zdr": true } }
```

The per-request flag **ORs** with account and guardrail settings — it can only
turn ZDR *on* for a request, never off. That is exactly the property needed: a
code path that must not leak cannot be silently downgraded by config.

### 2.3 The ZDR pool is published and broad

OpenRouter publishes the current list at:

```
GET https://openrouter.ai/api/v1/endpoints/zdr
```

Confirmed live and unauthenticated. Each entry carries `provider_name`,
`model_id`, `model_name`, `tag`, `context_length`, per-token `pricing`,
`supported_parameters` (including `tools` / `tool_choice` when the endpoint can
call tools), and uptime figures.

The sample pulled for this check already included ZDR endpoints from Azure,
Google Vertex, Amazon Bedrock, Fireworks, BaseTen, DeepInfra, Novita, Venice,
Decart, Wafer, and xAI — including endpoints that support tool calling. In other
words: **the ZDR pool is not a fringe corner; it spans the providers that serve
the popular coding models.**

Corroborating figures: OpenRouter reported (June 2026) **97 new ZDR models added
since January**, with monthly token volume on those endpoints up **4.3×**. The
trend is the right direction for this rule.

### 2.4 A stealth free model can be ZDR

The `:free` routes and the ZDR routes are different sets, but at least some free
routes advertise zero retention — Space Bunny Alpha, the current stealth
example, is described as zero data retention with 1M context and multimodal
input.

## 3. What could **not** be verified from here

**The exact size of the intersection — free `:free` routes that also have a ZDR
endpoint — was not computed.** Reasons:

- The ZDR list is large and `read_url` truncates it, and the tool rules forbid
  reaching for `curl` just to page through a web response.
- The free-model set lives in the full models payload, which is larger still.
- It is the wrong number to hard-code anyway: both lists change weekly, and the
  spec already says the *set* is the asset, not any member.

So this document does not claim a count. It claims a **mechanism**, and gives the
one command that produces the count when someone wants it.

### 3.1 Reproducing the count

```sh
# free model ids (no auth needed)
curl -s https://openrouter.ai/api/v1/models \
  | jq -r '.data[].id' | grep ':free$' | sort -u > /tmp/free.txt

# models that have at least one ZDR endpoint
curl -s https://openrouter.ai/api/v1/endpoints/zdr \
  | jq -r '.data[].model_id' | sort -u > /tmp/zdr.txt

comm -12 /tmp/free.txt /tmp/zdr.txt | wc -l
```

## 4. What this changes in the design

Three decisions, all fail-closed:

1. **Enforce at the gateway, not by guessing.** For an endpoint that supports it
   (OpenRouter today), KiCode sends `provider: { zdr: true }` on every request
   whose route is marked `retention: "zero"`. The gateway then refuses to route
   to a retaining endpoint. KiCode never has to know which provider would have
   served the request.
2. **Use the published list as the advance check.** Fetch
   `…/api/v1/endpoints/zdr` (cached like the `/key` probe) to mark configured
   routes in `/models` *before* a request is spent on a failure. This is a
   public read of metadata, candidate-driven and cached — it is not telemetry
   and it carries no user content.
3. **A ZDR refusal is a route failure, never a privacy downgrade.** If asking
   for ZDR leaves no provider for a route, the request fails and the chain moves
   on. There is no code path that retries the same request without `zdr`. That
   is the single most important line in this document.

### 4.1 The cost to the mission

Some free routes will be lost: a `:free` model whose only serving provider is not
ZDR simply becomes unavailable under the rule. The design accepts that, with one
escape hatch that can never engage by itself:

- `retention: "may-train"` may be declared **explicitly** per provider in
  `kicode.json`, and `--allow-training-routes` / a prompt may enable it for a
  run. KiCode never selects it automatically, and `/status` always shows when
  the active route is one of them.

The consequence lands on the user's own decision, visible on screen — which is
what "you own the conversation" has to mean in practice.

## 5. Residual risk

- **The ZDR list can drift from reality.** It is provider-declared, and
  OpenRouter's own docs say a provider's general policy can differ from a given
  endpoint's. Mitigation: it is the gateway's declaration that KiCode relies on,
  and the gateway is the one enforcing it per request — a stale local cache can
  only mislabel a picker row, never misroute a request.
- **A future gateway may support `zdr` under a different parameter.** Mitigation:
  enforcement is one function per provider kind; an endpoint that cannot be
  asked is treated as retaining and is not used automatically.
