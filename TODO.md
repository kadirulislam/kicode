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
- [x] Modern prompt bar with `+` attachment button, `🧠 Think` pill, and `↑` send button. *(superseded — the `[Think]` pill went in ADR-016 and the `↑` arrow in ADR-018; the prompt row now carries `[+]` alone.)*
- [x] TokenHarbor / TokenHarbour & OpenCode built-in services and key resolution.
- [x] Global settings API key & custom provider persistence (`~/.kicode.json`).
- [x] Interactive modal dialogs for `Manually enter API Key` and `Add API Provider`.
- [x] Emoji-free bar-style chat area (ADR-004): `▌` accent bar, single `·` separators, no sender headers, and now a filled typing surface (ADR-018). The `[Think]` pill and `↑` send button have since been dropped.
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
- [x] Send arrow removed from the input bar, and the box made unmistakably the typing area (ADR-018): the box now wears `theme.block` — the surface a user's own turn wears — instead of the `panel` it shared with the tab bar, the `kicode` page background deepened `#0c0d14` → `#08090f` behind it, and a blank row of the box's own fill sits between the editor and the state row (in place of the padding row that used to trail under it, so the box is the same height). The `[+]` attach button anchors to the right edge and its hit box was re-derived to match.
- [x] Permission and recovery cards come to the input box (ADR-019): both now sit at the foot of the page, their last row the last row of the conversation, exactly where a picker lands.
- [x] Everything a card offers is a mouse target (ADR-019): the answers are chips (`[y] yes · [a] always · [n] no`, `[r] retry · [m] choose model · [×] dismiss`), a click names the key and the same handler a keypress reaches answers it, and `esc` is drawn as a clickable `[×]` on every surface that offers it — footer hints, picker and menu titles, menu footers, the clipboard menu, and a card's own decision row.
- [x] Two bugs found while writing the rows down (ADR-019): a multi-line gateway message on the recovery card printed as one run-on row (the body's spans were missing the `\n` prefix the permission body always had), and the `[+]` attach hit box sat one column left of its glyph because the hit test compares 1-based columns.
- [x] Live todo progress (ADR-018): the `todo` tool's checklist is no longer logged once per call — the previous card is lifted out and the newest state put at the end of the transcript, so the agent's list ticks over in one place, where the work is. The system prompt now asks for a list on any multi-step task.
- [x] The prompt wraps, and the box grows with it (ADR-020): a line past the terminal's width breaks at the last space that fits (mid-word when there is none) instead of ending in a `…`, the box grows to six rows and then follows the caret, and the rows under the first keep the first row's column so a wrapped prompt stays one block of text. The `[+]` control rides only the row being typed on.
- [x] Clicks that place the caret work on a wrapped prompt (ADR-020): the renderer reports the box's own rows — bar rows, the column the text starts in, and the code-unit range each text row carries — so a click on the third row puts the caret there rather than at the start of the prompt. That replaced `app.ts`'s `attached.length * 10` guess at the badge width, which was wrong for document badges.
- [x] Caret column off-by-one fixed (ADR-020): `margin + 2 + caretCol` put the cursor one cell left of the text, which starts at `margin + 3` — visible in the empty box, where the caret sat on the space before the placeholder. The chrome boundary a drag may not cross is now the box's top row rather than `caretRow - 2`, which moved once the prompt could wrap.
- [x] **Caret row off-by-one fixed (found by the attach-button tests)**: the caret row omitted the tab bar's row, so with the sidebar visible the terminal caret and every prompt-row click/drag sat one row too high. A drag starting on the chrome under the rule could also copy `Ask anything...` as conversation text; the selection-start guard now refuses the rule and below (ADR-016).

## Pending (agreed, not yet built)
- [ ] Usage-tracking API: local-only `~/.kicode/usage.jsonl` (counts only — model, endpoint host, tokens, tool calls, duration), surfaced in `/stats` + new `/usage`, exported via `kicode --usage [--json]` with daily/per-model rollups.
- [ ] Hermes + brain integration (both layers): `KI_BRAIN_PATH` > `kicode.json` brain path > autodetect; generic configurable skills repo (ki-agent-brain default for now, limited starter allowlist); `/connect hermes` guided setup; skills index (names + descriptions) with on-demand body reads. Local side is built (`remember` auto-save, `/skills`, `@skill:`); Hermes runtime parked as optional future per owner decision (ADR-008) — not needed while the local brain learns.
- [ ] **Owner's issues list (received 2026-10-01, not yet started)** — ten items, in the owner's order:
  1. **Bash error in plan mode** — a bash command that should pass the read-only classifier is still refused (or vice versa); reproduce and fix.
  2. **Bash permission should be a modal** — the approval prompt for a bash command should appear as the permission modal, not inline. *(The `approve` channel already routes to the card; it now sits above the input box instead of centred, and is answered by chip or key — ADR-019. Re-check on a real bash prompt.)*
  3. ~~**All modals/pickers dim the background**~~ — **done (ADR-017)**: `/models` and `/settings` (and the permission modal) now float as a card *over* the conversation, which stays on screen but faded; the card sits at the foot of the page, just above the input area, and it owns the clicks while it is up. The question panel (`ask`) still replaces the page by design.
  4. **Sessions grouped by date** — `/sessions` should group rows under `Today`, `29-09-2026`, … instead of one flat list.
  5. ~~**Text wrapping everywhere**~~ — **done for the reading surfaces (ADR-020)**: the transcript has wrapped since ADR-011, the input box now wraps and grows (up to six rows, then it follows the caret) instead of cutting the line with a `…`, and a card's body wraps with a `… N more lines` marker when it runs out of room. Panels (`/models`, `/settings`, the palette) still truncate one row per item, and that is deliberate: a wrapped row would move the rows a click lands on out from under the target measured when it was drawn.
  6. **Compact to 30–50% while keeping task context** — compaction currently cuts too little/too much; target 30–50% of the window with all task-relevant context preserved.
  7. ~~**Live todo progress while the agent works**~~ — **done (ADR-018)**: the `todo` tool's checklist is rewritten in place at the end of the transcript as the agent advances, and the system prompt asks for a list on multi-step work. A busy-row count is still open if the card scrolls out of view.
  8. **Agent sometimes stops mid-task** — a turn ends before the work is done; find the stop and make it continue reliably.
  9. **Rate-limit → model modal, but keep working** — on a rate-limit error show the model chooser (as the recovery modal already does) *and* continue the work automatically rather than waiting on the user.
  10. ~~**Deeper chat-area background**~~ — **done (ADR-018)**: the `kicode` transcript background went `#0c0d14` → `#08090f`, and the input box moved onto the user-turn surface so the typing area reads as a raised card against it.
- [ ] Owner's minor-issues list (awaited — superseded by the ten items above).

## Future / Next Milestones
- [ ] Add streaming speed & token-per-second live metrics toggle in `/settings`.
- [ ] Support local model downloads (Ollama / Llama.cpp auto-detection).
- [ ] Expand MCP integrations catalogue with one-click connectors.
