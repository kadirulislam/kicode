# KiCode

A bring-your-own-key terminal coding agent. Point it at any OpenAI-compatible
endpoint, give it a key in the environment, and it reads your files and answers
questions about them — with six tools, MCP support, sessions, and compaction
around a streaming agent loop that stays short enough to read in one sitting.

## Install

```sh
npm install -g @kadirulislam/kicode
kicode --version
```

That is the whole install:KiCode has no runtime dependencies and no account, and the `bin` entry resolves to a single bundled file. It is licensed as a commercial/proprietary product — see the [license](#license). To run it without
installing globally, `npx @kadirulislam/kicode "…"` works the same way.

### Connect an endpoint, then set its key

KiCode talks only to endpoints you declare, and it names the environment
variable its key is read from. Nothing ambient counts: an `OPENAI_API_KEY` or
`OPENAI_BASE_URL` sitting in your shell is deliberately **not** enough on its
own, because a first run that silently borrowed one would be talking to a
gateway you never chose, for reasons you cannot see.

Start it with nothing configured and it says so. `/connect` inside the UI offers
the endpoints already known to work:

```sh
kicode
#  › /connect        pick a service, or type your own base URL
```

That writes a `providers` block into `kicode.json`. The key itself never goes in
the file — only the name of the variable to read it from. PowerShell on the left,
bash on the right:

```powershell
$env:OPENAI_API_KEY = "sk-..."
kicode "what does src/config.ts do?"
```

```sh
export OPENAI_API_KEY=sk-...
kicode "what does src/config.ts do?"
```

Or declare it by hand:

```json
{ "providers": { "openai": { "apiKeyEnv": "OPENAI_API_KEY" } } }
```

Declare exactly one provider and it is used without being named. Declare several
and name the one to run on with `"provider": "openai"` (or `--provider`). To try
an endpoint without declaring anything at all, `--base-url` and `--api-key`
configure a single run.

To stop passing the model on every run, drop it in `kicode.json` — see
[Project settings](#project-settings-kicodejson).

### From a checkout (developing)

```sh
npm install
npm run build     # npm blocks install scripts, so build once by hand
npm link          # symlinks this checkout, so rebuilds take effect immediately

kicode --version
```

`npm link` is the right choice while developing — it points at this directory
rather than copying it, so `npm run build` is the only step needed to publish a
change. It drops a `kicode` shim into npm's global prefix (`npm prefix -g`); on
Windows that is usually `%APPDATA%\npm`, which is already on `PATH`, so
`kicode` works from PowerShell, `cmd`, and Git Bash in any directory. To install
a standalone copy instead of a symlink, `npm install -g .`.The published package ships a single **minified** `dist/cli.js` (plus the README, CHANGELOG and license), so there is nothing else to install at runtime and the shipped bundle does not read as the source it was built from.

### Pointing it elsewhere

`baseUrl` on a declared provider accepts any OpenAI-compatible endpoint, and so
does `--base-url` for a single run:

| Provider | Base URL |
| --- | --- |
| OpenAI | `https://api.openai.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Ollama (local) | `http://localhost:11434/v1` |

The model must support tool calling — the whole agent depends on it.

## Usage

```
kicode                     Interactive session
kicode <prompt>            One prompt, then exit
echo "..." | kicode -p     Read the prompt from stdin
kicode --yes <prompt>      Allow file changes and commands without prompting
kicode --continue          Resume the last session for this directory
kicode --session <id>      Resume a specific session (or `latest`)
kicode --models            List the models the endpoint serves, then exit
kicode --init             Write the current settings to ./kicode.json
kicode --theme <name>      Colour theme (/themes lists them; default: opencode)
kicode --no-tui            Use the plain prompt instead of the full-screen UI
kicode --no-mcp <prompt>   Ignore the MCP servers in kicode.json
kicode --help
```

## The interface

In a terminal, `kicode` opens a full-screen UI:

```
   new session  ×   hiif  ×   gi  ×   gfg  ×   +NEW

                        █  █ ███  ███  ██     █  ██
                        █ █   █  █    █  █    █ █  █
                        ██    █  █    █  █  ███ ████
                        █ █   █  █    █  █ █  █ █
                        █  █ ███  ███  ██   ███  ███

                            deepseek-v4-flash:free · v0.1.0
                 /models to choose a model · /help for commands

──────────────────────────────────────────────────────────────────────────

    [BUILD] Ask anything…  "find the TODO in the parser"        UPLOAD [+]


    deepseek-v4-flash:free · default           [ASK]                    [USAGE]
    C:\dev\projects\kicode ·                     ↓ 12 tools · 304.8K (29%)   ⚙
```

The bar across the top is your sessions for this directory, newest first. It is
the **sidebar**, and it is a setting: `auto` — the default — keeps the row for
the transcript while there is only one session and brings it back the moment
there is something to switch to. The last three rows are the prompt, the current
state — the model, the reasoning variant, and the permission level, while the mode
rides in the box's own pill — and the footer: the
directory, what the session has cost, and a `⚙` glyph that opens the settings
panel. The `[USAGE]` chip on the state row opens this session's share of the
same numbers together with the context breakdown (`/context`). `[AGENTS n/m]`
joins it whenever a child has run.
`↓ 12 tools · 304.8K (29%)` is tool calls so far and the estimated size of the
transcript against the window compaction keeps it inside. When the transcript is
taller than the view, a scrollbar marks the right edge.

The transcript is spaced like prose rather than like a log: one blank row
between two entries, one more on either side of your request — which is the real
boundary, since everything above it answered it — and two rows of padding above
and below the text inside a request block, so the block reads as a panel the
request sits in rather than as a line that happens to be tall. The prompt box is
padded at both ends for the same reason. Tool calls keep a thinner gap inside
their shared left rule, because a call and its result are one act rather than
two. Those three numbers are the defaults of `spacing` in `kicode.json` — a
density is a preference, so it is a setting rather than a constant, and changing
it needs no rebuild (see [Project settings](#project-settings-kicodejson)).

The whole transcript then sits in a **column with a gutter down each side**, two
columns wide on a terminal of fifty or more. Nothing runs off the rim: a request
block has an edge to sit on rather than bleeding to the last cell, prose has
somewhere to stop, and the terminal's final column is left free for the
scrollbar. The prompt box is inset to the same column, so the block you type
into lines up with the blocks you read. On a narrower terminal the gutter
closes, because the room is worth more than the edge.

Under each answer there is a **line about that answer**:

```
Build · glm-4.7-flash · 3.9s · 17.7 tok/s
```

The mode it was produced in, the model that produced it, how long the turn took
wall-clock, and how fast it wrote. Only the parts that are known are printed —
`/settings tps off` drops the line, and an endpoint that reports no token counts
gets the time and no rate rather than an invented number. The rate is real: KiCode
asks for the usage block on every streaming request (`stream_options`), because a
streaming response carries no `usage` at all unless the request opts in — and a
gateway that does not know the field is asked again without it, once per process,
rather than failing the turn. Those same counts are what the session's token
budget is spent against.

The box you type into carries two buttons: the **mode pill** on its left edge,
and **`UPLOAD [+]`** on the right. The pill is the session's mode, and it is a
button: `Shift+Tab`, `/mode`, or a click on the pill all switch between `Build`
and `Plan`, and plan mode is drawn in the warning colour because it changes what
the session is allowed to do rather than merely what it is called.
`UPLOAD [+]` opens the platform's own file-selection window, so attaching is a
click rather than a slash command to remember. The state row under the box is
what is in play — the model and the reasoning variant — and it names the mode
too on the few screens where there is no box to put a pill in, such as while a
list or a permission prompt is up. A mode change is announced on that row and
not in the transcript: a line per keypress would bury the conversation it is
meant to accompany.

Each tab carries its own `×`, the way a browser tab does: **click the body of a
tab to switch to it, its `×` to close it**, click `+NEW` for a fresh
one, and `Ctrl+W` closes the tab you are in. Closing a tab hides it — the
transcript stays on disk and `/sessions` reopens it — because a stray click must
never throw work away. Closing the last tab leaves you in a new session, since a
tab bar with nothing in it has nothing to type into.

**A session keeps working when you leave it.** Switching tabs does not wait for a
turn in flight: the session you leave is parked, and its turn finishes there, in
the background, while you use another one. Its answer is saved under its own
session, a message queued behind it runs on its own, and its tab is marked `◐`
so a session still working is visible from the one on screen. An approval a
background turn needs is denied automatically, with a note — there is no screen
to put the card on — and a question it asks is skipped.

The mouse wheel scrolls the
transcript, and the same click works on a row of any panel — see
[Keys](#keys). KiCode asks the terminal for the mouse while it is on screen and
uses the drag itself: **drag across the transcript to select it**, and the text
is copied to the clipboard when the button comes up. The terminal's own bypass
(usually holding `Shift`) is still there as a second way.

### Commands

Type `/` and the palette opens, filtering as you type — `↑` `↓` choose, `Enter`
runs, `Esc` closes. `Ctrl+P` opens the same list from anywhere:

```
/agents    Watch the child agents working
/btw       One-shot answer from the session's context, not added to it <question>
/budget    Show or set the session token budget [tokens]
/cd        Change working directory <directory>
/clear     Clear session
/compact   Compact session
/context   Context window breakdown
/connect   Connect an integration [service]
/continue  Switch session
/copy      Copy session transcript
/debug     View debug info
/diff      Open diff viewer
/editor    Open editor [file]
/exit      Exit the app
/export    Export session transcript
/fork      Fork session
/goal      Autonomous goal execution <objective>
/help      Help
/init      guided AGENTS.md setup
/insert    Push message in between the conversation <message>
/learn     Run the learning pass now, and report what it kept
/mcps      MCP servers
/memory    Show what the brain holds for this project [full]
/mode      Switch between build and plan [build|plan]
/models    Switch model [free]
/new       New session
/paste     Paste the clipboard: text onto the prompt, an image onto the next turn
/pause     Pause model execution or active session
/reload    Reload configuration
/rename    Rename session <name>
/review    review changes [commit|branch|pr], defaults to uncommitted [scope]
/routes    Which endpoints answered, and which ran out
/sessions  Switch session
/settings  Open settings [key] [value]
/skills    List skills, or show one [name]
/stats     Usage statistics
/status    View status
/themes    Switch theme
/timeline  Jump to message [number]
/undo      Undo previous message
/update    How to update KiCode
/usage     Token usage across sessions
/variants  Switch model variant
```

Only commands that actually run here are listed — no aliases, no dead entries.
The rest still work when typed in full: an alias (`/q`, `/open`, `/resume`)
runs the command it stands for, and a name KiCode does not have (`/plugins`,
`/worktrees`…) answers for itself instead of failing silently:

```
[ /plugins is not available in KiCode: Zero runtime dependencies is a design
rule, so there is no plugin loader. Tools live in src/agent/tools/. ]
```

The list is a single source of truth in `src/tui/commands.ts`: the palette,
`/help`, and the dispatcher all read it, so a command cannot appear in one and
be missing from another, and an alias (`/q`, `/project`, `/thinking`) can never
drift away from the command it stands for.

Command | Does
--- | ---
`/new` `/fork` | Start an empty session, or one that keeps the conversation
`/rename` | Name this session; the name is kept on every later save
`/sessions` `/open` | Pick another session for this directory
`/continue` `/resume` | Switch to the most recent other session
`/undo` | Drop the last request and everything it produced
`/clear` | Empty the view without touching the session
`/compact` | Summarise now, rather than when the window fills
`/context` | The context window as spent: system prompt, skills, memory, messages — the same breakdown the `[USAGE]` chip shows
`/usage` | Token usage across sessions, with per-model and daily rollups
`/btw <question>` | One question answered from the transcript, recorded nowhere
`/copy` `/export` | The transcript to the clipboard, or to `./kicode-<id>.md`
`/paste` | The clipboard onto the prompt: text as if typed, an image attached to the next turn
`/cd <dir>` | Change directory; the agent is rebuilt around the new one
`/models [free]` | List what the endpoint serves and switch to one, with `all` / `free` / `paid` tabs; the title carries the count, and a gateway that refuses is named rather than reported as "no models"
`/budget [tokens]` | Where the session stands against its token ceiling, or set one (0 removes it)
`/mode [build\|plan]` | What the session may do; with no argument it opens the picker
`/variants` | Reasoning effort for this session, sent as `reasoning_effort`
`/themes` | The colour schemes, with a live preview as you walk the list — leaving without choosing puts back the one you had
`/routes` | What this machine has learned about each endpoint: which answered, which ran out, and when they come back
`/diff` | The diffs you approved in this session
`/timeline` | Jump to a message; scrolling returns you to the end
`/review [ref]` | Send `git diff` to the model and ask for a review
`/editor` | Hand the prompt to `$EDITOR` (leaves the alternate screen first)
`/init` | Write `./kicode.json` and a starter `AGENTS.md`
`/settings` | The settings panel: a search field, grouped rows, `‹` `›` to change a value. `/settings thinking hide` sets one outright. Its `Shortcuts` group opens the screens a session actually reaches for — Connect/Provider, Models, Sessions, Compact, Skills, Tools, MCP, Subagents
`/connect` | Add an endpoint KiCode can reach from a list of known services, and move the session onto it
`/status` `/stats` `/debug` `/mcps` | What is in play, and what it has cost
`/agents` | Named subagents: add one, edit one, or change what it may do
`/agents running` | The child agents this session spawned: which agent, which task, model, elapsed, and each report in full
`/permission [ask\|edits\|all]` | How much this session may do without asking. No argument steps it one rung
`/reload` | Re-read `kicode.json` without restarting

### Themes

`/themes` lists the palettes and repaints the screen in each one as you move
down the list, so the choice is made by looking rather than by name. Leaving
without choosing puts back the one you had; choosing one writes it into
`~/.kicode/kicode.json`, the same key `/settings` writes. `KICODE_THEME` or
`--theme <name>` still override it for a run, and the same precedence as
everything else applies — flags, then the project file, then the environment.

| Theme | |
| --- | --- |
| `opencode` | the default: violet on near-black |
| `dark` / `light` | the original slate-with-teal, and its light twin |
| `tokyo-night` | deep blue with a soft neon accent |
| `gruvbox` | warm, low-contrast, retro |
| `nord` | cool arctic blues |
| `dracula` | high-saturation purple and pink |
| `catppuccin` / `catppuccin-latte` | soft pastels, dark and light |
| `github-light` | a white page with a blue accent |
| `solarized-dark` / `solarized-light` | the Solarized palettes |
| `mono` | greys only, for a terminal whose colours are spoken for |
| `contrast` | maximum contrast on black, for poor light or a washed-out screen |

Every theme fills the same slots, so a theme is a statement about colour and
never about layout — the block behind your request, the rule down tool output,
the emphasis inside a sentence, and the mode word on the box's pill are all
themeable, and a theme that got one wrong would not be a theme. Each one also
declares whether it is a **dark** or a **light** theme, which is what the Color
mode's word steps through rather than guessing from the name.

### Settings

`/settings` opens a panel over the transcript: a search field, the rows in two
groups, and the value of each on the right. `↑` `↓` move, `‹` `›` change the
value on the highlighted row, `Enter` steps it forward, typing narrows the list,
and `Esc` closes. Every change takes effect at once and is written to
`~/.kicode/kicode.json` — the file that applies to every project on the machine,
because a preference about colours and detail is not a property of one
repository. Precedence is unchanged, so a `theme` or `verbosity` set in a
project's `kicode.json` still wins over the global one.

```
  Settings                                                    esc
  ▌Search

  Appearance
    Theme                                                       nord
    Color mode                                                  dark
    Animations                                                    on

  Session
    Sidebar                                                     auto
    Scrollbar                                                     on
    Thinking                                                    show
    Markdown                                                rendered
    Tool grouping                                               auto
    Verbosity                                                 medium
    Transcript images                                             on
    TPS                                                           on

  Colours for the whole screen. /themes previews each one.
  ‹/› change · enter value · ↑↓ move · esc close
```

None of the rows is decoration — each one changes what KiCode does:

| Row | What it changes |
| --- | --- |
| `Theme` | the palette, with a live preview as you step through |
| `Color mode` | which half of the theme list `Theme` steps through; the theme moves with it, so the two cannot disagree |
| `Animations` | the working spinner and the repaint that advances it while a turn runs |
| `Sidebar` | the session tab bar — `auto` shows it once there is a second session, and gives the row back to the transcript until then |
| `Scrollbar` | the bar down the right edge when the transcript is taller than the view |
| `Thinking` | the model's own reasoning, when the endpoint streams any: a `Thought: 1.1s` heading over the text |
| `Markdown` | answers rendered, or printed exactly as the model typed them |
| `Tool grouping` | whether a tool call and its result stay one run under a single left rule |
| `Verbosity` | how much of a tool's output, and of the reasoning, is printed |
| `Transcript images` | the `[2 images]` marker on a request that carried pictures |
| `TPS` | the line under each answer: `Build · model · 3.9s · 17.7 tok/s` |

That is every setting the panel has. One thing you might expect to find here is
not, on purpose: the **density** of the transcript — the request block's padding
and the gaps between entries — is `spacing` in `kicode.json` instead. The rows
above step through named values, and a density is a number; forcing it into a row
would have meant inventing names for `0`, `1`, `2` and `3` that say less than the
numbers do. See [Project settings](#project-settings-kicodejson).

With an argument the panel is skipped: `/settings thinking hide` sets that one
row, which is what a script or a familiar user wants. A value that is not one of
the row's is refused with a usage line, and the value in effect is left alone.
The same settings can be written by hand — see
[Project settings](#project-settings-kicodejson).

### Keys

| Key | Does |
| --- | --- |
| `Enter` | Send the prompt, or run the highlighted command |
| `Tab` | Switch to the next session for this directory |
| `Shift+Tab` | Switch between build and plan mode — the pill in the prompt box does the same |
| `↑` `↓` | Recall earlier prompts, scroll, or move the palette selection |
| `PgUp` / `PgDn` | Scroll the transcript |
| `←` `→` `Home` `End` | Move the caret |
| `Ctrl+P` | Open the command palette |
| `Ctrl+V` | Paste the clipboard: text onto the prompt line, an image onto the next turn |
| `Alt+V` | The same, for terminals that keep `Ctrl+V` for themselves |
| `Ctrl+W` | Close the current tab |
| `Ctrl+U` | Clear the line up to the caret |
| `Alt+U` | Open the session usage card — the `[USAGE]` chip by keyboard |
| `Ctrl+L` | Redraw |
| `Ctrl+C` | Stop the turn in flight; with nothing running, quit |
| Click | Switch tab, close tab, `+NEW`, or a panel row |
| Drag | Select text in the transcript, copying it on release |
| Wheel | Scroll the transcript |

While a list is open — models, themes, sessions, messages — `↑` `↓` choose,
`1`–`9` jump straight to a row, `Enter` takes it and `Esc` closes it. A number
typed there selects rather than typing into the prompt behind it — but only
while nothing has been typed into the search field. A list with filter tabs
(the model list's `all` / `free` / `paid`) switches them with `Tab` and
`Shift+Tab`, and the search stays typed across the switch.

**Everything on screen is also clickable.** The tab bar responds to a click on
a tab's body and to its `×`; a list, the command palette, the settings panel and
a question all respond to a click on a row. One rule covers all of them: **a
click is a cursor move followed by `Enter`**, which means a click does exactly
what the keyboard would do on that row — including the parts that deliberately
refuse, like a model row that cannot be chosen or a command that cannot run
here. There is no second implementation to drift out of step. The prompt box's
`[BUILD]` pill cycles the mode, `UPLOAD [+]` opens the file picker, `[USAGE]`
opens this session's usage card, and the footer's `⚙` opens settings.

A permission prompt is the one thing that does not answer to a click, and that
is on purpose: a click must never be able to approve a command.

Clicking and selecting coexist because a press is only ever one of them: a
press on a row that *does* something is a click, and a press anywhere else in
the transcript starts a **selection**. Drag to the other end and let go, and
what was covered is copied to the clipboard — read off the frame exactly as it
is drawn, wrapped and all, rather than re-rendered from the model and left to
disagree with the screen. A press with no drag copies nothing, and any key
press lets the highlight go. The chrome below the rule is deliberately not
selectable, so a highlight can never promise text that a copy would not
produce.

### Pasting

The clipboard is read by KiCode itself rather than left to the terminal, because
a terminal's paste can only carry **text** — and half of what people paste into a
coding agent is a screenshot. Two keys reach it:

- `Ctrl+V` reads the system clipboard and puts text on the prompt line; a copied
  image is attached to the next turn instead, because "look at this" is never the
  whole request. `/paste` does the same from the palette.
- `Alt+V` is the same thing, and exists because Windows Terminal, iTerm2 and
  others bind `Ctrl+V` to their *own* paste — KiCode never sees the key, and so
  could never attach the screenshot that was copied. `Alt+V` is nobody's
  shortcut.

Whichever key is used, the text is handed to **whatever has the keyboard** — the
prompt, a picker's search field, a settings panel — so a paste lands where you
are typing rather than in the prompt hidden behind a list.

KiCode also asks the terminal for **bracketed paste** (`?2004`). Without it,
pasting a code snippet delivers it as if it had been typed, so the first newline
is a real `Enter` and the prompt is sent half-way down the block. With it, the
whole paste arrives as one thing that can carry newlines safely; they are
flattened onto the prompt line rather than submitting it.

```
     ┌──────────────────────────────────────────────────────────────────┐
     │ Select model                                                esc  │
     │▌Search                                                           │
     │                                                                  │
     │ Recent                                                           │
     │ ● deepseek-v4-flash:free                                   FREE │
     │   glm-5.3                                                   paid │
     │                                                                  │
     │ Favorites                                                        │
     │   mimo-v2.5:free                                            Free │
     │                                                                  │
     │ tokenharbor.ai                                                   │
     │   Space Bunny Free Default                                  Free │
     │   LongCat 2.5 Preview Free                              paid · 1M │
     │ctrl+a change provider  ctrl+f favorite                           │
     └──────────────────────────────────────────────────────────────────┘
```

The list is a panel of its own, with a search field: typing narrows it, and
backspace widens it again — a list of 63 models is only usable if it can be
found in. The name, the tier and the price are all searched, the current choice
is marked `●`, and the window follows the cursor so the row the keys act on is
always on screen. When the list is longer than the window it says how many rows
it left out; when it is not, the last row names the extra keys it answers to.
Groups — `Recent`, `Favorites`, then one per provider — are separated by a blank
row, so a heading claims the rows below it and not the ones above it too.

`ctrl+f` keeps the highlighted model: the top of the list then carries it under
`Favorites`. Favourites are `{ baseUrl, model }` pairs saved in
`~/.kicode/favorites.json` (`KICODE_HOME` moves the directory), because a name
alone is ambiguous once two endpoints are in play — the same id can exist on two
providers. They are personal shortcuts, so they live beside the sessions rather
than in a project's `kicode.json`. Nothing is thrown away by favouriting: the
list stays open, the search that found the row is still there, and the
`Favorites` group is rebuilt where it was made — so the row moves as you watch
rather than on the next open, and the cursor follows the model it was on.

`ctrl+a` in the model list moves the session to another endpoint. Only *declared*
providers that already have a credential are offered — an endpoint KiCode cannot
authenticate to would only be a 401 after the choice. Declaring one is `/connect`,
and the key comes from the variable it names. The key moves with the endpoint, and
the list is fetched again from the new one.

## Pasting from the clipboard

A terminal can only carry text, and only when you use its own paste key, so
`Ctrl+V` — or `/paste`, for terminals that keep `Ctrl+V` for themselves
(Windows Terminal pastes text there and swallows the key) — reads
the *system* clipboard the same way `/copy` writes to it: PowerShell on Windows,
`pngpaste`/`pbpaste` on macOS, `wl-paste`/`xclip` on Linux. What it finds decides
what happens, which is what `Ctrl+V` means everywhere else:

- **Text** goes onto the prompt line, exactly as if the terminal had pasted it.
  A trailing newline — how most tools end their output — is dropped, and
  multi-line text is joined into the one line the prompt is. Copied files can be
  megabytes, so a paste is cut at 100 000 characters and says so.
- **An image** is attached to the next prompt rather than sent by itself,
  because "look at this" is never the whole request. It goes to the model as a
  `data:` URL beside the words, which is the one inline form every
  OpenAI-compatible endpoint accepts. PNG, JPEG, GIF, BMP and WebP are all
  recognised, since the format is whichever the copying application offered; an
  image over 8 MB is refused.
- **Neither** says the clipboard is empty, rather than looking like a key that
  does nothing.

What the image *was* is kept; the pixels are not. A screenshot is hundreds of
kilobytes of base64, and a session file is read back on every listing, so a
pasted image is written as `[1 image not kept in the session]` — `/export` and a
resumed session show that the picture was there instead of silently losing it.

## Several providers at once

`kicode.json` can declare more than one endpoint, and `/models` then lists every
provider's models in one panel, grouped by provider. Choosing a row chooses the
model *and* the endpoint it belongs to, which is the point: the alternative is
switching provider, forgetting, and sending a model name the endpoint has never
heard of.

```jsonc
{
  "provider": "tokenharbor",
  "providers": {
    "tokenharbor": { "baseUrl": "https://tokenharbor.ai/v1", "apiKeyEnv": "TOKENHARBOR_API_KEY" },
    "local": { "baseUrl": "http://localhost:11434/v1", "models": ["qwen3:8b"] }
  }
}
```

A provider names the environment variable holding its key (`apiKeyEnv`,
defaulting to `<NAME>_API_KEY`); there is still no place in the file for a
secret, and one found there is reported and ignored. A provider with no key is
still listed — it stays in the panel with the reason on its row, because a
provider that is *missing* is the thing hardest to notice. `models` is for an
endpoint that cannot be asked (a small local server), and then no request is
made. `KICODE_PROVIDER` picks the default provider; `provider` in the file wins
over it, and an explicit `baseUrl` or `--base-url` beats both. The panel has
`all` / `free` / `paid` tabs across the top — `Tab` and `Shift+Tab` move between
them without closing the list, so finding something that costs nothing is a
keystroke rather than a scan. `/models free` opens straight on that tab.

### Adding one without editing the file

`/connect` lists the services KiCode has checked and can talk to — OpenCode,
OpenAI, OpenRouter, Groq, Github Copilot, Anthropic, Google, 302.AI, Abacus,
abliteration.ai, AgentRouter, a local Ollama — with a tick on each one whose key
is already in the environment:

```
  Connect an integration                                      esc
  ▌Search

  Popular
    OpenCode Go                              set OPENCODE_API_KEY
  ✔ OpenCode Zen                          key in OPENCODE_API_KEY
    OpenCode Console                        set OPENCODE_API_KEY
  ✔ OpenAI                                  key in OPENAI_API_KEY

  Services
    302.AI                                        set AI302_API_KEY
    Abacus                                       set ABACUS_API_KEY
    Ollama (local)                                 no key needed

  enter connect · ↑↓ move · esc close
```

Choosing one writes its base URL and the *name* of the environment variable its
key lives in into `~/.kicode/kicode.json`, and then moves the session onto that
endpoint — followed by `/models` for that endpoint, because a model name the new
endpoint has never heard of is a 404. If the variable is not set, the endpoint is
still declared and the row says which variable is missing; it does not switch,
because a 401 is not a better answer than a sentence. `/connect groq` does the
same from the command line, with no panel.

A curated list rather than a directory: an entry that guessed at a base URL
would 404 the moment somebody used it, so a service that is not on the list is
declared by hand in `providers` instead. The list is in
`src/providers/services.ts`, and the write path can only produce
`{ baseUrl, apiKeyEnv }` — there is no code that can put a credential in a file.

## When a route runs out

Free routes have quotas, and a free route that is out of quota should not end
the session. `kicode.json` can name backups, and KiCode replays the *same*
request on the next one when a gateway rate-limits or fails:

```jsonc
{
  "model": "deepseek-v4-flash:free",
  "fallbackModels": ["qwen3-coder:free", "glm-5.3:free"],
  "fallback": [{ "provider": "groq", "model": "llama-3.3-70b" }]
}
```

- `fallbackModels` are other models on the endpoint already in use — the
  one-line way to say "try the other free ones". `KICODE_FALLBACK_MODELS` does
the same from the environment.
- `fallback` is a list of `{ provider, model }` (or `{ baseUrl, model }`) for
  routing somewhere else entirely. A declared provider brings its own key.

The chain is tried when a request fails with a quota, a missing model, a flaky
gateway, or no connection at all (HTTP 402, 404, 429, 5xx, or a failed fetch).
A request that got an answer is **never** rerouted — once text or a tool call
has been streamed, switching models would rewrite an answer you are already
reading, so that failure is reported instead. A rejected key is not routed
around either: a wrong key is a configuration mistake to be seen. When a backup
does take over, a note says which route answered and why, because the answer
coming from a different model is not something you would otherwise notice.

Where the chain went is remembered **on this machine**, in
`~/.kicode/routes.json` (moved by `KICODE_HOME`): the last time each route
answered, why it did not, and — when a gateway reported them — the limits left
and when they reset. `/routes` prints it, worst first:

```
[ route health — 3 routes remembered on this machine ]
[ deepseek-v4-flash:free @ tokenharbor.ai — healthy (in use) · last answered 4m 0s ago ]
[ qwen3-coder:free @ tokenharbor.ai — capped · out of quota (0 of 50 requests left), resets in 1h 0m ]
[ old-model @ groq.com — broken · will not answer: the key was refused (HTTP 403) (2d 4h ago) ]
```

`healthy`, `flaky`, `throttled`, `capped` and `broken` are *derived* from that
record rather than stored, so they cannot drift from the facts: three server
errors in a row is broken, results that keep alternating are flaky, an exhausted
quota is capped until its reset, and a rate limit with a `Retry-After` is
throttled for exactly as long as the gateway asked. Entries nobody has touched
for 30 days are dropped when the file is read, and a gateway that reported
nothing is left **unknown** — which is drawn as unknown, never as a number.
Nothing but a redacted one-line reason is written: a failure message is a
sentence the gateway wrote, so anything credential-shaped in it is replaced
before it touches the disk.

## The token budget

Streaming tokens are the whole cost model, so the session can carry a ceiling:
`maxTokens` in `kicode.json`, `KICODE_MAX_TOKENS`, or `--max-tokens <n>` (0, the
default, means no limit). The ceiling is checked *between* requests, never
mid-stream — a turn already under way finishes, because stopping it would leave
you with a half answer you did not ask to stop. When it is reached the turn ends
with a note naming the spend. `/budget` reports where you are; `/budget 500000`
sets a new ceiling, or 0 removes it.

Answers are rendered as they stream: `**bold**`, `` `inline code` ``, headings and
bullets are styled rather than shown as punctuation. Tool calls appear as
`→ read(...)` with a one-line result under them — what you approve is in the
prompt itself.

Six things worth knowing:

- **The home screen tells you what is in play** — the model, the version, any
  MCP servers, and which `kicode.json` files were read. "Why is it using that
  model" should never require a second command.
- **The UI is only used on a real terminal.** Piped input, `-p`, and any
  non-TTY output keep the plain prompt, so scripts are unaffected. `--no-tui`
  forces the plain prompt in a terminal too.
- **Slash commands are the full-screen UI's.** A pipe, `-p`, or `--no-tui` has no
  palette, so the plain prompt answers a known command name with that instead of
  forwarding `/models` to the model as prose. `/q` works as well as `/exit`.
- **Permissions are answered in the UI.** A gated tool replaces the prompt with
  the request, the diff and `y` / `a` / `n`. `Esc` counts as "no" — closing a
  permission request never means yes — and `Ctrl+C` refuses it *and* stops the
  turn; the footer names both, since neither key is otherwise written down. The
  request keeps its title, its `allow?`
  row and the footer at every window size, and a preview too long to fit ends in
  `… N more lines` instead of being cut quietly: the body of the request is what
  gives way, never the row that says how to answer it.
- **`kicode --tui-preview` draws one frame and exits.** It works over a pipe, so
  `COLUMNS=80 LINES=24 kicode --tui-preview` shows exactly what the UI would
  render at that size; `--continue --tui-preview` renders a real transcript. Both
  are there for bug reports — the layout code is pure, so a frame can be
  reproduced without a terminal.
- **`AGENTS.md` is read into the system prompt**, so a project can tell the
  model how it is built and what it expects. `/init` writes a starter one if the
  directory has none. It is read at startup and again whenever `/cd` moves the
  agent, so each directory gets its own instructions.
- **The environment is named in the system prompt**, whichever prompt that is:
  platform, shell, and what that shell has. `AGENTS.md` adds to that picture
  rather than replacing it, so a project cannot accidentally leave the model
  guessing at which shell its commands run through.

Text KiCode did not write — model output, tool results, file contents — is
sanitised on the way to the screen (`sanitiseText`, applied by `wrapSpans` and
`truncateSpans`): no escape sequence can move the cursor, and a tab counts as
the four cells it takes on screen rather than the one it is declared as. Both
would overrun a row, and an overrun row wraps, which scrolls the entire frame up
by a line. Doing it at the writer rather than at each source means one guarantee
instead of one per feature.

The UI is hand-rolled from escape codes in `src/tui/`. That is a deliberate
constraint: the layout is a pure function of state and terminal size, which is
what makes it testable at all — 247 tests cover `src/tui/`, and most of them
render a frame at a fixed size and assert on the result.

## Seeing what the endpoint offers

A 404 from `/chat/completions` usually means the model name does not exist at
that gateway, so KiCode can ask the endpoint what it actually serves:

```
$ kicode --models
   MODEL                     TIER       CTX  TOOLS  COST
   deepseek-v4-flash:free    low         1M  yes    FREE
   deepseek-v4.1-flash:free  low         1M  yes    FREE
   claude-opus-5             high        1M  yes    paid
   glm-5.3                   frontier  200k  yes    paid
   …

63 models · 5 free · current: gpt-4o-mini (not offered here)
FREE rows are not billed.
```

The table is driven entirely by the endpoint's `GET /models` response: free
first, then alphabetical, with the current model marked `*`. `TOOLS` reads `NO`
for a model that cannot call tools, which is a hard blocker for an agent rather
than a preference, and the summary repeats the count. Endpoints that return bare
ids (no tier or context) still work — the missing columns show `—`.

## Try it without an API key

`scripts/mock-provider.mjs` is a zero-dependency mock of an OpenAI-compatible
endpoint. It asks for the `read` tool on the first turn and answers in prose on
the second, so it exercises the whole loop offline:

```sh
npm run mock &                              # http://localhost:8787/v1

npm run build
node dist/cli.js "read the package file"    # needs "mock": true — see below
```

The `mock` shorthand is the point: instead of declaring a provider and an
endpoint before every run, put this in the project's `kicode.json` and a plain
`kicode` talks to the local mock — with the placeholder key `local`, so a real
key is never sent to localhost.

```json
{ "mock": true, "model": "mock-model" }
```

It listens on `8787`; set `MOCK_PORT` to move it, and Ctrl+C to stop it. If
port 8787 is already taken the mock says so — that usually means an earlier one
is still running. On Windows a backgrounded process ignores a plain `kill` from
Git Bash, so use `MSYS_NO_PATHCONV=1 taskkill /F /PID <pid>`.

`MOCK_TOOL` picks which tool it asks for (`read`, `write`, `edit`, `glob`,
`grep`, `bash`, `mcp`, `delegate`), and `MOCK_TOOL=none` makes it answer with
prose only — useful for exercising compaction.

`MOCK_TOOL=delegate` drives the whole subagent path: the parent delegates a batch
and each child answers with its own report, so you can watch a delegation
end-to-end with no key. `MOCK_LOG=1` prints each request's role and the tool names
it was offered — which is the only way to see from outside the process that a
child really was handed a read-only toolset:

```
[mock] parent · 2 messages · tools: read, glob, grep, write, edit, bash, remember, recall, plan, todo, goal, delegate
[mock] child  · 2 messages · tools: read, glob, grep, recall
```

## Tools

| Tool | Approval | What it does |
| --- | --- | --- |
| `read` | — | Numbered, paged file reads; refuses binary files |
| `glob` | — | Find files by pattern (`**/*.ts`); skips `node_modules`, `.git`, build output |
| `grep` | — | Search contents with a regex or literal; `glob` argument narrows the files |
| `write` | **yes** | Create or replace a file, diff shown first |
| `edit` | **yes** | Replace an exact string; refuses an ambiguous match |
| `bash` | **yes** | Run a shell command in the working directory |
| `ask` | — | Put a choice to you as labelled options; only offered when somebody can answer |
| `github` | — | Read the GitHub REST API through the authenticated `gh` CLI; reads only |
| `delegate` | — | Hand a task, or a batch of them, to child agents; off with `delegation.enabled: false` |

`glob` and `grep` are pure Node — no `ripgrep` binary to install. Both match
patterns against paths with forward slashes, so patterns behave the same on
Windows.

### Calls in one turn overlap; the transcript does not

When a model asks for several tools at once, the ones that cannot change anything
run **at the same time**. Measured on a turn of 18 reads that each took 40ms:
**853ms before, 44ms after** — and in both cases the transcript reads them back in
the order the model asked.

That last part is the point. The waits are removed; the order is not, because
every tool result has to land in the transcript beside the call it answers or the
next request is malformed and a saved session will not replay.

Two rules keep the overlap honest:

- **Approvals still happen one at a time, before anything runs.** You are asked
  about every gated call in the batch, then they run — so a batch of writes shows
  you every diff before anything lands.
- **A tool that could change something finishes before the next one begins.** Only
  `read`, `glob`, `grep` and `recall` are marked as safe to overlap; everything
  else runs on its own. Two writes to the same file in one turn are a race
  otherwise, and the model cannot have ordered them on a result it had not seen.

Which shell `bash` runs through is a decision, not an accident. On Windows it is
the Git Bash from Git for Windows when there is one, because the commands a
model reaches for first are POSIX ones; without one it is `cmd.exe`. Either way
the model is **told**: the system prompt ends with an `Environment` section
naming the platform, the shell and the commands that shell has and has not — so
`ls -la` is not the opening move on a machine that would answer `'ls' is not
recognized as an internal or external command`. `KICODE_SHELL` overrides the
choice, and `KICODE_SHELL=cmd.exe` keeps the Windows commands for someone who
wants them. WSL's `bash.exe` is never picked: its paths are Linux paths.

### GitHub, without a shell

`github` reads the GitHub REST API through the `gh` CLI using your own
credentials — the signed-in user, repositories, org memberships, issues, pull
requests, workflow runs, search. It needs `gh` installed and signed in
(`gh auth login`); without it the tool says so and tells the model to work from
the repository files instead.

```
github({ path: "/user/repos", jq: ".[] | {name, private, pushed_at}", paginate: true })
```

**There is no shell anywhere in it.** `gh` is executed directly with an argument
vector, so there is no command line for a second command to hide in:
`path: "/user/repos; rm -rf ~"` is not a shell, it is a request for a repository
that does not exist. That is safety by construction rather than by inspection —
and it is the reason this is a tool instead of a restricted `bash`. A read-only
verdict about a *shell command* is a denylist trying to parse a language it does
not own, which is a much weaker guarantee for a child with nobody watching than
it is for you, with a diff in front of you.

Consequences worth knowing:

- **The leading `/` is required**, and that is not a quirk. Git Bash rewrites an
  argument beginning with `/` into a Windows path, so `gh api /user/repos` under
  Git Bash asks for `C:\Program Files\Git\user\repos`. That rewrite belongs to a
  shell reading its arguments; there is no shell here, so the canonical form is
  simply correct.
- **No full URLs, and no `@`.** The token goes to whatever host a URL names, and
  `gh api @file` would read a local file and send its contents. Both are refused
  with the reason, before anything runs.
- **`$ENV` is refused in `jq`.** It is the one thing a jq program can reach that
  the tool otherwise cannot — `gh` holds your token in the process environment,
  and `read` cannot see it, so allowing it would be a way *around* a child's
  isolation.
- **`paginate` pairs with `--slurp` only when there is no filter**, because `gh`
  rejects the two together. With a `jq` filter, `gh` merges the pages itself.
- **Output over 256KB is truncated, with a note.** Add a `jq` filter — it is much
  cheaper than reading the whole payload, and on a large account it is the
  difference between an answer and a cut-off one.

It reads only. There is no way to write, comment or merge through it, at either
permission level.

## Subagents

Some questions are broad: *where is retry handled*, *audit every call site of X*.
Answering one in the main session means the main session reads forty files, and
those forty files sit in its context forever afterwards. KiCode can hand the
reading to child agents instead.

A **child** is an ordinary agent with three differences, and none of them is a
setting you can argue with:

- **A fresh context.** It knows nothing of your conversation. Everything it needs
  — paths, the error text, the constraint that matters — travels in the task, so
  a delegation of *"the bug we were looking at"* is a delegation of nothing.
- **A read-only toolset.** `read`, `glob`, `grep`, `recall`. No `write`, no
  `edit`, no `bash`, no `remember`, and no `delegate` of its own. It holds nothing
  to be talked into using, and there is no second level to bound.
- **No approval channel and no question channel.** There is nobody to ask, so
  `ask` is not offered either.

Only a bounded report comes back, and that report is what the main agent reads.
This is the point of the whole arrangement: the tokens go where nobody has to
read them, and the parent's context stays small.

A batch runs in parallel and returns in the order you asked:

```jsonc
// kicode.json
{
  "delegation": {
    "model": "gemini-3.8-flash",   // empty = the parent's own model
    "maxConcurrent": 4,            // children at once within one call
    "maxPerTurn": 8,               // children one turn may spawn, in total
    "maxIterations": 60,           // requests one child may make
    "staleMs": 450000,             // idle before a child counts as wedged
    "staleToolMs": 1200000         // …while it is inside a tool
  }
}
```

`model` is empty by default, so a fresh install spends no second model's money
until someone names a cheaper one — the useful shape is a strong model deciding
what to do and cheap models doing it. `KICODE_DELEGATION=off`, or
`"enabled": false`, removes the tool entirely rather than registering something
the model can see and cannot use.

### Named subagents

Every child getting the same instructions is the right default and the wrong
ceiling. **A subagent is a child with a name and a job.** `/agents` lists what
you have defined and opens a form to add one:

```
  New subagent                                                    [×]

    Name                          cody-git▌
    For                           GitHub and git work
    How it works                  Review branches, commits and PRs.
    Model                         (empty)
    May edit files                [no] / yes
        It can write and edit. There is no undo for a confused child.
    GitHub access                 [no] / yes
        Off. Without this it cannot answer anything about GitHub that the
        files on disk do not already say.
    Where                         [all projects] / this project
    ✔ Save

  enter next · [×] done
```

**`enter` is the key.** It ends the field, keeps what you typed, and steps to the
next one already open for typing — so filling the form is *type, enter, type*.
`↑↓` move between fields when you are outside one, `‹›` or space change a
toggle, and `esc` steps out of a field and then closes. Inside `How it works`,
**shift+enter** is a line break; every other field is one line. Every row is
clickable, and a click takes the same road as the key.

You can also just start typing: the field under the cursor takes what you write
and the row shows it as you go, caret and all.

Four things worth knowing:

- **The name and the one-line description are what the model reads.** They go
  into the system prompt *and* into the `delegate` tool's own description, so a
  subagent you define is one the model can actually choose — and is told when to
  reach for. A task can name its own agent, so one batch can send one task to
  `cody-git` and another to `cody-frontend`.

  Write the description as the *trigger*, not the summary. `GitHub and git work`
  tells the model what the agent is; `anything about GitHub, PRs or branches`
  tells it when to reach. That is the difference between a subagent that gets
  used and one that never does.
- **Read-only is the default; edit is a per-agent choice.** Read and edit are
  the file-shaped permissions. **`bash` is never grantable** — a shell is
  arbitrary code and a child has no approval channel to ask about it, so a
  grantable `bash` would mean a model you delegated to can run anything,
  unsupervised, four at a time. Unlike a write, there is no diff to show you
  first.
- **GitHub access is a separate, per-agent switch**, off unless granted. The
  `github` tool speaks with *your* token, so `/user/repos` answers with your
  private repositories — a child with it can read things `read` cannot reach,
  because a token is not a file. Separate from the edit permission on purpose:
  that one is about changing things, this one is about somebody else's server.
  A granted agent is listed in the system prompt as able to read the API, so the
  model routes GitHub questions to it instead of doing the work itself.
- **Two files, one format.** `~/.kicode/agents.json` for everywhere,
  `<project>/.kicode/agents.json` for one project. The project's overrides by
  name, and replaces rather than merges — so a repo can ship a `cody-frontend`
  and can also *narrow* a global agent's permissions. Deliberately not a block
  in `kicode.json`: that file is committed, so a form editing it would be
  rewriting a tracked file behind your back.
- **An agent you did not define is refused, by name**, with the real ones listed.
  Falling back to a general-purpose child would be a substitution the model never
  asked for and would not know about.

#### Splitting the work, and why it cannot be made reliable

The mechanism is there — a `tasks` batch runs its children in parallel — but a
model has to *decide* to split. Nothing in the loop can decide that "audit the
workspace" is four tasks rather than one, because that judgement needs the
conversation. So this part is **prompt work**, and it is worth being straight
about that: it has a hit rate, not a guarantee.

What it does:

- **`delegate` leads with the batch form**, with a worked example — *"audit every
  repo… then review the open PRs"* is **two tasks in one call**, not two calls and
  not one task listing both. Each task in the array is described too, because an
  undescribed item gets a one-word goal and a one-word report.
- **A `Delegation:` section in the system prompt**, present only when the
  `delegate` tool is registered — a session without subagents is not charged for a
  paragraph about them on every request.
- **It chains onto a rule the model already follows.** The base prompt says
  *"track the steps of multi-step work with the todo tool"*, and the observed
  failure was a session tracking four steps and then doing all four itself. So the
  new line picks up exactly there: *"when your tracked steps are independent of
  each other, hand each one to a subagent."*
- **It gives a reason rather than an order.** Handing over the reading is cheaper —
  a report comes back, the forty files behind it do not, and they would otherwise
  sit in your context for the rest of the session.
- **It says what not to delegate**: not a decision, not a single lookup, not
  anything depending on what the user said earlier. The failure mode of "delegate
  more" is delegating a lookup, which costs a child and saves nothing.

`/agents running` is the live roster — the children working right now, with each
report in full. Each row leads with **which agent took the task**, because that is
the question the panel exists to answer:

```
  ◐ cody-git: audit the retry paths · gemini-3.8-flash · 7 tools · 12s
    ✓ general: where is X handled · gemini-3.8-flash · 3 tools · 5s
```

`/agents` opens the whole roster; choosing a row prints that child's report in
full. The transcript keeps one row per delegation — it opens as `delegating…`,
counts `delegating 1 of 2` while the batch runs, and settles to what reported and
what did not, in place.

#### A task is not finished until the child says so

Two things make "the subagent's job is to complete the task" more than a hope.

**The child states whether it finished.** Every child's prompt ends with a
contract: say what you did, say what you could not do, and do not claim more than
you did. A partial result honestly labelled is useful; one dressed up as finished
sends the reader off on the wrong track. The runner does **not** try to parse that
for a boolean — parsing a model for "did you finish?" breaks on wording and fails
silently, which is worse than not checking at all. The parent reads it, because the
parent is the only party that knows the goal.

**An unfinished task is tried again, once.** A child that stalls, runs out of
turns, or comes back with nothing is retried carrying what the first attempt
managed to say — so the second attempt *resumes* rather than restarting and doing
the work twice. A crash is not retried: a bad argument will not fix itself, and
trying again spends the delay to learn nothing.

What the parent gets back is explicit either way:

```
TASK 1/2 [cody-git]: audit every repo (tried 2x)
Found it: 3 repos have unpushed branches; 1 has a stash.
(4 requests, 812 tokens)

TASK 2/2: find why CI is red (tried 2x)
— UNFINISHED, stalled: it ran out of turns
```

A retry is the **same task**, so it does not spend `maxPerTurn` again — the budget
counts tasks, and re-running one is not a new one. It does cost tokens, which is
why it is a setting: `"delegation": { "retryUnfinished": 0 }` turns it off.

It is also one roster row, not two. A retry marked its own row, and the
`[AGENTS n/m]` chip read `[0/2]` for a single unfinished task — a count of work
that was never delegated. The row now records `tried 2x` instead.

#### A folder per agent, for its skills

A one-line description says what an agent *is*. It does not say whether to send it
a pull request or a red build — and that judgement is the whole reason you made
the agent. So each agent can have a folder beside its file:

```
  ~/.kicode/agents/cody-git/
      SKILL.md            the agent itself: what it is for, how it works
      pr-review.md        one skill
      ci-triage.md        another
      repo-audit.md
```

`SKILL.md` is the one fixed name: its body becomes the agent's standing brief, in
front of every task it is given. **Every other `.md` is a skill** the agent can be
asked for — frontmatter optional, and the filename is the name when it is absent.

Those skills change how the agent is *chosen*, which is the part that matters:

- The **roster in the system prompt** lists each agent's skills by name and
  description. A model reading `cody-git — GitHub work` has one sentence to judge
  against; one reading `skills: pr-review (review a diff), ci-triage (find the
  first real error), repo-audit (every repo's sync state)` has something to match.
- The **child is told the paths**, and told to read the one that covers the task
  rather than work from memory of what its folder said. A child told a skill exists
  but not where would spend turns grepping for it — the very turns delegation exists
  to save.
- Only the paths go in the prompt, never the bodies. A folder of procedures is a lot
  of text to spend on every task, and which one the task needs is not knowable
  before the task is read.

```markdown
---
name: pr-review
description: Review a pull request diff for correctness, security and missed cases
---

# Reviewing a pull request

Read the diff first, then read enough of the surrounding files to judge it…
```

The folder follows the same two scopes as the file: `<project>/.kicode/agents/`
overrides `~/.kicode/agents/`, so a repo can take an agent away from something it
should not do here. Overriding the *agent* — or narrowing its permissions — is not
a request to strip the skills it already had.

#### When a turn is stopped mid-batch

A stop is the ordinary end of a delegation: ctrl+c, a dropped connection, a closed
window. Some reports came back; the rest never will, and from the next turn's side
the parent sees only what arrived and re-plans from there — so the work already
done gets done again.

So the next turn is told what is still open, once, by agent and goal:

```
  [delegation] The previous turn was stopped with this work still running:
  - cody-git: audit the deploy pipeline
  Those produced no report. Do not redo work you already have a report for —
  check what came back first, then re-delegate only what is genuinely missing.
```

Offered exactly once — a list that stayed would have the model re-delegate work it
has already finished, which is the failure this exists to prevent. A child that
*failed* on its own is left alone: it was already reported in the tool result, so
re-offering it asks for a retry that has already been offered once.

#### Watching it without leaving the chat

While children run, a dock above the prompt says who is working on what:

```
  ◐ audit the retry paths · gemini-3.8-flash · 7 tools · 12s
    ✓ where is X handled · gemini-3.8-flash · 3 tools · 5s
    +2 more · /agents for the roster
```

And on the state row below the chat, an `[AGENTS n/m]` chip — **done** against
total, so what is left is legible at a glance: `[1/1]` when a task has settled,
`[1/2]` when another is still owed. Only a *completed* child counts as done; a
failed or interrupted one is work that still has to happen. Click it and you are
in the same roster `/agents running` opens; one definition, so the two cannot
disagree.

#### What a child can and cannot do

No child can run a command. That is not a detail the model can be expected to
know, so the roster states it — and states what to do instead:

```
- cody-git — Anything about GitHub or git — PRs, issues, branches, CI, releases
    can: read files, search them, and edit files. cannot: run commands.
    skills: ci-triage (find the first real error in a red build); pr-review (…)
```

The rule that follows is written into the prompt: **if a task needs `gh`, or
`git status`, or a build, then either the task is not file-reading work, or you
run the command yourself and hand the child the output.** Auditing a GitHub
account is the worked example — one `gh` call by an agent that can make it, and
the reading handed off.

A child handed a task it structurally cannot do used to come back with nothing at
all, which left the parent with no result and no idea why. It now reports, in
words, that it ran and produced no report — and names the likely reason. Silence
is the one answer a parent cannot act on.

Three things worth knowing:

- **A child is not given a clock.** There is no wall-clock timeout, because a cap
  kills legitimate long work — a deep review needs minutes and keeps making
  progress throughout. Staleness measures *silence*: after `staleMs` with no sign
  of life the child is cut loose, and `staleToolMs` is the longer version for
  while it is inside a tool, where a long grep or a fetch is also silent. It is
  cut loose rather than waited on, so one wedged child cannot hold your turn open.
- **A cap is refused, not applied.** Asking for six tasks with two left in the
  turn's budget is an error naming both numbers, not a batch quietly cut to two.
  Four tasks that silently became two are four the model believes are running.
- **Nothing fails quietly.** A child that dies is a line of its own in the
  report, naming the reason, and the rest of the batch still reports. A child that
  ran out of turns is reported as stalled rather than complete, so a truncated
  finding is never read as a whole one.

## Sessions

Conversations are saved as JSON under `~/.kicode/sessions` (override with
`KICODE_HOME`) and can be resumed:

```sh
kicode               # prints its session id at startup
kicode --continue    # the most recent session for this directory
kicode --session 2026-09-30T00-41-02-118Z-a1b2c3
```

Only the transcript is stored — never the API key — but it does contain file
contents and paths, which is why it lives in your home directory rather than in
the project. Writes go to a temp file and are renamed into place, so a crash
mid-write cannot leave a session half-parsed. The store keeps the newest 50.

Scripted one-shot runs (`kicode -p`, or a bare inline prompt) are **not**
recorded, so a loop over `kicode -p` cannot evict your real sessions. Passing
`--continue` or `--session` opts back in.

### What a session keeps

A session owns its own **model and endpoint, working directory, mode and
reasoning variant**. `/models`, `/cd`, `Shift+Tab` and `/variants` change the
conversation you are in, not the program: `/cd` in one tab leaves another where
it was, and switching back restores what that conversation was using.

All five are written to the session file, so `--continue` and `--session` reopen
the conversation on the settings it was saved with rather than on whatever the
config says now — the mode included, so a session left in Plan comes back in
Plan (run `/mode build` before you leave if you would rather it did not). A
brand-new session starts from what is configured.

The system prompt is not saved with the transcript — it is code, not
conversation — so upgrading KiCode cannot resurrect a stale prompt.

## File changes need approval

`read` runs whenever the model asks. `write` and `edit` are marked
`requiresApproval`, so they are gated:

- **In a terminal,** KiCode shows a diff and asks `Allow? [y]es / [n]o / [a]lways`.
  `always` remembers the tool for the rest of the session.
- **Piped or one-shot input has no way to answer,** so changes are refused
  unless you pass `--yes`, which approves the session up front.
- **A refusal is not a crash.** The model is told permission was denied and can
  respond or try a different approach.

The diff is computed locally (`src/agent/tools/diff.ts`, an LCS line diff) and
is shown *before* anything touches disk — `preview()` and `run()` share the same
plan, so what you approve is what gets written.

### The permission ladder

Answering `always` to one `bash` command and never to an `edit` is a perfectly
reasonable position, and a single on/off switch cannot express it. So the chip on
the state row below the chat is three rungs, and it is always in view:

| Chip | Means |
| --- | --- |
| `[ASK]` | ask before anything that changes files or runs a command — **the default on every run** |
| `[EDITS]` | `write` and `edit` without asking; still ask before running a command |
| `[ALL]` | run anything without asking — no diff, no prompt, no undo |

The middle rung is the point. An edit shows a diff and can be read before it lands;
a command runs arbitrary code with no preview at all. `[ALL]` is drawn in the error
colour on purpose — at that rung there is no prompt and nothing to read.

**Click it to step one rung** (ask → edits → all → ask), or set one outright with
`/permission ask|edits|all`. Either way it says where it landed, because the next
rung stops asking and a control that silently changed what was allowed would be the
one action in this UI you could not take back. The mode lives in the session, not in
a file: trust is something a session is given, not something it inherits.

The ladder decides on the *tool*, never on its arguments. "Does this rung trust this
kind of tool" is a question you can answer from the chip; "does this command look
safe" is not. A caller that wants per-call judgement has `allow` rules in
`kicode.json` for that, and they are OR-ed with the rung rather than replaced by it.

## Stopping a turn

`Ctrl+C` stops the turn in flight rather than the window. The stream ends where
it is: what the model had already written stays on screen and in the transcript,
the tools that had already run stay in the transcript too — they happened — and
the session is saved. A note says the turn was cancelled, so a short answer is
never mistaken for a finished one. With nothing running the same key quits,
which is what it means everywhere else, and so does a second press once the turn
has stopped.

The half-written reply is kept as the model's own message, verbatim. That is
what makes "continue" work: the next turn is built from the transcript, so the
model reads what it had already said and picks up from there, instead of
answering as if it had never written a word.

A `bash` command that is still running is killed rather than waited out: the
turn's signal reaches the tool, the child dies with it, and the stopped command
goes back to the model as exactly that. Without that, `Ctrl+C` would only
end the next request early — a hung command would keep the turn alive until its
timeout.

A prompt on screen *is* that turn waiting for an answer, so `Ctrl+C` winds it up
too: the permission prompt is refused — closing one must never mean yes — and a
question panel is dismissed, which the model is told about rather than left
waiting on. Each turn carries its own abort signal, folded with any the session
was built with, so stopping one turn leaves the session ready for the next.

A pipe, `-p`, or `--no-tui` session keeps the terminal's own `Ctrl+C`, which
exits: there is no turn controller in the plain prompt.

Not every stop is yours. A turn ends when the model *answers* — it asked for
tools, or it said something and was allowed to finish. Two kinds of reply are
not answers, and both used to end the turn in silence:

- **A reply the endpoint cut off.** KiCode sends no `max_tokens`, so the
  gateway's own default is the output cap — often 4 096 tokens — and a long
  answer or a long list of tool calls runs into it. `finish_reason: "length"`
  says so, and the words that did arrive are kept: the next request continues
  the half-finished thought rather than starting the answer again.
- **A reply with nothing in it.** No words and no tool call is not an answer to
  anything, so the same question goes out again — unchanged, because an empty
  assistant message is a turn the model never really made.

Both are asked again up to three times in a row, and any turn that actually ran
a tool gets the allowance back, since progress is the thing that bound protects.
Each attempt carries a dim note — `the reply was cut off — asking it to carry
on`, `the model answered with nothing — asking again` — so what you are watching
is the endpoint's cap or a hiccup, not the model deciding it was done.

One request budget bounds the whole thing: 40 model turns per request of yours
(the old 12 was reached by ordinary work — look, read, edit, verify — before
anything had gone wrong). A turn that does run out says so — `turn budget
reached — send anything to carry on` — instead of the transcript just stopping.

## Build and plan mode

`Shift+Tab` switches the session between two modes, shown on the pill at the
left edge of the prompt box. `/mode` does the same from a command — with no
argument it opens the picker, and `/mode plan` names one outright — and the pill
is a button, so a click switches the mode as well:

- **Build** — the ordinary mode. Changes and commands are gated as above.
- **Plan** — read-only. The agent investigates, then tells you what it would do.
  Anything that changes a file or runs something is refused.

```
    [PLAN] Ask anything…                                       UPLOAD[+]
    deepseek-v4-flash:free · default
```

Plan mode is enforced in the agent, not drawn on it: a tool marked
`requiresApproval` is refused outright, and the refusal is a message the model
can read. There is no prompt to answer — a dialog you are expected to say no to
every time is worse than a refusal, and it would put the decision back on you
for each tool call rather than once with `Shift+Tab`. Switching modes rebuilds
the agent, the same way `/models` does, and the system prompt carries a line
saying the session is read-only so the model does not spend a turn discovering
it.

**A read-only command is not refused.** A gated tool may declare which of its
invocations only read, and those run in plan mode — without a prompt, since
asking about `git status` would be noise. `bash` decides with a deliberately
conservative classifier: redirection, chaining and substitution are out (`>`,
`<`, `;`, `&`, backticks, `$(`, newlines), a pipeline is allowed only when
*every* stage is itself a command that only reads (`ls -la | head -20` changes
nothing, and refusing it was the most common false negative), `find` loses its
action flags (`-exec`, `-delete`), `git` must name a reporting subcommand
(`status`, `diff`, `log`, `show`, `blame`, `rev-parse`, `ls-files`, `ls-tree`,
`describe`, `shortlog`, `whatchanged`, `reflog`), and anything not on the list —
`node -e`, `npm test`, `tsc`, `sort` — is refused. A classifier that guesses
wrong is worse than one that refuses, so the list is short on purpose. A tool
that says nothing is never exempt.

When a call is refused anyway, the message **names the reason**: which stage of
the pipeline was not recognised, which flag, which `git` subcommand — instead of
only that it "would change something". A refusal the model can read is one it
can act on rather than repeat.

The mode belongs to the session and is saved with it, so a resumed conversation
comes back in the mode it was using. A fresh session starts at `Build`; run
`/mode build` before you leave if you would rather a Plan session did not resume
read-only.

## The model can ask you

Some decisions are not in the code — which of two approaches you want, what to
call something, how far to take a refactor. That is what the `ask` tool is for:
it turns the fork into a question with concrete options, rather than a guess or
a paragraph of prose the model then waits on.

```
  Questions

  Base stack  Layout scope  Typography  Content  Submit

  The reference is clean sans-serif, not monospace. Which way?

  1. Sans-serif (Recommended) ✓
     Clean sans-serif throughout, like the reference. Correct for long-form
     reading, which is the point of this layout.
  2. Keep monospace
     Keep IBM Plex Mono from ki-code-v1.0. Distinctive and consistent with
     the other project, but harder to read in body-length article text.
  3. Sans body, mono for UI meta
     Sans for article titles and body, monospace for the chrome and metadata.
  4. Type your own answer

 tab next  ↑↓ select  enter confirm  esc dismiss
```

- **The questions are the tab strip**, with the current one in bold and a
  `Submit` marker at the end showing how much is left. Answering one moves to the
  next by itself, and the answers are sent together as soon as the last one has
  one — there is no submit key to hunt for.
- **`1`–`9` pick an option outright**; `↑` `↓` move, `Enter` confirms, `Tab`
  revisits an earlier question. Coming back to an answered question puts the
  cursor on the answer it holds.
- **You are never stuck inside the model's options.** `Type your own answer` is
  the UI's own last row, not the model's, and it opens an ordinary input line.
- **`Esc` dismisses, and the model is told so.** Unanswered questions come back
  as dismissed rather than blank — silence would read as agreement with whatever
  the model proposed.
- **With nobody to answer, the tool is not registered at all.** A piped run has
  no question channel, so the model is never offered one it cannot use; it is
  told to pick a default and say what it assumed. `--no-tui` keeps the channel
  and falls back to a numbered prompt.
- **Asking is not a mutation**, so it is not behind the approval gate, and
  `--yes` does not answer questions for you.

## MCP servers

KiCode can use tools from [MCP](https://modelcontextprotocol.io) servers.
Declare them in `kicode.json` — in the working directory, or in `~/.kicode/` for
every project. The shape matches OpenCode's `mcp` block:

```jsonc
{
  "mcp": {
    "docs": {
      "type": "local",
      "command": ["npx", "-y", "some-mcp-server"],
      "environment": { "API_TOKEN": "…" }
    },
    "remote": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}
```

Both transports work: **stdio** (`local`, newline-delimited JSON-RPC over a
spawned child) and **Streamable HTTP** (`remote`, answering with either a JSON
body or an SSE stream, and echoing `mcp-session-id` when the server issues one).
The negotiated protocol revision is `2025-06-18`. The project config wins over
the global one per server name; `"enabled": false` skips a server.

Their tools appear alongside the built-ins, namespaced `server_tool`:

```
> list the typescript files
→ glob({"pattern":"**/*.ts"})
→ docs_search({"q":"…"})
```

Three details worth knowing:

- **MCP tools are gated by default.** A server can shell out, reach the network,
  or write files, so every call goes through the approval prompt. Set
  `"autoApprove": true` on a server you trust.
- **A broken server never blocks startup.** It is reported and skipped, with the
  last lines of its stderr in the warning — that is usually the actual reason.
  `--no-mcp` skips them entirely.
- **Names are forced into the API's alphabet.** `server.tool` and `server/tool`
  are illegal function names, so they become `server_tool`, truncated to 64
  characters and de-duplicated so two servers cannot overwrite each other.

## Long sessions

A session that outgrows the model's window would otherwise fail outright. Before
each turn KiCode estimates the transcript size and, once it passes
`KICODE_CONTEXT_TOKENS` minus a reserve, replaces the older turns with a
model-written summary:

```
> [compacted 12 earlier messages: ~108400 → ~43100 tokens, target ~51200]
```

**The aim is a size, not a count of turns.** A compacted session is left sitting
at `targetPercent` of its window — 40% by default, kept inside a band of 30–50%
— and the tail that stays word-for-word is the longest run of recent turns that
fits inside that target. A turn count cannot do this job: two turns can be two
thousand tokens or ninety thousand, so a fixed count keeps far too little in a
tool-heavy session and leaves far too much in a quiet one. The target is what
makes room to keep working; the cut is what fills it. A session already at its
target is left alone, so `/compact` says there is nothing to do rather than
spending a model call to make the session bigger.

The cut prefers a **request**: a tail that opens on the words that prompted the
work reads as a conversation, and it is the boundary every provider is happiest
with. When one enormous turn leaves no request cut that fits — a hundred tool
calls under a single question — the cut moves inside that turn, to an assistant
message that owns its own calls. What it never does is orphan a tool result: a
`tool` message without the `assistant.tool_calls` that produced it is a hard API
error, so the cut is moved back to the call rather than left there. The system
prompt is never summarised.

The briefing is asked to stay inside a fifth of the target, because a summary
that runs long is what pushes a session back over its target after compacting.
Tune it in `kicode.json` (`compaction.contextTokens`, `targetPercent`,
`reserveTokens`, `compactAt`) or with the `KICODE_CONTEXT_TOKENS` (default
128000 — set it to your model's real window), `KICODE_COMPACT_TARGET` (default
40, in percent), `KICODE_COMPACT_AT` (default 100000) and
`KICODE_RESERVE_TOKENS` (default 8000) variables. `--no-compact` turns it off.

`keepRecentTurns` is gone. It was a turn count, and a turn is not a size; a
config that still sets it is told so and ignored.

The size estimate is ~4 characters per token rather than a real tokeniser —
close enough to decide *when* to compact. Compaction costs one extra model call;
if that call fails, the turn continues over budget rather than dropping the
conversation.

## Project settings (`kicode.json`)

Model, endpoint, compaction and MCP servers belong to a project, not to a
shell profile — so they can live in a `kicode.json`. KiCode reads two:
`~/.kicode/kicode.json` for every project, and `kicode.json` in the working
directory, which wins. Both are optional, and every key has a default.

You do not have to write it by hand:

```powershell
kicode --init --model deepseek-v4-flash:free --base-url https://tokenharbor.ai/v1
kicode --init                 # or record whatever is already in effect
```

It writes only the settings that are not already the built-in defaults, and it
**merges** rather than replaces — an `mcp` block, or any key a newer version adds,
survives a re-run. Running it twice says the file already records the current
settings. If the file exists but cannot be parsed it refuses to touch it, rather
than discarding content it cannot read. Because flags beat the file, `--model`
and `--base-url` are how you change what gets recorded. It works without an API
key, so a project can be set up before you have a credential to hand.

```jsonc
{
  "model": "deepseek-v4-flash:free",
  "baseUrl": "https://openrouter.ai/api/v1",
  "compaction": { "contextTokens": 200000, "targetPercent": 40 },
  "thinking": "hide",
  "verbosity": "low",
  "spacing": { "block": 1, "entry": 1, "turn": 2 },
  "mcp": { "docs": { "type": "local", "command": ["npx", "-y", "some-mcp-server"] } }
}
```

The display settings (`theme` through `tps` in the table below) are the rows
`/settings` shows; a value that is not one of the row's is reported and ignored,
and one set in a project file wins over the global one.

`spacing` is the exception, and is the reason it has a block of its own: it is
**three numbers, not a preset**, because how much air a transcript wants is
disagreed about more than anything else here, and a preset is only ever somebody
else's numbers. `block` is the padding above and below the text inside your
request, `entry` the blank rows between two entries, and `turn` the extra ones on
either side of a request. Each is a whole number from 0 to 3 — 0 is a real
answer, and gives one line per thing — and each is merged on its own, so
`{ "block": 0 }` does not mean the other two are 0:

```jsonc
{
  // A tighter screen than the default: no padding inside a request block, and
  // the request does not get a wider berth than anything else.
  "spacing": { "block": 0, "turn": 0 }
}
```

It is read from `kicode.json` — global or project — so picking a density is an
edit and a restart, not a rebuild. It is not a row in `/settings`, which steps
through named values.

| Key | Equivalent environment variable |
| --- | --- |
| `model` | `KICODE_MODEL` |
| `providers` | — (the endpoints you declared, each with its `apiKeyEnv`) |
| `provider` | `KICODE_PROVIDER` (which declared provider to use) |
| `baseUrl` | — (a declared provider's endpoint; `--base-url` for one run) |
| `fallbackModels` | `KICODE_FALLBACK_MODELS` (comma-separated) |
| `fallback` | — (routes across providers; see [When a route runs out](#when-a-route-runs-out)) |
| `maxTokens` | `KICODE_MAX_TOKENS` (or `--max-tokens`) |
| `theme` | `KICODE_THEME` (or `--theme`); see [Themes](#themes) |
| `colorMode` | — (`dark` / `light`; which half of the theme list `theme` comes from) |
| `animations` | — (`on` / `off`) |
| `sidebar` | — (`auto` / `on` / `off`) |
| `scrollbar` | — (`on` / `off`) |
| `thinking` | — (`show` / `hide`) |
| `markdown` | — (`rendered` / `raw`) |
| `toolGrouping` | — (`auto` / `off`) |
| `verbosity` | — (`low` / `medium` / `high`) |
| `transcriptImages` | — (`on` / `off`) |
| `tps` | — (`on` / `off`) |
| `spacing.block` | — (0–3: rows of padding inside a request block) |
| `spacing.entry` | — (0–3: blank rows between two entries) |
| `spacing.turn` | — (0–3: the extra rows on either side of a request) |
| `mock` | — (the same as declaring `http://localhost:8787/v1` with a placeholder key) |
| `compaction.contextTokens` | `KICODE_CONTEXT_TOKENS` |
| `compaction.reserveTokens` | `KICODE_RESERVE_TOKENS` |
| `compaction.targetPercent` | `KICODE_COMPACT_TARGET` |
| `compaction.compactAt` | `KICODE_COMPACT_AT` |
| `compaction.enabled` | `--no-compact` disables it |
| `delegation.enabled` | `KICODE_DELEGATION=off` disables it, and removes the tool |
| `delegation.model` | `KICODE_DELEGATION_MODEL` (empty = the parent's own model) |
| `delegation.maxConcurrent` | `KICODE_DELEGATION_CONCURRENT` |
| `delegation.maxPerTurn` | `KICODE_DELEGATION_PER_TURN` |
| `delegation.maxIterations` | `KICODE_DELEGATION_ITERATIONS` |
| `mcp` | — (see [MCP servers](#mcp-servers)) |

See [Subagents](#subagents) for what the delegation block does, and
[Named subagents](#named-subagents) for the ones with a name and a job.

The order is **flags > `kicode.json` > environment > defaults**, and the file
beats the environment on purpose: an ambient `OPENAI_BASE_URL` usually belongs to
some other tool, and being silently redirected to a different gateway is a
confusing failure. A file that names the endpoint is an explicit answer, so it
wins. `--model` and `--base-url` still override everything, for a one-off run.

Two details worth knowing:

- **`"mock": true` is a shorthand** for the bundled mock provider, and unlike
the other keys it beats the environment outright — that is what makes offline
runs need no variables at all. A real `baseUrl` in the same file wins over it,
and KiCode then says the shorthand was ignored.
- **The interactive banner names the files it read**, so "why is it using that
model?" is answered at startup rather than by guesswork.

A malformed value is reported and ignored rather than fatal — bad JSON, a
non-URL `baseUrl`, a negative context size. Starting with defaults beats refusing
to start.

## The key never touches disk

KiCode reads a provider's key from the environment variable that provider names
as its `apiKeyEnv`, and from nothing else — the endpoint comes from the
declaration and the value from the shell. `kicode.json` has no key field:
setting `apiKey`, `key`, or
`token` there gets you a warning and nothing more — the warning names the
variable to use instead. A config file is committed and shared, which is exactly
the wrong place for a secret, so there is no write path for one — nothing to
leak and nothing to accidentally commit. That holds at every scope: a key stored
in the per-user file is refused on the same terms as one in a project file.

Starting KiCode with no key at all opens the full-screen UI rather than exiting,
because that is where the remedies are: `/connect` declares an endpoint and
`/key` takes a key for the session. Neither writes the key to disk — the note
after `/key` names the environment variable that would make it permanent. A run
that cannot show a UI (a pipe, or `-p`) still stops with the hint above, and
`--tui-preview` never stops on config at all: it is what you run when KiCode is
misbehaving.

## How it works

```
src/cli.ts              shebang entry, top-level error handling
src/cli/run.ts          flag parsing, one-shot mode, REPL, event rendering
src/cli/models-table.ts the --models table
src/cli/init.ts         --init: writes/merges kicode.json
src/settings-write.ts    one key at a time into ~/.kicode/kicode.json, atomically
src/tui/frame.ts        layout as a pure function of state + terminal size
src/tui/menu.ts         the shared shape of the /settings and /connect panels
src/tui/settings.ts     what the screen shows: the rows and the values
src/tui/app.ts          the raw-mode loop: keys, redraws, sessions, approvals
src/tui/ansi.ts         escape codes, span width, ANSI-safe wrapping
src/tui/keys.ts         raw input decoding, tolerant of split sequences
src/tui/editor.ts       the prompt line, caret and history
src/tui/markdown.ts     the little bit of markdown a terminal needs
src/tui/logo.ts         the wordmark and its gradient
src/config-file.ts      loading the two kicode.json files
src/settings-file.ts    kicode.json -> settings, warnings, never a key
src/providers/services.ts  the known OpenAI-compatible endpoints /connect offers
src/config.ts           flags > kicode.json > environment > defaults
src/paths.ts            KICODE_HOME and the config filename
src/providers/sse.ts    buffer-safe SSE frame parser
src/providers/openai.ts streaming client, tool-call delta reassembly
src/providers/fallback.ts  the route chain: retry the same request before the first token
src/routes/quota.ts     what a gateway says about its limits, from its headers
src/routes/probe.ts     asking a gateway what is left (OpenRouter /key), cached
src/routes/health.ts    what each route did last time, kept in ~/.kicode/routes.json
src/agent/loop.ts       the loop: stream -> tools -> feed back -> repeat
src/agent/subagent.ts   the delegate tool, the child runner, the roster, and the
                       decomposition prompt the parent reads
src/agents.ts           named subagents: the profiles, their permissions, the files,
                       and each agent's skill folder beside them
src/agent/tools/        tool contract, registry, the seven tools, diff, walker, glob matcher
src/agent/compaction.ts summarise older turns when the context window fills
src/agent/environment.ts which shell `bash` gets, and the prompt that names it
src/clipboard.ts        the system clipboard: text out, or an image as a data URL
src/mcp/                MCP client: stdio + streamable HTTP transports, tool adapter
src/sessions/store.ts   session persistence (save/load/latest/prune)
src/favorites.ts        the models kept to hand, beside the sessions
src/types.ts            shared message/tool/stream types
```

One `agent.send(text)` call drives as many model turns as it takes. Each turn
streams to the terminal, executes every tool call it asked for, appends the
results as `tool` messages, and loops until the model *answers*: a turn that
asked for tools, or one that said something and was allowed to finish. A reply
the endpoint cut off at its output cap and a reply with neither words nor a tool
call are not answers, so the turn asks again — a few times, and never at the
cost of an unbounded loop. Malformed tool arguments and unknown tools are
reported back to the model rather than crashing the run, and `maxTurns` (40)
bounds a model that never stops.

### The one genuinely tricky part

Tool-call arguments do not arrive whole. They stream in as JSON fragments spread
across many SSE chunks, and a single turn can request several tools in parallel
(distinguished by an `index`). `src/providers/openai.ts` accumulates each call's
fragments per index and only parses the JSON at `finish_reason`. There are tests
for exactly this, including fragments split mid-token:

```sh
npm test
```

## Verification

```sh
npm run typecheck
npm test
npm run build
```

The suite drives the real `runCli` against a local mock endpoint, so flag
parsing, the approval prompt, rendering, session save/resume, and the file
actually landing on disk are all covered — not just the units. The TUI is driven
the same way: keystrokes go into a fake terminal and the tests assert on the
frames and on the session that gets saved, so every slash command in the table
above is exercised rather than assumed. The MCP tests
spawn a real stdio server and stand up real HTTP servers (JSON, SSE, and failure
responses) rather than mocking the protocol. Bash tests spawn `node -e`, which
behaves the same under `cmd.exe` and `sh`. The fallback provider is tested
against fake routes that fail on cue, including the cases that must *not* route
around a failure — a rejected key, a cancellation, and an answer already begun.

## What's next

1. **An eval harness.** Every claim this README makes about how a *model* behaves
   — that it delegates by name, that it batches, that it stops on a limit — has
   been reasoned rather than measured. A suite of task fixtures scored pass/fail on
   observable things (did it call `delegate`? was it one batch? did it respect the
   gate?) would turn all of it into numbers that can go down, and would make
   prompt changes reviewable instead of hopeful.
2. **Charge children's tokens to the session.** A child's spending rides on its
   own report but not on the parent's ledger, so `/context` and `/usage`
   under-report a session that delegated. The fix is an `Agent.absorb(other)` the
   loop calls for each settled child on the `subagents` event.
3. **A structured `github` tool, so `cody-git` can do GitHub work.** *(Built —
   see above. ADR-064. What it deliberately cannot do: GraphQL, and therefore
   mutations, because "read-only" was worth more than query flexibility.)*
4. **MCP resources and prompts** — the client speaks the `tools/*` surface only;
   `resources/*` and `prompts/*` are the next slice of the protocol.
4. **Write-capable children.** Read-only is a deliberate v1 limit: a child that
   could edit would need worktree isolation, and Git `worktrees` is not in the
   toolset. Adding it means adding that first, not relaxing the tool list.
5. **Memory and skills** — a long-lived memory layer and a skills directory
   would let a session start from what the last one learned. The design
   decision, and how (or whether) to bridge to Hermes Agent, is written down in
   [`ROADMAP.md`](ROADMAP.md) rather than left half-built in an afternoon.
6. **Per-request cost, not just tokens** — the usage footer counts tokens; a
   price would need a provider-reported rate, which the free routes do not have.
7. **Resume a child mid-flight, not just re-issue it.** ADR-059 stops the *double
   work* and the *lost report* when a batch is cancelled; the work still restarts,
   because nothing carries a child's intermediate state across a stop.

Adding a tool is a single file plus one line in `createDefaultTools()`. Set
`requiresApproval: true` and the gate, prompt, and refusal handling all apply.

## License

KiCode is **commercial software**. See [`LICENSE`](LICENSE) (a proprietary/
commercial license) for the exact terms. Installing it for your own personal or
internal business purposes is permitted; copying, redistributing,
sublicensing, selling, or reverse engineering it is not.
