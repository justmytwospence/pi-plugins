// Reads the machine's CPU and memory pressure on demand, without a timer.
// Every rate comes from a cumulative kernel counter (CPU time from os.cpus(),
// Linux PSI stall totals, swap-ins), so two reads any distance apart give the
// exact average between them: reading only when Pi does something loses
// nothing but resolution. macOS memory pressure and thermal state are states,
// not counters; the kernel-woken helper (darwin.ts) pushes them in. Parsers are
// pure so tests can feed them captured output.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CpuTimes { idle: number; total: number }

/** Memory pressure as the platform reports it. */
export type MemoryReading =
  /**
   * macOS kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical; `since` is when it took this level.
   * The level alone sets the signal's level; `usedPercent` and `compressedBytes` (from vm_stat) only describe it.
   */
  | { source: "darwin"; level: number; since: number; usedPercent?: number; compressedBytes?: number }
  /** Linux PSI, percent of time some/all tasks stalled on memory over the reading's interval. */
  | { source: "psi"; some: number; full: number };

/** macOS ProcessInfo.thermalState: 0 nominal, 1 fair, 2 serious (throttling), 3 critical; `since` is when it took this state. */
export interface ThermalReading { state: number; since: number }

export interface Reading {
  at: number;
  /** Start of the interval the averages cover: the previous read. Absent on the first read. */
  since?: number;
  /** Busy share of all cores over the interval, 0-100. */
  cpu?: number;
  /** One-minute load average per core (the kernel's own moving average). */
  loadPerCore: number;
  memory?: MemoryReading;
  thermal?: ThermalReading;
  /** Bytes swapped in per second over the interval (Linux). */
  swapInBps?: number;
}

export interface ProcessRow { pid: number; cpu: number; rssKb: number; name: string }

export function cpuTimes(cpus: Pick<os.CpuInfo, "times">[]): CpuTimes {
  let idle = 0, total = 0;
  for (const { times } of cpus) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

export function busyPercent(prev: CpuTimes, next: CpuTimes): number | undefined {
  const total = next.total - prev.total;
  if (!(total > 0)) return undefined;
  return Math.max(0, Math.min(100, (1 - (next.idle - prev.idle) / total) * 100));
}

export interface Psi { someAvg10: number; fullAvg10: number; someTotal: number; fullTotal: number }

/** A /proc/pressure file: avg10 and the cumulative stall time (microseconds) of its `some` and `full` lines. */
export function parsePsi(text: string): Psi | undefined {
  const some = /^some avg10=([\d.]+) .*total=(\d+)/m.exec(text);
  if (!some) return undefined;
  const full = /^full avg10=([\d.]+) .*total=(\d+)/m.exec(text);
  return { someAvg10: +some[1], fullAvg10: full ? +full[1] : 0, someTotal: +some[2], fullTotal: full ? +full[2] : 0 };
}

/** Stall share between two PSI reads, percent of wall time; the kernel's avg10 on the first read. */
export function psiShare(prev: { at: number; psi: Psi } | undefined, at: number, psi: Psi): { some: number; full: number } {
  const elapsedUs = prev ? (at - prev.at) * 1000 : 0;
  if (!prev || elapsedUs <= 0 || psi.someTotal < prev.psi.someTotal) return { some: psi.someAvg10, full: psi.fullAvg10 };
  const share = (now: number, before: number) => Math.max(0, Math.min(100, ((now - before) / elapsedUs) * 100));
  return { some: share(psi.someTotal, prev.psi.someTotal), full: share(psi.fullTotal, prev.psi.fullTotal) };
}

/** Cumulative pages swapped in, from /proc/vmstat. */
export function parseProcVmstat(text: string): number | undefined {
  const match = /^pswpin (\d+)$/m.exec(text);
  return match ? +match[1] : undefined;
}

export interface DarwinMemoryStats { usedPercent: number; compressedBytes: number }

/**
 * macOS `vm_stat`: memory used as Activity Monitor counts it (app memory, i.e.
 * anonymous minus purgeable pages, plus wired, plus the compressor's physical
 * pages) as a share of `totalBytes`, and the compressor's physical size.
 */
export function parseVmStat(text: string, totalBytes: number): DarwinMemoryStats | undefined {
  const page = /page size of (\d+) bytes/.exec(text);
  const count = (label: string) => {
    const match = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, "m").exec(text);
    return match ? +match[1] : undefined;
  };
  const anonymous = count("Anonymous pages"), purgeable = count("Pages purgeable") ?? 0;
  const wired = count("Pages wired down"), compressor = count("Pages occupied by compressor");
  if (!page || anonymous === undefined || wired === undefined || compressor === undefined || !(totalBytes > 0)) return undefined;
  const pageSize = +page[1];
  const used = (Math.max(0, anonymous - purgeable) + wired + compressor) * pageSize;
  return { usedPercent: Math.max(0, Math.min(100, (used / totalBytes) * 100)), compressedBytes: compressor * pageSize };
}

/** A process name fit for a one-line status: the command's base name, no separators, never ending in a prompt character. */
export function processName(command: string): string {
  const base = path.basename(command.trim()) || command.trim();
  const tidy = base.replace(/\s*\u00b7\s*/g, " ").replace(/\s+/g, " ").replace(/[%$#>\s]+$/, "");
  return tidy.length > 24 ? `${tidy.slice(0, 23)}…` : tidy;
}

/** `ps -A -o pid=,pcpu=,rss=,comm=` rows; the given pid is named `pi`. */
export function parsePs(text: string, selfPid: number): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = +match[1];
    const name = pid === selfPid ? "pi" : processName(match[4]);
    if (name) rows.push({ pid, cpu: +match[2], rssKb: +match[3], name });
  }
  return rows;
}

export interface SamplerDeps {
  platform: NodeJS.Platform;
  cpus: () => Pick<os.CpuInfo, "times">[];
  loadavg: () => number[];
  now: () => number;
  run: (command: string, args: string[]) => Promise<string>;
  read: (file: string) => Promise<string>;
  totalmem: () => number;
}

export const run = (command: string, args: string[], timeout = 1_500): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

export const defaultDeps: SamplerDeps = {
  platform: process.platform,
  cpus: () => os.cpus(),
  loadavg: () => os.loadavg(),
  now: () => Date.now(),
  run,
  read: (file) => readFile(file, "utf8"),
  totalmem: () => os.totalmem(),
};

const LINUX_PAGE = 4096;

/**
 * Reads on demand, keeping the previous counters to turn them into averages.
 * On macOS, memory and thermal come from the helper through `setDarwin`. Until
 * it reports (or when it cannot run), memory falls back to one `sysctl` per
 * read, at most every `darwinFallbackEveryMs`. Used memory and compressor size
 * come from one `vm_stat` per read, at most as often.
 */
export function createSampler(deps: SamplerDeps = defaultDeps, { darwinFallbackEveryMs = 10_000 } = {}) {
  let prev: { at: number; cpu: CpuTimes; psi?: Psi; pswpin?: number } | undefined;
  let darwin: { memory?: MemoryReading; thermal?: ThermalReading; live: boolean } = { live: false };
  let fallbackAt: number | undefined;
  let stats: { at: number; value?: DarwinMemoryStats } | undefined;
  const quiet = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    try { return await work(); } catch { return undefined; }
  };
  const darwinLevel = (level: number, at: number): MemoryReading =>
    darwin.memory?.source === "darwin" && darwin.memory.level === level ? darwin.memory : { source: "darwin", level, since: at };

  return {
    /** The helper's latest states; `live` stops the sysctl fallback. */
    setDarwin(update: { memoryLevel?: number; thermalState?: number; at: number }) {
      darwin.live = true;
      if (update.memoryLevel !== undefined) darwin.memory = darwinLevel(update.memoryLevel, update.at);
      if (update.thermalState !== undefined && darwin.thermal?.state !== update.thermalState) darwin.thermal = { state: update.thermalState, since: update.at };
    },
    /** The helper stopped: fall back to sysctl reads. */
    helperGone() { darwin = { ...darwin, live: false }; },
    async sample(): Promise<Reading> {
      const at = deps.now();
      const cpus = deps.cpus();
      const times = cpuTimes(cpus);
      const reading: Reading = { at, loadPerCore: (deps.loadavg()[0] ?? 0) / Math.max(1, cpus.length) };
      if (prev) {
        reading.since = prev.at;
        reading.cpu = busyPercent(prev.cpu, times);
      }
      const next: NonNullable<typeof prev> = { at, cpu: times };
      if (deps.platform === "darwin") {
        if (!darwin.live && (fallbackAt === undefined || at - fallbackAt >= darwinFallbackEveryMs)) {
          fallbackAt = at;
          const level = await quiet(async () => Number.parseInt((await deps.run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])).trim(), 10));
          if (level !== undefined && Number.isFinite(level)) darwin.memory = darwinLevel(level, at);
        }
        if (darwin.memory && (stats === undefined || at - stats.at >= darwinFallbackEveryMs)) {
          stats = { at, value: await quiet(async () => parseVmStat(await deps.run("vm_stat", []), deps.totalmem())) };
        }
        if (darwin.memory) reading.memory = stats?.value ? { ...darwin.memory, ...stats.value } : darwin.memory;
        if (darwin.thermal) reading.thermal = darwin.thermal;
      } else if (deps.platform === "linux") {
        const [psi, pswpin] = await Promise.all([
          quiet(async () => parsePsi(await deps.read("/proc/pressure/memory"))),
          quiet(async () => parseProcVmstat(await deps.read("/proc/vmstat"))),
        ]);
        if (psi) {
          reading.memory = { source: "psi", ...psiShare(prev?.psi ? { at: prev.at, psi: prev.psi } : undefined, at, psi) };
          next.psi = psi;
        }
        if (pswpin !== undefined) {
          next.pswpin = pswpin;
          if (prev?.pswpin !== undefined && pswpin >= prev.pswpin && at > prev.at) reading.swapInBps = ((pswpin - prev.pswpin) * LINUX_PAGE) / ((at - prev.at) / 1000);
        }
      }
      prev = next;
      return reading;
    },
    /** The busiest processes, by CPU or by resident memory. */
    async top(by: "cpu" | "memory", count = 1): Promise<ProcessRow[]> {
      const text = await quiet(() => deps.run("ps", ["-A", "-o", "pid=,pcpu=,rss=,comm="]));
      if (!text) return [];
      const rows = parsePs(text, process.pid);
      rows.sort((a, b) => by === "cpu" ? b.cpu - a.cpu : b.rssKb - a.rssKb);
      return rows.slice(0, count);
    },
  };
}

export type Sampler = ReturnType<typeof createSampler>;
