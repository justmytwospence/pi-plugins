import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  type KeybindingsManager,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

interface PlanNameOptions {
  suggestion?: string;
  directory: string;
}

const TITLE = "Save plan as";
const HINT = "enter submit  escape/ctrl+c cancel";
const USE_SUGGESTION = "Use suggested name";
const ENTER_NAME = "Enter different name";
const CANCEL = "Cancel";

function display(text: string): string {
  return stripVTControlCharacters(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
}

/** One ordinary Pi dialog, with a real, editable initial value (not a placeholder). */
export class PlanNameInput implements Component, Focusable {
  private readonly input = new Input({ prompt: "› " });
  private finished = false;
  private readonly onAbort = () => this.finish(undefined);

  constructor(
    private readonly options: PlanNameOptions,
    private readonly theme: Theme,
    private readonly keybindings: Pick<KeybindingsManager, "matches">,
    private readonly requestRender: () => void,
    private readonly done: (value: string | undefined) => void,
    private readonly signal?: AbortSignal,
  ) {
    this.input.setValue(options.suggestion ?? "");
    // setValue preserves the cursor; use the public editing API to move to the end.
    this.input.handleInput("\x05");
    this.input.onSubmit = (value) => this.finish(value);
    this.input.onEscape = () => this.finish(undefined);
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  private finish(value: string | undefined): void {
    if (this.finished) return;
    this.finished = true;
    this.dispose();
    this.done(value);
  }

  dispose(): void {
    this.finished = true;
    this.signal?.removeEventListener("abort", this.onAbort);
  }

  invalidate(): void {
    this.input.invalidate();
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.finish(undefined);
      return;
    }
    this.input.handleInput(data);
    if (!this.finished) this.requestRender();
  }

  render(width: number): string[] {
    const rule = this.theme.fg("border", "─".repeat(Math.max(0, width)));
    const contentWidth = Math.max(1, width - 2);
    const text = (value: string) => wrapTextWithAnsi(value, contentWidth).map((line) => ` ${line}`);
    return [
      rule,
      "",
      ...text(this.theme.fg("accent", this.theme.bold(TITLE))),
      ...text(this.theme.fg("muted", `Destination: ${display(this.options.directory)}`)),
      ...text(this.theme.fg("dim", "The .md extension is added automatically.")),
      "",
      ...this.input.render(contentWidth).map((line) => ` ${line}`),
      "",
      ...text(this.theme.fg("dim", HINT)),
      rule,
    ].map((line) => truncateToWidth(line, width));
  }
}

export async function promptPlanName(
  ctx: ExtensionContext,
  options: PlanNameOptions,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!ctx.hasUI || signal?.aborted) return undefined;
  if (ctx.mode === "tui") {
    let component: PlanNameInput | undefined;
    try {
      return await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
        component = new PlanNameInput(options, theme, keybindings, () => tui.requestRender(), done, signal);
        return component;
      });
    } finally {
      component?.dispose();
    }
  }
  if (options.suggestion) {
    const choice = await ctx.ui.select(
      `${TITLE} ${display(options.suggestion)}.md`,
      [USE_SUGGESTION, ENTER_NAME, CANCEL],
      { signal },
    );
    if (signal?.aborted) return undefined;
    if (choice === USE_SUGGESTION) return options.suggestion;
    if (choice !== ENTER_NAME) return undefined;
  }
  const value = await ctx.ui.input(TITLE, undefined, { signal });
  return signal?.aborted ? undefined : value;
}
