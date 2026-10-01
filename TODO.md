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

## Pending (agreed, not yet built)
- [ ] Usage-tracking API: local-only `~/.kicode/usage.jsonl` (counts only — model, endpoint host, tokens, tool calls, duration), surfaced in `/stats` + new `/usage`, exported via `kicode --usage [--json]` with daily/per-model rollups.
- [ ] Hermes + brain integration (both layers): `KI_BRAIN_PATH` > `kicode.json` brain path > autodetect; generic configurable skills repo (ki-agent-brain default for now, limited starter allowlist); `/connect hermes` guided setup; skills index (names + descriptions) with on-demand body reads. Local side is built (`remember` auto-save, `/skills`, `@skill:`); Hermes runtime parked as optional future per owner decision (ADR-008) — not needed while the local brain learns.
- [ ] Owner's minor-issues list (awaited — owner chose to list them, not yet received).

## Future / Next Milestones
- [ ] Add streaming speed & token-per-second live metrics toggle in `/settings`.
- [ ] Support local model downloads (Ollama / Llama.cpp auto-detection).
- [ ] Expand MCP integrations catalogue with one-click connectors.
