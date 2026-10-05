import { recallFromBrain } from "../brain";
import type { Tool } from "./types";

/**
 * Reads the brain back: the counterpart to `remember`.
 *
 * The session's briefing already names this project's memory and lists the
 * skills, but a name is not a body. This loads one on demand — a skill's full
 * procedure, or a project memory's entries — and searches the brain when the
 * caller only knows the words, not the name.
 *
 * Deliberately ungated: reading is not a change, nothing it returns is written
 * anywhere, and the prompt for it would cost more than the read. Like every
 * other read it works in plan mode.
 */
export const recallTool: Tool = {
  name: "recall",
  // Reads change nothing, so they may overlap each other within one turn.
  concurrencySafe: true,
  description: [
    "Load what earlier sessions saved in the brain: a skill's full procedure, or a project memory.",
    "Use it before starting work that a saved skill or memory might already cover — a project's build/test/deploy convention, a gotcha with its fix, a procedure you have run before. The system prompt lists what exists; this reads one.",
    'Pass "name" for an exact skill or project slug, or "query" for the words you remember. With neither, it answers for the current project.',
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'Exact skill name or project memory slug, e.g. "vercel-deploy" or "my-app".',
      },
      query: {
        type: "string",
        description: "Words to search skill names, descriptions and project memories for. Used when the exact name is not known.",
      },
    },
    required: [],
  },

  async run(args, context) {
    const name = typeof args.name === "string" ? args.name : "";
    const query = typeof args.query === "string" ? args.query : "";
    return recallFromBrain(context.cwd, { name, query });
  },
};
