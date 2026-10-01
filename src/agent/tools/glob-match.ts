/**
 * Glob → RegExp for the subset a coding agent actually needs:
 * `*`, `**`, `?`, `{a,b}`, and `[abc]`.
 *
 * Patterns are matched against paths with `/` separators, so this is
 * platform-independent.
 */

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//, "").split("\\").join("/");
  let source = "^";

  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index] ?? "";

    if (char === "*") {
      if (normalized[index + 1] === "*") {
        index++;
        if (normalized[index + 1] === "/") {
          index++;
          // `**/` must also match zero directories, so `**/x` finds a top-level `x`.
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    if (char === "{") {
      const close = normalized.indexOf("}", index);
      if (close !== -1) {
        const options = normalized
          .slice(index + 1, close)
          .split(",")
          .map((option) => escapeRegExp(option));
        source += `(?:${options.join("|")})`;
        index = close;
        continue;
      }
      source += "\\{";
      continue;
    }

    if (char === "[") {
      const close = normalized.indexOf("]", index);
      if (close !== -1) {
        source += normalized.slice(index, close + 1);
        index = close;
        continue;
      }
      source += "\\[";
      continue;
    }

    source += escapeRegExp(char);
  }

  return new RegExp(`${source}$`);
}

/** Paths are compared with forward slashes regardless of platform. */
export function toPosix(value: string): string {
  return value.split("\\").join("/");
}
