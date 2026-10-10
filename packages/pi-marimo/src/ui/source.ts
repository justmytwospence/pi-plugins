// The followed notebooks as a source of background work (activity.ts), like pi-bg's shells and
// pi-subagents' runs:
// - Rows in pi-bg's `/tasks` view, tagged `notebook`: running while a cell runs or is queued,
//   failed when its last run broke cells (until the user's next message, or `x`), idle otherwise.
//   Enter opens the notebook full screen (view.ts); `x` twice interrupts the kernel.
// - A pill under the prompt, `1 notebook` while one is busy and `1 failed` while a failure is
//   unseen; nothing for idle notebooks. A host draws it (pi-subagents' list, or pi-bg's pill);
//   alone, pi-marimo draws its own, and Enter on it opens the busiest notebook.
import { basename } from "../core/io.js";
import { elapsed } from "../core/render.js";
import type { Followed } from "../core/watcher.js";
import { busy } from "../core/hold.js";
import { kernelStateParts } from "../bg.js";
import type { ActivityEntry, ActivityPill, ActivitySection } from "../activity.js";

interface Run {
  since: number;
  startErrors: Set<string>;
}

interface Ended {
  at: number;
  ms: number;
  failed: boolean;
  summary: string;
}

export interface SourceActions {
  followed(): Followed[];
  open(path: string, ui: unknown): Promise<void>;
  interrupt(f: Followed): Promise<void>;
  /** Something changed that whoever shows the source should redraw. */
  changed(): void;
  /** Whether a host shows the pill now. */
  hostedChanged(hosted: boolean): void;
}

export class NotebookSource {
  private runs = new Map<string, Run>();
  private ended = new Map<string, Ended>();
  private dismissed = new Set<string>();
  private dismissedAt = 0;
  private hosts = new Set<string>();
  private lastKey = "";
  readonly section: ActivitySection;

  constructor(private readonly actions: SourceActions) {
    this.section = {
      id: "marimo",
      title: "notebooks",
      noun: "notebook",
      entries: (now) => this.entries(now),
      open: (key, ui) => this.actions.open(key, ui),
      stop: (key) => {
        const f = this.actions.followed().find((o) => o.attachment.path === key);
        if (f) void this.actions.interrupt(f).catch(() => undefined);
      },
      dismiss: (key) => {
        this.dismissed.add(key);
        this.actions.changed();
      },
      pill: (now) => this.pill(now),
      openDialog: (ui) => {
        const path = this.busiest();
        return path ? this.actions.open(path, ui) : Promise.resolve();
      },
      setHosted: (on, host) => {
        const before = this.hosts.size > 0;
        if (on) this.hosts.add(host ?? "host");
        else this.hosts.delete(host ?? "host");
        if (before !== this.hosts.size > 0) this.actions.hostedChanged(this.hosts.size > 0);
      },
    };
  }

  get hosted(): boolean {
    return this.hosts.size > 0;
  }

  resetHosts(): void {
    this.hosts.clear();
  }

  /** The user sent a message: failures before it no longer alert. */
  seen(now = Date.now()): void {
    this.dismissedAt = now;
    this.actions.changed();
  }

  /** Tracks each notebook's runs from the latest state; tells the hosts when anything shown changed. */
  update(followed: Followed[], now = Date.now()): void {
    const paths = new Set(followed.map((f) => f.attachment.path));
    for (const f of followed) {
      const path = f.attachment.path;
      const run = this.runs.get(path);
      if (busy(f)) {
        if (!run) {
          this.runs.set(path, { since: now, startErrors: new Set(f.notebook.errors().map((c) => c.id)) });
          this.dismissed.delete(path);
        }
        continue;
      }
      if (!run || f.connection !== "connected") continue;
      this.runs.delete(path);
      const broke = f.notebook.errors().filter((c) => !run.startErrors.has(c.id)).length;
      this.ended.set(path, { at: now, ms: now - run.since, failed: broke > 0, summary: `ran ${elapsed(now - run.since)}${broke ? ` · ${broke} error${broke === 1 ? "" : "s"}` : ""}` });
    }
    for (const p of [...this.runs.keys(), ...this.ended.keys()]) if (!paths.has(p)) { this.runs.delete(p); this.ended.delete(p); }
    const key = JSON.stringify([followed.map((f) => [f.attachment.path, f.connection, busy(f), kernelStateParts(f)]), this.pill(now)]);
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.actions.changed();
    }
  }

  private alerting(path: string): boolean {
    const e = this.ended.get(path);
    return !!e && e.failed && e.at > this.dismissedAt && !this.dismissed.has(path) && !this.runs.has(path);
  }

  entries(now: number): ActivityEntry[] {
    return this.actions.followed().map((f) => {
      const path = f.attachment.path;
      const run = this.runs.get(path);
      const ended = this.ended.get(path);
      const status: ActivityEntry["status"] = run ? "running" : this.alerting(path) ? "failed" : "done";
      const stats = run ? elapsed(now - run.since) : ended ? `${ended.summary} · ${elapsed(now - ended.at)} ago` : f.connection === "connected" ? "idle" : f.connection;
      return {
        key: path,
        label: basename(path),
        detail: kernelStateParts(f).join(" · "),
        status,
        stats,
        startedAt: run?.since ?? (ended ? ended.at - ended.ms : f.notebook.lastActivity),
        ...(run ? {} : { endedAt: ended?.at ?? f.notebook.lastActivity }),
      };
    });
  }

  pill(now: number): ActivityPill | undefined {
    void now;
    const followed = this.actions.followed();
    const running = followed.filter((f) => this.runs.has(f.attachment.path)).length;
    const failed = followed.filter((f) => this.alerting(f.attachment.path)).length;
    if (!running && !failed) return undefined;
    return { label: running ? `${running} notebook${running === 1 ? "" : "s"}` : "notebooks", ...(failed ? { alert: `${failed} failed` } : {}) };
  }

  /** The notebook to open from the pill: a running one, then a failed one, then the current one. */
  busiest(): string | undefined {
    const followed = this.actions.followed();
    return (
      followed.find((f) => this.runs.has(f.attachment.path)) ??
      followed.find((f) => this.alerting(f.attachment.path)) ??
      followed[0]
    )?.attachment.path;
  }
}
