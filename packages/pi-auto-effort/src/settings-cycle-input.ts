import { writeSync } from "node:fs";
import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseKey } from "@earendil-works/pi-tui";

export type SettingCycleTrigger =
  | { kind: "keyboard"; epoch: number; serial: number; modifiers: number; event: "press" | "repeat" }
  | { kind: "pointer" }
  | { kind: "programmatic" };

export interface SettingsCycleInputStatus {
  mode: "idle" | "negotiating" | "modifier-release" | "timer";
  modifiers: Array<"shift" | "ctrl" | "alt" | "super">;
  reason?: "unavailable" | "unsupported" | "partial" | "unconfirmed" | "unmodified" | "pointer" | "programmatic";
}

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
export interface SettingsCycleInputPorts {
  /** Passive observation only: the adapter never changes stdin's mode or replays bytes. */
  stdin: {
    prependListener(event: "data", listener: (data: string | Uint8Array) => void): unknown;
    removeListener(event: "data", listener: (data: string | Uint8Array) => void): unknown;
  };
  exitSource: {
    prependListener(event: "exit", listener: () => void): unknown;
    removeListener(event: "exit", listener: () => void): unknown;
  };
  isInputTTY(): boolean;
  isOutputTTY(): boolean;
  writeSync(data: string): void;
  queueMicrotask(run: () => void): void;
  createEditor: EditorFactory;
}
export interface SettingsCycleInput {
  bind(ctx: ExtensionContext): void;
  captureTrigger(): SettingCycleTrigger | undefined;
  withTrigger<T>(trigger: SettingCycleTrigger, run: () => T): T;
  begin(transactionToken: object, trigger: SettingCycleTrigger): void;
  touch(trigger: SettingCycleTrigger): void;
  close(): void;
  status(): SettingsCycleInputStatus;
  dispose(): void;
}

type Terminal = {
  kittyProtocolActive?: boolean;
  write(data: string): void;
  stop(...args: unknown[]): unknown;
  drainInput(...args: unknown[]): unknown;
  start(...args: unknown[]): unknown;
  restoreOnExit?(before: string, after: string): void;
};
type Tui = {
  terminal: Terminal;
  getFocusedComponent?(): unknown;
  hasOverlay?(): boolean;
};
type Key = {
  primary: number;
  identity: string;
  modifiers: number;
  event: "press" | "repeat" | "release";
  text?: string;
};
type Evidence = { serial: number; mask: number; modifier?: number; event: Key["event"] };
type Pending = {
  token: object;
  handshake: object;
  epoch: number;
  participating: number;
  since: number;
  phase: "baseline" | "ack" | "done";
  pushedAt: number;
  acknowledged: boolean;
  confirmed: boolean;
};
const ORIGINAL = Symbol.for("pi.settings-cycle-input.original.v1");
const POP = "\x1b[<u";
const QUERY = "\x1b[?u";
const BITS = [
  [1, "shift"],
  [4, "ctrl"],
  [2, "alt"],
  [8, "super"],
] as const;
const MASK = 15;
const REQUIRED = 2 | 8 | 16;
// Epochs are never reused, including by a disposed adapter rebound in the same session.
let nextEpoch = 0;
const scalar = (n: number) => Number.isInteger(n) && n >= 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff);
const privateKey = (n: number) =>
  (n >= 0xe000 && n <= 0xf8ff) || (n >= 0xf0000 && n <= 0xffffd) || (n >= 0x100000 && n <= 0x10fffd);
const printable = (n: number) => scalar(n) && n >= 32 && n !== 127 && !privateKey(n);
// Kitty left/right Shift, Control, Alt, Super. Hyper/Meta/ISO and locks are consumed
// as standalone keys too, but never participate in our four logical modifiers.
const modifierBit = (n: number) =>
  n === 57441 || n === 57447
    ? 1
    : n === 57442 || n === 57448
      ? 4
      : n === 57443 || n === 57449
        ? 2
        : n === 57444 || n === 57450
          ? 8
          : undefined;
const standalone = (n: number) => n >= 57441 && n <= 57454;

function keySequence(data: string): Key | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Match the VT protocol's ESC byte, not typed text.
  const match = /^\x1b\[([\d:]*)(?:;([\d:]*))?(?:;([\d:]*))?u$/.exec(data);
  if (!match || data.length > 4096) return;
  const codes = (match[1] ?? "").split(":");
  const mods = (match[2] ?? "").split(":");
  if (codes.length > 3 || mods.length > 2 || !codes[0]) return;
  const primary = Number(codes[0]);
  const encodedMod = mods[0] ? Number(mods[0]) : 1;
  const type = mods[1] ? Number(mods[1]) : 1;
  if (
    !scalar(primary) ||
    codes.some((c) => c !== "" && !scalar(Number(c))) ||
    !Number.isSafeInteger(encodedMod) ||
    encodedMod < 1 ||
    encodedMod > 256 ||
    ![1, 2, 3].includes(type)
  )
    return;
  let text: string | undefined;
  if (match[3]) {
    const values = match[3].split(":").map(Number);
    if (!values.every(scalar)) return;
    text = String.fromCodePoint(...values);
  }
  return {
    primary,
    identity: codes.join(":"),
    modifiers: encodedMod - 1,
    event: type === 3 ? "release" : type === 2 ? "repeat" : "press",
    text,
  };
}
function textEvent(key: Key, primary = key.primary): boolean {
  // Some terminals attach an unmodified letter even to non-text control events.
  // AltGr/Option/dead-key translation differs from both reported key identities;
  // unchanged Ctrl/Alt/Super text must retain its canonical shortcut identity.
  const control = key.modifiers & (2 | 4 | 8);
  const shifted = key.identity.split(":")[1];
  const translatedAltText =
    !!(control & 2) &&
    !(control & 8) &&
    key.text !== undefined &&
    key.text.length > 0 &&
    key.text !== String.fromCodePoint(primary) &&
    (!shifted || key.text !== String.fromCodePoint(Number(shifted))) &&
    [...key.text].every((c) => (c.codePointAt(0) ?? 0) >= 32 && c.codePointAt(0) !== 127);
  return primary === 0 || !control || translatedAltText;
}
function normalize(key: Key): string {
  const type = key.event === "release" ? 3 : key.event === "repeat" ? 2 : 1;
  // Alternate key numbers are identities too, never printable PUA. A malformed
  // alternate must not reach the host's permissive printable fallback.
  const identity = key.identity
    .split(":")
    .slice(1)
    .some((value) => value !== "" && privateKey(Number(value)))
    ? String(key.primary)
    : key.identity;
  const canonical = `\x1b[${identity};${key.modifiers + 1}:${type}u`;
  if (standalone(key.primary)) return "";
  if (privateKey(key.primary)) {
    // Pi's printable decoder otherwise inserts unhandled functional PUA glyphs.
    // Translate supported keys into its existing native identities; consume keys
    // for which the host has no identity, rather than decoding key numbers as text.
    const simple = new Map([
      [57344, 27],
      [57345, 13],
      [57346, 9],
      [57347, 127],
      [57414, 13],
    ]);
    const keypad = new Map([
      [57409, 46],
      [57410, 47],
      [57411, 42],
      [57412, 45],
      [57413, 43],
      [57415, 61],
      [57416, 44],
    ]);
    const ascii =
      simple.get(key.primary) ??
      keypad.get(key.primary) ??
      (key.primary >= 57399 && key.primary <= 57408 ? key.primary - 57399 + 48 : undefined);
    if (ascii !== undefined) {
      const textKey = ascii >= 32 && ascii !== 127;
      if (textKey && key.text !== undefined && key.event !== "release" && textEvent(key, ascii)) return key.text;
      return `\x1b[${ascii};${key.modifiers + 1}:${type}u`;
    }
    const navigation = new Map([
      [57348, "2~"],
      [57349, "3~"],
      [57350, "1D"],
      [57351, "1C"],
      [57352, "1A"],
      [57353, "1B"],
      [57354, "5~"],
      [57355, "6~"],
      [57356, "1H"],
      [57357, "1F"],
      [57417, "1D"],
      [57418, "1C"],
      [57419, "1A"],
      [57420, "1B"],
      [57421, "5~"],
      [57422, "6~"],
      [57423, "1H"],
      [57424, "1F"],
      [57425, "2~"],
      [57426, "3~"],
    ]).get(key.primary);
    if (navigation) return `\x1b[${navigation.slice(0, -1)};${key.modifiers + 1}:${type}${navigation.at(-1)}`;
    const f = [11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24][key.primary - 57364];
    if (f !== undefined) {
      if (key.event === "release") return `\x1b[${f};${key.modifiers + 1}:3~`;
      if ((key.modifiers & ~(64 | 128)) === 0) return `\x1b[${f}~`;
    }
    return "";
  }
  if (key.event === "release") return canonical;
  // Associated text is authoritative for ordinary text and key-number-zero IME
  // commits. Keep canonical control identity for non-text shortcut events.
  if (key.text !== undefined && (key.primary === 0 || (printable(key.primary) && textEvent(key)))) return key.text;
  if ((key.modifiers & ~(1 | 64 | 128)) === 0 && printable(key.primary)) {
    const shifted = identity.split(":")[1];
    const value = key.modifiers & 1 && shifted ? Number(shifted) : key.primary;
    if (printable(value)) return String.fromCodePoint(value);
  }
  return canonical;
}

/** A bounded, text-discarding scanner used ONLY by the passive stdin observer. */
function replyScanner(reply: (flags: number) => void) {
  let state: "plain" | "escape" | "csi" | "body" | "bodyEscape" | "paste" = "plain";
  let candidate = "";
  let osc = false;
  let pasteEnd = "";
  const reset = () => {
    state = "plain";
    candidate = "";
    osc = false;
    pasteEnd = "";
  };
  return {
    reset,
    feed(data: string | Uint8Array) {
      // Iterate bytes rather than decoding/storing arbitrary typed Unicode.
      for (let i = 0; i < data.length; i++) {
        const n = typeof data === "string" ? data.charCodeAt(i) : (data[i] ?? 0);
        if (state === "paste") {
          const end = "\x1b[201~";
          const c = String.fromCharCode(n);
          pasteEnd = c === end[pasteEnd.length] ? pasteEnd + c : c === "\x1b" ? c : "";
          if (pasteEnd === end) reset();
        } else if (state === "body" || state === "bodyEscape") {
          if ((osc && n === 7) || (state === "bodyEscape" && n === 92) || n === 0x9c) reset();
          else state = n === 27 ? "bodyEscape" : "body";
        } else if (state === "escape") {
          if (n === 91) {
            state = "csi";
            candidate = "";
          } else if (n === 93 || n === 80 || n === 95 || n === 94 || n === 88) {
            state = "body";
            osc = n === 93;
          } else state = n === 27 ? "escape" : "plain";
        } else if (state === "csi") {
          if (n === 27) {
            state = "escape";
            candidate = "";
            continue;
          }
          if (n < 32 || n > 126 || candidate.length >= 125) {
            reset();
            continue;
          }
          candidate += String.fromCharCode(n);
          if (n >= 64 && n <= 126) {
            const value = /^\?(\d+)u$/.exec(candidate);
            if (candidate === "200~") {
              state = "paste";
              candidate = "";
            } else {
              reset();
              if (value) {
                const flags = Number(value[1]);
                if (Number.isSafeInteger(flags) && flags >= 0 && flags <= 0x7fffffff) reply(flags);
              }
            }
          }
        } else if (n === 27) state = "escape";
        else if (n === 0x9d || n === 0x90 || n === 0x9f) {
          state = "body";
          osc = n === 0x9d;
        }
      }
    },
  };
}

export function createSettingsCycleInput(
  overrides: Partial<SettingsCycleInputPorts>,
  callbacks: { release(): void; mode(status: SettingsCycleInputStatus): void; cancel(reason: string): void },
): SettingsCycleInput {
  const ports: SettingsCycleInputPorts = {
    stdin: process.stdin,
    exitSource: process,
    isInputTTY: () => process.stdin.isTTY === true,
    isOutputTTY: () => process.stdout.isTTY === true,
    writeSync: (data) => {
      writeSync(process.stdout.fd, data);
    },
    queueMicrotask: (run) => queueMicrotask(run),
    createEditor: (tui, theme, keys) => new CustomEditor(tui, theme, keys),
    ...overrides,
  };
  let ctx: ExtensionContext | undefined;
  let session: string | undefined;
  let epoch = 0;
  let serial = 0;
  let live = false;
  let running = false;
  let binding = 0;
  let editor: unknown;
  let tui: Tui | undefined;
  let editorOwner: EditorFactory | undefined;
  let inputOff: (() => void) | undefined;
  let terminalOff: (() => void) | undefined;
  let observer = false;
  let exitOff: (() => void) | undefined;
  let currentTrigger: SettingCycleTrigger | undefined;
  let scope: SettingCycleTrigger | undefined;
  let pending: Pending | undefined;
  let mode: SettingsCycleInputStatus = { mode: "idle", modifiers: [] };
  let terminalOwner: object | undefined;
  let lease:
    | { terminal: Terminal; owner: object | undefined; foreignDepth: number; closing: boolean; cleanup?: () => void }
    | undefined;
  let ownWrite = false;
  let fragment = "";
  let paste = false;
  let pasteEnd = "";
  let body: "osc" | "other" | undefined;
  let bodyEscape = false;
  const physical = new Set<number>();
  const evidence: Evidence[] = [];
  const tokens = new Map<number, SettingCycleTrigger>();
  // Replies carry no IDs. Unanswered requests stay as tombstones: discarding one
  // may cost a later handshake, but can never let an old reply acquire a new lease.
  const queries: Array<{ pending: Pending; handshake: object; phase: "baseline" | "ack" }> = [];
  const status = (): SettingsCycleInputStatus => ({ ...mode, modifiers: [...mode.modifiers] });
  const publish = (value: SettingsCycleInputStatus["mode"], reason?: SettingsCycleInputStatus["reason"]) => {
    const next: SettingsCycleInputStatus = {
      mode: value,
      modifiers: BITS.filter(([bit]) => !!(pending?.participating && pending.participating & bit)).map(
        ([, name]) => name,
      ),
      ...(reason ? { reason } : {}),
    };
    if (JSON.stringify(next) === JSON.stringify(mode)) return;
    mode = next;
    callbacks.mode(status());
  };
  const current = () =>
    live &&
    !!ctx &&
    typeof ctx.sessionManager?.getSessionId === "function" &&
    ctx.sessionManager.getSessionId() === session;
  const ownsEditor = () => current() && ctx?.ui.getEditorComponent?.() === editorOwner;
  const focused = () =>
    ownsEditor() &&
    running &&
    !!tui &&
    !!editor &&
    typeof tui.getFocusedComponent === "function" &&
    typeof tui.hasOverlay === "function" &&
    tui.getFocusedComponent() === editor &&
    tui.hasOverlay() === false;
  const write = (terminal: Terminal, data: string) => {
    ownWrite = true;
    try {
      terminal.write(data);
    } finally {
      ownWrite = false;
    }
  };
  const pop = (sync = false): string => {
    if (!lease) return "";
    if (lease.foreignDepth > 0) {
      lease.closing = true;
      return "";
    }
    const frame = lease;
    lease = undefined;
    if (sync) {
      frame.cleanup?.();
      return POP;
    }
    try {
      write(frame.terminal, POP);
    } catch {
      /* Terminal may already be gone. */
    }
    frame.cleanup?.();
    return "";
  };
  const close = () => {
    pending = undefined;
    pop();
    publish("idle");
  };
  const cancel = (reason: string) => {
    const wasPending = !!pending;
    close();
    if (wasPending) callbacks.cancel(reason);
  };
  const checkFocus = () => {
    if (focused()) return true;
    if (pending && !ownsEditor() && !lease && current() && running) {
      // A later non-composing editor (for example Vim installed after us) retired
      // our capture, not the coordinator's timer transaction. Leave submit flush
      // and its fail-closed diagnostics intact; never cancel from the old editor.
      pending.participating = 0;
      pending.phase = "done";
      pending.acknowledged = false;
      pending.confirmed = false;
      publish("timer", "unavailable");
    } else cancel("settings input lost main-editor focus");
    return false;
  };
  const release = () => {
    if (!pending || !checkFocus()) return;
    close();
    callbacks.release();
  };
  const valid = (trigger: SettingCycleTrigger): trigger is Extract<SettingCycleTrigger, { kind: "keyboard" }> =>
    trigger?.kind === "keyboard" &&
    trigger.epoch === epoch &&
    tokens.get(trigger.serial) === trigger &&
    (!evidence[0] || trigger.serial >= evidence[0].serial - 1) &&
    ownsEditor();
  const clearEpoch = () => {
    epoch = ++nextEpoch;
    serial = 0;
    currentTrigger = undefined;
    scope = undefined;
    physical.clear();
    evidence.length = 0;
    tokens.clear();
    fragment = "";
    paste = false;
    pasteEnd = "";
    body = undefined;
    bodyEscape = false;
    scanner.reset();
  };
  const query = (p: Pending, phase: "baseline" | "ack") => {
    if (!tui || queries.length >= 64) {
      pop();
      p.phase = "done";
      publish("timer", "unavailable");
      return;
    }
    p.phase = phase;
    queries.push({ pending: p, handshake: p.handshake, phase });
    try {
      write(tui.terminal, QUERY);
    } catch {
      p.phase = "done";
      pop();
      publish("timer", "unavailable");
    }
  };
  const scanner = replyScanner((flags) => {
    const q = queries.shift();
    const p = pending;
    if (
      !q ||
      !p ||
      q.pending !== p ||
      q.handshake !== p.handshake ||
      p.epoch !== epoch ||
      q.phase !== p.phase ||
      !current() ||
      !running
    )
      return;
    if (!checkFocus()) return;
    if (q.phase === "baseline") {
      if (!flags) {
        p.phase = "done";
        publish("timer", "unsupported");
        return;
      }
      if (tui?.terminal.kittyProtocolActive !== true || lease) {
        p.phase = "done";
        publish("timer", "unavailable");
        return;
      }
      lease = { terminal: tui.terminal, owner: terminalOwner, foreignDepth: 0, closing: false };
      p.pushedAt = serial;
      try {
        write(tui.terminal, `\x1b[>${flags | 31}u`);
      } catch {
        pop();
        p.phase = "done";
        publish("timer", "unavailable");
        return;
      }
      query(p, "ack");
    } else {
      p.phase = "done";
      if ((flags & REQUIRED) !== REQUIRED) {
        pop();
        publish("timer", "partial");
        return;
      }
      p.acknowledged = true;
      publish(p.confirmed ? "modifier-release" : "negotiating", p.confirmed ? undefined : "unconfirmed");
    }
  });
  const observe = (data: string | Uint8Array) => {
    if (live && running) scanner.feed(data);
  };
  const ensureObserver = () => {
    if (observer) return true;
    try {
      if (typeof ports.stdin?.prependListener !== "function" || typeof ports.stdin?.removeListener !== "function")
        return false;
      ports.stdin.prependListener("data", observe);
      observer = true;
      return true;
    } catch {
      return false;
    }
  };
  const installTerminal = (terminal: Terminal) => {
    terminalOff?.();
    if (!terminal || typeof terminal.write !== "function") return false;
    const restorers = new Map<keyof Terminal, () => void>();
    const installed = new Set<keyof Terminal>();
    const owner = {};
    terminalOwner = owner;
    let owned = true;
    const wrap = <K extends "write" | "stop" | "drainInput" | "start" | "restoreOnExit">(
      name: K,
      build: (original: NonNullable<Terminal[K]>) => NonNullable<Terminal[K]>,
    ) => {
      const original = terminal[name];
      if (typeof original !== "function") return;
      const descriptor = Object.getOwnPropertyDescriptor(terminal, name);
      const replacement = build(original as NonNullable<Terminal[K]>);
      try {
        Object.defineProperty(terminal, name, { configurable: true, writable: true, value: replacement });
        installed.add(name);
        restorers.set(name, () => {
          if (terminal[name] !== replacement) return;
          if (descriptor) Object.defineProperty(terminal, name, descriptor);
          else Reflect.deleteProperty(terminal, name);
        });
      } catch {
        /* Read-only public methods cannot be composed. Lease stays unavailable. */
      }
    };
    wrap(
      "write",
      (original) =>
        function (this: Terminal, data: string) {
          const result = original.call(this, data);
          if (!ownWrite && lease?.terminal === terminal && lease.owner === owner) {
            // biome-ignore lint/suspicious/noControlCharactersInRegex: Match the VT protocol's ESC byte, not typed text.
            const controls = data.match(/\x1b\[(?:>[\d;]*|<\d*)u/g) ?? [];
            for (const control of controls) {
              if (control.startsWith("\x1b[>")) {
                lease.foreignDepth++;
                cancel("settings keyboard frame superseded");
              } else {
                const count = Number(control.slice(3, -1) || "1");
                if (count > lease.foreignDepth) {
                  // A foreign pop removed our frame too. Do not pop the host's frame.
                  const cleanup = lease.cleanup;
                  lease = undefined;
                  cleanup?.();
                  cancel("settings keyboard frame replaced");
                  break;
                }
                lease.foreignDepth -= count;
                if (!lease.foreignDepth && lease.closing) pop();
              }
              if (!lease) break;
            }
          }
          return result;
        },
    );
    for (const name of ["stop", "drainInput", "start"] as const)
      wrap(
        name,
        (original) =>
          function (this: Terminal, ...args: unknown[]) {
            if (owned && live) {
              cancel(`terminal ${name}`);
              running = name === "start";
              clearEpoch();
            }
            return original.apply(this, args);
          },
      );
    if (typeof terminal.restoreOnExit === "function") {
      wrap(
        "restoreOnExit",
        (original) =>
          function (this: Terminal, before: string, after: string) {
            const prefix = owned ? pop(true) : "";
            if (owned) {
              pending = undefined;
              running = false;
              clearEpoch();
              mode = { mode: "idle", modifiers: [] };
            }
            return original.call(this, prefix + before, after);
          },
      );
    } else {
      const exit = () => {
        const sequence = pop(true);
        pending = undefined;
        running = false;
        clearEpoch();
        mode = { mode: "idle", modifiers: [] };
        if (sequence)
          try {
            ports.writeSync(sequence);
          } catch {
            /* Exit cannot recover a closed fd. */
          }
      };
      try {
        ports.exitSource.prependListener("exit", exit);
        exitOff = () => {
          ports.exitSource.removeListener("exit", exit);
          exitOff = undefined;
        };
      } catch {
        /* No emergency restoration available: no lease below. */
      }
    }
    // Do not negotiate when lifecycle ownership cannot be established.
    const lifecycle = (["write", "stop", "drainInput", "start"] as const).every((name) => installed.has(name));
    terminalOff = () => {
      owned = false;
      exitOff?.();
      // A cooperative later stack owner must unwind first. Retain only an inert
      // write composition until that happens; no stdin/exit listeners survive.
      // It restores its descriptor only if still owned, never through a newer wrapper.
      const deferred = lease?.owner === owner && lease.foreignDepth > 0;
      if (deferred && lease) lease.cleanup = restorers.get("write");
      for (const [name, restore] of [...restorers].reverse()) if (!(deferred && name === "write")) restore();
      terminalOff = undefined;
    };
    return lifecycle && (installed.has("restoreOnExit") || !!exitOff);
  };
  let terminalReady = false;
  const remember = (mask: number, event: Key["event"], modifier?: number, keyNumber?: number) => {
    serial++;
    if (keyNumber !== undefined && modifier !== undefined) {
      if (event === "release") physical.delete(keyNumber);
      else physical.add(keyNumber);
      const sibling = [...physical].some((key) => modifierBit(key) === modifier);
      // The other side may have gone down before our scoped lease. Absence from
      // the physical set is not proof of release: retain the reported post-event
      // mask, adding a known sibling when a terminal omits it on one-side release.
      if (sibling) mask |= modifier;
    }
    // A later full event mask repairs a lost modifier release, including stale sides.
    // With no later bytes, a lost release is indistinguishable from a genuine hold;
    // the coordinator must not add an unconditional timer to a confirmed hold.
    for (const key of physical) if (!(mask & (modifierBit(key) ?? 0))) physical.delete(key);
    const item: Evidence = { serial, mask: mask & MASK, modifier, event };
    evidence.push(item);
    if (evidence.length > 256) evidence.shift();
    return item;
  };
  const acceptEvidence = (item: Evidence) => {
    const p = pending;
    if (!p || item.serial <= p.since || !p.participating) return;
    if (!checkFocus()) return;
    // A standalone unrelated release cannot prove participating modifiers are up.
    if (item.event === "release" && item.modifier !== undefined && !(item.modifier & p.participating)) return;
    if ((item.mask & p.participating) === 0) {
      release();
      return;
    }
    if (lease && item.serial > p.pushedAt && (item.mask & p.participating) !== 0) {
      p.confirmed = true;
      if (p.acknowledged) publish("modifier-release");
    }
  };
  const capture = (modifiers: number, event: "press" | "repeat", at = ++serial) => {
    const trigger: SettingCycleTrigger = { kind: "keyboard", epoch, serial: at, modifiers: modifiers & MASK, event };
    tokens.set(at, trigger);
    if (tokens.size > 256) {
      const oldest = tokens.keys().next().value;
      if (oldest !== undefined) tokens.delete(oldest);
    }
    currentTrigger = trigger;
    ports.queueMicrotask(() => {
      if (currentTrigger === trigger) currentTrigger = undefined;
    });
  };
  const input = (data: string): { data?: string; consume?: boolean } | undefined => {
    if (!live) return;
    currentTrigger = undefined;
    if (pending && !focused()) checkFocus();
    // The host's StdinBuffer normally supplies one sequence per call. Keep a bounded
    // CSI fragment for public transports that split it; paste/body payload is never
    // interpreted, and normalization remains installed after our temporary pop.
    const source = fragment + data;
    const releases: string[] = [];
    let out = "";
    fragment = "";
    let captured = false;
    for (let i = 0; i < source.length; ) {
      if (paste) {
        const c = source.charAt(i++);
        const end = "\x1b[201~";
        out += c;
        pasteEnd = c === end[pasteEnd.length] ? pasteEnd + c : c === "\x1b" ? c : "";
        if (pasteEnd === end) {
          paste = false;
          pasteEnd = "";
        }
        continue;
      }
      if (body) {
        const c = source.charAt(i++);
        out += c;
        if ((body === "osc" && c === "\x07") || (bodyEscape && c === "\\")) {
          body = undefined;
          bodyEscape = false;
        } else bodyEscape = c === "\x1b";
        continue;
      }
      if (source.startsWith("\x1b[200~", i)) {
        out += "\x1b[200~";
        i += 6;
        paste = true;
        continue;
      }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Match the VT protocol's ESC byte, not typed text.
      if (/^\x1b[\]P_^X]/.test(source.slice(i, i + 2))) {
        body = source[i + 1] === "]" ? "osc" : "other";
        out += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (source.startsWith("\x1b[", i)) {
        const rest = source.slice(i);
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Match the VT protocol's ESC byte, not typed text.
        const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(rest);
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Match the VT protocol's ESC byte, not typed text.
        if (!match && /^\x1b\[[\d:;]*$/.test(rest) && rest.length < 4096) {
          fragment = rest;
          break;
        }
        if (match) {
          const sequence = match[0];
          const key = keySequence(sequence);
          if (key) {
            const item = remember(
              key.modifiers,
              key.event,
              modifierBit(key.primary) ??
                (standalone(key.primary) || (key.primary >= 57358 && key.primary <= 57360) ? 0 : undefined),
              standalone(key.primary) ? key.primary : undefined,
            );
            acceptEvidence(item);
            if (!standalone(key.primary) && key.event !== "release" && focused()) {
              capture(key.modifiers, key.event, item.serial);
              captured = true;
            }
            const normalized = normalize(key);
            if (key.event === "release" && normalized) releases.push(normalized);
            out += normalized;
            i += sequence.length;
            continue;
          }
          // Malformed functional CSI-u can still match older host decoders (for
          // example an unknown event type). Never pass such a key to printable fallback.
          // biome-ignore lint/suspicious/noControlCharactersInRegex: Match the VT protocol's ESC byte, not typed text.
          const malformedKey = /^\x1b\[(\d+)[\d:;]*u$/.exec(sequence);
          if (malformedKey && privateKey(Number(malformedKey[1]))) {
            i += sequence.length;
            continue;
          }
          // Older Kitty hosts encode arrows/navigation with an event type too.
          // biome-ignore lint/suspicious/noControlCharactersInRegex: Match the VT protocol's ESC byte, not typed text.
          const legacyEvent = /^\x1b\[(?:\d+);(\d+):([123])[A-DFH~]$/.exec(sequence);
          if (legacyEvent) {
            const event = legacyEvent[2] === "3" ? "release" : legacyEvent[2] === "2" ? "repeat" : "press";
            const item = remember(Number(legacyEvent[1]) - 1, event);
            acceptEvidence(item);
            if (event !== "release" && focused()) {
              capture(item.mask, event, item.serial);
              captured = true;
            }
            if (event === "release") releases.push(sequence);
          }
          out += sequence;
          i += sequence.length;
          continue;
        }
      }
      out += source.charAt(i++);
    }
    if (
      !captured &&
      focused() &&
      !paste &&
      !body &&
      !fragment &&
      !data.includes("\x1b[200~") &&
      !data.includes("\x1b[")
    ) {
      const key = parseKey(data);
      if (key) {
        const mods = key.split("+");
        capture(
          (mods.includes("shift") ? 1 : 0) |
            (mods.includes("alt") ? 2 : 0) |
            (mods.includes("ctrl") ? 4 : 0) |
            (mods.includes("super") ? 8 : 0),
          "press",
        );
      }
    }
    // Native StdinBuffer already separates events. For coalescing public transports,
    // do not let its whole-chunk release filter swallow adjacent ordinary text.
    if (releases.length) {
      let nonRelease = out;
      for (const sequence of releases) nonRelease = nonRelease.replace(sequence, "");
      if (nonRelease) out = nonRelease;
    }
    if (out === data) return;
    return out ? { data: out } : { consume: true };
  };
  const activate = (trigger: SettingCycleTrigger) => {
    const p = pending;
    if (!p) return;
    if (!valid(trigger) || !trigger.modifiers) {
      pop();
      p.participating = 0;
      p.phase = "done";
      p.acknowledged = false;
      p.confirmed = false;
      publish(
        "timer",
        trigger?.kind === "pointer"
          ? "pointer"
          : trigger?.kind === "keyboard"
            ? valid(trigger)
              ? "unmodified"
              : "unavailable"
            : "programmatic",
      );
      return;
    }
    const fresh = !p.participating;
    p.participating |= trigger.modifiers;
    p.since = trigger.serial;
    // A retained token can cross an initialization await. Replay only bounded,
    // sanitized event evidence; never replay input into the editor/action path.
    for (const item of evidence) {
      if (pending !== p) return;
      acceptEvidence(item);
    }
    if (pending !== p) return;
    if (!fresh) {
      publish(mode.mode, mode.reason);
      return;
    }
    if (
      !focused() ||
      !terminalReady ||
      !inputOff ||
      !tui ||
      tui.terminal.kittyProtocolActive !== true ||
      !ports.isInputTTY() ||
      !ports.isOutputTTY() ||
      !ensureObserver() ||
      lease
    ) {
      p.phase = "done";
      publish("timer", "unavailable");
      return;
    }
    p.handshake = {};
    p.acknowledged = false;
    p.confirmed = false;
    publish("negotiating", "unconfirmed");
    query(p, "baseline");
  };
  const dispose = () => {
    close();
    live = false;
    running = false;
    clearEpoch();
    inputOff?.();
    inputOff = undefined;
    if (observer) {
      ports.stdin.removeListener("data", observe);
      observer = false;
    }
    terminalOff?.();
    exitOff?.();
    terminalReady = false;
    editor = undefined;
    editorOwner = undefined;
    tui = undefined;
    ctx = undefined;
    // Do not reset the editor factory here. Pi rebuilds it synchronously, which
    // would resurrect already-shutdown editor owners. bind unwraps our stale owner.
  };
  return {
    bind(context) {
      dispose();
      ctx = context;
      clearEpoch();
      const owner = ++binding;
      if (
        !context.hasUI ||
        context.mode !== "tui" ||
        typeof context.sessionManager?.getSessionId !== "function" ||
        typeof context.ui?.getEditorComponent !== "function" ||
        typeof context.ui?.setEditorComponent !== "function" ||
        typeof context.ui?.onTerminalInput !== "function"
      )
        return;
      live = true;
      running = true;
      session = context.sessionManager.getSessionId();
      const installed = context.ui.getEditorComponent() as
        | (EditorFactory & { [ORIGINAL]?: EditorFactory | null })
        | undefined;
      const previous = installed && ORIGINAL in installed ? (installed[ORIGINAL] ?? undefined) : installed;
      const factory: EditorFactory & { [ORIGINAL]?: EditorFactory | null } = (host, theme, keys) => {
        if (!live || owner !== binding || ctx !== context) return ports.createEditor(host, theme, keys);
        const result = previous?.(host, theme, keys) ?? ports.createEditor(host, theme, keys);
        if (editor && (editor !== result || tui !== (host as unknown as Tui))) cancel("main editor replaced");
        editor = result;
        tui = host as unknown as Tui;
        // The installed owner may be an outer compositional factory. A later
        // factory that never invokes us must not inherit this editor's authority.
        editorOwner = context.ui.getEditorComponent();
        terminalReady = installTerminal(tui.terminal);
        return result;
      };
      factory[ORIGINAL] = previous ?? null;
      inputOff = context.ui.onTerminalInput((data) => (live && owner === binding ? input(data) : undefined));
      context.ui.setEditorComponent(factory);
    },
    captureTrigger: () => scope ?? currentTrigger,
    withTrigger(trigger, run) {
      const prior = scope;
      scope = trigger;
      try {
        return run();
      } finally {
        scope = prior;
      }
    },
    begin(transactionToken, trigger) {
      if (pending?.token === transactionToken) {
        activate(trigger);
        return;
      }
      close();
      pending = {
        token: transactionToken,
        handshake: {},
        epoch,
        participating: 0,
        since: valid(trigger) ? trigger.serial : serial,
        phase: "done",
        pushedAt: Infinity,
        acknowledged: false,
        confirmed: false,
      };
      activate(trigger);
    },
    touch: activate,
    close,
    status,
    dispose,
  };
}
