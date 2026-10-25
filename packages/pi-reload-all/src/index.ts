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
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { agentDir, FILE_NAME, isFresh, makeRequest, readRequest, remoteWriteCommand, type Request, writeRequest } from "./signal.ts";

const run = promisify(execFile);

export const PENDING_COMMAND = "reload-when-idle";
const STATUS = "reload-all";
const ENTRY = "reload-all:report";
const POLL_MS = 30_000;
const RECHECK_MS = 2_000;

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
    pi.sendUserMessage(`/${PENDING_COMMAND}`, { expandPromptTemplates: true });
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    startedAt = deps.now();
    ctxRef = ctx;
    stale = false;
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
  });

  pi.on("session_shutdown", () => {
    stale = true;
    ctxRef = undefined;
    watcher?.close();
    watcher = undefined;
    if (poll) clearInterval(poll);
    poll = undefined;
  });

  /** Reloads this session once it is safe. Nothing may touch pi or ctx after ctx.reload(). */
  const reloadWhenSafe = async (ctx: ExtensionCommandContext) => {
    pending = true;
    if (await waitUntilSafe(ctx, () => stale, deps, () => sending)) await ctx.reload();
    if (stale) return;
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
    handler: async (_args, ctx) => reloadWhenSafe(ctx),
  });

  pi.registerCommand("reload-all", {
    description: "Reload every Pi session here and on Herdr's saved machines (--local: this machine only)",
    handler: async (args, ctx) => {
      const request = makeRequest();
      // This session's watcher must not reload it while the command still runs.
      handled.add(request.id);
      sending = true;
      let lines: string[];
      try {
        lines = await signal(args, request);
      } finally {
        sending = false;
      }
      if (ctx.mode !== "tui" || !ctx.hasUI) return ctx.ui.notify(lines.join("\n"), "info");
      // The report is kept as an entry: the reload rebuilds the chat.
      await reloadWhenSafe(ctx);
    },
  });

  /** Writes the request everywhere and records the report. */
  const signal = async (args: string, request: Request): Promise<string[]> => {
    const local = /(^|\s)--local(\s|$)/u.test(args);
    const lines = ["/reload-all: sessions reload when their turn ends and the editor is empty"];
    try {
      writeRequest(request);
      lines.push(`  this machine: signalled${countText(await countLocal(deps))}`);
    } catch (error) {
      lines.push(`  this machine: failed (${message(error)})`);
    }
    if (!local) for (const r of await signalMachines(request, deps)) lines.push(`  ${r.machine}: ${r.ok ? `signalled${countText(r.sessions)}` : `failed (${r.error})`}`);
    pi.appendEntry(ENTRY, { lines });
    return lines;
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
        return { machine: m.label, ok: false, error: message(error) };
      }
      let sessions: number | undefined;
      try {
        sessions = countPi(await deps.exec("herdr", ["--machine", m.label, "agent", "list"], 15_000));
      } catch {
        // The signal went out; only the count is missing.
      }
      return { machine: m.label, ok: true, ...(sessions === undefined ? {} : { sessions }) };
    }),
  );
}
