/**
 * The `allow` rules as a predicate: which tool calls run without being put to
 * the user.
 *
 * A rule is a prefix matched against a string argument, and it is deliberately
 * literal. A bare prefix match would let `git status; rm -rf /` through on the
 * strength of its first eleven characters, so a value carrying a shell control
 * character never matches at all: the rule names *this command*, not "a command
 * that begins like this one". Anything the rules do not cover still reaches the
 * approval channel, so the failure mode of a wrong rule is a prompt, never a
 * silent write.
 */

/** Characters that let one command mean another, or expand into one. */
const SHELL_CONTROL = /[;&|<>`$(){}[\]\n\r*?~!]/;

export type AllowRules = Record<string, readonly string[]>;

export function allowPredicate(rules: AllowRules): (name: string, args: Record<string, unknown>) => boolean {
  return (name, args) => {
    const prefixes = rules[name];
    if (!prefixes || prefixes.length === 0) return false;

    return Object.values(args).some(
      (value) =>
        typeof value === "string" &&
        !SHELL_CONTROL.test(value) &&
        prefixes.some((prefix) => value.trim().startsWith(prefix)),
    );
  };
}
