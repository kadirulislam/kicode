import { exec } from "node:child_process";
import { chooseShell } from "../environment";
import { clamp, intArg, stringArg } from "./args";
import type { Tool, ToolResult } from "./types";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

type ExecOutcome = {
  exitCode: number | null;
  killed: boolean;
  /** The turn was cancelled, which is what killed it — not the timeout. */
  aborted: boolean;
  output: string;
  failure: string | null;
};

/**
 * Commands whose whole job is to look at the machine.
 *
 * Deliberately short and conservative. A command that is only *usually* safe
 * (`node`, `npm`, `tsc`, `find` with an action flag) is not here: plan mode
 * exists so that nothing happens, and a classifier that guesses wrong is worse
 * than one that refuses.
 */
const READ_ONLY_COMMANDS = new Set([
  // Portable-ish
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "find",
  "which",
  "file",
  "stat",
  "du",
  "df",
  "uname",
  "whoami",
  "date",
  "echo",
  // Filters: they read a stream and print. `sort` writes only through `-o` /
  // `--output` (guarded in `checkStage`); a command that can rewrite its
  // input another way (`sed -i`, `tee`, `xargs`) is deliberately absent —
  // the classifier does not parse flags deeply enough to tell those apart.
  // `awk` and `sed` stay out for the same reason (`system()`, `s///e`, `w`).
  "uniq",
  "cut",
  "tr",
  "nl",
  "sort",
  "less",
  "jq",
  "diff",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "printenv",
  "id",
  "ps",
  // Windows
  "dir",
  "type",
  "where",
  "findstr",
  "more",
  "tree",
  "ver",
]);

/** A listing flag: it makes a following name a filter rather than a creation. */
const GIT_LISTING_FLAGS = new Set(["-l", "--list"]);

/** Flags that change a repository rather than reporting on it. */
const GIT_WRITE_FLAGS = new Set([
  "-d",
  "-D",
  "-m",
  "-M",
  "-c",
  "-C",
  "-f",
  "-u",
  "-t",
  "-e",
  "-s",
  "--delete",
  "--move",
  "--copy",
  "--force",
  "--set-upstream-to",
  "--unset-upstream",
  "--edit-description",
  "--annotate",
  "--sign",
  "--create-reflog",
  "--track",
  "--no-track",
  "--add",
  "--remove",
  "--rename",
  "--set-url",
  "--set-head",
]);

/** The `git config` flags that only read, so `key value` can be told from `key`. */
const GIT_CONFIG_READ_FLAGS = new Set([
  "-l",
  "--list",
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--get-color",
  "--get-colorbool",
]);

/**
 * Git subcommands that report on the repository and do not move it.
 *
 * `config` and `remote` are deliberately absent: `git config user.name x` and
 * `git remote add` write, and the two are indistinguishable from their listing
 * forms without knowing each flag's arity.
 */
const READ_ONLY_GIT = new Set([
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "describe",
  "shortlog",
  "whatchanged",
  "reflog",
]);

/** Flags that turn a browsing command into one that writes or runs things.
 *
 * Deliberately *not* in here: `-o`. It used to be, for `sort -o` — but the
 * same two letters are `grep -o` (print only the match), `ls -o`, `ps -o`
 * (report formats) and `find`'s OR operator, all of which only read. A bare
 * `-o` blocked every one of those, which was the plan-mode false negative
 * that kept biting. `sort`'s output flag is guarded where `sort` is known,
 * in `checkStage`.
 */
const DANGEROUS_FLAGS = ["-exec", "-execdir", "-delete", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"];

/** Whether a command may run in plan mode, and why not when it may not. */
export type ReadOnlyVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether a shell command can be trusted to change nothing.
 *
 * Conservative on purpose, and refused rather than guessed at:
 *
 * - Redirection, chaining and substitution are refused — `>`, `<`, `;`, `&`,
 *   `&&`, `||`, a backtick or `$(`, plus newlines. Those are how a
 *   read-only-looking command writes, so there is no way to be sure about one.
 * - Quoted regions are not structure: `grep "a|b" file` and `echo "x && y"`
 *   only read, so `|`, `;` and `&` inside `'...'` or `"..."` are ignored when
 *   looking for chains and pipe stages. Substitution is the exception —
 *   `$(...)` and backticks still run inside double quotes, so only
 *   single-quoted regions are blind to those (`'$(whoami)'` is literal text).
 * - A pipeline is allowed only when *every* stage is itself a command that only
 *   reads: `ls -la | sort -rn | head -20` changes nothing, and refusing it was
 *   the one false negative users kept hitting.
 * - `find` actions (`-exec`, `-delete`, `-fprint0`, …) are refused; bare `find`
 *   (and `find ... -o ...`, the OR operator) prints.
 * - `sort` is allowed except with `-o` / `--output`, which names a file.
 * - `git` is allowed its reporting subcommands, and three more on a stricter
 *   rule: `branch`, `tag`, `remote` and `config` read when they name nothing
 *   (or after a listing flag), and write when they do — `git branch` lists,
 *   `git branch feature` creates. A writing flag is refused either way.
 * - Assignments in front (`FOO=bar ls`) are stripped, because the command they
 *   set the variable for is still the thing being classified, and refusing
 *   `FOO=bar ls` was a false negative with no safety in it.
 * - An unknown first word is still refused.
 *
 * `checkReadOnlyCommand` says which of those it was, so the refusal the model
 * reads names the actual problem instead of sending it guessing again.
 */
/**
 * The command with its quoted regions removed, so punctuation inside
 * `'...'` or `"..."` is not read as shell structure. Handles `\"` inside
 * double quotes; an unterminated quote swallows the rest, which can only
 * make the verdict stricter downstream (or match what the shell does).
 */
function stripQuoted(text: string): string {
  return stripQuotes(text, false);
}

/**
 * The command with only single-quoted regions removed. `$(...)` and
 * backticks still execute inside double quotes, so those stay visible to the
 * substitution check — only `'...'` is literal text to the shell.
 */
function stripSingleQuoted(text: string): string {
  return stripQuotes(text, true);
}

function stripQuotes(text: string, singleOnly: boolean): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === "\\") i += 1;
      continue;
    }
    if (ch === "'" || (!singleOnly && ch === '"')) {
      quote = ch as "'" | '"';
      continue;
    }
    out += ch;
  }
  return out;
}

export function checkReadOnlyCommand(command: string): ReadOnlyVerdict {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: "the command is empty" };

  // A newline is a second command; the rest of these are how one writes.
  if (/[\n\r]/.test(trimmed)) return { ok: false, reason: "it holds more than one line" };
  // Quoted punctuation is data, not structure: `grep "a|b" f` is one stage,
  // `echo "x && y"` is one command. Everything structural below reads the
  // unquoted shape — except substitution, which still fires inside `"..."`.
  const bare = stripQuoted(trimmed);
  // `2>/dev/null` and `2>&1` are how a noisy command is quieted, and models
  // reach for them constantly while exploring. Neither can write a file — the
  // word after `>` names a stream, `/dev/null` or `&` — so they are allowed
  // where a bare `>` would be refused. A redirect to a real path still is.
  // Stripped first, because `2>&1` holds an `&` the chain check would trip on.
  const withoutStderr = bare.replace(/\d?>\s?(&\d?|\/dev\/null)/g, "");
  if (/[<>]/.test(withoutStderr)) return { ok: false, reason: "it redirects input or output (`<` or `>`)" };
  if (withoutStderr.includes("&&") || withoutStderr.includes("||")) {
    return { ok: false, reason: "it chains more than one command (`&&` or `||`)" };
  }
  if (/[;&]/.test(withoutStderr)) return { ok: false, reason: "it chains more than one command (`;` or `&`)" };
  // Single quotes are the only quoting that stops substitution: `"$(...)"`
  // runs, `'$(...)'` prints.
  const unsubstituted = stripSingleQuoted(trimmed);
  if (unsubstituted.includes("$(") || unsubstituted.includes("`")) {
    return { ok: false, reason: "it substitutes the output of another command" };
  }

  const stages = bare.split("|");
  for (const stage of stages) {
    const verdict = checkStage(stage.trim(), stages.length > 1);
    if (!verdict.ok) return verdict;
  }

  return { ok: true };
}

/** One command, or one stage of a pipeline. */
function checkStage(stage: string, piped: boolean): ReadOnlyVerdict {
  if (!stage) return { ok: false, reason: "one stage of the pipeline has no command in it" };

  const tokens = stage.split(/\s+/);
  // `FOO=bar ls` sets a variable for one command. The command is still the
  // thing being classified, so the assignments come off the front first.
  let start = 0;
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start] ?? "")) start += 1;
  const parts = tokens.slice(start);
  const first = (parts[0] ?? "").toLowerCase();

  // A pipeline stage is named in full, so the model can see which part of the
  // line was the problem rather than re-reading the whole thing.
  const subject = piped ? `the pipeline stage \`${stage}\`` : `\`${first}\``;

  if (!first) return { ok: false, reason: "the stage sets a variable but runs no command" };
  if (!READ_ONLY_COMMANDS.has(first) && first !== "git") {
    return { ok: false, reason: `${subject} is not a command KiCode knows only reads` };
  }

  const flag = parts.find((token) => {
    const lower = token.toLowerCase();
    // `-fprint0` / `-fprintf ...` write files like `-fprint` does; the exact
    // token list cannot name every suffix, so those two match by prefix.
    return DANGEROUS_FLAGS.includes(lower) || lower.startsWith("-fprint") || lower.startsWith("-fprintf");
  });
  if (flag) return { ok: false, reason: `${subject} uses \`${flag}\`, which can run or write something` };

  // `sort` only writes through its output flag; every other flag only orders.
  if (first === "sort") {
    const out = parts.find((token) => {
      const lower = token.toLowerCase();
      return lower === "-o" || (lower.startsWith("-o") && lower.length > 2) || lower.startsWith("--output");
    });
    if (out) return { ok: false, reason: `${subject} uses \`${out}\`, which writes to a file` };
  }

  if (first === "git") {
    const sub = (parts[1] ?? "").toLowerCase();
    // `git reflog expire` is the one reported-on subcommand with a writing
    // form, so it is narrowed to the listing on its own.
    if (sub === "reflog") {
      if (parts.length === 2 || (parts[2] ?? "").toLowerCase().startsWith("show")) return { ok: true };
      return { ok: false, reason: "`git reflog expire` writes to the repository" };
    }
    // `branch`, `tag`, `remote` and `config` do both, decided by their
    // arguments: a name creates, and only a listing flag makes a name a filter.
    if (sub === "branch" || sub === "tag" || sub === "remote" || sub === "config") {
      const rest = parts.slice(2);
      const base = (token: string): string => (token.split("=")[0] ?? "").toLowerCase();
      const writing = rest.find((token) => GIT_WRITE_FLAGS.has(base(token)));
      if (writing) return { ok: false, reason: `\`git ${sub} ${writing}\` can change the repository` };
      const positional = rest.filter((token) => !token.startsWith("-"));
      if (sub === "config") {
        // `git config key` prints the value; `git config key value` sets one.
        const reads = rest.some((token) => GIT_CONFIG_READ_FLAGS.has(base(token)));
        if (!reads && positional.length >= 2) {
          return { ok: false, reason: "`git config` with a value writes a setting" };
        }
        return { ok: true };
      }
      const listing = rest.some((token) => GIT_LISTING_FLAGS.has(base(token)));
      if (positional.length > 0 && !listing) {
        return {
          ok: false,
          reason: `\`git ${sub}\` with a name creates one; use \`git ${sub} --list\` to read them`,
        };
      }
      return { ok: true };
    }
    if (!READ_ONLY_GIT.has(sub)) {
      return { ok: false, reason: `${piped ? `the pipeline stage \`git ${sub}\`` : `\`git ${sub}\``} is not a read-only git subcommand` };
    }
  }

  return { ok: true };
}

/** The verdict as a yes or no, for callers that only need the answer. */
export function isReadOnlyCommand(command: string): boolean {
  return checkReadOnlyCommand(command).ok;
}

/**
 * Runs a shell command in the working directory.
 *
 * Gated behind approval — this is the one tool that can do anything to the
 * machine, so the user sees the exact command before it runs. Which shell it
 * runs through is `chooseShell`'s decision, and the model is told what it chose
 * in the Environment section of its instructions.
 */
export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the working directory and return its combined output. Requires the user's approval. The shell is named in the Environment section of your instructions — use its commands, not another platform's. Do not run interactive commands; explain destructive commands before proposing them. In plan mode only commands that provably only read (ls, cat, git status, git diff, and pipelines built from them) are allowed.",
  requiresApproval: true,

  readsOnly(args) {
    return isReadOnlyCommand(stringArg(args.command));
  },

  readOnlyRefusal(args) {
    const verdict = checkReadOnlyCommand(stringArg(args.command));
    return verdict.ok ? null : verdict.reason;
  },

  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      timeout_ms: {
        type: "integer",
        description: `Kill the command after this many milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
      },
    },
    required: ["command"],
  },

  async preview(args) {
    const command = stringArg(args.command).trim();
    return command ? `run: ${command}` : "run: (missing command)";
  },

  async run(args, context): Promise<ToolResult> {
    const command = stringArg(args.command).trim();
    if (!command) return { content: "Error: `command` is required.", isError: true };

    const timeout = clamp(intArg(args.timeout_ms, DEFAULT_TIMEOUT_MS), 1_000, MAX_TIMEOUT_MS);
    // A Git Bash on Windows, `KICODE_SHELL` wherever it is set, and Node's own
    // default otherwise — the same choice the system prompt was told about.
    const shell = chooseShell().shell ?? undefined;

    const outcome = await runShell(command, context.cwd, timeout, shell, context.signal);
    const body = outcome.output.replace(/\s+$/, "");
    const shown = body.length === 0 ? "(no output)" : truncate(body);

    if (outcome.aborted) {
      return { content: `Command stopped because the turn was cancelled.\n${shown}`, isError: true };
    }
    if (outcome.killed) {
      return { content: `Command timed out after ${timeout}ms.\n${shown}`, isError: true };
    }
    if (outcome.exitCode === null) {
      return { content: `Command could not be started: ${outcome.failure ?? "unknown error"}\n${shown}`, isError: true };
    }
    return { content: `Exit code ${outcome.exitCode}.\n${shown}`, isError: outcome.exitCode !== 0 };
  },
};

function runShell(
  command: string,
  cwd: string,
  timeout: number,
  shell: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout,
        // SIGKILL maps to TerminateProcess on Windows; SIGTERM there can leave
        // a hung child behind.
        killSignal: "SIGKILL",
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
        ...(shell ? { shell } : {}),
        // The turn's signal: Ctrl+C aborts it, and Node kills the child for us
        // rather than leaving a hung command to outlive the turn that ran it.
        ...(signal ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        const aborted = signal?.aborted === true;
        if (!error) {
          resolve({ exitCode: 0, killed: false, aborted: false, output, failure: null });
          return;
        }
        const rawCode = (error as { code?: unknown }).code;
        resolve({
          exitCode: typeof rawCode === "number" ? rawCode : null,
          killed: aborted || (error as { killed?: boolean }).killed === true,
          aborted,
          output,
          failure: error.message,
        });
      },
    );
  });
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const omitted = text.length - MAX_OUTPUT_CHARS;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… ${omitted} more characters omitted`;
}
