// The inbox: pi-to-pi messages that never touch the receiving editor.
//
// `herdr agent prompt` types a bracketed paste and then Enter into the target's terminal. In a pi
// with a draft that merges the message into the draft (pi-vim's Normal mode pastes it mid-draft),
// whatever overlay has focus gets it, and the model cannot tell it came from another agent.
//
// Instead, a pi-herdr sender writes one bracketed paste whose payload starts with ENVELOPE_MARKER
// (`pane.send_text`, no Enter). pi-tui hands a whole bracketed paste to terminal-input listeners as
// one string, before the editor, pi-vim or an overlay sees it, so the receiving pi-herdr consumes
// it and delivers the message with `pi.sendMessage`: a turn when idle, a steer or follow-up when
// working, held while a dialog is open on an idle session. It answers with an `ack-<id>` token on
// its pane, so the sender can say what happened.
//
// The receiver also protects its user and itself: it holds a message while the user is typing a draft
// (presence), and defers the messages one sender keeps starting turns with while no user answers
// (rate guard, so two agents cannot loop). Both are said in the acknowledgement: `outcome[:reason]`,
// such as `held:typing` or `deferred:rate`.
//
// A receiver advertises itself with the pane token `inbox=v1:<pid>`; a sender also checks that the
// pid is in the pane's foreground (not a stale token, a suspended pi or a shell on top of it). The
// envelope grants nothing a process that can type into the pane does not already have.
import { randomBytes } from "node:crypto";

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";
/** Two invisible separators, then the protocol name: no one types or pastes this by accident. */
export const ENVELOPE_MARKER = "\u2063\u2063pi-herdr/v1 ";
export const INBOX_TOKEN = "inbox";
/** A source of its own, so these tokens are not refreshed or cleared with the display tokens. */
export const INBOX_SOURCE = "pi-herdr-inbox";
export const INBOX_TTL_MS = 90_000;
export const ACK_TTL_MS = 60_000;
export const MAX_MESSAGE_BYTES = 256 * 1024;

export type Delivery = "steer" | "queue";
/**
 * started: began a turn; steered: into the current turn; queued: after it; held: until a dialog
 * closes or the user stops typing; deferred: rides along with the user's next prompt, starting no turn.
 */
export type Outcome = "started" | "steered" | "queued" | "held" | "deferred";
export const OUTCOMES: readonly Outcome[] = ["started", "steered", "queued", "held", "deferred"];
/** Why a message was held or deferred: a dialog is open, the user is typing, pi refused it, a sender's rate. */
export type Reason = "dialog" | "typing" | "retry" | "rate";

export interface Ack {
  outcome: Outcome;
  reason?: string;
}

/** The ack token's value: `outcome` or `outcome:reason`. */
export const formatAck = (ack: Ack): string => (ack.reason ? `${ack.outcome}:${ack.reason}` : ack.outcome);

export function parseAck(value: unknown): Ack | undefined {
  if (typeof value !== "string") return undefined;
  const [outcome, reason] = value.split(":", 2);
  if (!(OUTCOMES as readonly string[]).includes(outcome ?? "")) return undefined;
  return { outcome: outcome as Outcome, ...(reason ? { reason } : {}) };
}

/** How long after the last edit a user counts as typing, and how long after Enter as submitting. */
export const TYPING_IDLE_MS = 15_000;
export const SUBMIT_GRACE_MS = 400;

export interface RateLimit {
  limit: number;
  windowMs: number;
}
export const DEFAULT_RATE: RateLimit = { limit: 6, windowMs: 600_000 };

/** `PI_HERDR_INBOX_RATE`: `<messages>/<seconds>` (default `6/600`); `0` or `off` turns the guard off. */
export function parseRate(value: string | undefined): RateLimit | null {
  const v = value?.trim();
  if (!v) return DEFAULT_RATE;
  if (v === "0" || v.toLowerCase() === "off") return null;
  const m = /^(\d+)\/(\d+)$/u.exec(v);
  if (!m || Number(m[1]) < 1 || Number(m[2]) < 1) return DEFAULT_RATE;
  return { limit: Number(m[1]), windowMs: Number(m[2]) * 1000 };
}

export interface Sender {
  pane: string;
  name?: string;
  /** Its session's title (name or first prompt), when it has no agent name. */
  title?: string;
  host?: string;
  cwd?: string;
}

export interface Envelope {
  v: 1;
  id: string;
  from: Sender;
  text: string;
  delivery: Delivery;
  /** The sender awaits this turn's reply (a herdr child's parent). */
  awaitsReply?: boolean;
}

export const newMessageId = (): string => randomBytes(6).toString("hex");

export function encodeEnvelope(env: Envelope): string {
  return `${PASTE_START}${ENVELOPE_MARKER}${Buffer.from(JSON.stringify(env)).toString("base64url")}${PASTE_END}`;
}

/** Whether a terminal-input sequence is an envelope paste (well-formed or not). */
export function isEnvelopePaste(data: string): boolean {
  return data.startsWith(PASTE_START + ENVELOPE_MARKER);
}

export function decodeEnvelope(data: string): Envelope | undefined {
  if (!isEnvelopePaste(data) || !data.endsWith(PASTE_END)) return undefined;
  const body = data.slice(PASTE_START.length + ENVELOPE_MARKER.length, -PASTE_END.length).replace(/\s+/gu, "");
  try {
    const env = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<Envelope>;
    if (env?.v !== 1 || typeof env.id !== "string" || !/^[a-z0-9]{1,24}$/u.test(env.id)) return undefined;
    if (typeof env.text !== "string" || !env.text.trim()) return undefined;
    if (env.delivery !== "steer" && env.delivery !== "queue") return undefined;
    if (!env.from || typeof env.from.pane !== "string") return undefined;
    return env as Envelope;
  } catch {
    return undefined;
  }
}

export const inboxTokenValue = (pid: number): string => `v1:${pid}`;

/** The receiving process's pid from an `inbox` token, or undefined. */
export function parseInboxToken(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^v1:(\d+)$/u.exec(value.trim());
  return m ? Number(m[1]) : undefined;
}

export const ackTokenName = (id: string): string => `ack-${id}`;

/** What the receiving model reads: who sent it, and whether its reply goes back. */
export function messageText(env: Envelope): string {
  const who = env.from.name ? `pi agent "${env.from.name}"` : env.from.title ? `the pi session "${env.from.title}"` : "a pi agent";
  const where = [env.from.host, env.from.cwd].filter(Boolean).join(", ");
  const reply = env.awaitsReply
    ? "Your final reply to it is sent back to that session."
    : "Your reply is not sent back automatically; the sender reads it from your pane if it needs it, so do not message it back unless it asks you to.";
  return `[Message from ${who} in herdr pane ${env.from.pane}${where ? ` (${where})` : ""}: another agent session, not the user typing. ${reply}]\n\n${env.text}`;
}

/**
 * Whether the user is typing in the main editor, from the terminal input the listener sees. A draft
 * left alone for TYPING_IDLE_MS is not typing; the Enter that submits one counts for SUBMIT_GRACE_MS
 * more, while the editor is already empty and the turn it starts has not begun.
 */
export class Presence {
  private lastEditAt = Number.NEGATIVE_INFINITY;
  private submitAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly graceMs: number;

  constructor(now: () => number = () => Date.now(), idleMs = TYPING_IDLE_MS, graceMs = SUBMIT_GRACE_MS) {
    this.now = now;
    this.idleMs = idleMs;
    this.graceMs = graceMs;
  }

  /**
   * One terminal input sequence; `draft` is the editor's text before it. Returns true when it edits
   * text (a character, a delete, a paste): escape sequences (arrows, focus, mouse, key releases) do not.
   */
  key(data: string, draft: string, enter: boolean): boolean {
    if (isEnvelopePaste(data)) return false;
    const t = this.now();
    if (enter) {
      if (draft.trim()) this.submitAt = t;
      return false;
    }
    if (data.startsWith(PASTE_START)) {
      this.lastEditAt = t;
      return true;
    }
    if (data.startsWith("\x1b") || data.length === 0) return false;
    this.lastEditAt = t;
    return true;
  }

  active(draft: string): boolean {
    const t = this.now();
    return (draft.trim() !== "" && t - this.lastEditAt < this.idleMs) || t - this.submitAt < this.graceMs;
  }

  /** Milliseconds until `active` turns false if nothing else is typed. */
  msUntilIdle(draft: string): number {
    const t = this.now();
    const edit = draft.trim() !== "" ? this.lastEditAt + this.idleMs - t : 0;
    return Math.max(0, edit, this.submitAt + this.graceMs - t);
  }
}

export interface InboxHost {
  /** Whether the session is idle; undefined when unknown (treated as working). */
  isIdle(): boolean | undefined;
  /** Open `herdr:blocked` holds: dialogs waiting on the user. */
  blocked(): number;
  /** Whether the user is typing a draft in the main editor (see Presence). */
  typing(): boolean;
  /** pi.sendMessage; false when it failed. `nextTurn` queues it for the user's next prompt, starting no turn. */
  deliver(env: Envelope, deliverAs: "steer" | "followUp" | "nextTurn" | undefined): boolean;
  ack(env: Envelope, outcome: Outcome, reason?: Reason): void;
  notify(message: string, type: "info" | "warning"): void;
}

/** What outlives a runtime: held messages, seen ids and per-sender rates, kept process-wide across /reload and /new. */
export interface InboxState {
  held: Envelope[];
  seen: Set<string>;
  /** Times of the messages each sender (host/pane) has had accepted since the user last wrote. */
  rate?: Map<string, number[]>;
}

const STATE = Symbol.for("pi-plugins.pi-herdr/inbox-state.v1");

/** The process's inbox state: this pane's, whichever runtime of pi-herdr is live in it. */
export function processInboxState(): InboxState {
  const g = globalThis as Record<symbol, unknown>;
  const state = (g[STATE] ??= { held: [], seen: new Set<string>() }) as InboxState;
  // A state an earlier runtime of this process created has no rates yet.
  state.rate ??= new Map();
  return state;
}

const senderKey = (env: Envelope): string => `${env.from.host ?? ""}/${env.from.pane}`;

/** The receiving half: consumes envelope pastes and delivers them. */
export class Inbox {
  /** Messages held for an idle session with a dialog open or a user typing, delivered once that ends. */
  readonly held: Envelope[];
  private readonly seen: Set<string>;
  private readonly rates: Map<string, number[]>;
  private readonly notified = new Set<string>();
  private readonly host: InboxHost;
  private readonly limit: RateLimit | null;
  private readonly now: () => number;

  constructor(host: InboxHost, state: InboxState = { held: [], seen: new Set() }, options: { rate?: RateLimit | null; now?: () => number } = {}) {
    this.host = host;
    this.held = state.held;
    this.seen = state.seen;
    this.rates = state.rate ??= new Map();
    this.limit = options.rate === undefined ? DEFAULT_RATE : options.rate;
    this.now = options.now ?? (() => Date.now());
  }

  /** A terminal-input listener: consumes envelopes, passes everything else through. */
  input(data: string): { consume: true } | undefined {
    if (!isEnvelopePaste(data)) return undefined;
    const env = decodeEnvelope(data);
    if (!env) {
      this.host.notify("pi-herdr: dropped a malformed message from another agent.", "warning");
      return { consume: true };
    }
    this.receive(env);
    return { consume: true };
  }

  /** The user wrote to this agent: every sender's count starts over. */
  userInput(): void {
    this.rates.clear();
    this.notified.clear();
  }

  /** Whether this sender is past its limit; if not, counts the message. */
  private overRate(env: Envelope): boolean {
    if (!this.limit) return false;
    const key = senderKey(env);
    const t = this.now();
    const recent = (this.rates.get(key) ?? []).filter((at) => t - at < this.limit!.windowMs);
    const over = recent.length >= this.limit.limit;
    if (!over) recent.push(t);
    this.rates.set(key, recent);
    return over;
  }

  receive(env: Envelope): Outcome | undefined {
    // A sender that retries after an unconfirmed send must not deliver twice.
    if (this.seen.has(env.id)) return undefined;
    this.seen.add(env.id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
    const who = env.from.name ?? env.from.title ?? env.from.pane;
    const idle = this.host.isIdle() === true;
    let outcome: Outcome;
    let reason: Reason | undefined;
    if (this.overRate(env)) {
      // It starts no turn: it rides along with the user's next prompt.
      outcome = "deferred";
      reason = "rate";
      if (!this.host.deliver(env, "nextTurn")) {
        this.held.push(env);
        outcome = "held";
        reason = "retry";
      }
      const key = senderKey(env);
      if (!this.notified.has(key)) {
        this.notified.add(key);
        this.host.notify(`${who} has sent ${this.limit!.limit} messages without an answer from you, so its next ones wait for your next prompt instead of starting turns.`, "warning");
      }
    } else if (idle && this.host.blocked() > 0) {
      this.held.push(env);
      outcome = "held";
      reason = "dialog";
      this.host.notify(`Message from ${who} held until the dialog closes.`, "info");
    } else if (idle && this.host.typing()) {
      this.held.push(env);
      outcome = "held";
      reason = "typing";
      this.host.notify(`Message from ${who} is waiting until you submit or stop typing.`, "info");
    } else if (idle) {
      outcome = "started";
      if (!this.host.deliver(env, undefined)) ({ outcome, reason } = this.hold(env));
    } else {
      const as = env.delivery === "queue" ? "followUp" : "steer";
      outcome = as === "steer" ? "steered" : "queued";
      if (!this.host.deliver(env, as)) ({ outcome, reason } = this.hold(env));
    }
    this.host.ack(env, outcome, reason);
    return outcome;
  }

  private hold(env: Envelope): { outcome: Outcome; reason: Reason } {
    this.held.push(env);
    return { outcome: "held", reason: "retry" };
  }

  /**
   * Deliver held messages once the session is idle with no dialog open and no one typing. A session
   * that is working by then (the user submitted, or a turn began) gets them after its turn, never
   * steering it: they waited, and the turn they were meant for is long past.
   */
  flush(): void {
    while (this.held.length) {
      const idle = this.host.isIdle();
      if (idle === true && (this.host.blocked() > 0 || this.host.typing())) return;
      const env = this.held[0]!;
      if (!(idle === true ? this.host.deliver(env, undefined) : this.host.deliver(env, "followUp"))) return;
      this.held.shift();
    }
  }

  reset(): void {
    this.held.length = 0;
  }
}
