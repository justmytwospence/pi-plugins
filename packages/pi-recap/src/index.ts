// pi-recap: a short recap of where the session stands, written into the transcript after the session
// has sat idle for a while (3 minutes by default) after a turn, and on demand with /recap.
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
// Event bus:
//   recap:summary { reply(promise) }   pi-recap calls reply with a Promise<string | undefined> for
//                                      the current turn (memoized), when it is loaded and active
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Recap, type RecapRegistry, recap } from "./summary.ts";

/** The custom entry type of a recap in the session, and the key of /recap's pending line. */
export const ENTRY = "recap";
export const WIDGET = "recap";
export const MARK = "※ ";
export const LABEL = "recap: ";
const DEFAULT_DELAY_MS = 180_000;
/** As in Claude Code: no automatic recap before this many prompts, nor before this many more since the last. */
export const MIN_PROMPTS = 3;
export const MIN_PROMPTS_BETWEEN = 2;

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

function themeStyle(theme: { fg(color: any, s: string): string; bold(s: string): string; italic(s: string): string }): RecapStyle {
  return {
    mark: (s) => theme.fg("dim", theme.bold(s)),
    label: (s) => theme.fg("dim", theme.bold(s)),
    text: (s) => theme.fg("dim", theme.bold(theme.italic(s))),
  };
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

export default function piRecap(pi: ExtensionAPI) {
  let active = false;
  let lastCtx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Bumped whenever a pending recap goes stale: a new run, a tree jump, a new session.
  let generation = 0;
  let memo: { key: string; promise: Promise<Recap | undefined> } | undefined;

  pi.registerEntryRenderer<{ text?: string }>(ENTRY, (entry, _options, theme) => {
    const text = entry.data?.text;
    if (!text) return undefined;
    return { invalidate() {}, render: (width: number) => recapLines(text, width, themeStyle(theme)) };
  });

  /** /recap's placeholder above the editor while it waits for the run and the model. */
  const pending = (ctx: ExtensionContext, on: boolean) => {
    try {
      ctx.ui.setWidget(
        WIDGET,
        on ? (_tui, theme) => ({ invalidate() {}, render: (width: number) => recapLines("…", width, themeStyle(theme)) }) : undefined,
      );
    } catch {
      // The runtime went stale.
    }
  };

  const append = (text: string) => {
    try {
      pi.appendEntry(ENTRY, { text });
    } catch {
      // The runtime went stale.
    }
  };

  const reset = () => {
    generation++;
    clearTimeout(timer);
    timer = undefined;
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
    request.reply(summarize(lastCtx).then((r) => r?.text));
  });

  pi.on("session_start", (_event, ctx) => {
    reset();
    memo = undefined;
    active = ctx.mode === "tui";
    lastCtx = active ? ctx : undefined;
  });
  pi.on("session_tree", (_event, ctx) => {
    if (!active) return;
    lastCtx = ctx;
    reset();
  });
  pi.on("session_shutdown", () => {
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
    timer = setTimeout(async () => {
      const r = await recapping;
      if (epoch !== generation || !active || !r) return;
      // A reply that is already one short line is on screen; repeating it adds nothing.
      if (r.source === "reply") return;
      const branch = branchOf(ctx);
      if (branch && recapDue(branch)) append(r.text);
    }, delayMs());
    timer.unref?.();
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
        if (r) append(r.text);
        else ctx.ui.notify("Nothing to recap yet", "warning");
      } finally {
        pending(ctx, false);
      }
    },
  });
}
