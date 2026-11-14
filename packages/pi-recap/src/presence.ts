// Presence: whether you are looking at the session, judged from raw terminal input and focus reports.
// Pure logic, no Pi imports.
export const FOCUS_ON = "\x1b[?1004h";
export const FOCUS_OFF = "\x1b[?1004l";
export const FOCUS_IN = "\x1b[I";
export const FOCUS_OUT = "\x1b[O";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export interface ChunkState {
  inPaste: boolean;
}
export interface Classified {
  focus?: "in" | "out";
  input: boolean;
}

/** What one raw stdin chunk says about presence: the last focus report in it, and whether anything else is real input. */
export function classify(chunk: string, state: ChunkState): Classified {
  let rest = chunk;
  if (state.inPaste) {
    const end = rest.indexOf(PASTE_END);
    if (end < 0) return { input: false };
    rest = rest.slice(end + PASTE_END.length);
    state.inPaste = false;
  }
  let out = "";
  for (;;) {
    const start = rest.indexOf(PASTE_START);
    if (start < 0) {
      out += rest;
      break;
    }
    out += rest.slice(0, start);
    const end = rest.indexOf(PASTE_END, start + PASTE_START.length);
    if (end < 0) {
      state.inPaste = true;
      break;
    }
    rest = rest.slice(end + PASTE_END.length);
  }
  let focus: "in" | "out" | undefined;
  out = out.replace(/\x1b\[([IO])/g, (_m, c: string) => {
    focus = c === "I" ? "in" : "out";
    return "";
  });
  out = out
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[\?[\d;]*\$?[cnuy]/g, "")
    .replace(/\x1b\[\d+(?:;\d+)*t/g, "")
    .replace(/\x1b\[<(\d+);\d+;\d+[Mm]/g, (m, b: string) => {
      const n = Number(b);
      return (n & 32) !== 0 && (n & 3) === 3 ? "" : m;
    });
  return { focus, input: out.length > 0 };
}

export interface PresenceOptions {
  delayMs: number;
  now?: () => number;
}

export class Presence {
  /** undefined until the first focus report. */
  focused: boolean | undefined;
  lastSeenAt: number;
  private readonly delayMs: number;
  private readonly now: () => number;

  constructor(opts: PresenceOptions) {
    this.delayMs = opts.delayMs;
    this.now = opts.now ?? Date.now;
    this.lastSeenAt = this.now();
  }

  /** Feed one classified chunk. True when it is a return after being away since `settledAt` (undefined: nothing pending). */
  observe(c: Classified, settledAt: number | undefined): boolean {
    if (!c.focus && !c.input) return false;
    const t = this.now();
    if (c.focus === "out" && !c.input) {
      this.focused = false;
      this.lastSeenAt = t;
      return false;
    }
    const threshold = this.focused === true ? 5 * this.delayMs : this.delayMs;
    const back = settledAt !== undefined && t - Math.max(this.lastSeenAt, settledAt) >= threshold;
    if (c.focus === "in") this.focused = true;
    else if (c.focus === "out") this.focused = false;
    this.lastSeenAt = t;
    return back;
  }
}
