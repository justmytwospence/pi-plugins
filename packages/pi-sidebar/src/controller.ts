// Ties Sidebar together in main's process: opening, focus, the layout, the panel, the agent and the
// thread stored in main's session.
import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { ago, SidebarAgent, type SidebarEvent } from "./child.ts";
import { MIN_COLUMNS_ENV, parseMinColumns, parseRatio, PREFS_ENV, RATIO_ENV } from "./config.ts";
import { canSplit, dividerLines, SplitLayout } from "./layout.ts";
import { MainState } from "./main-state.ts";
import { RatioStore } from "./preferences.ts";
import { herdrFocus, navDirection, navTarget } from "./nav.ts";
import { SidebarPanel, type StatusPart } from "./panel.ts";
import { RESET_ENTRY, threadFromBranch } from "./thread.ts";

const PROBE = "pi-sidebar-probe";
const HERDR_BLOCKED = "herdr:blocked";

type FocusTui = TUI & { getFocusedComponent?(): Component | null };

export class SidebarController {
  readonly main: MainState;
  readonly agent: SidebarAgent;
  private tui: FocusTui | undefined;
  private theme: Theme | undefined;
  private panel: SidebarPanel | undefined;
  private layout: SplitLayout | undefined;
  private mainFocus: Component | null = null;
  private blocked = 0;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private releaseInput: (() => void) | undefined;
  /** Sidebar's share per orientation: what you dragged the divider to, else PI_SIDEBAR_RATIO. */
  readonly ratios = new RatioStore(process.env[PREFS_ENV] ?? path.join(getAgentDir(), "pi-sidebar.json"), parseRatio(process.env[RATIO_ENV]));

  constructor(private readonly pi: ExtensionAPI, private readonly keys: string[], private readonly focusKeys: string[] = []) {
    this.main = new MainState(pi);
    this.agent = new SidebarAgent(pi, this.main);
    this.agent.onEvent((event) => this.onAgentEvent(event));
    this.main.onChange(() => this.render());

    pi.on("session_start", async (_event, ctx) => {
      this.listen(ctx);
      await this.restore(ctx);
    });
    pi.on("session_tree", async (_event, ctx) => this.restore(ctx));
    pi.on("session_shutdown", async () => {
      this.releaseInput?.();
      this.releaseInput = undefined;
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
        mainHidesThinking: () => {
          try { return (this.pi.getSettings() as { hideThinkingBlock?: boolean }).hideThinkingBlock === true; } catch { return false; }
        },
      });
      this.panel.chat.seed(this.agent.messages, (text) => ({ text }));
      // Pi sends keyboard scrolling, `tui.scrollBy` (pi-vim's Ctrl+U/D), its transcript search, the
      // end indicator and leftover wheel scrolling to the primary scroll view; the last primary view in
      // the layout wins, and Sidebar comes after main. So the focused half gets them (pi-stereo-view's
      // approach).
      const panel = this.panel;
      Object.defineProperty(panel.view, "primary", {
        get: () => this.panel === panel && this.isOpen && panel.focused && this.blocked === 0,
        configurable: true,
      });
      const theme = () => this.theme ?? ctx.ui.theme;
      this.layout = new SplitLayout(tui, this.panel.root, {
        ratio: (orientation) => this.ratios.get(orientation),
        setRatio: (orientation, ratio, final) => this.ratios.set(orientation, ratio, final),
        scrollSidebar: (lines) => panel.view.scrollBy(lines),
        sidebarPrimary: () => panel.view.primary,
        minColumns: parseMinColumns(process.env[MIN_COLUMNS_ENV]),
        collapsed: () => this.blocked > 0,
        focused: () => !!this.panel?.focused,
        divider: (orientation, focused, width) => dividerLines(orientation, width, (text) => theme().fg(focused ? "borderAccent" : "borderMuted", text)),
      });
    }
    if (!this.layout!.mount()) return false;
    this.startTicker();
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
    this.releaseInput = ctx.ui.onTerminalInput((data) => {
      const direction = navDirection(data);
      if (direction) {
        const target = navTarget(direction, this.isOpen && this.blocked === 0, this.layout?.orientation ?? "right", !!this.panel?.focused);
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

  private async restore(ctx: ExtensionContext): Promise<void> {
    this.main.bind(ctx);
    await this.agent.setThread(threadFromBranch(ctx.sessionManager.getBranch()));
    this.rebuild();
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

  private submit(text: string): void {
    if (text === "/close") return this.close();
    if (text === "/new") {
      void this.reset();
      return;
    }
    if (text.startsWith("/") && !this.isSidebarCommand(text)) {
      this.panel?.notice({ kind: "warning", text: `Sidebar knows /new, /close, skills and prompt templates; ${text.split(/\s/)[0]} is a main-session command.` });
      return;
    }
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
    this.agent.ask(text, confirmed).catch((error) => {
      this.panel?.notice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    });
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
    if (event.type === "agent_end" && this.agent.missed) {
      panel.notice({ kind: "warning", text: "That answer missed main's cache; the next question asks first." });
    }
    this.render();
  }

  private status(theme: Theme): StatusPart[] {
    const live = this.main.live;
    const now = Date.now();
    const parts: StatusPart[] = [{ text: theme.fg("dim", "read-only"), optional: 1 }];
    if (live.state === "working") {
      const tool = live.tools[live.tools.length - 1];
      parts.push({ text: tool ? `main: ${tool.name} ${ago(now - tool.startedAt)}` : `main working ${ago(now - live.since)}` });
    } else {
      parts.push({ text: theme.fg("dim", `main idle ${ago(now - live.since)}`) });
    }
    if (this.agent.missed) parts.push({ text: theme.fg("warning", "missed main's cache") });
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
