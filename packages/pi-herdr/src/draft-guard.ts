// The draft guard: a prompt another program types into this pane (`herdr agent prompt` from a
// non-pi agent or a script, herdr-web-ui, Collie) without pi-herdr's envelope arrives as a
// bracketed paste and, about 300 ms later, Enter. With a draft in the editor, the paste lands in
// it and the Enter sends both as one prompt. The guard sends the injected text on its own and
// gives the draft back.
//
// It acts only when it must, on what it can tell apart from your own typing:
// - the editor held a draft before the paste, untouched for IDLE_MS (pasting a URL onto the end
//   of what you just typed and pressing Enter is yours);
// - Enter follows within WINDOW_MS, with only focus reports between;
// - the main editor's text changed (the paste landed there, not in an overlay or Sidebar).
// A command (`/...`, `!...`) is not run: commands clear the editor when they finish and some need
// it empty (/tree), so the draft could not safely come back. The draft is kept and you are told.
import { PASTE_END, PASTE_START, isEnvelopePaste } from "./inbox.ts";

export const WINDOW_MS = 700;
export const IDLE_MS = 3_000;
/** Terminal focus reports, which say nothing about what was typed. */
const NEUTRAL = new Set(["\x1b[I", "\x1b[O"]);

export interface DraftHost {
  /** The main editor's text. */
  getText(): string;
  setText(text: string): void;
  notify(message: string, type: "info" | "warning"): void;
  /** Run after the current input has been handled (the submit has cleared the editor). */
  later(fn: () => void): void;
  isEnter(data: string): boolean;
}

export class DraftGuard {
  private lastInputAt = Number.NEGATIVE_INFINITY;
  private pending: { pasted: string; draft: string; at: number } | undefined;

  private readonly host: DraftHost;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly idleMs: number;

  constructor(host: DraftHost, now: () => number = () => Date.now(), windowMs = WINDOW_MS, idleMs = IDLE_MS) {
    this.host = host;
    this.now = now;
    this.windowMs = windowMs;
    this.idleMs = idleMs;
  }

  input(data: string): { consume: true } | undefined {
    if (NEUTRAL.has(data) || isEnvelopePaste(data)) return undefined;
    const t = this.now();
    if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END)) {
      const draft = this.host.getText();
      this.pending = draft.trim() && t - this.lastInputAt >= this.idleMs
        ? { pasted: data.slice(PASTE_START.length, -PASTE_END.length).replace(/\r\n?/gu, "\n"), draft, at: t }
        : undefined;
      this.lastInputAt = t;
      return undefined;
    }
    const p = this.pending;
    this.pending = undefined;
    this.lastInputAt = t;
    if (!p || !this.host.isEnter(data) || t - p.at > this.windowMs) return undefined;
    if (this.host.getText() === p.draft) return undefined;
    const text = p.pasted.trim();
    if (!text) return undefined;
    if (/^[/!]/u.test(text)) {
      this.host.setText(p.draft);
      this.host.notify(`Another program typed \`${text.split(/\s/u)[0]}\` into this pane while you had a draft. It was not run; your draft is kept.`, "warning");
      return { consume: true };
    }
    this.host.setText(text);
    this.host.later(() => {
      if (this.host.getText() !== "") return;
      this.host.setText(p.draft);
      this.host.notify("Sent a prompt another program typed into this pane on its own; your draft is back.", "info");
    });
    return undefined;
  }

  reset(): void {
    this.pending = undefined;
  }
}
