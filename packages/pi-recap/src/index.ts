// pi-recap: a one-line recap of where the session stands, shown above the editor after the session
// has sat idle for a while (3 minutes by default) after a turn, and on demand with /recap.
//
// The recap is computed once per settled turn (summary.ts, one small-model call) and shared: pi-herdr
// asks for it over the event bus and writes it to its `$summary` pane token, so the turn's
// notification and the recap line are the same text.
//
// Event bus:
//   recap:summary { reply(promise) }   pi-recap calls reply with a Promise<string | undefined> for
//                                      the current turn (memoized), when it is loaded and active
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Recap, type RecapRegistry, recap } from "./summary.ts";

export const WIDGET = "recap";
export const LABEL = "※ recap: ";
const DEFAULT_DELAY_MS = 180_000;

export interface RecapRequest {
  reply?: (summary: Promise<string | undefined>) => void;
}

function delayMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PI_RECAP_DELAY_MS);
  return Number.isFinite(n) && n >= 0 && env.PI_RECAP_DELAY_MS?.trim() ? n : DEFAULT_DELAY_MS;
}

/** The recap's lines: the label, then the text wrapped to line up after it, all dimmed. */
export function recapLines(text: string, width: number, dim: (s: string) => string = (s) => s): string[] {
  const indent = 1 + visibleWidth(LABEL);
  return wrapTextWithAnsi(text, Math.max(10, width - indent - 1)).map((line, i) => dim(`${i === 0 ? ` ${LABEL}` : " ".repeat(indent)}${line}`));
}

export default function piRecap(pi: ExtensionAPI) {
  let active = false;
  let lastCtx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Bumped whenever a pending recap goes stale: a new run, a tree jump, a new session.
  let generation = 0;
  let memo: { key: string; promise: Promise<Recap | undefined> } | undefined;

  const show = (ctx: ExtensionContext, text: string | undefined) => {
    try {
      ctx.ui.setWidget(
        WIDGET,
        text
          ? (_tui, theme) => ({
              invalidate() {},
              render: (width: number) => recapLines(text, width, (s) => theme.fg("dim", s)),
            })
          : undefined,
      );
    } catch {
      // The runtime went stale.
    }
  };

  const reset = (ctx?: ExtensionContext) => {
    generation++;
    clearTimeout(timer);
    timer = undefined;
    if (ctx && active) show(ctx, undefined);
  };

  /** The recap of the branch's latest turn, computed once per leaf. */
  const summarize = (ctx: ExtensionContext): Promise<Recap | undefined> => {
    let branch: any[];
    try {
      branch = ctx.sessionManager.getBranch() as any[];
    } catch {
      return Promise.resolve(undefined);
    }
    const leaf = branch.at(-1);
    const key = `${leaf?.id ?? ""}:${branch.length}`;
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
    reset(lastCtx);
    memo = undefined;
    active = ctx.mode === "tui";
    lastCtx = active ? ctx : undefined;
  });
  pi.on("session_tree", (_event, ctx) => {
    if (!active) return;
    lastCtx = ctx;
    reset(ctx);
  });
  pi.on("session_shutdown", () => {
    reset(lastCtx);
    active = false;
    lastCtx = undefined;
    memo = undefined;
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!active) return;
    lastCtx = ctx;
    reset(ctx);
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
    const pending = summarize(ctx);
    timer = setTimeout(async () => {
      const r = await pending;
      // A reply that is already one short line is on screen; repeating it adds nothing.
      if (epoch === generation && active && r && r.source !== "reply") show(ctx, r.text);
    }, delayMs());
    timer.unref?.();
  });

  pi.registerCommand("recap", {
    description: "Recap where this session stands, in one line above the editor",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      active = true;
      lastCtx = ctx;
      show(ctx, "…");
      await ctx.waitForIdle();
      reset();
      const epoch = generation;
      const r = await summarize(ctx);
      if (epoch !== generation) return;
      show(ctx, r?.text);
      if (!r) ctx.ui.notify("Nothing to recap yet", "warning");
    },
  });
}
