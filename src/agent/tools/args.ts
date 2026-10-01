/** Argument coercion shared by the tools. Models emit loose JSON; be forgiving. */

export function stringArg(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function intArg(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return fallback;
}

export function boolArg(value: unknown): boolean {
  return value === true;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
