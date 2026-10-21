// The heads-up note above main's editor, and its choices. A digit typed on its own into main's empty
// editor answers it; nothing else is taken from the editor.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { HeadsUpNote } from "./protocol.ts";

export const DISMISSED_MS = 20_000;

export type NotePhase = "note" | "detail" | "dismissed";

export type NoteAction =
  | { type: "expand" }
  | { type: "known"; via: "knew" | "understood" }
  | { type: "dismiss" }
  | { type: "ask-main" }
  | { type: "ask-sidebar" }
  | { type: "turn-off" };

const KEYS: Record<NotePhase, Record<string, NoteAction>> = {
  note: { "1": { type: "expand" }, "2": { type: "known", via: "knew" }, "0": { type: "dismiss" } },
  detail: { "1": { type: "known", via: "understood" }, "2": { type: "ask-main" }, "3": { type: "ask-sidebar" }, "0": { type: "dismiss" } },
  dismissed: { "9": { type: "turn-off" } },
};

const CHOICES: Record<NotePhase, string> = {
  note: "1: Learn more   2: Knew this already   0: Dismiss",
  detail: "1: Understood   2: Ask main   3: Ask Sidebar   0: Dismiss",
  dismissed: "9: Turn off heads-up for this session",
};

const KIND_LABEL: Record<HeadsUpNote["kind"], string> = {
  tradeoff: "tradeoff",
  "suspect-result": "check this result",
  risk: "risk",
  context: "context",
};

/** What the note shows and which digits it answers. */
export class NoteState {
  note: HeadsUpNote | undefined;
  phase: NotePhase = "note";
  /** When a dismissed note's turn-off offer goes away. */
  until = 0;

  get showing(): boolean {
    return !!this.note;
  }

  /** Whether a fresh note may replace this one (nothing showing, or only the dismissed line). */
  get free(): boolean {
    return !this.note || this.phase === "dismissed";
  }

  show(note: HeadsUpNote): void {
    this.note = note;
    this.phase = "note";
    this.until = 0;
  }

  clear(): void {
    this.note = undefined;
    this.phase = "note";
    this.until = 0;
  }

  /** The action a key means now, if it is one of the digits on screen. */
  action(data: string): NoteAction | undefined {
    if (!this.note) return undefined;
    return KEYS[this.phase][data];
  }

  /** Apply an action to the note itself (the controller does the rest). */
  apply(action: NoteAction, now: number): void {
    if (action.type === "expand") this.phase = "detail";
    else if (action.type === "dismiss" && this.phase === "note") {
      this.phase = "dismissed";
      this.until = now + DISMISSED_MS;
    } else this.clear();
  }

  /** Whether the dismissed line has had its time. */
  expired(now: number): boolean {
    return this.phase === "dismissed" && now >= this.until;
  }

  lines(width: number, theme: Theme): string[] {
    const note = this.note;
    if (!note || width < 4) return [];
    const indent = "  ";
    const inner = Math.max(1, width - indent.length);
    if (this.phase === "dismissed") {
      return [truncateToWidth(theme.fg("dim", `${indent}Heads-up dismissed. ${CHOICES.dismissed}`), width)];
    }
    const head = `${theme.fg("accent", "✦ Heads up")}${theme.fg("dim", ` · ${KIND_LABEL[note.kind]} · `)}`;
    const out = wrapTextWithAnsi(`${head}${note.text}`, inner).map((line, i) => (i === 0 ? line : `${indent}${line}`));
    if (this.phase === "detail" && note.detail) {
      for (const line of wrapTextWithAnsi(note.detail, inner)) out.push(`${indent}${theme.fg("muted", line)}`);
    }
    out.push(truncateToWidth(`${indent}${theme.fg("dim", CHOICES[this.phase])}`, width));
    return out.map((line) => truncateToWidth(line, width));
  }
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
