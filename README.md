# KiCode

A bring-your-own-key terminal coding agent. Point it at any OpenAI-compatible
endpoint, give it a key in the environment, and it reads your files and answers
questions about them — with six tools, MCP support, sessions, and compaction
around a streaming agent loop that stays short enough to read in one sitting.

## Quick start

```sh
npm install
npm run build
```

Set the key in the environment (PowerShell on the left, bash on the right — the
key is deliberately the one thing that never goes in a config file):

```powershell
$env:KICODE_API_KEY = "sk-..."
node dist/cli.js "what does src/config.ts do?"
```

```sh
export KICODE_API_KEY=sk-...
node dist/cli.js "what does src/config.ts do?"
```

To stop passing the model and endpoint on every run, drop them in `kicode.json`
— see [Project settings](#project-settings-kicodejson).

## Install as a global command

```sh
npm install
npm run build     # required if your npm blocks install scripts
npm link          # symlinks this checkout, so rebuilds take effect immediately

kicode --version
kicode "what does this project do?"
```

`npm link` is the right choice while developing — it points at this directory
rather than copying it, so `npm run build` is the only step needed to publish a
change. It drops a `kicode` shim into npm's global prefix (`npm prefix -g`); on
Windows that is usually `%APPDATA%\npm`, which is already on `PATH`, so
`kicode` works from PowerShell, `cmd`, and Git Bash in any directory. Run
`kicode --version` from somewhere *other* than this folder to confirm.

npm blocks install scripts unless the package is allowed to run them, so the
`prepare` hook does not fire here — build once by hand first. To install a
standalone copy instead of a symlink:

```sh
npm install -g .
```

The package ships only `dist/` and `README.md`, and the `bin` entry resolves to
a single bundled file, so there is nothing else to install at runtime.

### Pointing it elsewhere

`baseUrl` in `kicode.json` (or `KICODE_BASE_URL`) accepts any OpenAI-compatible
endpoint:

| Provider | Base URL |
| --- | --- |
| OpenAI | `https://api.openai.com/v1` (default) |
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

    [BUILD] Ask anything…  "find the TODO in the parser"        UPLOAD[+]


    deepseek-v4-flash:free · default
 C:\dev\projects\kicode          ↓ 12 tools · 304.8K (29%)   ctrl+p commands
```

The bar across the top is your sessions for this directory, newest first. It is
the **sidebar**, and it is a setting: `auto` — the default — keeps the row for
the transcript while there is only one session and brings it back the moment
there is something to switch to. The last three rows are the prompt, the current
state — the model and the reasoning variant, while the mode rides in the box's
own pill — and the footer: the
directory, what the session has cost, and the one key worth naming.
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
and **`UPLOAD[+]`** on the right. The pill is the session's mode, and it is a
button: `Shift+Tab`, `/mode`, or a click on the pill all switch between `Build`
and `Plan`, and plan mode is drawn in the warning colour because it changes what
the session is allowed to do rather than merely what it is called.
`UPLOAD[+]` opens the platform's own file-selection window, so attaching is a
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
tab bar with nothing in it has nothing to type into. The mouse wheel scrolls the
transcript, and the same click works on a row of any panel — see
[Keys](#keys). KiCode asks the terminal for the mouse while it is on screen and
uses the drag itself: **drag across the transcript to select it**, and the text
is copied to the clipboard when the button comes up. The terminal's own bypass
(usually holding `Shift`) is still there as a second way.

### Commands

Type `/` and the palette opens, filtering as you type — `↑` `↓` choose, `Enter`
runs, `Esc` closes. `Ctrl+P` opens the same list from anywhere:

```
/btw       One-shot answer from the session's context, not added to it <question>
/cd        Change working directory <directory>                                
/clear     Clear session                                                       
/compact   Compact session                                                     
/connect   Connect an integration [service]                                     
/copy      Copy session transcript                                              
/debug     View debug info                                                     
/diff      Open diff viewer                                                     
/exit      Exit the app                                                        
/help      Help                                                                
/init      guided AGENTS.md setup                                                
/mcps      MCP servers                                                         
/mode      Switch between build and plan [build|plan]                         
/models    Switch model                                                        
/rename    Rename session <name>                                               
/sessions  Switch session                                                      
/settings  Open settings [key] [value]                                         
/status    View status                                                         
/undo      Undo previous message                                               
/variants  Switch model variant                                                
/worktrees Manage workspaces                                                  
```

Only commands that actually run here are listed — no aliases, no dead entries.
The rest still work when typed in full: an alias (`/q`, `/open`, `/resume`)
runs the command it stands for, and a name KiCode does not have (`/agents`,
`/plugins`, `/worktrees`…) answers for itself instead of failing silently:

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
`/settings` | The settings panel: a search field, grouped rows, `‹` `›` to change a value. `/settings thinking hide` sets one outright
`/connect` | Add an endpoint KiCode can reach from a list of known services, and move the session onto it
`/status` `/stats` `/debug` `/mcps` | What is in play, and what it has cost
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
here. There is no second implementation to drift out of step.

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

`ctrl+a` in the model list moves the session to another endpoint. Only
endpoints that already have a credential are offered — `KICODE_BASE_URL` /
`KICODE_API_KEY` and `OPENAI_BASE_URL` / `OPENAI_API_KEY`, alongside the one in
use — because a provider KiCode cannot authenticate to would only be a 401
after the choice. The key moves with the endpoint, and the list is fetched again
from the new one.

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

The `mock` shorthand is the point: instead of typing `KICODE_BASE_URL=…` (or
`$env:KICODE_BASE_URL`) before every run, put this in the project's
`kicode.json` and a plain `kicode` talks to the local mock — with the
placeholder key `local`, so a real key is never sent to localhost.

```json
{ "mock": true, "model": "mock-model" }
```

It listens on `8787`; set `MOCK_PORT` to move it, and Ctrl+C to stop it. If
port 8787 is already taken the mock says so — that usually means an earlier one
is still running. On Windows a backgrounded process ignores a plain `kill` from
Git Bash, so use `MSYS_NO_PATHCONV=1 taskkill /F /PID <pid>`.

`MOCK_TOOL` picks which tool it asks for (`read`, `write`, `edit`, `glob`,
`grep`, `bash`, `mcp`), and `MOCK_TOOL=none` makes it answer with prose only —
useful for exercising compaction.

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

`glob` and `grep` are pure Node — no `ripgrep` binary to install. Both match
patterns against paths with forward slashes, so patterns behave the same on
Windows.

Which shell `bash` runs through is a decision, not an accident. On Windows it is
the Git Bash from Git for Windows when there is one, because the commands a
model reaches for first are POSIX ones; without one it is `cmd.exe`. Either way
the model is **told**: the system prompt ends with an `Environment` section
naming the platform, the shell and the commands that shell has and has not — so
`ls -la` is not the opening move on a machine that would answer `'ls' is not
recognized as an internal or external command`. `KICODE_SHELL` overrides the
choice, and `KICODE_SHELL=cmd.exe` keeps the Windows commands for someone who
wants them. WSL's `bash.exe` is never picked: its paths are Linux paths.

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

The mode is per session and starts at `Build`; it is deliberately not stored,
so a resumed session never silently comes back unable to write.

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
> [compacted 8 earlier messages: ~1501 → ~486 tokens]
```

The cut always lands on a **user** message. That is deliberate: a `tool` message
without the `assistant.tool_calls` that produced it is a hard API error, so
splitting anywhere else would eventually cut a tool sequence in half. The recent
turns are kept verbatim, and the system prompt is never summarised.

Tune it in `kicode.json` (`compaction.contextTokens`, `keepRecentTurns`,
`reserveTokens`) or with the `KICODE_CONTEXT_TOKENS` (default 128000 — set it to
your model's real window), `KICODE_KEEP_TURNS` (default 6), and
`KICODE_RESERVE_TOKENS` (default 8000) variables. `--no-compact` turns it off.

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
  "compaction": { "contextTokens": 200000, "keepRecentTurns": 8 },
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
| `baseUrl` | `KICODE_BASE_URL` |
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
| `mock` | `KICODE_BASE_URL=http://localhost:8787/v1` |
| `compaction.contextTokens` | `KICODE_CONTEXT_TOKENS` |
| `compaction.reserveTokens` | `KICODE_RESERVE_TOKENS` |
| `compaction.keepRecentTurns` | `KICODE_KEEP_TURNS` |
| `compaction.enabled` | `--no-compact` disables it |
| `mcp` | — (see [MCP servers](#mcp-servers)) |

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

KiCode reads `KICODE_API_KEY` (or `OPENAI_API_KEY`) from the environment and
nothing else. `kicode.json` has no key field: setting `apiKey`, `key`, or
`token` there gets you a warning and nothing more. A project config is committed
and shared, which is exactly the wrong place for a secret, so there is no write
path for one — nothing to leak and nothing to accidentally commit.

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
src/agent/tools/        tool contract, registry, the six tools, diff, walker, glob matcher
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
results as `tool` messages, and loops until the model answers without calling a
tool. Malformed tool arguments and unknown tools are reported back to the model
rather than crashing the run, and `maxTurns` bounds a model that never stops.

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

1. **Sub-agents** — a tool that runs a nested KiCode loop would let a long task
   be split across contexts instead of filling one, and would turn `/agents`
   from a dimmed row into a real one.
2. **MCP resources and prompts** — the client speaks the `tools/*` surface only;
   `resources/*` and `prompts/*` are the next slice of the protocol.
3. **Memory and skills** — a long-lived memory layer and a skills directory
   would let a session start from what the last one learned. The design
   decision, and how (or whether) to bridge to Hermes Agent, is written down in
   [`ROADMAP.md`](ROADMAP.md) rather than left half-built in an afternoon.
4. **Per-request cost, not just tokens** — the usage footer counts tokens; a
   price would need a provider-reported rate, which the free routes do not have.

Adding a tool is a single file plus one line in `createDefaultTools()`. Set
`requiresApproval: true` and the gate, prompt, and refusal handling all apply.
