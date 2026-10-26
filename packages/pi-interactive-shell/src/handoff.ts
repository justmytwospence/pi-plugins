import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { TerminalPanel, type HandoffResult } from "./panel.ts";

export { failure, type HandoffResult } from "./panel.ts";

export function interactiveCommand(command: string): string | undefined {
  return /^i(?:\s|$)/u.test(command) ? command.slice(1).trim() : undefined;
}

export function handoff(tui: TUI, theme: Theme, command: string, cwd: string, done: (result: HandoffResult) => void) {
  const panel = new TerminalPanel(tui, theme, command, cwd, done);
  void panel.start();
  return panel;
}
