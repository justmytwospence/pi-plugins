/**
 * The review card: a document waiting for the user's approval in the transcript, then its outcome.
 * pi-plan-mode draws plans with it and pi-compact-plan draws compaction focuses, so both look the
 * same (this file is copied byte for byte; the suite's contract test keeps the copies identical).
 *
 * Layout, from the top: a bold title ("Plan review" while waiting, "Plan" after), the document as
 * Markdown, a blank line, then one status line (muted while waiting, green once approved, yellow
 * when set aside, red on failure) with dim context after ` · `. Once decided, a long document folds
 * to its first lines until the transcript is expanded (ctrl+o).
 *
 * A tool's result is already drawn on a tool background by Pi; `reviewCard` adds the same shell
 * (padded box, the background for the outcome) for hosts that are not tool rows, such as a custom
 * session entry. Pi puts the blank line above both.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Spacer, Text } from "@earendil-works/pi-tui";

/** Lines a decided document keeps before it folds. */
export const COLLAPSED_LINES = 12;

export type ReviewTone = "pending" | "success" | "warning" | "error";

export interface ReviewStatus {
  tone: ReviewTone;
  text: string;
  /** Dim text after the status, e.g. the plan file. */
  context?: string;
}

const TONE_COLOR = { pending: "muted", success: "success", warning: "warning", error: "error" } as const;

export function reviewStatusLine(theme: Theme, status: ReviewStatus): string {
  const context = status.context ? theme.fg("dim", ` · ${status.context}`) : "";
  return `${theme.fg(TONE_COLOR[status.tone], status.text)}${context}`;
}

export function reviewTitle(theme: Theme, title: string): Component {
  return new Text(theme.fg("toolTitle", theme.bold(title)), 0, 0);
}

/**
 * The document and its status. `markdown` draws a slice of the text (plan mode's draws Mermaid
 * diagrams too). A pending document is shown in full: you are deciding on it.
 */
export function reviewBody(
  theme: Theme,
  text: string,
  status: ReviewStatus,
  options: { expanded: boolean },
  markdown: (text: string) => Component,
): Container {
  const container = new Container();
  const lines = text.split("\n");
  const folded = status.tone !== "pending" && !options.expanded && lines.length > COLLAPSED_LINES;
  container.addChild(markdown(folded ? lines.slice(0, COLLAPSED_LINES).join("\n") : text));
  if (folded) {
    const more = lines.length - COLLAPSED_LINES;
    container.addChild(
      new Text(theme.fg("dim", `… ${more} more line${more === 1 ? "" : "s"} (ctrl+o to expand)`), 0, 0),
    );
  }
  container.addChild(new Spacer(1));
  container.addChild(new Text(reviewStatusLine(theme, status), 0, 0));
  return container;
}

/** Pi's tool row shell around a title and body, for a card that is not a tool result. */
export function reviewCard(theme: Theme, title: string, body: Component, tone: ReviewTone): Component {
  const background =
    tone === "pending" ? "toolPendingBg" : tone === "error" ? "toolErrorBg" : ("toolSuccessBg" as const);
  const box = new Box(1, 1, (line) => theme.bg(background, line));
  box.addChild(reviewTitle(theme, title));
  box.addChild(body);
  return box;
}
