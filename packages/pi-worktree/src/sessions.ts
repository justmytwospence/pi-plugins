// Session files for moving a conversation between checkouts. Pi's switchSession
// rebuilds the runtime (trust, settings, packages, AGENTS.md) for the cwd in the
// target file's header, so moving is: write or fork a file there, then switch.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";

export type CurrentSession = { file?: string; cwd: string; sessionDir: string };

/** Pi's default per-cwd session directory (mirrors its getDefaultSessionDirPath). */
export function defaultSessionDir(cwd: string, agentDir: string): string {
  return join(agentDir, "sessions", `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

/** Keep a custom session directory; otherwise use the target's default one. */
export function sessionDirFor(target: string, current: { cwd: string; sessionDir: string }, agentDir: string): string {
  return current.sessionDir === defaultSessionDir(current.cwd, agentDir) ? defaultSessionDir(target, agentDir) : current.sessionDir;
}

/** A header-only session file for `cwd` (SessionManager.create writes nothing until the first message). */
export function writeEmptySession(dir: string, cwd: string, now: Date = new Date(), id: string = randomUUID()): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${now.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
  const header = { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: now.toISOString(), cwd: resolve(cwd) };
  writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: "wx" });
  return file;
}

/** A session file in `target`: a fork of the current conversation, or an empty one. */
export function sessionInto(target: string, current: CurrentSession, agentDir: string, fresh: boolean): string {
  const dir = sessionDirFor(target, current, agentDir);
  if (!fresh && current.file && existsSync(current.file)) {
    const file = SessionManager.forkFrom(current.file, target, dir).getSessionFile();
    if (file) return file;
  }
  return writeEmptySession(dir, target);
}

/** The most recently modified session in `target`, if any. */
export async function latestSession(target: string, dir: string): Promise<string | undefined> {
  const sessions = await SessionManager.list(target, dir);
  return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime())[0]?.path;
}
