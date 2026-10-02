import { describe, expect, it } from "vitest";
import { allowPredicate } from "./allow";

describe("allowPredicate", () => {
  const rules = allowPredicate({ bash: ["npm test", "git status"] });

  it("matches a command that starts with a configured prefix", () => {
    expect(rules("bash", { command: "npm test" })).toBe(true);
    expect(rules("bash", { command: "npm test -- --watch" })).toBe(true);
    expect(rules("bash", { command: "  git status  " })).toBe(true);
  });

  it("leaves a tool with no rule to the approval channel", () => {
    expect(rules("bash", { command: "rm -rf /" })).toBe(false);
    expect(rules("write", { path: "out.txt" })).toBe(false);
  });

  it("refuses a value that chains or redirects, however it begins", () => {
    // The whole reason the prefix is matched literally: `git status; rm -rf /`
    // starts with a rule and is a different command.
    expect(rules("bash", { command: "git status; rm -rf /" })).toBe(false);
    expect(rules("bash", { command: "git status && rm -rf /" })).toBe(false);
    expect(rules("bash", { command: "npm test > out.txt" })).toBe(false);
    expect(rules("bash", { command: "npm test `whoami`" })).toBe(false);
    expect(rules("bash", { command: "npm test $(whoami)" })).toBe(false);
    expect(rules("bash", { command: "npm test | sh" })).toBe(false);
  });

  it("ignores non-string arguments", () => {
    expect(rules("bash", { command: 42, nested: { command: "npm test" } })).toBe(false);
  });
});
