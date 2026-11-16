// The body of the transcript card an answered questionnaire leaves: per question its header, the question,
// the answer(s), a preview and notes, then the note on all answers. The shared Block adds background and title.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Answer, type Details, shortenImagePaths } from "./result.ts";
import { expandHint } from "./transcript-style.ts";

const shown = (details: Details): Answer[] => details.answers.filter((a) => a.kind !== "skipped");

export function cardTitle(details: Details): string {
  return shown(details).length === 1 ? "Question" : "Questions";
}

export function cardDetail(details: Details): string | undefined {
  const all = shown(details);
  const unanswered = all.filter((a) => a.kind === "unanswered").length;
  return unanswered ? `${all.length - unanswered}/${all.length} answered` : undefined;
}

function para(first: string, rest: string, text: string, width: number): string[] {
  const avail = Math.max(1, width - visibleWidth(first));
  return text
    .split("\n")
    .flatMap((l) => wrapTextWithAnsi(l, avail))
    .map((l, i) => (i === 0 ? first : rest) + l);
}

export class AnswerCard implements Component {
  private readonly theme: Theme;
  private readonly details: Details;
  private readonly expanded: boolean;
  constructor(theme: Theme, details: Details, expanded: boolean) {
    this.theme = theme;
    this.details = details;
    this.expanded = expanded;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const { theme, details } = this;
    const short = (s: string) => shortenImagePaths(s, details.images);
    const out: string[] = [];
    for (const a of shown(details)) {
      if (out.length) out.push("");
      out.push(...para("", "", theme.bold(theme.fg("accent", a.header || a.question)), width));
      if (a.header && a.question.trim() !== a.header.trim()) out.push(...para("", "", theme.fg("muted", a.question), width));
      const unanswered = a.kind === "unanswered";
      const mark = "  " + theme.fg(unanswered ? "warning" : "success", "›") + " ";
      let lines: string[];
      if (unanswered) lines = para(mark, "    ", theme.fg("warning", "Unanswered"), width);
      else if (a.kind === "multi") lines = (a.selected ?? [a.answer ?? ""]).flatMap((s) => para(mark, "    ", short(s), width));
      else if (a.kind === "custom") lines = para(mark, "    ", theme.fg("muted", "wrote: ") + short(a.answer ?? ""), width);
      else lines = para(mark, "    ", short(a.answer ?? ""), width);
      const preview = a.kind === "option" && a.preview ? a.preview : undefined;
      if (preview && !this.expanded && lines.length) {
        const last = lines.length - 1;
        lines[last] = truncateToWidth(lines[last]! + theme.fg("dim", " · preview") + expandHint(theme), width, "…");
      }
      out.push(...lines);
      if (preview && this.expanded) {
        for (const line of preview.split("\n")) out.push(truncateToWidth("    " + theme.fg("dim", "│ ") + theme.fg("muted", line), width, "…"));
      }
      if (a.notes) out.push(...para("    ", "    ", theme.italic(theme.fg("dim", "note: " + short(a.notes))), width));
    }
    if (!out.length) return [theme.fg("dim", "No answers")];
    if (details.note) {
      out.push("");
      out.push(...para("", "", theme.fg("dim", "Note: ") + theme.italic(short(details.note)), width));
    }
    return out;
  }
}
