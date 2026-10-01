import { type Span, INVERSE, style, textWidth } from "./ansi";
import type { Styles } from "./theme";

/**
 * The prompt line: text, a caret position, the recall history, and an optional
 * text selection (for Ctrl+A / Ctrl+X / Ctrl+C inside the editor).
 *
 * Cursor positions are code-unit offsets, which is what `slice` wants; the
 * renderer converts the offset to a cell column, so a line containing CJK or
 * emoji still puts the caret in the right place.
 */

const MAX_HISTORY = 100;

export class LineEditor {
  text = "";
  cursor = 0;
  /** Start of the editor selection (code-unit offset), or null when nothing is selected. */
  selectionStart: number | null = null;
  /** End of the editor selection (code-unit offset), or null. Always >= selectionStart when set. */
  selectionEnd: number | null = null;
  private history: string[] = [];
  /** Index into `history` while recalling, or null when editing a fresh line. */
  private recalling: number | null = null;

  get value(): string {
    return this.text;
  }

  setText(text: string, cursor = text.length): void {
    this.text = text;
    this.cursor = Math.max(0, Math.min(cursor, text.length));
    this.clearSelection();
  }

  clear(): void {
    this.text = "";
    this.cursor = 0;
    this.recalling = null;
    this.clearSelection();
  }

  insert(input: string): void {
    // Pasting a whole prompt should not smuggle in a newline that submits it.
    const clean = input.replace(/\r?\n/g, " ");
    if (!clean) return;
    // If there is a selection, replace it with the input.
    if (this.hasSelection()) {
      const [start, end] = this.selectionRange();
      this.text = this.text.slice(0, start) + clean + this.text.slice(end);
      this.cursor = start + clean.length;
      this.clearSelection();
    } else {
      this.text = this.text.slice(0, this.cursor) + clean + this.text.slice(this.cursor);
      this.cursor += clean.length;
    }
    this.recalling = null;
  }

  backspace(): void {
    if (this.hasSelection()) {
      this.deleteSelection();
      return;
    }
    if (this.cursor === 0) return;
    this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
    this.cursor -= 1;
  }

  deleteForward(): void {
    if (this.hasSelection()) {
      this.deleteSelection();
      return;
    }
    if (this.cursor >= this.text.length) return;
    this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
  }

  left(): void {
    this.clearSelection();
    this.cursor = Math.max(0, this.cursor - 1);
  }

  right(): void {
    this.clearSelection();
    this.cursor = Math.min(this.text.length, this.cursor + 1);
  }

  home(): void {
    this.clearSelection();
    this.cursor = 0;
  }

  end(): void {
    this.clearSelection();
    this.cursor = this.text.length;
  }

  /** Deletes from the start of the line to the caret. */
  killToStart(): void {
    this.text = this.text.slice(this.cursor);
    this.cursor = 0;
    this.clearSelection();
  }

  // ---- selection support ---------------------------------------------------

  /** Selects all text in the editor (Ctrl+A). */
  selectAll(): void {
    if (this.text.length === 0) return;
    this.selectionStart = 0;
    this.selectionEnd = this.text.length;
    this.cursor = this.text.length;
  }

  /** Whether there is an active selection with non-zero length. */
  hasSelection(): boolean {
    return (
      this.selectionStart !== null &&
      this.selectionEnd !== null &&
      this.selectionStart !== this.selectionEnd
    );
  }

  /** Returns [start, end] normalised so start <= end. */
  selectionRange(): [number, number] {
    const a = this.selectionStart ?? this.cursor;
    const b = this.selectionEnd ?? this.cursor;
    return a <= b ? [a, b] : [b, a];
  }

  /** The selected text, or empty string. */
  selectedText(): string {
    if (!this.hasSelection()) return "";
    const [start, end] = this.selectionRange();
    return this.text.slice(start, end);
  }

  /** Deletes the selected text and places the cursor at the start. */
  deleteSelection(): void {
    if (!this.hasSelection()) return;
    const [start, end] = this.selectionRange();
    this.text = this.text.slice(0, start) + this.text.slice(end);
    this.cursor = start;
    this.clearSelection();
  }

  /** Clears the selection without changing text. */
  clearSelection(): void {
    this.selectionStart = null;
    this.selectionEnd = null;
  }

  // ---- history -------------------------------------------------------------

  acceptHistory(line: string): void {
    if (!line.trim()) return;
    if (this.history.at(-1) === line) return;
    this.history.push(line);
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }

  historyPrev(): void {
    if (this.history.length === 0) return;
    const next = this.recalling === null ? this.history.length - 1 : Math.max(0, this.recalling - 1);
    this.recalling = next;
    this.setText(this.history[next] ?? "");
  }

  historyNext(): void {
    if (this.recalling === null) return;
    const next = this.recalling + 1;
    if (next >= this.history.length) {
      this.recalling = null;
      this.clear();
      return;
    }
    this.recalling = next;
    this.setText(this.history[next] ?? "");
  }
}

/** Caret column in cells, given the text before it. */
export function caretColumn(editor: LineEditor): number {
  return textWidth(editor.text.slice(0, editor.cursor));
}

export type EditorView = { spans: Span[]; caret: number };

/**
 * What the prompt line shows: the typed text, or the placeholder while empty.
 * The caret is returned separately because it is a real terminal cursor.
 *
 * When the editor has a selection, the selected range is drawn in reverse video
 * so it is visible at a glance — the same highlight used for transcript drags.
 */
export function editorView(editor: LineEditor, styles: Styles, width: number, placeholder: string): EditorView {
  if (editor.text.length === 0) {
    const hint = placeholder.length > width ? `${placeholder.slice(0, Math.max(width - 1, 1))}…` : placeholder;
    return { spans: [{ text: hint, style: styles.hint }], caret: 0 };
  }

  if (editor.hasSelection()) {
    const [start, end] = editor.selectionRange();
    const spans: Span[] = [];
    const before = editor.text.slice(0, start);
    const selected = editor.text.slice(start, end);
    const after = editor.text.slice(end);
    if (before) spans.push({ text: before, style: styles.text });
    if (selected) spans.push({ text: selected, style: style(INVERSE) });
    if (after) spans.push({ text: after, style: styles.text });
    return { spans, caret: caretColumn(editor) };
  }

  return { spans: [{ text: editor.text, style: styles.text }], caret: caretColumn(editor) };
}
