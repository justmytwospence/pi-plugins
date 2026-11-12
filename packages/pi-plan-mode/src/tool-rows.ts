// Shared drawing for this package's own-renderer tools (renderShell "self"): a one-line call row,
// then a dim `↳` result line collapsed or a tone block expanded.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { Block, expandHint, Row, type Tone, toneOfTool } from "./transcript-style.js";

type Paint = Pick<Theme, "fg" | "bg">;
interface ToolContext {
  isError?: boolean;
  isPartial?: boolean;
  executionStarted?: boolean;
  lastComponent?: unknown;
}

/** The call row; its tone follows the tool's lifecycle. */
export function toolCallRow(theme: Paint, context: ToolContext, title: string, detail?: () => string | undefined): Component {
  return new Row(theme, () => ({
    tone: toneOfTool(context, context.lastComponent !== undefined),
    title,
    detail: detail?.(),
  }));
}

/** A dim `   ↳ line` with an expand hint when there is more to show. */
export class ResultLine implements Component {
  constructor(
    private readonly theme: Paint,
    private readonly line: string,
    private readonly more: boolean,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const first = this.line.split("\n")[0] ?? "";
    const text = this.theme.fg("dim", `   ↳ ${first.replace(/\s+/gu, " ").trim()}`) + (this.more ? expandHint(this.theme) : "");
    return [truncateToWidth(text, Math.max(1, width), "…")];
  }
}

/** Collapsed: `↳` line (plus hint when there is more). Expanded: a Block with the full body. */
export function toolResultView(
  theme: Paint,
  options: { expanded: boolean },
  view: { tone: Tone; title: string; summary: string; body: string; fold?: number },
): Component {
  if (options.expanded) {
    return new Block(theme, () => ({ tone: view.tone, title: view.title, body: view.body, fold: view.fold ?? 0, expanded: true }));
  }
  return new ResultLine(theme, view.summary, view.body.trim() !== view.summary.trim() && view.body.includes("\n"));
}

/** Result tone for a finished call: failed when the tool errored, stopped when it was cancelled. */
export function resultTone(context: ToolContext, cancelled = false): Tone {
  if (context.isError) return "failed";
  if (cancelled) return "stopped";
  return context.isPartial ? "running" : "done";
}
