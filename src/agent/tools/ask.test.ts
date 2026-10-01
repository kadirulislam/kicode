import { describe, expect, it } from "vitest";
import { askTool } from "./ask";
import { createDefaultTools } from "./index";

describe("ask tool", () => {
  it("is only registered when somebody can answer", () => {
    const without = createDefaultTools().list().map((tool) => tool.name);
    const with_ = createDefaultTools([], { ask: true }).list().map((tool) => tool.name);

    expect(without).not.toContain("ask");
    expect(with_).toContain("ask");
  });

  it("is not gated behind approval", () => {
    // It changes nothing, and the answer *is* the user's input — an approval
    // prompt on top of a question would be pure noise.
    expect(askTool.requiresApproval).toBeUndefined();
  });

  it("returns the answers one per line", async () => {
    const result = await askTool.run(
      {
        questions: [
          { header: "Typography", question: "Which way?", options: [{ label: "Sans" }, { label: "Mono" }] },
        ],
      },
      {
        cwd: ".",
        ask: async () => [{ header: "Typography", answer: "Mono", dismissed: false }],
      },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("Typography: Mono");
  });

  it("says a question was dismissed rather than staying silent", async () => {
    const result = await askTool.run(
      { questions: [{ header: "Typography", question: "Which way?", options: [{ label: "Sans" }] }] },
      { cwd: ".", ask: async () => [{ header: "Typography", answer: "", dismissed: true }] },
    );

    // Silence would be read as agreement with whatever the model proposed.
    expect(result.content).toContain("the user dismissed this question");
  });

  it("tells the model to decide for itself when there is no channel", async () => {
    const result = await askTool.run(
      { questions: [{ header: "Typography", question: "Which way?", options: [{ label: "Sans" }] }] },
      { cwd: "." },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("nobody to answer");
    expect(result.content).toContain("default");
  });

  it("rejects arguments it cannot render before reaching the user", async () => {
    let called = 0;
    const result = await askTool.run(
      { questions: [{ question: "no options at all", options: [] }] },
      {
        cwd: ".",
        ask: async () => {
          called += 1;
          return [];
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(called).toBe(0);
  });
});
