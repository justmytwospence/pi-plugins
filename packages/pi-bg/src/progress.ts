// Progress for background tasks, from three sources (highest priority first):
//
// 1. The progress file: every task gets `PI_BG_PROGRESS`, a file it may write `450/1000`, `45%` or
//    `450/1000 fitting fold 3` to (its last line counts). Exact, for scripts the agent writes.
// 2. A declared format: bg_run's `progress`, a catalogue name, a generic preset (`percent`,
//    `fraction`) or the agent's own regex, matched against the log. The agent vouched for it.
// 3. Detection: the catalogue below, standard progress output we are certain about, recognized
//    without being asked. Shown only once it looks like a live bar: a line redrawn in place with
//    \r, or three matches whose value never went down. A drop resets that; several drops in a
//    short while (nested or interleaved bars) hide it; a finished bar (100%) that goes quiet is
//    hidden after a while. `progress: "none"` turns detection off.
//
// Nothing is shown for a task none of these apply to.
import { parsePattern, stripAnsi } from "./log.ts";

/** What one line says about progress. */
export interface Reading {
  /** 0..1. */
  fraction: number;
  /** `450/1000`, `1.2/3.4 MB`. */
  count?: string;
}

export interface Progress extends Reading {
  /** A note from the progress file: `fitting fold 3`. */
  note?: string;
  /** `file`, `declared`, `declared: tqdm`, `detected: tqdm`. */
  source: string;
  /** When it last changed. */
  at: number;
  /** Where the ETA's rate is measured from: reset when the value drops or the source changes. */
  since: { fraction: number; at: number };
}

export interface Format {
  name: string;
  /** What a line (one \r-drawing of it, ANSI stripped) says, if it is this format. */
  read(segment: string): Reading | undefined;
}

const SUFFIX: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 };

/** `1,234`, `1.2k`, `3.4M`. NaN when it is not a number. */
export function parseNumber(text: string): number {
  const m = /^(\d[\d,]*(?:\.\d+)?|\.\d+)([kKMGTP]?)$/u.exec(text.trim());
  if (!m) return Number.NaN;
  return Number((m[1] as string).replace(/,/gu, "")) * (SUFFIX[m[2] as string] ?? 1);
}

export function fromCounts(done: string, total: string, unit = ""): Reading | undefined {
  const d = parseNumber(done);
  const t = parseNumber(total);
  if (!(t > 0) || !(d >= 0) || d > t * 1.0001) return undefined;
  return { fraction: Math.min(1, d / t), count: `${done.trim()}/${total.trim()}${unit ? ` ${unit}` : ""}` };
}

export function fromPercent(pct: string): Reading | undefined {
  const p = Number(pct);
  if (!(p >= 0) || p > 100) return undefined;
  return { fraction: p / 100 };
}

const NUM = String.raw`\d[\d,]*(?:\.\d+)?[kKMGTP]?`;

/**
 * Standard progress output, detected without being asked. Each entry must be unmistakable: a bare
 * `45%` or `3/10` never qualifies. Many tools draw their bars only on a terminal, so in a log file
 * these show up when the tool draws regardless (tqdm, pytest, wget) or is told to.
 */
export const CATALOGUE: Format[] = [
  {
    // ` 45%|████▌     | 450/1000 [00:12<00:15, 36.2it/s]`, `1.2k/10.0k`
    name: "tqdm",
    read: (s) => {
      const m = new RegExp(String.raw`\d{1,3}%\|[^|]*\|\s*(${NUM})/(${NUM})\s*\[`, "u").exec(s);
      return m ? fromCounts(m[1] as string, m[2] as string) : undefined;
    },
  },
  {
    // `tests/test_x.py ....F..   [ 45%]`, `tests/a.py::t PASSED   [ 45%]`, `[gw0] [ 45%] PASSED tests/a.py::t`
    name: "pytest",
    read: (s) => {
      const m = /(?:^|\s)\[\s{0,2}(\d{1,3})%\](?:\s|$)/u.exec(s);
      if (!m || !/\.py\b|^\[gw\d+\]/u.test(s)) return undefined;
      return fromPercent(m[1] as string);
    },
  },
  {
    // `    Building [=======>                 ] 45/120: serde, syn`
    name: "cargo",
    read: (s) => {
      const m = /^\s*Building \[[ =>]*\]\s+(\d+)\/(\d+)\b/u.exec(s);
      return m ? fromCounts(m[1] as string, m[2] as string) : undefined;
    },
  },
  {
    // `120/500 [=====>........................] - ETA: 3s - loss: 0.1` (Keras 2)
    // `120/500 ━━━━━━━━━━━━━━━━━━━━ 3s 6ms/step - loss: 0.1` (Keras 3)
    name: "keras",
    read: (s) => {
      const m = /^\s*(\d+)\/(\d+)\s+(?:\[[=>.]+\]\s+-\s+(?:ETA:|\d)|[━─]+\s+\d+m?s\b)/u.exec(s);
      return m ? fromCounts(m[1] as string, m[2] as string) : undefined;
    },
  },
  {
    // pip and other rich bars: `━━━━━━━━━━━━━━━━━━━━╸━━━━━━━━━━━━ 1.2/3.4 MB 5.0 MB/s eta 0:00:01`, `━━━━━━╺━━━━ 45%`
    name: "rich",
    read: (s) => {
      const sized = new RegExp(String.raw`[━╸╺]{4,}\s+(${NUM})/(${NUM})\s+([kMGT]?i?B|bytes)\b`, "u").exec(s);
      if (sized) return fromCounts(sized[1] as string, sized[2] as string, sized[3] as string);
      const pct = /[━╸╺]{4,}\s+(\d{1,3})%(?:\s|$)/u.exec(s);
      return pct ? fromPercent(pct[1] as string) : undefined;
    },
  },
  {
    // wget's dot progress (its default without a terminal): `  4500K .......... .......... 45% 1.23M 3s`
    name: "wget",
    read: (s) => {
      const m = /^\s*\d+[KMG]\s+[. ]{10,}\s(\d{1,3})%\s/u.exec(s);
      return m ? fromPercent(m[1] as string) : undefined;
    },
  },
  {
    // `rsync --info=progress2` (or --progress): `  1,234,567  45%  1.23MB/s    0:00:12`
    name: "rsync",
    read: (s) => {
      const m = /^\s*[\d,]+\s+(\d{1,3})%\s+[\d.]+[kMGT]?B\/s\s+\d+:\d{2}:\d{2}/u.exec(s);
      return m ? fromPercent(m[1] as string) : undefined;
    },
  },
];

/** Generic formats the agent may declare; too ambiguous to detect. */
export const PRESETS: Format[] = [
  {
    name: "percent",
    read: (s) => {
      const all = [...s.matchAll(/(\d+(?:\.\d+)?)\s*%/gu)];
      return all.length ? fromPercent(all.at(-1)?.[1] as string) : undefined;
    },
  },
  {
    name: "fraction",
    read: (s) => {
      const all = [...s.matchAll(new RegExp(String.raw`(${NUM})\s*/\s*(${NUM})`, "gu"))];
      const m = all.at(-1);
      return m ? fromCounts(m[1] as string, m[2] as string) : undefined;
    },
  },
];

export const FORMAT_NAMES = [...CATALOGUE, ...PRESETS].map((f) => f.name);

/** The capture groups a regex has. */
function groupCount(re: RegExp): number {
  return (new RegExp(`${re.source}|`, re.flags).exec("")?.length ?? 1) - 1;
}

/**
 * The agent's own regex: named groups `done`/`total` or `pct` win; else two groups are done/total
 * and one is a percent. The last match on a line counts.
 */
export function regexFormat(pattern: string): Format {
  const re = parsePattern(pattern);
  const n = groupCount(re);
  if (!n) throw new Error("`progress` regex needs a capture group: one for a percent, two for done/total (or named groups pct, done, total).");
  const all = new RegExp(re.source, `${re.flags.replace(/[gy]/gu, "")}g`);
  return {
    name: pattern,
    read: (s) => {
      let out: Reading | undefined;
      for (const m of s.matchAll(all)) {
        const g = m.groups ?? {};
        const r =
          g.done !== undefined && g.total !== undefined
            ? fromCounts(g.done, g.total)
            : g.pct !== undefined
              ? fromPercent(g.pct)
              : n >= 2 && m[1] !== undefined && m[2] !== undefined
                ? fromCounts(m[1], m[2])
                : m[1] !== undefined
                  ? fromPercent(m[1])
                  : undefined;
        if (r) out = r;
      }
      return out;
    },
  };
}

/** bg_run's `progress`: `none`, a catalogue or preset name, or a regex. Throws when the regex is unusable. */
export function progressSpec(spec: string | undefined): Format | "none" | undefined {
  const s = spec?.trim();
  if (!s) return undefined;
  if (s.toLowerCase() === "none") return "none";
  const named = [...CATALOGUE, ...PRESETS].find((f) => f.name === s.toLowerCase());
  return named ?? regexFormat(s);
}

/** The progress file's last line: `450/1000`, `45%`, either followed by a note. */
export function parseProgressFile(text: string): (Reading & { note?: string }) | undefined {
  const line = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  if (!line) return undefined;
  const counts = new RegExp(String.raw`^(${NUM})\s*/\s*(${NUM})(?:\s+(.*))?$`, "u").exec(line);
  const pct = /^(\d+(?:\.\d+)?)\s*%(?:\s+(.*))?$/u.exec(line);
  const reading = counts ? fromCounts(counts[1] as string, counts[2] as string) : pct ? fromPercent(pct[1] as string) : undefined;
  if (!reading) return undefined;
  const note = (counts ? counts[3] : pct?.[2])?.trim().slice(0, 80);
  return { ...reading, ...(note ? { note } : {}) };
}

/** A redraw: a \r inside the line, not just a CRLF ending. */
const redrawn = (raw: string) => /\r(?!$)/u.test(raw);
/** One line's drawings, ANSI stripped, last first. */
const drawings = (raw: string) =>
  stripAnsi(raw)
    .split("\r")
    .filter((s) => s.trim())
    .reverse();

/** Matches a detected format needs before it shows, unless a line is redrawn in place. */
export const DETECT_HITS = 3;
/** Drops within FLAP_MS that mean several bars are interleaved: detection hides. */
const FLAP_DROPS = 3;
const FLAP_MS = 10_000;
/** A detected bar at 100% that stays quiet this long is hidden: that phase is over. */
export const DONE_QUIET_MS = 30_000;

interface Candidate {
  reading: Reading;
  hits: number;
  redrawn: boolean;
  at: number;
}

/** One task's progress, fed its log lines and progress file. */
export class ProgressTracker {
  private readonly declared: Format | undefined;
  private readonly detecting: boolean;
  private fileReading: (Reading & { note?: string; at: number }) | undefined;
  private declaredReading: (Reading & { at: number }) | undefined;
  private readonly candidates = new Map<string, Candidate>();
  private lastDetected: string | undefined;
  private drops: number[] = [];
  private lastPending = "";
  private shown: Progress | undefined;

  constructor(spec: Format | "none" | undefined) {
    this.declared = spec === "none" ? undefined : spec;
    this.detecting = spec === undefined;
  }

  /** A complete raw log line (\r drawings and ANSI escapes kept). */
  line(raw: string, now = Date.now()): void {
    this.feed(raw, now);
  }

  /** The unterminated last line so far: only a \r-redrawn one counts, once per change. */
  pending(raw: string, now = Date.now()): void {
    if (raw === this.lastPending || !redrawn(raw)) return;
    this.lastPending = raw;
    this.feed(raw, now);
  }

  /** The progress file's content, or undefined when it does not exist. */
  file(text: string | undefined, now = Date.now()): void {
    const r = text === undefined ? undefined : parseProgressFile(text);
    if (!r) {
      if (text === undefined) this.fileReading = undefined;
      return;
    }
    this.fileReading = { ...r, at: now };
  }

  private feed(raw: string, now: number): void {
    if (!this.declared && !this.detecting) return;
    if (!/\d/u.test(raw)) return;
    for (const segment of drawings(raw)) {
      if (this.declared) {
        const r = this.declared.read(segment);
        if (r) {
          this.declaredReading = { ...r, at: now };
          return;
        }
        continue;
      }
      for (const f of CATALOGUE) {
        const r = f.read(segment);
        if (r) {
          this.detected(f.name, r, redrawn(raw), now);
          return;
        }
      }
    }
  }

  private detected(name: string, r: Reading, redraw: boolean, now: number): void {
    const c = this.candidates.get(name);
    if (c && r.fraction < c.reading.fraction - 1e-9) {
      this.drops = [...this.drops.filter((t) => now - t < FLAP_MS), now];
      c.hits = 0;
      c.redrawn = false;
    }
    const next = c ?? { reading: r, hits: 0, redrawn: false, at: now };
    next.reading = r;
    next.hits++;
    next.redrawn ||= redraw;
    next.at = now;
    this.candidates.set(name, next);
    this.lastDetected = name;
  }

  /** What to show now, if anything. */
  current(now = Date.now()): Progress | undefined {
    let next: (Reading & { note?: string; source: string; at: number }) | undefined;
    if (this.fileReading) next = { ...this.fileReading, source: "file" };
    else if (this.declaredReading) next = { ...this.declaredReading, source: this.declared && FORMAT_NAMES.includes(this.declared.name) ? `declared: ${this.declared.name}` : "declared" };
    else if (this.lastDetected) {
      const c = this.candidates.get(this.lastDetected);
      const flapping = this.drops.filter((t) => now - t < FLAP_MS).length >= FLAP_DROPS;
      const finished = c && c.reading.fraction >= 1 && now - c.at > DONE_QUIET_MS;
      if (c && (c.redrawn || c.hits >= DETECT_HITS) && !flapping && !finished) next = { ...c.reading, source: `detected: ${this.lastDetected}`, at: c.at };
    }
    if (!next) {
      this.shown = undefined;
      return undefined;
    }
    const prev = this.shown;
    const since = prev && prev.source === next.source && next.fraction >= prev.fraction - 1e-9 ? prev.since : { fraction: next.fraction, at: next.at };
    this.shown = { ...next, since };
    return this.shown;
  }
}

/** `45%`, floored so a bar shows 100% only when it is done. */
export function percent(p: Reading): string {
  return `${Math.floor(p.fraction * 100 + 1e-9)}%`;
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** `████▌░░░░░`: `cells` wide, in eighths of a cell, the rest a light track. */
export function bar(fraction: number, cells = 10): string {
  const eighths = Math.round(Math.max(0, Math.min(1, fraction)) * cells * 8);
  const full = Math.floor(eighths / 8);
  const part = EIGHTHS[eighths % 8] ?? "";
  return `${"█".repeat(full)}${part}${"░".repeat(cells - full - (part ? 1 : 0))}`;
}

/** Milliseconds left at the rate seen since the baseline, once there is enough of it to go on. */
export function eta(p: Progress | undefined, now = Date.now()): number | undefined {
  if (!p || p.fraction >= 1) return undefined;
  const df = p.fraction - p.since.fraction;
  const dt = p.at - p.since.at;
  if (dt < 10_000 || df < 0.05) return undefined;
  return Math.max(0, ((1 - p.fraction) * dt) / df - (now - p.at));
}

/** `~3m`, `~45s`, `~1h10m`. */
export function etaText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `~${Math.max(1, s)}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `~${m}m`;
  return `~${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
