// Reports the cache-guard `cache` pane token through pi-herdr's event-bus bridge (`herdr:token`),
// so herdr's agents sidebar can show which sessions are doomed to a cache miss. pi-herdr does the
// herdr work (and only in an interactive pi inside herdr); without it nothing listens. The opencode
// and Codex ports keep their own socket reporter (core.ts stays shared verbatim).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { HERDR_TOKEN } from "./core.ts";

export interface EventBus {
  emit(channel: string, data: unknown): void;
}

/**
 * Reports one token (`cache` unless told otherwise) when it changes; the first report (even
 * "nothing") always goes out. A value reported with a TTL is dropped by herdr when it runs out, so a
 * crashed pi cannot leave it behind; while pi runs, the next report clears it on time anyway.
 */
export class HerdrReporter {
  private last: string | undefined | null = null;
  // When the last value's TTL runs out (epoch ms), for a resend.
  private deadline: number | undefined;
  private readonly events: EventBus | undefined;
  private readonly key: string;

  // No parameter properties: Node's type stripping runs these sources too.
  constructor(events: EventBus | undefined, key: string = HERDR_TOKEN) {
    this.events = events;
    this.key = key;
  }

  report(value: string | undefined, ttlMs?: number): void {
    if (!this.events || value === this.last) return;
    this.last = value;
    this.deadline = value !== undefined && ttlMs !== undefined ? Date.now() + ttlMs : undefined;
    this.emit(value, ttlMs);
  }

  /** pi-herdr became active after a report: send the current value again. */
  resend(): void {
    if (!this.events || typeof this.last !== "string") return;
    this.emit(this.last, this.deadline === undefined ? undefined : Math.max(1_000, this.deadline - Date.now()));
  }

  /** Clears the token (session end) and forgets what was reported. */
  clear(): Promise<boolean> {
    const had = typeof this.last === "string";
    this.last = null;
    this.deadline = undefined;
    if (this.events && had) this.emit(undefined);
    return Promise.resolve(true);
  }

  private emit(value: string | undefined, ttlMs?: number): void {
    this.events!.emit("herdr:token", { key: this.key, value, ...(ttlMs !== undefined ? { ttlMs } : {}) });
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

/**
 * Say that a prompt did not go out: the question holds it. On macOS `sound` plays through `afplay`
 * (a system sound name or a file path), whatever space or app has focus. Inside herdr (through
 * pi-herdr) a notification names the session, with herdr's request sound where no macOS sound
 * played. Elsewhere the terminal bell rings; herdr does not pass the bell on.
 */
export function alertHeld(events: EventBus | undefined, sound: string, body: string, platform: NodeJS.Platform = process.platform): void {
  const file = platform === "darwin" ? soundFile(sound) : undefined;
  let played = false;
  if (file) {
    try {
      const child = spawn("afplay", [file], { stdio: "ignore", detached: true });
      child.on("error", () => undefined);
      child.unref();
      played = true;
    } catch {
      // No afplay: fall through to herdr's sound.
    }
  }
  try {
    events?.emit("herdr:notify", { title: "Prompt not sent: cache cold", body, sound: played || !sound ? "none" : "request" });
  } catch {
    // A failing listener must not break the question.
  }
  if (!played && sound && !process.env.HERDR_ENV) {
    try {
      if (process.stdout.isTTY) process.stdout.write("\x07");
    } catch {
      // No terminal to ring.
    }
  }
}

/** A macOS sound name (`Basso`) as its system file, or a path as is; undefined when it does not exist. */
export function soundFile(sound: string): string | undefined {
  const name = sound.trim();
  if (!name) return undefined;
  const file = name.includes("/") ? name : `/System/Library/Sounds/${name}.aiff`;
  return existsSync(file) ? file : undefined;
}
