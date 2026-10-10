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
 */
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

/**
 * Replay each terminal appearance report after `delays`. A new report cancels the replays still
 * pending for the previous one. Returns a function that stops listening and cancels pending replays.
 */
export function resync(source: SchemeSource, options: { delays?: number[]; timers?: Timers; log?: (message: string) => void } = {}): () => void {
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
    log(`report ${scheme}`);
    cancel();
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
        const stop = isSchemeSource(tui) ? resync(tui, { log }) : undefined;
        log?.(stop ? "listening" : "pi-tui lacks the color scheme hooks; doing nothing");
        return { render: () => [], invalidate: () => {}, dispose: () => stop?.() };
      },
      { placement: "belowEditor" },
    );
  });
}
