import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { TerminalPanel, type HandoffResult } from "./panel.ts";

export { failure, type HandoffResult } from "./panel.ts";

export function interactiveCommand(command: string): string | undefined {
  return /^i(?:\s|$)/u.test(command) ? command.slice(1).trim() : undefined;
}

export function handoff(tui: TUI, theme: Theme, command: string, cwd: string, done: (result: HandoffResult, snapshot?: Component) => void, autoClose = false, inline = false, onStarted?: () => void) {
  const panel = new TerminalPanel(tui, theme, command, cwd, done, undefined, autoClose, inline, onStarted);
  // Let the caller install completion/transcript ownership before a spawn can fail.
  queueMicrotask(() => { void panel.start(); });
  return panel;
}
