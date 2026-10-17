// pi-trends: per-turn trends of context %, effort, tokens, cost, tool calls and duration.
// A one-line sparkline widget (toggled with a shortcut or `/trends widget`) and a `/trends`
// overlay with a braille line chart per metric and a movable turn cursor. History is rebuilt from the
// current branch's session entries, so it survives resume, reload, /tree and compaction.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCost, formatDuration, formatTokens, lineChart, METRICS, type Metric, sparkline, window } from "./chart.ts";
import { collectTurns, EFFORT_LEVELS, type TurnStat } from "./turns.ts";

export const DEFAULT_SHORTCUT = "ctrl+shift+g";
const WIDGET_KEY = "pi-trends";

export interface TrendsConfig {
  /** Show the widget at startup. Default false. */
  widget?: boolean;
  /** Toggle shortcut, or "off". Default ctrl+shift+g. */
  shortcut?: string;
  /** Widget placement. Default belowEditor. */
  placement?: "aboveEditor" | "belowEditor";
}

export function loadConfig(cwd = process.cwd()): TrendsConfig {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const read = (path: string): TrendsConfig => {
    try {
      if (!existsSync(path)) return {};
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  return { ...read(join(agentDir, "pi-trends.json")), ...read(join(cwd, ".pi", "pi-trends.json")) };
}

export function turnsFor(ctx: ExtensionContext, currentEffort?: string): TurnStat[] {
  return collectTurns(ctx.sessionManager.getBranch(), {
    contextWindow: (provider, model) => ctx.modelRegistry?.find(provider, model)?.contextWindow ?? ctx.model?.contextWindow,
    initialEffort: currentEffort,
  });
}

const contextColor = (percent: number | undefined): "success" | "warning" | "error" | "muted" =>
  percent === undefined ? "muted" : percent >= 80 ? "error" : percent >= 50 ? "warning" : "success";

const WIDGET_METRICS: { key: string; short: string }[] = [
  { key: "context", short: "ctx" },
  { key: "effort", short: "effort" },
  { key: "tokens", short: "tok" },
  { key: "cost", short: "cost" },
  { key: "tools", short: "tools" },
  { key: "duration", short: "time" },
];

const metric = (key: string): Metric => METRICS.find((m) => m.key === key)!;

function latestValue(m: Metric, turns: TurnStat[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const value = m.value(turns[i]);
    if (value !== undefined) return m.format(value, turns[i]);
  }
  return "-";
}

/** One line: label, sparkline over recent turns, latest value per metric. */
export function renderWidgetLine(turns: TurnStat[], width: number, theme: Pick<Theme, "fg">): string {
  if (turns.length === 0) return truncateToWidth(theme.fg("dim", "trends: no turns yet"), width);
  const segment = (key: string, short: string, n: number, color: boolean) => {
    const m = metric(key);
    const recent = window(turns, n);
    const spark = sparkline(recent.map(m.value), m.max);
    const last = latestValue(m, turns);
    const sparkColor = key === "context" ? contextColor(recent.at(-1)?.contextPercent) : "accent";
    return color
      ? `${theme.fg("dim", short)} ${theme.fg(sparkColor, spark)} ${theme.fg("muted", last)}`
      : `${short} ${spark} ${last}`;
  };
  const sep = "  ";
  // Ends with a word so the line never ends in %, $, # or > (herdr-web-ui reads those as a shell prompt).
  const tail = ` \u00b7 ${turns.length} turn${turns.length === 1 ? "" : "s"}`;
  for (let count = WIDGET_METRICS.length; count >= 1; count--) {
    const shown = WIDGET_METRICS.slice(0, count);
    for (let n = Math.min(turns.length, 24); n >= Math.min(turns.length, 4); n--) {
      const plain = shown.map((s) => segment(s.key, s.short, n, false)).join(sep) + tail;
      if (visibleWidth(plain) <= width) return shown.map((s) => segment(s.key, s.short, n, true)).join(sep) + theme.fg("dim", tail);
    }
  }
  return truncateToWidth(segment("context", "ctx", Math.min(turns.length, 4), true), width);
}

function scaleLabel(metric: Metric, ceiling: number, turn: TurnStat): string {
  if (metric.key === "effort") return EFFORT_LEVELS[EFFORT_LEVELS.length - 1];
  return metric.format(ceiling, turn);
}

export function turnDetail(turn: TurnStat): string {
  const parts = [
    `Turn ${turn.index}`,
    turn.startedAt ? new Date(turn.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : undefined,
    turn.model,
    turn.contextPercent !== undefined
      ? `ctx ${turn.contextPercent.toFixed(1)}% (${formatTokens(turn.contextTokens)}/${formatTokens(turn.contextWindow)})`
      : `ctx ${formatTokens(turn.contextTokens)}`,
    `effort ${turn.effort}`,
    `in ${formatTokens(turn.input)} out ${formatTokens(turn.output)} cache r${formatTokens(turn.cacheRead)}/w${formatTokens(turn.cacheWrite)}`,
    formatCost(turn.cost),
    `${turn.toolCalls} tool call${turn.toolCalls === 1 ? "" : "s"}`,
    formatDuration(turn.durationMs),
    turn.compacted ? "after compaction" : undefined,
  ];
  return parts.filter(Boolean).join(" · ");
}

export function formatReport(turns: TurnStat[]): string {
  if (turns.length === 0) return "No turns in this session yet.";
  const lines = METRICS.map((m) => `${m.label.padEnd(10)} ${sparkline(window(turns, 40).map(m.value), m.max)} ${latestValue(m, turns)}`);
  const total = turns.reduce((sum, t) => sum + t.cost, 0);
  return [`Session trends: ${turns.length} turns, ${formatCost(total)} total`, ...lines, turnDetail(turns.at(-1)!)].join("\n");
}

const GUTTER = 12;

/** Overlay body lines (without border), for a given cursor turn and width. */
export function renderOverlay(
  turns: TurnStat[],
  cursor: number,
  width: number,
  chartHeight: number,
  theme: Pick<Theme, "fg" | "bold">,
): { lines: string[]; columns: number } {
  const inner = Math.max(10, width);
  const plotWidth = Math.max(4, inner - GUTTER);
  // Two dots per cell: up to 2*plotWidth turns fit before the view scrolls.
  const columns = Math.max(2, plotWidth * 2);
  // Keep the cursor visible: show the window of `columns` turns that ends at or after it.
  const offset = Math.max(0, Math.min(turns.length - columns, turns.length - 1 - cursor - Math.floor(columns / 4)));
  const visible = window(turns, columns, offset);
  const first = turns.length - offset - visible.length;
  const total = turns.reduce((sum, t) => sum + t.cost, 0);
  const lines: string[] = [];
  lines.push(
    truncateToWidth(
      `${theme.bold(theme.fg("accent", "Session Trends"))}  ${theme.fg("muted", `${turns.length} turn${turns.length === 1 ? "" : "s"} · ${formatCost(total)} · showing ${first + 1}-${first + visible.length}`)}`,
      inner,
    ),
  );
  for (const metric of METRICS) {
    lines.push("");
    const values = visible.map(metric.value);
    const chart = lineChart(values, plotWidth, chartHeight, metric.max);
    const cursorCell = chart.cellOf(cursor - first);
    const current = turns[cursor];
    const value = current ? metric.value(current) : undefined;
    const ceiling = metric.max ?? Math.max(0, ...values.filter((v): v is number => v !== undefined));
    const color = metric.key === "context" ? contextColor(current?.contextPercent) : "accent";
    const fit = (text: string) => text.padEnd(GUTTER - 1).slice(0, GUTTER - 1);
    const gutterFor = (r: number): string => {
      if (r === 0) return theme.bold(fit(metric.label));
      if (r === 1 && chartHeight > 2 && current) return theme.fg("dim", fit(`max ${scaleLabel(metric, ceiling, current)}`));
      if (r === chartHeight - 1) return theme.fg(color, fit(value === undefined ? "-" : metric.format(value, current!)));
      return " ".repeat(GUTTER - 1);
    };
    chart.rows.forEach((row, r) => {
      const plot = [...row]
        .map((ch, i) => {
          if (i === cursorCell) return ch === " " ? theme.fg("dim", "│") : theme.bold(theme.fg("warning", ch));
          return theme.fg(color, ch);
        })
        .join("");
      lines.push(truncateToWidth(`${gutterFor(r)} ${plot}`, inner));
    });
  }
  lines.push("");
  const current = turns[cursor];
  if (current) {
    // Wrap the detail at its " · " separators instead of cutting it off.
    let line = "";
    for (const part of turnDetail(current).split(" · ")) {
      const next = line ? `${line} · ${part}` : part;
      if (line && visibleWidth(next) > inner) {
        lines.push(line);
        line = part;
      } else line = next;
    }
    if (line) lines.push(truncateToWidth(line, inner));
  }
  lines.push(theme.fg("dim", truncateToWidth("←/→ turn  shift+←/→ jump 10  home/end  esc close", inner)));
  return { lines, columns };
}

async function showOverlay(ctx: ExtensionCommandContext, turns: TurnStat[]): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      let cursor = turns.length - 1;
      const border = (text: string) => theme.fg("border", text);
      return {
        handleInput(data: string) {
          const move = (delta: number) => {
            cursor = Math.max(0, Math.min(turns.length - 1, cursor + delta));
            tui.requestRender();
          };
          if (matchesKey(data, Key.escape) || data === "q") return done();
          if (matchesKey(data, Key.left) || data === "h") return move(-1);
          if (matchesKey(data, Key.right) || data === "l") return move(1);
          if (matchesKey(data, Key.shift("left")) || data === "H") return move(-10);
          if (matchesKey(data, Key.shift("right")) || data === "L") return move(10);
          if (matchesKey(data, Key.home) || data === "g") return move(-turns.length);
          if (matchesKey(data, Key.end) || data === "G") return move(turns.length);
        },
        invalidate() {},
        render(width: number) {
          const inner = Math.max(10, width - 4);
          const rows = process.stdout.rows || 40;
          const chartHeight = Math.max(1, Math.min(6, Math.floor((rows * 0.9 - 10) / METRICS.length) - 1));
          const { lines } = renderOverlay(turns, cursor, inner, chartHeight, theme);
          const pad = (line: string) => line + " ".repeat(Math.max(0, inner - visibleWidth(line)));
          return [
            border(`╭${"─".repeat(width - 2)}╮`),
            ...lines.map((line) => `${border("│")} ${pad(line)} ${border("│")}`),
            border(`╰${"─".repeat(width - 2)}╯`),
          ];
        },
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", width: "90%", minWidth: 50, maxHeight: "95%", margin: 1 } },
  );
}

export default function trendsExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  let showWidget = config.widget === true;
  let lastCtx: ExtensionContext | undefined;
  let turns: TurnStat[] = [];
  let requestRender: (() => void) | undefined;

  const refresh = (ctx?: ExtensionContext) => {
    if (ctx) lastCtx = ctx;
    if (!lastCtx) return;
    try {
      turns = turnsFor(lastCtx, pi.getThinkingLevel());
    } catch {
      turns = [];
    }
    requestRender?.();
  };

  const applyWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (!showWidget) {
      requestRender = undefined;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    refresh(ctx);
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        requestRender = () => tui.requestRender();
        return {
          invalidate() {},
          render: (width: number) => [renderWidgetLine(turns, width, theme)],
          dispose() {
            requestRender = undefined;
          },
        };
      },
      { placement: config.placement ?? "belowEditor" },
    );
  };

  const toggle = (ctx: ExtensionContext, next = !showWidget) => {
    showWidget = next;
    applyWidget(ctx);
  };

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    if (showWidget) applyWidget(ctx);
  });
  for (const event of ["turn_end", "agent_end", "session_compact", "session_tree", "thinking_level_select", "model_select"] as const) {
    pi.on(event as "turn_end", (_event: unknown, ctx: ExtensionContext) => {
      if (showWidget) refresh(ctx);
      else lastCtx = ctx;
    });
  }

  pi.registerCommand("trends", {
    description: "Chart context %, effort, tokens, cost, tool calls and duration per turn (`/trends widget` toggles the sparkline)",
    getArgumentCompletions: (prefix: string) =>
      ["widget", "widget on", "widget off"].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg.startsWith("widget")) {
        const mode = arg.slice("widget".length).trim();
        toggle(ctx, mode === "on" ? true : mode === "off" ? false : !showWidget);
        return;
      }
      const all = turnsFor(ctx, pi.getThinkingLevel());
      if (!ctx.hasUI || ctx.mode !== "tui" || all.length === 0) {
        ctx.ui.notify(formatReport(all), "info");
        return;
      }
      await showOverlay(ctx, all);
    },
  });

  const shortcut = config.shortcut ?? DEFAULT_SHORTCUT;
  if (shortcut !== "off") {
    pi.registerShortcut(shortcut as never, {
      description: "Toggle the session trends widget",
      handler: (ctx) => toggle(ctx),
    });
  }
}
