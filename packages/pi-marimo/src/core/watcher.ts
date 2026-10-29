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
import { findNotebooks, type NotebookSession, scanServers, type WaitingNotebook, waitingNotebook } from "./registry.js";
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
  /** Canonical file identity used by the watcher, stable across browser session replacements. */
  canonicalPath?: string;
  notebook: NotebookState;
  connection: Connection;
  current: boolean;
  /** When this session's agent last worked in it (0: never). */
  touchedAt: number;
  /** Whether this session uses it: pinned, or its agent has worked in it (now or earlier in the session). */
  engaged?: boolean;
}

/** A running server whose notebook is open in no browser, as the hosts see it. */
export interface Waiting extends WaitingNotebook {
  /** The notebook's file with symlinks resolved, comparable with followed notebooks' `canonicalPath`. */
  canonicalPath: string;
  /** In pinned mode, the pinned path it matched (as pinned). */
  pinned?: string;
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
  private waitingNow: Waiting[] = [];
  // Canonical paths of the notebooks this session's agent has worked in.
  private readonly engagedPaths = new Set<string>();
  // Canonical paths of the notebooks this session opened itself (/marimo edit, /marimo new): followed in any mode but off.
  private readonly includedPaths = new Set<string>();
  // Directories below the cwd, by whether they hold a Git repository of their own.
  private readonly repoDirs = new Map<string, boolean>();

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
    return this.ranked().map((f, i) => ({ attachment: f.attachment, canonicalPath: f.target.real, notebook: f.notebook, connection: f.connection, current: i === 0, touchedAt: f.touchedAt, engaged: this.mode.kind === "pinned" || this.engagedPaths.has(f.target.real) || this.includedPaths.has(f.target.real) }));
  }

  /**
   * Servers that run but have their notebook open in no browser, in file order: in auto mode those
   * serving a notebook under the cwd (outside hidden directories, like followed notebooks), in
   * pinned mode those serving a pinned one, none when off.
   */
  waiting(): Waiting[] {
    return this.waitingNow;
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
    const matches = this.candidates(t);
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Every followed notebook a marimo-pair call could target (see match). */
  private candidates(t: PairTarget): Follower[] {
    let matches = [...this.followers.values()];
    if (t.url) matches = matches.filter((f) => sameServer(f.target.url, t.url!));
    if (t.session) matches = matches.filter((f) => f.target.sessionId === t.session);
    else if (t.file) {
      const file = t.file.replace(/^\.\//, "");
      matches = matches.filter((f) => f.target.path === file || f.target.real === file || f.target.path.endsWith(`/${file}`) || f.target.real.endsWith(`/${file}`));
    } else if (!t.url) matches = [];
    return matches;
  }

  /**
   * The followed notebooks a marimo-pair call could mean when it names more than one (only a
   * server with several of them on it, or a file several servers hold), so it counts for none.
   * Empty when the call is clear, targets nothing followed, or has flags only the shell resolves.
   */
  ambiguous(t: PairTarget): Attachment[] {
    if (t.unresolved) return [];
    const matches = this.candidates(t);
    return matches.length > 1 ? matches.map((f) => f.attachment) : [];
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
      this.engagedPaths.add(match.target.real);
      touched = true;
    });
    if (touched) this.options.onChange();
    return touched;
  }

  /** Follow these notebooks (canonical paths) in auto and pinned mode alike, wherever they are. */
  include(paths: readonly string[]): void {
    for (const p of paths) this.includedPaths.add(p);
    this.scanned = false;
    this.wake?.();
  }

  /** Canonical paths of the notebooks this session opened itself, to save with the session. */
  included(): string[] {
    return [...this.includedPaths];
  }

  /** Canonical paths of the notebooks this session has worked in, to save with the session. */
  engaged(): string[] {
    return [...this.engagedPaths];
  }

  /** Restore notebooks this session worked in before (canonical paths, as engaged() returns them). */
  engage(paths: readonly string[]): void {
    for (const p of paths) this.engagedPaths.add(p);
    this.options.onChange();
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

  /**
   * Whether auto mode counts a notebook as the cwd's: under it, not in a hidden directory there
   * (.worktrees, .claude/worktrees: other checkouts), and not in another Git repository below it
   * (a directory of projects such as ~/Projects holds many; a submodule is its own repository too).
   */
  private async local(path: string, cwd: string): Promise<boolean> {
    if (!within(path, cwd)) return false;
    const dirs = path.slice(cwd.length).split("/").filter(Boolean).slice(0, -1);
    if (dirs.some((part) => part.startsWith("."))) return false;
    const exists = this.options.io.exists;
    if (!exists) return true;
    let dir = cwd === "/" ? "" : cwd;
    for (const part of dirs) {
      dir = `${dir}/${part}`;
      let repo = this.repoDirs.get(dir);
      if (repo === undefined) {
        repo = await exists(`${dir}/.git`).catch(() => false);
        this.repoDirs.set(dir, repo);
      }
      if (repo) return false;
    }
    return true;
  }

  /** The idle servers' notebooks that this mode shows (see waiting). */
  private async scanWaiting(idle: string[]): Promise<Waiting[]> {
    const mode = this.mode;
    const found = (await Promise.all(idle.map((url) => waitingNotebook(this.options.io, url, this.options.token).catch(() => undefined)))).filter((w): w is WaitingNotebook => w !== undefined);
    const withReal: Waiting[] = [];
    for (const w of found) withReal.push({ ...w, canonicalPath: await this.real(w.path) });
    let shown: Waiting[];
    if (mode.kind === "pinned") {
      const pinned = new Map<string, string>();
      for (const p of mode.paths) pinned.set(await this.real(p), p);
      shown = withReal.filter((w) => pinned.has(w.canonicalPath) || this.includedPaths.has(w.canonicalPath)).map((w) => (pinned.has(w.canonicalPath) ? { ...w, pinned: pinned.get(w.canonicalPath) } : w));
    } else {
      this.realCwd ??= await this.real(this.options.cwd);
      const cwd = this.realCwd;
      shown = [];
      for (const w of withReal) if (this.includedPaths.has(w.canonicalPath) || (await this.local(w.canonicalPath, cwd))) shown.push(w);
    }
    return shown.sort((a, b) => (a.canonicalPath < b.canonicalPath ? -1 : a.canonicalPath > b.canonicalPath ? 1 : a.url < b.url ? -1 : 1)).slice(0, this.options.maxNotebooks ?? 8);
  }

  /** The notebooks to follow now, keyed by server and file, and the servers waiting for their notebook to be opened. */
  private async targets(): Promise<{ targets: Map<string, Target>; waiting: Waiting[] }> {
    const mode = this.mode;
    const out = new Map<string, Target>();
    if (mode.kind === "off") return { targets: out, waiting: [] };
    const servers = await scanServers(this.options.io, { token: this.options.token, extraUrls: this.options.extraUrls });
    const sessions = servers.flatMap((s) => s.sessions);
    const waiting = await this.scanWaiting(servers.filter((s) => s.sessions.length === 0).map((s) => s.url));
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
      for (const s of sessions) if (this.includedPaths.has(real.get(s)!)) add(s);
      return { targets: out, waiting };
    }
    // Notebooks this session opened itself (/marimo edit) come first, wherever they are.
    for (const s of sessions) if (this.includedPaths.has(real.get(s)!)) add(s);
    this.realCwd ??= await this.real(this.options.cwd);
    const cwd = this.realCwd;
    const local: NotebookSession[] = [];
    for (const s of sessions) if (await this.local(real.get(s)!, cwd)) local.push(s);
    for (const s of local) add(s);
    const max = this.options.maxNotebooks ?? 8;
    return { targets: new Map([...out].slice(0, max)), waiting };
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
      const scan = await this.targets().catch(() => undefined);
      if (this.stopped) break;
      if (scan) {
        this.reconcile(scan.targets);
        const same = scan.waiting.length === this.waitingNow.length && scan.waiting.every((w, i) => w.url === this.waitingNow[i]!.url && w.path === this.waitingNow[i]!.path);
        if (!same) {
          this.waitingNow = scan.waiting;
          this.options.onChange();
        }
      }
      if (!this.scanned) { this.scanned = true; this.options.onChange(); }
      const sleep = this.options.io.sleep(this.mode.kind === "off" ? 60_000 : pollMs);
      this.wake = sleep.cancel;
      await sleep.done;
    }
  }
}
