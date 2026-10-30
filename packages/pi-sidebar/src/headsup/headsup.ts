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
import { runCheck, type CheckResult, type ForeignCheck, type StreamFn } from "./check.ts";
import { TranscriptParts } from "../foreign.ts";
import { modelKey, type ModelChoice, type ModelLike } from "../models.ts";
import { HEADSUP_DEBUG_ENV, HEADSUP_ENTRY, HEADSUP_ENV, headsUpDefault, headsUpFromBranch, HeadsUpStats, type HeadsUpEntry } from "./mode.ts";
import { proseMeasure, NoteState, quoteForMain, askSidebar, DISMISSED_MS, type NoteAction } from "./note.ts";
import type { HeadsUpNote } from "./protocol.ts";
import { HeadsUpScheduler, type Trigger } from "./scheduler.ts";
import { postToBluesky, type FetchFn, type Posted } from "../share/bluesky.ts";
import { shareConfig, shareEnabled, shareSummary, type ShareConfig } from "../share/config.ts";
import { draftFromReply, saveDraft, sidebarDraftPrompt, writeDraft, type Draft, type DraftKind, type DraftResult, type SaveOptions } from "../share/draft.ts";

export const HEADSUP_WIDGET = "pi-sidebar-headsup";
/** After this many checks in a row that missed main's cache, checks pause for the session. */
const MAX_MISSES = 2;

export const HEADSUP_HELP = [
  "/sidebar headsup       heads-up mode's state and what its checks cost",
  "/sidebar headsup off   stop heads-up checks in this session (on turns them back on)",
].join("\n");

/** `on` or `off` as a change of setting. */
export function headsUpChange(arg: string): { on: boolean } | undefined {
  if (arg === "on") return { on: true };
  if (arg === "off") return { on: false };
  return undefined;
}

export function headsUpChanged(change: { on: boolean }): string {
  return change.on
    ? "Heads-up mode is on for this session; notes show above main's editor, and in Sidebar's thread once Sidebar has been started."
    : "Heads-up mode is off for this session.";
}

export interface HeadsUpHost {
  /**
   * Also put the note in Sidebar's thread, but only once Sidebar has been started in this session
   * (never start it for a note: that would cost tokens nobody asked for).
   */
  deliver(note: HeadsUpNote): void;
  /** Open Sidebar and ask it this; false when Sidebar cannot open. */
  askSidebar(text: string, ctx: ExtensionContext): boolean;
  /** Sidebar's model: checks run on it too (main's, sharing main's cache, unless another is chosen). */
  model?(): ModelChoice;
  /** A dialog (a plan's approval, a question) has main's focus: the note stays out of its way. */
  dialogOpen?(): boolean;
  /** Sidebar is open beside main: it already shows the note in its thread, so main's copy is hidden. */
  sidebarOpen?(): boolean;
  /** A blog draft was written and saved: Sidebar's thread can carry it for follow-up edits. */
  draftWritten?(note: HeadsUpNote, draft: Draft, location: string): void;
  /**
   * Ask Sidebar's agent (which can call tools, unlike a side request) and resolve with the final
   * assistant text of that turn. `label` says what is being written, for Sidebar's thread. Rejects
   * when Sidebar cannot take the request now.
   */
  writeWithSidebar?(prompt: string, label: string): Promise<string>;
  /**
   * A draft written through `writeWithSidebar` was saved (`location`) or came to nothing (`error`):
   * the exchange is already in Sidebar's thread, so this is only a line saying how it ended.
   */
  draftSaved?(outcome: { location: string } | { error: string }): void;
}

/** A check's cache lifetime when the request did not say (Anthropic's and OpenAI's default). */
const DEFAULT_TTL_MS = 5 * 60_000;
/** Checks within this margin of the TTL count as cold. */
const COLD_MARGIN_MS = 20_000;

export interface HeadsUpOptions {
  knowledgeDir: string;
  logFile: string;
  run?: Git;
  stream?: StreamFn;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Share destinations (default: from the environment). */
  share?: ShareConfig;
  fetch?: FetchFn;
  save?: SaveOptions;
}

export class HeadsUp {
  on: boolean;
  /** Paused after repeated cache misses, until switched on again. */
  paused: string | undefined;
  readonly stats = new HeadsUpStats();
  readonly scheduler = new HeadsUpScheduler();
  readonly note = new NoteState();
  private misses = 0;
  /** Checks on another model read main's session as a transcript with a cache of their own. */
  private readonly parts = new TranscriptParts();
  private lastForeign: { at: number; model: string; ttl: number } | undefined;
  /** The last note shown, wherever it went (for /known in Sidebar). */
  lastNote: HeadsUpNote | undefined;
  private abort: AbortController | undefined;
  private tui: TUI | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private store: ProfileStore | undefined;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  /** Where share notes can go. */
  readonly share: ShareConfig;
  /** A share action (post or draft) in progress. */
  private sharing = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly main: MainState,
    private readonly host: HeadsUpHost,
    private readonly options: HeadsUpOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
    this.env = options.env ?? process.env;
    this.on = headsUpDefault(this.env);
    this.share = options.share ?? shareConfig(this.env);

    pi.on("agent_start", () => this.scheduler.runStarted(this.now()));
    pi.on("message_end", (event) => {
      if ((event.message as { role?: string }).role !== "assistant") return;
      if (this.active && this.scheduler.replied(this.now(), !this.note.free)) void this.check("turn");
    });
    pi.on("agent_end", () => {
      if (this.scheduler.ended(this.now(), !this.note.free) && this.active) void this.check("end");
    });
    // Pi stacks widgets above the editor in the order they were set, so one a tool adds while the
    // note shows (pi-todo's task list) lands below it. Mount the note again afterwards to stay last.
    pi.on("tool_execution_end", (_event, ctx) => {
      if (!this.note.showing) return;
      const timer = setTimeout(() => { if (this.note.showing) this.mount(this.main.ctx ?? ctx); }, 0);
      timer.unref?.();
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
    const choice = this.host.model?.();
    if (choice?.kind === "other") lines.push(`Checks run on ${choice.label}, which reads main's session as a transcript and keeps its own cache.`);
    else if (choice?.kind === "unavailable") lines.push(`Sidebar's model ${choice.pattern} matches no model you are logged in to, so checks are skipped.`);
    if (s.checks + s.failed + s.skipped === 0) lines.push("No checks yet: they run during main's longer runs, at most every 3 minutes.");
    else {
      const fresh = s.usage.input + s.usage.cacheWrite;
      lines.push(`${s.checks} check${s.checks === 1 ? "" : "s"}, ${s.notes} note${s.notes === 1 ? "" : "s"}${s.failed ? `, ${s.failed} failed` : ""}${s.skipped ? `, ${s.skipped} skipped` : ""}.`);
      lines.push(`Tokens: ${formatTokens(s.usage.cacheRead)} read from the cache, ${formatTokens(fresh)} new input, ${formatTokens(s.usage.output)} output.`);
      if (s.lastSkip) lines.push(`Last skip: ${s.lastSkip}.`);
    }
    lines.push(shareSummary(this.share));
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
      const choice = this.host.model?.() ?? { kind: "same" as const };
      if (choice.kind === "unavailable") {
        result = { outcome: "skipped", reason: `Sidebar's model ${choice.pattern} matches no model you are logged in to` };
      } else {
        const foreign = choice.kind === "other" ? this.foreign(choice.model, choice.label, choice.thinking, now) : undefined;
        result = await runCheck({
          main: this.main,
          known,
          recent,
          thinking: this.pi.getThinkingLevel(),
          now,
          signal: abort.signal,
          ...(this.options.stream ? { stream: this.options.stream } : {}),
          ...(foreign ? { foreign } : {}),
          share: shareEnabled(this.share),
          ...(this.share.taste ? { taste: this.share.taste } : {}),
        });
        // A share note the check was not asked for (sharing is off) is not shown.
        if (result.outcome === "note" && result.note?.kind === "share" && !shareEnabled(this.share)) result = { ...result, outcome: "none" };
        if (!foreign) this.lastForeign = undefined;
        else if (result.outcome === "note" || result.outcome === "none") {
          this.lastForeign = { at: now, model: modelKey(foreign.model), ttl: result.cacheTtlMs ?? DEFAULT_TTL_MS };
        }
      }
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
        const which = this.lastForeign ? "their model's own prompt cache" : "main's prompt cache";
        this.paused = `its checks missed ${which}`;
        ctx.ui.notify(`Heads-up checks paused: the last ones missed ${which}. /sidebar headsup on resumes them.`, "warning");
      }
    }
    if (result.outcome === "note" && result.note && this.on && this.note.free) {
      const note = result.note;
      try { (await this.profile(ctx.cwd)).update((p) => addRecent(p, { id: note.topic, text: note.text, at: now })); } catch { /* not remembered */ }
      this.lastNote = note;
      this.show(note, ctx);
      this.host.deliver(note);
    }
    return result;
  }

  private foreign(model: ModelLike, label: string, thinking: string | undefined, now: number): ForeignCheck {
    const last = this.lastForeign;
    const warm = !!last && last.model === modelKey(model) && now - last.at < last.ttl - COLD_MARGIN_MS;
    return { model, label, ...(thinking ? { thinking } : {}), parts: this.parts, warm };
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

  /** Which share destinations the note may offer. */
  get targets(): { bluesky: boolean; drafts: boolean } {
    return { bluesky: !!this.share.bluesky, drafts: !!this.share.drafts };
  }

  /** The last share note shown, for /post and /draft in Sidebar. */
  get lastShare(): HeadsUpNote | undefined {
    return this.lastNote?.kind === "share" ? this.lastNote : undefined;
  }

  /** Publish a post on Bluesky; the note's topic is then known (not suggested again). */
  async publish(text: string, note?: HeadsUpNote): Promise<Posted> {
    if (!this.share.bluesky) throw new Error("Bluesky is not configured");
    const posted = await postToBluesky(text, this.share.bluesky, { ...(this.options.fetch ? { fetch: this.options.fetch } : {}), now: this.now() });
    if (note) await this.remember(note);
    return posted;
  }

  /** Write a blog draft (or outline) from a share note and save it; returns where it went. */
  async draft(note: HeadsUpNote, kind: DraftKind): Promise<{ draft: Draft; location: string }> {
    const drafts = this.share.drafts;
    const ctx = this.main.ctx;
    if (!drafts) throw new Error("no drafts destination is configured");
    if (!ctx) throw new Error("main's session is not ready");
    const now = this.now();
    const choice = this.host.model?.() ?? { kind: "same" as const };
    if (choice.kind === "unavailable") throw new Error(`Sidebar's model ${choice.pattern} matches no model you are logged in to`);
    // With an examples tool, the draft runs through Sidebar's agent (a side request cannot call it).
    const examplesTool = this.share.examplesTool;
    const writeWithSidebar = examplesTool ? this.host.writeWithSidebar?.bind(this.host) : undefined;
    // Sidebar's thread already holds that exchange, so only how it ended is told there.
    const ended = (outcome: { location: string } | { error: string }) => { if (writeWithSidebar) this.host.draftSaved?.(outcome); };
    let result: DraftResult;
    if (examplesTool && writeWithSidebar) {
      const prompt = sidebarDraftPrompt(note, kind, this.share.style, examplesTool, this.share.examplesArgs);
      result = draftFromReply(await writeWithSidebar(prompt, `Writing a blog ${kind === "full" ? "draft" : "outline"}: ${note.text}`), note, kind);
    } else {
      const foreign = choice.kind === "other" ? this.foreign(choice.model, choice.label, choice.thinking, now) : undefined;
      result = await writeDraft(note, kind, {
        main: this.main,
        thinking: this.pi.getThinkingLevel(),
        now,
        ...(this.options.stream ? { stream: this.options.stream } : {}),
        ...(foreign ? { foreign } : {}),
        ...(this.share.style ? { style: this.share.style } : {}),
      });
    }
    if (!result.ok) {
      const error = `the draft was not written: ${result.reason}`;
      ended({ error });
      throw new Error(error);
    }
    let repo: string | undefined;
    try { repo = path.basename((await this.profile(ctx.cwd)).root); } catch { /* no repository */ }
    const date = new Date(now).toISOString().slice(0, 10);
    let location: string;
    try {
      location = await saveDraft(result.draft, { date, topic: note.topic, ...(repo ? { repo } : {}) }, drafts, { ...this.options.save, env: this.options.save?.env ?? this.env });
    } catch (error) {
      ended({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    await this.remember(note);
    if (writeWithSidebar) ended({ location });
    else this.host.draftWritten?.(note, result.draft, location);
    return { draft: result.draft, location };
  }

  private async remember(note: HeadsUpNote): Promise<void> {
    const ctx = this.main.ctx;
    if (!ctx) return;
    try { (await this.profile(ctx.cwd)).update((p) => markKnown(p, { id: note.topic, text: note.text, at: this.now() })); } catch { /* not remembered */ }
  }

  private show(note: HeadsUpNote, ctx: ExtensionContext): void {
    this.note.show(note, this.targets);
    this.mount(ctx);
  }

  private mount(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    try {
      ctx.ui.setWidget(
        HEADSUP_WIDGET,
        (tui, theme) => {
          this.tui = tui;
          return { render: (width: number) => this.host.dialogOpen?.() || this.host.sidebarOpen?.() ? [] : this.note.lines(width, theme, proseMeasure()), invalidate() {} };
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
    if (!editorIdle || this.host.sidebarOpen?.()) return false;
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
    } else if (action.type === "edit-post") {
      const edited = await ctx.ui.editor("Edit the Bluesky post", this.note.post);
      if (edited !== undefined && this.note.note === note) this.note.post = edited.trim();
    } else if (action.type === "publish" || action.type === "draft") {
      if (this.sharing) return;
      this.sharing = true;
      const text = this.note.post;
      this.note.setBusy(action.type === "publish" ? "Posting to Bluesky…" : `Writing a blog ${action.kind === "full" ? "draft" : "outline"}…`);
      this.tui?.requestRender();
      try {
        if (action.type === "publish") {
          const posted = await this.publish(text, note);
          ctx.ui.notify(`Posted to Bluesky: ${posted.url}`, "info");
        } else {
          const { location } = await this.draft(note, action.kind);
          ctx.ui.notify(`Blog ${action.kind === "full" ? "draft" : "outline"} saved: ${location}`, "info");
        }
        if (this.note.note === note) this.hide();
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        // Back to where it was, so the user can retry, edit or discard.
        if (this.note.note === note) this.note.phase = action.type === "publish" ? "post" : "note";
      } finally {
        this.sharing = false;
      }
      this.tui?.requestRender();
      return;
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
