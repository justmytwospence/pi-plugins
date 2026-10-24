// pi-pressure: a status that appears only while the machine is under CPU or
// memory pressure, and disappears once it eases. pi-status-footer folds it into
// its own footer row; without it, it shows in Pi's status row. `/pressure`
// prints the readings, thresholds and top processes; `/pressure on|off` toggles it.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMonitor, DEFAULTS, formatRate, formatStatus, type Level, type Paint, type PressureConfig, SIGNALS, spark, topBy, type View } from "./pressure.ts";
import { createSampler, type Sampler } from "./sample.ts";

export const STATUS_KEY = "pressure";
const TOP_REFRESH_MS = 10_000;

type Partial2<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Merge user settings over the defaults, keeping only sensible values. */
export function mergeConfig(...layers: Partial2<PressureConfig>[]): PressureConfig {
  const config: PressureConfig = structuredClone(DEFAULTS);
  for (const layer of layers) {
    if (typeof layer.enabled === "boolean") config.enabled = layer.enabled;
    for (const key of ["intervalMs", "showAfterMs", "hideAfterMs", "historyMinutes"] as const) if (finite(layer[key])) config[key] = layer[key];
    for (const key of ["cpu", "loadPerCore", "memorySome", "memoryFull", "swapInMBps"] as const) {
      const band = layer[key];
      if (!band || typeof band !== "object") continue;
      if (finite(band.warn)) config[key].warn = band.warn;
      if (finite(band.hot)) config[key].hot = band.hot;
    }
  }
  config.intervalMs = Math.max(500, config.intervalMs);
  config.historyMinutes = Math.max(1, Math.min(120, Math.round(config.historyMinutes)));
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

/** `/pressure`'s plain-text report. */
export async function report(view: View | undefined, config: PressureConfig, sampler: Sampler, watching: boolean): Promise<string> {
  const lines: string[] = [];
  const state = !watching ? "off (/pressure on)" : view?.visible ? "showing" : "hidden";
  lines.push(`Pressure: ${state}. Shows after ${config.showAfterMs / 1000}s at warn or above, hides ${config.hideAfterMs / 1000}s after it eases.`);
  const r = view?.reading;
  const lv = (signal: (typeof SIGNALS)[number]) => view?.levels[signal] ?? "ok";
  if (!r) lines.push("No reading yet.");
  else {
    const trace = view.history.some((v) => v !== undefined) ? ` (last ${view.history.length} min, a minute per dot column: ${spark(view.history)})` : "";
    lines.push(`cpu ${r.cpu === undefined ? "?" : Math.round(r.cpu)} busy${trace} · ${lv("cpu")} (warn ${config.cpu.warn}, hot ${config.cpu.hot})`);
    lines.push(`load ${r.loadPerCore.toFixed(2)} per core · ${lv("load")} (warn ${config.loadPerCore.warn}, hot ${config.loadPerCore.hot})`);
    const m = r.memory;
    if (m?.source === "darwin") lines.push(`memory pressure level ${m.level} (${DARWIN_LEVELS[m.level] ?? "unknown"}) · ${lv("mem")}`);
    else if (m?.source === "psi") lines.push(`memory stall some ${m.some} full ${m.full} (avg10) · ${lv("mem")} (some warn ${config.memorySome.warn}, hot ${config.memorySome.hot}; full warn ${config.memoryFull.warn}, hot ${config.memoryFull.hot})`);
    else lines.push("memory pressure unavailable on this platform");
    lines.push(`swap-in ${r.swapInBps === undefined ? "?" : formatRate(r.swapInBps)} · ${lv("swap")} (warn ${config.swapInMBps.warn}MB/s, hot ${config.swapInMBps.hot}MB/s)`);
  }
  const [cpu, memory] = await Promise.all([sampler.top("cpu", 5), sampler.top("memory", 5)]);
  if (cpu.length) lines.push(`top cpu: ${cpu.map((p) => `${p.name} ${Math.round(p.cpu)}`).join(", ")}`);
  if (memory.length) lines.push(`top memory: ${memory.map((p) => `${p.name} ${kb(p.rssKb)}`).join(", ")}`);
  return lines.join("\n");
}

const isStaleCtx = (error: unknown) => error instanceof Error && /\bstale\b/iu.test(error.message);

export default function pressureExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const sampler = createSampler();
  let watching = config.enabled;
  let ctx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let busy = false;
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
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    const context = ctx;
    if (context && lastStatus !== undefined) {
      try { context.ui.setStatus(STATUS_KEY, undefined); } catch { /* The session is already gone. */ }
    }
    lastStatus = undefined;
    top = undefined;
  };

  const tick = async (epoch: number) => {
    if (busy) return;
    busy = true;
    try {
      const reading = await sampler.sample();
      if (epoch !== generation || !ctx) return;
      const view = monitor.step(reading);
      last = view;
      if (!view.visible) {
        top = undefined;
        publish(undefined);
        return;
      }
      if (!top || reading.at - top.at >= TOP_REFRESH_MS) {
        const [row] = await sampler.top(topBy(view));
        if (epoch !== generation || !ctx) return;
        top = { name: row?.name, at: reading.at };
      }
      publish(formatStatus(view, top.name, paint(ctx)));
    } catch (error) {
      // A timer must never take Pi down; a stale ctx means we missed the session's end.
      if (isStaleCtx(error)) { stop(); ctx = undefined; }
    } finally {
      busy = false;
    }
  };

  const start = (context: ExtensionContext) => {
    stop();
    ctx = context;
    if (!context.hasUI || !watching) return;
    monitor = createMonitor(config);
    last = undefined;
    const epoch = generation;
    timer = setInterval(() => void tick(epoch), config.intervalMs);
    timer.unref?.();
    void tick(epoch);
  };

  pi.on("session_start", (_event, context) => start(context));
  pi.on("session_shutdown", () => {
    stop();
    ctx = undefined;
  });

  pi.registerCommand("pressure", {
    description: "CPU and memory pressure: readings, thresholds and top processes (`/pressure on|off` toggles the footer row)",
    getArgumentCompletions: (prefix: string) => ["on", "off"].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, context) => {
      const arg = args.trim();
      if (arg === "on" || arg === "off") {
        watching = arg === "on";
        if (watching) start(context);
        else { stop(); ctx = context; }
        context.ui.notify(`pressure: ${watching ? "watching" : "off"}`, "info");
        return;
      }
      let view = watching ? last : undefined;
      if (!view) {
        // Not watching (or no sample yet): two quick samples of our own for a CPU delta.
        const once = createSampler();
        await once.sample();
        await new Promise((resolve) => setTimeout(resolve, 300));
        view = createMonitor(config).step(await once.sample());
      }
      context.ui.notify(await report(view, config, sampler, watching), "info");
    },
  });
}
