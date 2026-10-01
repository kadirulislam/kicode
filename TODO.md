# KiCode Task & Roadmap Tracking

## Completed Tasks
- [x] Limit default tabs to max 3.
- [ ] Persist the active tab selection across sessions — **not built**: tabs restore via `--continue` / `latestSessionFor` only, so a restart returns to the newest session rather than the one that was in front. (Corrected 2026-10-01; the earlier entry here claimed this was done.)
- [x] Detachable and removable image chips directly inside chat prompt area.
- [x] Session deletion feature (`/delete-session` and interactive picker).
- [x] Clean TUI interface redesign with "Where should we begin?" and sleek input box.
- [x] "Go To Bottom" button and drag-interactive right scrollbar.
- [x] Model picker with Free models tab and provider name labels.
- [x] Tab close message fix and clean transition.
- [x] Mouse text selection without auto-copy/auto-paste side effects; `Ctrl+C` copy support.
- [x] Right-click clipboard & attachment context menu (Text / Image paste options).
- [x] Modern prompt bar with `+` attachment button, `🧠 Think` pill, and `↑` send button.
- [x] TokenHarbor / TokenHarbour & OpenCode built-in services and key resolution.
- [x] Global settings API key & custom provider persistence (`~/.kicode.json`).
- [x] Interactive modal dialogs for `Manually enter API Key` and `Add API Provider`.
- [x] Emoji-free bar-style chat area (ADR-004): `▌` accent bar, `[Think]` pill, `↑` send, single `·` separators, no sender headers.
- [x] Airy tabs with `+NEW` button; every fresh session opens on the home screen (ADR-005).
- [x] Palette lists only runnable commands — aliases/dead names work when typed, take no rows (ADR-006).
- [x] Plan + todo session tools with per-session isolation (ADR-007).
- [x] Fixed pre-existing typecheck error (`textWidth` import missing in `app.ts`).
- [x] `@` mentions inline popup (files/dirs + skills + project memories), Tab/Enter accept, submit expands into context.
- [x] Mouse wheel scrolls the `/` palette, pickers, menus and question options (one row per notch); transcript keeps ±3 lines.
- [x] `/skills` lists brain skills and inserts `@skill:name`; `/skills <name>` shows the card.
- [x] Auto-compact past 100K estimated tokens (`compaction.compactAt`, `KICODE_COMPACT_AT`, default 100000) — the 128K window still drives the footer (ADR-008).
- [x] `remember` tool builds skills/memories while working: auto-saves to the brain and announces afterwards; brain-only writes, slug names, capped bodies, secrets refused, plan mode refuses (ADR-008).
- [x] Permission modal floats centered over the transcript as a 72-wide card; prompt + caret hidden while it owns the keys, tab bar and footer stay visible (ADR-009).
- [x] Session search in `/sessions`: rows show when + how long (`today · 4 msgs` trailing), and typing matches title, id, model, and opening-request preview via non-displayed keywords (ADR-010).
- [x] OpenCode 401 diagnosis: an OpenCode-shaped AuthError on opencode.ai now says free models are client-restricted (paid Zen key works anywhere; OpenRouter free routes as alternative) instead of a bare 401 that reads as a wrong key. Verified live: `/zen/v1/models` is open, `/chat/completions` rejects non-OpenCode clients on free models.
- [x] OpenCode Go client validation support: providers now send `User-Agent: kicode/<version>` and a stable `x-opencode-session` header (the two requirements in Go's validated-clients docs) — session id flows from the TUI through AgentSettings to every request, including fallbacks. Not yet confirmed working against the live gateway.
- [x] `kicode --probe`: staged endpoint diagnosis (model list → tiny chat request) with gateway-specific verdicts — client restriction, bad key, rate limit, wrong model — from the gateway's own error. Two requests max, never retries; diagnosis, not workaround.
- [x] Vertically and horizontally center all modals and pickers (`renderPicker`, API key input, providers, etc.).
- [x] Right-click clipboard context menu docked in the chat input area above prompt with real pixel colored ANSI grid for images (`node:zlib` PNG decode) and line-numbered text preview.
- [x] Mid-conversation message queuing and insertion (`/queue`, `/insert`, `queue:`) with sequential dispatch and pause detection (`pause`, `/pause`, `▌ paused`).
- [x] Display model pricing in model lists/pickers and automatically move $0.00 pricing models to the Free tab.
- [x] Hierarchical tree breakdown for todos with status icons (`● Todos (done/total)`, `├── ✓`, `├── ◐`, `└── ○`).
- [x] Autonomous goal-driven execution via `/goal` and `/goal-direct` with goal tool and boxed Goal Card UI.
- [x] Unmistakable terminal text selection & copy feedback toast (`▌ ✓ copied · <lines/chars>` in vivid emerald).
- [x] Premium terminal UI architecture with distinct color spaces (Top tab bar, Transcript workspace, Tool execution blocks, Prompt input area, Mode line, and Footer HUD).
- [x] Interactive choice selection & approval modal UI redesign (breadcrumbs step indicator, left border accent, active item pointer `❯`, aligned descriptions, footer navigation hints, and non-destructive mouse selection).
- [x] Bottom-pinned choice selection panel directly above prompt input for seamless reading and typing.
- [x] Modal card styling for clipboard menu with slate panel background, border box alignment, and `❯` selection pointer.
- [x] Clean date-grouped session picker UI (`Today`, `Tue Sep 29 2026`) with session IDs hidden from descriptions.
- [x] Model and skill picker border alignment: strict column width bounds, truncated overflow, and clean `FREE` tag without `($0.00)` price strings.
- [x] Tab context menu docked directly under tabs at top-left instead of screen center.
- [x] Suppress terminal right-click auto-paste: right-clicking only reveals context menus and never injects clipboard text into prompt editor.
- [x] Clipboard options modal UI and box alignment: exact character-cell border math (`┌`, `┐`, `├`, `┤`, `└`, `┘`), truncated items, and zero background bleed.
- [x] Strict tab lifecycle & persistence: closed tabs stay closed and are never auto-reopened from disk; deleted sessions are completely expunged from disk and prevented from being re-saved.
- [x] Terminal-wide text selection & copying: select any text across all rows (tab bar, transcript, prompt, status, footer, modals) with auto-copy on drag release, Ctrl+C support, and visual feedback toast.
- [x] Selection highlight painted as the palette's accent fill instead of inverse video, which is invisible on some terminals (ADR-012). Root cause of it never showing live fixed: the app's `state()` never handed `this.selection` to the renderer, so the (fully tested) highlight code never ran — pinned by a live mouse-drag test asserting the raw frame bytes carry the accent fill.
- [x] Live reasoning collapsed to a one-line `▌ thinking <newest sentence>` ticker at low/medium verbosity; the full stream stays at high (ADR-012).
- [x] Tool results at medium verbosity summarize to one line (`first line · N lines`) instead of a mid-turn wall (ADR-012).
- [x] `ask` tool calls summarize as `3 questions: "<first question>"` rather than a raw JSON dump of every option object, and every other argument value is capped at one line (ADR-012).
- [x] Repeated identical notes (e.g. the same 429 every retry) fold into one transcript row with a `×N` count instead of stacking identical blocks (ADR-012).
- [x] `ask` validator forgives the argument shapes free models actually send: double-encoded JSON strings, a single question object or one-level-nested payload, question text under `title`/`prompt`/`text` or only in `header`, options as an object map or bare strings, option labels under `name`/`value`/`choice`. The refusal error now says what it received, so a genuinely malformed call self-corrects in one retry.
- [x] User request block is a filled rectangle: the padding rows above/below the message now run their fill to the text row's width instead of showing a two-cell bar sliver that read as a broken background.
- [x] `/goal` shows `Goal` in the mode row while a goal run executes (transient — not in the shift+tab mode cycle), and the turn's meta line reads `Goal · model · time`.
- [x] Request block fill hugs its text as a chip (widest text row + 2 cells of padding) instead of stretching to the transcript column, so a short message no longer reads as a background that stops mid-row.
- [x] Plan mode no longer refuses the stderr-quieting idioms models use constantly while exploring: `2>/dev/null`, `2>&1` and `1>/dev/null` are stripped before the redirect check, so `ls -la 2>/dev/null` runs in plan mode. A redirect to a real path is still refused.
- [x] Rate limits handled in three layers: (1) a 429 pauses before the next route — honouring the gateway's `Retry-After` up to a 60s ceiling, else 1.5s growing per hop — announced live in the busy row as `rate-limited on <route> — waiting Ns…`; (2) an active `:free` model implicitly falls back to the endpoint's other free models, discovered from its own `/models` list the first time the chain runs dry (capped at 4, never a paid model), **opt-in** via `"fallbackAuto": true` / `KICODE_FALLBACK_AUTO=on`; (3) when every route is rate-limited the turn stops with advice rather than a bare HTTP code (ADR-013).
- [x] Recovery modal on a failed turn (ADR-015): the gateway's message in a centered card with `r retry · m choose model · esc dismiss` — `r` re-runs the exact request, `m` opens the model picker and retries on whatever model lands, Esc keeps the error. Goal runs stay autonomous (note only); the queue holds behind the modal; auto-switching is now opt-in instead of default.
- [x] File upload by click (ADR-016): a `[+]` button on the right of the input bar opens the platform's own file-selection window — PowerShell's `OpenFileDialog` on Windows, `zenity`/`kdialog` on Linux, `osascript` on macOS — and the chosen file attaches automatically. Images (png/jpeg/webp/gif, ≤8 MB) join the pasted-screenshot base64 path; documents (≤512 KB text, capped at 24 000 chars) are read at attach time and appended as a named `Context from attached file "…"` block. Cancelling is silent, a missing picker falls back to typing a path in the prompt, and the old `/attach` command is gone. Badges, backspace-detach and the right-click clear items are unchanged from ADR-014.
- [x] `[Think]` variant pill removed from the prompt row at the owner's request — the row now carries only `[+]` and `↑`, and `/effort` changes the variant. Pinned by a frame test that the row no longer contains `[Think]`.
- [x] **Caret row off-by-one fixed (found by the attach-button tests)**: the caret row omitted the tab bar's row, so with the sidebar visible the terminal caret and every prompt-row click/drag sat one row too high. A drag starting on the chrome under the rule could also copy `Ask anything...` as conversation text; the selection-start guard now refuses the rule and below (ADR-016).

## Pending (agreed, not yet built)
- [ ] Usage-tracking API: local-only `~/.kicode/usage.jsonl` (counts only — model, endpoint host, tokens, tool calls, duration), surfaced in `/stats` + new `/usage`, exported via `kicode --usage [--json]` with daily/per-model rollups.
- [ ] Hermes + brain integration (both layers): `KI_BRAIN_PATH` > `kicode.json` brain path > autodetect; generic configurable skills repo (ki-agent-brain default for now, limited starter allowlist); `/connect hermes` guided setup; skills index (names + descriptions) with on-demand body reads. Local side is built (`remember` auto-save, `/skills`, `@skill:`); Hermes runtime parked as optional future per owner decision (ADR-008) — not needed while the local brain learns.
- [ ] **Owner's issues list (received 2026-10-01, not yet started)** — ten items, in the owner's order:
  1. **Bash error in plan mode** — a bash command that should pass the read-only classifier is still refused (or vice versa); reproduce and fix.
  2. **Bash permission should be a modal** — the approval prompt for a bash command should appear as the centered permission modal, not inline.
  3. **All modals/pickers dim the background** — `/models`, `/settings`, menus and dialogs should float over a greyed/faded transcript instead of the transcript staying fully bright.
  4. **Sessions grouped by date** — `/sessions` should group rows under `Today`, `29-09-2026`, … instead of one flat list.
  5. **Text wrapping everywhere** — long lines must wrap in the transcript, chat area, modals and small terminals rather than being clipped or hidden.
  6. **Compact to 30–50% while keeping task context** — compaction currently cuts too little/too much; target 30–50% of the window with all task-relevant context preserved.
  7. **Live todo progress while the agent works** — show the todo list's progress in the transcript/busy row as the agent advances through it.
  8. **Agent sometimes stops mid-task** — a turn ends before the work is done; find the stop and make it continue reliably.
  9. **Rate-limit → model modal, but keep working** — on a rate-limit error show the model chooser (as the recovery modal already does) *and* continue the work automatically rather than waiting on the user.
  10. **Deeper chat-area background** — the chat/transcript background should be a deeper colour than it is now.
- [ ] Owner's minor-issues list (awaited — superseded by the ten items above).

## Future / Next Milestones
- [ ] Add streaming speed & token-per-second live metrics toggle in `/settings`.
- [ ] Support local model downloads (Ollama / Llama.cpp auto-detection).
- [ ] Expand MCP integrations catalogue with one-click connectors.
