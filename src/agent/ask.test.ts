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
      { header: "Good", question: "   ", options: [{ label: "x" }] },
      { header: "Kept", question: "yes", options: [{ label: "a" }, "b"] },
    ]);

    expect(questions).toHaveLength(1);
    expect(questions[0]).toEqual({ header: "Kept", question: "yes", options: [{ label: "a" }, { label: "b" }] });
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
