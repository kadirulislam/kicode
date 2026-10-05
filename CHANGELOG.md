# Changelog

All notable changes to KiCode are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Independent tool calls in one turn now overlap.** A model exploring a codebase
  emits a dozen reads at once, and they ran strictly one after another — measured
  at **853ms for an 18-call turn where 44ms of tool work was all that was needed**.
  Reads (`read`, `glob`, `grep`, `recall`) now run concurrently; measured 18×40ms
  reads: **853ms → 44ms**, with the transcript in call order in both.

  Two rules keep it honest. **Approvals still happen one at a time and before
  anything runs**, because an approval is a conversation with the user. And a tool
  that could change something still finishes before the next one begins — only
  tools marked `concurrencySafe` overlap, so two writes can never interleave. The
  marker is on the tool, defaults to off, and is deliberately *not* inferred from
  `requiresApproval`: an MCP tool on an auto-approved server has no gate and can
  still write.

### Fixed

- A test flake in the `@` mention suite, unrelated to the above: the submit was
  waited on with a fixed 80ms, which a loaded machine missed about one run in
  five — so the test asserted on a prompt that had not been submitted yet. Now
  polled for the condition, like the polling already used three lines above it.

- **`[AGENTS 0/1]` on a finished task.** The chip counted *running*, so it went
  back to zero the moment the work landed — which reads as though the work had
  been undone. It now counts **done/total**: `[1/1]` when a task is settled,
  `[1/2]` when another is owed. A failed, stalled or interrupted child does not
  count as done, because that is work that still has to happen.
- **A repaint after a child settles.** Nothing asked the screen to redraw once a
  child was recorded as finished, so the `[AGENTS n/m]` chip sat on its last
  *running* frame until something unrelated happened to draw.
- **A child that reported nothing.** The transcript read `[(it reported nothing)]`
  and the parent had no result and no idea why. Silence is indistinguishable from
  a child that died mid-turn. A child that ran and produced no prose now says so,
  and names the likely reason — no child can run a command. A child that *failed*
  reports why in the summary too, rather than leaving an empty string beside the
  error.

### Added

- **A folder per subagent, for its skills.** `~/.kicode/agents/<name>/SKILL.md` is
  the agent's standing brief; every other `.md` in the folder is a skill it can be
  asked for, frontmatter optional. The skills go into the system-prompt roster by
  name and description — which is what the routing decision is actually made
  against, since "GitHub work" gives a model one sentence to judge with — and the
  child is handed the paths and told to read the one covering its task. Only the
  paths, never the bodies. Same two scopes as `agents.json`, project overriding.
- **The roster states each agent's limits, not just its subject.** Every entry now
  reads `can: read files, search them, and edit files. cannot: run commands.`
  Observed failure: `cody-git` was handed "audit this GitHub account", which needs
  `gh`. No child has a shell, so it had nothing to work with. A limit the parent
  cannot see is a trap, not a policy — and the prompt now says what to do instead:
  run the command yourself and re-delegate with the output.
- **The `[AGENTS n/m]` chip** on the state row, beside `[TODO]` and `[USAGE]`:
  running against total, so a batch in flight is legible at a glance. Clicking it
  opens the same roster `/agents running` does.
- **The roster leads with the agent's name**, not the goal — `cody-git: review PR 12`
  — because "which agent is working on what" is the question the panel exists to
  answer, and a goal with the agent hidden at the end of a line of timings cannot.
- **A stopped batch is resumable.** Children a cancelled turn left unfinished are
  named to the next turn — by agent and goal — once, so it finishes the gap instead
  of re-planning from the reports that did arrive and doing the work twice. A child
  that failed on its own is left alone: it was already reported.
- **The permission ladder**, as a chip below the chat you can click: `[ASK]`
  (default, every run), `[EDITS]` (write and edit without asking, still ask before
  running a command), `[ALL]` (no diff, no prompt, no undo — drawn in the error
  colour). One click steps a rung; `/permission ask|edits|all` sets one outright.
  The middle rung is the point: an edit shows a diff, a command does not, and one
  on/off switch cannot express a session that trusts one and not the other.
- The named subagents are now listed in the **system prompt**, with when to use
  each one. They were only in the `delegate` tool's description, so a session
  told a GitHub question did the work itself and then went looking for
  `cody-git` on disk to check that it existed.
- `MOCK_LOG=2` on the mock provider prints the system prompt of every request —
  the only way to see from outside whether something the model is supposed to
  know actually reached it.

- **`Subagents` in the settings panel's `Shortcuts` group**, opening the same
  screen `/agents` does.
- `enter` now ends a field and steps to the next one, already open for typing, so
  filling the subagent form is type, Enter, type. `‹›` or space change a toggle;
  shift+enter is a line break inside `How it works`.

- **Named subagents.** `/agents` lists them and opens a form to add one: a name,
  a line describing it, the specialisation put in front of its prompt, its own
  model if you want one, and whether it may edit files. `delegate` gains an
  `agent` field, and the names go into the tool description so the model picks
  one by name when a task fits. Defined in `~/.kicode/agents.json` for every
  project or `<cwd>/.kicode/agents.json` for this one, the project's overriding
  by name. `/agents running` is still the live roster.
- **`bash` is not grantable**, at any permission level. Read and edit are the
  file-shaped ones; a shell is arbitrary code and a child has no approval
  channel to ask about it. Edit is per-agent, opt-in, and off by default.

### Changed

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

- The subagent form's card was sized from each field's raw value while a toggle
  draws both of its options, so `Where` overflowed the card's right edge and the
  highlight ran off into the page.
- A field being typed into showed two carets — one drawn for the width
  measurement and one by the row.
- The subagent editor ignored typing. The row was drawn from the saved value
  while the keys went into the editor, so the text was there and the screen was
  not — which reads as a dead keyboard. It now shows what you are typing, with
  the caret where the cursor is, and the prompt box no longer draws the same
  text a second time underneath it.

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
