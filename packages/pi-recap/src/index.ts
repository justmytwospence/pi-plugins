// pi-recap: a short recap of where the session stands, written into the transcript when you come
// back to the session after being away (terminal unfocused, or no input) for a while after a turn
// (3 minutes by default), and on demand with /recap.
//
// Presence: terminal focus reporting (?1004) is turned on by wrapping the terminal's start/stop, and
// stdin is observed raw, because fullscreen mode consumes focus reports before extensions see them.
//
// It follows Claude Code's session recap: the line is a transcript entry (a custom session entry,
// never sent to the model) drawn as ` ※ recap: <text>`, all in dim bold with the text also italic,
// wrapped at pi-prose-width's measure. An automatic recap needs 3 prompts in the session and 2 more
// since the previous recap.
//
// The recap is computed once per settled turn (summary.ts, one small-model call) and shared: pi-herdr
// asks for it over the event bus and writes it to its `$summary` pane token, so the turn's
// notification and the recap line are the same text.
//
// Session name (what `pi --resume` and /resume list): the latest turn's recap once it settles, so the
// list shows what the session was doing last rather than its first message. A name you set yourself
// (/name, --name) is left alone until you clear it. PI_RECAP_NAME=0 turns this off. The name is
// announced on `recap:session-name`, so the footer and pi-herdr can tell it from one you set and
// keep it off screen.
//
// Event bus:
//   recap:session-name { name }        pi-recap's own session name (undefined when it set none),
//                                      sent when it changes and at session start
//   recap:summary { reply(promise) }   pi-recap calls reply with a Promise<string | undefined> for
//                                      the current turn (memoized, clipped to the token's 80
//                                      characters), when it is loaded and active
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Block, registerRowRun, rowLine } from "./transcript-style.ts";
import { classify, type ChunkState, FOCUS_IN, FOCUS_OFF, FOCUS_ON, FOCUS_OUT, Presence } from "./presence.ts";
import { oneLine, type Recap, RECAP_MAX, type RecapRegistry, recap } from "./summary.ts";

/** The custom entry type of a recap in the session, and the key of /recap's pending line. */
export const ENTRY = "recap";
/** The custom entry recording each session name pi-recap set, so a name set by hand is told apart. */
export const NAME_ENTRY = "recap-name";
/** Bus channel announcing the session name pi-recap set, so other plugins can leave it off screen. */
export const NAME_EVENT = "recap:session-name";
export const WIDGET = "recap";
export const MARK = "※ ";
export const LABEL = "recap: ";
const DEFAULT_DELAY_MS = 180_000;
/** Grace before a return appends the recap, so a prompt injected by another agent (paste, then Enter) starts its run first and cancels it. */
export const RETURN_SETTLE_MS = 1_000;
/** As in Claude Code: no automatic recap before this many prompts, nor before this many more since the last. */
export const MIN_PROMPTS = 3;
export const MIN_PROMPTS_BETWEEN = 2;

export interface InputSource {
  on(event: "data", listener: (d: string | Buffer) => void): unknown;
  off(event: "data", listener: (d: string | Buffer) => void): unknown;
}
export interface RecapDeps {
  stdin?: InputSource;
}

export interface RecapRequest {
  reply?: (summary: Promise<string | undefined>) => void;
}

export interface RecapStyle {
  mark(s: string): string;
  label(s: string): string;
  text(s: string): string;
}

const PLAIN: RecapStyle = { mark: (s) => s, label: (s) => s, text: (s) => s };

function delayMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PI_RECAP_DELAY_MS);
  return Number.isFinite(n) && n >= 0 && env.PI_RECAP_DELAY_MS?.trim() ? n : DEFAULT_DELAY_MS;
}

/** pi-prose-width's measure, read from its state on the shared Markdown prototype; 0 when it is not loaded. */
function proseMeasure(): number {
  const state = (Markdown.prototype as unknown as Record<symbol, { active?: boolean; measure?: number } | undefined>)[
    Symbol.for("pi-prose-width")
  ];
  return state?.active && typeof state.measure === "number" && state.measure > 0 ? state.measure : 0;
}

/** The recap's lines: ` ※ recap: text`, the text wrapped under the label at the prose measure. */
export function recapLines(text: string, width: number, style: RecapStyle = PLAIN, measure = proseMeasure()): string[] {
  const indent = 1 + visibleWidth(MARK);
  let room = Math.max(10, width - indent - 1);
  if (measure && room > measure) room = measure;
  const body = style.label(LABEL) + style.text(text);
  return wrapTextWithAnsi(body, room).map((line, i) => `${i === 0 ? ` ${style.mark(MARK)}` : " ".repeat(indent)}${line}`);
}

const isPrompt = (e: any) => e?.type === "message" && e.message?.role === "user";
const isRecap = (e: any) => e?.type === "custom" && e.customType === ENTRY;

/** Whether an automatic recap may follow this branch: enough prompts, and enough since the last recap. */
export function recapDue(branch: readonly any[]): boolean {
  if (isRecap(branch.at(-1))) return false;
  let prompts = 0;
  let since = 0;
  let seenRecap = false;
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (isRecap(e)) seenRecap = true;
    else if (isPrompt(e)) {
      prompts++;
      if (!seenRecap) since++;
    }
  }
  return prompts >= MIN_PROMPTS && (!seenRecap || since >= MIN_PROMPTS_BETWEEN);
}

/** Restore the exact descriptor, but never clobber a subsequent owner's method. */
function installMethod(target: object, key: PropertyKey, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  const installed = { value, writable: true, configurable: previous?.configurable ?? true, enumerable: previous?.enumerable ?? true };
  Object.defineProperty(target, key, installed);
  return () => {
    const current = Object.getOwnPropertyDescriptor(target, key);
    if (!current || current.value !== value || current.writable !== installed.writable
      || current.configurable !== installed.configurable || current.enumerable !== installed.enumerable) return;
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  };
}

type Terminal = { write(data: string): void } & Record<string, any>;

/** Borrow the live terminal: widget factories receive the TUI; the probe widget is removed at once. */
function grabTerminal(ctx: ExtensionContext): Terminal | undefined {
  let tui: any;
  ctx.ui.setWidget("recap-probe", (t) => {
    tui = t;
    return { render: () => [], invalidate() {} };
  });
  ctx.ui.setWidget("recap-probe", undefined);
  const terminal = tui?.terminal;
  return typeof terminal?.write === "function" ? terminal : undefined;
}

/** Turn focus reports on while Pi owns the terminal (after every start), off around stop and on exit. */
function focusReporting(terminal: Terminal): () => void {
  const write = (data: string) => {
    try {
      terminal.write(data);
    } catch {
      // The terminal is gone.
    }
  };
  const restores: Array<() => void> = [];
  write(FOCUS_ON);
  if (typeof terminal.start === "function") {
    const original = terminal.start;
    restores.push(installMethod(terminal, "start", function (this: unknown, ...args: unknown[]) {
      const result = original.apply(terminal, args);
      write(FOCUS_ON);
      return result;
    }));
  }
  if (typeof terminal.stop === "function") {
    const original = terminal.stop;
    restores.push(installMethod(terminal, "stop", function (this: unknown, ...args: unknown[]) {
      write(FOCUS_OFF);
      return original.apply(terminal, args);
    }));
  }
  if (typeof terminal.restoreOnExit === "function") {
    const original = terminal.restoreOnExit;
    restores.push(installMethod(terminal, "restoreOnExit", function (this: unknown, before: string, after: string) {
      return original.call(terminal, before + FOCUS_OFF, after);
    }));
  }
  return () => {
    write(FOCUS_OFF);
    for (const restore of restores.reverse()) restore();
  };
}

export default function piRecap(pi: ExtensionAPI, deps: RecapDeps = {}) {
  const stdin = deps.stdin ?? (process.stdin as unknown as InputSource);
  let settledAt: number | undefined;
  let pendingRecap: { epoch: number; ctx: ExtensionContext; recapping: Promise<Recap | undefined> } | undefined;
  let presence: Presence | undefined;
  const chunkState: ChunkState = { inPaste: false };
  let stopWatching: (() => void) | undefined;
  let active = false;
  let lastCtx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Bumped whenever a pending recap goes stale: a new run, a tree jump, a new session.
  let generation = 0;
  let memo: { key: string; promise: Promise<Recap | undefined> } | undefined;
  // The session name pi-recap set last; any other name was set by hand.
  let autoName: string | undefined;

  /** The latest automatic name recorded in the session, so it survives a resume. */
  const recordedName = (ctx: ExtensionContext): string | undefined => {
    try {
      const entries = ctx.sessionManager.getEntries() as any[];
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e?.type === "custom" && e.customType === NAME_ENTRY && typeof e.data?.name === "string") return e.data.name;
      }
    } catch {
      // No entries to read.
    }
    return undefined;
  };

  /** Name the session after what it is doing now, unless you named it yourself. */
  const nameSession = (text: string | undefined) => {
    if (!active || process.env.PI_RECAP_NAME === "0") return;
    const name = oneLine(text ?? "", RECAP_MAX);
    if (!name) return;
    try {
      const current = pi.getSessionName();
      if (current && current !== autoName) return;
      if (current === name) return;
      pi.setSessionName(name);
      pi.appendEntry(NAME_ENTRY, { name });
      autoName = name;
      pi.events.emit(NAME_EVENT, { name });
    } catch {
      // The runtime went stale.
    }
  };

  const rows = registerRowRun<{ text?: string }>(pi, {
    anchorType: ENTRY,
    stateType: "recap:state",
    sameRun: () => true,
    merge: (_a, b) => b,
    render: ({ data, time }, theme, options) => {
      const text = data?.text;
      if (!text) return undefined;
      return new Block(theme, () => ({ tone: "info", title: "Recap", body: text, fold: 0, expanded: options.expanded, time }));
    },
  });

  /** /recap's placeholder above the editor while it waits for the run and the model. */
  const pending = (ctx: ExtensionContext, on: boolean) => {
    try {
      ctx.ui.setWidget(
        WIDGET,
        on ? (_tui, theme) => ({ invalidate() {}, render: (width: number) => [rowLine(theme, { tone: "running", title: "Recap" }, width)] }) : undefined,
      );
    } catch {
      // The runtime went stale.
    }
  };

  const append = (ctx: ExtensionContext, text: string) => {
    try {
      rows.append(ctx, { text });
    } catch {
      // The runtime went stale.
    }
  };

  const reset = () => {
    generation++;
    clearTimeout(timer);
    timer = undefined;
    pendingRecap = undefined;
    settledAt = undefined;
  };

  /** You are back after being away: append the pending recap shortly, unless a run starts first. */
  const returned = () => {
    const p = pendingRecap;
    if (!p || p.epoch !== generation) return;
    pendingRecap = undefined;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const r = await p.recapping;
      if (p.epoch !== generation || !active || !r) return;
      // A reply that is already one short line is on screen; repeating it adds nothing.
      if (r.source === "reply") return;
      const branch = branchOf(p.ctx);
      if (branch && recapDue(branch)) append(p.ctx, r.text);
    }, RETURN_SETTLE_MS);
    timer.unref?.();
  };

  const unwatch = () => {
    stopWatching?.();
    stopWatching = undefined;
    presence = undefined;
    chunkState.inPaste = false;
  };

  const watch = (ctx: ExtensionContext) => {
    unwatch();
    try {
      presence = new Presence({ delayMs: delayMs() });
      const onData = (d: string | Buffer) => {
        const c = classify(typeof d === "string" ? d : d.toString("utf8"), chunkState);
        if (presence?.observe(c, pendingRecap ? settledAt : undefined)) returned();
      };
      stdin.on("data", onData);
      const offKeys = ctx.ui.onTerminalInput?.((data) => (data === FOCUS_IN || data === FOCUS_OUT ? { consume: true } : undefined));
      const terminal = grabTerminal(ctx);
      const stopFocus = terminal ? focusReporting(terminal) : undefined;
      stopWatching = () => {
        stdin.off("data", onData);
        offKeys?.();
        stopFocus?.();
      };
    } catch {
      // Without presence, recap still works through /recap.
    }
  };

  const branchOf = (ctx: ExtensionContext): any[] | undefined => {
    try {
      return ctx.sessionManager.getBranch() as any[];
    } catch {
      return undefined;
    }
  };

  /** The recap of the branch's latest turn, computed once per turn (recap entries do not count). */
  const summarize = (ctx: ExtensionContext): Promise<Recap | undefined> => {
    const branch = branchOf(ctx);
    if (!branch) return Promise.resolve(undefined);
    const messages = branch.filter((e) => e?.type === "message");
    const key = `${messages.at(-1)?.id ?? ""}:${messages.length}`;
    if (memo?.key === key) return memo.promise;
    const promise = recap(ctx.modelRegistry as unknown as RecapRegistry, branch).catch(() => undefined);
    memo = { key, promise };
    return promise;
  };

  pi.events.on("recap:summary", (data) => {
    const request = data as RecapRequest | undefined;
    if (!active || !lastCtx || typeof request?.reply !== "function") return;
    request.reply(summarize(lastCtx).then((r) => r && oneLine(r.text, RECAP_MAX)));
  });

  pi.on("session_start", (_event, ctx) => {
    reset();
    memo = undefined;
    active = ctx.mode === "tui";
    lastCtx = active ? ctx : undefined;
    autoName = active ? recordedName(ctx) : undefined;
    pi.events.emit(NAME_EVENT, { name: autoName });
    if (active && process.env.PI_RECAP !== "0") watch(ctx);
    else unwatch();
  });
  pi.on("session_tree", (_event, ctx) => {
    if (!active) return;
    lastCtx = ctx;
    reset();
  });
  pi.on("session_shutdown", () => {
    unwatch();
    reset();
    active = false;
    lastCtx = undefined;
    memo = undefined;
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!active) return;
    lastCtx = ctx;
    reset();
  });
  // Start the recap as the turn settles, so it is ready for pi-herdr's notification; without
  // pi-herdr, nothing waits on it.
  pi.on("agent_before_settle", (_event, ctx) => {
    if (!active) return undefined;
    lastCtx = ctx;
    void summarize(ctx);
    return undefined;
  });
  pi.on("agent_settled", (event, ctx) => {
    if (!active || event.aborted || process.env.PI_RECAP === "0") return;
    lastCtx = ctx;
    reset();
    const epoch = generation;
    const recapping = summarize(ctx);
    void recapping.then((r) => {
      if (epoch === generation && r) nameSession(r.text);
    });
    settledAt = Date.now();
    pendingRecap = { epoch, ctx, recapping };
  });

  pi.registerCommand("recap", {
    description: "Recap where this session stands, in one line in the transcript",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      active = true;
      lastCtx = ctx;
      pending(ctx, true);
      try {
        await ctx.waitForIdle();
        reset();
        const epoch = generation;
        const r = await summarize(ctx);
        if (epoch !== generation) return;
        if (r) {
          append(ctx, r.text);
          nameSession(r.text);
        } else ctx.ui.notify("Nothing to recap yet", "warning");
      } finally {
        pending(ctx, false);
      }
    },
  });
}
