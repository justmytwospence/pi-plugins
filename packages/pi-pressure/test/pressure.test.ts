import { describe, expect, test } from "vitest";
import { mergeConfig } from "../src/index.ts";
import { bandLevel, createMonitor, DEFAULTS, formatRate, formatStatus, spark, topBy } from "../src/pressure.ts";
import { busyPercent, cpuTimes, createSampler, parseProcVmstat, parsePs, parsePsi, parseVmStat, processName, type Reading, type SamplerDeps } from "../src/sample.ts";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   493698.
Pageins:                                   482396237.
Pageouts:                                    2081330.
Swapins:                                     7202751.
Swapouts:                                   18609735.
`;
const PSI = "some avg10=12.50 avg60=2.48 avg300=2.55 total=74826079805\nfull avg10=3.10 avg60=0.00 avg300=0.00 total=1184582163\n";

describe("parsers", () => {
  test("vm_stat", () => {
    expect(parseVmStat(VM_STAT)).toEqual({ pageSize: 16384, swapins: 7202751 });
    expect(parseVmStat("nothing")).toBeUndefined();
  });
  test("PSI", () => {
    expect(parsePsi(PSI)).toEqual({ some: 12.5, full: 3.1 });
    expect(parsePsi("some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n")).toEqual({ some: 0, full: 0 });
  });
  test("/proc/vmstat", () => {
    expect(parseProcVmstat("pgpgin 5\npswpin 42\npswpout 7\n")).toBe(42);
  });
  test("ps rows: base names, pi itself, and names safe for a status line", () => {
    const rows = parsePs([
      "  101  97.5  204800 /usr/local/bin/node",
      "  202   3.0 4096000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper (Renderer)",
      "  303  12.0   1000 /opt/bin/weird · name%",
      "garbage",
    ].join("\n"), 101);
    expect(rows.map((r) => r.name)).toEqual(["pi", "Google Chrome Helper (R…", "weird name"]);
    expect(rows[1]).toMatchObject({ pid: 202, cpu: 3, rssKb: 4096000 });
    expect(processName("a/b/tool $")).toBe("tool");
  });
  test("cpu busy share from os.cpus() deltas", () => {
    const a = cpuTimes([{ times: { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } }]);
    const b = cpuTimes([{ times: { user: 190, nice: 0, sys: 0, idle: 910, irq: 0 } }]);
    expect(busyPercent(a, b)).toBe(90);
    expect(busyPercent(a, a)).toBeUndefined();
  });
});

describe("sampler", () => {
  const deps = (over: Partial<SamplerDeps>): SamplerDeps => {
    let t = 0, user = 0;
    return {
      platform: "darwin",
      cpus: () => { user += 95; return [{ times: { user, nice: 0, sys: 0, idle: 5 * (user / 95), irq: 0 } }]; },
      loadavg: () => [3, 0, 0],
      now: () => (t += 2_000),
      run: async (command) => (command === "sysctl" ? "2\n" : VM_STAT),
      read: async () => "",
      ...over,
    };
  };
  test("macOS: pressure level and swap-in rate", async () => {
    let swapins = 1000;
    const sampler = createSampler(deps({ run: async (command) => (command === "sysctl" ? "2\n" : `page size of 1024 bytes\nSwapins: ${(swapins += 2048)}.\n`) }), { darwinMemoryEveryMs: 0 });
    const first = await sampler.sample();
    expect(first.cpu).toBeUndefined();
    expect(first.memory).toEqual({ source: "darwin", level: 2 });
    expect(first.loadPerCore).toBe(3);
    const second = await sampler.sample();
    expect(second.cpu).toBeCloseTo(95);
    expect(second.swapInBps).toBe(2048 * 1024 / 2);
  });
  test("macOS: memory subprocesses run at most every darwinMemoryEveryMs; CPU every sample", async () => {
    const calls: string[] = [];
    const sampler = createSampler(deps({ run: async (command) => { calls.push(command); return command === "sysctl" ? "4\n" : VM_STAT; } }));
    const readings = [];
    for (let i = 0; i < 6; i++) readings.push(await sampler.sample()); // 2 s apart
    expect(calls).toEqual(["sysctl", "vm_stat", "sysctl", "vm_stat"]);
    expect(readings.every((r) => r.memory?.source === "darwin" && r.memory.level === 4)).toBe(true);
    expect(readings.slice(1).every((r) => r.cpu !== undefined)).toBe(true);
  });
  test("Linux: PSI and pswpin; failures leave fields out", async () => {
    let pswpin = 0;
    const sampler = createSampler(deps({ platform: "linux", read: async (file) => (file.endsWith("memory") ? PSI : `pswpin ${(pswpin += 500)}\n`) }));
    await sampler.sample();
    const reading = await sampler.sample();
    expect(reading.memory).toEqual({ source: "psi", some: 12.5, full: 3.1 });
    expect(reading.swapInBps).toBe(500 * 4096 / 2);
    const broken = createSampler(deps({ platform: "linux", read: async () => { throw new Error("ENOENT"); } }));
    expect((await broken.sample()).memory).toBeUndefined();
  });
  test("top process by cpu or memory", async () => {
    const sampler = createSampler(deps({ run: async () => "1 50.0 100 /bin/a\n2 10.0 900 /bin/b\n" }));
    expect((await sampler.top("cpu"))[0].name).toBe("a");
    expect((await sampler.top("memory"))[0].name).toBe("b");
  });
});

describe("levels", () => {
  const band = { warn: 85, hot: 95 };
  test("rise at the threshold, fall only below the margin", () => {
    expect(bandLevel(84, band, "ok", 5)).toBe("ok");
    expect(bandLevel(85, band, "ok", 5)).toBe("warn");
    expect(bandLevel(81, band, "warn", 5)).toBe("warn");
    expect(bandLevel(80, band, "warn", 5)).toBe("ok");
    expect(bandLevel(96, band, "warn", 5)).toBe("hot");
    expect(bandLevel(91, band, "hot", 5)).toBe("hot");
    expect(bandLevel(90, band, "hot", 5)).toBe("warn");
    expect(bandLevel(undefined, band, "hot", 5)).toBe("hot");
  });
});

describe("monitor", () => {
  const reading = (at: number, over: Partial<Reading> = {}): Reading => ({ at, cpu: 20, loadPerCore: 0.5, memory: { source: "darwin", level: 1 }, ...over });
  test("shows after sustained pressure, lingers, then hides", () => {
    const m = createMonitor(DEFAULTS);
    expect(m.step(reading(0, { cpu: 97 })).visible).toBe(false);
    expect(m.step(reading(8_000, { cpu: 97 })).visible).toBe(false);
    const shown = m.step(reading(10_000, { cpu: 97 }));
    expect(shown.visible).toBe(true);
    expect(shown.levels.cpu).toBe("hot");
    expect(shown.episode).toEqual(["cpu"]);
    // Memory joins the episode; easing keeps the row up for hideAfterMs.
    m.step(reading(12_000, { cpu: 90, memory: { source: "darwin", level: 2 } }));
    expect(m.step(reading(14_000)).visible).toBe(true);
    const lingering = m.step(reading(40_000));
    expect(lingering.visible).toBe(true);
    expect(lingering.episode).toEqual(["cpu", "mem"]);
    const hidden = m.step(reading(44_000));
    expect(hidden.visible).toBe(false);
    expect(hidden.episode).toEqual([]);
  });
  test("a brief spike never shows", () => {
    const m = createMonitor(DEFAULTS);
    m.step(reading(0, { cpu: 99 }));
    m.step(reading(2_000));
    expect(m.step(reading(20_000, { cpu: 99 })).visible).toBe(false);
  });
  test("pressure returning while lingering keeps it up", () => {
    const m = createMonitor({ ...DEFAULTS, showAfterMs: 0 });
    expect(m.step(reading(0, { cpu: 99 })).visible).toBe(true);
    m.step(reading(20_000));
    m.step(reading(25_000, { cpu: 99 }));
    expect(m.step(reading(50_000)).visible).toBe(true);
  });
});

describe("status", () => {
  test("spark: two samples per braille cell, filled from the bottom", () => {
    expect(spark([25, 25, 50, 50, 75, 75, 100, 100])).toBe("⣀⣤⣶⣿");
    expect(spark([0, 100, 100])).toBe("⠀⣿");
    expect(spark([10, 100])).toBe("⣸");
    expect(spark([])).toBe("");
  });
  test("rates", () => {
    expect(formatRate(40 * 1024 * 1024)).toBe("40MB/s");
    expect(formatRate(1.5 * 1024)).toBe("1.5KB/s");
    expect(formatRate(12)).toBe("12B/s");
  });
  test("format: episode signals, level words, culprit; never ends in a prompt character", () => {
    const m = createMonitor({ ...DEFAULTS, showAfterMs: 0 });
    // One sample per minute: each minute is a braille dot column.
    for (const [i, cpu] of [60, 80, 90, 97].entries()) m.step({ at: i * 60_000, cpu, loadPerCore: 1.6, memory: { source: "darwin", level: 2 }, swapInBps: 40 * 1024 * 1024 });
    const view = m.view();
    const text = formatStatus(view, "vitest")!;
    expect(text).toBe("pressure: cpu 97 hot · load 1.6 warn · mem warn · swap-in 40MB/s warn · top vitest · ⣴⣿");
    expect(formatStatus(view, undefined)).not.toMatch(/[%$#>]$/);
    expect(topBy(view)).toBe("cpu");
    expect(formatStatus({ ...view, visible: false }, "x")).toBeUndefined();
  });
  test("history: a mean per minute over the window, gaps blank, current minute last", () => {
    const m = createMonitor({ ...DEFAULTS, historyMinutes: 4 });
    const at = (minute: number, second: number) => minute * 60_000 + second * 1000;
    m.step({ at: at(0, 0), cpu: 100, loadPerCore: 0 });
    m.step({ at: at(1, 0), cpu: 20, loadPerCore: 0 });
    m.step({ at: at(1, 30), cpu: 40, loadPerCore: 0 });
    expect(m.view().history).toEqual([100, 30]);
    m.step({ at: at(3, 0), cpu: 50, loadPerCore: 0 });
    expect(m.view().history).toEqual([100, 30, undefined, 50]);
    // Minute 0 falls out of a four-minute window; a sample without CPU still advances it.
    m.step({ at: at(4, 0), loadPerCore: 0 });
    expect(m.view().history).toEqual([30, undefined, 50, undefined]);
    expect(spark(m.view().history)).toBe("⡀⡄");
  });
  test("memory-only pressure names the biggest process", () => {
    const m = createMonitor({ ...DEFAULTS, showAfterMs: 0 });
    expect(topBy(m.step({ at: 0, cpu: 10, loadPerCore: 0.2, memory: { source: "psi", some: 50, full: 0 } }))).toBe("memory");
  });
});

describe("config", () => {
  test("merges valid values over defaults, ignores the rest", () => {
    const config = mergeConfig({ cpu: { warn: 70 }, showAfterMs: 0, historyMinutes: 999 }, { cpu: { hot: -1 } as never, intervalMs: 10, enabled: false });
    expect(config.historyMinutes).toBe(120);
    expect(DEFAULTS.historyMinutes).toBe(60);
    expect(config.cpu).toEqual({ warn: 70, hot: 95 });
    expect(config.showAfterMs).toBe(0);
    expect(config.intervalMs).toBe(500);
    expect(config.enabled).toBe(false);
    expect(DEFAULTS.cpu.warn).toBe(85);
  });
});
