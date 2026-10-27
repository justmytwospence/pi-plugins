// The draft in the transcript, drawn as plan mode draws a plan waiting for approval: the text as
// Markdown, a blank line, then one status line ("Waiting for approval", "✓ Compacted with this
// focus", "Cancelled"). The entry is a custom session entry (never sent to the model) appended once
// per /compact-plan run; edits and revisions update it in memory while you review, and the outcome
// entry records the final text and status so a reloaded session draws the same thing.
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

export const ENTRY = "compact-plan";
export const OUTCOME_ENTRY = "compact-plan-outcome";

export type Status = "drafting" | "pending" | "compacting" | "compacted" | "cancelled" | "failed";

export interface DraftState {
  goal: string;
  draft: string;
  status: Status;
  edited?: boolean;
  /** Drafting input tokens, and the share read from the prompt cache (0-100). */
  tokens?: number;
  cached?: number;
  error?: string;
}

export interface DraftEntry {
  id: string;
  goal: string;
  draft: string;
}

export interface OutcomeEntry extends DraftState {
  id: string;
}

export function statusLine(state: DraftState, theme: Theme): string {
  const stats = state.tokens ? theme.fg("dim", ` · drafting read ${state.tokens.toLocaleString("en-US")} tokens, ${state.cached ?? 0}% from cache`) : "";
  switch (state.status) {
    case "drafting":
      return theme.fg("muted", "Revising…");
    case "pending":
      return theme.fg("muted", "Waiting for approval");
    case "compacting":
      return theme.fg("muted", "Compacting…");
    case "compacted":
      return theme.fg("success", `✓ Compacted with this focus${state.edited ? " (edited)" : ""}`) + stats;
    case "cancelled":
      return theme.fg("warning", "Cancelled");
    case "failed":
      return theme.fg("error", `Compaction failed${state.error ? `: ${state.error}` : ""}`);
  }
}

/** The transcript block: title, the draft as Markdown, then the status. Reads its state at render time. */
export class DraftView implements Component {
  private cache: { width: number; text: string; lines: string[] } | undefined;

  constructor(
    private readonly state: () => DraftState,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const state = this.state();
    const title = new Text(
      this.theme.fg("accent", this.theme.bold("Compaction focus")) + (state.goal ? this.theme.fg("dim", ` · ${state.goal.replace(/\s+/gu, " ")}`) : ""),
      1,
      0,
    );
    if (this.cache?.width !== width || this.cache.text !== state.draft) {
      this.cache = { width, text: state.draft, lines: new Markdown(state.draft, 1, 0, getMarkdownTheme()).render(width) };
    }
    return [
      ...title.render(width),
      ...new Spacer(1).render(width),
      ...this.cache.lines,
      ...new Spacer(1).render(width),
      ...new Text(statusLine(state, this.theme), 1, 0).render(width),
    ];
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
