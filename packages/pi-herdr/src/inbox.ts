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
/** started: began a turn; steered: into the current turn; queued: after it; held: until a dialog closes. */
export type Outcome = "started" | "steered" | "queued" | "held";
export const OUTCOMES: readonly Outcome[] = ["started", "steered", "queued", "held"];

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

export interface InboxHost {
  /** Whether the session is idle; undefined when unknown (treated as working). */
  isIdle(): boolean | undefined;
  /** Open `herdr:blocked` holds: dialogs waiting on the user. */
  blocked(): number;
  /** pi.sendMessage; false when it failed. */
  deliver(env: Envelope, deliverAs: "steer" | "followUp" | undefined): boolean;
  ack(env: Envelope, outcome: Outcome): void;
  notify(message: string, type: "info" | "warning"): void;
}

/** What outlives a runtime: held messages and seen ids, kept process-wide across /reload and /new. */
export interface InboxState {
  held: Envelope[];
  seen: Set<string>;
}

const STATE = Symbol.for("pi-plugins.pi-herdr/inbox-state.v1");

/** The process's inbox state: this pane's, whichever runtime of pi-herdr is live in it. */
export function processInboxState(): InboxState {
  const g = globalThis as Record<symbol, unknown>;
  return (g[STATE] ??= { held: [], seen: new Set<string>() }) as InboxState;
}

/** The receiving half: consumes envelope pastes and delivers them. */
export class Inbox {
  /** Messages for an idle session with a dialog open, delivered once it closes. */
  readonly held: Envelope[];
  private readonly seen: Set<string>;
  private readonly host: InboxHost;

  constructor(host: InboxHost, state: InboxState = { held: [], seen: new Set() }) {
    this.host = host;
    this.held = state.held;
    this.seen = state.seen;
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

  receive(env: Envelope): Outcome | undefined {
    // A sender that retries after an unconfirmed send must not deliver twice.
    if (this.seen.has(env.id)) return undefined;
    this.seen.add(env.id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
    const idle = this.host.isIdle() === true;
    let outcome: Outcome;
    if (idle && this.host.blocked() > 0) {
      this.held.push(env);
      outcome = "held";
      this.host.notify(`Message from ${env.from.name ?? env.from.pane} held until the dialog closes.`, "info");
    } else if (idle) {
      outcome = this.host.deliver(env, undefined) ? "started" : this.hold(env);
    } else {
      const as = env.delivery === "queue" ? "followUp" : "steer";
      outcome = this.host.deliver(env, as) ? (as === "steer" ? "steered" : "queued") : this.hold(env);
    }
    this.host.ack(env, outcome);
    return outcome;
  }

  private hold(env: Envelope): Outcome {
    this.held.push(env);
    return "held";
  }

  /** Deliver held messages once the session is idle with no dialog open (or working: queued). */
  flush(): void {
    while (this.held.length) {
      const idle = this.host.isIdle();
      if (idle === true && this.host.blocked() > 0) return;
      const env = this.held[0]!;
      const ok = idle === true ? this.host.deliver(env, undefined) : this.host.deliver(env, env.delivery === "queue" ? "followUp" : "steer");
      if (!ok) return;
      this.held.shift();
    }
  }

  reset(): void {
    this.held.length = 0;
  }
}
