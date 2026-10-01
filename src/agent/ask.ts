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

/**
 * The field a model may put the question text in.
 *
 * Free models drift around the schema: `question` is the contract, but `title`,
 * `prompt` and `text` are the drifts seen in the wild, and some models put only
 * the header in and expect it to carry the question too. Accepting the drifts
 * beats bouncing the call — a refused ask costs a whole turn while the model
 * reformats.
 */
const QUESTION_FIELDS = ["question", "title", "prompt", "text", "header"] as const;

/** Likewise for an option's label. */
const LABEL_FIELDS = ["label", "name", "value", "choice", "text"] as const;

function firstString(source: Record<string, unknown>, fields: readonly string[]): string {
  for (const field of fields) {
    const value = source[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** One option from whatever the model actually sent. */
function parseOption(raw: unknown): AskOption | null {
  if (typeof raw === "string") return raw.trim() ? { label: raw.trim() } : null;
  if (raw === null || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const label = firstString(entry, LABEL_FIELDS);
  if (!label) return null;
  const description = typeof entry.description === "string" ? entry.description.trim() : "";
  return description ? { label, description } : { label };
}

/**
 * Options from the shapes a model sends: an array of objects or strings (the
 * contract), or an object map — `"Sans": "Cleaner at small sizes"` — which
 * several models produce instead of an array.
 */
function parseOptions(raw: unknown): AskOption[] {
  if (Array.isArray(raw)) {
    return raw
      .map(parseOption)
      .filter((option): option is AskOption => option !== null)
      .slice(0, 8);
  }
  if (raw !== null && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .map(([label, description]) =>
        typeof description === "string" && description.trim()
          ? { label, description: description.trim() }
          : { label },
      )
      .slice(0, 8);
  }
  return [];
}

/** One question from whatever the model actually sent, or null if unusable. */
function parseQuestion(item: unknown, index: number): AskQuestion | null {
  if (item === null || typeof item !== "object") return null;
  const source = item as Record<string, unknown>;

  const question = firstString(source, QUESTION_FIELDS);
  const options = parseOptions(source.options);
  if (!question || options.length === 0) return null;

  const header =
    typeof source.header === "string" && source.header.trim()
      ? source.header.trim()
      : // When the question text was rescued from `header` itself, it still
        // serves as the tab strip's name — it is the only text there is.
        (source.question === undefined && firstString(source, ["title", "prompt", "text"])) || `Q${index + 1}`;
  return { header, question, options };
}

/**
 * Guards the model's arguments into something renderable — and forgives the
 * shapes models actually send, because a bounced ask costs a whole turn:
 *
 * - `questions` as a JSON string (double-encoded arguments)
 * - a single question object instead of an array
 * - the whole payload nested one level deep (`{ questions: {...} }`)
 * - the question text under `title`/`prompt`/`text`, or only in `header`
 * - options as an object map (`{ "Sans": "why" }`) or strings, not just
 *   `{ label, description }` objects
 */
export function parseQuestions(raw: unknown): AskQuestion[] {
  if (raw === null || raw === undefined) return [];

  // A double-encoded payload arrives as one JSON string.
  if (typeof raw === "string") {
    try {
      return parseQuestions(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  // A single question object, or the payload nested one level deep.
  if (!Array.isArray(raw) && typeof raw === "object") {
    const source = raw as Record<string, unknown>;
    if (Array.isArray(source.questions)) return parseQuestions(source.questions);
    if (source.question !== undefined || source.options !== undefined) return parseQuestions([raw]);
    return [];
  }

  if (!Array.isArray(raw)) return [];

  return raw
    .slice(0, 8)
    .map((item, index) => parseQuestion(item, index))
    .filter((question): question is AskQuestion => question !== null);
}
