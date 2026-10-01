# KiCode Project Status

**Current Version:** 0.1.0  
**Build Status:** Stable, All 978 Tests Passing (49 test suites)  
**TypeScript Check:** Clean (`tsc --noEmit` exits with 0)  
**Binary Distribution:** Built (`dist/cli.js`, ~467 KB) via `npm run build`

---

## 🚀 Key Features Implemented

### 0a. Rate-Limit Recovery, Attachments & File Upload (ADR-013/014/015/016)
- **429 handling in three layers** (ADR-013): a rate limit pauses before the next route (gateway `Retry-After` honoured to a 60s ceiling, else 1.5s growing per hop) with a live busy-row countdown; an active `:free` model can implicitly fall back to the endpoint's other free models discovered from its own `/models` list the first time the chain runs dry (capped at 4 hops, never a paid model, **opt-in** via `"fallbackAuto": true` / `KICODE_FALLBACK_AUTO=on`); and an all-routes-capped turn ends with advice ("wait a bit, or /models") instead of a bare HTTP code.
- **Recovery modal on a failed turn** (ADR-015): a centered card carries the gateway's message with `r retry · m choose model · esc dismiss` — `r` re-runs the exact request (words, attachments, model), `m` opens the model picker and retries on whatever lands, Esc keeps the error in the transcript. Goal runs stay autonomous; the queue holds behind the modal. Auto-switching is opt-in, not default.
- **File upload by click** (ADR-016): a `[+]` button on the right of the input bar opens the platform's own file-selection window — PowerShell's `OpenFileDialog` on Windows, `zenity`/`kdialog` on Linux, `osascript` on macOS — and the chosen file attaches automatically. Images ride the existing base64 path (`[Image n]` badges); documents are read at attach time and appended to the next turn as a `Context from attached file "…"` block that works on every model. Cancelling is silent, a platform with no picker falls back to typing a path in the prompt, and the old `/attach` command is gone; badges, backspace-detach and the right-click clear items carry over from ADR-014.
- **Caret row off-by-one fixed** (found by the attach-button tests, ADR-016): the caret row omitted the tab bar's row, so with the sidebar visible the terminal caret and every prompt-row click sat one row too high; the selection-start guard also now refuses the chrome under the rule, so a drag there cannot copy `Ask anything...` as conversation text.
- **Plan-mode false refusals fixed**: the read-only classifier now permits `2>/dev/null`, `2>&1` and `1>/dev/null` — the stderr-quieting idioms models reach for constantly while exploring — while any redirect to a real path stays refused.
- **Request block chips**: the user message's fill hugs its text (widest row + 2 cells) rather than stretching to the column, so short messages no longer read as a background cut off mid-row.

### 0b. Panels Float Over a Faded Page (ADR-017)
- **Modals and pickers are cards over the transcript, not instead of it**: `/models`, `/settings` and the full-screen menus render the conversation behind them and fade it (one faint style on the page background, chip fills included), so the only thing at full strength is the card being answered.
- **The card sits at the foot of the page**, directly above the rule and the prompt — where the eye already is while typing — instead of being centred in the transcript. The permission modal gets the same fade behind it, and the mode row and footer keep their colour because they carry the keys the card is asking for.
- **While a card is up it owns the clicks**: the faded page contributes no click targets, so an unclear row cannot be pressed by accident.

### 0d. The Card Answers to a Mouse, and Escape Is a Chip (ADR-019)
- **The permission and recovery cards sit at the foot of the page**, their last row the last row of the conversation — directly above the rule and the prompt, where a picker already lands — instead of floating in the middle of the screen.
- **Every answer on a card is a chip**: `[y] yes · [a] always · [n] no` on a permission prompt, `[r] retry · [m] choose model · [×] dismiss` on a failed turn. A click names the key and the same handler a keypress reaches answers it, so a mouse answer cannot drift from a typed one — `[m]` still opens the model picker with the failed turn set aside.
- **`esc` is drawn as a clickable `[×]` everywhere it is offered**: the session footer's hints, a picker's title row, a menu's title and footer, the clipboard menu, and a card's own decision row. Each target is found by walking the row the chip was drawn in, so it cannot drift from the glyph.
- **While a card is up it is the only thing clickable** (plus the footer, whose `[×]` is the permission card's way out) — and two bugs were fixed on the way: a multi-line gateway message printed as one run-on row on the recovery card, and the `[+]` attach hit box sat one column left of its glyph.

### 0g. The List Cards Are Filled Surfaces, With Headings of Their Own (ADR-022)
- **The picker is no longer a frame.** `/sessions`, `/models`, `/skills` and the prompt-input cards are one filled surface with no border glyphs, as wide as the screen allows (up to 84 columns, was 68) — the fill, not a `┌─┐` outline, is what says where the card is. The settings/connect band was already built that way (ADR-017); now the two cards are the same material, and both are opaque where a blank row used to let the page through.
- **Group headings have a hue of their own** — a new `heading` theme slot, in every palette's own pink/purple family (kicode magenta `#f472b6`), because a heading names the rows under it rather than being one of them, and the accent belongs to the row the keys act on.
- **The row under the cursor is filled, with no cursor glyph** — a fill and a bar beside it say the same thing twice — and the row's text switches to the fill's foreground. The dot for the session in use stays.
- **A card's footer has two ends**: the hint pairs run from the left except the last, which is pinned to the card's right edge. The sessions card now names `ctrl+d delete`, which works on the row under the cursor and leaves the card up with one row fewer.
- **The fade was checked and is unchanged** (ADR-017): the conversation behind a picker or a menu is dropped to the faint style on the page background, and the chrome (tab bar, state row, footer) keeps its colour.

### 0f. The Input Box Is Fill Only, on a Lighter Surface (ADR-021)
- **The box and its state row wear a new theme slot, `input`**, a step off the user-turn fill — lighter on every dark theme (kicode `#1d1e2e` → `#2b2f47`), darker on the light ones — so the typing area reads as the surface in front instead of a shade off the transcript, and it follows whichever theme is in use.
- **No bar down the box's left edge**: the box is fill and its own air, and the state row lost its bar too (the mode word keeps its colour, which is where build/plan is read from). The text still starts in the same column, so the caret, badges and every click that places the caret are unchanged.
- **More air**: two rows of the box's fill above the text and two below, where there was one of each — the box is a row taller, the caret sits at row 20 of 24, and the transcript gives up that row.

### 0e. The Prompt Wraps, and the Box Grows With It (ADR-020)
- **The prompt wraps instead of being cut at the edge**: a line past the terminal's width is broken at the last space that fits (mid-word when there is none), so a long path or a wall of one character is readable rather than ending in a `…` — nothing typed is off screen.
- **The box grows with the text, up to six rows**, past which the rows follow the caret — what is being typed stays visible without the box eating the transcript it stands on. The rows under the first keep the first row's text column, and the `[+]` control rides only the row being typed on.
- **The caret is measured against the row it wrapped onto**, so it sits where the next character goes; the renderer now reports the box's own rows (`RenderedFrame.prompt`) — including the column the text starts in — so a click places the caret on the row it actually landed on, and the old `attached.length * 10` guess for badges is gone.
- **Caret column off-by-one fixed**: the caret sat one cell left of the insertion point (`margin + 2` where the text starts at `margin + 3`), visible in the empty box too.

### 0c. The Input Box Reads as a Typing Area, and the Todo List Goes Live (ADR-018)
- **The send arrow is gone**: the blue `↑` button was the loudest thing on a quiet row for the one action the keyboard already has (enter). The `[+]` attach button stays, anchored to the right edge; its click hit box was re-derived to match, since the drawn glyph and the hit box are computed from the same arithmetic in two files.
- **The box wears a filled surface of its own** (`theme.block` at the time, `theme.input` since ADR-021), not the `theme.panel` it shared with the tab bar, so the place being typed into is visibly a surface rather than one more line of transcript — and the page behind it got deeper (`kicode` background `#0c0d14` → `#08090f`). The permission card keeps `panel`, and the state row takes whatever fill is over it.
- **A blank row of the box's own fill sits between the editor and the state row**, in place of the padding row that used to trail under the status line — the same height, so the transcript does not lose a row. *(Since ADR-021 that gap is two rows and the box carries its own air above the text as well; it is one row taller in total.)*
- **Live todo card**: the `todo` tool's output is no longer appended per call — the previous card is lifted out and the newest state put at the end of the transcript, so there is exactly one checklist and it ticks over where the work is. The system prompt now asks the model to keep such a list for multi-step work.

### 0b. Reading-Level Transcript Discipline (ADR-012)
- **Accent selection fill** instead of inverse video (`Styles.selection` + parameterized `markCells`) — visible on terminals where `ESC[7m` renders as nothing; the centered permission modal is selectable like every other row. Root-cause fix: `TuiApp.state()` now passes the live selection to the renderer (previously the tested highlight code never ran on screen); pinned by a raw-bytes mouse-drag regression test.
- **Thinking ticker**: live reasoning renders as one line (`▌ thinking <newest sentence>`, 96-char cap) at low/medium verbosity; full stream only at high.
- **One-line tool results** at medium verbosity (`first line · N lines`) so a mid-turn result never becomes a wall.
- **Tool-argument summaries**: `ask` shows `3 questions: "<first question>"` instead of a raw JSON dump of option objects; every argument value is capped at one line — the permission modal now floats over a readable transcript, not a JSON wall.
- **Folded repeat notes**: identical failures (the same 429 on every retry) render as one row with a `×N` count, folding past the user's retry message.
- **Forgiving `ask` validation**: free-model argument drift (double-encoded JSON, single-object payloads, question text under `title`/`prompt`/`header`, options as object maps or strings) is rescued instead of refused — the plan-mode `no usable questions` error no longer bounces well-meant calls; the refusal message names what it received.
- **Session picker search** (ADR-010): `today · 4 msgs` trailing metadata and matching against the opening-request preview.
- **`kicode --probe`**: staged endpoint diagnosis (models → tiny chat) with gateway-specific verdicts; OpenCode client validation headers (`User-Agent: kicode/<version>`, `x-opencode-session`) sent on every request, fallbacks included.

### 1. Modern UI & Chat Interface
- **Centered Greeting**: "Where should we begin?" on empty transcript/home screen.
- **Enhanced Prompt Box**:
  - `Ask anything...` placeholder, no emoji.
  - Interactive `+` button to open the Clipboard & Attachment Options menu.
  - Attached image chips `[Image i]` with click-to-remove.
  - `[+]` attach button at the right edge of the prompt row — the only control pressed while typing; the variant is changed with `/effort` and send is enter (the `[Think]` pill and the `↑` button were both removed at the owner's request).
  - The box is a fill-only surface (no left bar) on the theme's own `input` slot, with two rows of its own fill above the text and two below, so it reads as the typing area (ADR-018, ADR-021).
  - Long prompts wrap inside the box and the box grows with them (up to six rows, then it follows the caret) instead of being clipped at the right edge (ADR-020).
- **Interactive Mouse Controls & Scrollbar**:
  - Drag-to-select text in the transcript without auto-copying or auto-pasting.
  - Mouse-interactive scrollbar on the right border.
  - "Go To Bottom" quick-jump chip when scrolled up.
  - Airy tabs (` title  ×  `) with hover states, active indicators, click-to-close (`×`), and a compact `+NEW` button; every fresh session opens on the home screen.

### 2. Palette, Plan Mode & Agent Tools
- **Palette lists only runnable commands**: aliases (`/q`, `/open`, …) still run when typed and dead names (`/agents`, `/plugins`, …) still explain themselves — neither occupies a row.
- **Plan-mode toolset**: `plan` presents goal + numbered steps for review (the plan-mode deliverable), `todo` tracks steps across turns (`add`/`done`/`list`/`clear`), per-session isolated state, never approval-gated.
- **Emoji-free bar-style chat area** (ADR-004): single `▌` accent bar, no frame borders, `▌ Build · model · variant` status row, `┌┐└┘` picker corners, no sender headers.

### 3. Clipboard & Selection Management
- Dedicated **Right-Click Clipboard Menu**:
  - `Paste Text from Clipboard`
  - `Paste Image from Clipboard`
  - `Paste from Clipboard (Smart)`
  - `Copy Selection` (`Ctrl+C`)
  - `Clear Selection`
  - `Remove Attached Images`
  - `Copy Entire Conversation`
- Separation of copy and paste actions: selecting text no longer pollutes the prompt.

### 4. API Key & Model Management (Global Settings)
- **Zero-Env Global Storage**:
  - API keys and custom providers are stored directly in `~/.kicode.json` (`globalConfigPath`), eliminating reliance on system environment variables.
  - Direct `apiKey` field support in `FileSettings`, `FileProvider`, `loadConfig`, and `readProviders`.
- **Interactive Input Modals**:
  - `Manually enter API Key` dialog with `esc` to cancel and `enter submit`.
  - `Add API Provider (Base URL)` workflow to quickly configure custom OpenAI-compatible proxies/routers.
- **Provider Resolution & 401 Prevention**:
  - Added `tokenharbor` (`https://tokenharbor.ai/v1`, `TOKENHARBOR_API_KEY`) and `tokenharbour` (`https://api.tokenharbour.com/v1`, `TOKENHARBOUR_API_KEY`) to built-in catalogue.
  - Fixed endpoint key resolution in `createAgent` and `listModels` to match target `baseUrl`, preventing erroneous fallback to OpenAI default credentials.
- **Dedicated Slash Commands**:
  - `/key` / `/api-key` - Manually enter or update API key for active provider.
  - `/add-provider` / `/add-model` - Register custom base URL & API key.
  - `/connect` - Includes `+ Add Custom Provider` and `+ Manually enter API Key`.
  - `Ctrl+K` shortcut inside `/models` picker to enter/update endpoint API key.

---

## 🛠️ Verification & Build Commands

```bash
# Run type check
npm run typecheck

# Run full test suite
npm test

# Build release bundle
npm run build

# Start KiCode
npm start
```
