// pi-pressure: a status that appears only while the machine is under CPU,
// memory or thermal pressure, and disappears once it eases. pi-status-footer
// folds it into its own footer row; without it, it shows in Pi's status row.
// It shows on its own when thresholds are hit; `/pressure` toggles it by hand
// (`show` pins it, `hide` dismisses it until the episode ends, `auto` hands it
// back), and `/pressure details` prints readings, thresholds and top processes.
//
// No polling: readings are taken when Pi does something (input, turns, tool
// calls, streamed output) and when the macOS helper reports a state change.
// Kernel counters make each read the exact average since the previous one. The
// only timers are one-shot, armed while an episode is building, showing or
// easing; in the steady state nothing runs.

import { existsSync, readFileSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMonitor, darwinMemoryText, DEFAULTS, formatBytes, formatRate, formatStatus, type Level, type Mode, type Paint, type PressureConfig, SIGNALS, topBy, type View } from "./pressure.ts";
import { ensureHelper, startHelper } from "./darwin.ts";
import { createSampler, processLabel, type Sampler } from "./sample.ts";

export const STATUS_KEY = "pressure";
const TOP_REFRESH_MS = 10_000;

type Partial2<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Merge user settings over the defaults, keeping only sensible values. */
export function mergeConfig(...layers: Partial2<PressureConfig>[]): PressureConfig {
  const config: PressureConfig = structuredClone(DEFAULTS);
  for (const layer of layers) {
    if (typeof layer.enabled === "boolean") config.enabled = layer.enabled;
    for (const key of ["minGapMs", "showAfterMs", "hideAfterMs", "refreshMs"] as const) if (finite(layer[key])) config[key] = layer[key];
    for (const key of ["cpu", "loadPerCore", "memorySome", "memoryFull", "swapInMBps"] as const) {
      const band = layer[key];
      if (!band || typeof band !== "object") continue;
      if (finite(band.warn)) config[key].warn = band.warn;
      if (finite(band.hot)) config[key].hot = band.hot;
    }
  }
  config.minGapMs = Math.max(250, config.minGapMs);
  config.refreshMs = Math.max(1_000, config.refreshMs);
  return config;
}

export function loadConfig(cwd = process.cwd()): PressureConfig {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const read = (path: string): Partial2<PressureConfig> => {
    try {
      if (!existsSync(path)) return {};
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  return mergeConfig(read(join(agentDir, "pi-pressure.json")), read(join(cwd, ".pi", "pi-pressure.json")));
}

const kb = (value: number) => formatRate(value * 1024).replace("/s", "");
const DARWIN_LEVELS: Record<number, string> = { 1: "normal", 2: "warn", 4: "critical" };
const THERMAL_STATES = ["nominal", "fair", "serious (throttling)", "critical"];

/** `/pressure`'s plain-text report. */
const MODE_TEXT: Record<Mode, string> = {
  auto: "automatic",
  shown: "shown by hand (/pressure auto hands it back)",
  hidden: "hidden by hand until this episode ends",
};

export async function report(view: View | undefined, config: PressureConfig, sampler: Sampler, source: string): Promise<string> {
  const lines: string[] = [];
  const state = view?.visible ? "showing" : "hidden";
  const auto = config.enabled ? "" : " Automatic showing is off (enabled: false).";
  lines.push(`Pressure: ${state}, ${MODE_TEXT[view?.mode ?? "auto"]}.${auto} Shows after ${config.showAfterMs / 1000}s at warn or above, hides ${config.hideAfterMs / 1000}s after it eases. Read on Pi activity; ${source}.`);
  const r = view?.reading;
  const lv = (signal: (typeof SIGNALS)[number]) => view?.levels[signal] ?? "ok";
  if (!r) lines.push("No reading yet.");
  else {
    const arrow = (signal: (typeof SIGNALS)[number]) => view.trends[signal] === "up" ? " \u2191 rising" : view.trends[signal] === "down" ? " \u2193 falling" : "";
    const span = r.since === undefined ? "" : ` over the last ${Math.max(1, Math.round((r.at - r.since) / 1000))}s`;
    lines.push(`cpu ${r.cpu === undefined ? "?" : Math.round(r.cpu)} busy${span}${arrow("cpu")} · ${lv("cpu")} (warn ${config.cpu.warn}, hot ${config.cpu.hot})`);
    lines.push(`load ${r.loadPerCore.toFixed(2)} per core${arrow("load")} · ${lv("load")} (warn ${config.loadPerCore.warn}, hot ${config.loadPerCore.hot})`);
    const m = r.memory;
    if (m?.source === "darwin") {
      const numbers = darwinMemoryText(m);
      lines.push(`memory ${numbers ? `${numbers} of ${formatBytes(totalmem())}; ` : ""}pressure level ${m.level} (${DARWIN_LEVELS[m.level] ?? "unknown"})${arrow("mem")} · ${lv("mem")}`);
    }
    else if (m?.source === "psi") lines.push(`memory stall some ${m.some.toFixed(1)} full ${m.full.toFixed(1)}${span}${arrow("mem")} · ${lv("mem")} (some warn ${config.memorySome.warn}, hot ${config.memorySome.hot}; full warn ${config.memoryFull.warn}, hot ${config.memoryFull.hot})`);
    else lines.push("memory pressure unavailable on this platform");
    if (r.thermal) lines.push(`thermal ${THERMAL_STATES[r.thermal.state] ?? r.thermal.state}${arrow("heat")} · ${lv("heat")}`);
    if (r.swapInBps !== undefined) lines.push(`swap-in ${formatRate(r.swapInBps)}${arrow("swap")} · ${lv("swap")} (warn ${config.swapInMBps.warn}MB/s, hot ${config.swapInMBps.hot}MB/s)`);
  }
  const [cpu, memory] = await Promise.all([sampler.top("cpu", 5), sampler.top("memory", 5)]);
  if (cpu.length) lines.push(`top cpu: ${cpu.map((p) => `${processLabel(p)} ${Math.round(p.cpu)}`).join(", ")}`);
  if (memory.length) lines.push(`top memory: ${memory.map((p) => `${processLabel(p)} ${kb(p.rssKb)}`).join(", ")}`);
  return lines.join("\n");
}

const isStaleCtx = (error: unknown) => error instanceof Error && /\bstale\b/iu.test(error.message);

const ACTIVITY = ["input", "agent_start", "agent_end", "turn_start", "turn_end", "tool_execution_start", "tool_execution_end", "message_update"] as const;

export const SUBCOMMANDS = ["show", "hide", "auto", "details"] as const;

export default function pressureExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const sampler = createSampler();
  // Pinned by hand: survives session switches in this Pi process. A dismissal does not need to.
  let pinned = false;
  let ctx: ExtensionContext | undefined;
  let generation = 0;
  let busy = false;
  let again = false;
  let lastRead = 0;
  let wake: ReturnType<typeof setTimeout> | undefined;
  let helper: { stop(): void } | undefined;
  let helperState: "starting" | "live" | "unavailable" = "unavailable";
  let monitor = createMonitor(config);
  let last: View | undefined;
  let lastStatus: string | undefined;
  let top: { name?: string; at: number } | undefined;

  const paint = (context: ExtensionContext): Paint => {
    const theme = context.ui.theme;
    const color: Record<Level, "muted" | "warning" | "error"> = { ok: "muted", warn: "warning", hot: "error" };
    return { level: (level, text) => theme.fg(color[level], text), dim: (text) => theme.fg("dim", text) };
  };

  const publish = (status: string | undefined) => {
    if (!ctx || status === lastStatus) return;
    lastStatus = status;
    ctx.ui.setStatus(STATUS_KEY, status);
  };

  const stop = () => {
    generation++;
    if (wake !== undefined) clearTimeout(wake);
    wake = undefined;
    helper?.stop();
    helper = undefined;
    const context = ctx;
    if (context && lastStatus !== undefined) {
      try { context.ui.setStatus(STATUS_KEY, undefined); } catch { /* The session is already gone. */ }
    }
    lastStatus = undefined;
    top = undefined;
  };

  /** One-shot: read again when the monitor needs to decide something Pi activity may not arrive in time for. */
  const arm = (epoch: number) => {
    if (wake !== undefined) clearTimeout(wake);
    wake = undefined;
    const due = monitor.nextCheck();
    if (due === undefined) return;
    wake = setTimeout(() => { wake = undefined; void read(epoch, true); }, Math.max(0, due - Date.now()));
    wake.unref?.();
  };

  const read = async (epoch: number, force = false): Promise<void> => {
    if (epoch !== generation || !ctx) return;
    // A forced read (a kernel push, a timer, a command) during another runs right after it.
    if (busy) { if (force) again = true; return; }
    if (!force && Date.now() - lastRead < config.minGapMs) return;
    busy = true;
    try {
      const reading = await sampler.sample();
      lastRead = reading.at;
      if (epoch !== generation || !ctx) return;
      const view = monitor.step(reading);
      last = view;
      if (!view.visible) {
        top = undefined;
        publish(undefined);
      } else {
        if (!top || reading.at - top.at >= TOP_REFRESH_MS) {
          const rows = await sampler.top(topBy(view), "standouts");
          if (epoch !== generation || !ctx) return;
          top = { name: rows.length ? rows.map(processLabel).join(", ") : undefined, at: reading.at };
        }
        publish(formatStatus(view, top.name, paint(ctx)));
      }
      arm(epoch);
    } catch (error) {
      // A timer or event must never take Pi down; a stale ctx means we missed the session's end.
      if (isStaleCtx(error)) { stop(); ctx = undefined; }
    } finally {
      busy = false;
      if (again && epoch === generation) { again = false; void read(epoch, true); }
    }
  };

  const startHelperFor = (epoch: number) => {
    if (process.platform !== "darwin") return;
    helperState = "starting";
    void ensureHelper().then((binary) => {
      if (epoch !== generation) return;
      if (!binary) { helperState = "unavailable"; return; }
      helper = startHelper(binary, (line) => {
        helperState = "live";
        sampler.setDarwin({ ...line, at: Date.now() });
        void read(epoch, true);
      }, () => {
        helper = undefined;
        helperState = "unavailable";
        sampler.helperGone();
      });
    });
  };

  const start = (context: ExtensionContext) => {
    stop();
    ctx = context;
    if (!context.hasUI) return;
    monitor = createMonitor(config);
    if (pinned) monitor.setMode("shown");
    last = undefined;
    const epoch = generation;
    startHelperFor(epoch);
    void read(epoch, true);
  };

  /** Change the mode and redraw from a fresh reading. */
  const setMode = async (mode: Mode) => {
    pinned = mode === "shown";
    last = monitor.setMode(mode);
    await read(generation, true);
  };

  pi.on("session_start", (_event, context) => start(context));
  pi.on("session_shutdown", () => {
    stop();
    ctx = undefined;
  });
  for (const event of ACTIVITY) pi.on(event as "turn_end", () => { void read(generation); });

  const source = () => process.platform === "darwin"
    ? helperState === "live" ? "macOS memory and thermal pushed by the kernel" : helperState === "starting" ? "macOS helper starting" : "macOS memory from sysctl (no Swift compiler for the helper)"
    : process.platform === "linux" ? "Linux memory from PSI totals" : "CPU only on this platform";

  pi.registerCommand("pressure", {
    description: "Toggle the pressure row by hand; `show` pins it, `hide` dismisses it until the episode ends, `auto` hands it back, `details` reports readings",
    getArgumentCompletions: (prefix: string) => SUBCOMMANDS.filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, context) => {
      const arg = args.trim();
      if (arg === "details") {
        if (ctx) await read(generation, true);
        let view = ctx ? last : undefined;
        if (!view) {
          // No UI session: two quick reads of our own for a CPU delta.
          const once = createSampler();
          await once.sample();
          await new Promise((resolve) => setTimeout(resolve, 300));
          view = createMonitor(config).step(await once.sample());
        }
        context.ui.notify(await report(view, config, sampler, source()), "info");
        return;
      }
      if (arg && !(SUBCOMMANDS as readonly string[]).includes(arg)) {
        context.ui.notify(`pressure: unknown "${arg}"; use ${SUBCOMMANDS.join(", ")}, or nothing to toggle`, "warning");
        return;
      }
      if (!ctx) {
        context.ui.notify("pressure: the row needs Pi's terminal UI", "warning");
        return;
      }
      const visible = monitor.view().visible;
      const mode: Mode = arg === "show" ? "shown" : arg === "hide" ? "hidden" : arg === "auto" ? "auto" : visible ? "hidden" : "shown";
      await setMode(mode);
      const view = monitor.view();
      const note = view.mode === "shown" ? "shown until you hide it"
        : view.mode === "hidden" ? "hidden until this episode ends"
        : view.visible ? "automatic (showing: thresholds are hit)" : "automatic: shows when thresholds are hit";
      context.ui.notify(`pressure: ${note}`, "info");
    },
  });
}
