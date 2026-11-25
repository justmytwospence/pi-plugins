// pi-ship: after a push, follow the commit's GitHub Actions runs and wake the agent only when they
// fail; /ship runs the repository's own publish steps in a fixed order (check, tidy, review, the
// human gate, publish, watch). Nothing decides by prompt: the steps and stops are code, the
// reviewers are pi-subagents, the verification is a typed System 1 judgment, the findings reach
// the user as draft comments in pi-diff-review, and CI state shows in the suite's activity views.
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_CHANGED, ACTIVITY_GONE, ACTIVITY_HOST, ACTIVITY_SECTION, type ActivityEntry, type ActivitySection } from "./activity.ts";
import { loadConfig } from "./config.ts";
import type { Exec } from "./exec.ts";
import { isPushCommand, parsePushOutput } from "./push.ts";
import { DEFAULT_CONFIG, runShip, type ShipConfig, type ShipCtx } from "./ship.ts";
import { askSystem1 } from "./system1.ts";
import { CiWatcher, type Watch } from "./watcher.ts";

export { DEFAULT_CONFIG };

const SECTION_ID = "ship";

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function piShip(pi: ExtensionAPI, deps: { exec?: Exec; now?: () => number; setTimeout?: (fn: () => void, ms: number) => unknown; clearTimeout?: (handle: unknown) => void } = {}) {
  const exec: Exec = deps.exec ?? (async (cmd, args, cwd, timeout) => {
    const r = await pi.exec(cmd, args, { cwd, timeout: timeout ?? 60_000 });
    return { stdout: r.stdout, stderr: r.stderr, code: r.code };
  });
  const now = deps.now ?? Date.now;
  const safely = (fn: () => void) => {
    try {
      fn();
    } catch {
      // A stale runtime after a reload: nothing to tell.
    }
  };

  // Messages for the agent wait until its turn has ended, as pi-subagents' results do.
  const owed: Array<{ id: string; text: string; wake: boolean }> = [];
  let sessionCtx: { isIdle(): boolean; mode?: string } | undefined;
  const flush = () => {
    if (!owed.length || sessionCtx?.isIdle() === false) return;
    for (const item of owed.splice(0)) safely(() => pi.sendMessage({ customType: "pi-ship", content: item.text, display: true }, { triggerTurn: item.wake, deliverAs: "followUp" }));
  };
  const deliver = (id: string, text: string, wake: boolean) => {
    owed.push({ id, text, wake });
    flush();
  };
  pi.events.on("bg:external-consumed", (data) => {
    const id = (data as { id?: unknown } | undefined)?.id;
    for (let i = owed.length - 1; i >= 0; i--) if (owed[i]!.id === id) owed.splice(i, 1);
  });

  const watcher = new CiWatcher({
    exec,
    now,
    setTimeout: deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimeout: deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    emit: (channel, data) => safely(() => pi.events.emit(channel, data)),
    deliver,
    changed: () => safely(() => pi.events.emit(ACTIVITY_CHANGED, { id: SECTION_ID })),
  });

  const status = (w: Watch): ActivityEntry["status"] => (w.status === "stopped" ? "stopped" : w.status);
  const section: ActivitySection = {
    id: SECTION_ID,
    title: "CI runs",
    noun: "ci",
    entries: (at) =>
      watcher.entries(at).map((w) => ({
        key: w.key,
        label: w.label,
        detail: `${w.repo} ${w.sha.slice(0, 7)} · ${w.detail}`,
        status: status(w),
        stats: elapsed((w.endedAt ?? at) - w.startedAt),
        startedAt: w.startedAt,
        ...(w.endedAt ? { endedAt: w.endedAt } : {}),
      })),
    open: async (key, ui) => {
      const w = watcher.entries(now()).find((e) => e.key === key);
      if (w) (ui as { notify(m: string, t?: string): void }).notify(`${w.repo} ${w.branch} ${w.sha.slice(0, 7)}: ${w.status}, ${w.detail}${w.urls.length ? ` ${w.urls.join(" ")}` : ""}`, "info");
    },
    stop: (key) => watcher.stop(key),
    pill: (at) => {
      const list = watcher.entries(at);
      const running = list.filter((w) => w.status === "running").length;
      const failed = list.some((w) => w.status === "failed");
      if (!running && !failed) return undefined;
      return { label: running ? `${running} CI run${running === 1 ? "" : "s"}` : "", ...(failed ? { alert: "CI failed" } : {}) };
    },
  };
  const offer = () => {
    if (sessionCtx?.mode === "tui") safely(() => pi.events.emit(ACTIVITY_SECTION, { section }));
  };
  pi.events.on(ACTIVITY_HOST, () => offer());

  pi.on("session_start", (_event, ctx) => {
    sessionCtx = ctx;
    offer();
  });
  pi.on("agent_end", (_event, ctx) => {
    sessionCtx = ctx;
    flush();
  });
  pi.on("session_shutdown", () => {
    watcher.dispose();
    safely(() => pi.events.emit(ACTIVITY_GONE, { id: SECTION_ID }));
    sessionCtx = undefined;
  });

  // A successful `git push` the agent ran through bash starts a watch of what it pushed.
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "bash" || event.isError) return;
    const command = String((event.input as { command?: unknown }).command ?? "");
    if (!isPushCommand(command)) return;
    sessionCtx = ctx;
    let text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    const full = (event.details as { fullOutputPath?: string } | undefined)?.fullOutputPath;
    if (full) {
      try {
        text = readFileSync(full, "utf8");
      } catch {
        // The truncated text is what there is.
      }
    }
    const refs = parsePushOutput(text);
    if (!refs.length) return;
    const cfg = loadConfig<ShipConfig>("pi-ship", DEFAULT_CONFIG, ctx.cwd);
    if (!cfg.ci.watch) return;
    for (const ref of refs) void watcher.watch(ref, cfg.ci, ctx.cwd);
  });

  pi.registerCommand("ship", {
    description: "Check, review and publish this repo's change, then watch its CI (--dry shows the steps)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      sessionCtx = ctx;
      const cfg = loadConfig<ShipConfig>("pi-ship", DEFAULT_CONFIG, ctx.cwd);
      const shipCtx = ctx as unknown as ShipCtx;
      try {
        await runShip(
          {
            exec,
            events: pi.events,
            watcher,
            deliver: (text, wake) => deliver("ship", text, wake),
            ask: (c, conf) => (state, questions) => askSystem1(c.modelRegistry, { enabled: conf.system1.enabled, provider: conf.system1.provider, model: conf.system1.model, timeoutMs: conf.system1.timeoutMs }, state, questions),
          },
          shipCtx,
          cfg,
          args,
        );
      } catch (error) {
        ctx.ui.notify(`/ship failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
