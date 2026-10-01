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
