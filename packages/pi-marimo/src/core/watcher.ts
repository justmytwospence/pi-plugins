// Keeps the live state of the notebooks you work in current. It finds them,
// subscribes to each one's session as a kiosk consumer, follows them across
// page reloads (which change the session id) and server restarts, and reports
// every change. The followed notebooks are the pinned ones, or in auto mode
// every one open under the cwd. The current one is the one this session's agent
// worked in last (through marimo-pair), so two sessions in two notebooks each
// keep their own; before the agent touches any, the one used most recently by
// anyone (a running cell, then the latest cell run or edit).

import { type Cancellable, type Io, normalize, within } from "./io.js";
import { NotebookState } from "./notebook.js";
import { findNotebooks, type NotebookSession } from "./registry.js";
import type { Attachment } from "./render.js";
import { streamSession } from "./sse.js";
import { type PairTarget, sameServer } from "./touch.js";

export type Mode =
  | { kind: "auto" }
  | { kind: "pinned"; paths: string[] }
  | { kind: "off" };

export type Connection = "idle" | "searching" | "connecting" | "connected" | "disconnected";

export interface WatcherOptions {
  io: Io;
  cwd: string;
  token?: string;
  extraUrls?: string[];
  pollMs?: number;
  /** Most notebooks followed at once in auto mode. */
  maxNotebooks?: number;
  onChange: () => void;
}

type Target = NotebookSession & { real: string; shared: boolean };

const consumerId = (): string => `pi-marimo-${Math.random().toString(36).slice(2, 10)}`;

/** A followed notebook, as the hosts see it. */
export interface Followed {
  attachment: Attachment;
  notebook: NotebookState;
  connection: Connection;
  current: boolean;
  /** When this session's agent last worked in it (0: never). */
  touchedAt: number;
}

/** Read a saved or configured mode, accepting the single-notebook form `{ kind: "pinned", path }`. */
export function parseMode(raw: unknown): Mode | undefined {
  const mode = raw as { kind?: unknown; path?: unknown; paths?: unknown } | undefined;
  if (mode?.kind === "auto" || mode?.kind === "off") return { kind: mode.kind };
  if (mode?.kind !== "pinned") return undefined;
  const paths = Array.isArray(mode.paths) ? mode.paths.filter((p): p is string => typeof p === "string") : typeof mode.path === "string" ? [mode.path] : [];
  return paths.length ? { kind: "pinned", paths } : undefined;
}

/** One notebook's subscription, reconnecting until stopped. */
class Follower {
  readonly notebook = new NotebookState();
  connection: Connection = "connecting";
  /** Whether browser edits reach us (false when connected by the browser's own session id). */
  seesBrowserEdits = false;
  /** When this session's agent last worked in the notebook (0: never). */
  touchedAt = 0;
  private stopped = false;
  private current?: Cancellable<unknown>;
  private sleep?: Cancellable<void>;
  private readonly id = consumerId();
  readonly loop: Promise<void>;

  constructor(public target: Target, private readonly options: WatcherOptions, private readonly changed: () => void) {
    this.loop = this.run();
  }

  get attachment(): Attachment {
    return { url: this.target.url, sessionId: this.target.sessionId, path: this.target.path };
  }

  /** Point at a new session for the same file (a page reload) and reconnect. */
  retarget(target: Target): void {
    if (target.sessionId === this.target.sessionId && target.shared === this.target.shared) return;
    this.target = target;
    this.current?.cancel();
    this.sleep?.cancel();
  }

  stop(): void {
    this.stopped = true;
    this.current?.cancel();
    this.sleep?.cancel();
  }

  private set(connection: Connection): void {
    if (connection === this.connection) return;
    this.connection = connection;
    this.changed();
  }

  private async run(): Promise<void> {
    const pollMs = this.options.pollMs ?? 5000;
    while (!this.stopped) {
      const target = this.target;
      this.seesBrowserEdits = !target.shared;
      this.notebook.reset();
      this.set("connecting");
      const stream = streamSession({
        io: this.options.io,
        url: target.url,
        // marimo names a consumer after the session id it connected with and
        // does not echo a browser's own edits back to that id. Connecting
        // under our own id (marimo then finds the session by file) receives
        // them. That lookup takes the oldest session for the file, so when
        // several hold it, connect by the exact id and miss browser edits.
        sessionId: target.shared ? target.sessionId : this.id,
        file: target.path,
        token: this.options.token,
        onMessage: (op, data) => {
          const changed = this.notebook.apply(op, data);
          if (op === "kernel-ready") this.set("connected");
          if (changed) this.changed();
        },
      });
      this.current = stream;
      const result = await stream.done.catch(() => ({ kind: "http-error" as const }));
      if (this.stopped) break;
      this.set("disconnected");
      if (target !== this.target) continue;
      // A dropped stream reconnects quickly; a refused one waits for the next poll.
      this.sleep = this.options.io.sleep(result.kind === "ended" ? 1000 : pollMs);
      await this.sleep.done;
    }
  }
}

export class MarimoWatcher {
  mode: Mode = { kind: "auto" };
  private followers = new Map<string, Follower>();
  private stopped = true;
  private scanned = false;
  private wake?: () => void;
  private loop?: Promise<void>;
  private realCwd?: string;
  private readonly realPaths = new Map<string, string>();
  private readonly empty = new NotebookState();

  constructor(private readonly options: WatcherOptions) {}

  /** Followers, the current one first, then by most recent use. */
  private ranked(): Follower[] {
    const rank = (x: Follower): number[] => [x.connection === "connected" ? 1 : 0, x.touchedAt, x.notebook.running() ? 1 : 0, x.notebook.lastActivity];
    const cmp = (a: Follower, b: Follower): number => {
      const [x, y] = [rank(a), rank(b)];
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i]! - x[i]!;
      return 0;
    };
    return [...this.followers.values()].sort(cmp);
  }

  /** The current notebook: the one used most recently. */
  private get active(): Follower | undefined {
    return this.ranked()[0];
  }

  /** Every followed notebook, the current one first, then by most recent use. */
  followed(): Followed[] {
    return this.ranked().map((f, i) => ({ attachment: f.attachment, notebook: f.notebook, connection: f.connection, current: i === 0, touchedAt: f.touchedAt }));
  }

  get notebook(): NotebookState {
    return this.active?.notebook ?? this.empty;
  }

  get attachment(): Attachment | undefined {
    const active = this.active;
    if (active) return active.attachment;
    return this.mode.kind === "pinned" ? { url: "", sessionId: "", path: this.mode.paths[0]! } : undefined;
  }

  get connection(): Connection {
    const active = this.active;
    if (active) return active.connection;
    return this.mode.kind === "off" ? "idle" : "searching";
  }

  get seesBrowserEdits(): boolean {
    return this.active?.seesBrowserEdits ?? false;
  }

  /**
   * The one followed notebook a marimo-pair call targets, if it is unambiguous: by session id, by
   * file (as marimo-pair takes it: absolute, or relative to the server's directory), or by server
   * alone when only one followed notebook is on it.
   */
  private match(t: PairTarget) {
    let matches = [...this.followers.values()];
    if (t.url) matches = matches.filter((f) => sameServer(f.target.url, t.url!));
    if (t.session) matches = matches.filter((f) => f.target.sessionId === t.session);
    else if (t.file) {
      const file = t.file.replace(/^\.\//, "");
      matches = matches.filter((f) => f.target.path === file || f.target.real === file || f.target.path.endsWith(`/${file}`) || f.target.real.endsWith(`/${file}`));
    } else if (!t.url) matches = [];
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** The paths of the followed notebooks these marimo-pair calls target. */
  targeted(targets: PairTarget[]): string[] {
    return targets.map((t) => this.match(t)?.attachment.path).filter((p): p is string => p !== undefined);
  }

  /**
   * Note that this session's agent works in these notebooks (from its marimo-pair calls), making
   * the last one current for this session. Returns whether any followed notebook matched.
   */
  touch(targets: PairTarget[], now = Date.now()): boolean {
    let touched = false;
    targets.forEach((t, i) => {
      const match = this.match(t);
      if (!match) return;
      // Later calls in one tool call win.
      match.touchedAt = now + i;
      touched = true;
    });
    if (touched) this.options.onChange();
    return touched;
  }

  /** The other notebooks followed besides the current one, most recently used first. */
  others(): Attachment[] {
    return this.ranked().slice(1).map((f) => f.attachment);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.run();
  }

  /** Stop, waiting at most a second for streams to close (a host may only end one at its next chunk). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    const loops = [...this.followers.values()].map((f) => { f.stop(); return f.loop; });
    this.followers.clear();
    await Promise.race([Promise.all([this.loop, ...loops]).catch(() => undefined), this.options.io.sleep(1000).done]);
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.scanned = false;
    this.wake?.();
  }

  /** Wait (up to ms) for the first scan and any connection in progress, so a first request has the state. */
  async settle(ms: number): Promise<void> {
    const busy = () => !this.scanned || [...this.followers.values()].some((f) => f.connection === "connecting");
    for (let waited = 0; !this.stopped && busy() && waited < ms; waited += 50) {
      await this.options.io.sleep(50).done;
    }
  }

  /** Rescan now instead of at the next poll. */
  refresh(): void {
    this.wake?.();
  }

  async list(): Promise<NotebookSession[]> {
    return findNotebooks(this.options.io, { token: this.options.token, extraUrls: this.options.extraUrls });
  }

  private async real(path: string): Promise<string> {
    const absolute = normalize(path, this.options.cwd);
    let real = this.realPaths.get(absolute);
    if (real === undefined) {
      real = normalize(await this.options.io.realpath(absolute));
      this.realPaths.set(absolute, real);
    }
    return real;
  }

  /** The notebooks to follow now, keyed by server and file. */
  private async targets(): Promise<Map<string, Target>> {
    const mode = this.mode;
    const out = new Map<string, Target>();
    if (mode.kind === "off") return out;
    const sessions = await this.list();
    const real = new Map<NotebookSession, string>();
    for (const s of sessions) real.set(s, await this.real(s.path));
    // Several sessions can hold one file (a closed tab's session lingers);
    // marimo lists them oldest first, so the newest wins.
    const add = (s: NotebookSession): void => {
      const path = real.get(s)!;
      const shared = sessions.filter((o) => o.url === s.url && real.get(o) === path).length > 1;
      out.set(`${s.url} ${path}`, { ...s, real: path, shared });
    };
    if (mode.kind === "pinned") {
      for (const pinned of mode.paths) {
        const path = await this.real(pinned);
        const chosen = sessions.filter((s) => real.get(s) === path).pop();
        if (chosen) add(chosen);
      }
      return out;
    }
    this.realCwd ??= await this.real(this.options.cwd);
    const cwd = this.realCwd;
    // Under the cwd, but not in a hidden directory there (.worktrees, .claude/worktrees: other checkouts).
    const local = sessions.filter((s) => {
      const path = real.get(s)!;
      return within(path, cwd) && !path.slice(cwd.length).split("/").slice(0, -1).some((part) => part.startsWith("."));
    });
    for (const s of local) add(s);
    const max = this.options.maxNotebooks ?? 8;
    return new Map([...out].slice(0, max));
  }

  private reconcile(targets: Map<string, Target>): void {
    let changed = false;
    for (const [key, follower] of this.followers) {
      if (targets.has(key)) continue;
      follower.stop();
      this.followers.delete(key);
      changed = true;
    }
    for (const [key, target] of targets) {
      const follower = this.followers.get(key);
      if (follower) follower.retarget(target);
      else {
        this.followers.set(key, new Follower(target, this.options, () => this.options.onChange()));
        changed = true;
      }
    }
    if (changed) this.options.onChange();
  }

  private async run(): Promise<void> {
    const pollMs = this.options.pollMs ?? 5000;
    while (!this.stopped) {
      const targets = await this.targets().catch(() => undefined);
      if (this.stopped) break;
      if (targets) this.reconcile(targets);
      if (!this.scanned) { this.scanned = true; this.options.onChange(); }
      const sleep = this.options.io.sleep(this.mode.kind === "off" ? 60_000 : pollMs);
      this.wake = sleep.cancel;
      await sleep.done;
    }
  }
}
