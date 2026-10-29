// The followed notebooks as a source of background work (activity.ts), like pi-bg's tasks and
// pi-subagents' runs:
// - Rows in pi-bg's `/tasks` view, tagged `notebook`: running while a cell runs or is queued,
//   failed when its last run broke cells (until the user's next message, or `x`), idle otherwise.
//   Enter opens the notebook full screen (view.ts); `x` twice interrupts the kernel. While a pi-bg
//   job drives the run, the row stands for that job too (pi-bg hides the job's own) and names it.
// - Rows under the prompt, one per notebook this session uses (`○ fit.py :2718 · idle`), plus servers
//   open in no browser and pinned files not open; they replace the footer lines. They are the pill's
//   `rows` (activity.ts), so a host (pi-subagents' list, or pi-bg's pill) draws them, and alone
//   pi-marimo draws its own. ↓ at the prompt selects them, Enter opens the notebook's view (a server
//   open in no browser opens in the browser), `x` twice interrupts a running one.
// - marimo-lens selections the user made since their last message add `2 selections` to the pill,
//   and every open selection is counted in the notebook's row.
import { basename } from "../core/io.js";
import { shortWhere } from "../core/render.js";
import { interruptKey, notebookKey } from "./identity.js";
import { elapsed } from "../core/render.js";
import type { Followed } from "../core/watcher.js";
import { busy } from "../core/hold.js";
import { kernelStateParts, lensParts } from "../bg.js";
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
  open(key: string, ui: unknown): Promise<void>;
  interrupt(f: Followed): Promise<void>;
  /** Something changed that whoever shows the source should redraw. */
  changed(): void;
  /** Whether a host shows the pill now. */
  hostedChanged(hosted: boolean): void;
  /** The pi-bg jobs running this notebook's cells, whose rows this one stands for. */
  drivers?(f: Followed): string[];
  /** The pi-bg servers standing for this notebook. */
  servers?(f: Followed): string[];
  /** The followed notebooks this session uses, which the rows under the prompt list (default: all followed). */
  engaged?(): Followed[];
  /** Opens a URL in the browser. */
  openUrl?(url: string): void;
  /** Notebooks with no session to follow yet (a running server open in no browser, a pinned file not open). */
  unopened?(): Unopened[];
}

/** A notebook listed in the rows under the prompt that is not followed: opening it opens its server in the browser. */
export interface Unopened {
  key: string;
  path: string;
  /** Its server, `:2718`, when known. */
  where?: string | undefined;
  /** `not open`. */
  state: string;
  /** Where Enter takes you, when there is a server. */
  url?: string | undefined;
}

export class NotebookSource {
  private runs = new Map<string, Run>();
  private ended = new Map<string, Ended>();
  private dismissed = new Set<string>();
  private dismissedAt = 0;
  private hosts = new Set<string>();
  private lastKey = "";
  /** When each open Lens selection (path + id) was first seen. */
  private lensSince = new Map<string, number>();
  readonly section: ActivitySection;

  constructor(private readonly actions: SourceActions) {
    this.section = {
      id: "marimo",
      title: "notebooks",
      noun: "notebook",
      entries: (now) => this.entries(now),
      open: (key, ui) => {
        const other = this.actions.unopened?.().find((u) => u.key === key);
        if (other) {
          if (other.url) this.actions.openUrl?.(other.url);
          return Promise.resolve();
        }
        return this.actions.open(key, ui);
      },
      canStop: (key) => {
        const f = this.actions.followed().find((o) => notebookKey(o) === key);
        return !!f && f.connection === "connected" && busy(f);
      },
      stop: (key) => {
        const f = this.actions.followed().find((o) => notebookKey(o) === key);
        if (f && f.connection === "connected" && busy(f)) return this.actions.interrupt(f);
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
        if (on) this.hosts.add(host ?? "subagents");
        else this.hosts.delete(host ?? "subagents");
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
    const paths = new Set(followed.map(notebookKey));
    for (const f of followed) {
      const path = notebookKey(f);
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
    const open = new Set<string>();
    for (const f of followed) {
      if (f.connection !== "connected") continue;
      for (const s of f.notebook.lens.selections()) {
        const key = `${notebookKey(f)}\0${s.id}`;
        open.add(key);
        if (!this.lensSince.has(key)) this.lensSince.set(key, now);
      }
    }
    // A disconnected notebook keeps its selections until it reconnects and says otherwise.
    for (const key of this.lensSince.keys()) {
      const path = key.slice(0, key.indexOf("\0"));
      const f = followed.find((o) => notebookKey(o) === path);
      if (!open.has(key) && (!f || f.connection === "connected")) this.lensSince.delete(key);
    }
    const key = JSON.stringify([followed.map((f) => [notebookKey(f), f.connection, busy(f), kernelStateParts(f), lensParts(f)]), this.pill(now)]);
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.actions.changed();
    }
  }

  private alerting(path: string): boolean {
    const e = this.ended.get(path);
    return !!e && e.failed && e.at > this.dismissedAt && !this.dismissed.has(path) && !this.runs.has(path);
  }

  /** Open Lens selections of a notebook made after the user's last message. */
  private lensNew(f: Followed): number {
    if (f.connection !== "connected") return 0;
    const path = notebookKey(f);
    return f.notebook.lens.selections().filter((s) => (this.lensSince.get(`${path}\0${s.id}`) ?? 0) > this.dismissedAt).length;
  }

  entries(now: number, list: Followed[] = this.actions.followed()): ActivityEntry[] {
    return list.map((f) => {
      const path = notebookKey(f);
      const run = this.runs.get(path);
      const ended = this.ended.get(path);
      const status: ActivityEntry["status"] = run ? "running" : this.alerting(path) ? "failed" : "done";
      const stats = run ? elapsed(now - run.since) : ended ? `${ended.summary} · ${elapsed(now - ended.at)} ago` : f.connection === "connected" ? "idle" : f.connection;
      return {
        key: path,
        stopToken: interruptKey(f),
        label: basename(f.attachment.path),
        detail: [...kernelStateParts(f), ...lensParts(f), ...(run ? (this.actions.drivers?.(f) ?? []).map((name) => `bg ${name}`) : []), ...(this.actions.servers?.(f) ?? []).map((name) => `server ${name}`)].join(" · "),
        status,
        stats,
        startedAt: run?.since ?? (ended ? ended.at - ended.ms : f.notebook.lastActivity),
        ...(run ? {} : { endedAt: ended?.at ?? f.notebook.lastActivity }),
      };
    });
  }

  /**
   * The rows under the prompt, one per notebook this session uses, then those not open anywhere, in
   * file order so they hold still: `○ fit.py  :2718 · idle`, `● fit.py  :2718 · running Model fit  0:12`.
   */
  rows(now: number): ActivityEntry[] {
    const engaged = this.actions.engaged?.() ?? this.actions.followed();
    const followed = this.entries(now, engaged).map((e, i) => {
      const f = engaged[i]!;
      const where = shortWhere(f.attachment.url);
      // The connection and `idle` are already in the detail.
      const stats = e.stats === "idle" || e.stats === f.connection ? "" : e.stats;
      return { path: f.attachment.path, entry: { ...e, detail: [where, e.detail].filter(Boolean).join(" · "), stats } };
    });
    const unopened = (this.actions.unopened?.() ?? []).map((u) => ({
      path: u.path,
      entry: { key: u.key, label: basename(u.path), detail: [u.where, u.state].filter(Boolean).join(" · "), status: "done" as const, stats: "", startedAt: 0 },
    }));
    return [...followed, ...unopened].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((r) => r.entry);
  }

  /** Rows for the notebooks (selectable like tasks and subagents), plus `2 selections` while new ones wait for a reply. */
  pill(now: number): ActivityPill | undefined {
    const rows = this.rows(now);
    const selections = this.actions.followed().reduce((n, f) => n + this.lensNew(f), 0);
    if (!rows.length && !selections) return undefined;
    return { label: selections ? `${selections} selection${selections === 1 ? "" : "s"}` : "", ...(rows.length ? { rows } : {}) };
  }

  /** How the notebook's last run went, for its view: `ran 2m 3s · 1 error · 5m ago`. */
  lastRun(f: Followed, now = Date.now()): string | undefined {
    const ended = this.ended.get(notebookKey(f));
    return ended ? `${ended.summary} · ${elapsed(now - ended.at)} ago` : undefined;
  }

  /** The notebook to open from the pill: a running one, then a failed one, then the current one. */
  busiest(): string | undefined {
    const followed = this.actions.followed();
    const selected = followed.find((f) => this.runs.has(notebookKey(f))) ?? followed.find((f) => this.alerting(notebookKey(f)))
      ?? followed.find((f) => this.lensNew(f) > 0) ?? followed[0];
    return selected ? notebookKey(selected) : undefined;
  }
}
