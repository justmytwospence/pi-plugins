// Turns readings into levels with hysteresis, decides when the row shows, and
// formats the status pi-status-footer folds into its own row:
//   pressure: cpu 97 ↑ hot · load 1.6 warn · mem 83% used warn · thermal warn · swap-in 40MB/s ↓ warn · top vitest
// Items are ` · `-separated; each signal is `name [value] [↑|↓] level`, the
// arrow only while it is moving significantly. Nothing ends in `%`
// (herdr-web-ui reads a footer line ending in % $ # > as a shell prompt).

import type { Reading } from "./sample.ts";

export type Level = "ok" | "warn" | "hot";
export type Signal = "cpu" | "load" | "mem" | "swap" | "heat";
export const SIGNALS: readonly Signal[] = ["cpu", "load", "mem", "swap", "heat"];

export interface Band { warn: number; hot: number }
export interface PressureConfig {
  /** Show the row on its own when thresholds are hit. Default true; when false it shows only by hand (`/pressure show`). */
  enabled: boolean;
  /** Pi activity closer together than this shares one read. */
  minGapMs: number;
  /** How long a signal stays at warn or above before the row shows. */
  showAfterMs: number;
  /** How long every signal stays back at ok before the row hides. */
  hideAfterMs: number;
  /** While the row shows and Pi is idle, re-read this often so it stays current and can hide. */
  refreshMs: number;
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

/** auto: shows on pressure. shown: pinned by hand. hidden: dismissed by hand until the current episode ends. */
export type Mode = "auto" | "shown" | "hidden";

export interface View {
  visible: boolean;
  mode: Mode;
  levels: Record<Signal, Level>;
  /** Signals to list, in display order: those that rose during the current episode (they stay until the row hides), and when shown by hand every signal with a reading. */
  episode: Signal[];
  reading?: Reading;
  /** Signals moving significantly, and which way. */
  trends: Partial<Record<Signal, Trend>>;
}

export type Trend = "up" | "down";

/** A trend compares the last RECENT_MS with the TREND_MS before it, time-weighted. */
const RECENT_MS = 15_000;
const TREND_MS = 60_000;
/** How far the recent mean must move to count. Memory and thermal on macOS are levels (1, 2, 4 and 0-3). */
const TREND_STEP: Record<Signal, number> = { cpu: 15, load: 0.3, mem: 0.5, swap: 5, heat: 0.5 };

/** The number a signal's trend follows, from one reading. */
function trendValue(signal: Signal, r: Reading): number | undefined {
  if (signal === "cpu") return r.cpu;
  if (signal === "load") return r.loadPerCore;
  if (signal === "mem") return r.memory?.source === "darwin" ? r.memory.level : r.memory?.some;
  if (signal === "heat") return r.thermal?.state;
  return r.swapInBps === undefined ? undefined : r.swapInBps / (1024 * 1024);
}

/** Up or down when the last 15 s moved a signal by its step against the minute before; nothing otherwise. */
export function trends(samples: readonly Reading[], now: number): Partial<Record<Signal, Trend>> {
  const out: Partial<Record<Signal, Trend>> = {};
  const mean = (signal: Signal, from: number, to: number): number | undefined => {
    let sum = 0, weight = 0;
    for (const r of samples) {
      const value = trendValue(signal, r);
      if (value === undefined) continue;
      // Averages (CPU, Linux memory stall, swap-ins) stand for the interval they cover; macOS
      // levels hold from when they were entered; load is the kernel's own moving average, an instant.
      const start = signal === "load" ? r.at - 1
        : signal === "mem" && r.memory?.source === "darwin" ? Math.max(r.memory.since, r.since ?? r.at - 1)
        : signal === "heat" && r.thermal ? Math.max(r.thermal.since, r.since ?? r.at - 1)
        : r.since ?? r.at - 1;
      const overlap = Math.min(r.at, to) - Math.max(start, from);
      if (overlap <= 0) continue;
      sum += value * overlap;
      weight += overlap;
    }
    return weight > 0 ? sum / weight : undefined;
  };
  for (const signal of SIGNALS) {
    const recent = mean(signal, now - RECENT_MS, now);
    const before = mean(signal, now - TREND_MS, now - RECENT_MS);
    if (recent === undefined || before === undefined) continue;
    if (recent - before >= TREND_STEP[signal]) out[signal] = "up";
    else if (before - recent >= TREND_STEP[signal]) out[signal] = "down";
  }
  return out;
}

/**
 * Steps through readings, which arrive whenever Pi does something rather than
 * on a clock: each covers the interval since the previous one. Shows after
 * sustained pressure, lingers once it eases; `nextCheck` says when a reading
 * is needed to decide that without waiting for Pi activity. `setMode` pins the
 * row or dismisses it; a dismissal lasts until the episode is over, so the next
 * one shows again.
 */
export function createMonitor(config: PressureConfig) {
  let levels: Record<Signal, Level> = { cpu: "ok", load: "ok", mem: "ok", swap: "ok", heat: "ok" };
  // Readings covering the last minute, for trends.
  let samples: Reading[] = [];
  const episode = new Set<Signal>();
  // Automatic visibility, tracked even while the mode overrides it.
  let automatic = false;
  let mode: Mode = "auto";
  let pressedSince: number | undefined;
  let calmSince: number | undefined;
  let reading: Reading | undefined;
  const pressed = () => SIGNALS.some((s) => levels[s] !== "ok");
  const available = (s: Signal) => s === "cpu" || s === "load" || (s === "mem" && Boolean(reading?.memory)) || (s === "heat" && Boolean(reading?.thermal)) || (s === "swap" && reading?.swapInBps !== undefined);
  const view = (): View => ({
    visible: mode === "shown" || (mode === "auto" && config.enabled && automatic),
    mode,
    levels: { ...levels },
    episode: SIGNALS.filter((s) => episode.has(s) || (mode === "shown" && available(s))),
    reading,
    trends: reading ? trends(samples, reading.at) : {},
  });
  return {
    step(next: Reading): View {
      reading = next;
      levels = classify(next, config, levels);
      samples = [...samples.filter((r) => r.at > next.at - TREND_MS), next];
      const now = next.at;
      if (pressed()) {
        const raised = SIGNALS.filter((s) => levels[s] !== "ok");
        pressedSince ??= Math.min(...raised.map((s) => pressureStart(s, next)));
        calmSince = undefined;
        for (const s of raised) episode.add(s);
        if (!automatic && now - pressedSince >= config.showAfterMs) automatic = true;
      } else {
        pressedSince = undefined;
        calmSince ??= now;
        if (automatic && now - calmSince >= config.hideAfterMs) automatic = false;
        if (!automatic) {
          episode.clear();
          // The dismissed episode is over; the next one shows again.
          if (mode === "hidden") mode = "auto";
        }
      }
      return view();
    },
    view,
    setMode(next: Mode): View {
      mode = next;
      return view();
    },
    /** When to read again without waiting for Pi activity, or undefined when nothing is pending (the steady state). */
    nextCheck(): number | undefined {
      if (!reading) return undefined;
      if (mode === "shown") return reading.at + config.refreshMs;
      if (!automatic) return pressed() && pressedSince !== undefined ? pressedSince + config.showAfterMs : undefined;
      if (!pressed() && calmSince !== undefined) return Math.min(calmSince + config.hideAfterMs, reading.at + config.refreshMs);
      return reading.at + config.refreshMs;
    },
  };
}

export function formatRate(bytesPerSecond: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = Math.max(0, bytesPerSecond), unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}/s`;
}

/** Bytes as a whole-ish size: `32GB`, `1.5GB`, `800MB`. */
export function formatBytes(bytes: number): string {
  return formatRate(bytes).replace("/s", "");
}

/** macOS memory's numbers for `/pressure details`: `83% used, 32GB compressed`; empty until vm_stat has reported. */
export function darwinMemoryText(memory: { usedPercent?: number; compressedBytes?: number }): string {
  const parts: string[] = [];
  if (memory.usedPercent !== undefined) parts.push(`${Math.round(memory.usedPercent)}% used`);
  if (memory.compressedBytes !== undefined) parts.push(`${formatBytes(memory.compressedBytes)} compressed`);
  return parts.join(", ");
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
    const arrow = view.trends[signal] === "up" ? "\u2191" : view.trends[signal] === "down" ? "\u2193" : "";
    const value = (text: string) => paint.level(level, [text, arrow, level].filter(Boolean).join(" "));
    if (signal === "cpu") {
      const busy = r?.cpu;
      items.push(`${paint.level(level, "cpu")} ${value(busy === undefined ? "" : `${Math.round(busy)}`)}`);
    } else if (signal === "load") items.push(`${paint.level(level, "load")} ${value(r ? r.loadPerCore.toFixed(1) : "")}`);
    else if (signal === "mem") items.push(`${paint.level(level, "mem")} ${value(r?.memory?.source === "darwin" && r.memory.usedPercent !== undefined ? `${Math.round(r.memory.usedPercent)}% used` : "")}`);
    else if (signal === "heat") items.push(`${paint.level(level, "thermal")} ${value("")}`);
    else items.push(`${paint.level(level, "swap-in")} ${value(r?.swapInBps === undefined ? "" : formatRate(r.swapInBps))}`);
  }
  if (top) items.push(`${paint.dim("top")} ${top}`);
  return `${paint.dim("pressure:")} ${items.join(paint.dim(" \u00b7 "))}`;
}

/** Which ranking names the culprit: memory when only memory signals are up. */
export function topBy(view: View): "cpu" | "memory" {
  const { cpu, load, mem, swap } = view.levels;
  return cpu === "ok" && load === "ok" && (mem !== "ok" || swap !== "ok") ? "memory" : "cpu";
}
