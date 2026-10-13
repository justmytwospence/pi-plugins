// /context: where the context window goes. A dialog shows the usage bar and one row per part
// (system prompt, memory files, skills, tool definitions, tool results, conversation); Enter or a
// click on a row opens a scrollable Markdown preview of that part as the model sees it.
//
// Both overlays are plain ui.custom components. Mouse support goes through pi-tui's normalized
// handleMouse (fullscreen mode enables mouse tracking; in normal mode only the keyboard applies).
//
// Ported from pi-cc-extensions (MIT, minuque).
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
  assembleReport,
  collectContextBreakdown,
  type ContextPart,
  type ContextReport,
  formatReport,
  formatTokens,
  normalizePreviewText,
  type PreviewKey,
} from "./breakdown.ts";

export * from "./breakdown.ts";

type Preview = { key: PreviewKey; label: string; title: string; content: string };

const ESC = "[esc]";
const ESC_WIDTH = visibleWidth(ESC);

/** Pad a line to `width` visible columns, truncating with an ellipsis when it is wider. */
function padLine(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "…");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function isClose(data: string): boolean {
  return matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"));
}

/** The [esc] button sits at the right end of the title row (local row 1). */
function overEsc(event: TuiMouseEvent): boolean {
  return event.y === 1 && event.x >= event.width - 1 - ESC_WIDTH && event.x < event.width - 1;
}

function isLeftClick(event: TuiMouseEvent): boolean {
  return event.type === "click" && event.button === "left";
}

const HANDLED: TuiMouseEventResult = { handled: true };

/** Scrollable Markdown preview of one part. */
export async function showTextPreview(ctx: Pick<ExtensionCommandContext, "ui">, title: string, rawContent: string): Promise<void> {
  const content = normalizePreviewText(rawContent);
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      let scrollOffset = 0;
      let pageSize = 1;
      let totalLines = 1;
      let escHovered = false;
      let scrollbar: { x: number; startRow: number; thumbStart: number; thumbSize: number; maxOffset: number } | undefined;
      let dragOffset: number | null = null;
      const markdownView = new Markdown(content, 0, 0, getMarkdownTheme());
      const border = (text: string) => theme.fg("border", text);

      const scrollTo = (next: number): boolean => {
        const clamped = Math.max(0, Math.min(next, Math.max(0, totalLines - pageSize)));
        if (clamped === scrollOffset) return false;
        scrollOffset = clamped;
        return true;
      };

      const dragTo = (row: number): boolean => {
        if (!scrollbar || dragOffset === null) return false;
        const maxThumbStart = Math.max(0, pageSize - scrollbar.thumbSize);
        const thumbStart = Math.max(0, Math.min(row - scrollbar.startRow - dragOffset, maxThumbStart));
        return scrollTo(maxThumbStart > 0 ? Math.round((thumbStart / maxThumbStart) * scrollbar.maxOffset) : 0);
      };

      return {
        invalidate() {
          markdownView.invalidate();
        },
        handleInput(data: string) {
          if (isClose(data)) return done();
          let moved = false;
          if (matchesKey(data, Key.up)) moved = scrollTo(scrollOffset - 1);
          else if (matchesKey(data, Key.down)) moved = scrollTo(scrollOffset + 1);
          else if (matchesKey(data, "pageUp")) moved = scrollTo(scrollOffset - pageSize);
          else if (matchesKey(data, "pageDown")) moved = scrollTo(scrollOffset + pageSize);
          else if (matchesKey(data, Key.home)) moved = scrollTo(0);
          else if (matchesKey(data, Key.end)) moved = scrollTo(totalLines - pageSize);
          if (moved) tui.requestRender();
        },
        handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
          if (event.type === "wheel") return { handled: true, render: scrollTo(scrollOffset + (event.wheelDelta ?? 0)) };
          if (event.type === "move") {
            const hovered = overEsc(event);
            const changed = hovered !== escHovered;
            escHovered = hovered;
            return { handled: true, render: changed };
          }
          if (event.type === "release") {
            dragOffset = null;
            return HANDLED;
          }
          if (event.type === "drag") return { handled: true, render: dragTo(event.y) };
          if (event.button !== "left") return undefined;
          if (isLeftClick(event) && overEsc(event)) {
            done();
            return HANDLED;
          }
          if (event.type === "press" && scrollbar && event.x === scrollbar.x) {
            const trackRow = event.y - scrollbar.startRow;
            if (trackRow < 0 || trackRow >= pageSize) return HANDLED;
            const inThumb = trackRow >= scrollbar.thumbStart && trackRow < scrollbar.thumbStart + scrollbar.thumbSize;
            dragOffset = inThumb ? trackRow - scrollbar.thumbStart : Math.floor(scrollbar.thumbSize / 2);
            return { handled: true, capture: true, render: dragTo(event.y) };
          }
          return HANDLED;
        },
        render(width: number) {
          const inner = Math.max(1, width - 2);
          const bodyInner = Math.max(1, inner - 1);
          const bodyWidth = Math.max(1, bodyInner - 1);
          const terminalHeight = Math.max(1, tui.terminal.rows);
          const availableHeight = Math.max(1, terminalHeight - 4);
          const viewportHeight = Math.min(30, Math.max(1, Math.floor(terminalHeight * 0.8)), availableHeight);
          pageSize = Math.max(1, viewportHeight - 6);
          const wrapped = markdownView.render(bodyWidth);
          totalLines = wrapped.length;
          scrollOffset = Math.min(scrollOffset, Math.max(0, totalLines - pageSize));
          const visible = wrapped.slice(scrollOffset, scrollOffset + pageSize);
          const scrollable = totalLines > pageSize;
          const thumbSize = scrollable ? Math.max(1, Math.floor((pageSize * pageSize) / totalLines)) : 0;
          const maxOffset = Math.max(0, totalLines - pageSize);
          const thumbStart = scrollable && maxOffset > 0 ? Math.round((scrollOffset / maxOffset) * (pageSize - thumbSize)) : 0;
          scrollbar = scrollable ? { x: width - 2, startRow: 3, thumbStart, thumbSize, maxOffset } : undefined;
          const scrollbarCell = (row: number): string => {
            if (!scrollable) return " ";
            const inThumb = row >= thumbStart && row < thumbStart + thumbSize;
            return theme.fg(inThumb ? "scrollbarThumb" : "scrollbarTrack", inThumb ? "█" : "│");
          };
          const bodyRows = Array.from({ length: pageSize }, (_, row) => {
            const line = visible[row] ?? "";
            return `${border("│")}${padLine(` ${line}`, bodyInner)}${scrollbarCell(row)}${border("│")}`;
          });
          const start = totalLines === 0 ? 0 : scrollOffset + 1;
          const end = Math.min(totalLines, scrollOffset + pageSize);
          const status = `${start}-${end} / ${totalLines} lines · ↑↓ PgUp/PgDn Home/End · ${ESC} close`;
          const titleRow = padLine(` ${theme.bold(theme.fg("accent", title))}`, inner - ESC_WIDTH);
          return [
            border(`╭${"─".repeat(inner)}╮`),
            `${border("│")}${titleRow}${theme.fg(escHovered ? "text" : "muted", ESC)}${border("│")}`,
            `${border("├")}${border("─".repeat(inner))}${border("┤")}`,
            ...bodyRows,
            `${border("├")}${border("─".repeat(inner))}${border("┤")}`,
            `${border("│")}${padLine(theme.fg("dim", ` ${status}`), inner)}${border("│")}`,
            border(`╰${"─".repeat(inner)}╯`),
          ];
        },
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", width: "85%", minWidth: 50, maxHeight: "80%", margin: 2 } },
  );
}

/** Local row of the first part row in the usage dialog: border, title, rule, bar, blank. */
const FIRST_PART_ROW = 5;

/** Draw the usage dialog; resolves with the part to preview, or undefined to close. */
function showUsageDialog(
  ctx: Pick<ExtensionCommandContext, "ui">,
  report: ContextReport,
  previews: Preview[],
  selected: { index: number },
): Promise<PreviewKey | undefined> {
  const { parts, used, contextWindow } = report;
  const previewFor = (part: ContextPart) => previews.find((preview) => preview.label === part.label);
  const partAtRow = (y: number): ContextPart | undefined => parts[y - FIRST_PART_ROW];

  return ctx.ui.custom<PreviewKey | undefined>(
    (tui: TUI, theme: Theme, _keybindings, done) => {
      let escHovered = false;
      let hoveredLabel: string | undefined;
      const border = (text: string) => theme.fg("border", text);

      const move = (delta: number): void => {
        if (previews.length === 0) return;
        selected.index = (selected.index + delta + previews.length) % previews.length;
        tui.requestRender();
      };

      return {
        invalidate() {},
        handleInput(data: string) {
          if (isClose(data)) return done(undefined);
          if (matchesKey(data, Key.up)) return move(-1);
          if (matchesKey(data, Key.down)) return move(1);
          if (matchesKey(data, Key.enter)) return done(previews[selected.index]?.key);
        },
        handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
          if (event.type === "wheel") {
            move(Math.sign(event.wheelDelta ?? 0));
            return HANDLED;
          }
          if (event.type === "move") {
            const esc = overEsc(event);
            const part = partAtRow(event.y);
            const label = part && previewFor(part) ? part.label : undefined;
            const changed = esc !== escHovered || label !== hoveredLabel;
            escHovered = esc;
            hoveredLabel = label;
            return { handled: true, render: changed };
          }
          if (!isLeftClick(event)) return event.button === "left" ? HANDLED : undefined;
          if (overEsc(event)) {
            done(undefined);
            return HANDLED;
          }
          const part = partAtRow(event.y);
          const preview = part && previewFor(part);
          if (preview) {
            selected.index = previews.indexOf(preview);
            done(preview.key);
          }
          return HANDLED;
        },
        render(width: number) {
          const inner = Math.max(1, width - 2);
          const percent = contextWindow > 0 ? (used / contextWindow) * 100 : 0;
          const title = theme.bold(theme.fg("accent", "Context Usage"));
          const subtitle = `${formatTokens(used)} / ${formatTokens(contextWindow)} tokens (${percent.toFixed(1)}%)`;
          const barWidth = Math.max(1, Math.min(60, inner - 2));
          let remaining = barWidth;
          const segments = parts
            .map((part, index) => {
              const cells =
                index === parts.length - 1
                  ? remaining
                  : Math.min(remaining, Math.round((part.tokens / Math.max(1, contextWindow)) * barWidth));
              remaining -= cells;
              return theme.fg(part.color, "█".repeat(Math.max(0, cells)));
            })
            .join("");
          const labelWidth = Math.min(24, Math.max(...parts.map((part) => part.label.length)));
          const selectedLabel = previews[selected.index]?.label;
          const partRows = parts.map((part) => {
            const pct = contextWindow > 0 ? (part.tokens / contextWindow) * 100 : 0;
            const swatch = theme.fg(part.color, "■");
            const label = part.label.padEnd(labelWidth);
            const amount = `${formatTokens(part.tokens).padStart(7)}  ${pct.toFixed(1).padStart(5)}%`;
            const isSelected = part.label === selectedLabel;
            const row = padLine(`${isSelected ? "› " : "  "}${swatch} ${label} ${amount}`, inner);
            if (isSelected) return theme.bg("selectedBg", row);
            return part.label === hoveredLabel ? theme.bg("customMessageBg", row) : row;
          });
          const titleRow = padLine(` ${title}  ${theme.fg("muted", subtitle)}`, inner - ESC_WIDTH);
          return [
            border(`╭${"─".repeat(inner)}╮`),
            `${border("│")}${titleRow}${theme.fg(escHovered ? "text" : "muted", ESC)}${border("│")}`,
            `${border("├")}${border("─".repeat(inner))}${border("┤")}`,
            `${border("│")}${padLine(` ${segments}`, inner)}${border("│")}`,
            `${border("│")}${" ".repeat(inner)}${border("│")}`,
            ...partRows.map((row) => `${border("│")}${row}${border("│")}`),
            `${border("├")}${border("─".repeat(inner))}${border("┤")}`,
            `${border("│")}${padLine(theme.fg("dim", ` ↑↓ select · Enter or click to preview · ${ESC} close`), inner)}${border("│")}`,
            border(`╰${"─".repeat(inner)}╯`),
          ];
        },
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", width: 64, minWidth: 44, maxHeight: "90%", margin: 1 } },
  );
}

export default function contextExtension(pi: ExtensionAPI): void {
  pi.registerCommand("context", {
    description: "Show how the context window is used, with previews of each part",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage();
      const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
      const breakdown = collectContextBreakdown({
        systemPrompt: ctx.getSystemPrompt(),
        options: ctx.getSystemPromptOptions?.() ?? {},
        tools: pi.getAllTools(),
        entries: ctx.sessionManager.buildContextEntries(),
      });
      const report = assembleReport(breakdown, usage, contextWindow);

      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify(formatReport(report), "info");
        return;
      }

      const previews: Preview[] = [
        { key: "systemPrompt", label: "System prompt", title: "System Prompt", content: breakdown.previews.systemPrompt },
        { key: "memoryFiles", label: "Memory", title: "Memory Files", content: breakdown.previews.memoryFiles },
        { key: "skills", label: "Skills", title: "Skills", content: breakdown.previews.skills },
        { key: "tools", label: "Tools definition", title: "Tool Definitions", content: breakdown.previews.tools },
        { key: "toolResults", label: "Tool results", title: "Tool Results", content: breakdown.previews.toolResults },
        { key: "contextFiles", label: "Context", title: "Conversation Context", content: breakdown.previews.contextFiles },
      ];
      const selected = { index: 0 };
      while (true) {
        const key = await showUsageDialog(ctx, report, previews, selected);
        if (!key) return;
        const preview = previews.find((candidate) => candidate.key === key);
        if (preview) await showTextPreview(ctx, preview.title, preview.content);
      }
    },
  });
}
