// Reads the machine's CPU and memory pressure without dependencies: os.cpus()
// deltas and load for CPU; on macOS the kernel's memory pressure level and the
// swap-in count from vm_stat; on Linux pressure stall information (PSI) and
// /proc/vmstat. Parsers are pure so tests can feed them captured output.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CpuTimes { idle: number; total: number }

/** Memory pressure as the platform reports it. */
export type MemoryReading =
  /** macOS kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical. */
  | { source: "darwin"; level: number }
  /** Linux PSI avg10, percent of time some/all tasks stalled on memory. */
  | { source: "psi"; some: number; full: number };

export interface Reading {
  at: number;
  /** Busy share of all cores since the previous sample, 0-100; absent on the first sample. */
  cpu?: number;
  /** One-minute load average per core. */
  loadPerCore: number;
  memory?: MemoryReading;
  /** Bytes swapped in per second since the previous sample. */
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

/** `vm_stat`'s page size and cumulative swap-ins. */
export function parseVmStat(text: string): { pageSize: number; swapins: number } | undefined {
  const pageSize = /page size of (\d+) bytes/.exec(text);
  const swapins = /^Swapins:\s+(\d+)\.?$/m.exec(text);
  return pageSize && swapins ? { pageSize: +pageSize[1], swapins: +swapins[1] } : undefined;
}

/** avg10 of the `some` and `full` lines of a /proc/pressure file. */
export function parsePsi(text: string): { some: number; full: number } | undefined {
  const some = /^some avg10=([\d.]+)/m.exec(text);
  if (!some) return undefined;
  const full = /^full avg10=([\d.]+)/m.exec(text);
  return { some: +some[1], full: full ? +full[1] : 0 };
}

/** Cumulative pages swapped in, from /proc/vmstat. */
export function parseProcVmstat(text: string): number | undefined {
  const match = /^pswpin (\d+)$/m.exec(text);
  return match ? +match[1] : undefined;
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
}

const run = (command: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 1_500, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
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
};

const LINUX_PAGE = 4096;

/** Samples on demand, keeping the previous counters to turn them into rates. */
export function createSampler(deps: SamplerDeps = defaultDeps) {
  let prevCpu: CpuTimes | undefined;
  let prevSwap: { at: number; bytes: number } | undefined;
  const swapRate = (at: number, bytes: number | undefined): number | undefined => {
    if (bytes === undefined) return undefined;
    const prev = prevSwap;
    prevSwap = { at, bytes };
    if (!prev || at <= prev.at || bytes < prev.bytes) return undefined;
    return (bytes - prev.bytes) / ((at - prev.at) / 1000);
  };
  const quiet = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    try { return await work(); } catch { return undefined; }
  };

  return {
    async sample(): Promise<Reading> {
      const at = deps.now();
      const cpus = deps.cpus();
      const times = cpuTimes(cpus);
      const cpu = prevCpu ? busyPercent(prevCpu, times) : undefined;
      prevCpu = times;
      const loadPerCore = (deps.loadavg()[0] ?? 0) / Math.max(1, cpus.length);
      const reading: Reading = { at, cpu, loadPerCore };
      if (deps.platform === "darwin") {
        const [level, vm] = await Promise.all([
          quiet(async () => Number.parseInt((await deps.run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])).trim(), 10)),
          quiet(async () => parseVmStat(await deps.run("vm_stat", []))),
        ]);
        if (level !== undefined && Number.isFinite(level)) reading.memory = { source: "darwin", level };
        reading.swapInBps = swapRate(at, vm ? vm.swapins * vm.pageSize : undefined);
      } else if (deps.platform === "linux") {
        const [psi, vmstat] = await Promise.all([
          quiet(async () => parsePsi(await deps.read("/proc/pressure/memory"))),
          quiet(async () => parseProcVmstat(await deps.read("/proc/vmstat"))),
        ]);
        if (psi) reading.memory = { source: "psi", ...psi };
        reading.swapInBps = swapRate(at, vmstat === undefined ? undefined : vmstat * LINUX_PAGE);
      }
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
