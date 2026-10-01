import { type Span, span } from "./ansi";
import type { Styles } from "./theme";

/**
 * Lightweight, zero-dependency code and diff syntax highlighter for terminal rendering.
 *
 * Scans tokens per line to apply themed ANSI styles without slowing down streaming
 * or introducing external AST/grammar dependencies.
 */

const JS_KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "export", "extends",
  "finally", "for", "from", "function", "if", "implements", "import", "in",
  "instanceof", "interface", "let", "new", "of", "package", "private",
  "protected", "public", "return", "static", "super", "switch", "this",
  "throw", "try", "typeof", "var", "void", "while", "with", "yield",
]);

const PYTHON_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue",
  "def", "del", "elif", "else", "except", "finally", "for", "from",
  "global", "if", "import", "in", "is", "lambda", "nonlocal", "not",
  "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

const GO_KEYWORDS = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else",
  "fallthrough", "for", "func", "go", "goto", "if", "import", "interface",
  "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
]);

const RUST_KEYWORDS = new Set([
  "as", "async", "await", "break", "const", "continue", "crate", "dyn",
  "else", "enum", "extern", "fn", "for", "if", "impl", "in", "let",
  "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self",
  "Self", "static", "struct", "super", "trait", "type", "unsafe", "use",
  "where", "while",
]);

const BASH_KEYWORDS = new Set([
  "case", "do", "done", "elif", "else", "esac", "fi", "for", "function",
  "if", "in", "select", "then", "until", "while", "export", "local", "source",
  "alias", "echo", "exit", "return", "set", "unset", "cd", "pwd", "grep",
  "find", "git", "npm", "node", "npx", "cargo", "docker", "cat", "curl",
]);

const COMMON_TYPES = new Set([
  "string", "number", "boolean", "symbol", "bigint", "void", "any", "unknown", "never",
  "object", "Promise", "Array", "Record", "Map", "Set", "Function", "Error",
  "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64",
  "float", "float32", "float64", "bool", "byte", "rune", "str", "list", "dict", "tuple",
  "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize",
  "f32", "f64", "Option", "Result", "String", "Vec", "Box",
]);

const LITERALS = new Set([
  "true", "false", "null", "undefined", "NaN", "Infinity", "nil", "None", "True", "False", "Some", "None", "Ok", "Err",
]);

export type SupportedLang =
  | "ts"
  | "js"
  | "python"
  | "bash"
  | "json"
  | "go"
  | "rust"
  | "diff"
  | "sql"
  | "generic";

/** Normalizes language identifier from markdown fence tags (e.g., ```typescript -> ts). */
export function normalizeLanguage(lang: string | undefined): SupportedLang {
  if (!lang) return "generic";
  const tag = lang.trim().toLowerCase();
  if (/^(typescript|ts|tsx)$/.test(tag)) return "ts";
  if (/^(javascript|js|jsx|mjs|cjs)$/.test(tag)) return "js";
  if (/^(python|py)$/.test(tag)) return "python";
  if (/^(bash|sh|zsh|shell)$/.test(tag)) return "bash";
  if (/^(json|jsonc)$/.test(tag)) return "json";
  if (/^(golang|go)$/.test(tag)) return "go";
  if (/^(rust|rs)$/.test(tag)) return "rust";
  if (/^(diff|patch)$/.test(tag)) return "diff";
  if (/^sql$/.test(tag)) return "sql";
  return "generic";
}

/** Highlights a single line of text with ANSI spans according to language syntax. */
export function highlightLine(line: string, lang: SupportedLang, styles: Styles): Span[] {
  if (!line) return [];

  // Special-case diffs
  if (lang === "diff") {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return [span(line, styles.ok)];
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return [span(line, styles.error)];
    }
    if (line.startsWith("@@")) {
      return [span(line, styles.accent)];
    }
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
      return [span(line, styles.dim)];
    }
    return [span(line, styles.text)];
  }

  // Special-case JSON
  if (lang === "json") {
    return highlightJsonLine(line, styles);
  }

  // Bash/Shell comment or prompt
  if (lang === "bash") {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#")) {
      const indent = line.slice(0, line.length - trimmed.length);
      return [span(indent), span(trimmed, styles.dim)];
    }
    if (trimmed.startsWith("$ ")) {
      const indent = line.slice(0, line.length - trimmed.length);
      return [span(indent), span("$ ", styles.accent), ...highlightGenericLine(trimmed.slice(2), lang, styles)];
    }
  }

  return highlightGenericLine(line, lang, styles);
}

function highlightJsonLine(line: string, styles: Styles): Span[] {
  const spans: Span[] = [];
  const regex = /("(?:\\.|[^"\\])*")|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)|([:{},[\]])/g;
  let last = 0;

  for (const match of line.matchAll(regex)) {
    const at = match.index ?? 0;
    if (at > last) spans.push(span(line.slice(last, at), styles.text));
    const [full, str, num, lit, punct] = match;

    if (str) {
      // If immediately followed by colon, this is a property key
      const after = line.slice(at + str.length).trimStart();
      if (after.startsWith(":")) {
        spans.push(span(str, styles.accent));
      } else {
        spans.push(span(str, styles.ok));
      }
    } else if (num || lit) {
      spans.push(span(full, styles.warn));
    } else if (punct) {
      spans.push(span(punct, styles.dim));
    }
    last = at + full.length;
  }

  if (last < line.length) spans.push(span(line.slice(last), styles.text));
  return spans;
}

function getKeywordSet(lang: SupportedLang): Set<string> {
  switch (lang) {
    case "python": return PYTHON_KEYWORDS;
    case "go": return GO_KEYWORDS;
    case "rust": return RUST_KEYWORDS;
    case "bash": return BASH_KEYWORDS;
    default: return JS_KEYWORDS;
  }
}

function highlightGenericLine(line: string, lang: SupportedLang, styles: Styles): Span[] {
  const spans: Span[] = [];
  const keywords = getKeywordSet(lang);

  // Pattern matches:
  // 1: Line comments (// ... or # ...)
  // 2: Strings ("...", '...', `...`)
  // 3: Numbers (hex, float, int)
  // 4: Words / Identifiers
  // 5: Operators / Punctuation
  const commentPrefix = lang === "python" || lang === "bash" ? "#" : "//";
  const regex = new RegExp(
    `(${commentPrefix}.*$)` +
    `|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)` +
    `|(\\b0x[0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?\\b)` +
    `|(\\b[a-zA-Z_$][a-zA-Z0-9_$]*\\b)` +
    `|([{}()\\[\\].,:;=+\\-*/%&|^!~<>?]+)`,
    "g",
  );

  let last = 0;
  for (const match of line.matchAll(regex)) {
    const at = match.index ?? 0;
    if (at > last) spans.push(span(line.slice(last, at), styles.text));

    const [full, comment, str, num, word, punct] = match;

    if (comment) {
      spans.push(span(comment, styles.dim));
    } else if (str) {
      spans.push(span(str, styles.ok));
    } else if (num) {
      spans.push(span(num, styles.warn));
    } else if (word) {
      if (keywords.has(word)) {
        spans.push(span(word, styles.accent));
      } else if (LITERALS.has(word)) {
        spans.push(span(word, styles.warn));
      } else if (COMMON_TYPES.has(word) || /^[A-Z][a-zA-Z0-9_$]*$/.test(word)) {
        // Types or PascalCase classes/interfaces
        spans.push(span(word, styles.emphasis));
      } else {
        // Check if followed by open parenthesis (function call)
        const rest = line.slice(at + word.length).trimStart();
        if (rest.startsWith("(")) {
          spans.push(span(word, styles.code));
        } else {
          spans.push(span(word, styles.text));
        }
      }
    } else if (punct) {
      spans.push(span(punct, styles.dim));
    }

    last = at + full.length;
  }

  if (last < line.length) spans.push(span(line.slice(last), styles.text));
  return spans;
}
