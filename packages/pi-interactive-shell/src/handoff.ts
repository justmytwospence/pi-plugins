// Adapted from Pi's examples/extensions/interactive-shell.ts (MIT, Mario Zechner).
import { spawn } from "node:child_process";
import type { TUI } from "@earendil-works/pi-tui";

export function interactiveCommand(command: string): string | undefined {
  return /^i(?:\s|$)/u.test(command) ? command.slice(1).trim() : undefined;
}

export function failure(message: string) {
  return { output: `(interactive command: ${message})`, exitCode: 1, cancelled: false, truncated: false };
}

/** Own the actual terminal, not a second renderer or a background-task transport. */
export async function handoff(tui: Pick<TUI, "stop" | "start" | "requestRender">, command: string, cwd: string,
  start = spawn, write = (text: string) => { process.stdout.write(text); }) {
  // Pi shares the terminal's foreground process group. Let the child receive
  // Ctrl+C without terminating Pi. Unlike spawnSync, spawn lets this handler run.
  const interrupt = () => {};
  process.on("SIGINT", interrupt);
  try {
    tui.stop();
    write("\x1b[2J\x1b[H");
    return await new Promise<ReturnType<typeof failure>>((resolve) => {
      const child = start(process.env.SHELL || "/bin/sh", ["-c", command], {
        cwd, stdio: "inherit", env: process.env,
      });
      child.once("error", (error) => resolve(failure(`could not start: ${error.message}`)));
      child.once("exit", (code, signal) => resolve({
        output: signal ? `(interactive command interrupted by ${signal})` : `(interactive command exited with code ${code ?? 1})`,
        exitCode: code ?? (signal === "SIGINT" ? 130 : 1),
        cancelled: signal === "SIGINT" || signal === "SIGTERM",
        truncated: false,
      }));
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  } finally {
    process.removeListener("SIGINT", interrupt);
    tui.start();
    tui.requestRender(true);
  }
}
