// How pi-bg's tools and wake-ups read in the transcript: as command rows, like a Bash call that runs
// in the background. bg_run's result is one live line (`↳ fit running · 45% ████░░░░ · 2:14`, then
// `↳ fit exit 0 after 3:02`); bg_wait, bg_logs and bg_kill show their first line collapsed and their
// full report expanded; a wake-up is one `✓ …` row that expands to the report.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { outcome, runtime } from "./format.ts";
import { bar, percent } from "./progress.ts";
import type { Task } from "./registry.ts";
import { blocksView } from "./result-view.ts";
import { Block, expandHint, rowLine, type Tone } from "./transcript-style.ts";

type Content = { type: string; text?: string };
type Result = { content: Content[]; details?: unknown };

/** `fit running · 45% ████░░░░ · 2:14`, or `fit exit 0 after 3:02` once it ended. */
export function taskState(t: Task, now = Date.now()): string {
  if (t.status !== "running") return `${t.name} ${outcome(t)} after ${runtime(t, now)}`;
  const p = t.progress;
  return [`${t.name} ${outcome(t)}`, p ? `${percent(p)} ${bar(p.fraction, 8)}` : undefined, runtime(t, now)].filter(Boolean).join(" · ");
}

/** Kept for callers that pass Pi's key hint; the shared expand hint reads the key itself. */
export type KeyHint = (keybinding: string, description: string) => string;

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
    if (!t) return theme.fg("muted", `   ↳ ${firstLine(result)}`);
    const failed = t.status === "failed" || t.status === "timeout";
    return theme.fg(failed ? "error" : "muted", `   ↳ ${taskState(t)}`);
  });
  if (!expanded) return live;
  const body = blocksView(result, true, theme);
  const inner: Component = {
    invalidate: () => body.invalidate(),
    render: (width) => [...live.render(width), "", ...body.render(width)],
  };
  return new Block(theme, () => {
    const t = task();
    const tone: Tone = !t ? "done" : t.status === "running" ? "running" : t.status === "failed" || t.status === "timeout" ? "failed" : t.status === "killed" ? "stopped" : "done";
    return { tone, title: "Background job", body: inner, expanded: true };
  });
}

/** bg_wait, bg_logs and bg_kill: their first line collapsed, the whole report in a block expanded. */
export function reportResultView(result: Result, expanded: boolean, theme: Theme, isError = false, title = "Background job"): Component {
  if (expanded) return new Block(theme, () => ({ tone: isError ? "failed" : "done", title, body: blocksView(result, true, theme), expanded: true }));
  const more = lineCount(result) > 1;
  const hint = more ? expandHint(theme) : "";
  return new LineView(() => theme.fg(isError ? "error" : "muted", `   ↳ ${firstLine(result)}`) + hint);
}

export interface WakeDetails {
  tasks?: { id: string; kind: "end" | "ready"; status: string }[];
}

/** A wake-up: `✓ Background job fit (ab12c) ended: exit 0 after 3:02.`; expanded, the reports. */
export function wakeView(content: string, details: WakeDetails | undefined, expanded: boolean, theme: Theme, time?: number | string): Component {
  const statuses = details?.tasks?.map((t) => t.status) ?? [];
  const bad = statuses.some((s) => s === "failed" || s === "timeout");
  const stopped = !bad && statuses.length > 0 && statuses.every((s) => s === "killed");
  const tone: Tone = bad ? "failed" : stopped ? "stopped" : "done";
  const parts = content.split(/\n\n---\n\n/u);
  const heads = parts.map((p) => p.split("\n").find((l) => l.trim())?.trim() ?? "").filter(Boolean);
  const title = heads.length > 1 ? `${heads[0]} (+${heads.length - 1} more)` : (heads[0] ?? "Background task");
  const more = content.trim().split("\n").length > 1;
  const head = (width: number, hint?: string) => rowLine(theme, { tone, title, hint, time }, width);
  if (!expanded) {
    const hint = more ? expandHint(theme) : "";
    return { invalidate() {}, render: (width) => [head(Math.max(1, width), hint)] };
  }
  const body = new Text(content.split("\n").map((l) => theme.fg("toolOutput", l)).join("\n"), 2, 0);
  return {
    invalidate: () => body.invalidate(),
    render: (width) => [head(Math.max(1, width)), ...body.render(width)],
  };
}
