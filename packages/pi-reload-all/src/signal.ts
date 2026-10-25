// The reload request: one small JSON file in Pi's agent directory. Writing it asks every
// interactive Pi on this machine to reload itself once it is idle with an empty editor.
// Written atomically (temp file, then rename) so a watcher never reads half a file.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const FILE_NAME = "reload-request";

export interface Request {
  id: string;
  /** Milliseconds since the epoch, by the writer's clock. */
  at: number;
  origin: string;
}

/** A request as read here: `seen` is the file's mtime by this machine's clock. */
export interface Received extends Request {
  seen: number;
}

export function agentDir(): string {
  return getAgentDir();
}

export function requestPath(dir = agentDir()): string {
  return join(dir, FILE_NAME);
}

export function makeRequest(origin = hostname(), now = Date.now()): Request {
  return { id: randomUUID(), at: now, origin };
}

export function writeRequest(request: Request, dir = agentDir()): void {
  mkdirSync(dir, { recursive: true });
  const path = requestPath(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(request));
  renameSync(tmp, path);
}

export function readRequest(dir = agentDir()): Received | undefined {
  try {
    const path = requestPath(dir);
    const seen = statSync(path).mtimeMs;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Request>;
    if (typeof value.id !== "string" || !value.id) return undefined;
    return { id: value.id, at: typeof value.at === "number" ? value.at : seen, origin: typeof value.origin === "string" ? value.origin : "", seen };
  } catch {
    return undefined;
  }
}

/**
 * A request this session should act on: written after it started (by this machine's clock, so a
 * remote writer's clock does not matter), not yet handled.
 */
export function isFresh(request: Received | undefined, startedAt: number, handled: ReadonlySet<string>): request is Received {
  return !!request && request.seen >= startedAt && !handled.has(request.id);
}

/** The same write as a POSIX shell command, for another machine over ssh. */
export function remoteWriteCommand(request: Request): string {
  const json = JSON.stringify(request).replace(/'/gu, `'\\''`);
  const dir = '"${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"';
  return `d=${dir} && mkdir -p "$d" && printf '%s' '${json}' > "$d/${FILE_NAME}.tmp" && mv "$d/${FILE_NAME}.tmp" "$d/${FILE_NAME}"`;
}
