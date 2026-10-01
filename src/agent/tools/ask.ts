import { parseQuestions } from "../ask";
import type { Tool } from "./types";

/** JSON.parse that answers null instead of throwing, for one-line use below. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Asks the user to choose between options.
 *
 * It is not gated behind approval: it changes nothing, and the answer *is* the
 * user's input — an approval prompt on top of a question would be pure noise.
 *
 * The results come back one per line so the model can rely on them, including
 * when the user closes the question: "dismissed" has to be stated explicitly,
 * or the model will read silence as consent to whatever it proposed.
 */
export const askTool: Tool = {
  name: "ask",
  description: [
    "Ask the user to choose between concrete options when the decision is theirs and cannot be inferred from the code.",
    "Use it for genuine forks — a preference, a trade-off, a name, which of two approaches to take. Do not use it to confirm something you can verify yourself, and do not use it when a reasonable default exists and you can just say what you assumed.",
    "Ask everything you need in one call rather than one question per turn.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "One to eight questions, asked together.",
        items: {
          type: "object",
          properties: {
            header: { type: "string", description: "Short label for this question, e.g. \"Typography\"." },
            question: { type: "string", description: "The question itself, in one sentence." },
            options: {
              type: "array",
              description: "Two to eight options. The first is the one you recommend.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Short label, a few words." },
                  description: {
                    type: "string",
                    description: "One or two sentences on what this choice means — the consequence, not a restatement.",
                  },
                },
                required: ["label"],
              },
            },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },

  async run(args, context) {
    // A double-encoded payload arrives as one JSON string; parse it before the
    // guard so the model's most common mistake still renders as questions.
    const payload = typeof args === "string" ? safeParse(args) : args?.questions;
    const questions = parseQuestions(payload);
    if (questions.length === 0) {
      const received =
        typeof payload === "string" ? "a string" : Array.isArray(payload) ? `${payload.length} item(s)` : typeof payload;
      return {
        content:
          `Error: no usable questions (received ${received}). ` +
          "Each question needs question text and at least one option, each option with a label.",
        isError: true,
      };
    }

    if (!context.ask) {
      return {
        content:
          "Error: there is nobody to answer questions in this run (non-interactive). Choose a sensible default yourself and say clearly what you assumed.",
        isError: true,
      };
    }

    const answers = await context.ask({ questions });
    return {
      content: answers
        .map((answer) => `${answer.header}: ${answer.dismissed ? "the user dismissed this question" : answer.answer}`)
        .join("\n"),
    };
  },
};
