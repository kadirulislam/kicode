import { describe, expect, it } from "vitest";
import { bashTool, checkReadOnlyCommand, isReadOnlyCommand } from "./bash";

const context = (): { cwd: string } => ({ cwd: process.cwd() });

/**
 * Commands are written as `node -e ...` so they behave identically under cmd.exe
 * and sh, which keeps these tests runnable on any platform.
 */
const node = (script: string): string => `node -e "${script}"`;

describe("bash tool", () => {
  it("is gated behind approval", () => {
    expect(bashTool.requiresApproval).toBe(true);
  });

  it("returns the command in its preview", async () => {
    expect(await bashTool.preview?.({ command: "echo hi" }, context())).toBe("run: echo hi");
  });

  it("captures stdout", async () => {
    const result = await bashTool.run({ command: node("console.log('hello')") }, context());

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Exit code 0");
    expect(result.content).toContain("hello");
  });

  it("captures stderr alongside stdout", async () => {
    const result = await bashTool.run({ command: node("console.error('oh no')") }, context());

    expect(result.content).toContain("oh no");
  });

  it("reports a non-zero exit code as an error", async () => {
    const result = await bashTool.run({ command: node("process.exit(3)") }, context());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Exit code 3");
  });

  it("says so when there is no output", async () => {
    const result = await bashTool.run({ command: node("void 0") }, context());

    expect(result.content).toContain("(no output)");
  });

  it("kills a command that exceeds its timeout", async () => {
    const started = Date.now();
    const result = await bashTool.run(
      { command: node("setTimeout(() => {}, 30000)"), timeout_ms: 1000 },
      context(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
    // Resolved by the timeout rather than waiting out the command.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it("kills the command when the turn is cancelled, instead of waiting it out", async () => {
    // A hung command must not hold the turn open: Ctrl+C aborts the signal, and
    // the child dies with it.
    const controller = new AbortController();
    const started = Date.now();
    const running = bashTool.run(
      { command: node("setTimeout(() => {}, 30000)"), timeout_ms: 60_000 },
      { cwd: process.cwd(), signal: controller.signal },
    );

    setTimeout(() => controller.abort(), 100);
    const result = await running;

    expect(result.isError).toBe(true);
    expect(result.content).toContain("cancelled");
    // Stopped by the abort, not by waiting out the 30-second command.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it("requires a command", async () => {
    expect((await bashTool.run({}, context())).isError).toBe(true);
  });
});

describe("what plan mode may run", () => {
  it("lets the commands that only report on things through", () => {
    for (const command of ["ls", "ls -la src", "cat package.json", "pwd", 'dir /b "C:\\MAMP\\htdocs"', "git status", "git diff --stat", "git log --oneline -5"]) {
      expect(isReadOnlyCommand(command), command).toBe(true);
    }
  });

  it("refuses anything that redirects, chains or substitutes", () => {
    for (const command of [
      "echo hi > file.txt",
      "cat a.txt >> b.txt",
      "cat a.txt | tee b.txt",
      "ls && rm -rf src",
      "ls; rm -rf src",
      "echo `whoami`",
      "echo $(whoami)",
      "ls < input.txt",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });

  it("refuses a browsing command with an action flag", () => {
    // `find` reports, unless it is asked to run or delete something.
    expect(isReadOnlyCommand("find . -name '*.ts'")).toBe(true);
    for (const command of ["find . -delete", "find . -exec rm {} ;", "find . -execdir rm {} \\;"]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });

  it("allows only the git subcommands that report", () => {
    expect(isReadOnlyCommand("git status")).toBe(true);
    for (const command of ["git commit -m x", "git reset --hard", "git clean -fd", "git checkout main", "git branch -D main", "git push", "git reflog expire --all"]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
    // Bare `git` and `git` with only flags name no subcommand at all.
    expect(isReadOnlyCommand("git")).toBe(false);
  });

  it("refuses a program that is only usually harmless", () => {
    // `node -e` and an assignment prefix are exactly how a read-looking command
    // writes, so neither is trusted.
    for (const command of ["node -e \"require('fs').writeFileSync('a','b')\"", "FOO=bar ls", "npm test", "tsc"]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });

  it("allows a pipeline whose every stage only reads", () => {
    // `ls -la | head -20` changes nothing, and refusing it is the false
    // negative a plan is most likely to hit while looking around.
    for (const command of ["ls -la | head -20", "cat log.txt | grep error | tail -5", "git log --oneline | wc -l"]) {
      expect(isReadOnlyCommand(command), command).toBe(true);
    }
  });

  it("refuses a pipeline with a stage that could write", () => {
    for (const command of ["ls -la | tee out.txt", "cat a.txt | xargs rm", 'ls | node -e ""', "ls |"]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });

  it("names the reason, so the model does not have to guess again", () => {
    const reason = (command: string): string => {
      const verdict = checkReadOnlyCommand(command);
      return verdict.ok ? "" : verdict.reason;
    };

    expect(reason("git push")).toContain("git push");
    expect(reason("git push")).toContain("not a read-only git subcommand");
    expect(reason("find . -delete")).toContain("-delete");
    expect(reason("ls -la | sort")).toContain("pipeline stage `sort`");
    expect(reason("ls > out.txt")).toContain("redirects");
    expect(reason("ls && rm -rf src")).toContain("chains");
    expect(reason("echo $(whoami)")).toContain("substitutes");
    expect(reason("rm -rf src")).toContain("`rm`");
  });

  it("answers on the tool itself, so the loop has one place to ask", () => {
    expect(bashTool.readsOnly?.({ command: "git status" })).toBe(true);
    expect(bashTool.readsOnly?.({ command: "rm -rf src" })).toBe(false);
    // A call with no command at all is not a read.
    expect(bashTool.readsOnly?.({})).toBe(false);
  });

  it("explains a refusal through the tool, which is what the loop reads", () => {
    expect(bashTool.readOnlyRefusal?.({ command: "git push" })).toContain("git push");
    // An allowed command has nothing to explain.
    expect(bashTool.readOnlyRefusal?.({ command: "git status" })).toBeNull();
  });
});
