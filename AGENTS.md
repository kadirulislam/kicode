# KiCode Agent Context & Operational Directives

KiCode is a terminal-based AI coding assistant with multi-provider routing, MCP support, session persistence, and modern TUI aesthetics.

## Core Protocols & Conventions
1. **State Files**:
   - `PROJECT_STATUS.md`: Current build health, architecture, and feature overview.
   - `TODO.md`: Completed tasks and upcoming roadmap items.
   - `DECISIONS.md`: Architectural Decision Records (ADRs).
2. **Key Subsystems**:
   - `src/tui/`: TUI renderer, frame layout (`frame.ts`), LineEditor, ANSI styling, and main event loop (`app.ts`).
   - `src/providers/`: OpenAI-compatible client (`openai.ts`), fallback router (`fallback.ts`), and services catalogue (`services.ts`).
   - `src/agent/`: The agent loop, tool registry, and **subagent delegation** (`subagent.ts`: the `delegate` tool, the child runner, the live roster).
   - `src/agents.ts`: **Named subagents** — profiles, permissions, and the two `agents.json` files. `/agents` manages them, `/agents running` watches the children, and the settings panel's `Subagents` door opens the same list.
   - The editor is a form (`FormPanel` in `menu.ts`, drawn by `renderFormPanel`). **`enter` is "next field" on every kind** — toggles change with `‹›` or space, and shift+enter is a line break. Never give `enter` two meanings.
   - `src/config.ts` & `src/settings-file.ts`: Multi-level configuration resolution (CLI > Project > Global > Env).
   - `src/settings-write.ts`: Atomic persistence to `~/.kicode.json`.
3. **Subagents** (`src/agent/subagent.ts`, ADR-053; `src/agents.ts`, ADR-054):
   - A child is an ordinary `Agent` whose isolation is the **tool list**, not a flag: `read`, `glob`, `grep`, `recall`, plus `write`/`edit` only when a named profile grants it.
   - **`bash` is never grantable.** A child has no approval channel, so a shell would mean arbitrary code running unsupervised.
   - Everything a profile decides (`model`, `tools`, `instructions`) is resolved **once**, in the delegate tool, and passed to the child builder. Never re-derive it downstream — that would be a second place for the permission grant to be read.
   - `childRunner` is shared by the TUI and the one-shot `--print` path. Do not duplicate it per caller.
   - No wall-clock timeout; `delegation.staleMs` / `staleToolMs` measure **silence** and abort the child.
   - `Tool.subagents()` hands the call's children over as data; the dock and `/agents running` read that, never parsed prose.
   - Known gap: a child's tokens are on its `SubagentResult` but are not charged to the parent, so `/usage` under-reports a delegated session.
4. **Testing without a key**: `scripts/mock-provider.mjs` with `MOCK_TOOL=delegate` and `MOCK_LOG=1` drives the whole delegation path offline and proves from outside the process that a child is read-only.
5. **Validation**:
   - Always run `npm run typecheck` and `npm test` before committing.
   - Build using `npm run build`.
