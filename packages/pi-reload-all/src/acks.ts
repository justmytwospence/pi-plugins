// Progress reports: each session that receives a request writes one small JSON file per request,
// `reload-acks/<request id>/<session id>.json` in Pi's agent directory, and updates it as it waits
// and reloads. The session that ran /reload-all reads them (other machines' over ssh) to show
// live progress. A reloading session's new runtime finds its own "reloading" file and marks it
// reloaded, so nothing has to survive the reload in memory.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { agentDir } from "./signal.ts";

export const ACKS_DIR = "reload-acks";
/** Request folders older than this are removed when a new request is written. */
const KEEP_MS = 24 * 60 * 60 * 1000;

export type AckState = "pending" | "reloading" | "reloaded" | "failed";

export interface Ack {
  session: string;
  host: string;
  name: string;
  state: AckState;
  reason?: string;
  at: number;
}

/** `MacBook-Pro`, not `MacBook-Pro.local`. */
export function shortHost(name = hostname()): string {
  return name.split(".")[0] || name;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/gu, "_");

export function ackFolder(requestId: string, dir = agentDir()): string {
  return join(dir, ACKS_DIR, safe(requestId));
}

export function writeAck(requestId: string, ack: Omit<Ack, "host" | "at"> & { at?: number; host?: string }, dir = agentDir()): void {
  const folder = ackFolder(requestId, dir);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${safe(ack.session)}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  const full: Ack = { host: shortHost(), at: Date.now(), ...ack } as Ack;
  writeFileSync(tmp, JSON.stringify(full));
  renameSync(tmp, path);
}

export function parseAcks(text: string): Ack[] {
  const out: Ack[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const a = JSON.parse(line) as Partial<Ack>;
      if (typeof a.session === "string" && typeof a.state === "string") {
        out.push({ session: a.session, host: String(a.host ?? ""), name: String(a.name ?? a.session), state: a.state as AckState, ...(a.reason ? { reason: String(a.reason) } : {}), at: Number(a.at) || 0 });
      }
    } catch {
      // a half-read line
    }
  }
  return out;
}

export function readAcks(requestId: string, dir = agentDir()): Ack[] {
  const folder = ackFolder(requestId, dir);
  let files: string[];
  try {
    files = readdirSync(folder).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return parseAcks(files.map((f) => {
    try {
      return readFileSync(join(folder, f), "utf8").replace(/\n/gu, " ");
    } catch {
      return "";
    }
  }).join("\n"));
}

/** The same read as a POSIX shell command, one JSON object per line, for another machine. */
export function remoteReadCommand(requestId: string): string {
  const d = '"${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"';
  return `d=${d}/${ACKS_DIR}/${safe(requestId)}; for f in "$d"/*.json; do [ -f "$f" ] && { tr '\\n' ' ' < "$f"; echo; }; done; true`;
}

/** After this session's reload: its "reloading" reports become "reloaded". */
export function markReloaded(session: string, dir = agentDir(), now = Date.now()): void {
  const root = join(dir, ACKS_DIR);
  let folders: string[];
  try {
    folders = readdirSync(root);
  } catch {
    return;
  }
  const file = `${safe(session)}.json`;
  for (const folder of folders) {
    const path = join(root, folder, file);
    try {
      if (now - statSync(path).mtimeMs > KEEP_MS) continue;
      const ack = JSON.parse(readFileSync(path, "utf8")) as Ack;
      if (ack.state !== "reloading") continue;
      writeAck(folder, { ...ack, state: "reloaded", reason: undefined, at: now }, dir);
    } catch {
      // not ours or gone
    }
  }
}

export function pruneAcks(dir = agentDir(), now = Date.now()): void {
  const root = join(dir, ACKS_DIR);
  try {
    for (const folder of readdirSync(root)) {
      const path = join(root, folder);
      try {
        if (now - statSync(path).mtimeMs > KEEP_MS) rmSync(path, { recursive: true, force: true });
      } catch {
        // gone
      }
    }
  } catch {
    // none yet
  }
}
