// Text charts for per-turn metrics: one-row sparklines for the widget and multi-row column charts
// for the overlay. Pure string output; callers add colour.

import { EFFORT_LEVELS, effortRank, type TurnStat } from "./turns.ts";

const BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export interface Metric {
  key: string;
  label: string;
  /** Numeric value plotted for a turn; undefined leaves a gap. */
  value: (turn: TurnStat) => number | undefined;
  /** Fixed chart ceiling; otherwise the visible maximum. */
  max?: number;
  format: (value: number, turn: TurnStat) => string;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return `${Math.round(value)}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export const formatCost = (value: number): string => `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;

export const METRICS: Metric[] = [
  { key: "context", label: "Context", value: (t) => t.contextPercent, max: 100, format: (v) => `${v.toFixed(0)}%` },
  { key: "effort", label: "Effort", value: (t) => effortRank(t.effort), max: EFFORT_LEVELS.length - 1, format: (_v, t) => t.effort },
  { key: "tokens", label: "Tokens", value: (t) => t.input + t.output + t.cacheRead + t.cacheWrite, format: (v) => formatTokens(v) },
  { key: "cost", label: "Cost", value: (t) => t.cost, format: (v) => formatCost(v) },
  { key: "tools", label: "Tool calls", value: (t) => t.toolCalls, format: (v) => `${v}` },
  { key: "duration", label: "Duration", value: (t) => t.durationMs, format: (v) => formatDuration(v) },
];

function scale(values: (number | undefined)[], max?: number): number {
  const visible = values.filter((v): v is number => v !== undefined && Number.isFinite(v));
  return max ?? Math.max(0, ...visible);
}

/** One block character per value, scaled to `max` (or the largest value). */
export function sparkline(values: (number | undefined)[], max?: number): string {
  const ceiling = scale(values, max);
  return values
    .map((v) => {
      if (v === undefined || !Number.isFinite(v)) return " ";
      if (ceiling <= 0) return BLOCKS[1];
      const eighths = Math.round((Math.min(v, ceiling) / ceiling) * 8);
      return BLOCKS[Math.max(1, eighths)];
    })
    .join("");
}

/** Column chart `height` rows tall, top row first; each value is one column. */
export function columnChart(values: (number | undefined)[], height: number, max?: number): string[] {
  const ceiling = scale(values, max);
  const fills = values.map((v) => {
    if (v === undefined || !Number.isFinite(v)) return 0;
    if (ceiling <= 0) return 1;
    return Math.max(1, Math.round((Math.min(v, ceiling) / ceiling) * height * 8));
  });
  const rows: string[] = [];
  for (let row = height - 1; row >= 0; row--) {
    rows.push(fills.map((fill) => BLOCKS[Math.max(0, Math.min(8, fill - row * 8))]).join(""));
  }
  return rows;
}

const DOT = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];

export interface LineChart {
  /** Braille rows, top first; one string of `width` cells per row. */
  rows: string[];
  /** Cell column holding each value's point. */
  cellOf: (index: number) => number;
}

/**
 * Braille line chart `width` cells by `height` rows (2x4 dots per cell). Points are spread evenly
 * across the width and joined by straight segments; undefined values break the line.
 */
export function lineChart(values: (number | undefined)[], width: number, height: number, max?: number): LineChart {
  const ceiling = scale(values, max);
  const dotsX = width * 2;
  const dotsY = height * 4;
  const grid = Array.from({ length: height }, () => new Array<number>(width).fill(0));
  const xOf = (i: number) => (values.length <= 1 ? 0 : Math.round((i * (dotsX - 1)) / (values.length - 1)));
  const yOf = (v: number) => {
    const ratio = ceiling > 0 ? Math.min(v, ceiling) / ceiling : 0;
    return Math.round((1 - ratio) * (dotsY - 1));
  };
  const plot = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= dotsX || y >= dotsY) return;
    grid[Math.floor(y / 4)][Math.floor(x / 2)] |= DOT[x % 2][y % 4];
  };
  let prev: [number, number] | undefined;
  values.forEach((v, i) => {
    if (v === undefined || !Number.isFinite(v)) {
      prev = undefined;
      return;
    }
    const point: [number, number] = [xOf(i), yOf(v)];
    if (prev) {
      // Bresenham between consecutive points.
      let [x0, y0] = prev;
      const [x1, y1] = point;
      const dx = Math.abs(x1 - x0);
      const dy = -Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1;
      const sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        plot(x0, y0);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) {
          err += dy;
          x0 += sx;
        }
        if (e2 <= dx) {
          err += dx;
          y0 += sy;
        }
      }
    } else plot(point[0], point[1]);
    prev = point;
  });
  return {
    rows: grid.map((row) => row.map((bits) => (bits ? String.fromCharCode(0x2800 + bits) : " ")).join("")),
    cellOf: (i) => Math.floor(xOf(i) / 2),
  };
}

/** The last `count` turns, ending `offset` turns before the newest. */
export function window<T>(items: readonly T[], count: number, offset = 0): T[] {
  const end = Math.max(0, items.length - offset);
  return items.slice(Math.max(0, end - count), end);
}
