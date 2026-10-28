// The draft guard: a prompt another program types into this pane (`herdr agent prompt` from a
// non-pi agent or a script, herdr-web-ui, Collie) without pi-herdr's envelope arrives as a
// bracketed paste and, about 300 ms later, Enter. With a draft in the editor, the paste lands in
// it and the Enter sends both as one prompt. The guard takes that Enter, puts the draft back as it
// was and submits the injected text itself (pi.sendUserMessage, steering a turn that is running,
// as Enter would): the draft is never out of the editor, whatever the submit does.
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
  /** Submit a prompt without the editor; false when pi refused it. */
  submit(text: string): boolean;
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
    // If pi refuses it, Enter goes on as it would have without the guard.
    if (!this.host.submit(text)) return undefined;
    this.host.setText(p.draft);
    this.host.notify("Sent a prompt another program typed into this pane on its own; your draft is back.", "info");
    return { consume: true };
  }

  reset(): void {
    this.pending = undefined;
  }
}
