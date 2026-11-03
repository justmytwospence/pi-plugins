// The heads-up note above main's editor (the `main` placement), and its choices. A digit typed on its own into main's empty
// editor answers it; nothing else is taken from the editor.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { graphemes, MAX_POST_GRAPHEMES, type HeadsUpNote } from "./protocol.ts";

export const DISMISSED_MS = 20_000;

export type NotePhase = "note" | "detail" | "dismissed" | "post" | "busy";

export type NoteAction =
  | { type: "expand" }
  | { type: "known"; via: "knew" | "understood" | "declined" }
  | { type: "dismiss" }
  | { type: "ask-main" }
  | { type: "ask-sidebar" }
  | { type: "turn-off" }
  | { type: "review-post" }
  | { type: "publish" }
  | { type: "edit-post" }
  | { type: "back" }
  | { type: "draft"; kind: "full" | "outline" };

const CHOICES: Record<"note" | "detail" | "dismissed", Array<[string, NoteAction, string]>> = {
  note: [["1", { type: "expand" }, "learn more"], ["2", { type: "known", via: "knew" }, "knew this"], ["0", { type: "dismiss" }, "dismiss"]],
  detail: [
    ["1", { type: "known", via: "understood" }, "understood"],
    ["2", { type: "ask-main" }, "ask main"],
    ["3", { type: "ask-sidebar" }, "ask Sidebar"],
    ["0", { type: "dismiss" }, "dismiss"],
  ],
  dismissed: [["9", { type: "turn-off" }, "turn off heads-up for this session"]],
};

/** Which share destinations are configured (choices for unconfigured ones are not offered). */
export interface ShareTargets {
  bluesky: boolean;
  drafts: boolean;
}

/** A share note's choices, by digit, with their labels. */
function shareChoices(note: HeadsUpNote, phase: NotePhase, targets: ShareTargets): Array<[string, NoteAction, string]> {
  if (phase === "post") {
    return [
      ["1", { type: "publish" }, "post to Bluesky"],
      ["2", { type: "edit-post" }, "edit"],
      ["3", { type: "back" }, "back"],
      ["0", { type: "known", via: "declined" }, "discard"],
    ];
  }
  if (phase !== "note") return [];
  const out: Array<[string, NoteAction, string]> = [];
  if (targets.bluesky && note.post) out.push(["1", { type: "review-post" }, "review post"]);
  if (targets.drafts) out.push(["2", { type: "draft", kind: "full" }, "blog draft"], ["3", { type: "draft", kind: "outline" }, "blog outline"]);
  out.push(["4", { type: "known", via: "declined" }, "not interested"], ["0", { type: "dismiss" }, "dismiss"]);
  return out;
}

/** The note's mark; pi-recap's line has `※ ` in the same place. */
export const MARK = "✦ ";

const KIND_LABEL: Record<HeadsUpNote["kind"], string> = {
  tradeoff: "tradeoff",
  "suspect-result": "check this result",
  risk: "risk",
  context: "context",
  share: "worth sharing",
};

/** What the note shows and which digits it answers. */
export class NoteState {
  note: HeadsUpNote | undefined;
  phase: NotePhase = "note";
  /** When a dismissed note's turn-off offer goes away. */
  until = 0;
  /** A share note's post as it will be published (edits land here). */
  post = "";
  /** What a busy note is doing ("writing a blog draft..."). */
  busy = "";
  targets: ShareTargets = { bluesky: false, drafts: false };

  get showing(): boolean {
    return !!this.note;
  }

  /** Whether a fresh note may replace this one (nothing showing, or not yet answered, or only the dismissed line). */
  get replaceable(): boolean {
    return !this.note || this.phase === "note" || this.phase === "dismissed";
  }

  show(note: HeadsUpNote, targets: ShareTargets = this.targets): void {
    this.note = note;
    this.phase = "note";
    this.until = 0;
    this.post = note.post ?? "";
    this.busy = "";
    this.targets = targets;
  }

  clear(): void {
    this.note = undefined;
    this.phase = "note";
    this.until = 0;
    this.post = "";
    this.busy = "";
  }

  /** The action a key means now, if it is one of the digits on screen. */
  action(data: string): NoteAction | undefined {
    const note = this.note;
    if (!note || this.phase === "busy") return undefined;
    if (note.kind === "share" && this.phase !== "dismissed") return shareChoices(note, this.phase, this.targets).find(([key]) => key === data)?.[1];
    if (this.phase === "post") return undefined;
    return CHOICES[this.phase].find(([key]) => key === data)?.[1];
  }

  /** Show the note as working on something (no keys answer until it is done). */
  setBusy(text: string): void {
    if (!this.note) return;
    this.phase = "busy";
    this.busy = text;
  }

  /** Apply an action to the note itself (the controller does the rest). */
  apply(action: NoteAction, now: number): void {
    if (action.type === "expand") this.phase = "detail";
    else if (action.type === "review-post") this.phase = "post";
    else if (action.type === "back") this.phase = "note";
    else if (action.type === "edit-post" || action.type === "publish" || action.type === "draft") return;
    else if (action.type === "dismiss" && this.phase === "note") {
      this.phase = "dismissed";
      this.until = now + DISMISSED_MS;
    } else this.clear();
  }

  /** Whether the dismissed line has had its time. */
  expired(now: number): boolean {
    return this.phase === "dismissed" && now >= this.until;
  }

  /**
   * The note's lines: a title line (mark, "Heads up", the kind), the text under it at the prose
   * measure, then the choices as accented digits with dim labels, wrapped to the width.
   */
  lines(width: number, theme: Theme, measure = 0): string[] {
    const note = this.note;
    if (!note || width < 4) return [];
    const hang = "   ";
    let room = Math.max(1, width - hang.length - 1);
    if (measure > 0 && room > measure) room = measure;
    const fit = (line: string) => truncateToWidth(line, width);
    const sep = theme.fg("dim", " · ");
    const chip = (key: string, text: string) => `${theme.fg("accent", theme.bold(key))} ${theme.fg("dim", text)}`;
    if (this.phase === "dismissed") {
      return [fit(` ${theme.fg("dim", theme.bold(MARK))}${theme.fg("dim", "Heads up dismissed")}${sep}${chip("9", "turn off heads-up for this session")}`)];
    }
    const out = [` ${theme.fg("accent", theme.bold(MARK))}${theme.fg("accent", theme.bold("Heads up"))}${sep}${theme.fg("muted", KIND_LABEL[note.kind])}`];
    for (const line of wrapTextWithAnsi(note.text, room)) out.push(`${hang}${line}`);
    if (this.phase === "detail" && note.detail) {
      for (const line of wrapTextWithAnsi(note.detail, room)) out.push(`${hang}${theme.fg("muted", line)}`);
    }
    if (this.phase === "post") {
      for (const para of this.post.split("\n")) {
        for (const line of para ? wrapTextWithAnsi(para, Math.max(1, room - 2)) : [""]) out.push(`${hang}${theme.fg("muted", "│ ")}${line}`);
      }
      const count = graphemes(this.post).length;
      out.push(`${hang}${theme.fg(count > MAX_POST_GRAPHEMES ? "error" : "dim", `${count}/${MAX_POST_GRAPHEMES}`)}`);
    }
    if (this.phase === "busy") out.push(`${hang}${theme.fg("dim", this.busy)}`);
    else {
      const choices = note.kind === "share" ? shareChoices(note, this.phase, this.targets) : this.phase === "post" ? [] : CHOICES[this.phase as "note" | "detail"];
      for (const line of chipLines(choices.map(([key, , text]) => chip(key, text)), room, sep)) out.push(`${hang}${line}`);
    }
    return out.map(fit);
  }
}

/** Chips joined by `sep`, packed greedily into lines of at most `room` columns. */
function chipLines(chips: string[], room: number, sep: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const chip of chips) {
    const joined = line ? `${line}${sep}${chip}` : chip;
    if (line && visibleWidth(joined) > room) {
      lines.push(line);
      line = chip;
    } else line = joined;
  }
  if (line) lines.push(line);
  return lines.map((l) => (visibleWidth(l) > room ? truncateToWidth(l, room) : l));
}

export const HEADSUP_STATUS = "sidebar-headsup";

/** Main's status while notes wait in a closed Sidebar (plain text: pi-status-footer parses it). */
export function waitingStatus(note: HeadsUpNote, count: number): string {
  return `${MARK.trim()} heads up${count > 1 ? ` (${count})` : ""} · ${KIND_LABEL[note.kind]}: ${note.text.replace(/\s+/g, " ").trim()}`;
}

/**
 * pi-prose-width's measure when it is loaded and on (shared on Markdown's prototype), else 0. Notes
 * wrap their text at it, as pi-recap's line does.
 */
export function proseMeasure(proto: object = Markdown.prototype): number {
  const state = (proto as Record<symbol, { active?: boolean; measure?: number } | undefined>)[Symbol.for("pi-prose-width")];
  const measure = state?.active ? state.measure : undefined;
  return typeof measure === "number" && measure > 0 ? measure : 0;
}

/** Main's editor text that quotes a note, for the user to add a question and send to main. */
export function quoteForMain(note: HeadsUpNote): string {
  const quote = [note.text, ...(note.detail ? ["", note.detail] : [])].map((line) => (line ? `> ${line}` : ">")).join("\n");
  return `Sidebar's heads-up check noted:\n${quote}\n\n`;
}

/** Sidebar's question about a note. */
export function askSidebar(note: HeadsUpNote): string {
  return `Your heads-up check showed me this note: "${note.text}"\n\nIts explanation: ${note.detail || "(none)"}\n\nWalk me through it: is it right, and what should I do about it?`;
}
