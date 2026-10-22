// A view framed and keyed like Pi's own `/mcp` manager (dist/extensions/mcp/ui.js): accent rules,
// a bold accent title, muted body text, a dim key-hint footer, and Pi's select list for menus.

import { DynamicBorder, getSelectListTheme, keyHint, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, Text, truncateToWidth, visibleWidth, type Component, type SelectItem, type TUI } from "@earendil-works/pi-tui";

const MAX_VISIBLE_ITEMS = 12;

export function frame(theme: Theme, title: string, body: Component[], footer?: string): Container {
  const container = new Container();
  container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
  container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
  for (const child of body) container.addChild(child);
  if (footer) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", footer), 1, 0));
  }
  container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
  return container;
}

export class DeviceLoginView implements Component {
  private content: Component;
  private inputHandler?: (data: string) => void;
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;

  constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.content = frame(theme, "MCP device sign-in", [new Text(theme.fg("muted", "Loading…"), 1, 1)]);
  }

  setContent(content: Component, inputHandler?: (data: string) => void): void {
    this.content = content;
    this.inputHandler = inputHandler;
    this.tui.requestRender();
  }

  /** A menu like `/mcp`'s; resolves to the chosen value, or undefined when cancelled. */
  menu(title: string, items: SelectItem[], details?: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const body: Component[] = [];
      if (details) body.push(new Text(this.theme.fg("muted", details), 1, 0));
      body.push(new Spacer(1));
      const list = new SelectList(items, Math.min(items.length, MAX_VISIBLE_ITEMS), getSelectListTheme());
      list.onSelect = (item) => resolve(item.value);
      list.onCancel = () => resolve(undefined);
      body.push(list);
      const footer = `${keyHint("tui.select.confirm", "sign in")} • ${keyHint("tui.select.cancel", "close")}`;
      this.setContent(frame(this.theme, title, body, footer), (data) => list.handleInput(data));
    });
  }

  /** A read-only screen; `keys` maps keybinding ids to actions. */
  screen(title: string, body: Component[], footer: string | undefined, keys: Record<string, () => void> = {}): void {
    this.setContent(frame(this.theme, title, body, footer), (data) => {
      for (const [id, action] of Object.entries(keys)) {
        if (this.keybindings.matches(data, id as never)) {
          action();
          return;
        }
      }
    });
  }

  handleInput(data: string): void {
    this.inputHandler?.(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    return this.content.render(width).map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
  }

  invalidate(): void {
    this.content.invalidate();
  }
}
