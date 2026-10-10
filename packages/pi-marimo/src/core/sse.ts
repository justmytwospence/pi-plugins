// A read-only (kiosk) subscription to a marimo session's message stream.
//
// marimo serves the same kernel messages over /ws and /sse. A kiosk consumer
// is never the session's main consumer: it cannot edit or run code and does
// not take the notebook over from the browser. Connecting replays the
// session's current state (kernel-ready, then every cell's last messages), so
// a fresh NotebookState is complete after the replay.

import type { Cancellable, Io } from "./io.js";
import { authHeaders } from "./registry.js";

export interface SseEvent {
  event?: string;
  data: string;
}

/** Incremental parser for a text/event-stream body. */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const events: SseEvent[] = [];
    let end = this.buffer.indexOf("\n\n");
    while (end >= 0) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let event: string | undefined;
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) events.push({ event, data: data.join("\n") });
      end = this.buffer.indexOf("\n\n");
    }
    return events;
  }
}

export interface StreamResult {
  /** "closed": the server ended the stream with a close event. "ended": the stream dropped. */
  kind: "closed" | "ended" | "http-error";
  code?: number;
  reason?: string;
}

export interface StreamOptions {
  io: Io;
  url: string;
  sessionId: string;
  file?: string;
  token?: string;
  onMessage: (op: string, data: unknown) => void;
}

export function streamSession(options: StreamOptions): Cancellable<StreamResult> {
  const query: Record<string, string> = { session_id: options.sessionId, kiosk: "true" };
  if (options.file) query.file = options.file;
  if (options.token) query.access_token = options.token;
  const params = Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const parser = new SseParser();
  let closed: StreamResult | undefined;
  const stream = options.io.stream(
    `${options.url}/sse?${params}`,
    { Accept: "text/event-stream", ...authHeaders(options.token) },
    (text) => {
      if (closed) return;
      for (const event of parser.push(text)) {
        if (event.event === "close") {
          try {
            const body = JSON.parse(event.data) as { code?: number; reason?: string };
            closed = { kind: "closed", code: body.code, reason: body.reason };
          } catch {
            closed = { kind: "closed" };
          }
          stream.cancel();
          return;
        }
        if (event.event && event.event !== "message") continue;
        let message: { op?: unknown; data?: unknown };
        try {
          message = JSON.parse(event.data);
        } catch {
          continue;
        }
        if (typeof message.op === "string") options.onMessage(message.op, message.data);
      }
    },
  );
  const done = stream.done.then((end): StreamResult => closed ?? (end.ok ? { kind: "ended" } : { kind: "http-error", code: end.status }));
  return { done, cancel: stream.cancel };
}
