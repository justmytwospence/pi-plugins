// The kernel hold: the stretch after the agent's turn ends while a cell it
// started is still running. It begins when a turn ends with a notebook the agent
// worked in during that turn busy (a cell running or queued), and ends when
// every held notebook is quiet, disconnected or no longer followed, or when the
// next turn begins. The hosts show it in herdr; this file only decides it.

import { basename } from "./io.js";
import { truncate } from "./notebook.js";
import { elapsed } from "./render.js";
import type { Followed } from "./watcher.js";

/** The herdr pane token the ports report while the kernel holds (`$marimo` in a sidebar row). */
export const HERDR_TOKEN = "marimo";
/** The herdr metadata source the ports report under. */
export const HERDR_SOURCE = "marimo";

export type HoldChange =
  | { kind: "none" }
  /** The hold began, or what it shows changed. */
  | { kind: "held"; value: string }
  /** The hold ended because the kernel went quiet; what to tell the user. */
  | { kind: "finished"; title: string; body: string }
  /** The hold ended without the kernel finishing (a new turn, the session ending). */
  | { kind: "released" };

const NONE: HoldChange = { kind: "none" };

export function busy(f: Followed): boolean {
  return f.connection === "connected" && (f.notebook.running() !== undefined || f.notebook.queued() > 0);
}

/** What the pane token says: `fit.py: Model fit`, `fit.py: cell train`, or `fit.py: 3 queued`. */
export function holdValue(f: Followed): string {
  const file = basename(f.attachment.path);
  const run = f.notebook.running();
  if (!run) return `${file}: ${f.notebook.queued()} queued`;
  const where = run.section[run.section.length - 1] ?? `cell ${run.cell.name !== "_" ? run.cell.name : run.cell.id}`;
  return truncate(`${file}: ${where}`, 80);
}

export class KernelHold {
  private turnStartedAt: number | undefined;
  private held = new Set<string>();
  private since = 0;
  private last: string | undefined;

  get active(): boolean {
    return this.held.size > 0;
  }

  /** The notebooks held, by path. */
  get paths(): string[] {
    return [...this.held];
  }

  /** A turn began: the agent is working again, so any hold ends. */
  begin(now: number): HoldChange {
    this.turnStartedAt = now;
    return this.release();
  }

  /** The turn ended: hold the busy notebooks the agent worked in during it. */
  end(followed: Followed[], now: number): HoldChange {
    const startedAt = this.turnStartedAt;
    this.turnStartedAt = undefined;
    if (startedAt === undefined || this.active) return NONE;
    for (const f of followed) if (f.touchedAt >= startedAt && busy(f)) this.held.add(f.attachment.path);
    if (!this.active) return NONE;
    this.since = now;
    return this.update(followed, now);
  }

  /** After a notebook changed: what the hold shows now, or that it finished. */
  update(followed: Followed[], now: number): HoldChange {
    if (!this.active) return NONE;
    const held = followed.filter((f) => this.held.has(f.attachment.path));
    const running = held.filter(busy);
    if (!running.length) {
      this.held.clear();
      this.last = undefined;
      const files = held.length ? held.map((f) => basename(f.attachment.path)).join(", ") : "notebook";
      const errors = held.reduce((n, f) => n + (f.connection === "connected" ? f.notebook.errors().length : 0), 0);
      const gone = held.length < 1 || held.some((f) => f.connection !== "connected");
      const parts = [`ran ${elapsed(now - this.since)}`];
      if (errors) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
      if (gone) parts.push("disconnected");
      return { kind: "finished", title: truncate(`${files} ${gone ? "stopped" : "finished"}`, 80), body: parts.join(" · ") };
    }
    const value = holdValue(running[0]!);
    if (value === this.last) return NONE;
    this.last = value;
    return { kind: "held", value };
  }

  /** Stop holding without a notice. */
  release(): HoldChange {
    if (!this.active) return NONE;
    this.held.clear();
    this.last = undefined;
    return { kind: "released" };
  }
}
