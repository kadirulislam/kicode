# KiCode Project Status

**Current Version:** 0.2.0  
**Build Status:** Stable, All 1506 Tests Passing (59 test suites)  
**Subagent delegation:** built (ADR-053) — one `delegate` tool, read-only children (`read`, `glob`, `grep`, `recall`), a live dock above the prompt plus `/agents running` and a clickable `[AGENTS n/m]` chip for the roster; one `delegation.model` pin, empty by default so a fresh install spends no second model's money. Verified end to end against the mock provider (`MOCK_TOOL=delegate`, `MOCK_LOG=1`). Known gap: a child's tokens are not charged to the parent's ledger, so `/usage` under-reports a delegated session  
**Named subagents:** built (ADR-054) — `/agents` lists them and opens a form to add one, edit one, or change what it may do; `delegate({ agent })` names one and the names sit in the tool description so the model can choose by name. Profiles live in `~/.kicode/agents.json` and `<cwd>/.kicode/agents.json`, the project's overriding by name. Read-only by default, edit opt-in per agent, and **`bash` is never grantable** — a child has no approval channel. The roster itself is in the **system prompt** (ADR-057)  
**Agent skills:** built (ADR-058) — each agent may have a folder beside its file, `SKILL.md` as the standing brief and every other `.md` as a skill. The skills go into the roster by name and description, which is what the routing decision is actually made against, and the child is handed the paths to read. Verified against a real folder from outside the process  
**Resumable delegation:** built (ADR-059) — children a cancelled turn left unfinished are named to the next turn once, by agent and goal, so the batch is finished rather than re-planned. The work restarts; that is the stated limit  
**Permission ladder:** built (ADR-060) — a clickable chip below the chat: `[ASK]` (default every run), `[EDITS]`, `[ALL]`. Decides on the tool, never its arguments; `/permission` sets a rung outright
**Decomposition:** prompt work, not mechanism (ADR-066) — delegate leads with the batch form and a worked example, and a Delegation: prompt section is appended **only when the tool is registered**, chained onto the todo rule the model already follows. Cannot be made reliable; a model has to decide what is a separate task. The eval harness is what would make it measurable
**Task completion:** built (ADR-065) — an unfinished delegated task (stalled, out of turns, or returned nothing) is retried once carrying the first attempt's partial report; a crash is not, since it will not fix itself. The child's prompt carries a completion contract, which the **parent** reads and the runner does not parse. The report says `tried 2x` and says `UNFINISHED` in capitals when a task still did not finish. `delegation.retryUnfinished` (default 1, `0` off); a retry is the same task so it does not spend `maxPerTurn` again  
**GitHub tool:** built (ADR-064) — `github({ path, jq, paginate })` reads api.github.com through `gh` via `execFile`, so there is no shell to inject into; URLs, `@` and `jq`'s `$ENV` are refused before anything runs. Opt-in per subagent and off by default, because it carries the user's token and /user/repos answers with private repos
**Overlapping tool calls:** built (ADR-063) — independent reads in one turn run concurrently while the transcript stays in call order; 18×40ms reads measured 853ms → 44ms. Only `read`/`glob`/`grep`/`recall` are marked `concurrencySafe`; approvals stay sequential and run before anything launches  
**Release readiness:** see [`LAUNCH.md`](LAUNCH.md) — artifacts and paths verified end to end; publishing runs from CI with provenance, so the owner must first rotate the leaked keys, scrub history and make the repository public  
**TypeScript Check:** Clean (`tsc --noEmit` exits with 0)  
**Binary Distribution:** Built (`dist/cli.js`, ~300 KB **minified**, ADR-037) via `npm run build`  
**Per-session settings:** model, endpoint, directory, mode and variant belong to the session; all five persist in the session file and are restored on a switch, and a resumed run opens on its own saved model/mode/variant (ADR-040)  
**Distribution & License:** Publishable to npm under a **proprietary** (`UNLICENSED`) licence; the tarball ships the minified bundle + README/CHANGELOG/LICENSE only — source, tests and history are not published. Publication runs in CI (`.github/workflows/publish.yml`) with an npm **provenance** attestation, which requires the repository to be public  
**Auto-compaction:** Fires at **150K** estimated tokens (`compactAt`), inside a 200K default window  
**Credential guard:** `npm run check:secrets` (also a git pre-commit hook, and the first CI step)  
**Keys on disk:** none, in either direction — nothing writes one (`settings-write.ts` has no field) and one found in a config file is reported and ignored at any scope (ADR-038)  
**Providers are declared, never inherited (ADR-041):** the environment supplies a key only to a provider that names it (`apiKeyEnv`); a fresh install has no endpoint at all and says so — `No provider is configured yet.` — because an ambient `OPENAI_BASE_URL`/`OPENAI_API_KEY` used to become the session's provider invisibly  
**First run with no key:** opens the full-screen UI so `/connect` and `/key` are reachable; `--tui-preview` needs no key at all (ADR-038)  
**Turn ceiling:** settable (`kicode.json` `maxTurns` / `KICODE_MAX_TURNS`), default **100** (was 40) (ADR-039)  
**Approvals:** read-only calls do not prompt, "always" outlives the agent rebuild, and `kicode.json` `allow` rules skip the prompt (ADR-039)  
**Shift+Enter:** inserts a line break, decoded from modifyOtherKeys, the kitty protocol (CSI-u) and `ESC CR`/`ESC LF` (ADR-039, ADR-040)  
**Background turns:** a running turn keeps going when you switch sessions — the session is parked, its answer is saved under its own id, its queue drains on its own, and its tab shows `◐`; an off-screen approval is auto-denied with a notice and an off-screen question is skipped (ADR-040)  
**Skills:** `/skills delete <name>` retires a skill into `<brain>/.trash/` (ADR-039)

---

## 🚀 Key Features Implemented

### 0. A Fresh User's Brain Is Created, Not Demanded (ADR-031)
- **The bootstrap that was missing.** Before this, a brain was found only via `KI_BRAIN_PATH` or an upward walk for `ki-agent-brain`, and `remember` *refused* when neither existed — so a new user's first save failed and nothing ever accumulated. Now the resolution order is **`KI_BRAIN_PATH` → `brain` in `kicode.json` → existing `ki-agent-brain` → `~/.kicode/brain`**, and the first `remember` **creates** the configured path or the default `~/.kicode/brain`.
- **Existing brains are untouched**: the `ki-agent-brain` walk is kept, so a brain in use is never abandoned; it is only a read fallback, never a creation target.
- **`brain` is a validated config key** (`~` means home, a relative path resolves against the working directory), read synchronously because the briefing has no `await` on its path.

### 0. The Brain Is Read Back, and the Agent Knows When to Write (ADR-030)
- **Recall — the half that was missing.** The brain used to be write-only: `remember` saved skills and project memories, but nothing reached the next session unless the user typed `@project:…` by hand. Now a bounded **brain briefing** (this project's memory text, plus skill names and descriptions) is folded into the system prompt at session start, and a new **`recall` tool** loads a full skill or memory body on demand — by exact name or by the words you remember.
- **A write policy instead of one vague line.** The prompt now states exactly *when* to save (a user's stated preference or decision; a non-obvious gotcha with its fix; a project convention the code does not show; a ≥3-step procedure worth repeating) and *when not to* (one-off output, code restated, speculation, transient errors, secrets, anything already recorded), and tells the model to add to this project's memory rather than repeat it.
- **Skills are correctable.** `remember` gained `action: "update"`, so a skill can be fixed deliberately; a plain save still refuses to overwrite one. Frontmatter quotes are stripped, so descriptions read cleanly in the briefing and the `@skill:` list.
- **The reader is recursive**, so a maintained brain's categorised skills (`skills/android/adb-automation/SKILL.md`) are found, not just the flat ones `remember` writes.

### 0. The TODO Button and Its Plan Panel (ADR-029)
- **Tracked work is a button**: the state row carries a `[TODO n/m]` chip whenever the `todo` or `goal` tool is holding work — pressing it opens a panel, and the chip only exists when there is something to show. A running goal's own subtask progress is preferred in the label.
- **The panel is a narrow card on the right, above the box**: checklist rows with `✓`/`◐`/`○`, a 10-cell progress bar, and — when a goal is running — its status, title, subtasks and current task. `esc` or the `[×]` closes it.
- **The state travels as data, not text**: `Tool` gained an optional `snapshot()`, implemented by the plan tools; the loop forwards it as a new `plan` event, so the panel draws a structure instead of parsing the checklist the model was handed. The app holds the snapshot, so it survives a model switch.

### 0. OpenCode 403 Is Diagnosed as a Client Restriction (ADR-029)
- **A bare 403 on opencode.ai now says what it is.** Credentials are a 401, so a 403 is the client gate — the note no longer waits for the body to carry an OpenCode-shaped `AuthError`, which newer responses do not always send. A 401 still needs the body to confirm it, since it can also be a wrong key. `kicode --probe` picks this up through the same message.

### 0. The Turn Continues While Tracked Work Remains (ADR-028)
- **The stop is enforced, not just requested**: a turn that answers while the `todo` or `goal` tool still holds open work is nudged to carry on instead of ending — "the agent stopped mid-task" was the loop's rule, and the rule is now the other way round. `Tool` gained an optional `pendingWork()` (the plan tools implement it), and `loop.ts` reads it before accepting an answer.
- **The nudge is bounded like the re-ask**: at most three in a row (`MAX_CONTINUATIONS`), and any tool call hands the allowance back, because progress is what the bound protects. Plan mode is exempt — an open list there *is* the plan, whose deliverable is stopping for review.
- **The system prompt now draws the line between asking and continuing**: work to the end of the task in one turn (don't stop to report progress), and use the `ask` tool only when the decision is genuinely the user's — pick a reasonable default and say what was assumed otherwise.
- **The stop is said out loud**: the `continued` event gained a third reason, `work`, rendered as `tracked work is not finished — asking it to carry on` in both the TUI and one-shot mode.

### 0. Queued Messages Are Tiles Above the Box, and Commands Run the Same Way (ADR-028)
- **The queue is visible**: while a turn runs, each queued message is a tile above the input box, with its own `[x]` that drops just that one — a message queued by mistake is removed by clicking it, not by clearing the queue and retyping the rest. The renderer reports each `[x]`'s columns (`PanelKind: "queued"`), so a press can never land on the wrong tile.
- **`ADD[+]` in the box queues what is typed**: shown only while a turn (or a paused session) gives the queue something to drain into, so the idle box keeps its full width for the words that enter already sends.
- **A queued line that starts with `/` runs as a command** when its turn arrives (`runQueued`) — a `/goal …` typed mid-turn starts a goal, it is not handed to the model as prose.
- **`/insert` and `/queue` with an argument run at once when idle** — with nothing in flight there is nothing to insert ahead of; a bare `/insert` fills `/insert ` into the box and waits rather than printing a dead-end usage line.
- **Choosing a command that needs an argument fills the box and waits**: `/goal`, `/cd`, `/rename` (any `usage` written in angle brackets) put `/cmd ` in the box with the cursor waiting, instead of being submitted with the argument missing.

### 0. Clipboard Image Preview & Last-5 History
- **Vivid True-Color Image Preview Before Pasting**: When copying an image (or selecting an image from history), the clipboard modal displays a real 24×6 true-color thumbnail rendered via terminal half-blocks (`▀`), with 24-bit RGB foreground and background sampling decoded directly from PNG via `node:zlib`. Colors are safely preserved across ANSI escape sanitization.
- **Last-5 Copied History Persistence**: Automatically captures up to 5 recent copied items (text and images) across copies and right-clicks, persistently saved to `~/.kicode/clipboard_history.json`.
- **Dynamic Arrow/Hover Preview Switching**: Navigating the clipboard menu (`↑`/`↓` arrow keys, mouse hover, or mouse wheel) dynamically swaps the preview card between text line-numbered snippets and true-color image previews for whichever history entry is focused.
- **Quick 1-5 Number / Click Selection**: Pressing `1`–`5` or clicking any history entry immediately pastes the text into the editor or attaches the image to the upcoming prompt.

### 0a. Animated "Agent is Thinking..." & Square Blocks Mode Working Animation
- **Animated Thinking Loading Indicator**: When the model is thinking or processing a turn, instead of dumping walls or streaming fragments of raw reasoning text into the transcript, an animated loading indicator (`▌ ⠋ Agent is Thinking...`) displays with a rotating Braille spinner and cycling ellipsis dots in the transcript above the prompt box.
- **Square Blocks Mode Status Animation**: Replaced duplicate bottom status line text with a pulsing 5-block square animation (`■ ■ □ □ □`) that explains mode execution (e.g. `Working in Build mode...`), cleanly separating thinking state in the transcript from operational mode status below the prompt box.
- **Minimal Right-Bottom Footer**: Removed the redundant `ctrl+p commands` text from the bottom-right footer, leaving the footer clean and exclusively focused on the working directory and token/tool metrics.

### 0a. Warning Modal Redesign & Persistent Tab Bar
- **Warning / Turn Failure Modal UI**: Recovery modal (`The turn failed — what now?`) now renders with a rich red alert shade tint (`blend(theme.panel, theme.error, 0.18)`), vibrant red left indicator bar (`▌`), `⚠ ` warning glyph, bold error title, and vertical air/spacers separating title, body, and decision chips.
- **Full Chip Mouse Click Targets**: Decision chips (`[r] retry`, `[m] choose model`, `[×] dismiss`) now have hit boundaries spanning the complete button bracket and label text (with ±1 col tolerance), allowing effortless mouse clicks anywhere on the button or text.
- **Tab Bar Persistence Across Session Closures**: `sidebar` now defaults to `"on"` (rather than `"auto"`), ensuring that closing tabs down to a single session or a new session leaves the tab bar and `+NEW` button fully visible and clickable. Closing the last session cleanly resets to an accessible new session with the `+NEW` tab button ready.

### 0a. Rate-Limit Recovery, Attachments & File Upload (ADR-013/014/015/016)
- **429 handling in three layers** (ADR-013): a rate limit pauses before the next route (gateway `Retry-After` honoured to a 60s ceiling, else 1.5s growing per hop) with a live busy-row countdown; an active `:free` model can implicitly fall back to the endpoint's other free models discovered from its own `/models` list the first time the chain runs dry (capped at 4 hops, never a paid model, **opt-in** via `"fallbackAuto": true` / `KICODE_FALLBACK_AUTO=on`); and an all-routes-capped turn ends with advice ("wait a bit, or /models") instead of a bare HTTP code.
- **Recovery modal on a failed turn** (ADR-015): a centered card carries the gateway's message with `r retry · m choose model · esc dismiss` — `r` re-runs the exact request (words, attachments, model), `m` opens the model picker and retries on whatever lands, Esc keeps the error in the transcript. Goal runs stay autonomous; the queue holds behind the modal. Auto-switching is opt-in, not default.
- **File upload by click** (ADR-016): a `[+]` button on the right of the input bar — `UPLOAD[+]` since ADR-023 — opens the platform's own file-selection window — PowerShell's `OpenFileDialog` on Windows, `zenity`/`kdialog` on Linux, `osascript` on macOS — and the chosen file attaches automatically. Images ride the existing base64 path (`[Image n]` badges); documents are read at attach time and appended to the next turn as a `Context from attached file "…"` block that works on every model. Cancelling is silent, a platform with no picker falls back to typing a path in the prompt, and the old `/attach` command is gone; badges, backspace-detach and the right-click clear items carry over from ADR-014.
- **Caret row off-by-one fixed** (found by the attach-button tests, ADR-016): the caret row omitted the tab bar's row, so with the sidebar visible the terminal caret and every prompt-row click sat one row too high; the selection-start guard also now refuses the chrome under the rule, so a drag there cannot copy `Ask anything...` as conversation text.
- **Plan-mode false refusals fixed**: the read-only classifier now permits `2>/dev/null`, `2>&1` and `1>/dev/null` — the stderr-quieting idioms models reach for constantly while exploring — while any redirect to a real path stays refused.
- **Request block chips**: the user message's fill hugs its text (widest row + 2 cells) rather than stretching to the column, so short messages no longer read as a background cut off mid-row.

### 0b. Panels Float Over a Faded Page (ADR-017) & Centered Clean Cards
- **Modals and pickers are cards over the transcript, not instead of it**: `/models`, `/settings` and the full-screen menus render the conversation behind them and fade it (one faint style on the page background, chip fills included), so the only thing at full strength is the card being answered.
- **Centered, comfortable card layout with max-content width & working [x] close chip**: Picker dialogs (`/models`, `/sessions`, provider dropdown, etc.) are centered both horizontally and vertically in the terminal window. Width calculates cleanly from content (`max-content` based on title, tabs, items, trailing badges, and hints, clamped between 24 and 76 columns) so cards hug their contents cleanly without empty horizontal dead space or background bleeding. The top-right `[x]` / `[×]` close chip registers exact hit targets so clicking it dismisses the dialog immediately. Tab context menus remain docked at the tab bar, rate limiting/warning modals remain docked above the prompt, and clipboard menus remain docked above the input bar. Item click hit detection covers the full row width for smooth selection.
- **Clean date grouping for `/sessions`**: Sessions are bucketed into clean date sections (`Today`, `Yesterday`, `Previous 7 Days`, `Previous 30 Days`, and `Month Year`), sorted chronologically newest-first. Group headings are deduplicated across consecutive rows so section titles render once at the top of each block instead of repeating on every row.
- **Provider filter dropdown for `/models`**: In the `/models` picker, users can filter models across providers under `paid`, `free`, or `all` tiers. A `provider: <name> ▾` tab and `ctrl+p: select provider` key offer an interactive dropdown listing `All Providers` and each endpoint with model counts. Clicking or selecting a provider filters the model list instantly.
- **While a card is up it owns the clicks**: the faded page contributes no click targets, so an unclear row cannot be pressed by accident.

### 0d. The Card Answers to a Mouse, and Escape Is a Chip (ADR-019)
- **The permission and recovery cards sit at the foot of the page**, their last row the last row of the conversation — directly above the rule and the prompt, where a picker already lands — instead of floating in the middle of the screen.
- **Every answer on a card is a chip**: `[y] yes · [a] always · [n] no` on a permission prompt, `[r] retry · [m] choose model · [×] dismiss` on a failed turn. A click names the key and the same handler a keypress reaches answers it, so a mouse answer cannot drift from a typed one — `[m]` still opens the model picker with the failed turn set aside.
- **`esc` is drawn as a clickable `[×]` everywhere it is offered**: the session footer's hints, a picker's title row, a menu's title and footer, the clipboard menu, and a card's own decision row. Each target is found by walking the row the chip was drawn in, so it cannot drift from the glyph.
- **While a card is up it is the only thing clickable** (plus the footer, whose `[×]` is the permission card's way out) — and two bugs were fixed on the way: a multi-line gateway message printed as one run-on row on the recovery card, and the `[+]` attach hit box sat one column left of its glyph.

### 0j. A Turn Ends at an Answer, Not at the Absence of a Tool Call (ADR-025)
- **The stop was the loop's rule, not the model's** — owner's issue 8: "the agent sometimes stops mid-task". `done("complete")` was reached whenever a reply carried no tool call, and the loop never looked at why the endpoint stopped writing. A reply the endpoint's own output cap cut off (`finish_reason: "length"` — KiCode sends no `max_tokens`, so the gateway's default *is* the cap, often 4 096) was filed as an answer and the turn ended mid-sentence; a reply with no words and no tool call was filed as an answer too, so the turn ended having done nothing at all.
- **A turn now ends at an answer**: a turn that asked for tools, or one that said something and was allowed to finish. Anything else — cut off by the endpoint, or empty — is asked again, bounded at **three in a row** (`MAX_CONTINUATIONS`), with the allowance handed back by any turn that ran a tool, since progress is what the bound protects. Continuations count against the ordinary request budget like any other request.
- **A cut-off reply is kept and built on**: the words that did arrive are pushed into the transcript exactly as they were, so the next request continues the half-finished thought instead of restarting the answer. An *empty* reply is deliberately not kept — an empty assistant message is a turn the model never really made, some endpoints refuse one back — so the same question goes out unchanged.
- **The stop is said out loud**: a new `continued` event names which way it stopped and which attempt it was, shown as a dim note (`the reply was cut off — asking it to carry on` / `the model answered with nothing — asking again`) in the TUI and as a dim line in one-shot mode.
- **The request budget is 40, not 12** — ordinary work (look, read, edit, verify across a few files) reached 12 before anything had gone wrong — and hitting it is no longer silent: the turn adds `turn budget reached — send anything to carry on`. `loop.ts` now owns `DEFAULT_MAX_TURNS` and `config.ts` re-exports it, so the number has one home.

### 0i. Compaction Aims at a Size, Not at a Count of Turns (ADR-024)
- **A compacted session is left at `targetPercent` of its window** — 40% by default, clamped to a 30–50% band — instead of at "the last six turns". Two turns can be two thousand tokens or ninety thousand, so a count kept far too little in a tool-heavy session and left far too much in a quiet one; a size is the thing that can be aimed at.
- **The tail is the longest run of recent turns that fits**, so the session lands *at* the target and keeps as much verbatim history as the target allows. A session already at its target is left alone — `/compact` says there is nothing to do rather than spending a model call to make it bigger.
- **The cut prefers a request** (a tail that opens on the words that prompted the work), and moves inside a turn only when one enormous turn leaves no request cut that fits — the case that used to refuse to compact at all, so a long autonomous run could grow until the window broke it. A tool result is never orphaned: the cut is moved back to the call behind it.
- **The briefing has a budget too** — a fifth of the target, reserved before the cut is chosen and said out loud in the summariser's instructions — because a summary that runs long is what pushed sessions back over their target.
- **`keepRecentTurns` is gone** (a turn count was the bug); a config that still sets it is told so and ignored. The notices now name the aim: `compacted 12 earlier messages · ~100.0K → ~43.0K tokens (target ~51.2K)`.

### 0h. The Mode Is a Button on the Box's Left Edge, and Upload Is Spelled Out (ADR-023)
- **The mode rides the box's left edge as a pill** — `[BUILD]` / `[PLAN]` / `[PAUSED]` / `[GOAL]`, the mode's own word inside brackets (the shape `[esc]` and `[y]` already have), in the mode's colour, warning-coloured when the mode is not the everyday one. It is a **button**: a click cycles the mode exactly as `shift+tab` does, because the mode is a capability and it is worth the same reach from a mouse as from a key. It leads the row because it answers the question the row is about — what this box will do with what is typed into it.
- **The right-hand control is `UPLOAD[+]`**: the word because a bare `[+]` is a riddle, the glyph in the accent because the glyph is the part that is pressed. Its job is unchanged — the platform's own file-selection window.
- **The mode is named once per screen**: with the box up the state row drops its leading mode word and reads `model · variant`; a card (a picker, a menu, a permission prompt, a question that is not being typed into) hides the box, and the state row leads with the mode again. `modeWord()` is the only place the words and the colours live, so the pill and the row cannot disagree.
- **Both buttons report the columns they were drawn in** (`PromptBox.modeButton` / `.uploadButton`), and the caret column is the box's own `textLeft` plus the caret's offset inside the text — so the app no longer re-derives any of the row's geometry, and the off-by-one class of bug the `[+]` hit box kept producing (ADR-016, ADR-019) is gone with it. The pill's width is the mode's own word; nothing outside the renderer can know it.
- **The text starts one gap after the pill**, so a long prompt breaks sooner (a 200-character line is four rows where it was three) — the rows under the first pad the pill out rather than drawing it again, and `UPLOAD[+]` stays on the row being typed on. One behaviour retired: clicking the empty left side of the box used to open the clipboard menu; that cell is the pill now, and the menu is still on the prompt's right-click.
- **The README was brought back in step**: its interface sketch still drew the box with `▌` bars, which ADR-021 had already reversed.

### 0g. The List Cards Are Filled Surfaces, With Headings of Their Own (ADR-022)
- **The picker is no longer a frame.** `/sessions`, `/models`, `/skills` and the prompt-input cards are one filled surface with no border glyphs, as wide as the screen allows (up to 84 columns, was 68) — the fill, not a `┌─┐` outline, is what says where the card is. The settings/connect band was already built that way (ADR-017); now the two cards are the same material, and both are opaque where a blank row used to let the page through.
- **Group headings have a hue of their own** — a new `heading` theme slot, in every palette's own pink/purple family (kicode magenta `#f472b6`), because a heading names the rows under it rather than being one of them, and the accent belongs to the row the keys act on.
- **The row under the cursor is filled, with no cursor glyph** — a fill and a bar beside it say the same thing twice — and the row's text switches to the fill's foreground. The dot for the session in use stays.
- **A card's footer has two ends**: the hint pairs run from the left except the last, which is pinned to the card's right edge. The sessions card now names `ctrl+d delete`, which works on the row under the cursor and leaves the card up with one row fewer.
- **The fade was checked and is unchanged** (ADR-017): the conversation behind a picker or a menu is dropped to the faint style on the page background, and the chrome (tab bar, state row, footer) keeps its colour.

### 0f. The Input Box Is Fill Only, on a Lighter Surface (ADR-021)
- **The box and its state row wear a new theme slot, `input`**, a step off the user-turn fill — lighter on every dark theme (kicode `#1d1e2e` → `#2b2f47`), darker on the light ones — so the typing area reads as the surface in front instead of a shade off the transcript, and it follows whichever theme is in use.
- **No bar down the box's left edge**: the box is fill and its own air, and the state row lost its bar too (the mode word kept its colour, and since ADR-023 it rides in the pill at the box's left edge). The text still starts in the same column, so the caret, badges and every click that places the caret are unchanged.
- **More air**: two rows of the box's fill above the text and two below, where there was one of each — the box is a row taller, the caret sits at row 20 of 24, and the transcript gives up that row.

### 0e. The Prompt Wraps, and the Box Grows With It (ADR-020)
- **The prompt wraps instead of being cut at the edge**: a line past the terminal's width is broken at the last space that fits (mid-word when there is none), so a long path or a wall of one character is readable rather than ending in a `…` — nothing typed is off screen.
- **The box grows with the text, up to six rows**, past which the rows follow the caret — what is being typed stays visible without the box eating the transcript it stands on. The rows under the first keep the first row's text column, and the row's controls (the mode pill and `UPLOAD[+]` since ADR-023) ride only the row being typed on.
- **The caret is measured against the row it wrapped onto**, so it sits where the next character goes; the renderer now reports the box's own rows (`RenderedFrame.prompt`) — including the column the text starts in — so a click places the caret on the row it actually landed on, and the old `attached.length * 10` guess for badges is gone.
- **Caret column off-by-one fixed**: the caret sat one cell left of the insertion point (`margin + 2` where the text starts at `margin + 3`), visible in the empty box too.

### 0c. The Input Box Reads as a Typing Area, and the Todo List Goes Live (ADR-018)
- **The send arrow is gone**: the blue `↑` button was the loudest thing on a quiet row for the one action the keyboard already has (enter). The `[+]` attach button stays, anchored to the right edge (it is `UPLOAD[+]` since ADR-023); its click hit box was re-derived to match, since the drawn glyph and the hit box are computed from the same arithmetic in two files.
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
