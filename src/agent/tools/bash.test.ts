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

  it("lets the stderr-quieting idioms through — models reach for them constantly", () => {
    for (const command of [
      "ls -la 2>/dev/null",
      "grep -r TODO src 2>/dev/null",
      "cat package.json 2>&1",
      "git status 2>/dev/null",
      "find . -name '*.ts' 2>/dev/null | head -5",
      "rg pattern src 2>&1 | head",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(true);
    }
    // A redirect to a real path is still a write.
    for (const command of ["ls > out.txt 2>/dev/null", "ls 2>err.txt", "echo hi > /dev/null && rm x"]) {
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

  it("tells a git listing from the same word used to create", () => {
    for (const command of [
      "git branch",
      "git branch -a",
      "git branch -vv",
      "git tag",
      "git tag -l 'v*'",
      "git remote -v",
      "git config --get user.email",
      "git config user.email",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(true);
    }
    // A name creates one; a writing flag writes.
    for (const command of [
      "git branch feature",
      "git tag v1.2.0",
      "git remote add origin url",
      "git config user.email me@example.com",
      "git branch -d old",
      "git tag -d v1",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });

  it("reads through an assignment in front, and still refuses the command behind it", () => {
    expect(isReadOnlyCommand("FOO=bar ls")).toBe(true);
    expect(isReadOnlyCommand("NODE_ENV=test grep x src")).toBe(true);
    // An assignment is not a way past the checks that matter.
    for (const command of ["FOO=bar node index.js", "FOO=bar rm -rf src", "FOO=bar", "FOO=bar ls > out.txt"]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });

  it("allows the plain filters, but not one that can rewrite its input", () => {
    for (const command of [
      "cut -d, -f1 data.csv",
      "uniq -c",
      "tr a-z A-Z",
      "nl README.md",
      "dirname src/app.ts",
      "ls -la | sort -rn | head -20",
      "git log --oneline | sort | uniq -c | sort -rn",
      "less notes.md",
      "jq . package.json",
      "diff a.txt b.txt",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(true);
    }
    for (const command of ["sort -o out.txt in.txt", "sort --output=out.txt in.txt", "sed -i s/a/b/ file", "tee out.txt", "xargs rm"]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });

  it("scopes `-o` to sort's output flag instead of every command's", () => {
    // `-o` used to sit in the global dangerous-flag list, which refused
    // `grep -o`, `ps -o`, `ls -o` and find's `-o` (OR) — all of which read.
    for (const command of [
      "grep -o pattern file.txt",
      "grep -ro TODO src",
      "ps -o pid,comm",
      "find . -name '*.ts' -o -name '*.js'",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(true);
    }
    expect(isReadOnlyCommand("sort -o out.txt in.txt")).toBe(false);
  });

  it("does not read quoted punctuation as shell structure", () => {
    for (const command of ['grep "a|b" file.txt', "grep 'a|b' file.txt", 'echo "x && y"', "echo 'x; y'", 'echo "a > b"']) {
      expect(isReadOnlyCommand(command), command).toBe(true);
    }
    // The quotes are gone but the structure is still there.
    for (const command of ['echo "a" > file.txt', 'grep "a" f | tee out.txt', "ls || cat file.txt", "ls && cat file.txt"]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });

  it("still refuses substitution inside double quotes, but not single quotes", () => {
    expect(isReadOnlyCommand('echo "$(whoami)"')).toBe(false);
    expect(isReadOnlyCommand("echo '$(whoami)'")).toBe(true);
  });

  it("refuses the find actions that write under any spelling", () => {
    for (const command of ["find . -fprint out.txt", "find . -fprint0 out.txt", "find . -fprintf out.txt '%p\\n'"]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });

  it("refuses a program that is only usually harmless", () => {
    // `node -e` runs whatever it is given, so it is never trusted.
    for (const command of ["node -e \"require('fs').writeFileSync('a','b')\"", "npm test", "tsc"]) {
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
    expect(reason("ls -la | tac")).toContain("pipeline stage `tac`");
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
