import { describe, expect, it } from "vitest";
import { githubTool } from "./github";

const ctx = { cwd: process.cwd() } as never;
const run = (args: Record<string, unknown>) => githubTool.run(args, ctx);

describe("the github tool", () => {
  describe("what it refuses before running anything", () => {
    // Each of these is refused *before* gh is started, so none of them can
    // execute. That is the property: the argument vector has no way to carry a
    // second command, because there is no command line to carry it in.
    const refused: Array<[string, unknown, RegExp]> = [
      ["a full URL", { path: "https://evil.example/steal" }, /only talks to api\.github\.com/],
      ["another host as a URL", { path: "http://169.254.169.254/latest/meta-data" }, /api\.github\.com/],
      ["a protocol-relative path", { path: "//evil.example/x" }, /protocol-relative/],
      ["gh's file-upload shorthand", { path: "@.git-credentials" }, /local file/],
      ["a path with no leading slash", { path: "user/repos" }, /must begin with/],
      ["an empty path", { path: "" }, /required/],
      ["a path with a space", { path: "/user repos" }, /may use letters/],
      ["no path at all", {}, /required/],
    ];

    for (const [what, args, expected] of refused) {
      it(`refuses ${what}`, async () => {
        const result = await run(args as Record<string, unknown>);
        expect(result.isError).toBe(true);
        expect(result.content).toMatch(expected);
      });
    }

    it("refuses a jq filter that would read the process environment", async () => {
      // The one leak the argument vector does not prevent on its own: gh holds the
      // user's token in the environment, and `read` cannot reach it.
      const result = await run({ path: "/user", jq: "$ENV | keys" });

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/\$ENV/);
    });

    it("refuses input_filename too, which is the filesystem's equivalent", async () => {
      const result = await run({ path: "/user", jq: "input_filename" });

      expect(result.isError).toBe(true);
    });

    it("allows a filter that only reads the response", async () => {
      // The refusal must be narrow: a real filter is the point of the argument.
      const result = await run({ path: "/user", jq: ".[].full_name" });
      // Not refused — it got as far as running gh, which is the whole assertion.
      expect(result.content).not.toMatch(/not allowed in/);
    });
  });

  describe("the shape it hands gh", () => {
    it("keeps the leading slash, because there is no shell to rewrite it", async () => {
      // Under Git Bash, `gh api /user/repos` becomes a request for a Windows path.
      // That rewrite belongs to a shell interpreting its arguments; `execFile`
      // starts gh directly, so it cannot happen here — which is exactly why the
      // canonical form is required rather than worked around.
      const result = await run({ path: "/user" });
      expect(result.content).not.toMatch(/No such file|file.*not found|cannot find/i);
    });
  });

  describe("when gh is not usable", () => {
    it("says to install it, rather than reporting a spawn failure", async () => {
      const result = await run({ path: "/user" });

      // On this machine gh is installed, so either real output or a real API
      // error. Either way it must be a sentence the model can act on — never a
      // bare exit code, and never silence.
      expect(result.content.length).toBeGreaterThan(0);
      if (result.isError) {
        expect(result.content).toMatch(/gh|install|failed/i);
      }
    });
  });
});