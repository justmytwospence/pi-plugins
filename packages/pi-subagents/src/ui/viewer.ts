// A subagent's session, shown the way Pi shows main's: Pi's own message and tool components
// (PiChat), Pi's working row, queued steers as Pi shows queued messages, your editor (pi-vim's
// when loaded) with pi-status-footer's context gauge, the subagent list main shows under its prompt,
// and your footer, all for the child. Pi hosts one live session, and subagents are separate
// processes, so this is what Claude Code and Codex do too: main's chrome redrawn for another
// thread. Tab and Shift+Tab (or Ctrl+J and Ctrl+K) switch to the next or previous session (main closes the view), Esc
// returns to main, and ↓ at the editor's bottom enters the list. Typing steers a running child;
// Ctrl+C twice on an empty editor stops it.
// Adapted from tintinweb/pi-subagents (MIT): https://github.com/tintinweb/pi-subagents
import { keyText } from "@earendil-works/pi-coding-agent";
import { compositeTuiLine, getKeybindings, Editor, Loader, type Component, type EditorTheme, type Focusable, type OverlayHandle, type TUI, type TuiMouseEvent, type TuiMouseEventResult, isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { leavesPromptDown, type ActivitySection } from "../activity.ts";
import { contextTokens, type Conversation } from "../conversation.ts";
import { type EditorModeContext, type EmbeddedEditor, type EditorFactoryOptions, type SuiteEditor, EDITOR_MODE, EDITOR_SURFACE, INPUT_CONTEXT, readEditorMode, requestEditorFactory } from "../editor-contract.ts";
import { discoverFamily, type FamilyService } from "../family-contract.ts";
import { runLabel } from "../label.ts";
import type { Run } from "../run.ts";
import { type FleetEntry, fleetRoster, renderFleet } from "./fleet.ts";
import { type Theme, formatCost, formatCount, statusIcon } from "./format.ts";
import { PiChat } from "./pi-chat.ts";

/** Share of the terminal height the view takes: all of it, as main's screen does. */
export const VIEWER_HEIGHT_PCT = 100;

export interface ViewerActions {
  /** Send a steering message; false when the run can no longer be steered. */
  steer?: (message: string) => boolean;
  stop?: () => void | Promise<void>;
  /** Move a foreground run's tool call to the background, so the main agent can go on. */
  background?: () => void;
  canBackground?: () => boolean;
  /** pi's event bus: the suite's editor, working stats and footer are requested over it. */
  events?: { emit(channel: string, data: unknown): void };
}

/** What the view switches between and draws around a session: FleetView's source, plus Pi's settings. */
export interface SessionSource {
  /** Optional composition host, discovered in the current runtime. */
  family?(): FamilyService | undefined;
  runs(): readonly Run[];
  actions(run: Run): ViewerActions;
  /** Whether the list under the editor shows (FleetView's setting). */
  enabled?(): boolean;
  sections?(): readonly ActivitySection[];
  dismissedAt?(): number;
  dismissed?(): ReadonlySet<string>;
  dismiss?(runId: string): void | Promise<void>;
  /** The context window of `provider/model`, for the footer's context share. */
  contextWindow?(model: string): number | undefined;
  /** Main's `hideThinkingBlock` and `editorPaddingX`. */
  settings?(): { hideThinkingBlock?: boolean; editorPaddingX?: number };
  /** The view moved to another run. */
  onSwitch?(run: Run): void;
}

/** Pi's KeybindingsManager, structurally. */
export interface Keybindings {
  matches(data: string, id: string): boolean;
}

type TuiLike = Pick<TUI, "requestRender"> & { terminal: { rows: number; columns?: number } };

const WORKING_STATS_CHANNEL = "pi-plugins.working-stats.v1";
const SESSION_CHROME_CHANNEL = "pi-plugins.session-chrome.v1";

interface WorkingCounter {
  reset(): void;
  apply(event: unknown): void;
  message(elapsedMs: number, base?: string): string | undefined;
}
interface WorkingStatsService {
  create(): WorkingCounter;
  refreshMs: number;
}
/** pi-status-footer's session-chrome service (its src/session-chrome.ts, copied structurally). */
interface SessionChromeOverrides {
  cwd: string;
  provider: string;
  model: string;
  thinking?: string;
  context: { tokens: number | null; contextWindow: number; percent: number | null };
  totals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; compactions: number; started: number };
  phase?: string;
  queued?: boolean;
  sessionName?: string;
  borderGauge?: boolean;
}
interface SessionChromeService {
  footer(session: SessionChromeOverrides, width: number, theme: Theme): string[];
  gauge(editor: unknown, used: () => number | null, theme: () => Theme | undefined): boolean;
}

function requestService<T>(events: ViewerActions["events"], channel: string, valid: (service: T) => boolean): T | undefined {
  if (!events) return undefined;
  const request: { version: 1; service?: T } = { version: 1 };
  try {
    events.emit(channel, request);
  } catch {
    return undefined;
  }
  return request.service && valid(request.service) ? request.service : undefined;
}

/** Drafts per run, so switching away and back keeps what you were typing. */
const drafts = new Map<string, string>();

type Composer = (EmbeddedEditor & { getText?(): string; setText?(text: string): void; isShowingAutocomplete?(): boolean }) | SuiteEditor;

export class SessionView implements Component, Focusable {
  private run: Run;
  private chat!: PiChat;
  private unsubscribe: (() => void) | undefined;
  private composer: Composer | undefined;
  private suite = false;
  private gauge = false;
  private chrome: SessionChromeService | undefined;
  private stats: WorkingStatsService | undefined;
  private counter: WorkingCounter | undefined;
  private readonly loader: Loader;
  private hasFocus = false;
  private closed = false;
  private disposed = false;
  private stopArmed = false;
  /** The list under the editor has the keyboard. */
  private listActive = false;
  private listSelected = 0;
  private listStopArmed = false;
  /** Transcript scrolling: the first shown line, and whether it follows new output. */
  private scrollTop = 0;
  private follow = true;
  private lastViewport = 1;
  private lastContent = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: TuiLike,
    run: Run,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly initialActions: ViewerActions = {},
    private readonly keybindings?: Keybindings,
    private readonly source?: SessionSource,
    private readonly openSection?: (section: ActivitySection) => void,
    private readonly onInteraction?: () => void,
    private readonly viewport?: () => { width: number; height: number },
    private readonly family?: FamilyService,
  ) {
    this.run = run;
    this.loader = new Loader(tui as TUI, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), "Working");
    this.loader.stop();
    this.attach(run);
    // Elapsed time and the list's clocks tick even when the child is quiet.
    this.timer = setInterval(() => {
      if (!this.closed) {
        this.refreshWorking();
        this.tui.requestRender();
      }
    }, 1_000);
    this.timer.unref?.();
  }

  /** The run shown now. */
  get current(): Run {
    return this.run;
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    if (this.composer) this.composer.focused = value && !this.listActive;
  }

  readonly [EDITOR_SURFACE] = "embedded";

  [EDITOR_MODE](): EditorModeContext | undefined {
    return this.composer && !this.listActive ? readEditorMode(this.composer) : undefined;
  }

  [INPUT_CONTEXT](): "editor" | "list" | "viewer" {
    if (this.listActive) return "list";
    return this.composer ? "editor" : "viewer";
  }

  private actions(run = this.run): ViewerActions {
    if (this.source) {
      try {
        return this.source.actions(run);
      } catch {
        return {};
      }
    }
    return run === this.run ? this.initialActions : {};
  }

  private get events() {
    return this.actions().events ?? this.initialActions.events;
  }

  private running(run = this.run) {
    return run.state.status === "running";
  }

  private canSteer() {
    return Boolean(this.actions().steer) && this.running() && Boolean(this.run.child);
  }

  private canStop() {
    return Boolean(this.actions().stop) && this.running() && Boolean(this.run.child);
  }

  private key(data: string, id: string, ...fallback: string[]) {
    const keys = this.keybindings ?? safeKeybindings();
    if (keys) {
      try {
        if (keys.matches(data, id)) return true;
      } catch {
        // An unknown id in an older Pi.
      }
    }
    return fallback.some((k) => matchesKey(data, k as never));
  }

  /** Show `run`: its conversation, working row, editor and footer. */
  private attach(run: Run) {
    this.run = run;
    this.follow = true;
    this.scrollTop = 0;
    this.stopArmed = false;
    const settings = safe(() => this.source?.settings?.()) ?? {};
    this.chat = new PiChat(() => this.theme as never, { cwd: run.cwd || process.cwd(), userMessagesFromEvents: true, requestRender: () => this.tui.requestRender() });
    if (settings.hideThinkingBlock) this.chat.setThinkingHidden(true);
    // A message Pi's components cannot draw must not keep the session from opening.
    safe(() => seedChat(this.chat, run.conversation));
    this.stats = requestService<WorkingStatsService>(this.events, WORKING_STATS_CHANNEL, (s) => typeof s.create === "function");
    this.counter = this.stats?.create();
    this.chrome = requestService<SessionChromeService>(this.events, SESSION_CHROME_CHANNEL, (s) => typeof s.footer === "function");
    this.unsubscribe = run.conversation.subscribeEvents((event) => {
      if (this.closed) return;
      this.chat.apply(event);
      if (event.type === "message_update" && event.assistantMessageEvent) this.counter?.apply(event.assistantMessageEvent);
      this.tui.requestRender();
    });
    if (this.running(run)) {
      this.loader.start();
      this.refreshWorking();
    }
    this.openComposer(settings.editorPaddingX ?? 0);
    safe(() => this.family?.focus(run.agentId));
  }

  private detach() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.loader.stop();
    this.closeComposer();
  }

  private refreshWorking() {
    if (!this.running()) {
      this.loader.stop();
      return;
    }
    const elapsed = Date.now() - (this.run.state.startedAt || Date.now());
    this.loader.setMessage(this.counter?.message(elapsed) ?? "Working");
  }

  /** Switch to `run`, or back to main (`undefined`). */
  switchTo(run: Run | undefined) {
    if (this.closed || run === this.run) return;
    safe(() => this.onInteraction?.());
    if (!run) {
      this.close();
      return;
    }
    this.detach();
    this.listActive = false;
    this.attach(run);
    this.focused = this.hasFocus;
    safe(() => this.source?.onSwitch?.(run));
    this.tui.requestRender();
  }

  private openComposer(paddingX: number) {
    if (!this.canSteer()) return;
    const th = this.theme;
    const editorTheme: EditorTheme = {
      borderColor: (text) => th.fg("borderAccent", text),
      selectList: {
        selectedPrefix: (text) => th.fg("accent", text),
        selectedText: (text) => th.fg("accent", text),
        description: (text) => th.fg("muted", text),
        scrollInfo: (text) => th.fg("dim", text),
        noMatch: (text) => th.fg("dim", text),
      },
    };
    const submit = (value: string) => {
      const message = value.trim();
      if (!message) return;
      (this.composer as { addToHistory?(text: string): void } | undefined)?.addToHistory?.(message);
      (this.composer as { setText?(text: string): void } | undefined)?.setText?.("");
      drafts.delete(this.run.id);
      this.actions().steer?.(message);
      this.follow = true;
      this.tui.requestRender();
    };
    const draft = drafts.get(this.run.id) ?? "";
    const suite = requestEditorFactory(this.events);
    let composer: Composer | undefined;
    if (suite) {
      try {
        composer = suite.factory!({
          surface: "embedded",
          tui: this.tui as EditorFactoryOptions["tui"],
          theme: editorTheme,
          keybindings: (this.keybindings ?? safeKeybindings()) as EditorFactoryOptions["keybindings"],
          onSubmit: submit,
          // Esc in idle Normal mode: back to main.
          onCancel: () => this.close(),
          scrollViewport: (direction) => this.scrollBy(direction * Math.max(1, Math.floor(this.lastViewport / 2))),
          notify: () => undefined,
          paddingX,
          initialText: draft,
          initialMode: "insert",
        });
        this.suite = true;
      } catch {
        composer = undefined;
      }
    }
    if (!composer) {
      const editor = new Editor(this.tui as TUI, editorTheme, { paddingX });
      editor.onSubmit = submit;
      if (draft) editor.setText(draft);
      composer = editor as unknown as Composer;
      this.suite = false;
    }
    composer.focused = this.hasFocus && !this.listActive;
    this.composer = composer;
    this.gauge = this.chrome ? safe(() => this.chrome!.gauge(composer, () => this.contextShare().percent, () => this.theme)) === true : false;
  }

  private closeComposer() {
    const composer = this.composer;
    this.composer = undefined;
    if (!composer) return;
    const text = safe(() => (composer as { getText?(): string }).getText?.()) ?? "";
    if (text.trim()) drafts.set(this.run.id, text);
    else drafts.delete(this.run.id);
    try {
      composer.dispose?.();
    } catch {
      // Already gone.
    }
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    this.done();
  }

  /** Scroll the transcript by `lines` (negative up); follows again at the end. */
  scrollBy(lines: number): void {
    const max = Math.max(0, this.lastContent - this.lastViewport);
    this.scrollTop = Math.max(0, Math.min(max, Math.min(this.follow ? max : this.scrollTop, max) + lines));
    this.follow = this.scrollTop >= max;
    this.tui.requestRender();
  }

  private scrollTo(where: "top" | "bottom") {
    if (where === "bottom") this.follow = true;
    else {
      this.follow = false;
      this.scrollTop = 0;
    }
    this.tui.requestRender();
  }

  // ---- the sessions you can switch to: main, the listed runs, then pills -------------------------

  private roster(): FleetEntry[] {
    const runs = safe(() => this.source?.runs()) ?? [];
    const roster = fleetRoster(runs, Date.now(), `run:${this.run.id}`, safe(() => this.source?.sections?.()) ?? [], safe(() => this.source?.dismissedAt?.()), safe(() => this.source?.dismissed?.()));
    // A recorded run (from /subagents) is not one of this session's live runs.
    if (!roster.some((e) => e.kind === "run" && e.run === this.run)) {
      const at = roster.findIndex((e) => e.kind === "pill");
      const entry: FleetEntry = { kind: "run", run: this.run };
      if (at < 0) roster.push(entry);
      else roster.splice(at, 0, entry);
    }
    if (roster[0]?.kind !== "main") roster.unshift({ kind: "main" });
    return roster;
  }

  private sessions(): (Run | undefined)[] {
    return this.roster().flatMap((e) => (e.kind === "main" ? [undefined] : e.kind === "run" ? [e.run] : []));
  }

  private cycle(direction: 1 | -1) {
    const sessions = this.sessions();
    const at = sessions.indexOf(this.run);
    const next = sessions[(at + direction + sessions.length) % sessions.length];
    this.switchTo(next);
  }

  private listShown() {
    return this.source ? safe(() => this.source!.enabled?.()) !== false : false;
  }

  private enterList() {
    const roster = this.roster();
    this.listActive = true;
    this.listStopArmed = false;
    this.listSelected = Math.max(0, roster.findIndex((e) => e.kind === "run" && e.run === this.run));
    if (this.composer) this.composer.focused = false;
    this.tui.requestRender();
  }

  private leaveList() {
    this.listActive = false;
    this.listStopArmed = false;
    if (this.composer) this.composer.focused = this.hasFocus;
    this.tui.requestRender();
  }

  private listKey(data: string) {
    const roster = this.roster();
    this.listSelected = Math.min(this.listSelected, Math.max(0, roster.length - 1));
    const entry = roster[this.listSelected];
    const armed = this.listStopArmed;
    this.listStopArmed = false;
    if (matchesKey(data, "escape") || matchesKey(data, "h")) return this.leaveList();
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (this.listSelected === 0) return this.leaveList();
      this.listSelected--;
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.listSelected = Math.min(roster.length - 1, this.listSelected + 1);
    } else if (matchesKey(data, "enter") || matchesKey(data, "l")) {
      if (!entry) return;
      if (entry.kind === "pill") {
        safe(() => this.openSection?.(entry.section));
        return;
      }
      this.listActive = false;
      this.switchTo(entry.kind === "run" ? entry.run : undefined);
      return;
    } else if (matchesKey(data, "x") && entry?.kind === "run") {
      if (this.running(entry.run)) {
        if (armed) invoke(() => this.actions(entry.run).stop?.());
        else this.listStopArmed = true;
      } else if (entry.run !== this.run) invoke(() => this.source?.dismiss?.(entry.run.id));
    } else if (matchesKey(data, "b") && entry?.kind === "run" && this.actions(entry.run).canBackground?.()) {
      this.actions(entry.run).background?.();
    } else return;
    this.tui.requestRender();
  }

  // ---- keys ----------------------------------------------------------------------------------------

  handleInput(data: string): void {
    if (this.closed) return;
    safe(() => this.onInteraction?.());
    if (isKeyRelease(data)) return;
    const autocomplete = Boolean(this.composer && (readEditorMode(this.composer)?.autocomplete || this.composer.isShowingAutocomplete?.()));
    if (!autocomplete && matchesKey(data, "tab")) return this.cycle(1);
    if (!autocomplete && matchesKey(data, "shift+tab")) return this.cycle(-1);
    // Ctrl+J/Ctrl+K too (over the editor's newline and kill-line, which have other keys).
    if (!autocomplete && matchesKey(data, "ctrl+j")) return this.cycle(1);
    if (!autocomplete && matchesKey(data, "ctrl+k")) return this.cycle(-1);
    if (this.listActive) return this.listKey(data);
    if (this.key(data, "app.tools.expand", "ctrl+o")) {
      this.chat.setExpanded(!this.chat.isExpanded);
      return;
    }
    if (this.key(data, "app.thinking.toggle")) {
      this.chat.setThinkingHidden(!this.chat.thinkingHidden);
      return;
    }
    if (this.key(data, "tui.altScreen.halfPageUp", "pageUp")) return this.scrollBy(-Math.max(1, Math.floor(this.lastViewport / 2)));
    if (this.key(data, "tui.altScreen.halfPageDown", "pageDown")) return this.scrollBy(Math.max(1, Math.floor(this.lastViewport / 2)));
    if (this.key(data, "tui.altScreen.pageUp")) return this.scrollBy(-Math.max(1, this.lastViewport - 1));
    if (this.key(data, "tui.altScreen.pageDown")) return this.scrollBy(Math.max(1, this.lastViewport - 1));
    if (this.key(data, "tui.altScreen.lineUp")) return this.scrollBy(-1);
    if (this.key(data, "tui.altScreen.lineDown")) return this.scrollBy(1);
    if (this.key(data, "tui.altScreen.bottom", "ctrl+end")) return this.scrollTo("bottom");
    if (this.key(data, "tui.altScreen.top", "ctrl+home")) return this.scrollTo("top");
    const composer = this.composer;
    if (!composer) return this.viewerKey(data);
    const mode = readEditorMode(composer);
    const text = safe(() => (composer as { getText?(): string }).getText?.()) ?? "";
    // Ctrl+C clears the editor; on an empty one, twice stops the child (main's Esc, which here goes back).
    if (this.key(data, "app.clear", "ctrl+c") && (!mode || mode.state === "normal" || mode.state === "insert")) {
      if (text) {
        (composer as { setText?(text: string): void }).setText?.("");
        this.stopArmed = false;
      } else if (this.canStop()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          invoke(() => this.actions().stop?.());
        } else this.stopArmed = true;
      }
      this.tui.requestRender();
      return;
    }
    this.stopArmed = false;
    // Esc goes back to main. With pi-vim it first leaves Insert mode, unless there is nothing to edit.
    if (matchesKey(data, "escape") && !autocomplete && (!this.suite || (mode?.state === "insert" && !text))) return this.close();
    const down = matchesKey(data, "down");
    if (this.listShown() && !autocomplete && leavesPromptDown(composer, data, down, data === "j" && mode?.state === "normal")) return this.enterList();
    composer.handleInput(data);
    this.tui.requestRender();
  }

  /** An ended run has no editor: the keys scroll, and ↓ at the end enters the list. */
  private viewerKey(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) return this.close();
    const atEnd = this.follow || this.scrollTop >= this.lastContent - this.lastViewport;
    if ((matchesKey(data, "down") || matchesKey(data, "j")) && atEnd && this.listShown()) return this.enterList();
    if (matchesKey(data, "up") || matchesKey(data, "k")) return this.scrollBy(-1);
    if (matchesKey(data, "down") || matchesKey(data, "j")) return this.scrollBy(1);
    if (matchesKey(data, "ctrl+u")) return this.scrollBy(-Math.max(1, Math.floor(this.lastViewport / 2)));
    if (matchesKey(data, "ctrl+d")) return this.scrollBy(Math.max(1, Math.floor(this.lastViewport / 2)));
    if (matchesKey(data, "home") || data === "g") return this.scrollTo("top");
    if (matchesKey(data, "end") || data === "G") return this.scrollTo("bottom");
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed) return undefined;
    safe(() => this.onInteraction?.());
    if (event.type === "wheel") {
      this.scrollBy(event.wheelDelta ?? 0);
      return { handled: true };
    }
    // Pi's "Jump to latest message" pill.
    if (event.y === this.lastViewport - 1 && !this.follow && event.type === "click") {
      this.scrollTo("bottom");
      return { handled: true };
    }
    if (event.y < this.lastViewport) {
      const top = this.follow ? Math.max(0, this.lastContent - this.lastViewport) : this.scrollTop;
      return this.chat.handleMouse({ ...event, y: event.y + top }) ?? undefined;
    }
    return undefined;
  }

  // ---- drawing -------------------------------------------------------------------------------------

  /** The child's context in use, as a share of its model's window. */
  private contextShare(): SessionChromeOverrides["context"] {
    const tokens = contextTokens(this.run.conversation.messages) ?? null;
    const window = safe(() => this.source?.contextWindow?.(this.run.state.model ?? this.run.model)) ?? 0;
    return { tokens, contextWindow: window, percent: tokens !== null && window > 0 ? (tokens / window) * 100 : null };
  }

  private overrides(): SessionChromeOverrides {
    const model = this.run.state.model ?? this.run.model;
    const slash = model.indexOf("/");
    const u = this.run.state.usage;
    const s = this.run.state.status;
    return {
      cwd: this.run.cwd || process.cwd(),
      provider: slash > 0 ? model.slice(0, slash) : "",
      model: slash > 0 ? model.slice(slash + 1) : model,
      thinking: this.run.thinking,
      context: this.contextShare(),
      totals: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost.total, compactions: 0, started: this.run.state.startedAt || Date.now() },
      phase: s === "running" || s === "done" ? undefined : s === "failed" ? "error" : s,
      queued: this.run.conversation.queued.length > 0,
      sessionName: runLabel(this.run),
      borderGauge: this.gauge,
    };
  }

  private footerLines(width: number): string[] {
    if (this.chrome) {
      const lines = safe(() => this.chrome!.footer(this.overrides(), width, this.theme));
      if (lines?.length) return lines;
    }
    // Pi's own footer, in its layout: the directory, then usage on the left and the model on the right.
    const th = this.theme;
    const o = this.overrides();
    const home = process.env.HOME;
    const cwd = home && o.cwd.startsWith(home) ? `~${o.cwd.slice(home.length)}` : o.cwd;
    const parts = [`↑${formatCount(o.totals.input)}`, `↓${formatCount(o.totals.output)}`];
    if (o.totals.cacheRead) parts.push(`R${formatCount(o.totals.cacheRead)}`);
    if (o.totals.cacheWrite) parts.push(`W${formatCount(o.totals.cacheWrite)}`);
    const cost = formatCost(o.totals.cost);
    if (cost) parts.push(cost);
    if (o.context.percent !== null) parts.push(`${o.context.percent.toFixed(1)}%/${formatCount(o.context.contextWindow)}`);
    const right = `${o.model}${o.thinking ? ` • ${o.thinking}` : ""}`;
    const left = parts.join(" ");
    const gap = width - visibleWidth(left) - visibleWidth(right);
    return [
      truncateToWidth(th.fg("dim", `${cwd} • ${o.sessionName}`), width, th.fg("dim", "…")),
      truncateToWidth(th.fg("dim", gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : left), width),
    ];
  }

  private statusLines(width: number): string[] {
    const th = this.theme;
    const s = this.run.state;
    if (this.running()) {
      if (this.composer) return [];
      return [truncateToWidth(th.fg("dim", " Waiting for the subagent to start…"), width)];
    }
    const label = s.error ? `${s.status}: ${s.error.replace(/\s+/gu, " ")}` : s.status;
    return [truncateToWidth(` ${statusIcon(s.status, th)} ${th.fg(s.status === "done" ? "dim" : "error", label)}`, width)];
  }

  render(width: number): string[] {
    if (width < 8) return [];
    const th = this.theme;
    const rows = this.viewport ? Math.max(1, Math.floor(this.viewport().height)) : Math.max(4, Math.floor((this.tui.terminal.rows * VIEWER_HEIGHT_PCT) / 100));
    if (!this.running()) this.loader.stop();
    // The run ended while shown: no more steering (an unsent draft is kept).
    if (this.composer && !this.canSteer()) this.closeComposer();
    const dock: string[] = [];
    // Pi's working row, then queued messages, then the blank row over the editor.
    if (this.running()) dock.push(...safeRender(this.loader, width));
    const queued = this.run.conversation.queued;
    if (queued.length) {
      dock.push("");
      for (const q of queued) dock.push(truncateToWidth(` ${th.fg("dim", `Steering: ${q.replace(/\s+/gu, " ")}`)}`, width));
    }
    dock.push("");
    if (this.composer) {
      let lines = safeRender(this.composer, width);
      if (!lines.length) lines = [""];
      dock.push(...lines.slice(0, Math.max(1, Math.floor(rows / 2))));
    } else dock.push(...this.statusLines(width));
    if (this.stopArmed && this.canStop()) dock.push(truncateToWidth(` ${th.fg("error", `${keyLabel("app.clear", "ctrl+c")} again to stop ${runLabel(this.run)}`)}`, width));
    if (this.listShown()) {
      const roster = this.roster();
      const current = roster.findIndex((e) => e.kind === "run" && e.run === this.run);
      const selected = this.listActive ? this.listSelected : current;
      const entry = roster[selected];
      const canBackground = entry?.kind === "run" && Boolean(safe(() => this.actions(entry.run).canBackground?.()));
      // How to get back, since nothing else on this screen says it is not main.
      if (!this.listActive) dock.push(truncateToWidth(` ${th.fg("dim", `esc back to main · tab/shift+tab switch · ↓ list`)}`, width));
      dock.push(...renderFleet({ roster, selected, current, active: this.listActive, stopArmed: this.listStopArmed, canBackground, normalKeys: true, now: Date.now(), width, theme: th }));
    } else dock.push("");
    dock.push(...this.footerLines(width));

    const viewport = Math.max(1, rows - dock.length);
    const content = this.chat.empty ? [th.fg("dim", " (waiting for the first message…)")] : safe(() => this.chat.render(width)) ?? [];
    this.lastViewport = viewport;
    this.lastContent = content.length;
    const max = Math.max(0, content.length - viewport);
    if (this.follow) this.scrollTop = max;
    const start = Math.min(this.scrollTop, max);
    const lines = content.slice(start, start + viewport).map((l) => truncateToWidth(l, width));
    while (lines.length < viewport) lines.push("");
    // Pi's own pill when you are scrolled up, centered on the last transcript row.
    if (!this.follow && start < max) {
      const key = keyLabel("tui.altScreen.bottom", "ctrl+end");
      const raw = ` ↓ Jump to latest message${key ? ` · ${key}` : ""} `;
      const styled = th as Theme & { bg?(color: string, text: string): string };
      const label = truncateToWidth(styled.bg ? styled.bg("selectedBg", th.fg("text", raw)) : `\x1b[7m${raw}\x1b[27m`, width, "");
      const labelWidth = visibleWidth(label);
      const column = Math.max(0, Math.floor((width - labelWidth) / 2));
      lines[viewport - 1] = safe(() => compositeTuiLine(lines[viewport - 1] ?? "", label, column, labelWidth, width)) ?? label;
    }
    return [...lines, ...dock.slice(0, Math.max(0, rows - lines.length))];
  }

  invalidate(): void {
    this.composer?.invalidate?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    safe(() => this.family?.focus(undefined));
    this.closed = true;
    clearInterval(this.timer);
    this.detach();
  }
}

/** Fill a fresh chat from a conversation already under way: finished messages, the one streaming, the tools running. */
export function seedChat(chat: PiChat, conversation: Conversation) {
  const streaming = conversation.streaming;
  chat.seed(conversation.messages.filter((m) => m !== streaming), (text) => ({ text }));
  if (streaming?.role === "assistant") {
    chat.apply({ type: "message_start", message: streaming });
    chat.apply({ type: "message_update", message: streaming });
  }
  for (const tool of conversation.activeTools.values()) {
    chat.apply({ type: "tool_execution_start", toolCallId: tool.id, toolName: tool.name, args: tool.args });
    if (tool.partial) chat.apply({ type: "tool_execution_update", toolCallId: tool.id, partialResult: { content: [{ type: "text", text: tool.partial }] } });
  }
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function safeRender(component: Component, width: number): string[] {
  try {
    return component.render(width);
  } catch {
    return [];
  }
}

function safeKeybindings(): Keybindings | undefined {
  return safe(() => getKeybindings() as unknown as Keybindings);
}

/** How you bound `id` (Pi's key hints), or `fallback`. */
function keyLabel(id: string, fallback: string): string {
  return safe(() => keyText(id as never)) || fallback;
}

/** Input callbacks cannot await; contain synchronous and asynchronous failures. */
function invoke(action: () => void | Promise<void>) {
  try {
    void Promise.resolve(action()).catch(() => undefined);
  } catch {
    // A failed stop must not take the keyboard.
  }
}

/** The part of `ctx.ui` the view uses. */
export interface ViewerUI {
  custom<T>(
    factory: (tui: TUI, theme: any, keybindings: any, done: (result: T) => void) => Component & { dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: { anchor?: "center" | "top-left"; width?: `${number}%`; maxHeight?: `${number}%` } | (() => { anchor?: "center" | "top-left"; width?: `${number}%`; maxHeight?: `${number}%` }); onHandle?: (handle: OverlayHandle) => void },
  ): Promise<T>;
}

/**
 * Show `run`'s session full screen until you go back to main; `onOpen` gets a way to close it.
 * With a `source`, Tab and the list switch between main and its runs.
 */
export function openViewer(ui: ViewerUI, run: Run, actions: ViewerActions = {}, onOpen?: (close: () => void) => void, source?: SessionSource, onInteraction?: () => void, canInstall?: () => boolean): Promise<void> {
  const family = source?.family?.() ?? (actions.events ? discoverFamily(actions.events) : undefined);
  if (family) {
    let hosted: SessionView | undefined;
    let cancelled = false;
    return family.view({ factory: (tui, theme, keybindings, done, viewport) => {
      // A delayed host must not install an auto-view after eligibility changed.
      if (cancelled || canInstall?.() === false) throw new Error("Viewer opening cancelled");
      const close = () => {
        if (cancelled) return;
        cancelled = true;
        hosted?.dispose();
        done();
      };
      const openSection = (section: ActivitySection) => invoke(() => section.openDialog?.(ui as never));
      hosted = new SessionView(tui, run, theme as Theme, close, actions, keybindings as Keybindings, source, openSection, onInteraction, viewport, family);
      onOpen?.(close);
      return hosted;
    } }).finally(() => hosted?.dispose());
  }
  let view: SessionView | undefined;
  let handle: OverlayHandle | undefined;
  let cancelled = false;
  return ui.custom<void>(
    (tui, theme, keybindings, done) => {
      const openSection = (section: ActivitySection) => {
        void Promise.resolve()
          .then(() => section.openDialog?.(ui as never))
          .catch(() => undefined);
      };
      const close = () => {
        if (cancelled) return;
        cancelled = true;
        view?.dispose();
        // Pi 1.2's custom done() blindly pops the last overlay, not this one.
        // Remove only our entry, then give done() a non-capturing placeholder to
        // pop synchronously. Pi 1.4 removes its own handle instead, so also hide
        // the placeholder by handle (a no-op if 1.2 already popped it).
        // A dialog above us keeps both its entry and focus;
        // handle.hide() also retargets its previous focus away from this viewer.
        // Before installation, reject in overlayOptions instead of calling done.
        if (handle) {
          handle.hide();
          const placeholder = tui.showOverlay({ render: () => [], invalidate() {} }, { nonCapturing: true });
          try {
            done(undefined);
          } finally {
            placeholder.hide();
          }
        }
      };
      view = new SessionView(tui, run, theme, close, actions, keybindings, source, openSection, onInteraction);
      onOpen?.(close);
      return view;
    },
    {
      overlay: true,
      // Pi resolves these options in the same callback as showOverlay, after awaiting
      // the factory. This is the last safe check before it captures keyboard focus.
      overlayOptions: () => {
        if (cancelled || canInstall?.() === false) throw new Error("Viewer opening cancelled");
        return { anchor: "top-left", width: "100%", maxHeight: `${VIEWER_HEIGHT_PCT}%` };
      },
      onHandle: (installed) => { handle = installed; },
    },
  ).catch((error) => {
    view?.dispose();
    throw error;
  });
}
