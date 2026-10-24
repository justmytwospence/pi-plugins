// Turns readings into levels with hysteresis, decides when the row shows, and
// formats the status pi-status-footer folds into its own row:
//   pressure: cpu 97 hot · load 1.6 warn · mem warn · thermal warn · swap-in 40MB/s warn · top vitest · ⣀⣤⣶⣿
// Items are ` · `-separated; each signal ends in its level word and the CPU trace
// (braille only) comes last, so nothing ends in `%` (herdr-web-ui reads a footer
// line ending in % $ # > as a shell prompt).

import type { Reading } from "./sample.ts";

export type Level = "ok" | "warn" | "hot";
export type Signal = "cpu" | "load" | "mem" | "swap" | "heat";
export const SIGNALS: readonly Signal[] = ["cpu", "load", "mem", "swap", "heat"];

export interface Band { warn: number; hot: number }
export interface PressureConfig {
  /** Watch at startup. Default true. */
  enabled: boolean;
  /** Pi activity closer together than this shares one read. */
  minGapMs: number;
  /** How long a signal stays at warn or above before the row shows. */
  showAfterMs: number;
  /** How long every signal stays back at ok before the row hides. */
  hideAfterMs: number;
  /** While the row shows and Pi is idle, re-read this often so it stays current and can hide. */
  refreshMs: number;
  /** Minutes of CPU history in the trace, one braille dot column per minute (two per character). */
  historyMinutes: number;
  /** Busy share of all cores, percent. */
  cpu: Band;
  /** One-minute load average per core. */
  loadPerCore: Band;
  /** Linux PSI memory `some` stall share, percent. */
  memorySome: Band;
  /** Linux PSI memory `full` stall share, percent. */
  memoryFull: Band;
  /** Swap-ins, MB per second (Linux). */
  swapInMBps: Band;
}

export const DEFAULTS: PressureConfig = {
  enabled: true,
  minGapMs: 2_000,
  showAfterMs: 10_000,
  hideAfterMs: 30_000,
  refreshMs: 10_000,
  historyMinutes: 60,
  cpu: { warn: 85, hot: 95 },
  loadPerCore: { warn: 1.5, hot: 2.5 },
  memorySome: { warn: 10, hot: 40 },
  memoryFull: { warn: 2, hot: 5 },
  swapInMBps: { warn: 10, hot: 50 },
};

/** How far below a threshold a value must fall before its level drops, so a value hovering on it does not flicker. */
const MARGIN = { cpu: 5, loadPerCore: 0.1, memorySome: 2, memoryFull: 1, swapInMBps: 2 };
const MB = 1024 * 1024;
const RANK: Record<Level, number> = { ok: 0, warn: 1, hot: 2 };
const max = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b);

/** A level that rises at its threshold and falls only `margin` below it. Unknown values keep the previous level. */
export function bandLevel(value: number | undefined, band: Band, prev: Level, margin: number): Level {
  if (value === undefined || !Number.isFinite(value)) return prev;
  if (value >= band.hot || (prev === "hot" && value > band.hot - margin)) return "hot";
  if (value >= band.warn || (prev !== "ok" && value > band.warn - margin)) return "warn";
  return "ok";
}

export function classify(reading: Reading, config: PressureConfig, prev: Record<Signal, Level>): Record<Signal, Level> {
  const memory = reading.memory;
  let mem: Level = "ok";
  if (memory?.source === "darwin") mem = memory.level >= 4 ? "hot" : memory.level >= 2 ? "warn" : "ok";
  else if (memory?.source === "psi") {
    mem = max(bandLevel(memory.some, config.memorySome, prev.mem, MARGIN.memorySome),
      bandLevel(memory.full, config.memoryFull, prev.mem, MARGIN.memoryFull));
  }
  // macOS thermal state: serious means the system is throttling, critical means hard.
  const thermal = reading.thermal?.state;
  const heat: Level = thermal === undefined ? "ok" : thermal >= 3 ? "hot" : thermal >= 2 ? "warn" : "ok";
  return {
    cpu: bandLevel(reading.cpu, config.cpu, prev.cpu, MARGIN.cpu),
    load: bandLevel(reading.loadPerCore, config.loadPerCore, prev.load, MARGIN.loadPerCore),
    mem,
    swap: bandLevel(reading.swapInBps === undefined ? undefined : reading.swapInBps / MB, config.swapInMBps, prev.swap, MARGIN.swapInMBps),
    heat,
  };
}

/** When a raised signal's pressure began: interval averages cover their whole interval; states date from their change. */
function pressureStart(signal: Signal, reading: Reading): number {
  if (signal === "mem" && reading.memory?.source === "darwin") return Math.max(reading.memory.since, reading.since ?? reading.memory.since);
  if (signal === "heat" && reading.thermal) return Math.max(reading.thermal.since, reading.since ?? reading.thermal.since);
  return reading.since ?? reading.at;
}

export interface View {
  visible: boolean;
  levels: Record<Signal, Level>;
  /** Signals that rose during the current episode, in display order; they stay listed until the row hides. */
  episode: Signal[];
  reading?: Reading;
  /** Mean CPU busy percentage per minute, oldest first, ending with the current (partial) minute; undefined where nothing was read. */
  history: (number | undefined)[];
}

const MINUTE = 60_000;

/**
 * Steps through readings, which arrive whenever Pi does something rather than
 * on a clock: each covers the interval since the previous one. Shows after
 * sustained pressure, lingers once it eases; `nextCheck` says when a reading
 * is needed to decide that without waiting for Pi activity.
 */
export function createMonitor(config: PressureConfig) {
  let levels: Record<Signal, Level> = { cpu: "ok", load: "ok", mem: "ok", swap: "ok", heat: "ok" };
  // Time-weighted CPU per minute (percent x ms, ms), keyed by minute since the epoch.
  const minutes = new Map<number, { sum: number; weight: number }>();
  let latest: number | undefined;
  const history = (): (number | undefined)[] => {
    if (latest === undefined || minutes.size === 0) return [];
    const first = Math.max(Math.min(...minutes.keys()), latest - config.historyMinutes + 1);
    const out: (number | undefined)[] = [];
    for (let m = first; m <= latest; m++) {
      const bucket = minutes.get(m);
      out.push(bucket && bucket.weight > 0 ? bucket.sum / bucket.weight : undefined);
    }
    return out;
  };
  /** Spread an interval's mean over the minutes it covers, weighted by overlap. */
  const record = (since: number, at: number, cpu: number) => {
    const from = Math.max(Math.floor(since / MINUTE), Math.floor(at / MINUTE) - config.historyMinutes + 1);
    for (let m = from; m <= Math.floor(at / MINUTE); m++) {
      const overlap = Math.min(at, (m + 1) * MINUTE) - Math.max(since, m * MINUTE);
      if (overlap <= 0) continue;
      const bucket = minutes.get(m) ?? { sum: 0, weight: 0 };
      bucket.sum += cpu * overlap;
      bucket.weight += overlap;
      minutes.set(m, bucket);
    }
  };
  const episode = new Set<Signal>();
  let visible = false;
  let pressedSince: number | undefined;
  let calmSince: number | undefined;
  let reading: Reading | undefined;
  const pressed = () => SIGNALS.some((s) => levels[s] !== "ok");
  const view = (): View => ({ visible, levels: { ...levels }, episode: SIGNALS.filter((s) => episode.has(s)), reading, history: history() });
  return {
    step(next: Reading): View {
      reading = next;
      levels = classify(next, config, levels);
      const minute = Math.floor(next.at / MINUTE);
      latest = Math.max(latest ?? minute, minute);
      if (next.cpu !== undefined && next.since !== undefined) record(next.since, next.at, next.cpu);
      for (const m of minutes.keys()) if (m <= latest - config.historyMinutes) minutes.delete(m);
      const now = next.at;
      if (pressed()) {
        const raised = SIGNALS.filter((s) => levels[s] !== "ok");
        pressedSince ??= Math.min(...raised.map((s) => pressureStart(s, next)));
        calmSince = undefined;
        for (const s of raised) episode.add(s);
        if (!visible && now - pressedSince >= config.showAfterMs) visible = true;
      } else {
        pressedSince = undefined;
        calmSince ??= now;
        if (visible && now - calmSince >= config.hideAfterMs) visible = false;
        if (!visible) episode.clear();
      }
      return view();
    },
    view,
    /** When to read again without waiting for Pi activity, or undefined when nothing is pending (the steady state). */
    nextCheck(): number | undefined {
      if (!reading) return undefined;
      if (!visible) return pressed() && pressedSince !== undefined ? pressedSince + config.showAfterMs : undefined;
      if (!pressed() && calmSince !== undefined) return Math.min(calmSince + config.hideAfterMs, reading.at + config.refreshMs);
      return reading.at + config.refreshMs;
    },
  };
}

const BRAILLE_LEFT = [0x40, 0x04, 0x02, 0x01]; // bottom to top
const BRAILLE_RIGHT = [0x80, 0x20, 0x10, 0x08];

/** Percentages as braille bars, two values per cell, filled from the bottom (4 dots per column); undefined is blank. */
export function spark(values: readonly (number | undefined)[]): string {
  const padded = values.length % 2 ? [undefined, ...values] : [...values];
  const dots = (value: number | undefined, column: number[]) => {
    if (value === undefined) return 0;
    const height = value <= 0 ? 0 : Math.max(1, Math.min(4, Math.round(value / 25)));
    return column.slice(0, height).reduce((bits, bit) => bits | bit, 0);
  };
  let out = "";
  for (let i = 0; i < padded.length; i += 2) out += String.fromCodePoint(0x2800 | dots(padded[i], BRAILLE_LEFT) | dots(padded[i + 1], BRAILLE_RIGHT));
  return out;
}

export function formatRate(bytesPerSecond: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = Math.max(0, bytesPerSecond), unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}/s`;
}

export interface Paint { level(level: Level, text: string): string; dim(text: string): string }
const plain: Paint = { level: (_level, text) => text, dim: (text) => text };

/** The status text while the row shows, undefined while it is hidden. */
export function formatStatus(view: View, top: string | undefined, paint: Paint = plain): string | undefined {
  if (!view.visible) return undefined;
  const r = view.reading;
  const items: string[] = [];
  for (const signal of view.episode) {
    const level = view.levels[signal];
    const value = (text: string) => paint.level(level, `${text}${text ? " " : ""}${level}`);
    if (signal === "cpu") {
      const busy = r?.cpu ?? view.history.at(-1);
      items.push(`${paint.dim("cpu")} ${value(busy === undefined ? "" : `${Math.round(busy)}`)}`);
    } else if (signal === "load") items.push(`${paint.dim("load")} ${value(r ? r.loadPerCore.toFixed(1) : "")}`);
    else if (signal === "mem") items.push(`${paint.dim("mem")} ${value("")}`);
    else if (signal === "heat") items.push(`${paint.dim("thermal")} ${value("")}`);
    else items.push(`${paint.dim("swap-in")} ${value(r?.swapInBps === undefined ? "" : formatRate(r.swapInBps))}`);
  }
  if (top) items.push(`${paint.dim("top")} ${top}`);
  // The CPU trace goes last, so a reader can give it whatever width is left.
  if (view.history.some((v) => v !== undefined)) items.push(paint.level(view.levels.cpu, spark(view.history)));
  return `${paint.dim("pressure:")} ${items.join(paint.dim(" \u00b7 "))}`;
}

/** Which ranking names the culprit: memory when only memory signals are up. */
export function topBy(view: View): "cpu" | "memory" {
  const { cpu, load, mem, swap } = view.levels;
  return cpu === "ok" && load === "ok" && (mem !== "ok" || swap !== "ok") ? "memory" : "cpu";
}
