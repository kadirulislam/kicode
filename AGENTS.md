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
   - `src/config.ts` & `src/settings-file.ts`: Multi-level configuration resolution (CLI > Project > Global > Env).
   - `src/settings-write.ts`: Atomic persistence to `~/.kicode.json`.
3. **Subagents** (`src/agent/subagent.ts`, ADR-053):
   - A child is an ordinary `Agent` with `SUBAGENT_TOOLS` = `read`, `glob`, `grep`, `recall` — isolation is the **tool list**, not a flag.
   - `childRunner` is shared by the TUI and the one-shot `--print` path. Do not duplicate it per caller.
   - No wall-clock timeout; `delegation.staleMs` / `staleToolMs` measure **silence** and abort the child.
   - `Tool.subagents()` hands the call's children over as data; the dock and `/agents` read that, never parsed prose.
   - Known gap: a child's tokens are on its `SubagentResult` but are not charged to the parent, so `/usage` under-reports a delegated session.
4. **Testing without a key**: `scripts/mock-provider.mjs` with `MOCK_TOOL=delegate` and `MOCK_LOG=1` drives the whole delegation path offline and proves from outside the process that a child is read-only.
5. **Validation**:
   - Always run `npm run typecheck` and `npm test` before committing.
   - Build using `npm run build`.
