// Copied from pi-sidebar/src/config.ts (the layout arithmetic only); change both.

export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;

/** Sidebar's share kept within MIN_RATIO..MAX_RATIO. */
export function clampRatio(ratio: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/**
 * Sidebar's share when the divider sits at `position` (a column beside main, a row below it) in a
 * split of `total` cells: main takes the cells before the divider.
 */
export function ratioAt(position: number, total: number): number {
  const usable = Math.max(2, total - 1);
  return clampRatio((usable - Math.max(0, Math.min(usable, position))) / usable);
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
