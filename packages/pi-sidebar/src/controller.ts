// Ties Sidebar together in main's process: opening, focus, the layout, the panel, the agent and the
// thread stored in main's session.
import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { ago, SidebarAgent, type SidebarEvent } from "./child.ts";
import { MIN_COLUMNS_ENV, parseMinColumns, parseRatio, PREFS_ENV, RATIO_ENV } from "./config.ts";
import { canSplit, dividerLines, muteEditorBorders, SplitLayout } from "./layout.ts";
import { MainState } from "./main-state.ts";
import { RatioStore } from "./preferences.ts";
import { InjectedPrompt } from "./injected.ts";
import { herdrFocus, navDirection, navTarget } from "./nav.ts";
import { SidebarPanel, type StatusPart } from "./panel.ts";
import { requestPinService, requestStash, type PromptPinService, type StashController } from "./contract.ts";
import { HeadsUp, headsUpChange, headsUpChanged } from "./headsup/headsup.ts";
import type { HeadsUpNote } from "./headsup/protocol.ts";
import { isNoteMarker, noteMessages } from "./headsup/thread.ts";
import { QUIZ_ENTRY, QuizMode, quizFromBranch } from "./quiz/mode.ts";
import { QUIZ_NEXT, QUIZ_ROLE, QUIZ_START } from "./quiz/prompt.ts";
import { RESET_ENTRY, threadFromBranch } from "./thread.ts";
import {
  cycleChoice,
  favoritePatterns,
  findModel,
  isMainModel,
  MODEL_ENTRY,
  modelDefault,
  modelFromBranch,
  modelKey,
  modelLabel,
  MODELS_ENV,
  resolveChoice,
  resolvePattern,
  SAME,
  type Favorite,
  type ModelChoice,
  type ModelEntry,
  type ModelLike,
} from "./models.ts";

export const KNOWLEDGE_ENV = "PI_SIDEBAR_KNOWLEDGE";

export const QUIZ_HELP = [
  "/quiz           quiz mode on (asks the first question) or off",
  "/quiz next      the next question, on what main changed most recently",
  "/quiz progress  what you have shown you know in this repository",
].join("\n");

export const MODEL_HELP = [
  "/model          pick Sidebar's model: main's own (same, sharing its prompt cache) or a favorite",
  "/model <name>   switch to a favorite by name (opus, sol, ...) or provider/id; /model same goes back",
  "ctrl+p          the next model (shift+ctrl+p the previous; your own model keys apply)",
].join("\n");

/** How long a resolved model choice is reused (the header asks every second). */
const CHOICE_MS = 2_000;

export const SIDEBAR_HEADSUP_HELP = [
  "/known          the last heads-up note was something you knew: it is not raised again",
  "/headsup        heads-up mode's state and cost (on | sidebar | off)",
].join("\n");

const PROBE = "pi-sidebar-probe";
const HERDR_BLOCKED = "herdr:blocked";

type FocusTui = TUI & { getFocusedComponent?(): Component | null };

export class SidebarController {
  readonly main: MainState;
  readonly agent: SidebarAgent;
  /** Quiz mode: questions on main's changes, graded into a per-repository knowledge profile. */
  readonly quiz = new QuizMode(process.env[KNOWLEDGE_ENV] ?? path.join(getAgentDir(), "pi-sidebar", "knowledge"));
  /** Heads-up mode: occasional checks for one thing worth knowing, shown above main's editor. */
  readonly headsUp: HeadsUp;
  /** Main's TUI, found when the session starts (Sidebar's own may not exist yet). */
  private hostTui: FocusTui | undefined;
  /** Main's editor: the component focused when the user last submitted a prompt. */
  private mainEditor: Component | null = null;
  /** Sidebar's own prompt stash from pi-stash (Ctrl+S in its composer); it outlives panel rebuilds. */
  private stashController: StashController | undefined;
  /** pi-sticky-last-prompt's prompt-pin service, once found. */
  private pinService: PromptPinService | undefined;
  /** Blocking extension dialogs open in main (a digit then belongs to them). */
  private prompts = 0;
  /** Sidebar's model: `same` (main's) or a favorite's pattern, stored in main's session. */
  private modelSetting = modelDefault();
  private resolvedChoice: { id: string; at: number; choice: ModelChoice } | undefined;
  /** Heads-up notes waiting for Sidebar to finish its answer. */
  private pendingNotes: HeadsUpNote[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private tui: FocusTui | undefined;
  private theme: Theme | undefined;
  private panel: SidebarPanel | undefined;
  private layout: SplitLayout | undefined;
  private mainFocus: Component | null = null;
  private blocked = 0;
  /** Sidebar steps aside: a dialog holds `herdr:blocked` or a UI prompt is open in main. */
  private get collapsed(): boolean {
    return this.blocked > 0 || this.prompts > 0;
  }
  private ticker: ReturnType<typeof setInterval> | undefined;
  private releaseInput: (() => void) | undefined;
  /** Prompts another program types into this pane, which go to main even while Sidebar has focus. */
  private readonly injected = new InjectedPrompt();
  /** Sidebar's share per orientation: what you dragged the divider to, else PI_SIDEBAR_RATIO. */
  readonly ratios = new RatioStore(process.env[PREFS_ENV] ?? path.join(getAgentDir(), "pi-sidebar.json"), parseRatio(process.env[RATIO_ENV]));

  constructor(private readonly pi: ExtensionAPI, private readonly keys: string[], private readonly focusKeys: string[] = []) {
    this.main = new MainState(pi);
    this.agent = new SidebarAgent(pi, this.main);
    this.agent.onEvent((event) => this.onAgentEvent(event));
    this.agent.modelChoice = () => this.sidebarModel();
    this.agent.quiz = { role: () => (this.quiz.on ? QUIZ_ROLE : undefined), status: () => this.quiz.status() };
    this.agent.onTurn((added) => {
      const recorded = this.quiz.record(added);
      if (recorded.invalid > 0) this.panel?.notice({ kind: "warning", text: `Quiz mode could not read ${recorded.invalid} grade${recorded.invalid === 1 ? "" : "s"} from that answer; it was not counted.` });
    });
    this.main.onChange(() => this.render());
    this.headsUp = new HeadsUp(pi, this.main, {
      deliver: (note, onlySidebar) => this.deliverNote(note, onlySidebar),
      askSidebar: (text, ctx) => {
        this.openOrFocus(ctx);
        if (!this.isOpen) return false;
        this.question(text);
        return true;
      },
      model: () => this.sidebarModel(),
    }, {
      knowledgeDir: process.env[KNOWLEDGE_ENV] ?? path.join(getAgentDir(), "pi-sidebar", "knowledge"),
      logFile: path.join(getAgentDir(), "pi-sidebar", "headsup.log"),
    });
    // A dialog in main (Pi's select/confirm/input/editor or an extension's custom UI) collapses
    // Sidebar like a `herdr:blocked` hold, also for dialogs that hold none: remote clients
    // (herdr-web-ui, Collie) read the dialog off a full-width screen.
    pi.on("ui_prompt_start", () => {
      this.prompts++;
      this.render();
    });
    pi.on("ui_prompt_end", () => {
      this.prompts = Math.max(0, this.prompts - 1);
      this.render();
    });
    pi.on("input", (event) => {
      if (event.source === "interactive") this.mainEditor = this.hostTui?.getFocusedComponent?.() ?? this.mainEditor;
      return undefined;
    });
    // While quiz mode is on, say when main's run changed files (a nudge; nothing is sent).
    pi.on("agent_end", async (_event, ctx) => {
      if (!this.quiz.on) return;
      const fresh = await this.quiz.freshChanges(ctx.cwd).catch(() => []);
      if (fresh.length === 0 || !this.panel) return;
      this.panel.notice({ kind: "info", text: `Main changed ${fresh.length} file${fresh.length === 1 ? "" : "s"}: /quiz next asks about ${fresh.length === 1 ? "it" : "them"}.` });
      if (!this.panel.focused) this.panel.unread = true;
      this.render();
    });

    pi.on("session_start", async (_event, ctx) => {
      this.listen(ctx);
      await this.restore(ctx, true);
    });
    pi.on("session_tree", async (_event, ctx) => this.restore(ctx, false));
    pi.on("session_shutdown", async () => {
      this.releaseInput?.();
      this.releaseInput = undefined;
      this.headsUp.dispose();
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      this.pendingNotes = [];
      this.close();
      this.panel?.dispose();
      this.panel = undefined;
      this.tui = undefined;
      await this.agent.dispose();
    });
    pi.events?.on?.(HERDR_BLOCKED, (data: unknown) => {
      const active = (data as { active?: unknown } | undefined)?.active === true;
      this.blocked = Math.max(0, this.blocked + (active ? 1 : -1));
      this.render();
    });
  }

  get isOpen(): boolean {
    return !!this.layout?.mounted;
  }

  matchesToggle(data: string): boolean {
    return this.keys.some((key) => matchesKey(data, key as never));
  }

  matchesFocusSwitch(data: string): boolean {
    return this.focusKeys.some((key) => matchesKey(data, key as never));
  }

  /** Open Sidebar (focused) if it is closed. */
  openOrFocus(ctx: ExtensionContext): void {
    if (!this.isOpen && !this.open(ctx)) return;
    this.focusSidebar();
  }

  /** Ctrl+' and `/sidebar`: open it (focused), or close it when it is open (the thread is kept). */
  toggle(ctx: ExtensionContext): void {
    if (this.isOpen) this.close();
    else if (this.open(ctx)) this.focusSidebar();
  }

  open(ctx: ExtensionContext): boolean {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      ctx.ui.notify("Sidebar needs Pi's interactive terminal UI.", "warning");
      return false;
    }
    this.main.bind(ctx);
    const tui = this.probe(ctx);
    if (!tui || !canSplit(tui)) {
      ctx.ui.notify('Sidebar needs Pi\'s fullscreen mode (set "tuiMode": "fullscreen" in settings).', "warning");
      return false;
    }
    if (tui !== this.tui || !this.panel) {
      if (tui !== this.tui) {
      }
      this.panel?.dispose();
      this.layout?.unmount();
      this.tui = tui;
      this.panel = new SidebarPanel(tui, () => this.theme ?? ctx.ui.theme, {
        cwd: ctx.cwd,
        events: this.pi.events,
        pinService: () => (this.pinService ??= requestPinService(this.pi.events)),
        stash: () => (this.stashController ??= requestStash(this.pi.events, {
          editor: () => this.panel?.input.editorComponent,
          notify: (message, type) => this.panel?.notice({ kind: type, text: message }),
          changed: () => this.render(),
        })),
        status: (theme) => this.status(theme),
        submit: (text) => this.submit(text),
        confirm: (text) => this.send(text, true),
        abort: () => void this.agent.abort(),
        focusMain: () => this.focusMain(),
        focusSidebar: () => this.focusSidebar(),
        close: () => this.close(),
        isBusy: () => this.agent.busy,
        matchesToggle: (data) => this.matchesToggle(data),
        matchesFocusSwitch: (data) => this.matchesFocusSwitch(data),
        toggleLabel: this.keys[0] ?? "ctrl+'",
        cycleModel: (direction) => this.cycleModel(direction),
        pickModel: () => void this.pickModel(),
        editorPaddingX: () => {
          try { return Number((this.pi.getSettings() as { editorPaddingX?: unknown }).editorPaddingX) || 0; } catch { return 0; }
        },
        mainHidesThinking: () => {
          try { return (this.pi.getSettings() as { hideThinkingBlock?: boolean }).hideThinkingBlock === true; } catch { return false; }
        },
      });
      this.panel.chat.seed(this.agent.messages, (text) => (isNoteMarker(text) ? undefined : { text }));
      // Pi sends keyboard scrolling, `tui.scrollBy` (pi-vim's Ctrl+U/D), its transcript search, the
      // end indicator and leftover wheel scrolling to the primary scroll view; the last primary view in
      // the layout wins, and Sidebar comes after main. So the focused half gets them (pi-stereo-view's
      // approach).
      const panel = this.panel;
      Object.defineProperty(panel.view, "primary", {
        get: () => this.panel === panel && this.isOpen && panel.focused && !this.collapsed,
        configurable: true,
      });
      const theme = () => this.theme ?? ctx.ui.theme;
      this.layout = new SplitLayout(tui, this.panel.root, {
        ratio: (orientation) => this.ratios.get(orientation),
        setRatio: (orientation, ratio, final) => this.ratios.set(orientation, ratio, final),
        scrollSidebar: (lines) => panel.view.scrollBy(lines),
        sidebarPrimary: () => panel.view.primary,
        minColumns: parseMinColumns(process.env[MIN_COLUMNS_ENV]),
        collapsed: () => this.collapsed,
        focused: () => !!this.panel?.focused,
        focusHalf: (half) => (half === "sidebar" ? this.focusSidebar() : this.focusMain()),
        // Accent in both states; the arrow in its middle points at the focused half.
        divider: (orientation, sidebarFocused, width, length) => dividerLines(orientation, width, (text) => theme().fg("borderAccent", text), {
          sidebar: sidebarFocused, length, pointer: (text) => theme().bold(theme().fg("accent", text)),
        }),
      });
    }
    if (!this.layout!.mount()) return false;
    this.startTicker();
    // A note showing above main's editor moves into Sidebar's thread.
    const shown = this.headsUp.take();
    if (shown) this.pendingNotes.push(shown);
    this.flushNotes();
    return true;
  }

  /**
   * Keys that reach Pi whichever half has focus: Herdr's prefix+h/j/k/l (sent by the pi-sidebar-nav
   * Herdr plugin as reserved keys) and the optional direct focus-switch keys.
   */
  private listen(ctx: ExtensionContext): void {
    this.releaseInput?.();
    this.releaseInput = undefined;
    if (ctx.mode !== "tui" || typeof ctx.ui.onTerminalInput !== "function") return;
    this.hostTui = this.probe(ctx) ?? this.hostTui;
    this.releaseInput = ctx.ui.onTerminalInput((data) => {
      if (this.headsUp.note.showing && this.headsUp.handleKey(data, this.editorIdle(ctx))) return { consume: true };
      if (this.sidebarTyping()) {
        const prompt = this.injected.observe(data, this.panel!.input.getText() === "", (d) => matchesKey(d, "enter"));
        if (prompt !== undefined) {
          this.panel!.input.setText("");
          this.toMain(prompt, ctx);
          return { consume: true };
        }
      } else this.injected.reset();
      const direction = navDirection(data);
      if (direction) {
        const target = navTarget(direction, this.isOpen && !this.collapsed, this.layout?.orientation ?? "right", !!this.panel?.focused);
        if (target === "sidebar") this.focusSidebar();
        else if (target === "main") this.focusMain();
        else herdrFocus(direction);
        return { consume: true };
      }
      if (this.isOpen && this.matchesFocusSwitch(data)) {
        if (this.panel?.focused) this.focusMain();
        else this.focusSidebar();
        return { consume: true };
      }
      return undefined;
    });
  }

  /** Sidebar's composer has the keyboard: open, focused, and no dialog in main. */
  private sidebarTyping(): boolean {
    return this.isOpen && !!this.panel?.focused && !this.collapsed;
  }

  /**
   * A prompt typed into this pane by another program, sent to main as its editor would: a new turn
   * when main is idle, else a steer into its current one (the sender chose steer by sending now).
   */
  private toMain(text: string, fallback: ExtensionContext): void {
    const ctx = this.main.ctx ?? fallback;
    let idle = true;
    try { idle = ctx.isIdle(); } catch { /* treat as idle */ }
    try {
      this.pi.sendUserMessage(text, idle ? undefined : { deliverAs: "steer" });
    } catch (error) {
      this.panel?.input.setText(text);
      this.panel?.notice({ kind: "error", text: `Could not pass that message to main: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    this.panel?.notice({ kind: "info", text: `A message sent to this pane went to main${idle ? "" : " (steering its current turn)"}, not Sidebar.` });
    this.render();
  }

  /** Main's own editor has focus and is empty: no dialog, no Sidebar focus, nothing typed. */
  private editorIdle(ctx: ExtensionContext): boolean {
    if (this.collapsed || this.panel?.focused) return false;
    try { if (ctx.ui.getEditorText() !== "") return false; } catch { return false; }
    const focused = this.hostTui?.getFocusedComponent?.() ?? null;
    if (this.mainEditor) return focused === this.mainEditor;
    // Before the first prompt: an editor-like component (not a list dialog) that is empty.
    const text = (focused as { getText?: () => unknown } | null)?.getText;
    return typeof text === "function" && text.call(focused) === "";
  }

  close(): void {
    if (!this.layout) return;
    const hadFocus = !!this.panel?.focused;
    this.layout.unmount();
    this.stopTicker();
    if (hadFocus) this.focusMain();
  }

  focusSidebar(): void {
    const tui = this.tui;
    const panel = this.panel;
    if (!tui || !panel || !this.isOpen) return;
    const current = tui.getFocusedComponent?.() ?? null;
    // While Sidebar is the active half, the focused component is Sidebar's own overlay (Pi's search), not main's.
    if (current && current !== panel.input && !panel.focused) this.mainFocus = current;
    // Main's editor keeps drawing its (accent) borders in its half; mute them while Sidebar has focus.
    for (const editor of new Set([this.mainFocus, this.mainEditor])) {
      muteEditorBorders(editor, () => {
        const theme = this.theme;
        return theme && this.panel === panel && this.isOpen && panel.focused && !this.collapsed ? (text) => theme.fg("borderMuted", text) : undefined;
      });
    }
    panel.unread = false;
    tui.setFocus(panel.input);
    tui.requestRender();
  }

  focusMain(): void {
    const tui = this.tui;
    if (!tui) return;
    if (this.panel) this.panel.focused = false;
    tui.setFocus(this.mainFocus);
    tui.requestRender();
  }

  /** Start a fresh thread; earlier exchanges stay in main's session history. */
  async reset(): Promise<void> {
    await this.agent.abort();
    this.pi.appendEntry(RESET_ENTRY, { timestamp: Date.now() });
    await this.agent.setThread([]);
    this.rebuild();
  }

  private async restore(ctx: ExtensionContext, newSession = false): Promise<void> {
    this.main.bind(ctx);
    const branch = ctx.sessionManager.getBranch();
    this.headsUp.restore(branch, newSession);
    this.modelSetting = modelFromBranch(branch)?.model ?? modelDefault();
    this.resolvedChoice = undefined;
    this.pendingNotes = [];
    await this.agent.setThread(threadFromBranch(branch));
    await this.quiz.restore(quizFromBranch(branch), ctx.cwd).catch(() => {});
    this.rebuild();
  }

  private availableModels(): ModelLike[] {
    try {
      return (this.main.ctx?.modelRegistry.getAvailable() ?? []) as ModelLike[];
    } catch {
      return [];
    }
  }

  /** Your favorites (PI_SIDEBAR_MODELS, else Pi's enabledModels), resolved against the models you are logged in to. */
  favorites(): Favorite[] {
    let enabled: string[] | undefined;
    try { enabled = (this.pi.getSettings() as { enabledModels?: string[] }).enabledModels; } catch { /* none */ }
    const available = this.availableModels();
    return favoritePatterns(process.env, enabled).map((pattern) => resolvePattern(pattern, available));
  }

  /** Main's model as Sidebar shares it: the one of its last request, else the selected one. */
  private mainModel(): { provider: string; id: string } | undefined {
    const request = this.main.request;
    if (request) return { provider: request.provider, id: request.model };
    const model = this.main.ctx?.model;
    return model ? { provider: model.provider, id: model.id } : undefined;
  }

  /** The model Sidebar answers (and checks) on now. A favorite that is main's own model means `same`. */
  sidebarModel(): ModelChoice {
    const main = this.mainModel();
    const id = `${this.modelSetting}\u0000${main ? modelKey(main) : ""}`;
    const now = Date.now();
    const memo = this.resolvedChoice;
    if (memo && memo.id === id && now - memo.at < CHOICE_MS) return memo.choice;
    let choice = resolveChoice(this.modelSetting, this.availableModels());
    if (choice.kind === "other" && isMainModel(choice.model, main)) choice = { kind: "same" };
    this.resolvedChoice = { id, at: now, choice };
    return choice;
  }

  /** Switch Sidebar's model for this session (stored in main's session). */
  setModel(setting: string): string {
    this.modelSetting = setting;
    this.resolvedChoice = undefined;
    const entry: ModelEntry = { version: 1, model: setting, at: Date.now() };
    try { this.pi.appendEntry(MODEL_ENTRY, entry); } catch { /* main's session went away */ }
    this.agent.missed = undefined;
    this.render();
    return this.describeModel();
  }

  /** What Sidebar runs on now, in a sentence. */
  describeModel(): string {
    const choice = this.sidebarModel();
    if (choice.kind === "unavailable") return `Sidebar's model ${choice.pattern} matches no model you are logged in to. /model picks another.`;
    if (choice.kind === "other") {
      return `Sidebar runs on ${choice.label} (${modelKey(choice.model)}${choice.thinking ? `, thinking ${choice.thinking}` : ""}).\nIt reads main's session as a transcript and keeps its own prompt cache, so its first question pays for that transcript once.`;
    }
    if (this.modelSetting !== SAME) return "Sidebar's favorite is main's own model, so it uses main's model and shares main's prompt cache.";
    return "Sidebar uses main's model and shares main's prompt cache.";
  }

  /** `/sidebar model …` in main, or `/model …` in Sidebar: a picker without an argument. */
  async modelCommand(args: string, ctx: ExtensionContext | undefined = this.main.ctx): Promise<void> {
    const arg = args.trim();
    if (!arg) return this.pickModel(ctx);
    if (arg === "help") return this.say(MODEL_HELP, "info", ctx);
    if (["same", "main", "off", "default"].includes(arg.toLowerCase())) return this.say(this.setModel(SAME), "info", ctx);
    const found = findModel(arg, this.favorites(), this.availableModels());
    if (!found?.model) return this.say(`No favorite or model you are logged in to matches "${arg}". /model lists your favorites (set ${MODELS_ENV}).`, "warning", ctx);
    this.say(this.setModel(found.pattern), "info", ctx);
  }

  /** Ctrl+P in Sidebar: the next of `same` and the favorites you are logged in to. */
  cycleModel(direction: 1 | -1): void {
    const favorites = this.favorites();
    if (!favorites.some((f) => f.model)) {
      this.say(`No favorite models to switch to: set ${MODELS_ENV} (or Pi's enabled models).`, "warning");
      return;
    }
    this.say(this.setModel(cycleChoice(this.modelSetting, favorites, direction)), "info");
  }

  /**
   * Pick Sidebar's model from `same` and your favorites: in Sidebar while it is open (focusing it),
   * else as a dialog in main.
   */
  async pickModel(ctx: ExtensionContext | undefined = this.main.ctx): Promise<void> {
    if (!ctx) return;
    const favorites = this.favorites();
    const current = (setting: string) => (setting === this.modelSetting ? " (current)" : "");
    const items = [{ value: SAME, label: `Same as main${current(SAME)}`, description: "shares main's prompt cache" }];
    for (const fav of favorites) {
      if (!fav.model) continue;
      items.push({ value: fav.pattern, label: `${modelLabel(fav.model)}${current(fav.pattern)}`, description: `${modelKey(fav.model)}${fav.thinking ? ` · ${fav.thinking}` : ""}` });
    }
    if (items.length === 1) {
      this.say(`No favorite models to pick from: set ${MODELS_ENV} (or Pi's enabled models).`, "warning", ctx);
      return;
    }
    if (this.isOpen && this.panel) {
      const at = items.findIndex((item) => item.value === this.modelSetting);
      this.panel.clearNotice();
      this.panel.openPicker({
        title: "Sidebar's model",
        items,
        selected: Math.max(0, at),
        onSelect: (value) => this.say(this.setModel(value), "info", ctx),
      });
      this.focusSidebar();
      return;
    }
    const options = items.map((item) => `${item.label} · ${item.description}`);
    let picked: string | undefined;
    try {
      picked = await ctx.ui.select("Sidebar's model", options);
    } catch {
      return;
    }
    const index = picked === undefined ? -1 : options.indexOf(picked);
    if (index !== -1) this.say(this.setModel(items[index]!.value), "info", ctx);
  }

  /** A message in Sidebar while it is open, else a notification in main. */
  private say(text: string, kind: "info" | "warning", ctx: ExtensionContext | undefined = this.main.ctx): void {
    if (this.isOpen && this.panel) {
      const [first, ...rest] = text.split("\n");
      this.panel.notice({ kind, text: first ?? "" });
      for (const line of rest) this.panel.chat.note(line);
      this.render();
      return;
    }
    ctx?.ui.notify(text, kind);
  }

  /** `/quiz …` in Sidebar, or `/sidebar quiz …` in main. */
  async quizCommand(args: string): Promise<void> {
    const ctx = this.main.ctx;
    const sub = args.trim().toLowerCase();
    if (!ctx) return;
    if (sub === "help") return this.noteLines(QUIZ_HELP.split("\n"));
    if (sub === "progress") return this.noteLines(await this.quiz.progress(ctx.cwd).catch(() => ["Could not read the knowledge profile."]));
    if (sub === "off" || (sub === "" && this.quiz.on)) {
      if (!this.quiz.on) return this.panel?.notice({ kind: "info", text: "Quiz mode is already off." });
      this.pi.appendEntry(QUIZ_ENTRY, this.quiz.stop());
      this.panel?.notice({ kind: "info", text: "Quiz mode off. What you showed is kept; /quiz progress lists it." });
      this.render();
      return;
    }
    if (sub !== "" && sub !== "on" && sub !== "next") {
      this.panel?.notice({ kind: "warning", text: `Unknown /quiz argument "${sub}": /quiz, /quiz next, /quiz progress, /quiz off.` });
      return;
    }
    const starting = !this.quiz.on;
    if (starting) this.pi.appendEntry(QUIZ_ENTRY, await this.quiz.start(ctx.cwd));
    this.render();
    this.question(sub === "next" && !starting ? QUIZ_NEXT : QUIZ_START);
  }

  private noteLines(lines: string[]): void {
    if (!this.panel) return;
    for (const line of lines) this.panel.chat.note(line);
    this.panel.scrollToEnd();
  }

  /** A new panel for the current thread, reopened (and refocused) if it was showing. */
  private rebuild(): void {
    if (!this.panel) return;
    const ctx = this.main.ctx;
    const wasOpen = this.isOpen;
    const hadFocus = this.panel.focused;
    this.close();
    this.panel.dispose();
    this.panel = undefined;
    this.layout = undefined;
    this.tui = undefined;
    if (wasOpen && ctx && this.open(ctx) && hadFocus) this.focusSidebar();
  }

  /**
   * A heads-up note into Sidebar's thread, while Sidebar is open (or always, with `onlySidebar`). While
   * it answers, the note waits for the answer to end. False when Sidebar is closed and the note may go
   * above main's editor instead.
   */
  private deliverNote(note: HeadsUpNote, onlySidebar = false): boolean {
    if (!this.isOpen && !onlySidebar) return false;
    this.pendingNotes.push(note);
    this.flushNotes();
    return true;
  }

  private flushNotes(): void {
    const panel = this.panel;
    if (this.pendingNotes.length === 0) return;
    if (!this.agent.idle) {
      // Sidebar is answering (or just finishing): try again shortly; its agent_end also flushes.
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.flushNotes(); }, 500);
        this.flushTimer.unref?.();
      }
      return;
    }
    const request = this.main.request;
    const model = this.main.ctx?.model;
    const choice = this.sidebarModel();
    const id = choice.kind === "other"
      ? { api: choice.model.api, provider: choice.model.provider, model: choice.model.id }
      : { api: request?.api ?? model?.api ?? "", provider: request?.provider ?? model?.provider ?? "", model: request?.model ?? model?.id ?? "" };
    const notes = this.pendingNotes;
    this.pendingNotes = [];
    for (const note of notes) {
      const messages = noteMessages(note, id, Date.now());
      this.agent.appendMessages(messages).catch(() => {});
      // Without a panel yet, the one Sidebar builds when it opens shows the thread, note included.
      panel?.chat.seed(messages, (text) => (isNoteMarker(text) ? undefined : { text }));
      panel?.chat.note("/known if you knew this · ask about it below");
    }
    if (!panel) return;
    panel.scrollToEnd();
    if (!panel.focused) panel.unread = true;
    this.render();
  }

  private async sidebarHeadsUp(arg: string): Promise<void> {
    const sub = arg.trim().toLowerCase();
    const change = headsUpChange(sub);
    if (change) {
      this.headsUp.setOn(change.on, change.where);
      this.panel?.notice({ kind: "info", text: headsUpChanged(change) });
    } else if (sub === "") this.noteLines(this.headsUp.summary().split("\n"));
    else this.panel?.notice({ kind: "warning", text: `Unknown /headsup argument "${sub}": /headsup, /headsup on, /headsup sidebar, /headsup off.` });
  }

  private async known(): Promise<void> {
    const note = await this.headsUp.markLastKnown().catch(() => undefined);
    this.panel?.notice(note ? { kind: "info", text: `Marked as known: ${note.text}` } : { kind: "info", text: "No heads-up note to mark yet." });
  }

  private submit(text: string): void {
    if (text === "/close") return this.close();
    if (text === "/known") {
      void this.known();
      return;
    }
    if (text === "/headsup" || text.startsWith("/headsup ")) {
      void this.sidebarHeadsUp(text.slice("/headsup".length));
      return;
    }
    if (text === "/new") {
      void this.reset();
      return;
    }
    if (text === "/model" || text.startsWith("/model ")) {
      void this.modelCommand(text.slice("/model".length));
      return;
    }
    if (text === "/quiz" || text.startsWith("/quiz ")) {
      void this.quizCommand(text.slice("/quiz".length));
      return;
    }
    if (text.startsWith("/") && !this.isSidebarCommand(text)) {
      this.panel?.notice({ kind: "warning", text: `Sidebar knows /new, /close, /model, /quiz, /known, /headsup, skills and prompt templates; ${text.split(/\s/)[0]} is a main-session command.` });
      return;
    }
    this.question(text);
  }

  /** A question for Sidebar's agent, after its cache preflight. */
  question(text: string): void {
    const check = this.agent.preflight();
    if (check.kind === "refuse") {
      this.panel?.notice({ kind: "warning", text: `Not sent: ${check.reason}` });
      this.panel?.input.setText(text);
      return;
    }
    if (check.kind === "confirm") {
      this.panel?.notice({ kind: "confirm", title: check.title, message: check.message, text });
      return;
    }
    this.send(text, false);
  }

  /** Skills (`/skill:name`) and prompt templates run in Sidebar as they do in main. */
  private isSidebarCommand(text: string): boolean {
    const name = text.slice(1).split(/\s/)[0] ?? "";
    try {
      return this.pi.getCommands().some((command) => command.name === name && (command.source === "skill" || command.source === "prompt"));
    } catch {
      return false;
    }
  }

  private send(text: string, confirmed: boolean): void {
    this.panel?.clearNotice();
    this.panel?.scrollToEnd();
    const failed = (error: unknown) => this.panel?.notice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    const cwd = this.main.ctx?.cwd;
    if (!this.quiz.on || !cwd) {
      this.agent.ask(text, confirmed).catch(failed);
      return;
    }
    // Quiz mode measures main's changes before each question; the status carries them.
    this.quiz
      .prepare(cwd)
      .catch(() => {})
      .then(() => {
        this.quiz.sent();
        return this.agent.ask(text, confirmed);
      })
      .catch(failed);
  }

  private onAgentEvent(event: SidebarEvent): void {
    const panel = this.panel;
    if (!panel) return;
    if (event.type === "sidebar_error") {
      panel.notice({ kind: "error", text: String(event.message) });
      return;
    }
    panel.apply(event);
    if (event.type === "agent_end" && !panel.focused) panel.unread = true;
    if (event.type === "agent_end") setTimeout(() => this.flushNotes(), 0);
    if (event.type === "agent_end" && this.agent.missed) {
      const choice = this.sidebarModel();
      const which = this.agent.missed.own && choice.kind === "other" ? `${choice.label}'s own cache` : "main's cache";
      panel.notice({ kind: "warning", text: `That answer missed ${which}; the next question asks first.` });
    }
    this.render();
  }

  private status(theme: Theme): StatusPart[] {
    const live = this.main.live;
    const now = Date.now();
    const parts: StatusPart[] = [{ text: theme.fg("dim", "read-only"), optional: 1 }];
    const choice = this.sidebarModel();
    if (choice.kind === "other") parts.unshift({ text: theme.fg("accent", choice.label) });
    else if (choice.kind === "unavailable") parts.unshift({ text: theme.fg("warning", `${choice.pattern} unavailable`) });
    if (this.quiz.on) {
      const c = this.quiz.counts();
      const figures = c ? [c.proven ? `${c.proven} proven` : "", c.shaky ? `${c.shaky} shaky` : "", c.due ? `${c.due} due` : ""].filter(Boolean) : [];
      parts.unshift({ text: theme.fg("accent", ["quiz", ...figures].join(" · ")) });
    }
    if (live.state === "working") {
      const tool = live.tools[live.tools.length - 1];
      parts.push({ text: tool ? `main: ${tool.name} ${ago(now - tool.startedAt)}` : `main working ${ago(now - live.since)}` });
    } else {
      parts.push({ text: theme.fg("dim", `main idle ${ago(now - live.since)}`) });
    }
    if (this.agent.missed) parts.push({ text: theme.fg("warning", this.agent.missed.own ? "missed its cache" : "missed main's cache") });
    else if (this.agent.lastAnswer) parts.push({ text: theme.fg("dim", this.agent.lastAnswer), optional: 2 });
    return parts;
  }

  private probe(ctx: ExtensionContext): FocusTui | undefined {
    let tui: FocusTui | undefined;
    try {
      ctx.ui.setWidget(PROBE, (t, theme) => {
        tui = t as FocusTui;
        this.theme = theme;
        return { render: () => [], invalidate() {} };
      });
      ctx.ui.setWidget(PROBE, undefined);
    } catch {
      return undefined;
    }
    return tui;
  }

  private render(): void {
    if (this.isOpen) this.tui?.requestRender();
  }

  // The header shows elapsed times; tick once a second while Sidebar is open.
  private startTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.render(), 1000);
    this.ticker.unref?.();
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }
}
