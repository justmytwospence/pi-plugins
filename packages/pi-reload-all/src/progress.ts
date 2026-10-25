// The live view in the session that ran /reload-all: one row per session that answered, read
// from the ack folders here and (over ssh) on each signalled machine, above the editor until every
// session has reloaded, failed or stopped answering, or the time limit runs out.
import { type Ack, parseAcks, readAcks, remoteReadCommand } from "./acks.ts";

export const WIDGET = "reload-all";
export const PROGRESS_POLL_MS = 3_000;
/** Give up on the live view this long after the request. */
export const PROGRESS_LIMIT_MS = 10 * 60 * 1000;
/** Everyone who answered is done and nobody new for this long: the rest are not listening. */
export const SETTLE_MS = 30_000;
const MAX_ROWS = 12;

export interface Tracked {
  id: string;
  at: number;
  /** Machines signalled over ssh. */
  machines: { label: string; target: string }[];
  /** Pi panes Herdr counted, over all machines; undefined when it could not tell. */
  expected?: number;
}

export interface ProgressDeps {
  exec(file: string, args: string[], timeoutMs: number): Promise<string>;
  now(): number;
}

export interface ProgressUI {
  setWidget(key: string, lines: string[] | undefined): void;
  dim(s: string): string;
  accent(s: string): string;
  warn(s: string): string;
  ok(s: string): string;
}

const terminal = (a: Ack) => a.state === "reloaded" || a.state === "failed";

export function summarize(t: Tracked, acks: Ack[], now: number, lastChange: number): { lines: string[]; done: boolean; title: string } {
  const reloaded = acks.filter((a) => a.state === "reloaded").length;
  const failed = acks.filter((a) => a.state === "failed").length;
  const total = Math.max(t.expected ?? 0, acks.length);
  const allTerminal = acks.length > 0 && acks.every(terminal);
  const missing = Math.max(0, (t.expected ?? acks.length) - acks.length);
  const timedOut = now - t.at >= PROGRESS_LIMIT_MS;
  const done = timedOut || (allTerminal && (missing === 0 || now - lastChange >= SETTLE_MS));
  const parts = [`${reloaded}/${total} reloaded`];
  if (failed) parts.push(`${failed} failed`);
  if (missing && (done || now - t.at >= SETTLE_MS)) parts.push(`${missing} not answering`);
  if (timedOut && !allTerminal) parts.push("stopped watching");
  const title = `reload-all · ${parts.join(" · ")}`;
  const order = { pending: 0, reloading: 1, failed: 2, reloaded: 3 } as const;
  const sorted = [...acks].sort((a, b) => order[a.state] - order[b.state] || a.host.localeCompare(b.host) || a.name.localeCompare(b.name));
  const hostWidth = Math.min(16, Math.max(0, ...sorted.map((a) => a.host.length)));
  const nameWidth = Math.min(28, Math.max(0, ...sorted.map((a) => a.name.length)));
  const rows = sorted.slice(0, MAX_ROWS).map((a) => {
    const state = a.state === "pending" ? `pending${a.reason ? `: ${a.reason}` : ""}` : a.state === "failed" ? `failed${a.reason ? `: ${a.reason}` : ""}` : a.state;
    return `  ${a.host.slice(0, hostWidth).padEnd(hostWidth)}  ${a.name.slice(0, nameWidth).padEnd(nameWidth)}  ${state}`;
  });
  if (sorted.length > MAX_ROWS) rows.push(`  … ${sorted.length - MAX_ROWS} more`);
  return { lines: [title, ...rows], done, title };
}

export class Progress {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private lastKey = "";
  private lastChange: number;
  private remote = new Map<string, Ack[]>();

  private readonly t: Tracked;
  private readonly ui: ProgressUI;
  private readonly deps: ProgressDeps;
  private readonly onDone: (lines: string[]) => void;
  private readonly readLocal: (id: string) => Ack[];

  constructor(t: Tracked, ui: ProgressUI, deps: ProgressDeps, onDone: (lines: string[]) => void, readLocal: (id: string) => Ack[] = readAcks) {
    this.t = t;
    this.ui = ui;
    this.deps = deps;
    this.onDone = onDone;
    this.readLocal = readLocal;
    this.lastChange = deps.now();
  }

  start(): void {
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Clears the view for good (dismissed). */
  dismiss(): void {
    this.stop();
    try {
      this.ui.setWidget(WIDGET, undefined);
    } catch {
      // stale
    }
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    await Promise.all(
      this.t.machines.map(async (m) => {
        try {
          const out = await this.deps.exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", m.target, remoteReadCommand(this.t.id)], 15_000);
          this.remote.set(m.label, parseAcks(out));
        } catch {
          // keep the last answer
        }
      }),
    );
    if (this.stopped) return;
    const acks = dedupe([...this.readLocal(this.t.id), ...[...this.remote.values()].flat()]);
    const now = this.deps.now();
    const key = acks.map((a) => `${a.host}/${a.session}:${a.state}:${a.reason ?? ""}`).sort().join("|");
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.lastChange = now;
    }
    const { lines, done } = summarize(this.t, acks, now, this.lastChange);
    if (done) {
      this.dismiss();
      this.onDone(lines);
      return;
    }
    try {
      this.ui.setWidget(WIDGET, this.paint(lines));
    } catch {
      this.stop();
      return;
    }
    this.timer = setTimeout(() => void this.tick(), PROGRESS_POLL_MS);
    this.timer.unref?.();
  }

  private paint(lines: string[]): string[] {
    return lines.map((l, i) => {
      if (i === 0) return this.ui.accent(l);
      if (/\bfailed\b/u.test(l)) return this.ui.warn(l);
      if (/reloaded$/u.test(l)) return this.ui.ok(l);
      return this.ui.dim(l);
    });
  }
}

/** The same session can be read twice (a machine signalled by both label and host). */
function dedupe(acks: Ack[]): Ack[] {
  const by = new Map<string, Ack>();
  for (const a of acks) {
    const k = `${a.host}/${a.session}`;
    const prev = by.get(k);
    if (!prev || a.at >= prev.at) by.set(k, a);
  }
  return [...by.values()];
}
