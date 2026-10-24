import { describe, expect, it } from "vitest";
import {
  CATALOGUE,
  DETECT_HITS,
  DONE_QUIET_MS,
  ProgressTracker,
  bar,
  eta,
  etaText,
  parseNumber,
  parseProgressFile,
  percent,
  progressSpec,
} from "../src/progress.ts";

const read = (name: string, line: string) => CATALOGUE.find((f) => f.name === name)?.read(line);
const detect = (line: string) => {
  for (const f of CATALOGUE) {
    const r = f.read(line);
    if (r) return { name: f.name, ...r };
  }
  return undefined;
};

// Captured from tqdm 4 and pytest 9 writing to a pipe; the others follow each tool's documented output.
const SAMPLES: [string, string, number, string?][] = [
  ["tqdm", " 45%|████▌     | 450/1000 [00:00<00:00, 14085349.25it/s]", 0.45, "450/1000"],
  ["tqdm", " 33%|███▎      | 4.00k/12.0k [00:00<00:00, 25.7Mit/s]", 4 / 12, "4.00k/12.0k"],
  ["tqdm", "  0%|          | 0.00/12.0k [00:00<?, ?it/s]", 0, "0.00/12.0k"],
  ["tqdm", "epoch:  30%|███       | 3/10 [00:00<00:00, 58217.30it/s]", 0.3, "3/10"],
  ["pytest", "test_m2.py ..                                                            [ 50%]", 0.5],
  ["pytest", "test_m1.py::test_b PASSED                                                [ 25%]", 0.25],
  ["pytest", "[gw0] [ 45%] PASSED tests/test_a.py::test_one ", 0.45],
  ["cargo", "    Building [=======>                 ] 45/120: serde, syn", 0.375, "45/120"],
  ["keras", "120/500 [=====>........................] - ETA: 3s - loss: 0.1234", 0.24, "120/500"],
  ["keras", "120/500 ━━━━━━━━━━━━━━━━━━━━ 3s 6ms/step - loss: 0.1234", 0.24, "120/500"],
  ["rich", "   ━━━━━━━━━━━━━━━━━━━━╸━━━━━━━━━━━━━━━━━━━ 1.2/3.0 MB 5.0 MB/s eta 0:00:01", 0.4, "1.2/3.0 MB"],
  ["rich", "Downloading ━━━━━━━━━━╺━━━━━━━━━━  50% 0:00:02", 0.5],
  ["wget", "  4500K .......... .......... .......... .......... .......... 45% 1.23M 3s", 0.45],
  ["rsync", "  1,234,567  45%  1.23MB/s    0:00:12 (xfr#3, to-chk=7/12)", 0.45],
];

describe("catalogue", () => {
  it.each(SAMPLES)("%s reads %j", (name, line, fraction, count) => {
    const r = detect(line);
    expect(r?.name).toBe(name);
    expect(r?.fraction).toBeCloseTo(fraction, 5);
    if (count) expect(r?.count).toBe(count);
  });

  it.each([
    "2024-10-24 12:00:01 INFO processed 3/10 files",
    "coverage: 45%",
    "Progress: 45% done",
    "[ 45%] Building CXX object src/foo.o",
    "loss 0.12 [ 45%]",
    "450/1000 records",
    "100%|          | 0/0 [00:00<?, ?it/s]",
    "  1,234  45% somewhere",
  ])("detects nothing in %j", (line) => {
    expect(detect(line)).toBeUndefined();
  });

  it("parses numbers with commas and suffixes", () => {
    expect(parseNumber("1,234")).toBe(1234);
    expect(parseNumber("1.2k")).toBe(1200);
    expect(parseNumber("3M")).toBe(3_000_000);
    expect(Number.isNaN(parseNumber("abc"))).toBe(true);
  });

  it("reads nothing from a tqdm line whose counts are unusable", () => {
    expect(read("tqdm", " 50%|█████     | 5/0 [00:00<?, ?it/s]")).toBeUndefined();
  });
});

describe("progressSpec", () => {
  it("resolves names, none and regexes", () => {
    expect(progressSpec(undefined)).toBeUndefined();
    expect(progressSpec("none")).toBe("none");
    expect((progressSpec("TQDM") as any).name).toBe("tqdm");
    expect((progressSpec("percent") as any).read("step 3 of many, 12.5% done")).toEqual({ fraction: 0.125 });
    expect((progressSpec("fraction") as any).read("files 3/4, chunks 9/10")).toEqual({ fraction: 0.9, count: "9/10" });
  });

  it("reads one group as a percent, two as done/total, named groups first", () => {
    expect((progressSpec(String.raw`(\d+) pct`) as any).read("at 40 pct")).toEqual({ fraction: 0.4 });
    expect((progressSpec(String.raw`row (\d+) of (\d+)`) as any).read("Row 30 of 120")).toEqual({ fraction: 0.25, count: "30/120" });
    expect((progressSpec(String.raw`(?<total>\d+) total, (?<done>\d+) done`) as any).read("8 total, 2 done")).toEqual({ fraction: 0.25, count: "2/8" });
    expect((progressSpec(String.raw`/step (\d+)/(\d+)/`) as any).read("Step 3/4")).toBeUndefined();
  });

  it("rejects a regex without a capture group", () => {
    expect(() => progressSpec(String.raw`\d+%`)).toThrow(/capture group/);
  });

  it("ignores impossible values", () => {
    const f = progressSpec(String.raw`(\d+)/(\d+)`) as any;
    expect(f.read("12/10")).toBeUndefined();
    expect(f.read("1/0")).toBeUndefined();
    expect((progressSpec(String.raw`(\d+)%`) as any).read("150%")).toBeUndefined();
  });
});

describe("progress file", () => {
  it("reads counts, percents and a note from the last line", () => {
    expect(parseProgressFile("450/1000\n")).toEqual({ fraction: 0.45, count: "450/1000" });
    expect(parseProgressFile("10%\n45% fitting fold 3\n")).toEqual({ fraction: 0.45, note: "fitting fold 3" });
    expect(parseProgressFile("3/4 fold 3\n\n")).toEqual({ fraction: 0.75, count: "3/4", note: "fold 3" });
    expect(parseProgressFile("starting")).toBeUndefined();
    expect(parseProgressFile("")).toBeUndefined();
  });
});

describe("ProgressTracker", () => {
  const tqdm = (n: number) => ` ${Math.floor(n / 10)}%|          | ${n}/1000 [00:00<?, ?it/s]`;

  it("shows a \\r-redrawn catalogue bar at once", () => {
    const p = new ProgressTracker(undefined);
    p.pending(`\r${tqdm(0)}\r${tqdm(450)}`, 1_000);
    expect(p.current(1_000)).toMatchObject({ fraction: 0.45, count: "450/1000", source: "detected: tqdm" });
  });

  it("does not count an unchanged or un-redrawn pending line", () => {
    const p = new ProgressTracker(undefined);
    p.pending("test_a.py ..   [ 10%]", 0);
    p.pending("test_a.py ..   [ 10%]", 0);
    expect(p.current(0)).toBeUndefined();
  });

  it("needs several rising matches from plain lines", () => {
    const p = new ProgressTracker(undefined);
    for (let i = 1; i < DETECT_HITS; i++) {
      p.line(`test_m${i}.py ..   [ ${i * 10}%]`, i);
      expect(p.current(i)).toBeUndefined();
    }
    p.line(`test_m9.py ..   [ ${DETECT_HITS * 10}%]`, 9);
    expect(p.current(9)).toMatchObject({ fraction: DETECT_HITS / 10, source: "detected: pytest" });
  });

  it("hides on a drop until it qualifies again, and while bars interleave", () => {
    const p = new ProgressTracker(undefined);
    for (const pct of [10, 20, 30]) p.line(`t.py .. [ ${pct}%]`, 0);
    expect(p.current(0)).toBeDefined();
    p.line("t.py .. [  5%]", 1);
    expect(p.current(1)).toBeUndefined();
    const q = new ProgressTracker(undefined);
    for (const n of [100, 900, 200, 800, 300, 700, 400]) q.pending(`\r${tqdm(n)}`, n);
    expect(q.current(1_000)).toBeUndefined();
  });

  it("hides a finished detected bar that went quiet", () => {
    const p = new ProgressTracker(undefined);
    p.line(`\r${tqdm(1000)}`, 0);
    expect(p.current(1)).toBeDefined();
    expect(p.current(DONE_QUIET_MS + 1)).toBeUndefined();
  });

  it("ignores stray numbers and detects nothing when told none", () => {
    const p = new ProgressTracker(undefined);
    for (let i = 1; i <= 5; i++) p.line(`processed ${i}/10 files, coverage ${i * 10}%`, i);
    expect(p.current(5)).toBeUndefined();
    const none = new ProgressTracker("none");
    none.line(`\r${tqdm(500)}`, 0);
    expect(none.current(0)).toBeUndefined();
  });

  it("trusts a declared format at once and skips detection", () => {
    const p = new ProgressTracker(progressSpec(String.raw`row (\d+) of (\d+)`) as any);
    p.line(`\r${tqdm(900)}`, 0);
    expect(p.current(0)).toBeUndefined();
    p.line("row 5 of 20", 1);
    expect(p.current(1)).toMatchObject({ fraction: 0.25, source: "declared" });
    const named = new ProgressTracker(progressSpec("pytest") as any);
    named.line("t.py .. [ 40%]", 0);
    expect(named.current(0)).toMatchObject({ fraction: 0.4, source: "declared: pytest" });
  });

  it("prefers the progress file, keeping its last good value", () => {
    const p = new ProgressTracker(undefined);
    p.line(`\r${tqdm(900)}`, 0);
    p.file("2/8 loading", 1);
    expect(p.current(1)).toMatchObject({ fraction: 0.25, note: "loading", source: "file" });
    p.file("garbage", 2);
    expect(p.current(2)?.fraction).toBe(0.25);
    p.file(undefined, 3);
    expect(p.current(3)?.source).toBe("detected: tqdm");
  });

  it("measures the ETA from a baseline that resets on a drop", () => {
    const p = new ProgressTracker(progressSpec("fraction") as any);
    p.line("0/100", 0);
    p.current(0);
    p.line("10/100", 5_000);
    expect(eta(p.current(5_000), 5_000)).toBeUndefined();
    p.line("20/100", 20_000);
    expect(eta(p.current(20_000), 20_000)).toBe(80_000);
    expect(eta(p.current(20_000), 30_000)).toBe(70_000);
    p.line("5/100", 21_000);
    expect(p.current(21_000)?.since).toEqual({ fraction: 0.05, at: 21_000 });
  });
});

describe("drawing", () => {
  it("draws eighths", () => {
    expect(bar(0)).toBe(`▕${" ".repeat(10)}▏`);
    expect(bar(1)).toBe(`▕${"█".repeat(10)}▏`);
    expect(bar(0.45)).toBe("▕████▌     ▏");
    expect(bar(0.45)).toHaveLength(12);
  });

  it("formats percent and ETA", () => {
    expect(percent({ fraction: 0.996 })).toBe("99%");
    expect(percent({ fraction: 1 })).toBe("100%");
    expect(etaText(45_000)).toBe("~45s");
    expect(etaText(180_000)).toBe("~3m");
    expect(etaText(4_200_000)).toBe("~1h10m");
  });
});
