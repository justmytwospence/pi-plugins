// pi-trends: per-model-call trends of context %, effort, tokens, cost, tool calls and duration.
// A one-line sparkline widget (toggled with a shortcut or `/trends widget`) and a `/trends`
// overlay with a braille chart per metric (areas/steps for levels, bars for events) and a movable call cursor. History is rebuilt from the
// current branch's session entries, so it survives resume, reload, /tree and compaction.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCost, formatDuration, formatTokens, METRICS, type Metric, normalize, plot, slots, sparkline, window } from "./chart.ts";
import { collectTurns, type TurnStat } from "./turns.ts";

export const DEFAULT_SHORTCUT = "alt+g";
const WIDGET_KEY = "pi-trends";

export interface TrendsConfig {
  /** Show the widget at startup. Default false. */
  widget?: boolean;
  /** Toggle shortcut, or "off". Default alt+g. */
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
  { key: "cost", short: "cost" },
  { key: "tokens", short: "new" },
  { key: "tools", short: "tools" },
  { key: "duration", short: "time" },
];

const metricFor = (key: string): Metric => METRICS.find((m) => m.key === key)!;

const defined = (values: (number | undefined)[]): number[] => values.filter((v): v is number => v !== undefined && Number.isFinite(v));

/** Normalized 0-1 levels for a run of calls, on the metric's own axis. */
function levels(m: Metric, calls: TurnStat[]): { values: (number | undefined)[]; domain: [number, number]; norm: (number | undefined)[] } {
  const values = calls.map(m.value);
  const domain = m.domain(defined(values));
  return { values, domain, norm: values.map((v) => (v === undefined ? undefined : normalize(m, v, domain))) };
}

function latestValue(m: Metric, calls: TurnStat[]): string {
  for (let i = calls.length - 1; i >= 0; i--) {
    const value = m.value(calls[i]);
    if (value !== undefined) return m.format(value, calls[i]);
  }
  return "-";
}

/** Widget value: the current level for levels, the session total for per-call events. */
function widgetValue(m: Metric, calls: TurnStat[]): string {
  if (m.kind !== "bars") return latestValue(m, calls);
  if (m.key === "cost") return formatCost(calls.reduce((t, c) => t + c.cost, 0));
  if (m.key === "duration") return formatDuration(calls.reduce((t, c) => t + c.durationMs, 0));
  if (m.key === "tokens") return formatTokens(calls.reduce((t, c) => t + c.input + c.cacheWrite + c.output, 0));
  return `${calls.reduce((t, c) => t + (m.value(c) ?? 0), 0)}`;
}

/** One line: label, sparkline over recent model calls, current level or session total. */
export function renderWidgetLine(turns: TurnStat[], width: number, theme: Pick<Theme, "fg">): string {
  if (turns.length === 0) return truncateToWidth(theme.fg("dim", "trends: no model calls yet"), width);
  const segment = (key: string, short: string, n: number, color: boolean) => {
    const m = metricFor(key);
    const recent = window(turns, n);
    const spark = sparkline(levels(m, recent).norm);
    const value = widgetValue(m, turns);
    const sparkColor = key === "context" ? contextColor(recent.at(-1)?.contextPercent) : "accent";
    return color
      ? `${theme.fg("dim", short)} ${theme.fg(sparkColor, spark)} ${theme.fg("muted", value)}`
      : `${short} ${spark} ${value}`;
  };
  const sep = "  ";
  // Ends with a word so the line never ends in %, $, # or > (herdr-web-ui reads those as a shell prompt).
  const prompts = turns.at(-1)?.prompt ?? 0;
  const tail = ` \u00b7 ${turns.length} call${turns.length === 1 ? "" : "s"}/${prompts} prompt${prompts === 1 ? "" : "s"}`;
  for (let count = WIDGET_METRICS.length; count >= 1; count--) {
    const shown = WIDGET_METRICS.slice(0, count);
    for (let n = Math.min(turns.length, 24); n >= Math.min(turns.length, 4); n--) {
      const plain = shown.map((s) => segment(s.key, s.short, n, false)).join(sep) + tail;
      if (visibleWidth(plain) <= width) return shown.map((s) => segment(s.key, s.short, n, true)).join(sep) + theme.fg("dim", tail);
    }
  }
  return truncateToWidth(segment("context", "ctx", Math.min(turns.length, 4), true), width);
}

export function turnDetail(turn: TurnStat): string {
  const parts = [
    `Call ${turn.index} (prompt ${turn.prompt})`,
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
  if (turns.length === 0) return "No model calls in this session yet.";
  const recent = window(turns, 40);
  const lines = METRICS.map((m) => `${m.label.padEnd(11)} ${sparkline(levels(m, recent).norm)} ${widgetValue(m, turns)}`);
  const total = turns.reduce((sum, t) => sum + t.cost, 0);
  return [`Session trends: ${turns.length} model calls over ${turns.at(-1)!.prompt} prompts, ${formatCost(total)} total`, ...lines, turnDetail(turns.at(-1)!)].join("\n");
}

/** Width of the y-axis tick column, plus one space and the axis rule. */
const GUTTER = 7;
const TOTAL_WEIGHT = METRICS.reduce((t, m) => t + m.weight, 0);

/** Chart heights for a budget of chart rows, by weight; every chart keeps at least one row. Step
 *  charts get one row per level in view instead. */
export function chartHeights(budget: number, stepRows = 1): number[] {
  const stepMetrics = METRICS.filter((m) => m.kind === "step");
  const rest = Math.max(0, budget - stepRows * stepMetrics.length);
  const weight = TOTAL_WEIGHT - stepMetrics.reduce((t, m) => t + m.weight, 0);
  const factor = Math.max(0.25, Math.min(1.5, rest / weight));
  return METRICS.map((m) => (m.kind === "step" ? stepRows : Math.max(1, Math.round(m.weight * factor))));
}

/** Rows the overlay needs besides the charts: title, one header per metric, axes, detail, help. */
export const OVERLAY_CHROME = 1 + METRICS.length + 3 + 3 + 1;

/** Overlay body lines (without border), for a given cursor call, width and chart-row budget. */
export function renderOverlay(
  turns: TurnStat[],
  cursor: number,
  width: number,
  rowBudget: number,
  theme: Pick<Theme, "fg" | "bold">,
): { lines: string[]; columns: number } {
  const inner = Math.max(20, width);
  const plotWidth = Math.max(4, inner - GUTTER - 2);
  // At one dot column per call, 2*plotWidth calls fit before the view scrolls.
  const columns = Math.max(2, plotWidth * 2);
  const offset = Math.max(0, Math.min(turns.length - columns, turns.length - 1 - cursor - Math.floor(columns / 4)));
  const visible = window(turns, columns, offset);
  const first = turns.length - offset - visible.length;
  const x = slots(visible.length, plotWidth);
  const cursorIndex = cursor - first;
  const cursorCell = x.cellOf(cursorIndex);
  const current = turns[cursor];
  const total = turns.reduce((sum, t) => sum + t.cost, 0);
  const effortDomain = metricFor("effort").domain([]);
  const heights = chartHeights(rowBudget, effortDomain[1] - effortDomain[0] + 1);
  const valueWidth = inner >= 80 ? 16 : 0;
  const axis = (text: string) => theme.fg("dim", text);
  const lines: string[] = [];
  lines.push(
    truncateToWidth(
      `${theme.bold(theme.fg("accent", "Session Trends"))}  ${theme.fg("muted", `calls ${first + 1}-${first + visible.length} of ${turns.length} · ${turns.at(-1)?.prompt ?? 0} prompts · ${formatCost(total)}`)}`,
      inner,
    ),
  );

  METRICS.forEach((m, mi) => {
    const height = heights[mi];
    const { domain, norm } = levels(m, visible);
    const value = current ? m.value(current) : undefined;
    const valueColor = m.key === "context" ? contextColor(current?.contextPercent) : "accent";
    // Header: label, the cursor call's value, then a session aggregate.
    const header = `${theme.bold(m.label.padEnd(11))} ${theme.bold(theme.fg(valueColor, (value === undefined ? "-" : m.format(value, current!)).padEnd(valueWidth)))} ${theme.fg("muted", m.summary(turns))}`;
    lines.push(truncateToWidth(header, inner));

    const rows = plot(norm, m.kind, x, plotWidth, height);
    // Ticks: top and bottom of the domain; the midpoint too on tall linear charts.
    const ticks = new Map<number, string>([[0, m.tick(domain[1])]]);
    if (height > 1) ticks.set(height - 1, m.tick(domain[0]));
    if (height >= 4 && !m.log && m.kind !== "step") ticks.set(Math.floor((height - 1) / 2), m.tick((domain[0] + domain[1]) / 2));
    if (m.kind === "step") {
      // One row per level, each named.
      for (let r = 0; r < height; r++) ticks.set(r, m.tick(domain[1] - r));
    }
    rows.forEach((row, r) => {
      const plotted = [...row]
        .map((ch, cell) => {
          if (cell === cursorCell) return ch === " " ? axis("│") : theme.bold(theme.fg("warning", ch));
          if (m.key === "context") return theme.fg(contextColor(visible[x.callAt(cell)]?.contextPercent), ch);
          return theme.fg(m.kind === "step" ? "muted" : "accent", ch);
        })
        .join("");
      lines.push(truncateToWidth(`${axis((ticks.get(r) ?? "").slice(0, GUTTER).padStart(GUTTER))} ${axis("┤")}${plotted}`, inner));
    });
  });

  // X axis: a tick where each prompt starts (the cursor's prompt highlighted), its number below.
  const ticks = new Array<string>(plotWidth).fill(axis("─"));
  const labels = new Array<string>(plotWidth).fill(" ");
  let free = 0;
  visible.forEach((call, i) => {
    if (!call.promptStart) return;
    const cell = x.cellOf(i);
    const mine = call.prompt === current?.prompt;
    ticks[cell] = mine ? theme.fg("warning", "┴") : axis("┴");
    const label = `${call.prompt}`;
    if (cell >= free && cell + label.length <= plotWidth) {
      [...label].forEach((ch, k) => (labels[cell + k] = mine ? theme.fg("warning", ch) : axis(ch)));
      free = cell + label.length + 1;
    }
  });
  lines.push(truncateToWidth(`${" ".repeat(GUTTER)} ${axis("└")}${ticks.join("")}`, inner));
  lines.push(truncateToWidth(`${axis("prompt".padStart(GUTTER))}  ${labels.join("")}`, inner));

  lines.push("");
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
  lines.push(axis(truncateToWidth("←/→ call  [/] prompt  shift+←/→ 10  home/end  esc", inner)));
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
          if (data === "[" || data === "]") {
            // Jump to the first call of the previous/next prompt.
            const prompt = turns[cursor].prompt + (data === "]" ? 1 : turns[cursor].promptStart ? -1 : 0);
            const target = turns.findIndex((call) => call.prompt === prompt);
            if (target >= 0) move(target - cursor);
            return;
          }
          if (matchesKey(data, Key.shift("left")) || data === "H") return move(-10);
          if (matchesKey(data, Key.shift("right")) || data === "L") return move(10);
          if (matchesKey(data, Key.home) || data === "g") return move(-turns.length);
          if (matchesKey(data, Key.end) || data === "G") return move(turns.length);
        },
        invalidate() {},
        render(width: number) {
          const inner = Math.max(10, width - 4);
          const rows = process.stdout.rows || 40;
          const { lines } = renderOverlay(turns, cursor, inner, Math.floor(rows * 0.95) - 2 - OVERLAY_CHROME, theme);
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
    description: "Chart context %, effort, tokens, cost, tool calls and duration per model call (`/trends widget` toggles the sparkline)",
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
