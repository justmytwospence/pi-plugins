import type { IPty } from "node-pty";

export type PtyProcess = Pick<IPty, "pid" | "write" | "resize" | "onData" | "onExit" | "kill" | "pause" | "resume">;
export type PtyFactory = (command: string, cwd: string, cols: number, rows: number) => Promise<PtyProcess>;

export const spawnPty: PtyFactory = async (command, cwd, cols, rows) => {
  if (process.platform === "win32") throw new Error("Interactive terminal currently requires macOS or Linux");
  // Native loading happens only on use, not while Pi discovers extension factories.
  const pty = await import("node-pty");
  return pty.spawn(process.env.SHELL || "/bin/sh", ["-c", command], {
    name: "xterm-256color", cols, rows, cwd,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    handleFlowControl: false,
  });
};

/** forkpty creates a separate session/process group, never Pi's own group. */
export async function stopPty(pty: PtyProcess): Promise<void> {
  const signal = (name: NodeJS.Signals) => {
    try { process.kill(-pty.pid, name); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        try { pty.kill(name); } catch { /* Already exited. */ }
      }
    }
  };
  signal("SIGTERM");
  // Don't cancel escalation when the leader exits: a descendant may ignore TERM.
  await new Promise<void>((resolve) => setTimeout(resolve, 400));
  signal("SIGKILL");
}
