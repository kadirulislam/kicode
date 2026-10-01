import { type Span, span } from "./ansi";
import { highlightLine, normalizeLanguage, type SupportedLang } from "./syntax";
import type { Styles } from "./theme";

/**
 * A markdown renderer with zero-dependency syntax highlighting for code fences.
 *
 * Models write markdown; a terminal shows the asterisks. This covers what
 * actually shows up in an answer — fenced code blocks with language-aware syntax
 * coloring, bold, inline code, headings, bullets, links — and leaves everything
 * else as typed, because half-rendering a document is worse than not rendering it.
 *
 * `_underscores_` are deliberately *not* italicised: in a coding agent they are
 * overwhelmingly snake_case identifiers (`show_if`, `my_file.ts`), and mangling
 * those is far worse than losing one emphasis style.
 */

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\))/g;

export function markdownSpans(text: string, styles: Styles): Span[] {
  const spans: Span[] = [];
  let inFence = false;
  let fenceLang: SupportedLang = "generic";
  let fenceTag = "";

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (index > 0) spans.push(span("\n"));

    // Check for fenced code block boundary (``` or ~~~)
    const fenceMatch = /^\s*(`{3,}|~{3,})\s*([a-zA-Z0-9_.-]*)/.exec(line);

    if (fenceMatch) {
      if (!inFence) {
        // Entering fence
        inFence = true;
        fenceTag = fenceMatch[1] ?? "```";
        const rawLang = fenceMatch[2] ?? "";
        fenceLang = normalizeLanguage(rawLang);
        spans.push(span("  ╭─ ", styles.rule));
        spans.push(span(rawLang || "code", styles.dim));
        continue;
      } else if (line.trim().startsWith(fenceTag[0] ?? "`")) {
        // Closing fence
        inFence = false;
        spans.push(span("  ╰──", styles.rule));
        continue;
      }
    }

    if (inFence) {
      // Line inside code block: gutter rule + syntax-highlighted tokens
      spans.push(span("  │ ", styles.rule));
      spans.push(...highlightLine(line, fenceLang, styles));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      spans.push(span(heading[2] ?? "", styles.accentBold));
      continue;
    }

    // `- item` and `* item` become a real bullet. The marker is consumed here
    // so a bullet is never mistaken for the start of *emphasis*.
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      const indent = (line.length - line.trimStart().length) > 1 ? "  " : "";
      spans.push(span(`${indent}• `, styles.accent));
      spans.push(...inline(bullet[1] ?? "", styles));
      continue;
    }

    spans.push(...inline(line, styles));
  }

  return spans;
}

function inline(text: string, styles: Styles): Span[] {
  const spans: Span[] = [];
  let last = 0;

  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) spans.push(span(text.slice(last, at)));
    const token = match[0];

    if (token.startsWith("**")) {        // Emphasis is its own colour, not just a weight: the word that matters
        // in a sentence should not look like chrome.
        spans.push(span(token.slice(2, -2), styles.emphasis));
    } else if (token.startsWith("`")) {
      spans.push(span(token.slice(1, -1), styles.code));
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      spans.push(span(link?.[1] ?? token));
      // The URL stays visible: terminals are not clickable everywhere, and a
      // bare label loses information.
      if (link?.[2]) spans.push(span(` (${link[2]})`, styles.hint));
    } else {
      spans.push(span(token.slice(1, -1), styles.italic));
    }

    last = at + token.length;
  }

  if (last < text.length) spans.push(span(text.slice(last)));
  return spans;
}

/** Collapses runs of blank lines and trims trailing whitespace. */
export function tidy(text: string): string {
  return text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "");
}
