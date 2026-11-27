import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";

export const SAMPLE_MS = 2_000;
export const COOLDOWN_MS = 10_000;

export interface CpuTimes { idle: number; total: number }
export type MemoryReading =
  | { source: "darwin"; level: number }
  | { source: "linux"; some?: number; full?: number; available?: number };
export interface HostReading { cpu?: CpuTimes; memory?: MemoryReading }
export interface HeadroomOptions {
  now?: () => number;
  read?: (signal: AbortSignal) => HostReading | Promise<HostReading>;
}

export function cpuTimes(cpus: Pick<os.CpuInfo, "times">[]): CpuTimes | undefined {
  let idle = 0, total = 0;
  for (const { times } of cpus) {
    const counters = [times.user, times.nice, times.sys, times.idle, times.irq];
    if (counters.some((time) => !Number.isFinite(time) || time < 0)) return undefined;
    idle += times.idle;
    total += counters.reduce((sum, time) => sum + time, 0);
  }
  return total > 0 ? { idle, total } : undefined;
}

function validCpu(times: CpuTimes | undefined): times is CpuTimes {
  return !!times && Number.isFinite(times.total) && Number.isFinite(times.idle)
    && times.total > 0 && times.idle >= 0 && times.idle <= times.total;
}

export function busyPercent(prev: CpuTimes, next: CpuTimes): number | undefined {
  if (!validCpu(prev) || !validCpu(next)) return undefined;
  const total = next.total - prev.total, idle = next.idle - prev.idle;
  if (total <= 0 || idle < 0 || idle > total) return undefined;
  return (total - idle) / total * 100;
}

const validPercent = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0 && value <= 100;

export function parseDarwinMemory(text: string): MemoryReading | undefined {
  const level = text.trim();
  if (level === "1" || level === "2" || level === "4") return { source: "darwin", level: +level };
}

export function parseLinuxMemory(psi = "", meminfo = ""): MemoryReading {
  const avg10 = (kind: "some" | "full") => {
    const value = Number(new RegExp(`^${kind} +avg10=(\\d+(?:\\.\\d+)?)(?=\\s|$)`, "m").exec(psi)?.[1]);
    return validPercent(value) ? value : undefined;
  };
  const total = Number(/^MemTotal:[ \t]+(\d+)[ \t]+kB[ \t]*$/m.exec(meminfo)?.[1]);
  const available = Number(/^MemAvailable:[ \t]+(\d+)[ \t]+kB[ \t]*$/m.exec(meminfo)?.[1]);
  return {
    source: "linux", some: avg10("some"), full: avg10("full"),
    available: Number.isSafeInteger(total) && total > 0 && Number.isSafeInteger(available) && available <= total
      ? available / total * 100 : undefined,
  };
}

function memoryBand(memory: MemoryReading | undefined): "critical" | "middle" | "healthy" | "unknown" {
  if (!memory) return "unknown";
  if (memory.source === "darwin") {
    switch (memory.level) {
      case 4: return "critical";
      case 2: return "middle";
      case 1: return "healthy";
      default: return "unknown";
    }
  }
  const { some, full, available } = memory;
  if ((validPercent(full) && full >= 5) || (validPercent(available) && available < 5)) return "critical";
  if (!validPercent(some) || !validPercent(full) || !validPercent(available)) return "unknown";
  return some < 5 && full < 1 && available >= 20 ? "healthy" : "middle";
}

async function readHost(signal: AbortSignal): Promise<HostReading> {
  let cpu: CpuTimes | undefined;
  try { cpu = cpuTimes(os.cpus()); } catch { /* unavailable */ }
  let memory: MemoryReading | undefined;
  if (process.platform === "darwin") {
    memory = await new Promise((resolve) => {
      execFile("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], {
        signal, timeout: 1_000, killSignal: "SIGKILL", maxBuffer: 1024,
      }, (error, stdout) => resolve(error ? undefined : parseDarwinMemory(stdout)));
    });
  } else if (process.platform === "linux") {
    const read = (path: string) => readFile(path, { encoding: "utf8", signal }).catch(() => undefined);
    const [psi, meminfo] = await Promise.all([read("/proc/pressure/memory"), read("/proc/meminfo")]);
    memory = parseLinuxMemory(psi, meminfo);
  }
  signal.throwIfAborted();
  return { cpu, memory };
}

/** One waiter's rolling evidence. It reads on demand only, never from an idle timer. */
export class Headroom {
  readonly #now: NonNullable<HeadroomOptions["now"]>;
  readonly #read: NonNullable<HeadroomOptions["read"]>;
  #previous?: { at: number; cpu?: CpuTimes };
  #memory: ReturnType<typeof memoryBand> = "unknown";
  #cpu?: number;
  #warming = true;
  #busy = 0;
  #healthy = 0;

  constructor({ now = () => performance.now(), read = readHost }: HeadroomOptions = {}) {
    this.#now = now;
    this.#read = read;
  }

  async sample(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const at = this.#now();
    const previous = this.#previous;
    if (previous && at >= previous.at && at - previous.at < SAMPLE_MS) return;
    const reading = await this.#read(signal);
    signal.throwIfAborted();

    // Don't count a long gap (e.g. both slots were full) as a healthy or busy interval.
    const continuous = previous && at >= previous.at && at - previous.at <= 2 * SAMPLE_MS;
    const times = validCpu(reading.cpu) ? reading.cpu : undefined;
    const cpu = continuous && previous.cpu && times ? busyPercent(previous.cpu, times) : undefined;
    this.#previous = { at, cpu: times };
    this.#cpu = cpu;
    this.#memory = memoryBand(reading.memory);
    this.#busy = cpu !== undefined && cpu >= 90 ? Math.min(2, this.#busy + 1) : 0;
    this.#healthy = cpu !== undefined && cpu < 70 && this.#memory === "healthy" ? Math.min(2, this.#healthy + 1) : 0;
    // Read at least one delta when counters exist. A cold high reading warrants a
    // second interval; missing counters must still permit the single-slot fallback.
    if (!continuous) this.#warming = times !== undefined;
    else if (cpu === undefined || cpu < 90 || this.#busy >= 2) this.#warming = false;
  }

  blockedReason(occupied: number, admissionAgeMs: number): string | undefined {
    if (occupied >= 2) return "both heavy-job slots are occupied";
    if (this.#memory === "critical") return "waiting for memory pressure to ease";
    if (this.#busy >= 2 || (occupied === 1 && this.#cpu !== undefined && this.#cpu >= 70)) {
      return `CPU ${Math.round(this.#cpu!)}%`;
    }
    if (occupied === 0) {
      if (this.#warming) return "sampling host CPU";
      return;
    }
    if (this.#memory === "middle") return "waiting for memory pressure to ease";
    if (this.#memory === "unknown") return "waiting for host readings";
    if (this.#healthy < 2) return this.#warming || this.#cpu !== undefined
      ? "waiting for healthy host samples" : "waiting for host readings";
    if (!(admissionAgeMs >= COOLDOWN_MS)) return "waiting for admission cooldown";
  }
}
