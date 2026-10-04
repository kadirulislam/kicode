# Changelog

All notable changes to KiCode are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Subagent delegation.** A `delegate` tool hands a task — or a batch of
  independent tasks, run in parallel — to a child agent: a fresh context, a
  read-only toolset (`read`, `glob`, `grep`, `recall`), and its own model. Only
  a bounded report comes back. Configure with a `delegation` block in
  `kicode.json`; `model` empty means children use the parent's, and
  `KICODE_DELEGATION=off` (or `"enabled": false`) removes the tool entirely.
- A dock above the prompt shows every child in flight — goal, model, tools
  spent, elapsed — capped at two rows with a count of the rest; `/agents` opens
  the full roster and prints any child's report in full.
- The transcript records one row per delegation: it opens as `delegating…`,
  counts `delegating N of M` while the batch runs, and settles to what
  reported and what did not.
- `MOCK_TOOL=delegate` and `MOCK_LOG=1` on the mock provider, for exercising
  the whole delegation path with no key or network.

### Changed

- `/help` names the command count and points at `/` instead of listing every
  command inline. The list was seven wrapped rows of a 24-row terminal's worth
  of space, it pushed the keymap off the top of a short screen, and the palette
  renders the same names with descriptions.

### Fixed

- A wedged child is cut loose on its own account after
  `delegation.staleMs` of silence (1 200s while inside a tool), instead of
  holding its parent's turn open until the session's own request budget.
- `delegation.maxPerTurn` is spent across the turn and starts again with the
  next one; it was never reset, so a long session would have had later turns
  refused for children the first turn spawned.

## [0.2.0] — 2026-10-04

### Added

- `/context`: the context window estimated and broken down the way it is
  spent — system prompt plus tools, skills, project memory, conversation —
  with a usage bar, share of budget, and what remains.
- The `[USAGE]` chip now opens one card with the context breakdown above the
  session's own numbers; `Alt+U` opens the same card from the keyboard.
- A `⚙` glyph at the footer's right end opens the settings panel by mouse.
- An empty bracketed paste reads the system clipboard, so `Ctrl+V` with a
  screenshot attaches it even where the terminal forwards no text; the help
  line names `Alt+V` and `/paste` for terminals that keep `Ctrl+V`.

### Fixed

- `UPLOAD[+]` spacing; the footer path shares the prompt and state rows'
  gutter; the home screen yields blank decoration before MCP/config lines on
  short screens.

## [0.1.1] — 2026-10-02

### Changed

- **The environment can no longer declare an endpoint.** `OPENAI_BASE_URL`,
  `OPENAI_API_BASE`, `KICODE_BASE_URL`, `OPENAI_API_KEY` and `KICODE_API_KEY` no
  longer configure a session on their own. A provider has to be *declared* — by
  `/connect`, or a `providers` block in `kicode.json` — and the environment only
  supplies the key, in the variable that provider names as its `apiKeyEnv`. On a
  machine whose shell already had `OPENAI_BASE_URL` set, a first run used to work
  for a reason its owner could not see (and on a gateway they never chose); it
  now says `No provider is configured yet.` and points at `/connect`.
- **One declared provider is used without being named**, which is exactly the
  shape `/connect` writes — so a service added from the UI is in use the moment
  it is added. Several declared and none named reports
  `No provider is selected — name the one to use with "provider" in kicode.json.`
- **There is no default endpoint.** `DEFAULT_BASE_URL` is gone rather than left
  in place as an unused constant that implied one. `--base-url` and `--api-key`
  still configure a single run, and `baseUrl` in `kicode.json` still pins an
  endpoint for a project.
- **The first-run message names a remedy, not just a variable.** With nothing
  declared there is no variable to set, so the hint offers `/connect`, the two
  one-off flags, and the `providers` block instead.

### Fixed

- **`--init` records any configured endpoint**, and records nothing where none
  is configured, instead of comparing against the removed default and writing an
  empty `baseUrl` into the file.

## [0.1.0] — 2026-10-02

The first release. Distributed from npm as a **proprietary** package
(`"license": "UNLICENSED"`, `"private"` removed), shipped as a minified bundle —
`dist/cli.js`, the README, this changelog and the licence. No source, no tests,
no history.

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
- **Background turns.** Switching tabs does not cancel a turn: the session you
  leave is parked and finishes there, its answer saved under its own id, its
  queue drained on its own, and its tab marked `◐`. An approval a background
  turn needs is denied with a note, and a question it asks is skipped.
- **Per-session settings.** The model, endpoint, working directory, mode and
  reasoning variant belong to the conversation, so `/models`, `/cd`, `Shift+Tab`
  and `/variants` in one tab do not change another. All five are written to the
  session file and restored on a switch — including by `--continue` on the next
  run.
- **Shift+Enter** inserts a line break, decoded from xterm's `modifyOtherKeys`,
  the kitty keyboard protocol and bare `ESC`+`Enter`, all requested on entry and
  released on exit.

### Changed

- **Compaction now lands at its target** instead of at target-plus-the-system-
  prompt, which is what it claimed before.
- **The turn budget is 100** (was 12), and reaching it says so rather than the
  transcript simply ending. It is settable: `maxTurns` in `kicode.json`, then
  `KICODE_MAX_TURNS`, then the default.
- **The default endpoint and model are a pair.** `gpt-4o-mini` against
  `https://api.openai.com/v1`, where the old default model did not exist on the
  old default endpoint.
- **The package is publishable and proprietary.** `"private": true` removed,
  `"license": "MIT"` → `"UNLICENSED"`, and the bundle minified (543 KB → ~300 KB).
- **`[a]lways` on an approval outlives a rebuild**, read-only `bash` calls no
  longer prompt in either mode, and `allow` rules in `kicode.json` skip the
  prompt for the commands you name.
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
- **The published `bin` entry survives npm's publish normalization.** A
  `./`-prefixed path is silently dropped on npm 11+ — the tarball is unaffected,
  but the *published* manifest would have carried no `bin` at all, so
  `npm install -g @kadirulislam/kicode` would have installed a package with no
  `kicode` command. The path is written without the prefix now.
- Mouse hit-detection for `[x]` / `[×]` close chips on modal pickers, and a
  caret-column off-by-one in the input box.
- **A missing key opens the UI instead of refusing to start**, so `/connect` and
  `/key` are reachable exactly when they are needed; `--tui-preview` needs no key
  at all. A piped or `-p` run with no key still exits 1 with the environment hint.
- **Switching sessions no longer throws away work.** A running turn keeps going
  (see Background turns above); `[f]ork` parks the session it forks from, and
  deleting the session on screen stops its turn rather than letting it run on.
- **The queue and the pause are per session.** A paused session does not drain
  its queue off screen, a goal is marked on the session running it and cleared
  when it ends, and the steering list is no longer shared between sessions.

### Security

- **`remember` refuses anything shaped like a secret** (private keys, API-key
  patterns) and writes only inside the resolved brain, with slug names that
  cannot escape it.
- **An API key in a config file is refused and named, at every scope.** KiCode
  never writes a key, and a key found in `kicode.json` — project, global or on a
  provider entry — is reported and ignored, with the variable to set instead.
  The value is never echoed.
- **The tracked `.env.example` was found to contain three real provider keys.**
  The values were blanked and a warning added. **Those keys remain in the git
  history of this repository and must be rotated and scrubbed.**
