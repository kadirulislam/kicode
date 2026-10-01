import { describe, expect, it } from "vitest";
import { parseQuestions } from "./ask";

describe("parseQuestions", () => {
  it("keeps a well-formed question", () => {
    const questions = parseQuestions([
      {
        header: "Typography",
        question: "Which way?",
        options: [
          { label: "Sans-serif", description: "Clean throughout." },
          { label: "Monospace" },
        ],
      },
    ]);

    expect(questions).toEqual([
      {
        header: "Typography",
        question: "Which way?",
        options: [{ label: "Sans-serif", description: "Clean throughout." }, { label: "Monospace" }],
      },
    ]);
  });

  it("accepts a bare string as an option", () => {
    const questions = parseQuestions([{ question: "Which?", options: ["left", "right"] }]);

    expect(questions[0]?.options).toEqual([{ label: "left" }, { label: "right" }]);
    // A question with no header still needs to be identifiable in the tab strip.
    expect(questions[0]?.header).toBe("Q1");
  });

  it("drops anything it cannot render", () => {
    const questions = parseQuestions([
      null,
      "nonsense",
      { question: "no options", options: [] },
      { question: "bad options", options: [{ description: "no label" }, null, 7] },
      // No question text under any known field name, and no header to rescue.
      { options: [{ label: "x" }] },
      { header: "Kept", question: "yes", options: [{ label: "a" }, "b"] },
    ]);

    expect(questions).toHaveLength(1);
    expect(questions[0]).toEqual({ header: "Kept", question: "yes", options: [{ label: "a" }, { label: "b" }] });
  });

  it("rescues the shapes free models actually send", () => {
    // The question text drifted into another field name…
    const drifted = parseQuestions([{ header: "Project type", title: "What kind of project?", options: [{ label: "Web" }] }]);
    expect(drifted[0]).toMatchObject({ header: "Project type", question: "What kind of project?" });

    // …or only the header carries text at all.
    const headerOnly = parseQuestions([{ header: "New project setup?", options: ["yes", "no"] }]);
    expect(headerOnly[0]).toMatchObject({ header: "New project setup?", question: "New project setup?" });

    // A double-encoded payload arrives as one JSON string.
    const encoded = parseQuestions(JSON.stringify([{ question: "Which?", options: [{ label: "A" }] }]));
    expect(encoded).toHaveLength(1);

    // A single question object instead of an array, or nested one level deep.
    expect(parseQuestions({ question: "Which?", options: [{ label: "A" }] })).toHaveLength(1);
    expect(parseQuestions({ questions: [{ question: "Which?", options: [{ label: "A" }] }] })).toHaveLength(1);

    // Options as an object map instead of an array.
    const mapped = parseQuestions([{ question: "Font?", options: { Sans: "clean", Mono: "aligned" } }]);
    expect(mapped[0]?.options).toEqual([
      { label: "Sans", description: "clean" },
      { label: "Mono", description: "aligned" },
    ]);
  });

  it("returns nothing for a shape it cannot use", () => {
    expect(parseQuestions(undefined)).toEqual([]);
    expect(parseQuestions({ questions: [] })).toEqual([]);
    expect(parseQuestions([])).toEqual([]);
  });

  it("caps what it will put on screen", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      header: `Q${index}`,
      question: `question ${index}`,
      options: Array.from({ length: 30 }, (_, option) => ({ label: `option ${option}` })),
    }));

    const questions = parseQuestions(many);

    // A wall of options is unanswerable, and the terminal is only so tall.
    expect(questions).toHaveLength(8);
    expect(questions[0]?.options).toHaveLength(8);
  });
});
