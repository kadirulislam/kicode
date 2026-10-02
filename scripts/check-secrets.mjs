#!/usr/bin/env node
/**
 * Refuses to commit anything shaped like a live credential.
 *
 * A key that reaches a commit has to be rotated: taking it out afterwards means
 * rewriting every commit that carried it and hoping nobody had cloned in the
 * meantime. That is expensive and it is not reversible, so this is the cheap
 * gate in front of it. It reads what is **staged**, because that is exactly what
 * the commit would contain — not what happens to be on disk, which is not what
 * is about to be published.
 *
 * It is a shape check, not a scanner. It knows the prefixes real providers
 * issue, and it names the one it found. Anything it cannot recognise is
 * something it will not stop, and no amount of pattern-writing fixes that: the
 * real guard is never having the key in a shell that commits.
 *
 * A fixture that must contain one of these shapes says so on the line, with
 * `kicode-secret-ok`. That is a deliberate, reviewable act — the whole point is
 * that a key cannot arrive by accident and cannot arrive quietly.
 *
 * Usage:
 *   node scripts/check-secrets.mjs           # what is staged (the pre-commit hook)
 *   node scripts/check-secrets.mjs --all     # every tracked file (CI)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Written on a line to say its key shape is a fixture, not a credential. */
const ALLOW = "kicode-secret-ok";

/**
 * The prefixes that are worth recognising, and what to call them.
 *
 * Ordered so a specific prefix is tried before a general one: `sk-ant-` and
 * `sk-proj-` would otherwise be swallowed by the plain `sk-` rule and reported
 * under the wrong name.
 */
const PATTERNS = [
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["an Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["an OpenAI project key", /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}\b/],
  ["an OpenAI-style key", /\bsk-[A-Za-z0-9]{20,}\b/],
  ["a GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["a GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{30,}\b/],
  ["an AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["a Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["a Stripe secret key", /\b[rs]k_live_[A-Za-z0-9]{20,}\b/],
  ["a SendGrid key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/],
  ["an OpenCode key", /\boc_sk_[A-Za-z0-9_]{20,}\b/],
  ["an Experiential Labs key", /\bxpl_[A-Za-z0-9]{20,}\b/],
  ["a Kenari key", /\bkn-[A-Za-z0-9]{30,}\b/],
  ["a JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Never echo a credential in full: enough to find it, not enough to use it. */
const mask = (value) => (value.length <= 8 ? `${value.slice(0, 2)}…` : `${value.slice(0, 8)}…`);

export function scan(text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.includes(ALLOW)) return;
    for (const [name, pattern] of PATTERNS) {
      const match = pattern.exec(line);
      if (match) {
        found.push({ line: index + 1, name, sample: mask(match[0]) });
        return;
      }
    }
  });
  return found;
}

function main() {
  const all = process.argv.includes("--all");
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  const listed = all
    ? git(["ls-files"])
    : git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);

  const files = listed.split("\n").map((name) => name.trim()).filter(Boolean);
  const hits = [];

  for (const file of files) {
    let content;
    try {
      // Staged content in both modes: in `--all` it is the same as the working
      // tree for a clean checkout, and in the hook it is the only thing that is
      // actually about to be committed.
      content = all ? readFileSync(path.join(root, file), "utf8") : git(["show", `:${file}`]);
    } catch {
      continue; // deleted since it was listed, or unreadable
    }
    if (content.includes("\u0000")) continue; // binary
    for (const hit of scan(content)) hits.push({ file, ...hit });
  }

  if (hits.length === 0) return 0;

  console.error(`\n  ${hits.length} value${hits.length === 1 ? "" : "s"} in this commit look like a live credential:\n`);
  for (const hit of hits) console.error(`    ${hit.file}:${hit.line}  ${hit.name}  ${hit.sample}`);
  console.error(
    [
      "",
      "  A key that reaches a commit has to be rotated, so this commit is refused.",
      "",
      "    · If it is real: take it out, and rotate it — it is already exposed.",
      "    · If it is a fixture: put `" + ALLOW + "` on that line to say so.",
      "",
    ].join("\n"),
  );
  return 1;
}

// Importable for tests without running the check.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(main());
}
