# Changelog

All notable changes to KiCode are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.0] — 2026-10-02

The first release. Not published to a registry: `package.json` is still
`"private": true`, so the distribution decision (npm vs. git) is open.

### Added

- **A bring-your-own-key terminal coding agent.** Point it at any
  OpenAI-compatible endpoint and give it a key in the environment; the key is
  never written to a config file. No account, no server, no telemetry.
- **A streaming agent loop** with six tools — read, write/edit, bash, todo,
  goal — plus `ask` for genuine user decisions, and `remember`/`recall` for the
  brain. Turns continue while tracked work remains, bounded and announced.
- **A full-screen TUI**: transcript with markdown and syntax colour, a wrapping
  input box, a message queue you can see and drop per message, a command
  palette, list cards for sessions/models/skills, themes, and `/settings`.
- **Sessions** per directory, grouped by date in `/sessions`.
- **Compaction** that aims a compacted session at a target fraction of the
  window (default 40%, clamped to 30–50), chosen by size rather than by a count
  of turns, with the system prompt counted against the budget.
- **The brain** — a skills and project-memory store, read back every session:
  a bounded prompt briefing (this project's memory plus skill names and
  descriptions), a `recall` tool to load a body on demand, a save-when /
  never-save policy, and `action: "update"` to correct a skill deliberately.
  A fresh user gets a brain created on the first save (`~/.kicode/brain`, or
  `KI_BRAIN_PATH` / a `brain` path in `kicode.json`, or an existing
  `ki-agent-brain` at or above the working directory).
- **A plan panel** — a `[TODO n/m]` chip on the state row that opens a card with
  the checklist, a progress bar, and a running goal's status and subtasks.
- **MCP support**, including an HTTP transport, so anything that speaks the
  protocol can contribute tools.
- **Clipboard image preview** with a persistent last-5 history.

### Changed

- **Compaction now lands at its target** instead of at target-plus-the-system-
  prompt, which is what it claimed before.
- **The turn budget is 40** (was 12), and reaching it says so rather than the
  transcript simply ending.
- **The plan tools hold the turn open**: a reply with an unfinished `todo` or
  `goal` is nudged to carry on, at most three times, and any tool call hands the
  allowance back. Plan mode is exempt — an open list there is the plan itself.

### Fixed

- **A turn no longer ends merely because a reply carried no tool call.** A reply
  the endpoint's output cap cut off (`finish_reason: "length"`) is kept and
  built on, and an empty reply is re-asked, both bounded.
- **The skill reader walks the tree**, so categorised skills in a maintained
  brain (`skills/<category>/<name>/SKILL.md`) are found, not just the flat ones
  `remember` writes.
- **Quoted frontmatter is unquoted** in the briefing and the `@skill:` list.
- **A bare 403 from OpenCode** is reported as the server-side client restriction
  it is (a rejected key is a 401), rather than a generic failure.
- Mouse hit-detection for `[x]` / `[×]` close chips on modal pickers, and a
  caret-column off-by-one in the input box.

### Security

- **`remember` refuses anything shaped like a secret** (private keys, API-key
  patterns) and writes only inside the resolved brain, with slug names that
  cannot escape it.
- **The tracked `.env.example` was found to contain three real provider keys.**
  The values were blanked and a warning added. **Those keys remain in the git
  history of this repository and must be rotated and scrubbed.**
