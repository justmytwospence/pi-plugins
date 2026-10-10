// Everything the core needs from its host, so it runs unchanged under Node and
// Bun (pi, opencode: node-io.ts) and in sandboxes that offer only their own
// file, HTTP, process and clock calls (Claude Code mods). The rest of src/core
// is plain ECMAScript.

export interface Cancellable<T> {
  done: Promise<T>;
  cancel(): void;
}

export interface StreamEnd {
  /** The server answered and the body ended (or was cancelled). */
  ok: boolean;
  status?: number;
}

export interface Io {
  /** The parsed JSON of every entry in marimo's server registry; servers known to be dead may be left out. */
  registryEntries(): Promise<unknown[]>;
  /** GET a JSON document; undefined on any failure. */
  getJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown>;
  /** GET a streaming body, handing over its text as it arrives. */
  stream(url: string, headers: Record<string, string>, onText: (text: string) => void): Cancellable<StreamEnd>;
  /** The path with symlinks resolved (macOS /tmp is /private/tmp); the path itself when that fails. */
  realpath(path: string): Promise<string>;
  sleep(ms: number): Cancellable<void>;
}

/** Posix path helpers, enough for comparing absolute notebook paths. */
export function normalize(path: string, cwd = "/"): string {
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

/** Whether path is dir or inside it (both absolute and normalized). */
export function within(path: string, dir: string): boolean {
  const d = normalize(dir);
  const p = normalize(path);
  return p === d || p.startsWith(d === "/" ? "/" : `${d}/`);
}
