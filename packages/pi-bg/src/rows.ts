// How pi-bg's tools and wake-ups read in the transcript: as command rows, like a Bash call that runs
// in the background. bg_run's result is one live line (`↳ fit running · 45% ████░░░░ · 2:14`, then
// `↳ fit exit 0 after 3:02`); bg_wait, bg_logs and bg_kill show their first line collapsed and their
// full report expanded; a wake-up is one `✓ …` row that expands to the report.
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { outcome, runtime } from "./format.ts";
import { bar, percent } from "./progress.ts";
import type { Task } from "./registry.ts";
import { blocksView } from "./result-view.ts";

type Content = { type: string; text?: string };
type Result = { content: Content[]; details?: unknown };

/** `fit running · 45% ████░░░░ · 2:14`, or `fit exit 0 after 3:02` once it ended. */
export function taskState(t: Task, now = Date.now()): string {
  if (t.status !== "running") return `${t.name} ${outcome(t)} after ${runtime(t, now)}`;
  const p = t.progress;
  return [`${t.name} ${outcome(t)}`, p ? `${percent(p)} ${bar(p.fraction, 8)}` : undefined, runtime(t, now)].filter(Boolean).join(" · ");
}

/** ` · ctrl+o to expand`, in the user's key; plain when Pi's theme is not up (tests, headless). */
const expandHint = (theme: Theme) => {
  let hint = "to expand";
  try {
    hint = keyHint("app.tools.expand", "to expand");
  } catch {
    // No theme yet.
  }
  return theme.fg("dim", ` · ${hint}`);
};

const firstLine = (result: Result) =>
  result.content
    .flatMap((c) => (c.type === "text" && c.text ? c.text.split("\n") : []))
    .find((l) => l.trim())
    ?.trim() ?? "Done";

const lineCount = (result: Result) => result.content.reduce((n, c) => n + (c.type === "text" && c.text ? c.text.split("\n").length : 0), 0);

/** One `↳ …` line, recomputed on every render so a running task stays current. */
class LineView implements Component {
  constructor(private readonly line: () => string) {}
  invalidate(): void {}
  render(width: number): string[] {
    return [truncateToWidth(this.line(), Math.max(1, width), "…")];
  }
}

/** bg_run's result: the task's live state; expanded, the start report under it. */
export function runResultView(result: Result, expanded: boolean, theme: Theme, task: () => Task | undefined): Component {
  const live = new LineView(() => {
    const t = task();
    if (!t) return theme.fg("muted", `↳ ${firstLine(result)}`);
    const failed = t.status === "failed" || t.status === "timeout";
    return theme.fg(failed ? "error" : "muted", `↳ ${taskState(t)}`);
  });
  if (!expanded) return live;
  const body = blocksView(result, true, theme);
  return {
    invalidate: () => body.invalidate(),
    render: (width) => [...live.render(width), "", ...body.render(width)],
  };
}

/** bg_wait, bg_logs and bg_kill: their first line collapsed, the whole report expanded. */
export function reportResultView(result: Result, expanded: boolean, theme: Theme, isError = false): Component {
  if (expanded) return blocksView(result, true, theme);
  const more = lineCount(result) > 1;
  const hint = more ? expandHint(theme) : "";
  return new LineView(() => theme.fg(isError ? "error" : "muted", `↳ ${firstLine(result)}`) + hint);
}

export interface WakeDetails {
  tasks?: { id: string; kind: "end" | "ready"; status: string }[];
}

/** A wake-up: `✓ Background job fit (ab12c) ended: exit 0 after 3:02.`; expanded, the reports. */
export function wakeView(content: string, details: WakeDetails | undefined, expanded: boolean, theme: Theme): Component {
  const statuses = details?.tasks?.map((t) => t.status) ?? [];
  const bad = statuses.some((s) => s === "failed" || s === "timeout");
  const stopped = !bad && statuses.length > 0 && statuses.every((s) => s === "killed");
  const icon = bad ? theme.fg("error", "✗") : stopped ? theme.fg("warning", "■") : theme.fg("success", "✓");
  const parts = content.split(/\n\n---\n\n/u);
  const heads = parts.map((p) => p.split("\n").find((l) => l.trim())?.trim() ?? "").filter(Boolean);
  const title = heads.length > 1 ? `${heads[0]} (+${heads.length - 1} more)` : (heads[0] ?? "Background task");
  const more = content.trim().split("\n").length > 1;
  const head = `${icon} ${theme.fg("toolTitle", title)}`;
  if (!expanded) {
    const hint = more ? expandHint(theme) : "";
    return new LineView(() => head + hint);
  }
  const body = new Text(content.split("\n").map((l) => theme.fg("toolOutput", l)).join("\n"), 2, 0);
  return {
    invalidate: () => body.invalidate(),
    render: (width) => [truncateToWidth(head, Math.max(1, width), "…"), ...body.render(width)],
  };
}
