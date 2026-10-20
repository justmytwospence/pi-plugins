// Sidebar's remembered layout: the share you dragged the divider to, one per orientation, in
// `pi-sidebar.json` in Pi's agent directory. Until you drag, PI_SIDEBAR_RATIO (or one half) applies.
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { clampRatio, type Orientation } from "./config.ts";

export interface Preferences {
  ratio: Partial<Record<Orientation, number>>;
}

export function readPreferences(file: string): Preferences {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { ratio?: Record<string, unknown> };
    const ratio: Preferences["ratio"] = {};
    for (const orientation of ["right", "down"] as const) {
      const value = raw?.ratio?.[orientation];
      if (typeof value === "number" && Number.isFinite(value)) ratio[orientation] = clampRatio(value);
    }
    return { ratio };
  } catch {
    return { ratio: {} };
  }
}

/** Ratios by orientation, falling back to `fallback`; saves are queued and never throw. */
export class RatioStore {
  private prefs: Preferences;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly fallback: number, private readonly onError: (error: unknown) => void = () => {}) {
    this.prefs = readPreferences(file);
  }

  get(orientation: Orientation): number {
    return this.prefs.ratio[orientation] ?? this.fallback;
  }

  /** Set for this session; `save` also writes it to disk. Undefined forgets it (back to the default). */
  set(orientation: Orientation, ratio: number | undefined, save: boolean): void {
    const next = { ...this.prefs.ratio };
    if (ratio === undefined) delete next[orientation];
    else next[orientation] = clampRatio(ratio);
    this.prefs = { ratio: next };
    if (save) this.save();
  }

  /** Resolves when queued writes finish (for tests). */
  flushed(): Promise<void> {
    return this.writes;
  }

  private save(): void {
    const snapshot = JSON.stringify({ ratio: this.prefs.ratio }, null, 2) + "\n";
    this.writes = this.writes
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(this.file, snapshot);
      })
      .catch(this.onError);
  }
}
