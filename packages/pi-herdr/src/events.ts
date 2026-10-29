// A long-lived herdr event subscription (`events.subscribe`): one socket connection, one JSON
// line per pushed event, `{ "event": "<kind>", "data": { ... } }`, after a first reply
// `{ "id", "result": { "type": "subscription_started" } }`. herdr keeps no durable history: a
// subscriber that falls behind gets `{ "id", "error": { "code": "events_lost" } }` and is closed,
// and a restarted server drops every subscription. Either way this reconnects with backoff and
// calls `onResync`, so the owner reconciles from `session.snapshot` instead of trusting that it
// saw every event. Nothing here throws.
import net from "node:net";

export interface HerdrEvent {
  event: string;
  data: any;
}

export interface SubscriptionOptions {
  socketPath: string;
  /** `events.subscribe` entries, e.g. `{ type: "workspace.metadata_updated" }`. */
  subscriptions: Array<Record<string, unknown>>;
  onEvent(e: HerdrEvent): void;
  /** After every (re)connection is acknowledged: events may have been missed, reconcile. */
  onResync?(): void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Tests: the socket factory. */
  connect?: (path: string) => net.Socket;
}

let counter = 0;

export class HerdrSubscription {
  private socket: net.Socket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private backoff: number;
  private closed = false;
  private readonly opts: SubscriptionOptions;

  constructor(opts: SubscriptionOptions) {
    this.opts = opts;
    this.backoff = opts.minBackoffMs ?? 1_000;
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    const id = `pi-herdr-sub:${process.pid}:${counter++}`;
    let buffer = "";
    let started = false;
    let socket: net.Socket;
    try {
      socket = (this.opts.connect ?? ((p) => net.createConnection(p)))(this.opts.socketPath);
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
    socket.unref?.();
    const drop = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      socket.destroy();
      this.retry();
    };
    socket.on("error", drop);
    socket.on("close", drop);
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions: this.opts.subscriptions } })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.id === id) {
          if (msg.error) return drop();
          if (msg.result?.type === "subscription_started" && !started) {
            started = true;
            this.backoff = this.opts.minBackoffMs ?? 1_000;
            try { this.opts.onResync?.(); } catch { /* the owner's problem */ }
          }
          continue;
        }
        if (typeof msg?.event === "string") {
          try { this.opts.onEvent({ event: msg.event, data: msg.data }); } catch { /* the owner's problem */ }
        }
      }
    });
  }

  private retry(): void {
    if (this.closed || this.timer) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 60_000);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.open();
    }, wait);
    this.timer.unref?.();
  }

  get connected(): boolean {
    return !!this.socket && !this.closed;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const s = this.socket;
    this.socket = undefined;
    s?.destroy();
  }
}
