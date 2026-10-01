/**
 * The question channel.
 *
 * A model that hits a decision only the user can make has two bad options:
 * guess, or stop and ask in prose. A typed channel lets it ask properly — one
 * question, a few labelled options, and an answer that comes back as a normal
 * tool result.
 *
 * Like approval, this is a *channel*: with nobody to answer it is not offered
 * at all, because a question that cannot be answered wastes a turn.
 */

export type AskOption = {
  /** Short label, shown next to its number. */
  label: string;
  /** One or two sentences on what choosing this means. */
  description?: string;
};

export type AskQuestion = {
  /** Short name for the tab strip, e.g. "Typography". */
  header: string;
  question: string;
  options: AskOption[];
};

export type AskRequest = { questions: AskQuestion[] };

export type AskAnswer = {
  header: string;
  /** The chosen label, or the text the user typed themselves. */
  answer: string;
  /** True when the user closed the question without answering. */
  dismissed: boolean;
};

export type AskFn = (request: AskRequest) => Promise<AskAnswer[]>;

/** Guards the model's arguments into something renderable. */
export function parseQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return [];

  const questions: AskQuestion[] = [];
  for (const item of raw.slice(0, 8)) {
    if (item === null || typeof item !== "object") continue;
    const source = item as Record<string, unknown>;

    const question = typeof source.question === "string" ? source.question.trim() : "";
    const options = Array.isArray(source.options)
      ? source.options
          .map((option): AskOption | null => {
            if (typeof option === "string") return { label: option.trim() };
            if (option === null || typeof option !== "object") return null;
            const entry = option as Record<string, unknown>;
            const label = typeof entry.label === "string" ? entry.label.trim() : "";
            if (!label) return null;
            const description = typeof entry.description === "string" ? entry.description.trim() : "";
            return description ? { label, description } : { label };
          })
          .filter((option): option is AskOption => option !== null)
          .slice(0, 8)
      : [];

    if (!question || options.length === 0) continue;
    const header = typeof source.header === "string" && source.header.trim() ? source.header.trim() : `Q${questions.length + 1}`;
    questions.push({ header, question, options });
  }

  return questions;
}
