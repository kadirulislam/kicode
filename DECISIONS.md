# KiCode Architecture Decision Records (ADRs)

## ADR-001: Modern AI Chat Interface & Interactive Elements
- **Context**: The TUI needed to provide a modern, engaging AI coding interface while maintaining exact terminal row layout geometry.
- **Decision**: Added "Where should we begin?" greeting to home screen, created a rounded input prompt layout with `+` attachment launcher, `[Image i]` chips, `🧠 Think` reasoning pill, and `↑` send button.

## ADR-004: Emoji-Free Bar-Style Chat Area
- **Context**: The prompt box used emoji (`🧠`, `⚡`, `📋`, `◆`) and a framed `╭╮╰╯` border that competed with the transcript's own rules; sender `You`/`Ki` header rows cost a row on every turn.
- **Decision**: The box is now a single accent `▌` bar (no top/bottom border, bar-only padding rows), plain `[Think]` pill and `↑` send button, `▌ Build · model · variant` status row with single separators, `┌┐└┘` picker corners, `│` tool rule, and no sender headers — answers are plain prose, requests are filled blocks.
- **Outcome**: All 823 tests pass; the layout matches the VS Code-style reference (separator, accent bar, `Ask anything...`, status row, path + `ctrl+p commands` footer).

## ADR-005: Airy Tabs with +NEW and Home on Every Fresh Session
- **Context**: The tab close box sat tight against the title (easy to miss, hard to click) and the `+ New session` button ate a wide row; worse, `/new` pushed a `new session` transcript entry, so a fresh session opened on a one-line transcript instead of the home screen.
- **Decision**: Each tab is now ` title  ×  ` (two cells of air around `×`, which is also the click target), the trailing button is a compact accent `+NEW`, and `newSession()` reports via the state-row notice instead of a transcript note — so `entries` stays empty and every new session opens on `Where should we begin?`.
- **Outcome**: All 823 tests pass (tab geometry tests re-pinned; `/new` test now also asserts the home greeting).

## ADR-006: Palette Lists Only Runnable Commands
- **Context**: The `/` palette showed the whole OpenCode catalogue — aliases (`/q`, `/open`, `/project(s)`, `/resume`, `/effort`, `/thinking`) as separate rows and names KiCode cannot run (`/agents`, `/pair`, `/plugins`, …) as dimmed rows — tripling the visual noise of choosing a command.
- **Decision**: `filterCommands` returns only available, non-alias commands. The full `COMMANDS` catalogue stays as the single source of truth for the dispatcher, so typed aliases still run and typed dead names still explain why they cannot — they just no longer occupy rows in the list. `/help` already filtered the same way.
- **Outcome**: All 823 tests pass (palette tests re-pinned to open on `/btw`; new test pins that aliases and dead names are absent from the list but present in the catalogue).

## ADR-007: Plan + Todo Session Tools
- **Context**: Plan mode only subtracted — it refused `write`/`edit`/`bash` but offered no deliverable, so a plan was prose the user had to hunt for and multi-step work had no memory across turns.
- **Decision**: New `plan` tool (goal + numbered steps with optional detail/files, presented once for review; calling again replaces it) and `todo` tool (`add`/`done`/`list`/`clear` over a numbered session list), sharing per-agent closure state so sessions never leak into each other. Both registered always and never approval-gated (in-memory only); `PLAN_MODE_PROMPT` now names them as the plan-mode deliverable.
- **Outcome**: All 834 tests pass (11 new in `plan.test.ts`).
- **Outcome**: All 117 layout and rendering tests pass with pixel-perfect caret and row coordinates.

## ADR-002: Mouse Text Selection & Clipboard Protocol
- **Context**: Automatic copy and paste on text selection caused accidental clipboard pollution and unintended input insertion.
- **Decision**: Decoupled mouse selection from clipboard mutation. Mouse drag highlights transcript text without mutating clipboard or prompt buffer. `Ctrl+C` explicitly copies the selected range. Right-click opens a context menu with separate options for text paste, image paste, and transcript copying.
- **Outcome**: Clean, intentional text copy/paste UX matching desktop standards.

## ADR-008: Compact at 100K, Remember While Working, Hermes Optional
- **Context**: Sessions on free-tier windows die past ~100K tokens while the configured 128K window says there is room; learnings evaporated at session end, which was the whole case for bolting on the Hermes agent runtime; and every new save prompt would train the user to stop saving.
- **Decision**: (1) `compaction.compactAt` (default 100,000, `KICODE_COMPACT_AT`, persisted by `--init` when changed) caps the auto-compact budget below the window — `shouldCompact` uses `min(window − reserve, compactAt)`, so a wider window never delays the cut. (2) A `remember` tool (`skill` → `skills/<slug>/SKILL.md`, never overwriting; `memory` → dated append to `memories/projects/<slug>.md`) is always registered and deliberately not approval-gated; safety is positional (brain directory only, slug names, 12K/4K caps, secret shapes refused, plan mode refuses). The model is prompted to save verified, reusable learnings and announce each save in one sentence. (3) With the local brain learning on its own, the Hermes agent runtime is parked as an optional future (M13/M14 stay on the roadmap, unbuilt) — not a requirement.
- **Outcome**: All 868 tests pass (15 new: 3 compactAt budget cases, config env/file defaults, `--init` persistence, 10 remember cases covering no-overwrite, slug jailing, secret refusal, truncation).

## ADR-009: Permission Prompt Floats Centered
- **Context**: The approval modal sat where the prompt box had been — bottom of the screen, full width — while the eye is in the middle of the transcript it is being asked about.
- **Decision**: `renderFrame` overlays the modal as a 72-wide card centered over the transcript (`paint` with a panel background on the page background), keeping the tab bar and footer visible. The prompt box and caret stay hidden while the modal owns the keyboard; the state row keeps its warn edge, and the card carries no click targets — a click still cannot answer it.
- **Outcome**: All 870 tests pass (2 new pinning the centered row and the visible tab bar/footer; 4 existing modal tests re-pinned to the prompt staying hidden).

## ADR-010: Sessions Picker Shows When + How Long, Searches the Preview
- **Context**: `/sessions` rows carried only title + id — fifty sessions of `new session` are indistinguishable, and searching matched the 28-char title at best. The store already knew more (date, length, model, opening request).
- **Decision**: `SessionSummary` gains optional `updatedAt`/`messageCount`/`model`/`preview` (run.ts maps them from the record; `sessionPreview` flattens and caps the opening request at 100 chars). Rows show `today · 4 msgs` as trailing metadata; preview + model travel as non-displayed `keywords` that `filterPickItems` matches, so typing a word from the opening request finds the session without snippets drowning the titles.
- **Outcome**: All 874 tests pass (4 new: preview flatten/cap/empty, keyword matching, picker trailing + preview search + switch).

## ADR-011: Centered Modal Pickers, In-Input Docked Clipboard Menu & Turn Queuing/Pause
- **Context**: Modal dialogs and pickers were left-top aligned, context menus replaced the transcript body rather than anchoring to the input area, clipboard content lacked visual inspection (making pasted images or multi-line text opaque to the user), and users could not push questions in between conversation turns or request an immediate pause.
- **Decision**:
  1. Centered all modal picker dialogs (`renderPicker`) vertically (`topPad = Math.max(Math.floor((height - out.length) / 2), 0)`) and offset all hit targets so mouse clicking aligns exactly.
  2. Anchored the right-click context menu directly into the chat input area docked above the prompt (`renderBottom`), preventing transcript obliteration.
  3. Added clipboard real content previews in `clipboard.ts`: 16x4 24-bit ANSI RGB colored block grid (`█`) by decompressing PNG IDAT scanlines via `node:zlib` for images, and line-numbered text preview for string clipboards.
  4. Added turn queueing and pausing (`/queue <msg>`, `/insert <msg>`, `queue: <msg>`, and `"pause"` / `"/pause"`). If the model or turn is busy and user types "pause", it cancels the active turn and marks `isPaused = true` (`▌ paused`). The agent system prompt is instructed to pause immediately on pause requests. Queued messages are automatically dispatched in order upon completion or unpausing.
- **Outcome**: All 874 tests pass across 46 test suites; clean production build.

## ADR-012: Reading-Level Transcript Discipline (Selection Fill, Thinking Ticker, One-Line Results, Folded Notes, Ask Summaries)
- **Context**: Four reading problems compounded each other. (1) The selection highlight used inverse video (`ESC[7m`), which several terminals render invisibly. (2) A live reasoning stream printed every delta, turning the transcript into a scrolling wall while the model thought. (3) At medium verbosity a tool result still printed up to 12 lines mid-turn, when nobody is reading output — they are reading what the tool touched. (4) Repeated identical failure notes (a free gateway 429ing every retry) stacked identical blocks down the transcript, and `ask` tool calls dumped their whole question objects — headers, option lists, descriptions — as raw JSON, which both flooded the transcript and made the centered permission modal (ADR-009) appear to collide with text.
- **Decision**:
  1. `theme` gains `Styles.selection` (accent background, background foreground) and `ansi.markCells` takes the highlight style as a parameter, replacing span styles inside the range instead of prefixing inverse video. The modal box is selectable like every other row.
  2. While reasoning is open and verbosity is low/medium, the transcript renders one ticker line: `▌ thinking <newest sentence>` (accent + faint), where the newest sentence fragment is capped at 96 chars. High verbosity keeps the full stream; closed thoughts still show `Thought: Xs`.
  3. `resultLines` at medium verbosity summarizes a non-error result to its first line plus `· N lines`; low and high keep their previous behavior.
  4. `summarizeArgs` takes the tool name: `ask` renders as `3 questions: "<first question>"`; every argument value is capped at 96 chars, so one long `content` cannot flood the line. Applies to the transcript, copied/exported text, and `/diff` change labels.
  5. Identical notes fold into one row that admits the count (`[Provider rate-limited the request (HTTP 429) ×3]`). Turn-failure notes fold past the user's retry message; strictly consecutive notes fold regardless. The count rides on the note entry, so exports show it too.
- **Outcome**: 910 tests pass across 47 files (selection, ticker, fragment, result, ask-summary, value-cap, note-fold, and a live mouse-drag case added); typecheck and ESM build clean. The permission modal now floats over a readable transcript rather than a JSON wall. Found while verifying live: the drag highlight was fully implemented and tested at the frame level but `TuiApp.state()` never handed `this.selection` to the renderer, so it never appeared on screen — the new regression test drives a real SGR mouse drag through the input loop and asserts the raw frame bytes carry the accent fill and no inverse video.

## ADR-013: Rate-Limit Recovery — Backoff Before Switching, Auto Free→Free Chain, All-Capped Summary
- **Context**: TokenHarbor's free routes 429 frequently ("free-model rate limit reached; slow down and retry"). With no fallbacks configured the turn died on the first 429; even with a chain, hops fired back-to-back into the same busy gateway, and a single-route session had nowhere to go at all. The owner asked for "something done about the rate limiting".
- **Decision**:
  1. A 429 pauses before the next route. The gateway's own `Retry-After` (via the quota reading) is honoured up to a 60 s ceiling; without one, 1.5 s growing one step per hop already tried. The pause emits a `route-wait` stream event so the busy row reads `rate-limited on <route> — waiting Ns…` instead of the UI looking hung, and it is sliced (250 ms poll) so Ctrl+C lands within a quarter second. The transcript deliberately keeps no entry — a wait is seconds, not history.
  2. When the session's model is free and no explicit fallbacks are declared, the chain is extended the first time it runs dry: the endpoint's own `/models` list is fetched once, other free models become hops (capped at 4, same endpoint and key, de-duplicated against the chain). Never a paid model — a paid fallback silently changes the quality of every answer after it. Discovery failure contributes nothing; the real error is what the user sees. Kill switch: `"fallbackAuto": false` in `kicode.json` or `KICODE_FALLBACK_AUTO=off`.
  3. A chain that ended only in rate limits throws a different error from one that failed otherwise: "Every route is rate-limited — … wait a bit and send again, or /models to pick another route."
- **Outcome**: 937 tests pass across 48 suites (backoff/cap/no-pause-for-502, discovery append/dedup/failure, capped summary; plan-mode classifier also permits the stderr-quieting idioms `2>/dev/null`, `2>&1`, `1>/dev/null` that models use constantly while exploring — a redirect to a real path is still refused). Typecheck and ESM build clean.

## ADR-014: `/attach` — Files from the Prompt, Two Ways Across
- **Context**: The prompt accepted pasted screenshots and `@file` mentions, but nothing in between: a user mid-sentence who wanted to show the model a screenshot on disk or a spec document had no way to hand it over, and free models silently drop image parts entirely.
- **Decision**:
  1. `/attach <path>` reads at attach time, not send time — a bad path is a message while the user can still retype it. Relative paths resolve against the session's cwd; quoted paths are unquoted.
  2. Images (`png/jpg/webp/gif`, ≤8 MB) join `attached` and ride the existing pasted-screenshot base64 path, badges and all — visible to vision-capable models, dropped by the rest.
  3. Everything else (≤512 KB, decoded as text, binary refused, content capped at 24 000 characters with the truncation named in the block) becomes a named `Context from attached file "…"` block appended to the turn's words — the same shape an `@file` mention produces, so every model including the free ones reads it without any provider content-part changes.
  4. The typing area shows `[name]` badges beside the image chips; backspace on an empty prompt detaches the newest attachment of either kind; the right-click menu clears images or documents separately. Queueing (`/queue`, `/insert`) carries attached documents like images.
- **Outcome**: 937 tests pass (attach resolution, mime mapping, caps, binary/missing/directory refusals, doc blocks, badge rendering, two live end-to-end attach flows through the input loop); typecheck and ESM build clean. The command palette gained `/attach`, shifting palette order — the two tests that pinned row positions were re-pinned.
