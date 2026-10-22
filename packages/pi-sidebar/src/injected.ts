// Prompts typed into this pane by another program (`herdr agent prompt`, herdr_child's send, a
// phone client) belong to main, even when Sidebar has focus. Herdr writes them as a bracketed paste
// and, about 300 ms later, Enter. A paste into Sidebar's empty composer followed by Enter within
// INJECTED_WINDOW_MS, with no other key between, is taken as one: the paste still lands in the
// composer as it arrives (a paste you make yourself shows at once), and only that Enter is redirected.

export const INJECTED_WINDOW_MS = 700;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** Terminal focus reports, which say nothing about what was typed. */
const NEUTRAL = new Set(["\x1b[I", "\x1b[O"]);

export class InjectedPrompt {
  private pending: { text: string; at: number } | undefined;

  constructor(private readonly now: () => number = () => Date.now(), private readonly windowMs = INJECTED_WINDOW_MS) {}

  /**
   * One input sequence while Sidebar's composer has focus. `composerEmpty` is the composer's state
   * before this sequence. Returns the prompt when this sequence is the Enter that submits one.
   */
  observe(data: string, composerEmpty: boolean, isEnter: (data: string) => boolean): string | undefined {
    if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END)) {
      this.pending = composerEmpty ? { text: data.slice(PASTE_START.length, -PASTE_END.length).replace(/\r\n?/gu, "\n"), at: this.now() } : undefined;
      return undefined;
    }
    if (NEUTRAL.has(data)) return undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (!pending || !isEnter(data) || this.now() - pending.at > this.windowMs || !pending.text.trim()) return undefined;
    return pending.text;
  }

  reset(): void {
    this.pending = undefined;
  }
}
