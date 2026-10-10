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

/** Every notebook session open on every registered server, plus any extra server URLs. */
export async function findNotebooks(io: Io, options: { token?: string; extraUrls?: string[] } = {}): Promise<NotebookSession[]> {
  const urls = new Set(await serverUrls(io));
  for (const url of options.extraUrls ?? []) urls.add(url.replace(/\/$/, ""));
  const lists = await Promise.all([...urls].map((url) => listSessions(io, url, options.token)));
  return lists.flat();
}
