// Herdr's prefix+h/j/k/l move between main and Sidebar as if they were Herdr panes. Herdr reads the
// prefix before Pi sees it, so the pi-sidebar-nav Herdr plugin (herdr-plugin/) sends a Pi pane one
// reserved key per direction instead of moving focus itself. Here Pi decides: a move between main
// and Sidebar switches focus inside Pi; any other move goes back to Herdr as a normal pane move.
import { execFile } from "node:child_process";
import { matchesKey } from "@earendil-works/pi-tui";
import type { Orientation } from "./config.ts";

export type Direction = "left" | "down" | "up" | "right";

/** The reserved keys the Herdr plugin sends, one per direction (keep in step with nav.sh). */
export const NAV_KEYS: Record<Direction, string> = {
  left: "ctrl+alt+shift+h",
  down: "ctrl+alt+shift+j",
  up: "ctrl+alt+shift+k",
  right: "ctrl+alt+shift+l",
};

export function navDirection(data: string): Direction | undefined {
  return (Object.keys(NAV_KEYS) as Direction[]).find((direction) => matchesKey(data, NAV_KEYS[direction] as never));
}

export type NavTarget = "sidebar" | "main" | "herdr";

/**
 * Where a move goes. Sidebar sits right of main, or below it: toward Sidebar from main focuses
 * Sidebar, away from it from Sidebar focuses main, and everything else leaves Pi.
 */
export function navTarget(direction: Direction, open: boolean, orientation: Orientation, sidebarFocused: boolean): NavTarget {
  if (!open) return "herdr";
  const toward: Direction = orientation === "right" ? "right" : "down";
  const back: Direction = orientation === "right" ? "left" : "up";
  if (!sidebarFocused && direction === toward) return "sidebar";
  if (sidebarFocused && direction === back) return "main";
  return "herdr";
}

/** A normal Herdr pane move from this pane. */
export function herdrFocus(direction: Direction, env: NodeJS.ProcessEnv = process.env): void {
  const pane = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !pane) return;
  execFile(env.HERDR_BIN_PATH || "herdr", ["pane", "focus", "--direction", direction, "--pane", pane], { timeout: 5000 }, () => {});
}
