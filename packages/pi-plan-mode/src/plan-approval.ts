// The plan approval picker. In the TUI it is a compact version of Pi's selector, so more of the
// plan stays on screen: no blank rows around the dialog, and "Edit the plan" is a key (Pi's
// app.editor.external, Ctrl+G by default) shown in the hint instead of a row. Elsewhere (RPC) it
// is Pi's own select, with "Edit the plan" as a row.
//
// herdr-web-ui reads the screen into a phone card, so the layout keeps what its Pi parser needs:
// the question, a blank line, one row per option (` → ` on the cursor's, three spaces on the
// others, the cursor on the first), then a hint ending in Pi's `↑↓ navigate  enter select
// escape/ctrl+c cancel`.
import { type ExtensionContext, keyHint, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const EDIT_CHOICE = "Edit the plan";
const EDIT_KEY = "app.editor.external";

/** Ask which of `options` to take; EDIT_CHOICE when you ask to edit, undefined on cancel. */
export async function choosePlanApproval(
  ctx: ExtensionContext,
  title: string,
  options: string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  const editKey = editKeyBound();
  const withEdit = [...options.slice(0, -1), EDIT_CHOICE, ...options.slice(-1)];
  if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function" || !editKey)
    return ctx.ui.select(title, withEdit, { signal });
  if (signal?.aborted) return undefined;
  let abort: (() => void) | undefined;
  try {
    return await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
      abort = () => done(undefined);
      signal?.addEventListener("abort", abort, { once: true });
      return new ApprovalPicker(title, options, theme, done, () => tui.requestRender());
    });
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

export class ApprovalPicker implements Component {
  private selected = 0;

  constructor(
    private readonly title: string,
    private readonly options: string[],
    private readonly theme: Theme,
    private readonly done: (choice: string | undefined) => void,
    private readonly requestRender: () => void,
  ) {}

  render(width: number): string[] {
    const theme = this.theme;
    const inner = Math.max(1, width - 2);
    const pad = (line: string) => ` ${line}`;
    const lines = [theme.fg("border", "─".repeat(Math.max(1, width)))];
    for (const line of wrapTextWithAnsi(theme.fg("accent", theme.bold(this.title)), inner)) lines.push(pad(line));
    lines.push("");
    this.options.forEach((option, index) => {
      const row = index === this.selected ? theme.fg("accent", `→ ${option}`) : `  ${theme.fg("text", option)}`;
      lines.push(pad(truncateToWidth(row, inner)));
    });
    const hint = [
      keyHint(EDIT_KEY, "edit"),
      rawKeyHint("↑↓", "navigate"),
      keyHint("tui.select.confirm", "select"),
      keyHint("tui.select.cancel", "cancel"),
    ].join("  ");
    for (const line of wrapTextWithAnsi(hint, inner)) lines.push(pad(line));
    return lines;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, EDIT_KEY)) this.done(EDIT_CHOICE);
    else if (kb.matches(data, "tui.select.up") || data === "k") this.move(-1);
    else if (kb.matches(data, "tui.select.down") || data === "j") this.move(1);
    else if (kb.matches(data, "tui.select.confirm") || data === "\n") this.done(this.options[this.selected]);
    else if (kb.matches(data, "tui.select.cancel")) this.done(undefined);
  }

  private move(step: number) {
    const next = Math.min(this.options.length - 1, Math.max(0, this.selected + step));
    if (next === this.selected) return;
    this.selected = next;
    this.requestRender();
  }

  invalidate(): void {}
}
