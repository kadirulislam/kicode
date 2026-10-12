# @kadirulislam/kicode

## 0.1.1

**A provider must be declared now.** The environment can no longer supply an
endpoint on its own: `OPENAI_BASE_URL`, `OPENAI_API_BASE` and `KICODE_BASE_URL`
are ignored, and so is a bare `OPENAI_API_KEY`/`KICODE_API_KEY` with no
declaration to send it to. Declare an endpoint with `/connect` (or a `providers`
block in `kicode.json`), and the key still comes from the environment, in the
variable that provider names as its `apiKeyEnv`.

If 0.1.0 worked on your machine with nothing configured, the reason was an
ambient variable set for some other tool. Run `kicode` once, use `/connect`, and
it will keep working — this time because you said so.

Also in this release: one declared provider is used without being named;
`--base-url`/`--api-key` still configure a single run; and `--init` no longer
writes an empty `baseUrl`.

## 0.1.0

The first release. A bring-your-own-key terminal coding agent: point it at any
OpenAI-compatible endpoint, put a key in the environment, and work in a
full-screen TUI. No account, no server, no telemetry — nothing leaves your
machine except the requests you asked for.

## Install

```sh
npm install -g @kadirulislam/kicode
export OPENAI_API_KEY=sk-...      # or the variable for whichever endpoint you use
kicode
```

Node 20 or newer, no runtime dependencies. The endpoint and the model can live
in `kicode.json` (`kicode --init` writes a starter one) — **the key cannot**.
KiCode never reads a key from a config file, and if one is there it says so and
ignores it rather than using it. Any OpenAI-compatible endpoint works, including
OpenRouter, Groq and a local Ollama.

## What you get

**A terminal agent that keeps working.** Six tools — read, write/edit, bash,
todo, goal — plus `ask` for decisions that are genuinely yours and
`remember`/`recall` for a skills and memory store that is read back at the start
of every session. A turn does not end because the model stopped talking: it
continues while tracked work remains, and it tells you when a reply was cut off
mid-thought rather than filing it as an answer.

**A TUI, not a scrollback dump.** Markdown and syntax colour, a wrapping input
box, a message queue you can see and drop a message from, a command palette, list
cards for sessions, models and skills, themes and `/settings`.

**Background turns.** Switching tabs does not cancel work. The session you leave
is parked and finishes there, its answer saved under its own id, its queue
drained on its own, and its tab marked `◐`. Background turns do not steal the
screen: an approval one needs is denied with a note rather than a modal, and a
question it asks is skipped.

**Per-session settings.** The model, endpoint, working directory, mode and
reasoning variant belong to the conversation. `/models`, `/cd`, `Shift+Tab` and
`/variants` in one tab do not change another, and all five come back when you
switch to it — including via `--continue` on the next run.

**`Shift+Enter` inserts a line break**, decoded from xterm's `modifyOtherKeys`,
the kitty keyboard protocol and bare `ESC`+`Enter`, each requested on entry and
released on exit.

**Compaction that lands where it says.** A compacted session is left at a target
fraction of its window (default 40%, clamped to 30–50), chosen by size rather
than by a count of turns, with the system prompt counted against the budget.

## Fixed since the pre-release builds

- A turn no longer ends merely because a reply carried no tool call: a reply the
  endpoint's output cap cut off is kept and built on, and an empty reply is
  re-asked, both bounded and announced.
- The skill reader walks the tree, so categorised skills in a maintained brain
  are found, not just the flat ones the agent writes itself.
- A missing key opens the UI instead of refusing to start, so `/connect` and
  `/key` are reachable exactly when they are needed. A piped or `-p` run with no
  key still exits 1 with the environment hint.
- Mouse hit-detection on modal close chips, and a caret-column off-by-one in the
  input box.

See [CHANGELOG.md](./CHANGELOG.md) for the complete list.

## Notes

- **Licence: `MIT`.** Open source under the MIT License.
- **The tarball ships built output only**: a minified `dist/cli.js`, the README,
  the changelog and the licence. No source, no tests, no history.
- **Git installs are not a supported path.** npm blocks `prepare` scripts by
  default, so `npm install github:…` would install a package with no build in it.
  Use the registry tarball.
- Releases cut through CI carry an npm **provenance** attestation, so a tarball
  is verifiable back to the commit it was built from
  (`npm view @kadirulislam/kicode dist.attestations`). `0.1.0` ships without one, because
  attestation requires a public build repository.
