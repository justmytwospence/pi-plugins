// Notebooks whose server runs but that are open in no browser: how the footer shows them, and how
// they are opened. The footer line reads like any notebook's (`marimo: nb.py · :2718 · not open`),
// with the notebook's name as an OSC 8 hyperlink to the server. Clicking it opens the notebook:
// Pi's fullscreen TUI captures the mouse and opens an OSC 8 link under a click itself (`open` on
// macOS, `xdg-open` elsewhere), and other terminals (herdr, in regular mode) do the same with it.
import { spawn } from "node:child_process";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import { basename } from "./core/io.js";
import { shortWhere, statusText } from "./core/render.js";
import type { Waiting } from "./core/watcher.js";

/** Where a waiting notebook opens: the server's home page serves its one notebook. */
export const waitingUrl = (w: Pick<Waiting, "url">): string => `${w.url}/`;

/** The footer line of a waiting notebook; its name links to the notebook where the terminal shows links. */
export function waitingStatus(w: Waiting, links = getCapabilities().hyperlinks): string {
  const name = basename(w.path);
  const text = statusText({ notebook: name, connection: "not open", queued: 0, errors: 0, where: shortWhere(w.url) });
  const prefix = `marimo: ${name}`;
  return links && text.startsWith(prefix) ? `marimo: ${hyperlink(name, waitingUrl(w))}${text.slice(prefix.length)}` : text;
}

/** Open a URL in the user's browser (`open` on macOS, otherwise `xdg-open`); best effort. */
export function openUrl(url: string): void {
  try {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
  } catch {
    // No opener: nothing to do.
  }
}
