// Interrupting a notebook's kernel, as the stop button in marimo's browser UI does: POST
// /api/kernel/interrupt for the session. marimo checks a server token on every API call (it is in
// the page marimo serves, `data-token="..."`) besides the access token of a protected server.
import { authHeaders } from "../core/registry.js";

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const serverTokens = new Map<string, string>();

async function serverToken(url: string, auth: Record<string, string>, fetchImpl: Fetch, fresh: boolean): Promise<string> {
  const known = serverTokens.get(url);
  if (known !== undefined && !fresh) return known;
  const page = await fetchImpl(`${url}/`, { headers: auth });
  const found = /data-token="([^"]*)"/u.exec(await page.text())?.[1] ?? "";
  serverTokens.set(url, found);
  return found;
}

/** Stops whatever the session's kernel runs (the running cell; the queue behind it is dropped). */
export async function interruptKernel(target: { url: string; sessionId: string }, token?: string, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<void> {
  const auth = authHeaders(token);
  const post = async (fresh: boolean) =>
    fetchImpl(`${target.url}/api/kernel/interrupt`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Marimo-Session-Id": target.sessionId, "Marimo-Server-Token": await serverToken(target.url, auth, fetchImpl, fresh) },
      body: "{}",
    });
  let res = await post(false);
  // A restarted server has a new token.
  if (res.status === 401 || res.status === 403) res = await post(true);
  if (!res.ok) throw new Error(`marimo answered ${res.status}`);
}
