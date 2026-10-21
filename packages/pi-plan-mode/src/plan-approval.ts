// Plan review in the TUI: a full-screen reader. While you decide, the plan is the whole screen:
// no header, no hints, no rules. Enter brings up the choices over the end of the plan (only their
// rows, on a tinted background); Esc there goes back to reading. Elsewhere (RPC) it is Pi's own
// select, with "Edit the plan" as a row.
//
// Keys while reading: up/down or j/k scroll a line, Ctrl+D/U and PgDn/PgUp half or a whole page,
// g/G and Home/End the ends, and the wheel scrolls. Enter: the choices. Ctrl+G (Pi's
// app.editor.external): edit the plan. Esc: keep planning.
//
// herdr-web-ui cannot read this as a dialog (it needs Pi's hint line), so phones get its bare
// Enter/Esc card for plan review.
import { type ExtensionContext, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { FULL_SCREEN } from "./app/frame.js";
import { PlanMarkdown } from "./mermaid-art.js";

export const EDIT_CHOICE = "Edit the plan";
const EDIT_KEY = "app.editor.external";
/** The plan's column: wider prose is hard to read. */
const MAX_WIDTH = 100;

/**
 * Ask which of `options` to take after reading `plan`. Returns EDIT_CHOICE to edit, `keep` when
 * you leave the reader with Esc (the TUI only), and undefined when cancelled or aborted.
 */
export async function choosePlanApproval(
  ctx: ExtensionContext,
  plan: string,
  title: string,
  options: string[],
  keep: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function" || !editKeyBound()) {
    const withEdit = [...options.slice(0, -1), EDIT_CHOICE, ...options.slice(-1)];
    return ctx.ui.select(title, withEdit, { signal });
  }
  if (signal?.aborted) return undefined;
  let abort: (() => void) | undefined;
  try {
    return await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
      abort = () => done(undefined);
      signal?.addEventListener("abort", abort, { once: true });
      return new PlanReader(
        plan,
        options,
        keep,
        theme,
        () => tui.terminal.rows,
        done,
        () => tui.requestRender(),
      );
    }, FULL_SCREEN as never);
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

function editKeyBound() {
  try {
    return getKeybindings().getKeys(EDIT_KEY).length > 0;
  } catch {
    return false;
  }
}

export class PlanReader implements Component {
  private top = 0;
  private choosing = false;
  private selected = 0;
  private readonly markdown: PlanMarkdown;
  /** The last frame's page height and plan length, for paging and clamping. */
  private page = 10;
  private total = 0;

  constructor(
    plan: string,
    readonly options: string[],
    private readonly keep: string,
    private readonly theme: Theme,
    private readonly rows: () => number,
    private readonly done: (choice: string | undefined) => void,
    private readonly requestRender: () => void,
  ) {
    this.markdown = new PlanMarkdown(plan, getMarkdownTheme(), theme);
  }

  get isChoosing() {
    return this.choosing;
  }

  render(width: number): string[] {
    const height = Math.max(1, this.rows());
    const column = Math.max(1, Math.min(MAX_WIDTH, width - 2));
    const margin = " ".repeat(Math.max(1, Math.floor((width - column) / 2)));
    const plan = this.markdown.render(column).map((line) => margin + line);
    this.total = plan.length;
    this.page = height;
    this.top = Math.max(0, Math.min(this.top, plan.length - height));
    const lines = plan.slice(this.top, this.top + height);
    while (lines.length < height) lines.push("");
    if (!this.choosing) return lines.map((line) => truncateToWidth(line, width));
    const choices = this.options.map((option, index) => {
      const row = index === this.selected ? this.theme.fg("accent", `→ ${option}`) : `  ${option}`;
      const text = truncateToWidth(`${margin}${row}`, width);
      return this.theme.bg("selectedBg", text + " ".repeat(Math.max(0, width - visibleWidth(text))));
    });
    const kept = lines.slice(0, Math.max(0, height - choices.length)).map((line) => truncateToWidth(line, width));
    return [...kept, ...choices.slice(-height)];
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, EDIT_KEY)) {
      this.done(EDIT_CHOICE);
      return;
    }
    if (this.choosing) {
      if (kb.matches(data, "tui.select.up") || data === "k") this.move(-1);
      else if (kb.matches(data, "tui.select.down") || data === "j") this.move(1);
      else if (kb.matches(data, "tui.select.confirm") || data === "\n") this.done(this.options[this.selected]);
      else if (kb.matches(data, "tui.select.cancel")) this.setChoosing(false);
      return;
    }
    const half = Math.max(1, Math.floor(this.page / 2));
    if (kb.matches(data, "tui.select.confirm") || data === "\n") this.setChoosing(true);
    else if (kb.matches(data, "tui.select.cancel")) this.done(this.keep);
    else if (kb.matches(data, "tui.select.up") || data === "k") this.scroll(-1);
    else if (kb.matches(data, "tui.select.down") || data === "j") this.scroll(1);
    else if (matchesKey(data, "ctrl+u")) this.scroll(-half);
    else if (matchesKey(data, "ctrl+d")) this.scroll(half);
    else if (matchesKey(data, "pageUp")) this.scroll(-this.page);
    else if (matchesKey(data, "pageDown") || data === " ") this.scroll(this.page);
    else if (matchesKey(data, "home") || data === "g") this.scroll(-this.total);
    else if (matchesKey(data, "end") || data === "G") this.scroll(this.total);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      this.scroll(Math.sign(event.wheelDelta ?? 0) * 3);
      return { handled: true };
    }
    return event.type === "move" || event.type === "release" ? undefined : { handled: true };
  }

  private scroll(delta: number) {
    const next = Math.max(0, Math.min(this.top + delta, this.total - this.page));
    if (next === this.top) return;
    this.top = next;
    this.requestRender();
  }

  private setChoosing(on: boolean) {
    this.choosing = on;
    this.selected = 0;
    this.requestRender();
  }

  private move(step: number) {
    const next = Math.min(this.options.length - 1, Math.max(0, this.selected + step));
    if (next === this.selected) return;
    this.selected = next;
    this.requestRender();
  }

  invalidate(): void {
    this.markdown.invalidate();
  }
}
