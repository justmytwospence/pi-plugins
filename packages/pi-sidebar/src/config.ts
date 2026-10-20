// Sidebar's settings (environment variables read where main starts) and its layout arithmetic.

export const KEYS_ENV = "PI_SIDEBAR_KEYS";
export const RATIO_ENV = "PI_SIDEBAR_RATIO";
export const MIN_COLUMNS_ENV = "PI_SIDEBAR_MIN_COLUMNS";
export const FOCUS_KEYS_ENV = "PI_SIDEBAR_FOCUS_KEYS";
export const DEFAULT_KEYS = ["ctrl+'"];
export const DEFAULT_RATIO = 0.5;
export const DEFAULT_MIN_COLUMNS = 80;

export function parseKeys(raw: string | undefined): string[] {
  const keys = (raw ?? "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  return keys.length ? keys : [...DEFAULT_KEYS];
}

/** Optional keys that switch focus between main and Sidebar (none by default). */
export function parseFocusKeys(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
}

export function parseRatio(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0.15 && n <= 0.85 ? n : DEFAULT_RATIO;
}

export function parseMinColumns(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 20 && n <= 400 ? n : DEFAULT_MIN_COLUMNS;
}

export type Orientation = "right" | "down";

/** Beside main when both halves keep `minColumns` columns, otherwise below it. */
export function orientationFor(width: number, minColumns: number): Orientation {
  return width >= 2 * minColumns + 1 ? "right" : "down";
}

/**
 * Cells for main, the divider and Sidebar along the split axis. The divider takes one cell; Sidebar
 * gets `ratio` of the rest, and at least one cell is left to each side.
 */
export function splitSizes(total: number, ratio: number): { main: number; divider: number; side: number } {
  const usable = Math.max(2, total - 1);
  const side = Math.min(usable - 1, Math.max(1, Math.round(usable * ratio)));
  return { main: usable - side, divider: 1, side };
}
