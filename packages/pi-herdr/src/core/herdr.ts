// Shared verbatim by pi-herdr and opencode-herdr (src/core).
//
// The herdr socket API: one JSON line `{ id, method, params }` on the Unix socket at
// $HERDR_SOCKET_PATH, answered by one JSON line `{ id, result }` or `{ id, error }`.
// Every call resolves (never throws): a missing server, a timeout or an error reply all come back
// as `{ error }`, so callers that only decorate herdr's UI can ignore failures.
import net from "node:net";

export interface HerdrTarget {
  socketPath: string;
  paneId: string;
}

/** The pane this process runs in, or undefined outside herdr. */
export function herdrTarget(env: NodeJS.ProcessEnv = process.env): HerdrTarget | undefined {
  if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID) return undefined;
  return { socketPath: env.HERDR_SOCKET_PATH, paneId: env.HERDR_PANE_ID };
}

export interface Reply<T = any> {
  result?: T;
  error?: { code: string; message: string };
}

export type Call = <T = any>(method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<Reply<T>>;

let counter = 0;

export function socketCall(socketPath: string): Call {
  return (method, params, timeoutMs = 2_000) =>
    new Promise((resolve) => {
      const id = `pi-herdr:${process.pid}:${Date.now()}:${counter++}`;
      let done = false;
      let buffer = "";
      const finish = (reply: Reply) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(reply);
      };
      const socket = net.createConnection(process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath);
      const timer = setTimeout(() => finish({ error: { code: "timeout", message: `herdr did not answer ${method}` } }), timeoutMs);
      timer.unref?.();
      socket.on("error", (e) => finish({ error: { code: "socket", message: e.message } }));
      socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        try {
          const reply = JSON.parse(buffer.slice(0, end));
          finish(reply.error ? { error: reply.error } : { result: reply.result });
        } catch {
          finish({ error: { code: "parse", message: "unreadable reply from herdr" } });
        }
      });
      socket.on("end", () => finish({ error: { code: "closed", message: "herdr closed the connection" } }));
    });
}

/** A day, herdr's ceiling for metadata TTLs. */
export const MAX_TTL_MS = 86_400_000;

/**
 * Split beside a pane when it is wide (cells are about twice as tall as wide, so
 * width >= 2.2 x height) and both halves keep 80 columns; otherwise split below.
 */
export function splitDirection(rect: { width: number; height: number } | undefined): "right" | "down" {
  if (!rect) return "right";
  return rect.width >= 2.2 * rect.height && rect.width >= 161 ? "right" : "down";
}

export function errorText(reply: Reply): string {
  return reply.error ? `${reply.error.message} (${reply.error.code})` : "no reply";
}
