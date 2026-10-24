import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ensureHelper, parseHelperLine, startHelper, type HelperLine } from "../src/darwin.ts";
import { mergeConfig } from "../src/index.ts";
import { bandLevel, createMonitor, DEFAULTS, formatRate, formatStatus, topBy, trends } from "../src/pressure.ts";
import { busyPercent, cpuTimes, createSampler, parseProcVmstat, parsePs, parsePsi, processName, psiShare, type Reading, type SamplerDeps } from "../src/sample.ts";

const PSI = "some avg10=12.50 avg60=2.48 avg300=2.55 total=1000000\nfull avg10=3.10 avg60=0.00 avg300=0.00 total=200000\n";

describe("parsers", () => {
  test("PSI: avg10 and cumulative stall totals", () => {
    expect(parsePsi(PSI)).toEqual({ someAvg10: 12.5, fullAvg10: 3.1, someTotal: 1_000_000, fullTotal: 200_000 });
    expect(parsePsi("some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n")).toEqual({ someAvg10: 0, fullAvg10: 0, someTotal: 1, fullTotal: 0 });
  });
  test("PSI share between two reads is exact; the first read uses the kernel's avg10", () => {
    const first = parsePsi(PSI)!;
    expect(psiShare(undefined, 0, first)).toEqual({ some: 12.5, full: 3.1 });
    // 10 s later, 2 s more of some-stall and 0.5 s of full-stall.
    const later = { ...first, someTotal: first.someTotal + 2_000_000, fullTotal: first.fullTotal + 500_000 };
    expect(psiShare({ at: 0, psi: first }, 10_000, later)).toEqual({ some: 20, full: 5 });
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
  test("helper lines", () => {
    expect(parseHelperLine("memory 4")).toEqual({ memoryLevel: 4 });
    expect(parseHelperLine("thermal 2\n")).toEqual({ thermalState: 2 });
    expect(parseHelperLine("hello")).toBeUndefined();
  });
});

describe("sampler", () => {
  const deps = (over: Partial<SamplerDeps>, step = 2_000): SamplerDeps => {
    let t = 0, user = 0;
    return {
      platform: "darwin",
      cpus: () => { user += 95; return [{ times: { user, nice: 0, sys: 0, idle: 5 * (user / 95), irq: 0 } }]; },
      loadavg: () => [3, 0, 0],
      now: () => (t += step),
      run: async () => "2\n",
      read: async () => "",
      ...over,
    };
  };
  test("each read covers the interval since the previous one, however long", async () => {
    const sampler = createSampler(deps({}, 20 * 60_000));
    const first = await sampler.sample();
    expect(first.cpu).toBeUndefined();
    expect(first.since).toBeUndefined();
    expect(first.loadPerCore).toBe(3);
    const second = await sampler.sample();
    expect(second.since).toBe(first.at);
    expect(second.at - second.since!).toBe(20 * 60_000);
    expect(second.cpu).toBeCloseTo(95);
  });
  test("macOS: the helper's states replace sysctl; without it, one sysctl at most every 10 s", async () => {
    const calls: string[] = [];
    const sampler = createSampler(deps({ run: async (command) => { calls.push(command); return "2\n"; } }));
    for (let i = 0; i < 6; i++) await sampler.sample(); // 2 s apart
    expect(calls).toEqual(["sysctl", "sysctl"]);
    sampler.setDarwin({ memoryLevel: 4, thermalState: 2, at: 50_000 });
    const pushed = await sampler.sample();
    expect(pushed.memory).toEqual({ source: "darwin", level: 4, since: 50_000 });
    expect(pushed.thermal).toEqual({ state: 2, since: 50_000 });
    // The same level again keeps its start time.
    sampler.setDarwin({ memoryLevel: 4, at: 60_000 });
    expect((await sampler.sample()).memory).toMatchObject({ since: 50_000 });
    expect(calls).toHaveLength(2);
    sampler.helperGone();
    for (let i = 0; i < 6; i++) await sampler.sample();
    expect(calls.length).toBeGreaterThan(2);
  });
  test("Linux: PSI share and swap-in rate over the interval; failures leave fields out", async () => {
    let some = 0, pswpin = 0;
    const sampler = createSampler(deps({
      platform: "linux",
      read: async (file) => (file.endsWith("memory") ? `some avg10=1.00 avg60=0 avg300=0 total=${(some += 400_000)}\nfull avg10=0.00 avg60=0 avg300=0 total=0\n` : `pswpin ${(pswpin += 500)}\n`),
    }));
    expect((await sampler.sample()).memory).toEqual({ source: "psi", some: 1, full: 0 });
    const reading = await sampler.sample();
    expect(reading.memory).toEqual({ source: "psi", some: 20, full: 0 });
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
  const reading = (at: number, over: Partial<Reading> = {}): Reading => ({ at, since: at - 2_000, cpu: 20, loadPerCore: 0.5, ...over });
  test("a busy interval at least showAfterMs long shows at once; a short one waits for a check", () => {
    const m = createMonitor(DEFAULTS);
    expect(m.step(reading(100_000, { since: 80_000, cpu: 97 })).visible).toBe(true);
    const n = createMonitor(DEFAULTS);
    n.step(reading(0, { since: undefined, cpu: undefined }));
    expect(n.nextCheck()).toBeUndefined(); // steady state: nothing armed
    expect(n.step(reading(4_000, { cpu: 97 })).visible).toBe(false);
    expect(n.nextCheck()).toBe(2_000 + DEFAULTS.showAfterMs);
    const shown = n.step(reading(12_000, { since: 4_000, cpu: 97 }));
    expect(shown.visible).toBe(true);
    expect(shown.levels.cpu).toBe("hot");
    expect(shown.episode).toEqual(["cpu"]);
  });
  test("lingers once it eases, re-checking while idle, then hides", () => {
    const m = createMonitor({ ...DEFAULTS, showAfterMs: 0 });
    m.step(reading(0, { cpu: 97 }));
    expect(m.nextCheck()).toBe(DEFAULTS.refreshMs);
    m.step(reading(5_000, { memory: { source: "darwin", level: 2, since: 4_000 } }));
    const eased = m.step(reading(10_000));
    expect(eased.visible).toBe(true);
    expect(m.nextCheck()).toBe(10_000 + DEFAULTS.refreshMs);
    expect(m.step(reading(39_000)).visible).toBe(true);
    expect(m.nextCheck()).toBe(40_000);
    const hidden = m.step(reading(40_000));
    expect(hidden.visible).toBe(false);
    expect(hidden.episode).toEqual([]);
    expect(m.nextCheck()).toBeUndefined();
  });
  test("a state that just changed is not backdated over a long interval", () => {
    const m = createMonitor(DEFAULTS);
    expect(m.step(reading(600_000, { since: 0, memory: { source: "darwin", level: 4, since: 599_000 } })).visible).toBe(false);
    expect(m.nextCheck()).toBe(599_000 + DEFAULTS.showAfterMs);
    expect(m.step(reading(609_500, { memory: { source: "darwin", level: 4, since: 599_000 } })).visible).toBe(true);
  });
  test("thermal throttling is a signal", () => {
    const m = createMonitor({ ...DEFAULTS, showAfterMs: 0 });
    const view = m.step(reading(0, { thermal: { state: 2, since: -1 } }));
    expect(view.levels.heat).toBe("warn");
    expect(view.episode).toEqual(["heat"]);
    expect(createMonitor(DEFAULTS).step(reading(0, { thermal: { state: 1, since: 0 } })).levels.heat).toBe("ok");
  });
  test("trends: an arrow only while the last 15 s moved a signal by its step against the minute before", () => {
    const steady = Array.from({ length: 30 }, (_, i) => reading((i + 1) * 2_000, { cpu: 50 }));
    expect(trends(steady, 60_000)).toEqual({});
    const rising = [...steady.slice(0, 22), ...Array.from({ length: 8 }, (_, i) => reading(46_000 + (i + 1) * 2_000, { cpu: 80 }))];
    expect(trends(rising, 62_000)).toEqual({ cpu: "up" });
    // Small moves (under 15 points) do not count.
    const drifting = [...steady.slice(0, 22), ...Array.from({ length: 8 }, (_, i) => reading(46_000 + (i + 1) * 2_000, { cpu: 60 }))];
    expect(trends(drifting, 62_000)).toEqual({});
    // macOS memory level 1 -> 2 is a step; load falling by 0.3 per core is too.
    const memory = [reading(10_000, { loadPerCore: 1.2, memory: { source: "darwin", level: 1, since: 0 } }), reading(55_000, { since: 10_000, loadPerCore: 0.8, memory: { source: "darwin", level: 2, since: 50_000 } })];
    expect(trends(memory, 55_000)).toMatchObject({ mem: "up", load: "down" });
    // One read covering a long idle stretch has nothing to compare against.
    expect(trends([reading(600_000, { since: 0, cpu: 90 })], 600_000)).toEqual({});
  });
  test("the monitor's view carries trends from the last minute of readings", () => {
    const m = createMonitor({ ...DEFAULTS, showAfterMs: 0 });
    for (let i = 1; i <= 22; i++) m.step(reading(i * 2_000, { cpu: 30 }));
    let view = m.view();
    for (let i = 23; i <= 30; i++) view = m.step(reading(i * 2_000, { cpu: 97 }));
    expect(view.trends.cpu).toBe("up");
    expect(formatStatus(view, undefined)).toBe("pressure: cpu 97 \u2191 hot");
  });
  test("shown by hand: visible without pressure, every signal with a reading, kept current", () => {
    const m = createMonitor(DEFAULTS);
    m.step(reading(0, { memory: { source: "darwin", level: 1, since: 0 } }));
    expect(m.nextCheck()).toBeUndefined();
    const view = m.setMode("shown");
    expect(view.visible).toBe(true);
    expect(view.episode).toEqual(["cpu", "load", "mem"]);
    expect(m.nextCheck()).toBe(DEFAULTS.refreshMs);
    expect(formatStatus(view, undefined)).toBe("pressure: cpu 20 ok \u00b7 load 0.5 ok \u00b7 mem ok");
    // It stays until hidden; hiding with no episode running hands it back to auto.
    expect(m.step(reading(100_000)).visible).toBe(true);
    m.setMode("hidden");
    expect(m.step(reading(102_000)).mode).toBe("auto");
    expect(m.nextCheck()).toBeUndefined();
  });
  test("hidden by hand: stays hidden for the rest of the episode, and the next one shows again", () => {
    const m = createMonitor({ ...DEFAULTS, showAfterMs: 0 });
    expect(m.step(reading(0, { cpu: 97 })).visible).toBe(true);
    expect(m.setMode("hidden").visible).toBe(false);
    expect(m.step(reading(20_000, { cpu: 97 })).visible).toBe(false);
    // Still checking while idle, so it notices the episode end.
    expect(m.nextCheck()).toBe(20_000 + DEFAULTS.refreshMs);
    const eased = m.step(reading(25_000));
    expect(eased.mode).toBe("hidden");
    expect(m.step(reading(55_000)).mode).toBe("auto");
    expect(m.step(reading(60_000, { cpu: 97 })).visible).toBe(true);
  });
  test("enabled: false never shows on its own, but shows by hand", () => {
    const m = createMonitor({ ...DEFAULTS, enabled: false, showAfterMs: 0 });
    expect(m.step(reading(0, { cpu: 97 })).visible).toBe(false);
    expect(m.setMode("shown").visible).toBe(true);
  });
  test("memory-only pressure names the biggest process", () => {
    const m = createMonitor({ ...DEFAULTS, showAfterMs: 0 });
    expect(topBy(m.step({ at: 0, cpu: 10, loadPerCore: 0.2, memory: { source: "psi", some: 50, full: 0 } }))).toBe("memory");
  });
});

describe("status", () => {
  test("rates", () => {
    expect(formatRate(40 * 1024 * 1024)).toBe("40MB/s");
    expect(formatRate(1.5 * 1024)).toBe("1.5KB/s");
    expect(formatRate(12)).toBe("12B/s");
  });
  test("format: episode signals, level words, then the culprit; never ends in a prompt character", () => {
    const m = createMonitor({ ...DEFAULTS, showAfterMs: 0 });
    // One read per minute: each minute is a braille dot column.
    for (const [i, cpu] of [60, 80, 90, 97].entries()) m.step({ at: (i + 1) * 60_000, since: i * 60_000, cpu, loadPerCore: 1.6, memory: { source: "darwin", level: 2, since: 0 }, thermal: { state: 2, since: 0 } });
    const view = m.view();
    // One read a minute: too sparse for a trend.
    expect(formatStatus(view, "vitest")).toBe("pressure: cpu 97 hot · load 1.6 warn · mem warn · thermal warn · top vitest");
    expect(formatStatus(view, undefined)).not.toMatch(/[%$#>]$/);
    // The label takes the level's color as well as the value.
    const tagged = formatStatus(view, undefined, { level: (level, text) => `<${level}>${text}</>`, dim: (text) => text })!;
    expect(tagged).toContain("<hot>cpu</> <hot>97 hot</>");
    expect(tagged).toContain("<warn>mem</> <warn>warn</>");
    expect(topBy(view)).toBe("cpu");
    expect(formatStatus({ ...view, visible: false }, "x")).toBeUndefined();
  });
});

describe("config", () => {
  test("merges valid values over defaults, ignores the rest", () => {
    const config = mergeConfig({ cpu: { warn: 70 }, showAfterMs: 0 }, { cpu: { hot: -1 } as never, minGapMs: 10, enabled: false });
    expect(config.cpu).toEqual({ warn: 70, hot: 95 });
    expect(config.showAfterMs).toBe(0);
    expect(config.minGapMs).toBe(250);
    expect(config.enabled).toBe(false);
    expect(DEFAULTS.cpu.warn).toBe(85);
  });
});

const hasSwift = (() => {
  if (process.platform !== "darwin") return false;
  try { execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" }); return true; } catch { return false; }
})();

describe.skipIf(!hasSwift)("macOS helper", () => {
  test("compiles, reports both states at start, and exits when its stdin closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-pressure-test-"));
    try {
      const binary = await ensureHelper(dir);
      expect(binary).toBeDefined();
      expect(await ensureHelper(dir)).toBe(binary); // cached
      const lines: HelperLine[] = [];
      let exited = false;
      const helper = startHelper(binary!, (line) => lines.push(line), () => { exited = true; });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(lines.some((l) => "memoryLevel" in l && [1, 2, 4].includes(l.memoryLevel))).toBe(true);
      expect(lines.some((l) => "thermalState" in l && l.thermalState >= 0 && l.thermalState <= 3)).toBe(true);
      expect(exited).toBe(false);
      helper.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
