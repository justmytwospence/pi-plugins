// Text charts for per-call metrics. Every overlay chart shares one slot-based x-axis (a fixed
// number of braille dot columns per call), so a call lines up vertically across all charts.
// Levels use areas or step lines; per-call events use bars.

import { EFFORT_LEVELS, effortRank, type TurnStat } from "./turns.ts";

const BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export type ChartKind = "area" | "step" | "bars";

export interface Metric {
  key: string;
  label: string;
  /** How the series reads: a level that persists (area, step) or a per-call event (bars). */
  kind: ChartKind;
  /** Relative chart height. */
  weight: number;
  /** Logarithmic y-axis, for heavy-tailed values. */
  log?: boolean;
  /** Numeric value plotted for a call; undefined leaves a gap. */
  value: (call: TurnStat) => number | undefined;
  /** [min, max] of the y-axis for the values in view. */
  domain: (values: number[]) => [number, number];
  /** Header value for one call. */
  format: (value: number, call: TurnStat) => string;
  /** Y-axis tick label. */
  tick: (value: number) => string;
  /** Session aggregate shown after the header value. */
  summary: (calls: TurnStat[]) => string;
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

/** Smallest 1, 2, 2.5 or 5 x 10^k at or above `value`. */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value * (1 - 1e-9)) return step * power;
  return 10 * power;
}

const sum = (calls: TurnStat[], f: (c: TurnStat) => number) => calls.reduce((total, c) => total + f(c), 0);
const freshTokens = (c: TurnStat) => c.input + c.cacheWrite + c.output;
const shortCost = (v: number) => (v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(3)}` : v < 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(1)}`);

export const METRICS: Metric[] = [
  {
    key: "context",
    label: "Context",
    kind: "area",
    weight: 4,
    value: (c) => c.contextPercent,
    // Zoomed to just above the peak: a 1M window would otherwise leave the area flat on the floor.
    domain: (values) => [0, Math.min(100, niceMax(Math.max(10, ...values) * 1.05))],
    format: (v) => `${v.toFixed(0)}%`,
    tick: (v) => `${v.toFixed(0)}%`,
    summary: (calls) => {
      const peak = Math.max(0, ...calls.map((c) => c.contextPercent ?? 0));
      const window = calls.at(-1)?.contextWindow;
      return [`peak ${peak.toFixed(0)}%`, window ? `${formatTokens(window)} window` : undefined].filter(Boolean).join(" · ");
    },
  },
  {
    key: "effort",
    label: "Effort",
    kind: "step",
    weight: 2,
    value: (c) => effortRank(c.effort),
    // Every level, one row each: few enough to show them all, and the scale never shifts.
    domain: () => [0, EFFORT_LEVELS.length - 1],
    format: (_v, c) => c.effort,
    tick: (v) => EFFORT_LEVELS[Math.round(v)] ?? "",
    summary: (calls) => {
      const changes = calls.filter((c, i) => i > 0 && c.effort !== calls[i - 1].effort).length;
      return `${changes} change${changes === 1 ? "" : "s"}`;
    },
  },
  {
    key: "tokens",
    label: "New tokens",
    kind: "bars",
    weight: 3,
    value: freshTokens,
    domain: (values) => [0, niceMax(Math.max(0, ...values))],
    format: (_v, c) => `${formatTokens(c.input + c.cacheWrite)} in, ${formatTokens(c.output)} out`,
    tick: formatTokens,
    summary: (calls) => `Σ ${formatTokens(sum(calls, freshTokens))} · cache reads excluded`,
  },
  {
    key: "cost",
    label: "Cost",
    kind: "bars",
    weight: 3,
    value: (c) => c.cost,
    domain: (values) => [0, niceMax(Math.max(0, ...values))],
    format: (v) => formatCost(v),
    tick: shortCost,
    summary: (calls) => `Σ ${formatCost(sum(calls, (c) => c.cost))}`,
  },
  {
    key: "tools",
    label: "Tool calls",
    kind: "bars",
    weight: 2,
    value: (c) => c.toolCalls,
    domain: (values) => [0, Math.max(1, ...values)],
    format: (v) => `${v}`,
    tick: (v) => `${Math.round(v)}`,
    summary: (calls) => `Σ ${sum(calls, (c) => c.toolCalls)}`,
  },
  {
    key: "duration",
    label: "Duration",
    kind: "bars",
    weight: 3,
    log: true,
    value: (c) => c.durationMs,
    domain: (values) => [0, Math.max(1000, ...values)],
    format: (v) => formatDuration(v),
    tick: (v) => (v === 0 ? "0" : formatDuration(v)),
    summary: (calls) => `Σ ${formatDuration(sum(calls, (c) => c.durationMs))} · log scale`,
  },
];

/** Position of `value` within the metric's domain, 0 to 1. */
export function normalize(metric: Pick<Metric, "log">, value: number, [lo, hi]: [number, number]): number {
  if (metric.log) {
    const f = (v: number) => Math.log10(1 + Math.max(0, v) / 1000);
    return hi > lo ? Math.max(0, Math.min(1, (f(value) - f(lo)) / (f(hi) - f(lo)))) : 0;
  }
  return hi > lo ? Math.max(0, Math.min(1, (value - lo) / (hi - lo))) : 0;
}

/** One block character per value already normalized to 0-1. */
export function sparkline(values: (number | undefined)[]): string {
  return values
    .map((v) => (v === undefined || !Number.isFinite(v) ? " " : BLOCKS[Math.max(1, Math.round(Math.min(1, Math.max(0, v)) * 8))]))
    .join("");
}

const DOT = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];

/** Shared x-axis: each call gets `dotsPerSlot` braille dot columns, left to right. */
export interface Slots {
  count: number;
  dotsPerSlot: number;
  start: (index: number) => number;
  /** Cell holding the call's first dot column. */
  cellOf: (index: number) => number;
  /** Call drawn in a cell (the last slot that starts in or before it). */
  callAt: (cell: number) => number;
}

export function slots(count: number, width: number): Slots {
  const dotsPerSlot = Math.max(1, Math.min(6, Math.floor((width * 2) / Math.max(1, count))));
  return {
    count,
    dotsPerSlot,
    start: (i) => i * dotsPerSlot,
    cellOf: (i) => Math.floor((i * dotsPerSlot) / 2),
    callAt: (cell) => Math.min(count - 1, Math.floor((cell * 2 + 1) / dotsPerSlot)),
  };
}

/**
 * Braille chart `width` cells by `height` rows. `levels` are values normalized to 0-1 (undefined
 * leaves a gap). Areas and bars fill from the bottom; step lines hold each level across its slot and
 * join levels with vertical risers.
 */
export function plot(levels: (number | undefined)[], kind: ChartKind, x: Slots, width: number, height: number): string[] {
  const dotsX = width * 2;
  const dotsY = height * 4;
  const grid = Array.from({ length: height }, () => new Array<number>(width).fill(0));
  const set = (dx: number, dy: number) => {
    if (dx < 0 || dy < 0 || dx >= dotsX || dy >= dotsY) return;
    grid[Math.floor(dy / 4)][Math.floor(dx / 2)] |= DOT[dx % 2][dy % 4];
  };
  let previousY: number | undefined;
  levels.forEach((level, i) => {
    if (level === undefined || !Number.isFinite(level)) {
      previousY = undefined;
      return;
    }
    const start = x.start(i);
    if (kind === "step") {
      // One row per level: the line runs through the middle of its row.
      const y = (height - 1 - Math.round(level * (height - 1))) * 4 + 1;
      if (previousY !== undefined) for (let dy = Math.min(y, previousY); dy <= Math.max(y, previousY); dy++) set(start, dy);
      for (let dx = start; dx < start + x.dotsPerSlot; dx++) set(dx, y);
      previousY = y;
      return;
    }
    // Areas are continuous; bars leave a one-dot gap when slots are wide enough.
    const barWidth = kind === "bars" && x.dotsPerSlot >= 2 ? x.dotsPerSlot - 1 : x.dotsPerSlot;
    const filled = level > 0 ? Math.max(1, Math.round(level * dotsY)) : 0;
    for (let dx = start; dx < start + barWidth; dx++) for (let k = 0; k < filled; k++) set(dx, dotsY - 1 - k);
  });
  return grid.map((row) => row.map((bits) => (bits ? String.fromCharCode(0x2800 + bits) : " ")).join(""));
}

/** The last `count` items, ending `offset` items before the newest. */
export function window<T>(items: readonly T[], count: number, offset = 0): T[] {
  const end = Math.max(0, items.length - offset);
  return items.slice(Math.max(0, end - count), end);
}
