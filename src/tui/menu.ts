/**
 * A full-screen menu: a title, a search field, grouped rows with a value on the
 * right, and a footer that names the keys.
 *
 * The settings panel and the integration list are the same shape, so they are
 * the same component with different rows. Both are what a "modal" is in this
 * TUI — it replaces the transcript rather than floating over it, because the
 * layout has no z-order and choosing from a menu is the only thing left to do
 * while one is open.
 *
 * The rows are already filtered by the caller: this layer draws what it is
 * handed, the same way the picker does, so a search can never disagree with
 * what is on screen.
 */

export type MenuRow = {
  /** What is handed back when this row is taken. */
  value: string;
  label: string;
  /** Pinned right, in the faint colour, so a column of values lines up. */
  trailing?: string;
  /** A heading printed above the first row of a group. */
  group?: string;
  /** Already set up — a tick, the way a connected service is marked. */
  checked?: boolean;
  /** Shown, with its reason, but not choosable. */
  disabled?: boolean;
};

export type MenuPanel = {
  title: string;
  rows: readonly MenuRow[];
  selected: number;
  /** What is in the search field. */
  query: string;
  /** The keys this panel answers to, named on its last row. */
  footer: string;
  /** What the highlighted row does, printed above the footer. */
  description?: string;
  /**
   * The widest description the panel can show, in cells. The card is sized by
   * this instead of by `description`: the sentence changes with every row the
   * cursor lands on, so sizing by the current one resizes the card on every
   * hover. Sized by the longest, every sentence fits and the card never moves.
   */
  descriptionWidth?: number;
};

/**
 * The nearest row the keys may land on, skipping what cannot be chosen.
 *
 * Returns where it started when every row is disabled, so a list of nothing but
 * reasons cannot leave the cursor nowhere.
 */
export function stepMenuRow(rows: readonly MenuRow[], from: number, delta: number): number {
  if (rows.length === 0) return 0;

  const start = Math.min(Math.max(from, 0), rows.length - 1);
  for (let step = 1; step <= rows.length; step++) {
    const index = (((start + delta * step) % rows.length) + rows.length) % rows.length;
    if (!rows[index]?.disabled) return index;
  }
  return start;
}

/** Rows matching what has been typed, searched across every visible field. */
export function filterMenuRows(rows: readonly MenuRow[], query: string): MenuRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) =>
    `${row.label} ${row.group ?? ""} ${row.trailing ?? ""} ${row.value}`.toLowerCase().includes(needle),
  );
}

/** The row under the cursor, or undefined when the list is empty. */
export function selectedRow(rows: readonly MenuRow[], selected: number): MenuRow | undefined {
  return rows[Math.min(Math.max(selected, 0), Math.max(rows.length - 1, 0))];
}

/**
 * An editable form: named fields, each holding a value the user changes.
 *
 * A separate shape from `MenuPanel` because a menu *chooses* from a fixed list
 * and this *edits*. The editor for a subagent has to set a name, a
 * specialisation that is a paragraph rather than a choice, and a permission
 * level — none of which is a row you can step onto.
 */
export type FormFieldKind =
  /** Free text, typed into the editor. */
  | "text"
  /** One of a fixed pair, flipped with enter — permissions, scope. */
  | "toggle"
  /** One of several, stepped with left/right — reserved for a model list. */
  | "choice"
  /** Not a field: a thing you press, like Save or Delete. */
  | "action";

export type FormField = {
  key: string;
  label: string;
  kind: FormFieldKind;
  /** What it holds now. Empty is a real value; an action holds nothing. */
  value: string;
  /**
   * Where the caret sits, in code units into `value`, while this field is being
   * edited.
   *
   * The panel draws from the live editor buffer rather than the saved value, so
   * what you see while typing is what you have typed — a field that only updates
   * when you leave it looks frozen, and reads as though the keyboard is dead.
   * Absent when the field is not being edited.
   */
  caret?: number;
  /** The choices, for `toggle` and `choice`. The first is the default. */
  options?: readonly string[];
  /** One line under the field, saying what it is for. */
  hint?: string;
  /** Why this field cannot be used yet, when it cannot. */
  problem?: string;
  /** An action that needs confirming before it runs. */
  danger?: boolean;
};

export type FormPanel = {
  title: string;
  /** A line under the title — what this form is editing. */
  subtitle?: string;
  fields: readonly FormField[];
  selected: number;
  /** True while the cursor is in a text field rather than on the list. */
  editing: boolean;
  /** The keys this panel answers to, named on its last row. */
  footer: string;
  /** Why it will not save yet, or what the last save attempt said. */
  error?: string | null;
};

/**
 * The nearest field the keys may land on, wrapping at both ends.
 *
 * Every field is reachable, unlike a menu where a disabled row is skipped: a
 * field that is not usable yet is still a field, and a cursor that skips it
 * leaves the user with no way to see why their name is not accepted.
 */
export function stepFormField(fields: readonly FormField[], from: number, delta: number): number {
  if (fields.length === 0) return 0;
  const start = Math.min(Math.max(from, 0), fields.length - 1);
  return (((start + delta) % fields.length) + fields.length) % fields.length;
}

/**
 * A field's value after a toggle or a choice moved by `delta`.
 *
 * Returns the current value untouched when there is nothing to step through, so
 * a caller can treat "no options" and "one option" the same way.
 */
export function stepFormValue(field: FormField, delta: number): string {
  const options = field.options ?? [];
  if (options.length < 2) return field.value;
  const at = options.indexOf(field.value);
  const next = (((at < 0 ? 0 : at) + delta) % options.length + options.length) % options.length;
  return options[next] ?? field.value;
}
