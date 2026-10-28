// Find running marimo servers and the notebooks open on them.
//
// Servers started with --no-token register a JSON file under
// $XDG_STATE_HOME/marimo/servers (marimo/_server/server_registry.py). A
// token-protected server is reached with MARIMO_TOKEN.

import type { Io } from "./io.js";

export interface NotebookSession {
  url: string;
  sessionId: string;
  path: string;
}

export function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function hostFor(host: unknown): string {
  if (typeof host !== "string" || host === "" || host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** Base URLs of the registered servers. */
export async function serverUrls(io: Io): Promise<string[]> {
  const urls: string[] = [];
  for (const raw of await io.registryEntries()) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    if (typeof entry.port !== "number") continue;
    const base = typeof entry.base_url === "string" ? entry.base_url.replace(/\/$/, "") : "";
    urls.push(`http://${hostFor(entry.host)}:${entry.port}${base}`);
  }
  return urls;
}

export async function listSessions(io: Io, url: string, token?: string): Promise<NotebookSession[]> {
  const body = await io.getJson(`${url}/api/sessions`, authHeaders(token), 2000);
  if (body === null || typeof body !== "object") return [];
  return Object.entries(body as Record<string, Record<string, unknown> | null>).flatMap(([sessionId, info]) => {
    const path = typeof info?.path === "string" ? info.path : typeof info?.filename === "string" ? info.filename : "";
    return path ? [{ url, sessionId, path }] : [];
  });
}

/** A running server and the notebook sessions open on it (none: nobody has the notebook open). */
export interface ServerSessions {
  url: string;
  sessions: NotebookSession[];
}

/** Every registered server (plus any extra server URLs) with its open sessions. */
export async function scanServers(io: Io, options: { token?: string; extraUrls?: string[] } = {}): Promise<ServerSessions[]> {
  const urls = new Set(await serverUrls(io));
  for (const url of options.extraUrls ?? []) urls.add(url.replace(/\/$/, ""));
  return Promise.all([...urls].map(async (url) => ({ url, sessions: await listSessions(io, url, options.token) })));
}

/** Every notebook session open on every registered server, plus any extra server URLs. */
export async function findNotebooks(io: Io, options: { token?: string; extraUrls?: string[] } = {}): Promise<NotebookSession[]> {
  return (await scanServers(io, options)).flatMap((s) => s.sessions);
}

/** A running server whose one notebook is open in no browser: it is waiting for the user. */
export interface WaitingNotebook {
  url: string;
  path: string;
}

/**
 * The notebook a server with no sessions serves, from the file listing its home page uses
 * (`marimo edit nb.py` lists exactly that file). A server serving a directory or several files
 * has no single notebook to name, so it is not reported.
 */
export async function waitingNotebook(io: Io, url: string, token?: string): Promise<WaitingNotebook | undefined> {
  const body = await io.postJson?.(`${url}/api/home/workspace_files`, authHeaders(token), {}, 2000);
  const files = (body as { files?: unknown } | null | undefined)?.files;
  if (!Array.isArray(files) || files.length !== 1) return undefined;
  const file = files[0] as { path?: unknown; isDirectory?: unknown; isMarimoFile?: unknown } | null;
  if (typeof file?.path !== "string" || !file.path || file.isDirectory === true || file.isMarimoFile === false) return undefined;
  return { url, path: file.path };
}
