// The files the main session (host) and its Sidebar (side) share. One directory per main session
// under the OS temp dir; every write is atomic (temp file + rename) so a reader never sees half a file.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PROTOCOL_VERSION = 1;
export const HOST_ENV = "PI_SIDEBAR_HOST";
export const MAIN_PANE_ENV = "PI_SIDEBAR_MAIN_PANE";
export const LABEL_ENV = "PI_SIDEBAR_LABEL";
export const KEYS_ENV = "PI_SIDEBAR_KEYS";
export const RATIO_ENV = "PI_SIDEBAR_RATIO";
export const MIN_COLUMNS_ENV = "PI_SIDEBAR_MIN_COLUMNS";
export const DEFAULT_KEYS = ["ctrl+'"];
export const DEFAULT_RATIO = 0.5;
export const DEFAULT_MIN_COLUMNS = 80;

export const FILES = {
  host: "host.json",
  payload: "payload.json",
  live: "live.json",
  side: "side.json",
  wantPayload: "want-payload",
} as const;

export interface ModelRef {
  provider: string;
  id: string;
  api: string;
}

/** Who the main session is. Rewritten on session start, model and thinking changes. */
export interface HostInfo {
  version: number;
  pid: number;
  sessionId: string;
  sessionFile: string | undefined;
  cwd: string;
  mainPaneId: string | undefined;
  model: ModelRef | undefined;
  thinkingLevel: string;
  updatedAt: number;
}

/** Main's last provider request, exactly as it was sent, and what it covered. */
export interface PayloadSnapshot {
  version: number;
  api: string;
  provider: string;
  model: string;
  /** The session leaf when main built this request: entries after it are not in the payload. */
  leafId: string | null;
  sentAt: number;
  /** Total prompt tokens of main's last answered request (input + cache read + cache write). */
  promptTokens?: number;
  payload: Record<string, unknown>;
}

export interface LiveTool {
  id: string;
  name: string;
  summary: string;
  startedAt: number;
}

/** A tool call that has finished but whose result main has not committed yet (parallel calls). */
export interface FinishedTool extends LiveTool {
  isError: boolean;
  durationMs?: number;
  preview: string;
}

/** What main is doing right now, beyond what its session file has committed. */
export interface LiveState {
  version: number;
  state: "idle" | "working";
  since: number;
  tools: LiveTool[];
  finished?: FinishedTool[];
  /** The tail of the reply main is streaming (text only, never thinking). */
  streaming?: string;
  leafId: string | null;
  lastUsage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  updatedAt: number;
}

export interface SideInfo {
  version: number;
  pid: number;
  startedAt: number;
}

export function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "session";
}

export function runtimeDir(sessionId: string, base = tmpdir()): string {
  return join(base, "pi-sidebar", sanitizeId(sessionId));
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

let counter = 0;
function tempName(path: string): string {
  return `${path}.${process.pid}.${++counter}.tmp`;
}

export function writeJsonSync(path: string, value: unknown): void {
  const temp = tempName(path);
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = tempName(path);
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}

/**
 * Writes one file asynchronously, one write at a time, always ending on the latest value: a write
 * that finishes late can never overwrite a newer one.
 */
export class LatestWriter {
  private writing = false;
  private next: { value: unknown } | undefined;
  constructor(readonly path: string) {}
  write(value: unknown): void {
    this.next = { value: structuredClone(value) };
    if (!this.writing) void this.drain();
  }
  /** Writes now, replacing any queued value. */
  writeSync(value: unknown): void {
    // An async write still in flight may land after this one; queue the value so it lands last.
    this.next = this.writing ? { value: structuredClone(value) } : undefined;
    writeJsonSync(this.path, value);
  }
  private async drain(): Promise<void> {
    this.writing = true;
    try {
      while (this.next) {
        const { value } = this.next;
        this.next = undefined;
        try { await writeJson(this.path, value); } catch { /* best effort */ }
      }
    } finally {
      this.writing = false;
    }
  }
}

export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Reads a JSON file again only when its mtime or size changed. */
export class CachedJson<T> {
  private key = "";
  private value: T | undefined;
  constructor(readonly path: string) {}
  read(): T | undefined {
    let key: string;
    try {
      const s = statSync(this.path);
      key = `${s.mtimeMs}:${s.size}`;
    } catch {
      this.key = "";
      this.value = undefined;
      return undefined;
    }
    if (key !== this.key) {
      this.value = readJson<T>(this.path);
      this.key = key;
    }
    return this.value;
  }
}

export function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function sideAlive(dir: string): boolean {
  if (!existsSync(join(dir, FILES.side))) return false;
  return processAlive(readJson<SideInfo>(join(dir, FILES.side))?.pid);
}

export function parseKeys(raw: string | undefined): string[] {
  const keys = (raw ?? "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  return keys.length ? keys : [...DEFAULT_KEYS];
}

export function parseMinColumns(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 20 && n <= 400 ? n : DEFAULT_MIN_COLUMNS;
}

export function parseRatio(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0.15 && n <= 0.85 ? n : DEFAULT_RATIO;
}
