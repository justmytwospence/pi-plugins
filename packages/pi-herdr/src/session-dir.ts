// Where Pi keeps a working folder's session files, so a conversation forked into another folder
// (a worktree) is stored where `pi --resume` there finds it.
import { join, resolve } from "node:path";

/** Pi's default per-cwd session directory (mirrors its getDefaultSessionDirPath). */
export function defaultSessionDir(cwd: string, agentDir: string): string {
  return join(agentDir, "sessions", `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

/** Keep a custom session directory; otherwise use the target's default one. */
export function sessionDirFor(target: string, current: { cwd: string; sessionDir: string }, agentDir: string): string {
  return current.sessionDir === defaultSessionDir(current.cwd, agentDir) ? defaultSessionDir(target, agentDir) : current.sessionDir;
}
