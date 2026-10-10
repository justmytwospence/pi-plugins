// Keeps pi's fullscreen exit transcript from wrapping inside herdr.
//
// With ui.pane_scrollbars on (the default), herdr gives a pane's main screen one
// column less than its alt screen: the scrollbar gutter is reserved only outside
// the alt screen. When fullscreen pi exits, it leaves the alt screen and at once
// prints its transcript at the width it last saw. herdr's SIGWINCH for the
// narrower main screen arrives too late, so every full-width line wraps.
//
// This watches pi's own stdout for the alt-screen exit and narrows
// process.stdout.columns by that one column right away. When herdr's SIGWINCH
// arrives it reports the same width, so Node emits no resize. Entering the alt
// screen needs nothing: herdr widens the pane and the normal resize path re-renders.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENTER_ALT = "\x1b[?1049h";
const EXIT_ALT = "\x1b[?1049l";

// herdr reads its config on the server, which is the host the pane runs on.
function scrollbarsEnabled(): boolean {
  const file = process.env.HERDR_CONFIG_PATH || path.join(homedir(), ".config/herdr/config.toml");
  try {
    return !/^\s*pane_scrollbars\s*=\s*false\b/m.test(readFileSync(file, "utf8"));
  } catch {
    return true;
  }
}

const PATCHED = Symbol.for("pi-herdr-scrollbar-width");

export default function (_pi: ExtensionAPI) {
  const out = process.stdout as typeof process.stdout & { [PATCHED]?: boolean };
  if (process.env.HERDR_ENV !== "1" || !out.isTTY || out[PATCHED] || !scrollbarsEnabled()) return;
  out[PATCHED] = true;

  // Assume the alt screen until seen otherwise: pi may enter it before extensions load.
  let alt = true;
  const write = out.write;
  out.write = function (this: typeof out, chunk: unknown, ...rest: unknown[]) {
    const result = (write as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
    if (typeof chunk === "string" && chunk.includes("\x1b[?1049")) {
      const leaving = chunk.lastIndexOf(EXIT_ALT) > chunk.lastIndexOf(ENTER_ALT);
      // herdr keeps the full width for panes of 4 columns or fewer.
      if (leaving && alt && out.columns > 4) out.columns -= 1;
      alt = !leaving;
    }
    return result;
  } as typeof out.write;
}
