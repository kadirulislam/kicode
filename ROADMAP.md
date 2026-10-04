# KiCode roadmap — the open design decisions

This file records decisions that are **not** built yet, so they are settled by
argument rather than by whichever version gets written first. It is deliberately
short; the README is the manual, this is the reasoning.

## 1. Memory and skills

The goal is that a session starts from what the last one learned, without a
hosted service and without a second store of truth.

### What already exists

- **`AGENTS.md`** is read into the system prompt at startup and again on `/cd`,
  and `/init` writes a starter one. That is project-scoped, hand-edited, and
  already the right shape for "how this codebase is built".
- **Sessions** are JSON files under `~/.kicode/sessions`, per directory.
- **MCP** is already a mounted surface (`mcp.tools`), so anything that speaks
  the protocol can contribute tools.

### Decision

**Add a skills directory, and keep memory separate from it.**

- **Skills** — `.kicode/skills/<name>.md` (project) and
  `~/.kicode/skills/<name>.md` (global), each a short stand-alone instruction
  with a one-line description in front matter. The model is given the *names and
  descriptions* up front and reads a skill's body only when it decides to; a
  `skill` tool is the read. This is the OpenCode/Claude-style "progressive
  disclosure" model, and it is the one that scales: a hundred skills must not
  cost a hundred prompts.
- **Memory** — a single append-only `~/.kicode/memory.jsonl`, scoped by
  directory. Entries are written by an explicit tool (`remember`), never
  inferred, and are *read back only when asked for* via a `recall` tool. The
  session's own transcript is already the working memory; a memory layer that
  silently injects itself into every prompt is the version that goes wrong.
- **Both stay zero-dependency**: files on disk, no index, no embeddings. At the
  scale a CLI needs, `grep` is the retrieval engine, and it is already there.

### Why it waited

It multiplies the ways a prompt can grow, and the token budget in this release
exists precisely so that growth is visible. Skills were worth building once the
budget had been in use for a while; building both at once would have made it
impossible to tell which one blew the context.

### Where this landed (ADR-030, ADR-031, ADR-032)

- **Memory and skills are built** (ADR-030): a bounded brain briefing is folded
  into the system prompt, `recall` loads a body on demand, and `memory` is the
  append-only project file under the brain. Learned skills live at
  `~/.kicode/brain/skills/<category>/<name>/SKILL.md`, discovered recursively.
- **A fresh user gets a brain** (ADR-031): resolution is `KI_BRAIN_PATH` →
  `brain` in `kicode.json` → an existing `ki-agent-brain` walk →
  `~/.kicode/brain`, and the first save *creates* one instead of refusing.
- **A registry is distribution, not a runtime** (ADR-032): a curated official
  repo at `skills/<category>/<name>/SKILL.md`, a generated `skills.json`
  manifest, and installs through the existing `npx skills` CLI. The website is
  static and discover-only; KiCode never fetches skills mid-session, so
  **the intelligence ships in the binary and is on for everyone**, and the whole
  marketplace can be deleted without changing the CLI.

The remaining piece of this section is now the upstream half: a first-class
`kicode` entry in the `npx skills` CLI's agent table (Phase C of ADR-032,
built as ADR-042's follow-up) — Phase B, reading the `.agents/skills/`
convention, is done.

## 2. Hermes Agent

[Hermes Agent](https://github.com/nousresearch/hermes-agent) is Nous Research's
open-source, self-hosted agent: persistent memory, self-created skills, a
long-running loop, model-agnostic (Nous Portal, OpenRouter, OpenAI).

### Decision

**Bridge, do not depend. And only over MCP.**

- **No hard dependency.** KiCode's thesis is one bundled `dist/cli.js` with zero
  runtime dependencies, owning its own loop. A core that requires another
  agent framework contradicts that outright.
- **The bridge is MCP**, which both sides speak: KiCode can mount Hermes' tools
  as an MCP server, and Hermes can call KiCode's tools the same way. That keeps
  the seam at a protocol instead of at source, and it means an unreachable
  Hermes degrades to "those tools are not there", not to a broken CLI.
- **Steal the good ideas, not the process.** The two worth taking are above —
  persistent memory and a self-growing skills directory. A *background* agent
  that watches the project and volunteers work is interesting, but it is a
  product of its own; it does not belong in a foreground coding CLI.

## 3. Sub-agents

Already promised by the dimmed `/agents` row. The decision to make before
building it:

**A sub-agent is a tool, not a second UI.** The parent calls
`task(description, prompt)`; the child runs its own `Agent` with its own
transcript and its own token budget, and returns one summary string. It must:

- route to a **free or cheap model by default**, or delegating multiplies the
  spend the project exists to cut;
- inherit **plan mode and the approval gate** — a sub-agent must not be a way
  around the prompt the parent would have shown;
- carry a **token ceiling** (the budget machinery above), so a runaway child
  cannot eat the session.

## 4. Cost visibility

Tokens are counted today; money is not. Prices belong to the gateway and change
weekly, and the free routes have none at all. The honest version is: show a cost
**only** when the endpoint reports a price (some gateways return rate metadata),
and otherwise show tokens, plainly labelled as tokens. Inventing a price table
that goes stale is worse than showing none.

## 5. What is deliberately *not* on this list

- **A relay or a reseller.** Routing other people's keys, or pooling quotas and
  selling access, breaks provider terms and inverts the "you own the
  conversation" premise. KiCode is BYOK, per-user, and stays that way.
- **Runtime dependencies** for the CLI's own UX. The rule is **zero-dependency
  by default, with argued exceptions** (`spec` §3.8): a dependency must be shown
  to beat the alternative in writing, here, before it is added. The proposal log
  so far:

| Candidate | Verdict | Why |
| --- | --- | --- |
| `chalk` | **no** | Colour is already an owned ANSI layer (`src/tui/ansi.ts`); a dep for sugar weakens `npx kicode`. |
| `ansi-styles` / `supports-color` | **no** (pattern only) | `supports-color` solves terminal-colour detection, which KiCode must own anyway to honour `NO_COLOR` and its own theme system. Take the *pattern*, not the package. |
| `@opencode-ai/models` | **no** (pattern only) | The official [models.dev](https://models.dev) client, and it ships a ≤24 h **snapshot** entrypoint — the right *shape* for the model catalogue in `spec` §4.8 (build-time data, offline-capable). But it is a package in the tree for data: a `scripts/` fetch of `/api.json?type=…` emitting a trimmed, committed `src/generated/models.ts` gives the same freshness with no dependency at all. Take the idea; do not take the package. |
| `commander` | **no, for now** | `parseArgs` already exists in `src/cli/run.ts`; swapping ~80 lines for a dep is not a win. Revisit if subcommands arrive. |
| `cli` | **no** | Unmaintained, and it is a command framework for classic CLIs, not a full-screen TUI with a persistent render loop. |
| `@inquirer/prompts` | **no, for the TUI** | Beautiful for one-shot prompt flows; wrong shape for a persistent alt-screen TUI. The approval modal, pickers and `/budget` are already built and tested. Worth revisiting only for a *non-TUI* setup wizard, and even then the plain prompt already handles it. |
| `clack` | **no** | Same reason as `@inquirer/prompts`: a prompt library fights `renderFrame(state, size)`. |
| `oclif` | **no** | A framework (plugins, manifests, update notifier) — the opposite of one bundled file. |
| `cli/cli` | **n/a** | Not a library; a Go product to learn UX from. Cannot be consumed from Node. |

  The standing question for any future candidate is the same: does it beat what
  is already written, and does the gain survive the loss of single-file
  `npx kicode`? Borrow patterns; do not take weight without that argument.
