// The draft in the transcript, drawn with the suite's review card (review-card.ts, shared with
// pi-plan-mode), so it looks like a plan waiting for approval: "Compaction plan review" on the
// tool background, the focus as Markdown, then the status ("Waiting for approval", "✓ Compacted
// with this focus", "Cancelled"). The entry is a custom session entry (never sent to the model)
// appended once per /compact-plan run; edits and revisions update it in memory while you review,
// and the outcome entry records the final text and status so a reloaded session draws the same.
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown } from "@earendil-works/pi-tui";
import { type ReviewStatus, reviewBody, reviewCard } from "./review-card.ts";

export const ENTRY = "compact-plan";
export const OUTCOME_ENTRY = "compact-plan-outcome";

export type Status = "drafting" | "pending" | "compacting" | "compacted" | "cancelled" | "failed";

export interface DraftState {
  goal: string;
  draft: string;
  status: Status;
  edited?: boolean;
  /** Approved with "compact and continue": the next step is sent once compacted. */
  continued?: boolean;
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

/** The card's status line: what happened, then the goal and (once compacted) the drafting cost. */
export function reviewStatus(state: DraftState): ReviewStatus {
  const parts = [state.goal ? `next: ${state.goal.replace(/\s+/gu, " ")}` : ""];
  if (state.status === "compacted" && state.tokens) {
    parts.push(`drafting read ${state.tokens.toLocaleString("en-US")} tokens, ${state.cached ?? 0}% cached`);
  }
  const context = parts.filter(Boolean).join(" · ") || undefined;
  switch (state.status) {
    case "drafting":
      return { tone: "pending", text: "Revising…", context };
    case "pending":
      return { tone: "pending", text: "Waiting for approval", context };
    case "compacting":
      return { tone: "pending", text: "Compacting…", context };
    case "compacted":
      return { tone: "success", text: `✓ Compacted with this focus${state.edited ? " (edited)" : ""}${state.continued ? ", continuing" : ""}`, context };
    case "cancelled":
      return { tone: "warning", text: "Cancelled", context };
    case "failed":
      return { tone: "error", text: `Compaction failed${state.error ? `: ${state.error}` : ""}`, context };
  }
}

/** The transcript card. Reads its state at render time, so edits and outcomes show as they happen. */
export class DraftView implements Component {
  private cache: { key: string; lines: string[] } | undefined;

  constructor(
    private readonly state: () => DraftState,
    private readonly theme: Theme,
    private readonly expanded: () => boolean = () => false,
  ) {}

  render(width: number): string[] {
    const state = this.state();
    const status = reviewStatus(state);
    const expanded = this.expanded();
    const key = JSON.stringify([width, state.draft, status, expanded]);
    if (this.cache?.key !== key) {
      const body = reviewBody(this.theme, state.draft, status, { expanded }, (text) => new Markdown(text, 0, 0, getMarkdownTheme()));
      const title = status.tone === "pending" ? "Compaction plan review" : "Compaction plan";
      this.cache = { key, lines: reviewCard(this.theme, title, body, status.tone).render(width) };
    }
    return this.cache.lines;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
