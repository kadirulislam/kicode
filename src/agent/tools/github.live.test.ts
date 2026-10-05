import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { githubTool } from "./github";

const run = (args: Record<string, unknown>) => githubTool.run(args, { cwd: process.cwd() } as never);

/**
 * A generous per-test timeout, because these make real network calls.
 *
 * Vitest's default is 5s, which a `gh api` over a slow connection on a loaded
 * machine can exceed — and the failure that produces is a lie about the code
 * rather than about the network. Caught by watching one of these time out under
 * load while every unit test passed.
 */
const LIVE_TIMEOUT = 30_000;

/**
 * Whether this machine can actually answer.
 *
 * These tests call the real API, so they need `gh` installed *and* signed in —
 * neither of which holds on CI or on a fresh checkout. Without this guard the file
 * would fail for everyone who has not run `gh auth login`, which is the opposite
 * of what a test is for.
 *
 * Checked once, synchronously, because a `describe` cannot await.
 */
const available = ((): boolean => {
  try {
    execFileSync("gh", ["api", "user", "--jq", ".login"], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
})();

if (!available) {
  // eslint-disable-next-line no-console -- the reason for the skip, printed once.
  console.log("[skip] github live tests: `gh` is not installed or not signed in");
}

describe.skipIf(!available)("github, against the real CLI", () => {
  it("reads the signed-in user", async () => {
    const result = await run({ path: "/user", jq: "{login, name, public_repos}" });
    // Not asserted for content: this machine's account is not the test's to
    // depend on. Asserted for the thing that actually breaks — that the leading
    // slash survives and the call comes back as JSON rather than a path error.
    expect(result.isError ?? false).toBe(false);
    expect(result.content).toMatch(/login/);
    expect(result.content).not.toMatch(/No such file|is a directory|cannot find the path/i);
  }, LIVE_TIMEOUT);

  it("filters with jq so the payload stays small", async () => {
    const whole = await run({ path: "/user" });
    const filtered = await run({ path: "/user", jq: ".login" });

    expect(filtered.isError ?? false).toBe(false);
    // The point of the argument: a filter is cheaper than the payload, and it is
    // the reason a big account does not overflow the context.
    expect(filtered.content.length).toBeLessThan(whole.content.length);
  }, LIVE_TIMEOUT);

  it("paginates a list endpoint with a filter, and does not add --slurp", async () => {
    const result = await run({ path: "/user/repos", jq: "length", paginate: true });

    expect(result.isError ?? false).toBe(false);
    // gh rejects `--slurp` alongside `--jq`, so pairing them unconditionally
    // would have broken every paginated filtered query. With a filter gh merges
    // the pages itself, so the answer is the whole count — one number, not one
    // number per page.
    expect(result.content.trim()).toMatch(/^\d+$/);
  }, LIVE_TIMEOUT);

  it("says so when an unfiltered payload is too big, instead of silently cutting it", async () => {
    const result = await run({ path: "/user/repos", paginate: true });

    expect(result.isError ?? false).toBe(false);
    // This account's full repo list is ~300KB, over the cap — so the honest
    // outcome is a truncated body *with a note*, which is also the strongest
    // argument for the `jq` argument above. Silently returning the first 256KB
    // would look like the whole answer.
    expect(result.content).toMatch(/truncated at \d+KB/);
    expect(result.content).toMatch(/jq/);
  }, LIVE_TIMEOUT);

  it("wraps paginated output in one array when there is no filter", async () => {
    const result = await run({ path: "/user/repos", paginate: true });

    expect(result.isError ?? false).toBe(false);
    // Asserted on the opening characters rather than by parsing, because this
    // account's full list is over the cap and truncated — and `per_page` is
    // ignored once `--paginate` is set, so there is no small paginated call to
    // make. `[[` is one slurped array; `[{` would be gh's concatenated pages,
    // which is not valid JSON.
    expect(result.content.trimStart().startsWith("[[")).toBe(true);
  }, LIVE_TIMEOUT);

  it("names the API error for a path that does not exist", async () => {
    const result = await run({ path: "/repos/this-owner-does-not-exist-9f2b/nope" });

    // An API error has to be readable as one. A bare exit code would leave the
    // model guessing whether the path, the auth or the network was at fault.
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/404|Not Found/i);
  }, LIVE_TIMEOUT);
});