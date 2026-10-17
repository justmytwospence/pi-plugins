// Reports the cache-guard `cache` pane token through pi-herdr's event-bus bridge (`herdr:token`),
// so herdr's agents sidebar can show which sessions are doomed to a cache miss. pi-herdr does the
// herdr work (and only in an interactive pi inside herdr); without it nothing listens. The opencode
// and Codex ports keep their own socket reporter (core.ts stays shared verbatim).
import { HERDR_TOKEN } from "./core.ts";

export interface EventBus {
  emit(channel: string, data: unknown): void;
}

/** Reports the token when it changes; the first report (even "nothing") always goes out. */
export class HerdrReporter {
  private last: string | undefined | null = null;
  private readonly events: EventBus | undefined;

  // No parameter properties: Node's type stripping runs these sources too.
  constructor(events: EventBus | undefined) {
    this.events = events;
  }

  report(value: string | undefined): void {
    if (!this.events || value === this.last) return;
    this.last = value;
    this.events.emit("herdr:token", { key: HERDR_TOKEN, value });
  }

  /** pi-herdr became active after a report: send the current value again. */
  resend(): void {
    if (this.events && typeof this.last === "string") this.events.emit("herdr:token", { key: HERDR_TOKEN, value: this.last });
  }

  /** Clears the token (session end) and forgets what was reported. */
  clear(): Promise<boolean> {
    const had = typeof this.last === "string";
    this.last = null;
    if (this.events && had) this.events.emit("herdr:token", { key: HERDR_TOKEN, value: undefined });
    return Promise.resolve(true);
  }
}

// herdr shows a pi agent as blocked (needs input) while any extension holds `herdr:blocked` on pi's
// event bus, counting `{ active: true, label }` / `{ active: false }` pairs. The cold-cache question
// holds it while open, so the pane reads as waiting (sidebar, sound, phone card) instead of idle.
export const HERDR_BLOCKED = "herdr:blocked";

/** Run `run` (a dialog) while holding `herdr:blocked`, released however it ends. */
export async function whileBlocked<T>(events: EventBus | undefined, label: string, run: () => Promise<T>): Promise<T> {
  const emit = (data: unknown) => {
    try {
      events?.emit(HERDR_BLOCKED, data);
    } catch {
      // A failing listener must not break the dialog.
    }
  };
  emit({ active: true, label });
  try {
    return await run();
  } finally {
    emit({ active: false });
  }
}

/** The terminal bell (BEL), so a prompt held by the question is noticed after switching away. */
export function ringBell(): void {
  try {
    if (process.stdout.isTTY) process.stdout.write("\x07");
  } catch {
    // No terminal to ring.
  }
}
