// pi-copy: `/yank` (and ctrl+shift+x) opens a picker of things to copy from the session: whole
// messages and the pieces inside them, found in code. Jev, through Pi's own classifier models,
// ranks what you most likely want to copy now and filters out prose that is only explanation.
// Pi's built-in `/copy` (last reply) and ctrl+x are left as they are: the interactive editor handles
// `/copy` before extension commands, so this command cannot replace it.
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { whileBlocked } from "./herdr.ts";
import { type JevConfig, askJev } from "./jev.ts";
import { Picker, type PickerModel } from "./picker.ts";
import { DEFAULT_RANK, type Judged, type RankSettings, chronological, piecesToJudge, rankQuestions, rankState, readJudgments, suggested } from "./rank.ts";
import { type Segment, extractSegments, segmentKey } from "./segments.ts";
import { clip, messageText } from "./transcript.ts";

export interface CopyConfig extends Record<string, unknown> {
  jev: JevConfig;
  rank: RankSettings;
  /** User turns the picker covers. */
  maxTurns: number;
  shortcut: string;
}

export const DEFAULT_CONFIG: CopyConfig = {
  jev: { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 3_000 },
  rank: DEFAULT_RANK,
  maxTurns: 30,
  shortcut: "ctrl+shift+x",
};

export default function piCopy(pi: ExtensionAPI) {
  // Jev's judgments by piece content, for this session.
  const cache = new Map<string, Judged>();
  let config: CopyConfig = DEFAULT_CONFIG;

  const open = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/yank needs the interactive terminal UI.", "warning");
      return;
    }
    config = loadConfig("copy", DEFAULT_CONFIG, ctx.cwd);
    const branch = ctx.sessionManager.getBranch();
    const segments = extractSegments(branch, config.maxTurns);
    if (!segments.length) {
      ctx.ui.notify("Nothing to copy yet.", "info");
      return;
    }
    const lastTurn = Math.max(...segments.map((s) => s.turn));
    const model = (ranking: PickerModel["ranking"]): PickerModel => ({
      suggested: suggested(segments, cache, config.rank),
      all: chronological(segments),
      ranking,
      lastTurn,
    });

    const pending = piecesToJudge(segments, config.rank).filter((s) => !cache.has(segmentKey(s)));
    const controller = new AbortController();
    let picker: Picker | undefined;
    const ranking: Promise<PickerModel["ranking"]> = pending.length
      ? askJev(ctx.modelRegistry, config.jev, rankState(pending, recentUserMessages(branch), config.rank), rankQuestions(pending), controller.signal).then((outcome) => {
          if (!outcome.ok) return "unavailable";
          for (const [key, value] of readJudgments(pending, outcome.answers)) cache.set(key, value);
          pi.appendEntry("copy:decision", { pieces: pending.length, latencyMs: outcome.latencyMs, inputTokens: outcome.usage?.input });
          return "done";
        })
      : Promise.resolve(cache.size ? "done" : "unavailable");
    void ranking.then((state) => picker?.update(model(state)));

    const chosen = await whileBlocked(pi.events, "Yank picker", () =>
      ctx.ui.custom<Segment | undefined>((tui, theme, _keybindings, done) => {
        picker = new Picker(model(pending.length ? "pending" : cache.size ? "done" : "unavailable"), theme as never, () => tui.requestRender(), done);
        return picker;
      }),
    );
    controller.abort();
    if (!chosen) return;
    try {
      await copyToClipboard(chosen.text);
      const lines = chosen.text.split("\n").length;
      ctx.ui.notify(`Copied ${chosen.kind === "code" && chosen.lang ? `${chosen.lang} code` : chosen.kind} (${lines} line${lines === 1 ? "" : "s"}, ${chosen.text.length} chars)`, "info");
    } catch (error) {
      ctx.ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig("copy", DEFAULT_CONFIG, ctx.cwd);
    cache.clear();
  });

  pi.registerCommand("yank", {
    description: "Pick something from this session to copy: replies, code, commands, paths, URLs",
    handler: async (_args, ctx) => open(ctx),
  });

  // Shortcuts are registered at load, from the global settings (a project file cannot change it).
  const shortcut = loadConfig("copy", DEFAULT_CONFIG, process.cwd()).shortcut;
  pi.registerShortcut(shortcut as never, {
    description: "Pick something from this session to copy (/yank)",
    handler: (ctx) => open(ctx),
  });
}

function recentUserMessages(entries: readonly unknown[]): string[] {
  const out: string[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < 3; i--) {
    const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const text = messageText(entry.message.content).trim();
    if (text) out.unshift(clip(text, 500));
  }
  return out;
}
