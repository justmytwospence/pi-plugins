// Ties Sidebar together in main's process: opening, focus, the layout, the panel, the agent and the
// thread stored in main's session.
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { ago, SidebarAgent, type SidebarEvent } from "./child.ts";
import { MIN_COLUMNS_ENV, parseMinColumns, parseRatio, RATIO_ENV } from "./config.ts";
import { canSplit, dividerLines, SplitLayout } from "./layout.ts";
import { MainState } from "./main-state.ts";
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

  constructor(private readonly pi: ExtensionAPI, private readonly keys: string[]) {
    this.main = new MainState(pi);
    this.agent = new SidebarAgent(pi, this.main);
    this.agent.onEvent((event) => this.onAgentEvent(event));
    this.main.onChange(() => this.render());

    pi.on("session_start", async (_event, ctx) => this.restore(ctx));
    pi.on("session_tree", async (_event, ctx) => this.restore(ctx));
    pi.on("session_shutdown", async () => {
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

  /** Ctrl+' from main: open Sidebar if it is closed, otherwise move focus to it. */
  openOrFocus(ctx: ExtensionContext): void {
    if (!this.isOpen && !this.open(ctx)) return;
    this.focusSidebar();
  }

  /** `/sidebar`: open it, or hide it when it is open (the thread is kept). */
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
        isBusy: () => this.agent.busy,
        matchesToggle: (data) => this.matchesToggle(data),
      });
      this.panel.chat.seed(this.agent.messages, (text) => ({ text }));
      const theme = () => this.theme ?? ctx.ui.theme;
      this.layout = new SplitLayout(tui, this.panel.root, {
        ratio: parseRatio(process.env[RATIO_ENV]),
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
    if (current && current !== panel.input) this.mainFocus = current;
    panel.unread = false;
    tui.setFocus(panel.input);
    tui.requestRender();
  }

  focusMain(): void {
    const tui = this.tui;
    if (!tui) return;
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
    if (text.startsWith("/")) {
      this.panel?.notice({ kind: "warning", text: `Sidebar knows /new and /close; ${text.split(/\s/)[0]} is a main-session command.` });
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

  private send(text: string, confirmed: boolean): void {
    this.panel?.clearNotice();
    this.panel?.followEnd();
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
    panel.chat.apply(event);
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
