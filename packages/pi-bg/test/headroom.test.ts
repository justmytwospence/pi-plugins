import { describe, expect, it } from "vitest";
import { busyPercent, COOLDOWN_MS, cpuTimes, Headroom, parseDarwinMemory, parseLinuxMemory, SAMPLE_MS, type HostReading, type MemoryReading } from "../src/headroom.ts";

const signal = new AbortController().signal;
const healthy: MemoryReading = { source: "darwin", level: 1 };
const middle: MemoryReading = { source: "darwin", level: 2 };
const critical: MemoryReading = { source: "darwin", level: 4 };

function fixture() {
  let now = 0, idle = 1_000, total = 2_000, reads = 0;
  let reading: HostReading = { cpu: { idle, total }, memory: healthy };
  const policy = new Headroom({ now: () => now, read: () => { reads++; return reading; } });
  return {
    policy,
    reads: () => reads,
    async sample(cpu: number | undefined, memory: MemoryReading | null = healthy, elapsed = SAMPLE_MS) {
      now += elapsed;
      idle += 100 - (cpu ?? 0);
      total += 100;
      reading = { cpu: cpu === undefined ? undefined : { idle, total }, memory: memory ?? undefined };
      await policy.sample(signal);
    },
  };
}

describe("heavy-job headroom", () => {
  it("uses CPU deltas, not lifetime counters, and drops invalid intervals", () => {
    const prev = cpuTimes([{ times: { user: 80, nice: 10, sys: 7, idle: 900, irq: 3 } }])!;
    const next = cpuTimes([{ times: { user: 155, nice: 20, sys: 7, idle: 910, irq: 8 } }])!;
    expect(prev).toEqual({ idle: 900, total: 1000 });
    expect(busyPercent(prev, next)).toBe(90);
    expect(busyPercent(next, next)).toBeUndefined();
    expect(busyPercent(next, prev)).toBeUndefined();
    expect(busyPercent(prev, { total: 1100, idle: 899 })).toBeUndefined();
    expect(busyPercent(prev, { total: 1100, idle: 1001 })).toBeUndefined();
    expect(cpuTimes([])).toBeUndefined();
    expect(cpuTimes([{ times: { user: NaN, nice: 0, sys: 0, idle: 900, irq: 0 } }])).toBeUndefined();
  });

  it("admits the first healthy job without cooldown, then needs two healthy samples and ten seconds for the second", async () => {
    const { policy, sample, reads } = fixture();
    await sample(30);
    expect(policy.blockedReason(0, 0)).toBe("sampling host CPU");
    await sample(30, healthy, 100);
    expect(reads()).toBe(1);
    await sample(30, healthy, SAMPLE_MS - 100);
    expect(policy.blockedReason(0, 0)).toBeUndefined();
    expect(policy.blockedReason(1, COOLDOWN_MS)).toBe("waiting for healthy host samples");
    await sample(30);
    expect(policy.blockedReason(1, COOLDOWN_MS - 1)).toBe("waiting for admission cooldown");
    expect(policy.blockedReason(1, COOLDOWN_MS)).toBeUndefined();
    expect(policy.blockedReason(2, Infinity)).toBe("both heavy-job slots are occupied");
  });

  it("blocks new first jobs only after sustained busy CPU and recovers on a non-busy interval", async () => {
    const { policy, sample } = fixture();
    await sample(30);
    await sample(30);
    await sample(90);
    expect(policy.blockedReason(0, 0)).toBeUndefined();
    await sample(91);
    expect(policy.blockedReason(0, 0)).toBe("CPU 91%");
    await sample(89);
    expect(policy.blockedReason(0, 0)).toBeUndefined();
    await sample(89);
    expect(policy.blockedReason(1, COOLDOWN_MS)).toBe("CPU 89%");
    await sample(70);
    expect(policy.blockedReason(1, COOLDOWN_MS)).toBe("CPU 70%");
    await sample(69);
    expect(policy.blockedReason(1, COOLDOWN_MS)).toBe("waiting for healthy host samples");
    await sample(69);
    expect(policy.blockedReason(1, COOLDOWN_MS)).toBeUndefined();
  });

  it("checks a cold high CPU interval before granting the first slot", async () => {
    const { policy, sample } = fixture();
    await sample(90);
    await sample(90);
    expect(policy.blockedReason(0, 0)).toBe("sampling host CPU");
    await sample(90);
    expect(policy.blockedReason(0, 0)).toBe("CPU 90%");
    await sample(89);
    expect(policy.blockedReason(0, 0)).toBeUndefined();
  });

  it("checks critical Darwin memory immediately and resets expansion evidence on a warning or a gap", async () => {
    const { policy, sample } = fixture();
    await sample(20, critical);
    expect(policy.blockedReason(0, 0)).toBe("waiting for memory pressure to ease");
    await sample(20, healthy);
    await sample(20, healthy);
    expect(policy.blockedReason(1, COOLDOWN_MS)).toBeUndefined();
    await sample(20, middle);
    expect(policy.blockedReason(0, 0)).toBeUndefined();
    expect(policy.blockedReason(1, COOLDOWN_MS)).toBe("waiting for memory pressure to ease");
    await sample(20, healthy);
    await sample(20, healthy, 3 * SAMPLE_MS);
    await sample(20, healthy);
    expect(policy.blockedReason(1, COOLDOWN_MS)).toBe("waiting for healthy host samples");
    await sample(20, healthy);
    expect(policy.blockedReason(1, COOLDOWN_MS)).toBeUndefined();
  });

  it("uses Linux PSI avg10 and available RAM independently and applies strict thresholds", async () => {
    const { policy, sample } = fixture();
    const psi = (some: number, full: number) => `some avg10=${some} avg60=70.00 avg300=80.04 total=19\nfull avg10=${full} avg60=60 total=1\n`;
    const ram = (available: number) => `MemTotal:        1000 kB\nMemAvailable:     ${available} kB\nSwapTotal: 900 kB\nSwapFree: 0 kB\n`;
    const linux = parseLinuxMemory(psi(4.99, 0.99), ram(200));
    expect(linux).toEqual({ source: "linux", some: 4.99, full: 0.99, available: 20 });
    await sample(20, linux);
    await sample(20, linux);
    await sample(20, linux);
    expect(policy.blockedReason(1, COOLDOWN_MS)).toBeUndefined();
    for (const reading of [parseLinuxMemory(psi(5, 0), ram(200)), parseLinuxMemory(psi(0, 1), ram(200)), parseLinuxMemory(psi(0, 0), ram(50))]) {
      await sample(20, reading);
      expect(policy.blockedReason(0, 0)).toBeUndefined();
      expect(policy.blockedReason(1, COOLDOWN_MS)).toBe("waiting for memory pressure to ease");
    }
    for (const reading of [parseLinuxMemory(psi(0, 5)), parseLinuxMemory(undefined, ram(49))]) {
      await sample(20, reading);
      expect(policy.blockedReason(0, 0)).toBe("waiting for memory pressure to ease");
    }
  });

  it("falls back to one slot on missing or malformed sensors, never expanding on partial health", async () => {
    const { policy, sample } = fixture();
    expect(parseDarwinMemory("4\n")).toEqual(critical);
    for (const text of ["", "0", "3", "1junk", "2 4"]) expect(parseDarwinMemory(text)).toBeUndefined();
    const malformed = parseLinuxMemory("some avg10=0junk\nfull avg10=0.1.2\n", "MemTotal: 1000 kB\nMemAvailable: 1001 kB\n");
    expect(malformed).toEqual({ source: "linux", some: undefined, full: undefined, available: undefined });
    await sample(undefined, null);
    expect(policy.blockedReason(0, 0)).toBeUndefined();
    expect(policy.blockedReason(1, COOLDOWN_MS)).toBe("waiting for host readings");
    await sample(20, healthy);
    await sample(20, malformed);
    await sample(20, { source: "linux", some: 0, available: 90 });
    expect(policy.blockedReason(0, 0)).toBeUndefined();
    expect(policy.blockedReason(1, COOLDOWN_MS)).toBe("waiting for host readings");
    await sample(20);
    expect(policy.blockedReason(1, COOLDOWN_MS)).toBe("waiting for healthy host samples");
  });
});
