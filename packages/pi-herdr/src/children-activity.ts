// This session's herdr children as a source of background work (activity.ts), like pi-bg's shells
// and pi-subagents' runs: rows in pi-bg's `/tasks` view tagged `child`, a pill (`1 child`) at the
// end of pi-subagents' list under the prompt while a child works on a turn this session asked for.
//
// What the rows allow is deliberately narrow. A child is an interactive, human-led session in a
// pane of its own: Enter opens read-only details (its task, where it runs, its status and last reply
// or screen) and never focuses or raises its pane; `x` only interrupts an awaited turn (Escape in
// its pane, as action=interrupt does), and only while one is awaited; nothing here closes a pane.
// Ended rows (closed, or idle after replying) can be dismissed from the list.
import { randomUUID } from "node:crypto";
import { type Component, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type ActivityEntry, type ActivityPill, type ActivitySection, INPUT_CONTEXT } from "./activity.ts";
import type { ChildRecord, Children } from "./core/children.ts";

export const CHILDREN_SOURCE_ID = "herdr";

export interface ChildrenActivityDeps {
  /** Something shown changed: whoever shows the source should redraw. */
  changed(): void;
  now?: () => number;
  isCurrent?(): boolean;
}

interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

type TuiLike = { requestRender(): void; terminal: { rows: number } };

/** One child's record, for the details view: the record, plus what `read` says when it answers. */
export interface ChildDetailsSource {
  record(): ChildRecord | undefined;
  /** `children.read`: the last reply or the screen; rejects when herdr cannot be reached. */
  read(): Promise<string>;
}

const where = (rec: ChildRecord) => (rec.where === "worktree" && rec.branch ? `worktree ${rec.branch}` : rec.where);

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}h${String(m % 60).padStart(2, "0")}m` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Read-only details of one child, full screen: Esc, q, h or ← closes; ↑↓ scroll. Nothing here touches its pane. */
export class ChildDetails implements Component {
  private scroll = 0;
  private body: string[] = [];
  private closed = false;
  private loadId = 0;
  private lineCount = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: TuiLike,
    private readonly theme: Theme,
    private readonly source: ChildDetailsSource,
    private readonly done: () => void,
  ) {
    this.body = ["(reading…)"];
    void this.load();
    this.timer = setInterval(() => {
      if (!this.closed) this.tui.requestRender();
    }, 1_000);
    this.timer.unref?.();
  }

  /** Read-only scrolling content: global listeners leave its keys alone. */
  [INPUT_CONTEXT](): "viewer" {
    return "viewer";
  }

  private async load() {
    const id = ++this.loadId;
    let text: string;
    try {
      text = await this.source.read();
    } catch (error) {
      text = `(could not read: ${error instanceof Error ? error.message : String(error)})`;
    }
    if (this.closed || id !== this.loadId) return;
    this.body = text.split("\n");
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q") || matchesKey(data, "h") || matchesKey(data, "left")) {
      if (this.closed) return;
      this.dispose();
      this.done();
      return;
    }
    if (this.closed) return;
    const page = this.viewport();
    const half = Math.max(1, Math.floor(page / 2));
    const max = Math.max(0, this.lineCount - page);
    this.scroll = Math.min(this.scroll, max);
    if (matchesKey(data, "up") || matchesKey(data, "k")) this.scroll = Math.max(0, this.scroll - 1);
    else if (matchesKey(data, "down") || matchesKey(data, "j")) this.scroll = Math.min(max, this.scroll + 1);
    else if (matchesKey(data, "ctrl+u")) this.scroll = Math.max(0, this.scroll - half);
    else if (matchesKey(data, "ctrl+d")) this.scroll = Math.min(max, this.scroll + half);
    else if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - page);
    else if (matchesKey(data, "pageDown")) this.scroll = Math.min(max, this.scroll + page);
    else if (matchesKey(data, "home")) this.scroll = 0;
    else if (matchesKey(data, "end")) this.scroll = max;
    else if (matchesKey(data, "r")) void this.load();
    else return;
    this.tui.requestRender();
  }

  private viewport(): number {
    return Math.max(1, this.tui.terminal.rows - 7);
  }

  render(width: number): string[] {
    if (width < 12) return [];
    const th = this.theme;
    const inner = width - 4;
    const row = (s: string) => `${th.fg("accent", "│")} ${truncateToWidth(s, inner, "…", true)} ${th.fg("accent", "│")}`;
    const rule = row(th.fg("dim", "─".repeat(inner)));
    const rec = this.source.record();
    const title = ` ◀ esc · herdr child ${rec?.name ?? ""} · read-only `;
    const out = [th.fg("accent", `╭─${th.bold(truncateToWidth(title, Math.max(4, width - 3)))}${"─".repeat(Math.max(0, width - 3 - title.length))}╮`)];
    if (!rec) {
      out.push(row(th.fg("dim", "This child is no longer known.")));
    } else {
      const status = rec.closed ? "closed" : rec.awaiting ? "working on a turn this session asked for" : "idle";
      out.push(row(`${th.bold(rec.name)}  ${th.fg("muted", `${where(rec)} · pane ${rec.paneId} · ${status}`)}`));
      out.push(row(th.fg("dim", `${rec.cwd}${rec.model ? ` · ${rec.model}` : ""}${rec.thinking ? ` · ${rec.thinking}` : ""}${rec.session ? ` · ${rec.session}` : ""}`)));
    }
    out.push(rule);
    const lines: string[] = [];
    if (rec) {
      lines.push(th.fg("accent", "Task"));
      for (const l of rec.task.split("\n")) lines.push(...wrapTextWithAnsi(l, inner));
      lines.push("");
    }
    for (const l of this.body) lines.push(...wrapTextWithAnsi(l, inner));
    this.lineCount = lines.length;
    const page = this.viewport();
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, lines.length - page)));
    for (let i = 0; i < page; i++) out.push(row(lines[this.scroll + i] ?? ""));
    out.push(rule);
    out.push(row(th.fg("dim", "Ctrl-U/D half-page · j/k scroll · r reread · esc back · read-only")));
    out.push(th.fg("accent", `╰${"─".repeat(width - 2)}╯`));
    return out;
  }

  invalidate(): void {}

  dispose(): void {
    this.closed = true;
    clearInterval(this.timer);
  }
}

/** The children as an activity source. `observe` is called with every saved record (the persist hook). */
export class ChildrenActivity {
  section: ActivitySection;
  private readonly hosts = new Set<string>();
  private readonly dismissed = new Set<string>();
  /** Pre-turnId records still need an identity that changes when restoration replaces them. */
  private readonly legacyStopTokens = new WeakMap<ChildRecord, string>();
  /** When each child's awaited turn started and ended, by name. */
  private readonly turns = new Map<string, { startedAt: number; endedAt?: number; token?: string }>();
  private lastKey = "";
  private generation = 0;
  private active = true;

  constructor(
    private readonly children: Pick<Children, "records" | "interrupt" | "read">,
    private readonly deps: ChildrenActivityDeps,
  ) {
    this.section = this.createSection();
  }

  private createSection(): ActivitySection {
    const generation = this.generation;
    const current = () => generation === this.generation && this.current();
    return {
      id: CHILDREN_SOURCE_ID,
      title: "herdr children",
      noun: "child",
      entries: (now) => current() ? this.entries(now) : [],
      open: (key, ui) => this.open(key, ui, current),
      stop: (key) => {
        const rec = this.children.records.get(key);
        // Interrupt only a turn this session asked for; never close the pane.
        if (current() && rec?.awaiting && !rec.closed) return this.children.interrupt(rec.name).then(() => undefined);
      },
      canStop: (key) => {
        const rec = this.children.records.get(key);
        return current() && Boolean(rec?.awaiting && !rec.closed);
      },
      dismiss: (key) => {
        const rec = this.children.records.get(key);
        if (!current() || !rec || (rec.awaiting && !rec.closed)) return;
        this.dismissed.add(key);
        this.deps.changed();
      },
      pill: (now) => current() ? this.pill(now) : undefined,
      openDialog: (ui) => {
        if (!current()) return Promise.resolve();
        const first = [...this.children.records.values()].find((r) => r.awaiting && !r.closed) ?? [...this.children.records.values()].find((r) => !this.dismissed.has(r.name));
        return first ? this.open(first.name, ui, current) : Promise.resolve();
      },
      setHosted: (on, host) => {
        if (!current()) return;
        if (on) this.hosts.add(host ?? "subagents");
        else this.hosts.delete(host ?? "subagents");
      },
    };
  }

  get hosted(): boolean {
    return this.hosts.size > 0;
  }

  resetHosts(): void {
    this.hosts.clear();
  }

  /** Only a live generation may be offered to hosts. */
  get available(): boolean {
    return this.current();
  }

  private current(): boolean {
    return this.active && this.deps.isCurrent?.() !== false;
  }

  /** Retained host references must never target a later branch or runtime. */
  dispose(): void {
    this.active = false;
    this.generation++;
    this.resetHosts();
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** A record was saved (spawned, prompted, replied, closed): track its turn and tell the hosts when something shown changed. */
  observe(rec: ChildRecord): void {
    if (!this.active) return;
    const turn = this.turns.get(rec.name);
    if (rec.awaiting && !rec.closed) {
      const token = this.stopToken(rec);
      if (!turn || turn.endedAt !== undefined || turn.token !== token) this.turns.set(rec.name, { startedAt: this.now(), token });
      this.dismissed.delete(rec.name);
    } else if (turn && turn.endedAt === undefined) turn.endedAt = this.now();
    this.refresh();
  }

  /** Restored records: awaited ones count from now (their start is unknown). */
  restored(): void {
    this.dispose();
    this.active = true;
    this.section = this.createSection();
    this.turns.clear();
    this.dismissed.clear();
    this.lastKey = "";
    for (const rec of this.children.records.values()) this.observe(rec);
  }

  private stopToken(rec: ChildRecord): string {
    if (rec.turnId) return rec.turnId;
    let token = this.legacyStopTokens.get(rec);
    if (!token) { token = randomUUID(); this.legacyStopTokens.set(rec, token); }
    return token;
  }

  refresh(): void {
    if (!this.active) return;
    const key = JSON.stringify([...this.children.records.values()].map((r) => [r.name, r.paneId, r.awaiting, r.closed, r.awaiting && !r.closed ? this.stopToken(r) : undefined, this.dismissed.has(r.name)]));
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.deps.changed();
  }

  entries(now: number): ActivityEntry[] {
    const rows: ActivityEntry[] = [];
    if (!this.current()) return rows;
    for (const rec of this.children.records.values()) {
      if (this.dismissed.has(rec.name)) continue;
      const turn = this.turns.get(rec.name);
      const running = rec.awaiting && !rec.closed;
      const status: ActivityEntry["status"] = running ? "running" : rec.closed ? "stopped" : "done";
      const startedAt = turn?.startedAt ?? rec.createdAt;
      const endedAt = running ? undefined : (turn?.endedAt ?? rec.createdAt);
      const stats = running ? `turn · ${elapsed(now - startedAt)}` : rec.closed ? "closed" : turn?.endedAt ? `replied · ${elapsed(now - turn.endedAt)} ago` : "idle";
      rows.push({
        key: rec.name,
        label: rec.name,
        detail: `${where(rec)} · pane ${rec.paneId} · ${rec.task.replace(/\s+/gu, " ").trim()}`,
        status,
        stats,
        startedAt,
        ...(running ? { stopToken: this.stopToken(rec) } : {}),
        ...(endedAt !== undefined ? { endedAt } : {}),
      });
    }
    return rows;
  }

  pill(now: number): ActivityPill | undefined {
    void now;
    if (!this.current()) return undefined;
    const running = [...this.children.records.values()].filter((r) => r.awaiting && !r.closed).length;
    return running ? { label: `${running} child${running === 1 ? "" : "ren"}` } : undefined;
  }

  private open(key: string, ui: unknown, current: () => boolean): Promise<void> {
    const u = ui as { custom?<T>(factory: (tui: TuiLike, theme: Theme, keybindings: unknown, done: (r: T) => void) => Component, options?: unknown): Promise<T> };
    const rec = this.children.records.get(key);
    if (!current() || typeof u?.custom !== "function" || !rec) return Promise.resolve();
    const known = () => current() && this.children.records.get(key) === rec;
    const source: ChildDetailsSource = {
      record: () => known() ? rec : undefined,
      read: () => known() ? this.children.read(key) : Promise.resolve("This child's owning session or branch is no longer current."),
    };
    return u.custom<void>((tui, theme, _kb, done) => new ChildDetails(tui, theme, source, () => done(undefined)), {
      overlay: true,
      overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
    });
  }
}
