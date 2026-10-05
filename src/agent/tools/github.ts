import { execFile } from "node:child_process";
import { clamp, intArg } from "./args";
import type { Tool, ToolResult } from "./types";

/** Enough JSON to answer most questions, and not enough to flood a context. */
const MAX_BYTES = 256 * 1024;
const MIN_TIMEOUT = 1_000;
const MAX_TIMEOUT = 300_000;
const DEFAULT_TIMEOUT = 60_000;

/**
 * An API path, as `gh api` itself defines one.
 *
 * Deliberately narrow, because this string is the whole of the tool's authority:
 * it is what decides whether the call stays on api.github.com or becomes a local
 * file read.
 *
 * - Must begin with a single `/`. A leading `//` is protocol-relative, and a
 *   `scheme:` is an absolute URL — either would send an authenticated request
 *   somewhere that is not GitHub, with the user's token attached.
 * - `@` is refused. `gh api @notes.json` reads that file from disk and sends its
 *   contents as the request body, which would turn a read-only tool into a way
 *   to exfiltrate any file the agent can read.
 * - No whitespace or shell punctuation. Nothing here is ever passed to a shell,
 *   but a path with a space in it is nearly always a mistake rather than a
 *   deliberate API call, and refusing it says so instead of 404ing later.
 */
const PATH_PATTERN = /^\/[A-Za-z0-9._~%+,:=/-]*$/;

/** What the model is told when the path is refused, naming the actual problem. */
function pathProblem(value: string): string | null {
  if (value === "") return "a path is required";

  // Most specific first, because the first refusal wins and the generic one is
  // the least useful. A full URL also fails the leading-slash test, so checking
  // that first answered "you forgot a slash" to someone who had actually written
  // a URL to somewhere else entirely — the case where naming the real problem
  // matters most.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) || /^[a-zA-Z][a-zA-Z0-9+.-]*:[^/]/.test(value)) {
    return "give a GitHub API path like /user/repos, not a full URL — this tool only talks to api.github.com.";
  }
  if (value.startsWith("//")) {
    return 'a path beginning with "//" is protocol-relative, not a GitHub API path.';
  }
  if (value.includes("@")) {
    return '"@" is refused: gh would read that name as a local file and send its contents.';
  }
  if (!value.startsWith("/")) {
    return `paths must begin with "/" — got "${value}".`;
  }
  if (!PATH_PATTERN.test(value)) {
    return "paths may use letters, digits and / _ - . ~ : % + , = only.";
  }
  return null;
}

/**
 * Reads the GitHub API through the `gh` CLI.
 *
 * This exists because a child agent cannot run `bash` — deliberately, since a
 * child has no approval channel (ADR-053) — which left `cody-git` unable to do
 * the one thing it exists for. The obvious fix, a `bash` restricted to `gh`, was
 * rejected: a read-only verdict about a *shell command* is a denylist trying to
 * parse a language it does not own, and it is a much weaker guarantee for a child
 * with nobody watching than it is for a parent with a human and a diff in front
 * of them.
 *
 * So there is no shell here at all. `gh` is executed directly with an argument
 * vector, which means there is no command line to inject a second command into —
 * `path: "/user/repos; rm -rf ~"` is not a shell, it is a request for a
 * repository that does not exist. That is safety by construction rather than by
 * inspection, and it is why the answer to "can this be tricked" is a property of
 * how the process is started instead of a list of things to remember to block.
 *
 * Two consequences of starting the process directly, worth stating because they
 * are the usual Windows failure here:
 *
 * - **No MSYS path conversion.** Git Bash rewrites an argument beginning with `/`
 *   into a Windows path, so `gh api /user/repos` under Git Bash becomes a request
 *   for `C:\Program Files\Git\user\repos`. That rewrite is a feature of the shell
 *   interpreting its arguments. There is no shell here, so it cannot happen — which
 *   is why the canonical leading slash is *required* rather than something to work
 *   around. A model that has learned to drop the slash from a session that ran the
 *   command through a shell would otherwise get a confusing 404 here; the error
 *   text below names this case for exactly that reason.
 * - **No credential in the output.** `gh` resolves its own token from its config;
 *   this never sees it, so there is nothing here to redact.
 */
export const githubTool: Tool = {
  name: "github",
  description: [
    "Read the GitHub REST API through the authenticated `gh` CLI: the signed-in user, their repos,",
    "org memberships, issues, pull requests, workflow runs, search — anything under api.github.com.",
    "Use it for questions about a GitHub account or repository that the files on disk cannot answer.",
    "Give a path beginning with a slash, e.g. /user, /user/repos, /repos/OWNER/NAME/issues.",
    "Add `jq` to filter server-side rather than reading the whole payload, and `paginate` for a list",
    "that spans pages. This reads only: there is no way to write, comment, or merge anything.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: 'API path beginning with "/", e.g. "/user" or "/repos/facebook/react/issues".',
      },
      jq: {
        type: "string",
        description:
          "Optional jq filter applied by gh before you see the output — `.[].full_name`, `.login`, " +
          "`.[] | {name, private}`. Filtering server-side is much cheaper than reading everything.",
      },
      paginate: {
        type: "boolean",
        description: "Follow every page of a list endpoint and return them as one array. Off by default.",
      },
      timeout_ms: {
        type: "number",
        description: `Milliseconds before giving up. Defaults to ${DEFAULT_TIMEOUT}.`,
      },
    },
    required: ["path"],
  },

  /**
   * Reads only, so it may overlap the other reads in a turn.
   *
   * Not gated: it cannot change anything, and it reads the same kind of thing
   * `read` does — the user's own account. It does carry the user's GitHub token,
   * which is why `path` is validated rather than passed through: the token goes
   * to whatever host the URL names, and only api.github.com is ever intended.
   */
  concurrencySafe: true,

  async run(args, context): Promise<ToolResult> {
    const requested = typeof args.path === "string" ? args.path.trim() : "";
    const problem = pathProblem(requested);
    if (problem) return { content: `Error: ${problem}`, isError: true };

    const jq = typeof args.jq === "string" ? args.jq.trim() : "";
    // `$ENV` is the one thing a jq program can reach that this tool otherwise
    // cannot. `gh` keeps the user's token in the process environment, so
    // `jq: "$ENV"` would print it into the output — into the transcript, and
    // onward to the provider. `read` has no equivalent, because a file is not a
    // process environment, so this would be a way *around* a child's isolation
    // rather than inside it.
    //
    // Refused rather than rewritten: a filter silently altered would produce a
    // wrong answer where a refusal produces an honest one.
    if (/\$ENV|input_filename/.test(jq)) {
      return {
        content:
          "Error: `$ENV` and `input_filename` are not allowed in `jq` here — they would read this process's " +
          "environment and filesystem into the output. Filter the API response instead.",
        isError: true,
      };
    }
    const paginate = args.paginate === true;
    const timeout = clamp(intArg(args.timeout_ms, DEFAULT_TIMEOUT), MIN_TIMEOUT, MAX_TIMEOUT);

    // The argument vector, built one entry at a time. Nothing is concatenated into
    // a command line and nothing is interpolated into one, which is the whole
    // reason this tool is safe to hand to a child.
    const argv = ["api", requested];
    if (jq) argv.push("--jq", jq);
    if (paginate) {
      argv.push("--paginate");
      // `--slurp`, but **only** when there is no filter — and gh rejects the two
      // together outright ("the `--slurp` option is not supported with `--jq`"), so
      // pairing them unconditionally would have made every paginated filtered query
      // fail. Found by running it, not by reading it.
      //
      // The paths differ because gh itself differs. With a `--jq` filter it already
      // merges the pages before filtering: `--paginate --jq length` returns the whole
      // count rather than one number per page. Without a filter it emits one JSON
      // document per page, concatenated — not valid JSON — so `--slurp` is what
      // makes it one array.
      if (!jq) argv.push("--slurp");
    }

    const outcome = await runGh(argv, context.cwd, timeout, context.signal ?? new AbortController().signal);
    if (!outcome.ok) return { content: outcome.error, isError: true };

    const body = outcome.stdout.trim();
    if (body === "") {
      // gh writes nothing on some successful calls. Saying "empty" is honest;
      // returning nothing would leave the model guessing.
      return { content: `\`gh api ${requested}\` returned no output. The path may have no data, or gh may have written nothing.` };
    }

    const notes: string[] = [];
    let text = body;
    if (outcome.stdout.length > MAX_BYTES) {
      text = body.slice(0, MAX_BYTES);
      notes.push(
        `output truncated at ${Math.round(MAX_BYTES / 1024)}KB — narrow the path or add a \`jq\` filter`,
      );
    }
    if (outcome.stderr.trim()) notes.push(`gh stderr: ${outcome.stderr.trim().slice(0, 500)}`);

    return { content: notes.length > 0 ? `${text}\n\n[${notes.join("; ")}]` : text };
  },
};

/** What came back from `gh`, or the sentence to show instead of it. */
type GhOutcome = { ok: true; stdout: string; stderr: string } | { ok: false; error: string };

/**
 * Runs `gh` with an argument vector and no shell.
 *
 * `execFile` rather than `exec` is the load-bearing choice: it never hands the
 * arguments to a command interpreter, so nothing in them can become a second
 * command, and no MSYS/Git Bash path rewrite is applied to the leading slash.
 */
function runGh(argv: string[], cwd: string, timeout: number, signal: AbortSignal): Promise<GhOutcome> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      argv,
      { cwd, timeout, signal, maxBuffer: MAX_BYTES * 2, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, stdout: String(stdout), stderr: String(stderr) });
          return;
        }

        const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };

        // Each of these says something different to the model, and the difference
        // is whether the next move is to install something, fix the arguments, or
        // do the work another way.
        if (failure.code === "ENOENT") {
          resolve({
            ok: false,
            error:
              "Error: the GitHub CLI (`gh`) is not installed or not on PATH. Ask the user to install it, " +
              "or work from the repository files on disk instead.",
          });
          return;
        }
        if (signal.aborted) {
          resolve({ ok: false, error: "Error: the GitHub call was cancelled with the turn." });
          return;
        }
        if (failure.killed) {
          resolve({ ok: false, error: `Error: \`gh api\` timed out after ${timeout}ms.` });
          return;
        }

        // gh reports API errors on stderr with a non-zero exit, and the body is the
        // useful part: "Not Found (HTTP 404)" tells the model its path is wrong in
        // a way that the bare exit code never would.
        const detail = String(stderr).trim() || String(stdout).trim();
        resolve({ ok: false, error: `Error: \`gh api\` failed.\n${detail || (error as Error).message}` });
      },
    );
  });
}
