// A notebook opened without a browser: a WebSocket to the server's /ws, as marimo's own page opens
// it, which makes the server start the notebook's kernel session. marimo-pair (and the rest of
// pi-marimo) need such a session to exist; holding the socket keeps it alive, and closing it lets
// the server's session TTL end it. Nothing is run: the cells wait until something runs them (the
// view's `r`/`A`, or marimo-pair), exactly as in a browser tab that has not run the notebook yet.
import { randomBytes } from "node:crypto";

type Socket = {
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onclose: ((e: unknown) => void) | null;
  close(): void;
};
type SocketCtor = new (url: string) => Socket;

interface Held {
  sessionId: string;
  socket: Socket;
}

export const KERNEL_WAIT_MS = 15_000;

/** `http://127.0.0.1:2718` and a notebook file: the WebSocket address the browser would use. */
export function socketUrl(serverUrl: string, file: string, sessionId: string, token?: string): string {
  const base = serverUrl.replace(/\/+$/u, "").replace(/^http/u, "ws");
  const query = new URLSearchParams({ session_id: sessionId, file });
  if (token) query.set("access_token", token);
  return `${base}/ws?${query.toString()}`;
}

export class HeadlessSessions {
  private readonly held = new Map<string, Held>();
  private readonly starting = new Map<string, Promise<string>>();

  /** Messages that arrive on a held session (marimo answers a function call only to the session that made it). */
  onMessage: ((serverUrl: string, file: string, op: string, data: unknown) => void) | undefined;

  constructor(private readonly Socket: SocketCtor | null | undefined = (globalThis as { WebSocket?: SocketCtor }).WebSocket) {}

  private static key(serverUrl: string, file: string): string {
    return `${serverUrl.replace(/\/+$/u, "")}\0${file}`;
  }

  /** Whether this process holds a headless session for the notebook. */
  has(serverUrl: string, file: string): boolean {
    return this.held.has(HeadlessSessions.key(serverUrl, file));
  }

  /** Opens the notebook on the server (or finds it already held) and resolves with its session id once the kernel is ready. */
  attach(serverUrl: string, file: string, token?: string, waitMs = KERNEL_WAIT_MS): Promise<string> {
    const key = HeadlessSessions.key(serverUrl, file);
    const known = this.held.get(key);
    if (known) return Promise.resolve(known.sessionId);
    const pending = this.starting.get(key);
    if (pending) return pending;
    const Socket = this.Socket;
    if (!Socket) return Promise.reject(new Error("this Node has no WebSocket"));
    const sessionId = `s_${randomBytes(4).toString("hex")}`;
    const started = new Promise<string>((resolve, reject) => {
      let socket: Socket;
      try {
        socket = new Socket(socketUrl(serverUrl, file, sessionId, token));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch { /* already closed */ }
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail("the kernel did not start"), waitMs);
      timer.unref?.();
      socket.onmessage = (e) => {
        const text = String(e.data);
        if (settled && this.onMessage && text.includes('"function-call-result"')) {
          try {
            const msg = JSON.parse(text) as { op?: string; data?: unknown };
            if (msg.op) this.onMessage(serverUrl, file, msg.op, msg.data);
          } catch { /* not JSON */ }
        }
        if (settled || !text.includes('"kernel-ready"')) return;
        settled = true;
        clearTimeout(timer);
        this.held.set(key, { sessionId, socket });
        resolve(sessionId);
      };
      socket.onerror = () => fail("could not reach the marimo server");
      socket.onclose = () => {
        if (this.held.get(key)?.socket === socket) this.held.delete(key);
        fail("the marimo server closed the connection");
      };
    }).finally(() => this.starting.delete(key));
    this.starting.set(key, started);
    return started;
  }

  /** Lets go of every session (the servers end them after their TTL), except those on servers `keep` names. */
  closeAll(keep: (serverUrl: string) => boolean = () => false): void {
    for (const [key, { socket }] of this.held) {
      if (keep(key.slice(0, key.indexOf("\0")))) continue;
      try { socket.close(); } catch { /* already closed */ }
      this.held.delete(key);
    }
  }
}
