/**
 * pi-appearance-resync: keep Pi's light/dark theme in step with the terminal behind multiplexers that
 * announce an appearance change before they report the new colors.
 *
 * Pi follows a `"light/dark"` theme setting through mode 2031: on each `CSI ? 997 ; n` report it queries
 * the terminal's colors at once, and the reported background decides the theme. Herdr 0.9.3 forwards the
 * report before it has fetched the new colors from the host terminal, so that query returns the old
 * background and Pi stays one switch behind (herdrdev/herdr#4183). This extension replays the report a
 * few times shortly afterwards, so Pi queries again once the reported colors have caught up. Where the
 * first answer was already right, the replays find the same colors and change nothing.
 *
 * Herdr fixed the ordering after 0.9.5 (herdrdev/herdr#5517). Inside Herdr the extension asks the
 * running server for its version (`herdr status server`, refreshed after each report, so an update
 * handed off to a live session counts) and stands down once it is newer than 0.9.5. Outside Herdr, or
 * when the version cannot be read, it keeps replaying.
 */
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Delays after a report at which it is replayed. */
export const REPLAY_DELAYS_MS = [250, 1_000, 3_000];

const WIDGET_KEY = "appearance-resync";

export type Scheme = "light" | "dark";

/** The parts of pi-tui's TUI this extension relies on. Neither is part of Pi's extension API. */
export interface SchemeSource {
  onTerminalColorSchemeChange(listener: (scheme: Scheme) => void): () => void;
  consumeTerminalColorSchemeReport(data: string): boolean;
}

export function isSchemeSource(tui: unknown): tui is SchemeSource {
  const t = tui as Partial<SchemeSource> | undefined;
  return typeof t?.onTerminalColorSchemeChange === "function" && typeof t?.consumeTerminalColorSchemeReport === "function";
}

export function schemeReport(scheme: Scheme): string {
  return `\x1b[?997;${scheme === "dark" ? 1 : 2}n`;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The last Herdr release that forwards the report before the new colors. */
export const LAST_UNFIXED_HERDR = [0, 9, 5] as const;

/**
 * Whether a Herdr version still needs the replays: true up to 0.9.5 (preview builds of 0.9.5 report
 * 0.9.5 too, fixed or not, so they keep the replays) and for anything unreadable.
 */
export function herdrNeedsResync(version: string | undefined): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? "");
  if (!match) return true;
  const parts = match.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i]! !== LAST_UNFIXED_HERDR[i]) return parts[i]! < LAST_UNFIXED_HERDR[i]!;
  }
  return true;
}

/** The running Herdr server's version from `herdr status server` output. */
export function parseServerVersion(output: string): string | undefined {
  return /^version:\s*(\S+)/m.exec(output)?.[1];
}

export type VersionReader = () => Promise<string | undefined>;

/** Ask the running Herdr server for its version; undefined when that fails. */
export function readHerdrServerVersion(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(env.HERDR_BIN_PATH || "herdr", ["status", "server"], { timeout: 3_000, env }, (error, stdout) => {
        resolve(error ? undefined : parseServerVersion(String(stdout)));
      });
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Whether replays are still needed here, kept current in the background. Outside Herdr always true.
 * Inside it, the verdict starts from the version Herdr gave the pane (`TERM_PROGRAM_VERSION`) and
 * follows the running server's version after each `refresh()`; a failed read keeps the last verdict.
 */
export class ResyncNeed {
  private needed: boolean;
  private version: string | undefined;
  private readonly herdr: boolean;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly read: VersionReader = () => readHerdrServerVersion(env), private readonly log: (message: string) => void = () => {}) {
    this.herdr = env.HERDR_ENV === "1" || env.TERM_PROGRAM === "herdr";
    this.version = this.herdr && env.TERM_PROGRAM === "herdr" ? env.TERM_PROGRAM_VERSION : undefined;
    this.needed = !this.herdr || herdrNeedsResync(this.version);
  }

  get(): boolean {
    return this.needed;
  }

  async refresh(): Promise<void> {
    if (!this.herdr) return;
    const version = await this.read().catch(() => undefined);
    if (!version) return;
    const needed = herdrNeedsResync(version);
    if (version !== this.version || needed !== this.needed) {
      this.log(needed ? `herdr ${version}: replaying reports` : `herdr ${version} sends the new colors first: standing down`);
    }
    this.version = version;
    this.needed = needed;
  }
}

/**
 * Replay each terminal appearance report after `delays`. A new report cancels the replays still
 * pending for the previous one. Returns a function that stops listening and cancels pending replays.
 */
export function resync(source: SchemeSource, options: { delays?: number[]; timers?: Timers; log?: (message: string) => void; needed?: () => boolean; reported?: () => void } = {}): () => void {
  const delays = options.delays ?? REPLAY_DELAYS_MS;
  const timers = options.timers ?? realTimers;
  const log = options.log ?? (() => {});
  let pending: unknown[] = [];
  let replaying = false;
  const cancel = () => {
    for (const handle of pending) timers.clear(handle);
    pending = [];
  };
  const unsubscribe = source.onTerminalColorSchemeChange((scheme) => {
    if (replaying) return;
    cancel();
    options.reported?.();
    if (options.needed && !options.needed()) {
      log(`report ${scheme}; not needed here, no replays`);
      return;
    }
    log(`report ${scheme}`);
    const report = schemeReport(scheme);
    pending = delays.map((ms) =>
      timers.set(() => {
        log(`replay ${scheme} after ${ms} ms`);
        replaying = true;
        try {
          source.consumeTerminalColorSchemeReport(report);
        } finally {
          replaying = false;
        }
      }, ms),
    );
  });
  return () => {
    cancel();
    unsubscribe();
  };
}

function debugLog(): ((message: string) => void) | undefined {
  const path = process.env.PI_APPEARANCE_RESYNC_LOG;
  if (!path) return undefined;
  return (message) => {
    try {
      appendFileSync(path, `${new Date().toISOString()} ${process.pid} ${message}\n`);
    } catch {
      // Logging is best effort.
    }
  };
}

export default function appearanceResync(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    const log = debugLog();
    // A widget factory is the only place an extension receives the TUI. The widget renders nothing,
    // and below the editor an extra widget adds no spacer line.
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui) => {
        const need = new ResyncNeed(process.env, undefined, log);
        void need.refresh();
        const stop = isSchemeSource(tui)
          ? resync(tui, { log, needed: () => need.get(), reported: () => void need.refresh() })
          : undefined;
        log?.(stop ? "listening" : "pi-tui lacks the color scheme hooks; doing nothing");
        return { render: () => [], invalidate: () => {}, dispose: () => stop?.() };
      },
      { placement: "belowEditor" },
    );
  });
}
