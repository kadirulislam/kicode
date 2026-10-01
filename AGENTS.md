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
   - `src/config.ts` & `src/settings-file.ts`: Multi-level configuration resolution (CLI > Project > Global > Env).
   - `src/settings-write.ts`: Atomic persistence to `~/.kicode.json`.
3. **Validation**:
   - Always run `npm run typecheck` and `npm test` before committing.
   - Build using `npm run build`.
