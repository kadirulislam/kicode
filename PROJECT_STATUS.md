# KiCode Project Status

**Current Version:** 0.1.0  
**Build Status:** Stable, All 911 Tests Passing (47 test suites)  
**TypeScript Check:** Clean (`tsc --noEmit` exits with 0)  
**Binary Distribution:** Built (`dist/cli.js`) via `npm run build`

---

## 🚀 Key Features Implemented

### 0. Reading-Level Transcript Discipline (ADR-012)
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
  - `[Think]` pill with variant switcher (`default`, `low`, `medium`, `high`).
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
