// Heads-up mode in main's process: when to check, the check itself, the note above main's editor,
// its answers, and what it remembers per repository.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { MainState } from "../main-state.ts";
import { formatTokens } from "../child.ts";
import { git, repoRoot, type Git } from "../quiz/changes.ts";
import { addRecent, knownTopics, markKnown, ProfileStore } from "../quiz/profile.ts";
import { runCheck, type CheckResult, type StreamFn } from "./check.ts";
import { HEADSUP_DEBUG_ENV, HEADSUP_ENTRY, HEADSUP_ENV, headsUpDefault, headsUpFromBranch, HeadsUpStats, type HeadsUpEntry } from "./mode.ts";
import { NoteState, quoteForMain, askSidebar, DISMISSED_MS, type NoteAction } from "./note.ts";
import type { HeadsUpNote } from "./protocol.ts";
import { HeadsUpScheduler, type Trigger } from "./scheduler.ts";

export const HEADSUP_WIDGET = "pi-sidebar-headsup";
/** After this many checks in a row that missed main's cache, checks pause for the session. */
const MAX_MISSES = 2;

export const HEADSUP_HELP = [
  "/sidebar headsup       heads-up mode's state and what its checks cost",
  "/sidebar headsup off   stop heads-up checks in this session (on turns them back on)",
].join("\n");

export interface HeadsUpHost {
  /** Put a note in Sidebar's thread when Sidebar is open; false shows it above main's editor. */
  deliver(note: HeadsUpNote): boolean;
  /** Open Sidebar and ask it this; false when Sidebar cannot open. */
  askSidebar(text: string, ctx: ExtensionContext): boolean;
}

export interface HeadsUpOptions {
  knowledgeDir: string;
  logFile: string;
  run?: Git;
  stream?: StreamFn;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export class HeadsUp {
  on: boolean;
  /** Paused after repeated cache misses, until switched on again. */
  paused: string | undefined;
  readonly stats = new HeadsUpStats();
  readonly scheduler = new HeadsUpScheduler();
  readonly note = new NoteState();
  private misses = 0;
  /** The last note shown, wherever it went (for /known in Sidebar). */
  lastNote: HeadsUpNote | undefined;
  private abort: AbortController | undefined;
  private tui: TUI | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private store: ProfileStore | undefined;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly main: MainState,
    private readonly host: HeadsUpHost,
    private readonly options: HeadsUpOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
    this.env = options.env ?? process.env;
    this.on = headsUpDefault(this.env);

    pi.on("agent_start", () => this.scheduler.runStarted(this.now()));
    pi.on("message_end", (event) => {
      if ((event.message as { role?: string }).role !== "assistant") return;
      if (this.active && this.scheduler.replied(this.now(), !this.note.free)) void this.check("turn");
    });
    pi.on("agent_end", () => {
      if (this.scheduler.ended(this.now(), !this.note.free) && this.active) void this.check("end");
    });
  }

  get active(): boolean {
    return this.on && !this.paused;
  }

  /** The setting restored from main's branch (on unless switched off there, or by the env). */
  restore(branch: readonly unknown[], newSession: boolean): void {
    const entry = headsUpFromBranch(branch);
    this.on = entry ? entry.on : headsUpDefault(this.env);
    this.paused = undefined;
    this.misses = 0;
    this.lastNote = undefined;
    if (newSession) this.stats.reset();
    this.abort?.abort();
    this.hide();
  }

  setOn(on: boolean): HeadsUpEntry {
    this.on = on;
    this.paused = undefined;
    this.misses = 0;
    if (!on) {
      this.abort?.abort();
      this.hide();
    }
    const entry: HeadsUpEntry = { version: 1, on, at: this.now() };
    this.pi.appendEntry(HEADSUP_ENTRY, entry);
    return entry;
  }

  dispose(): void {
    this.abort?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.tui = undefined;
  }

  /** `/sidebar headsup`: whether it is on, and what its checks cost this session. */
  summary(): string {
    const s = this.stats;
    const state = this.paused ? `paused (${this.paused})` : this.on ? "on" : "off";
    const lines = [`Heads-up mode is ${state} in this session.`];
    if (s.checks + s.failed + s.skipped === 0) lines.push("No checks yet: they run during main's longer runs, at most every 3 minutes.");
    else {
      const fresh = s.usage.input + s.usage.cacheWrite;
      lines.push(`${s.checks} check${s.checks === 1 ? "" : "s"}, ${s.notes} note${s.notes === 1 ? "" : "s"}${s.failed ? `, ${s.failed} failed` : ""}${s.skipped ? `, ${s.skipped} skipped` : ""}.`);
      lines.push(`Tokens: ${formatTokens(s.usage.cacheRead)} read from main's cache, ${formatTokens(fresh)} new input, ${formatTokens(s.usage.output)} output.`);
      if (s.lastSkip) lines.push(`Last skip: ${s.lastSkip}.`);
    }
    lines.push(`Turn off for this session with /sidebar headsup off; set ${HEADSUP_ENV}=0 to start sessions with it off.`);
    return lines.join("\n");
  }

  private async profile(cwd: string): Promise<ProfileStore> {
    const root = await repoRoot(cwd, this.options.run ?? git);
    if (!this.store || this.store.root !== root) this.store = new ProfileStore(this.options.knowledgeDir, root);
    return this.store;
  }

  /** One check, now. Exposed for tests. */
  async check(trigger: Trigger): Promise<CheckResult | undefined> {
    const ctx = this.main.ctx;
    if (!ctx || this.scheduler.inFlight) return undefined;
    const now = this.now();
    this.scheduler.started(now);
    const abort = new AbortController();
    this.abort = abort;
    let result: CheckResult;
    try {
      let known: string[] = [];
      let recent: string[] = [];
      try {
        const topics = knownTopics((await this.profile(ctx.cwd)).load(), now);
        known = topics.known;
        recent = topics.recent;
      } catch { /* no memory: the check still runs */ }
      result = await runCheck({
        main: this.main,
        known,
        recent,
        thinking: this.pi.getThinkingLevel(),
        now,
        signal: abort.signal,
        ...(this.options.stream ? { stream: this.options.stream } : {}),
      });
    } catch (error) {
      result = { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
    } finally {
      this.scheduler.finished();
      if (this.abort === abort) this.abort = undefined;
    }
    if (abort.signal.aborted) return result;
    this.stats.record(result.outcome, "usage" in result ? result.usage : undefined, "reason" in result ? result.reason : undefined);
    this.log(trigger, result);
    if (result.outcome === "note" || result.outcome === "none") {
      this.misses = result.missed ? this.misses + 1 : 0;
      if (this.misses >= MAX_MISSES) {
        this.paused = "its checks missed main's prompt cache";
        ctx.ui.notify("Heads-up checks paused: the last ones missed main's prompt cache. /sidebar headsup on resumes them.", "warning");
      }
    }
    if (result.outcome === "note" && result.note && this.on && this.note.free) {
      const note = result.note;
      try { (await this.profile(ctx.cwd)).update((p) => addRecent(p, { id: note.topic, text: note.text, at: now })); } catch { /* not remembered */ }
      this.lastNote = note;
      if (!this.host.deliver(note)) this.show(note, ctx);
    }
    return result;
  }

  /** `/known` in Sidebar: the last note's topic is one the user knows. */
  async markLastKnown(): Promise<HeadsUpNote | undefined> {
    const ctx = this.main.ctx;
    const note = this.lastNote;
    if (!ctx || !note) return undefined;
    (await this.profile(ctx.cwd)).update((p) => markKnown(p, { id: note.topic, text: note.text, at: this.now() }));
    if (this.note.note === note) this.hide();
    return note;
  }

  private log(trigger: Trigger, result: CheckResult): void {
    if (this.env[HEADSUP_DEBUG_ENV] !== "1") return;
    try {
      mkdirSync(path.dirname(this.options.logFile), { recursive: true });
      appendFileSync(this.options.logFile, `${JSON.stringify({ at: new Date(this.now()).toISOString(), trigger, expected: this.main.promptTokens(), ...result })}\n`);
    } catch { /* debugging only */ }
  }

  private show(note: HeadsUpNote, ctx: ExtensionContext): void {
    this.note.show(note);
    this.mount(ctx);
  }

  private mount(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    try {
      ctx.ui.setWidget(
        HEADSUP_WIDGET,
        (tui, theme) => {
          this.tui = tui;
          return { render: (width: number) => this.note.lines(width, theme), invalidate() {} };
        },
        { placement: "aboveEditor" },
      );
    } catch { /* no widget: the note is lost */ }
  }

  hide(): void {
    this.note.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try { this.main.ctx?.ui.setWidget(HEADSUP_WIDGET, undefined); } catch { /* already gone */ }
  }

  /**
   * A key typed into main while a note shows. `editorIdle` says main's own editor has focus and is
   * empty (no dialog, no Sidebar focus). Only the digits on screen are taken.
   */
  handleKey(data: string, editorIdle: boolean): boolean {
    if (!editorIdle) return false;
    const action = this.note.action(data);
    if (!action) return false;
    void this.act(action);
    return true;
  }

  private async act(action: NoteAction): Promise<void> {
    const ctx = this.main.ctx;
    const note = this.note.note;
    if (!ctx || !note) return;
    const now = this.now();
    this.note.apply(action, now);
    if (action.type === "known") {
      try { (await this.profile(ctx.cwd)).update((p) => markKnown(p, { id: note.topic, text: note.text, at: now })); } catch { /* not remembered */ }
    } else if (action.type === "ask-main") {
      ctx.ui.setEditorText(quoteForMain(note));
    } else if (action.type === "ask-sidebar") {
      if (!this.host.askSidebar(askSidebar(note), ctx)) ctx.ui.setEditorText(quoteForMain(note));
    } else if (action.type === "turn-off") {
      this.setOn(false);
      ctx.ui.notify("Heads-up mode is off for this session. /sidebar headsup on turns it back on.", "info");
    }
    if (!this.note.showing) return this.hide();
    if (this.note.phase === "dismissed") {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (this.note.expired(this.now())) this.hide();
      }, DISMISSED_MS);
      this.timer.unref?.();
    }
    this.tui?.requestRender();
  }
}
