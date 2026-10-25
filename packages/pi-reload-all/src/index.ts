// /reload-all: reload every interactive Pi on this machine and on Herdr's saved machines.
//
// No keystrokes are typed into other panes. /reload-all writes a small request file in Pi's agent
// directory (over ssh for each enabled `herdr machine`), and every session running this extension
// watches that file and reloads itself, at a safe moment: when its turn has ended, nothing is
// queued and the editor is empty, so a running turn or a half-written draft only delays it.
//
// ctx.reload() is command-only, so a session reaches it through its own hidden command, which
// pi.sendUserMessage() dispatches at once, even during a turn.
import { execFile } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type AckState, markReloaded, pruneAcks, writeAck } from "./acks.ts";
import { Progress, PROGRESS_LIMIT_MS, type Tracked } from "./progress.ts";
import { agentDir, FILE_NAME, isFresh, makeRequest, readRequest, remoteWriteCommand, type Request, writeRequest } from "./signal.ts";

const run = promisify(execFile);

export const PENDING_COMMAND = "reload-when-idle";
const STATUS = "reload-all";
const ENTRY = "reload-all:report";
const POLL_MS = 30_000;
const RECHECK_MS = 2_000;
/** No reload within this long of a keystroke anywhere in the terminal (main, Sidebar, a dialog). */
export const QUIET_MS = 5_000;
/** Asked synchronously before a reload; any extension may call `hold(reason)` to wait. */
export const PROBE = "reload-all:probe";
/** Holds that mean work a reload would abort. */
const HOLD_CHANNELS = ["herdr:background", "herdr:working", "herdr:blocked"] as const;

/**
 * A hold a reload does not hurt: pi-bg keeps its jobs across a reload, and pi-herdr restores an
 * awaited child's reply in the next runtime.
 */
export function survivesReload(id: string): boolean {
  return id.startsWith("bg:") || id.startsWith("child:");
}

export interface Deps {
  exec(file: string, args: string[], timeoutMs: number): Promise<string>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const defaultDeps: Deps = {
  exec: async (file, args, timeout) => (await run(file, args, { timeout, encoding: "utf8" })).stdout,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  now: () => Date.now(),
};

interface Machine {
  label: string;
  target: string;
}

export interface MachineReport {
  machine: string;
  target: string;
  ok: boolean;
  /** Pi panes Herdr sees there, when it could tell. */
  sessions?: number;
  error?: string;
}

export default function reloadAll(pi: ExtensionAPI, deps: Deps = defaultDeps): void {
  let startedAt = deps.now();
  const handled = new Set<string>();
  let watcher: FSWatcher | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let pending = false;
  /** /reload-all is running here: it reloads this session itself when done. */
  let sending = false;
  let stale = false;
  let ctxRef: ExtensionContext | undefined;
  let lastInput = Number.NEGATIVE_INFINITY;
  let stopInput: (() => void) | undefined;
  let tui: { hasOverlay?(): boolean } | undefined;
  /** Active holds by channel and id (herdr:blocked has no id: counted). */
  const holds = new Map<string, string>();
  let blocked = 0;
  let progress: Progress | undefined;
  /** This session, as its progress reports name it. */
  let self: { session: string; name: string } | undefined;

  const ack = (requestId: string | undefined, state: AckState, reason?: string) => {
    if (!requestId || !self) return;
    try {
      writeAck(requestId, { ...self, state, ...(reason ? { reason } : {}) });
    } catch {
      // progress is best effort
    }
  };

  for (const channel of HOLD_CHANNELS) {
    pi.events?.on?.(channel, (data: unknown) => {
      const e = (data ?? {}) as { active?: unknown; id?: unknown; label?: unknown };
      const active = e.active === true;
      if (channel === "herdr:blocked" && typeof e.id !== "string") {
        blocked = Math.max(0, blocked + (active ? 1 : -1));
        return;
      }
      const id = `${channel}:${typeof e.id === "string" ? e.id : String(e.label ?? "")}`;
      if (typeof e.id === "string" && survivesReload(e.id)) return;
      if (active) holds.set(id, typeof e.label === "string" && e.label ? e.label : channel === "herdr:working" ? "planner" : "background work");
      else holds.delete(id);
    });
  }

  /** Why a reload must wait now, or undefined when nothing else is in the way. */
  const heldBy = (): string | undefined => {
    if (sending) return "/reload-all";
    if (deps.now() - lastInput < QUIET_MS) return "typing";
    if (holds.size) return [...new Set(holds.values())].join(", ");
    if (blocked) return "a question";
    try {
      if (tui?.hasOverlay?.()) return "an open dialog";
    } catch {
      // stale TUI
    }
    const reasons: string[] = [];
    try {
      pi.events?.emit?.(PROBE, { hold: (reason: string) => reasons.push(String(reason)) });
    } catch {
      // a listener failed: do not let it block forever
    }
    return reasons[0];
  };

  pi.registerEntryRenderer<{ lines?: string[] }>(ENTRY, (entry, _options, theme) => {
    const lines = entry.data?.lines;
    if (!lines?.length) return undefined;
    return new Text(lines.map((l, i) => theme.fg(i ? "dim" : "muted", l)).join("\n"), 1, 0);
  });

  const check = () => {
    if (stale || pending || sending || !ctxRef) return;
    const request = readRequest();
    if (!isFresh(request, startedAt, handled)) return;
    handled.add(request.id);
    pending = true;
    try {
      ctxRef.ui.setStatus(STATUS, "reload pending");
    } catch {
      // stale runtime
    }
    ack(request.id, "pending");
    pi.sendUserMessage(`/${PENDING_COMMAND} ${request.id}`, { expandPromptTemplates: true });
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    startedAt = deps.now();
    ctxRef = ctx;
    stale = false;
    try {
      const session = ctx.sessionManager.getSessionId();
      let name = "";
      try {
        name = pi.getSessionName() ?? "";
      } catch {
        // none
      }
      self = { session, name: name.trim() || basename(ctx.cwd) || session };
      // This runtime is what a "reloading" report was waiting for.
      markReloaded(session);
    } catch {
      self = undefined;
    }
    resumeProgress(ctx);
    try {
      watcher = watch(agentDir(), (_type, name) => {
        if (!name || name === FILE_NAME) check();
      });
      watcher.on("error", () => watcher?.close());
      watcher.unref?.();
    } catch {
      // No watch support: the poll still finds it.
    }
    poll = setInterval(check, POLL_MS);
    poll.unref?.();
    try {
      stopInput = ctx.ui.onTerminalInput?.(() => {
        lastInput = deps.now();
        return undefined;
      });
    } catch {
      // no input hook
    }
    // Borrow the TUI to see open overlays; widget factories receive it.
    try {
      ctx.ui.setWidget("reload-all-probe", (t) => {
        tui = t as unknown as typeof tui;
        return { render: () => [], invalidate() {} };
      });
      ctx.ui.setWidget("reload-all-probe", undefined);
    } catch {
      // no widgets
    }
  });

  pi.on("session_shutdown", () => {
    stale = true;
    ctxRef = undefined;
    watcher?.close();
    watcher = undefined;
    if (poll) clearInterval(poll);
    poll = undefined;
    stopInput?.();
    stopInput = undefined;
    tui = undefined;
    progress?.stop();
    progress = undefined;
  });

  const startProgress = (ctx: ExtensionContext, t: Tracked) => {
    progress?.stop();
    const theme = ctx.ui.theme;
    const paint = (color: string) => (s: string) => {
      try {
        return theme.fg(color as never, s);
      } catch {
        return s;
      }
    };
    progress = new Progress(
      t,
      { setWidget: (key, lines) => ctx.ui.setWidget(key, lines), dim: paint("dim"), accent: paint("accent"), warn: paint("warning"), ok: paint("success") },
      deps,
      (lines) => {
        progress = undefined;
        if (stale) return;
        try {
          pi.appendEntry(ENTRY, { lines, final: t.id });
        } catch {
          // stale runtime
        }
      },
    );
    progress.start();
  };

  /** After the sending session's own reload, its live view picks up where it was. */
  const resumeProgress = (ctx: ExtensionContext) => {
    let branch: { type?: string; customType?: string; data?: unknown }[] = [];
    try {
      branch = ctx.sessionManager.getBranch() as typeof branch;
    } catch {
      return;
    }
    const finished = new Set<string>();
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i]!;
      if (e.type !== "custom" || e.customType !== ENTRY) continue;
      const data = e.data as { track?: Tracked; final?: string } | undefined;
      if (data?.final) finished.add(data.final);
      const t = data?.track;
      if (!t) continue;
      if (!finished.has(t.id) && deps.now() - t.at < PROGRESS_LIMIT_MS) startProgress(ctx, t);
      return;
    }
  };

  /** Reloads this session once it is safe. Nothing may touch pi or ctx after ctx.reload(). */
  const reloadWhenSafe = async (ctx: ExtensionCommandContext, requestId?: string) => {
    pending = true;
    let shown = "";
    const held = () => {
      const reason = heldBy();
      const text = reason ? `reload pending: ${reason}` : "reload pending";
      if (text !== shown) {
        shown = text;
        ack(requestId, "pending", reason);
        try {
          ctx.ui.setStatus(STATUS, text);
        } catch {
          // stale runtime
        }
      }
      return !!reason;
    };
    if (await waitUntilSafe(ctx, () => stale, deps, held)) {
      ack(requestId, "reloading");
      await ctx.reload();
    }
    if (stale) return;
    ack(requestId, "failed", "Pi skipped the reload (compacting?)");
    // Not reloaded (Pi skips it while compacting): accept the next request.
    pending = false;
    try {
      ctx.ui.setStatus(STATUS, undefined);
    } catch {
      // stale runtime
    }
  };

  pi.registerCommand(PENDING_COMMAND, {
    description: "Reload once the turn ends and the editor is empty (used by /reload-all)",
    handler: async (args, ctx) => reloadWhenSafe(ctx, args.trim() || undefined),
  });

  pi.registerCommand("reload-all", {
    description: "Reload every Pi session here and on Herdr's saved machines (--local: this machine only; stop: close the progress view)",
    handler: async (args, ctx) => {
      if (/^\s*stop\s*$/u.test(args)) {
        progress?.dismiss();
        progress = undefined;
        return;
      }
      const request = makeRequest();
      // This session's watcher must not reload it while the command still runs.
      handled.add(request.id);
      sending = true;
      let sent: { lines: string[]; track: Tracked };
      try {
        sent = await signal(args, request);
      } finally {
        sending = false;
      }
      if (ctx.mode !== "tui" || !ctx.hasUI) return ctx.ui.notify(sent.lines.join("\n"), "info");
      // The report and what to watch are kept as an entry: the reload rebuilds the chat, and the
      // next runtime resumes the live view from it.
      startProgress(ctx, sent.track);
      await reloadWhenSafe(ctx, request.id);
    },
  });

  /** Writes the request everywhere and records the report. */
  const signal = async (args: string, request: Request): Promise<{ lines: string[]; track: Tracked }> => {
    const local = /(^|\s)--local(\s|$)/u.test(args);
    const lines = ["/reload-all: sessions reload when their turn ends and the editor is empty"];
    let expected: number | undefined = 0;
    try {
      pruneAcks();
      writeRequest(request);
      const n = await countLocal(deps);
      expected = n;
      lines.push(`  this machine: signalled${countText(n)}`);
    } catch (error) {
      expected = undefined;
      lines.push(`  this machine: failed (${message(error)})`);
    }
    const machines: Tracked["machines"] = [];
    if (!local) {
      for (const r of await signalMachines(request, deps)) {
        lines.push(`  ${r.machine}: ${r.ok ? `signalled${countText(r.sessions)}` : `failed (${r.error})`}`);
        if (!r.ok) continue;
        machines.push({ label: r.machine, target: r.target });
        expected = expected === undefined || r.sessions === undefined ? undefined : expected + r.sessions;
      }
    }
    const track: Tracked = { id: request.id, at: request.at, machines, ...(expected === undefined ? {} : { expected }) };
    pi.appendEntry(ENTRY, { lines, track });
    return { lines, track };
  };
}

/** Waits for an ended turn, an empty queue and an empty editor. False when the runtime went stale. */
export async function waitUntilSafe(
  ctx: ExtensionCommandContext,
  isStale: () => boolean,
  deps: Pick<Deps, "sleep">,
  isHeld: () => boolean = () => false,
): Promise<boolean> {
  for (;;) {
    await ctx.waitForIdle();
    if (isStale()) return false;
    let draft = "";
    try {
      draft = ctx.ui.getEditorText();
    } catch {
      return false;
    }
    // A queued follow-up can start another run right after idle.
    if (!isHeld() && ctx.isIdle() && !ctx.hasPendingMessages() && !draft.trim()) return true;
    await deps.sleep(RECHECK_MS);
    if (isStale()) return false;
  }
}

function countText(n: number | undefined): string {
  return n === undefined ? "" : ` (${n} Pi session${n === 1 ? "" : "s"} in Herdr)`;
}

function message(error: unknown): string {
  const e = error as { stderr?: string; message?: string };
  const text = (e?.stderr || e?.message || String(error)).trim().split("\n").filter((l) => !/^\*\*|^Warning: remote port forwarding/u.test(l)).pop();
  return text || "error";
}

export function countPi(json: string): number | undefined {
  try {
    const agents = JSON.parse(json)?.result?.agents;
    return Array.isArray(agents) ? agents.filter((a: { agent?: string }) => a?.agent === "pi").length : undefined;
  } catch {
    return undefined;
  }
}

async function countLocal(deps: Deps): Promise<number | undefined> {
  if (process.env.HERDR_ENV !== "1") return undefined;
  try {
    return countPi(await deps.exec("herdr", ["agent", "list"], 10_000));
  } catch {
    return undefined;
  }
}

export function parseMachines(json: string): Machine[] {
  try {
    const list = JSON.parse(json);
    if (!Array.isArray(list)) return [];
    return list
      .filter((m) => m?.enabled !== false && typeof m?.target === "string" && m.target)
      .map((m) => ({ label: typeof m.label === "string" && m.label ? m.label : m.target, target: m.target }));
  } catch {
    return [];
  }
}

/** Writes the request on every enabled Herdr machine over ssh, in parallel. */
export async function signalMachines(request: Request, deps: Deps): Promise<MachineReport[]> {
  let machines: Machine[];
  try {
    machines = parseMachines(await deps.exec("herdr", ["machine", "list", "--json"], 10_000));
  } catch {
    return [];
  }
  const command = remoteWriteCommand(request);
  return Promise.all(
    machines.map(async (m): Promise<MachineReport> => {
      try {
        await deps.exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", m.target, command], 20_000);
      } catch (error) {
        return { machine: m.label, target: m.target, ok: false, error: message(error) };
      }
      let sessions: number | undefined;
      try {
        sessions = countPi(await deps.exec("herdr", ["--machine", m.label, "agent", "list"], 15_000));
      } catch {
        // The signal went out; only the count is missing.
      }
      return { machine: m.label, target: m.target, ok: true, ...(sessions === undefined ? {} : { sessions }) };
    }),
  );
}
