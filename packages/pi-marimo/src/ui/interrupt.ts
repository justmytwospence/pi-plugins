// Interrupting and running cells in a notebook's kernel, and setting its widgets, as the browser's
// buttons and controls do: POST /api/kernel/interrupt, /run, /set_ui_element_value and
// /set_model_value for the session. marimo checks a server token on every API call (it is in the
// page marimo serves, `data-token="..."`) besides the access token of a protected server.
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

/** The headers a kernel endpoint needs for the session: the access token, the session id and the server token (`fresh` refetches it). */
export async function kernelHeaders(target: { url: string; sessionId: string }, token?: string, fetchImpl: Fetch = fetch as unknown as Fetch, fresh = false): Promise<Record<string, string>> {
  const auth = authHeaders(token);
  return { ...auth, "Content-Type": "application/json", "Marimo-Session-Id": target.sessionId, "Marimo-Server-Token": await serverToken(target.url, auth, fetchImpl, fresh) };
}

/** POSTs a JSON body to one of the kernel's endpoints for the session, with marimo's token headers. */
export async function kernelPost(target: { url: string; sessionId: string }, endpoint: string, body: unknown, token?: string, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<void> {
  const post = async (fresh: boolean) =>
    fetchImpl(`${target.url}/api/kernel/${endpoint}`, {
      method: "POST",
      headers: await kernelHeaders(target, token, fetchImpl, fresh),
      body: JSON.stringify(body),
    });
  let res = await post(false);
  // A restarted server has a new token.
  if (res.status === 401 || res.status === 403) res = await post(true);
  if (!res.ok) throw new Error(`marimo answered ${res.status}`);
}

/** Stops whatever the session's kernel runs (the running cell; the queue behind it is dropped). */
export function interruptKernel(target: { url: string; sessionId: string }, token?: string, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<void> {
  return kernelPost(target, "interrupt", {}, token, fetchImpl);
}

/** Runs cells as the browser's run button does: POST /api/kernel/run with each cell's id and code. */
export function runCells(target: { url: string; sessionId: string }, cells: Array<{ id: string; code: string }>, token?: string, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<void> {
  return kernelPost(target, "run", { cellIds: cells.map((c) => c.id), codes: cells.map((c) => c.code) }, token, fetchImpl);
}

/** Sets widgets (by object id) as moving them in the browser does; the cells that read them rerun. */
export function setUiValues(target: { url: string; sessionId: string }, objectIds: string[], values: unknown[], token?: string, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<void> {
  return kernelPost(target, "set_ui_element_value", { objectIds, values }, token, fetchImpl);
}

/** Sends an anywidget a custom message (marimo-lens's commands travel this way); buffers are base64. */
export function setModelValue(target: { url: string; sessionId: string }, modelId: string, content: unknown, buffers: string[], token?: string, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<void> {
  return kernelPost(target, "set_model_value", { modelId, message: { method: "custom", content }, buffers }, token, fetchImpl);
}
