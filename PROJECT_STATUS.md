# KiCode Project Status

**Current Version:** 0.1.0  
**Build Status:** Stable, All 948 Tests Passing (49 test suites, two consecutive green runs)  
**TypeScript Check:** Clean (`tsc --noEmit` exits with 0)  
**Binary Distribution:** Built (`dist/cli.js`, ~456 KB) via `npm run build`

---

## 🚀 Key Features Implemented

### 0a. Rate-Limit Recovery, Attachments & File Upload (ADR-013/014/015/016)
- **429 handling in three layers** (ADR-013): a rate limit pauses before the next route (gateway `Retry-After` honoured to a 60s ceiling, else 1.5s growing per hop) with a live busy-row countdown; an active `:free` model can implicitly fall back to the endpoint's other free models discovered from its own `/models` list the first time the chain runs dry (capped at 4 hops, never a paid model, **opt-in** via `"fallbackAuto": true` / `KICODE_FALLBACK_AUTO=on`); and an all-routes-capped turn ends with advice ("wait a bit, or /models") instead of a bare HTTP code.
- **Recovery modal on a failed turn** (ADR-015): a centered card carries the gateway's message with `r retry · m choose model · esc dismiss` — `r` re-runs the exact request (words, attachments, model), `m` opens the model picker and retries on whatever lands, Esc keeps the error in the transcript. Goal runs stay autonomous; the queue holds behind the modal. Auto-switching is opt-in, not default.
- **File upload by click** (ADR-016): a `[+]` button on the right of the input bar opens the platform's own file-selection window — PowerShell's `OpenFileDialog` on Windows, `zenity`/`kdialog` on Linux, `osascript` on macOS — and the chosen file attaches automatically. Images ride the existing base64 path (`[Image n]` badges); documents are read at attach time and appended to the next turn as a `Context from attached file "…"` block that works on every model. Cancelling is silent, a platform with no picker falls back to typing a path in the prompt, and the old `/attach` command is gone; badges, backspace-detach and the right-click clear items carry over from ADR-014.
- **Caret row off-by-one fixed** (found by the attach-button tests, ADR-016): the caret row omitted the tab bar's row, so with the sidebar visible the terminal caret and every prompt-row click sat one row too high; the selection-start guard also now refuses the chrome under the rule, so a drag there cannot copy `Ask anything...` as conversation text.
- **Plan-mode false refusals fixed**: the read-only classifier now permits `2>/dev/null`, `2>&1` and `1>/dev/null` — the stderr-quieting idioms models reach for constantly while exploring — while any redirect to a real path stays refused.
- **Request block chips**: the user message's fill hugs its text (widest row + 2 cells) rather than stretching to the column, so short messages no longer read as a background cut off mid-row.

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
  - `[+]` attach button and `↑` send button on the prompt row; the variant is changed with `/effort` (the `[Think]` pill was removed at the owner's request).
  - `↑` Send button (clickable and keyboard responsive) in a blue square.
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
