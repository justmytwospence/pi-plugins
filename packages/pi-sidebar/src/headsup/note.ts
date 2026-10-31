// The heads-up note above main's editor, and its choices. A digit typed on its own into main's empty
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

const KEYS: Record<"note" | "detail" | "dismissed", Record<string, NoteAction>> = {
  note: { "1": { type: "expand" }, "2": { type: "known", via: "knew" }, "0": { type: "dismiss" } },
  detail: { "1": { type: "known", via: "understood" }, "2": { type: "ask-main" }, "3": { type: "ask-sidebar" }, "0": { type: "dismiss" } },
  dismissed: { "9": { type: "turn-off" } },
};

const CHOICES: Record<"note" | "detail" | "dismissed", string> = {
  note: "1: Learn more   2: Knew this already   0: Dismiss",
  detail: "1: Understood   2: Ask main   3: Ask Sidebar   0: Dismiss",
  dismissed: "9: Turn off heads-up for this session",
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
      ["1", { type: "publish" }, "Post to Bluesky"],
      ["2", { type: "edit-post" }, "Edit"],
      ["3", { type: "back" }, "Back"],
      ["0", { type: "known", via: "declined" }, "Discard"],
    ];
  }
  if (phase !== "note") return [];
  const out: Array<[string, NoteAction, string]> = [];
  if (targets.bluesky && note.post) out.push(["1", { type: "review-post" }, "Review post"]);
  if (targets.drafts) out.push(["2", { type: "draft", kind: "full" }, "Blog draft"], ["3", { type: "draft", kind: "outline" }, "Blog outline"]);
  out.push(["4", { type: "known", via: "declined" }, "Not interested"], ["0", { type: "dismiss" }, "Dismiss"]);
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

  /** Whether a fresh note may replace this one (nothing showing, or only the dismissed line). */
  get free(): boolean {
    return !this.note || this.phase === "dismissed";
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
    return KEYS[this.phase][data];
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
   * The note's lines, laid out like pi-recap's ` ※ recap: text` line so the two read as one family
   * when both show: one column in, a mark, a lowercase label ending in a colon, the text hanging under
   * the label, and the same wrap (the prose measure, or the width less the indent and one column).
   * The note keeps the accent: it asks for an answer, the recap does not.
   */
  lines(width: number, theme: Theme, measure = 0): string[] {
    const note = this.note;
    if (!note || width < 4) return [];
    const hang = " ".repeat(1 + visibleWidth(MARK));
    let room = Math.max(1, width - hang.length - 1);
    if (measure > 0 && room > measure) room = measure;
    const fit = (line: string) => truncateToWidth(line, width);
    const mark = theme.fg("accent", theme.bold(MARK));
    if (this.phase === "dismissed") {
      return [fit(` ${theme.fg("dim", `${theme.bold(MARK)}${theme.bold(`heads up dismissed: `)}${CHOICES.dismissed}`)}`)];
    }
    const label = `${theme.fg("accent", theme.bold("heads up"))}${theme.fg("dim", ` · ${KIND_LABEL[note.kind]}: `)}`;
    const out = wrapTextWithAnsi(`${label}${note.text}`, room).map((line, i) => `${i === 0 ? ` ${mark}` : hang}${line}`);
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
    else if (note.kind === "share") out.push(`${hang}${theme.fg("dim", shareChoices(note, this.phase, this.targets).map(([key, , text]) => `${key}: ${text}`).join("   "))}`);
    else if (this.phase !== "post") out.push(`${hang}${theme.fg("dim", CHOICES[this.phase])}`);
    return out.map(fit);
  }
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
