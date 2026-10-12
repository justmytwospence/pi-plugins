// Herdr reserves a scrollbar column on the main screen but not the alternate
// screen. Pi prints its exit transcript before SIGWINCH can report that change.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENTER_ALT = "\x1b[?1049h";
const EXIT_ALT = "\x1b[?1049l";
const PATCHED = Symbol.for("pi-herdr-scrollbar-width");

type WidthOutput = Pick<NodeJS.WriteStream, "write" | "columns"> & { [PATCHED]?: Guard };
interface Guard {
  owners: Set<symbol>;
  retiring: boolean;
  active: boolean;
  alt: boolean;
  restore(): void;
}

// Herdr reads its config on the server, which is the host the pane runs on.
function scrollbarsEnabled(): boolean {
  const file = process.env.HERDR_CONFIG_PATH || path.join(homedir(), ".config/herdr/config.toml");
  try {
    return !/^\s*pane_scrollbars\s*=\s*false\b/m.test(readFileSync(file, "utf8"));
  } catch {
    return true;
  }
}

/** A lease survives shutdown until the final alternate-screen exit is written. */
export function installWidthGuard(out: WidthOutput): () => void {
  let guard = out[PATCHED];
  if (!guard) {
    const write = out.write;
    // Pi may have entered the alternate screen before extensions loaded.
    guard = { owners: new Set(), retiring: false, active: true, alt: true, restore() {} };
    const shared = guard;
    let pending = "";
    const patched = function (this: WidthOutput, chunk: unknown, ...rest: unknown[]) {
      if (!shared.active) return (write as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
      const text = typeof chunk === "string" ? chunk
        : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : "";
      const input = pending + text;
      for (const match of input.matchAll(/\x1b\[\?1049([hl])/g)) {
        const leaving = match[1] === "l";
        // Apply before delegating: even synchronous writers must see the new width.
        if (leaving && shared.alt && out.columns > 4) out.columns -= 1;
        shared.alt = !leaving;
      }
      // Retain only a possible incomplete escape sequence, never transcript data.
      pending = "";
      for (let length = ENTER_ALT.length - 1; length > 0; length--) {
        const suffix = input.slice(-length);
        if (ENTER_ALT.startsWith(suffix) || EXIT_ALT.startsWith(suffix)) {
          pending = suffix;
          break;
        }
      }
      try {
        return (write as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
      } finally {
        if (shared.retiring && !shared.alt) shared.restore();
      }
    } as NodeJS.WriteStream["write"];
    shared.restore = () => {
      shared.active = false;
      if (out.write === patched) out.write = write;
      if (out[PATCHED] === shared) delete out[PATCHED];
    };
    out.write = patched;
    out[PATCHED] = shared;
  }
  const shared = guard;
  const owner = Symbol();
  shared.owners.add(owner);
  shared.retiring = false;
  return () => {
    if (!shared.owners.delete(owner) || shared.owners.size) return;
    shared.retiring = true;
    // Signal shutdown emits session_shutdown before Pi leaves the alt screen.
    // Removing the patch here would reintroduce wrapping on actual quit.
    if (!shared.alt) shared.restore();
  };
}

export default function (pi: ExtensionAPI) {
  let release: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || process.env.HERDR_ENV !== "1" || !process.stdout.isTTY || !scrollbarsEnabled()) return;
    release ??= installWidthGuard(process.stdout);
  });
  pi.on("session_shutdown", () => {
    release?.();
    release = undefined;
  });
}
