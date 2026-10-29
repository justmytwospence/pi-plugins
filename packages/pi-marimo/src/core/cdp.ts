// A small Chrome DevTools Protocol client over Node's built-in WebSocket: commands by id, events by
// name, and sessions (one per page) through `sessionId`.
export type CdpSend = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, any>>;

export interface CdpClient {
  send: CdpSend;
  /** Runs `handler` for each event named `method` on `sessionId`; returns the unsubscribe. */
  on(method: string, sessionId: string | undefined, handler: (params: Record<string, any>) => void): () => void;
  close(): void;
  readonly closed: Promise<void>;
}

interface Reply { id?: number; result?: Record<string, any>; error?: { message?: string }; method?: string; params?: Record<string, any>; sessionId?: string }

export async function connectCdp(url: string): Promise<CdpClient> {
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) throw new Error("this Node has no WebSocket");
  const ws = new WS(url);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("could not reach the browser"));
  });
  let id = 0;
  const pending = new Map<number, { resolve(v: Record<string, any>): void; reject(e: Error): void }>();
  const handlers = new Map<string, Set<(params: Record<string, any>) => void>>();
  let onClosed!: () => void;
  const closed = new Promise<void>((r) => { onClosed = r; });
  ws.onmessage = (event) => {
    let msg: Reply;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "protocol error"));
      else p.resolve(msg.result ?? {});
    } else if (msg.method) {
      for (const h of handlers.get(`${msg.sessionId ?? ""}|${msg.method}`) ?? []) h(msg.params ?? {});
    }
  };
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error("the browser closed"));
    pending.clear();
    onClosed();
  };
  return {
    closed,
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const i = ++id;
        pending.set(i, { resolve, reject });
        try { ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); } catch (e) { pending.delete(i); reject(e as Error); }
      }),
    on(method, sessionId, handler) {
      const key = `${sessionId ?? ""}|${method}`;
      const set = handlers.get(key) ?? new Set();
      set.add(handler);
      handlers.set(key, set);
      return () => { set.delete(handler); };
    },
    close: () => { try { ws.close(); } catch { /* already closed */ } },
  };
}
