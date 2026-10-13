/**
 * Compact mode: every assistant message containing a toolCall is folded into one incrementally accumulating summary row
 * (`Ran for 8s, bash×2, read×2`), with edit/write as standalone title rows (`✓ write <path> (+25 -0)`);
 * normal tools show no standalone row when collapsed; when expanded (Ctrl+O / fullscreen click) assistant text renders natively,
 * and thinking and tool cards are placed in a userMessageBg panel (inside the card, compact-thinking / Pi native or dedicated
 * renderers are restored). edit/write reuse the mode=on rich diff
 * and `editDiffCollapsedLines` / `writeDiffCollapsedLines` / `expandedPreviewMaxLines`.
 * Agent/Task family: calls only count in the summary and the tool card always stays collapsed (avoids pending-to-done height flicker).
 * The bottom Agents/Tasks panel is handled by the independent pi-subagents/pi-tasks widgets, not by externalized tool cards.
 *
 * Live spectator state (round in progress / quiet period after finishing): the body has the same shape as collapsed; the summary row and single-slot card
 * (`↳` + the latest block: a still-growing thinking preview, or the round's most recent tool, running first) hang at
 * the end of the round in the transcript container (tail-row component, after the anchor and tool cards, before the next message).
 * Thinking grows in place without rotating; the slot content changes only when a new thinking block or tool call arrives.
 * Hanging the summary row at the end is deliberate: while running it always sits at the bottom edge of the writable viewport, and on completion it flips in place from Running... to
 * Ran for and really lands in scrollback; inside the anchor it would be pushed out of the viewport by tools/diffs and freeze.
 * (Standalone rendering where the anchor is not mounted in a container falls back to the old in-component behavior.)
 *
 * Tool counts: read is deduplicated by non-empty path, others count per call (in order of first appearance); edit/write are not in the summary.
 * Duration = wall-clock time elapsed in the round; Running... while in progress, Ran for when finished.
 * abort/error/length status rows hang outside the summary so collapsing does not swallow them.
 * The final agent-round summary is owned exclusively by feature/agent-summary (bash/read/edit/write/other).
 *
 * Patch lifecycle follows the repository's existing pattern: Symbol ownership, dispose restores only methods still
 * held by this installation, and a reentrancy guard prevents leftover closures from recursing after /reload.
 */
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, Box, Spacer } from "@earendil-works/pi-tui";
import { config, getToolDisplayConfig } from "../config/config.ts";
import { toolLoadingIcon } from "../utils/tool-loading-icon.ts";
import { sanitizeToolResultText } from "../utils/tool-result-sanitize.ts";
import { refreshTranscriptComponent } from "./transcript-refresh.ts";
import { getMessageDisplayTheme } from "./tool/message-display.ts";
import { showMoreHintText } from "./tool/show-more-hint.ts";
import {
	countEditDiffStats,
	countWriteDiffStats,
	isRichDiffComponent,
} from "./tool/diff/diff-renderer.ts";
import { renderRichToolResult } from "./tool/diff/index.ts";
import type { WriteExecutionMetadataStore } from "./tool/diff/write-execution.ts";
import { isToolCallHovered } from "./mouse/hover.ts";
import { getToolMouseTui } from "./mouse/scroll.ts";
import { insetComponent, renderExpandedToolResult, scheduleAnimation } from "./tool/result.ts";
import { paddedBackgroundRow } from "./tool/grouping.ts";
import { formatDisplayPath } from "./tool/names.ts";
import {
	hasVisibleText,
	removeStyledRange,
	stripBackgroundAnsi,
	stripTerminalSequencesPreservingLayout,
} from "../utils/ansi-text.ts";
import { walkComponentTree } from "../utils/component-tree.ts";
import {
	ASSISTANT_REENTRY_KEY,
	ASSISTANT_SET_EXPANDED_KEY,
	ASSISTANT_TOGGLE_ROUND_KEY,
	COMPACT_MODE_PATCH_KEY,
	COMPACT_THINKING_PATCH_KEY,
	patchRegistry,
	PROTOTYPE_ORIGINAL_KEY,
	TOOL_GROUPING_PARENT_KEY,
} from "../utils/patch-keys.ts";

/** Pi's native components and the extension may each hold their own copy of pi-tui, so Spacer cannot be detected by instanceof alone. */
function isSpacerComponent(value: any): boolean {
	return value instanceof Spacer || value?.constructor?.name === "Spacer";
}

/** Read-only query surface of the compact render layer onto compact-thinking (no second set of timers). */
export type CompactThinkingQuery = {
	getMessageThinkingDurationMs(messageTimestamp: number): number | undefined;
	isMessageThinkingActive?(messageTimestamp: number): boolean;
	getThinkingAnimationFrame?(): number;
	setCompactSummaryActive?(active: boolean): void;
};

const EDIT_WRITE_TOOLS = new Set(["edit", "write"]);

/**
 * Quiet period (ms) before folding after a round ends. Body tokens often arrive before the toolCall,
 * so folding immediately would cause two transitions (fold, then reopen); if a new round takes over during the quiet period, both fold together.
 */
const FOLD_SETTLE_MS = 250;

type CompactThinkingTheme = Pick<Theme, "fg" | "italic" | "bold">;

/** Static text styles shared with the compact-thinking main renderer. */
export function styleCompactThinkingText(
	text: string,
	theme: CompactThinkingTheme | undefined,
	bold = false,
): string {
	if (!theme) return text;
	const color = config.dimThinkingText ? "dim" : "thinkingText";
	const colored = typeof theme.fg === "function" ? theme.fg(color, text) : text;
	const weighted = bold && typeof theme.bold === "function" ? theme.bold(colored) : colored;
	return typeof theme.italic === "function" ? theme.italic(weighted) : weighted;
}

/** Active-thinking sweep animation shared with the compact-thinking main renderer. */
export function animateCompactThinkingText(
	text: string,
	theme: CompactThinkingTheme | undefined,
	animationFrame: number,
	boldBase = false,
): string {
	if (!theme) return text;
	const characters = Array.from(text);
	if (characters.length === 0) return "";
	const highlightWidth = Math.max(1, Math.min(5, Math.ceil(characters.length * 0.28)));
	const start = (animationFrame % (characters.length + highlightWidth)) - highlightWidth;
	const end = start + highlightWidth;
	const before = characters.slice(0, Math.max(0, start)).join("");
	const highlighted = characters
		.slice(Math.max(0, start), Math.min(characters.length, end))
		.join("");
	const after = characters.slice(Math.max(0, end)).join("");
	const highlightedColored =
		highlighted && typeof theme.fg === "function" ? theme.fg("text", highlighted) : highlighted;
	const highlightedWeighted =
		highlightedColored && typeof theme.bold === "function"
			? theme.bold(highlightedColored)
			: highlightedColored;
	const highlightedText =
		highlightedWeighted && typeof theme.italic === "function"
			? theme.italic(highlightedWeighted)
			: highlightedWeighted;

	return (
		styleCompactThinkingText(before, theme, boldBase) +
		highlightedText +
		styleCompactThinkingText(after, theme, boldBase)
	);
}

function formatThoughtDuration(durationMs: number) {
	if (durationMs < 1_000) {
		return `${Math.max(1, Math.round(durationMs))}ms`;
	}

	const totalSeconds = Math.max(1, Math.round(durationMs / 1_000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) return `${seconds}s`;
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export { formatThoughtDuration };

/** assistant stopReason -> outer status text (aligned with Pi's native wording). */
export function messageStopStatus(message: any): string | undefined {
	const reason = message?.stopReason;
	if (reason === "aborted") {
		return message.errorMessage && message.errorMessage !== "Request was aborted"
			? String(message.errorMessage)
			: "Operation aborted";
	}
	if (reason === "error") {
		return `Error: ${message.errorMessage || "Unknown error"}`;
	}
	if (reason === "length") {
		return "Response was truncated before completion.";
	}
	return undefined;
}

function roundStopStatus(messages: Iterable<any>): string | undefined {
	for (const message of messages) {
		const status = messageStopStatus(message);
		if (status) return status;
	}
	return undefined;
}

/**
 * Summary text per assistant message (may be an empty string when there are no tool counts):
 * duration = max(thinking query, durationFloorMs wall clock); tools in order of first appearance; read paths deduplicated.
 */
function buildMessagesSummary(
	messages: Iterable<any>,
	query?: CompactThinkingQuery,
	runningActiveOverride?: boolean,
	durationFloorMs?: number,
): string {
	const parts: string[] = [];
	const counts = new Map<string, number>();
	const readPaths = new Set<string>();
	const durationTimestamps = new Set<number>();
	let durationMs = 0;
	let runningActive = false;

	for (const message of messages) {
		if (typeof message?.timestamp === "number" && !durationTimestamps.has(message.timestamp)) {
			durationTimestamps.add(message.timestamp);
			if (query?.isMessageThinkingActive?.(message.timestamp)) runningActive = true;
			const value = query?.getMessageThinkingDurationMs(message.timestamp);
			if (typeof value === "number" && Number.isFinite(value) && value > 0) durationMs += value;
		}
		const content = Array.isArray(message?.content) ? message.content : [];
		for (const item of content) {
			if (item?.type !== "toolCall") continue;
			const rawName = typeof item.name === "string" ? item.name : "tool";
			if (EDIT_WRITE_TOOLS.has(rawName)) continue;
			const name = sanitizeToolResultText(rawName);
			if (rawName.split(".").pop() === "read") {
				const args = item.arguments ?? item.args ?? {};
				const path = args.path ?? args.file_path ?? args.file;
				if (typeof path === "string" && path.length > 0) {
					if (readPaths.has(path)) continue;
					readPaths.add(path);
				}
			}
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
	}

	if (
		typeof durationFloorMs === "number" &&
		Number.isFinite(durationFloorMs) &&
		durationFloorMs > durationMs
	) {
		durationMs = durationFloorMs;
	}

	runningActive = runningActiveOverride ?? runningActive;
	if (runningActive) {
		parts.push(durationMs > 0 ? `Running... · ${formatThoughtDuration(durationMs)}` : "Running...");
	} else if (durationMs > 0) parts.push(`Ran for ${formatThoughtDuration(durationMs)}`);
	for (const [name, count] of counts) parts.push(`${name}×${count}`);
	return parts.join(", ");
}

export function buildMessageSummary(
	message: any,
	query?: CompactThinkingQuery,
	durationFloorMs?: number,
): string {
	return buildMessagesSummary([message], query, undefined, durationFloorMs);
}

function fallbackTheme(): any {
	return {
		fg: (_color: string, text: string) => text,
		italic: (text: string) => text,
		bold: (text: string) => text,
	};
}

function themeOf(): any {
	return getMessageDisplayTheme() ?? fallbackTheme();
}

/** RGB to HSL (h in [0,1), l and s in [0,1]). */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
	r /= 255;
	g /= 255;
	b /= 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	switch (max) {
		case r:
			h = (g - b) / d + (g < b ? 6 : 0);
			break;
		case g:
			h = (b - r) / d + 2;
			break;
		default:
			h = (r - g) / d + 4;
	}
	return [h / 6, l, s];
}

/** HSL to RGB (h in [0,1), l and s in [0,1]). */
function hslToRgb(h: number, l: number, s: number): [number, number, number] {
	if (s === 0) {
		const v = Math.round(l * 255);
		return [v, v, v];
	}
	const hue2rgb = (p: number, q: number, t: number): number => {
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	return [
		Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
		Math.round(hue2rgb(p, q, h) * 255),
		Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
	];
}

/** Inner tool call card background: darken the userMessageBg by HSL (l×0.7),
 *  to create nested layering with the outer card; returned unchanged if not RGB or already dark enough. */
function darkenBgAnsi(theme: any, slot: string): string {
	const prefix = typeof theme?.getBgAnsi === "function" ? String(theme.getBgAnsi(slot)) : "";
	const m = prefix.match(/48;2;(\d+);(\d+);(\d+)/);
	if (!m) return prefix;
	const [h, l, s] = rgbToHsl(Number(m[1]), Number(m[2]), Number(m[3]));
	if (l <= 0.05) return prefix; // already dark enough, no further darkening
	const [r, g, b] = hslToRgb(h, l * 0.7, s);
	return `\x1b[48;2;${r};${g};${b}m`;
}

/** Tool card dark row: inset left and right (2 left, 3 right, including the tool card's own padding), background only up to the content area,
 *  fixing truncation by the trailing reset. */
function toolCardBgRow(
	theme: any,
	slot: string,
	bgAnsi: string,
	line: string,
	width: number,
): string {
	const leftInset = 2;
	const rightInset = 3;
	const contentWidth = Math.max(0, width - leftInset - rightInset);
	// 1 cell of inner padding on each side inside the dark block; realign after removing the original leading spaces
	const text = stripBackgroundAnsi(line).replace(/^ +/, "");
	const innerPad = 2;
	const clipped = truncateToWidth(text, Math.max(0, contentWidth - innerPad), "");
	const pad = Math.max(0, contentWidth - innerPad - visibleWidth(clipped));
	const body = ` ${clipped}${" ".repeat(pad)} `;
	const stable = body.replace(/\x1b\[(?:0)?m/g, (reset) => reset + bgAnsi);
	const outerBg = typeof theme?.getBgAnsi === "function" ? String(theme.getBgAnsi(slot)) : "";
	const inset = (n: number) => (outerBg ? `${outerBg}${" ".repeat(n)}\x1b[49m` : " ".repeat(n));
	return `${inset(leftInset)}${bgAnsi}${stable}\x1b[49m${inset(rightInset)}`;
}
/** edit/write expanded card: keep the original style (expanded card background Box); do not apply tool card dark/spacing changes. */
function editWriteExpandedCard(theme: any): any {
	return new Box(
		1,
		1,
		typeof theme.bg === "function"
			? (text: string) => theme.bg(config.expandedCardBackground, text)
			: undefined,
	);
}

/** compact expanded panel: the outer card keeps the expanded-card background; an expanded thinking is wrapped in an extra, darker
 *  inner card (its own Box background is the same as the outer card and would blur together otherwise), and tool cards are laid directly on the outer card background.
 *  Each child card is preceded by 1 separator row (skipped if the previous one is already blank), and the child card's own leading/trailing blank rows are trimmed,
 *  avoiding double blank rows stacked with the outer/inner card padding.
 *  hits: row ranges and hit targets of child cards (thinking hits itself, tools hit the tool component),
 *  used for clicking the hint after expansion. When toolHits is off, tools are not mapped and clicks still belong to the outer panel.
 *  live=true: used for the live slot; no background and no blank rows above/below, the first row follows `↳` directly and other rows are indented to align
 *  (Claude Code's ⎿ convention). Output is still one row per row, so hits row numbers need no shifting.
 */
function layoutExpandedToolCard(
	theme: any,
	children: any[],
	width: number,
	paints?: string[][],
	toolHits = false,
	live = false,
): { lines: string[]; hits: Array<{ child: any; start: number; end: number }> } {
	const slot = config.expandedCardBackground;
	const toolBgAnsi = darkenBgAnsi(theme, slot);
	/** Width of the marker before each live row (`↳ ` on the first row, alignment spaces on the rest). */
	const markerWidth = live ? 2 : 0;
	const innerWidth = Math.max(0, width - 2 - markerWidth);
	const lines: string[] = [];
	const hits: Array<{ child: any; start: number; end: number }> = [];
	const isThinkingPreview = (child: any) => typeof child?.setHintHovered === "function";
	let lastBlank = false;
	/** Leading indent eaten from the first live row: continuation rows shift left by the same number of cells to keep relative alignment within the block. */
	let liveLead = 0;
	const pushRow = (raw: string) => {
		if (!live) {
			lines.push(paddedBackgroundRow(theme, slot, raw, width));
			return;
		}
		// Do not repeat the expand entry inside the slot (see SLOT_HINT_PATTERNS).
		const line = stripSlotHint(raw);
		// Tool card rows begin with an SGR: the indent spaces come after the ANSI.
		const head = line.match(/^((?:\x1b\[[0-9;]*m)*)( *)/);
		const ansi = head?.[1] ?? "";
		const spaces = head?.[2]?.length ?? 0;
		const first = lines.length === 0;
		if (first) liveLead = spaces;
		// Put a muted `↳` on the first row (same color as default-mode tool result rows); continuation rows drop indent per liveLead.
		// Keep the leading SGR on both sides: dropping it makes the row fall back to the terminal default foreground.
		const marker = first ? `${theme.fg("muted", "↳")} ` : "  ";
		const lead = first ? spaces : Math.min(spaces, liveLead);
		lines.push(
			`${marker}${ansi}${truncateToWidth(line.slice(ansi.length + lead), innerWidth, "")}`,
		);
	};
	const pushBlank = () => {
		if (live || lastBlank) return;
		lines.push(paddedBackgroundRow(theme, slot, "", width));
		lastBlank = true;
	};
	for (let childIndex = 0; childIndex < children.length; childIndex++) {
		const child = children[childIndex];
		const painted = paints?.[childIndex];
		const childLines = Array.isArray(painted) ? painted : child.render(innerWidth);
		// live leaves no blank rows and no dark inner card: the slot has no border.
		const innerCard = !live && isThinkingPreview(child) && child.expanded === true;
		let first = -1;
		let last = -1;
		for (let i = 0; i < childLines.length; i++) {
			if (hasVisibleText(childLines[i])) {
				if (first < 0) first = i;
				last = i;
			}
		}
		if (first < 0) {
			if (live) continue;
			for (const line of childLines) {
				lines.push(paddedBackgroundRow(theme, slot, line, width));
				lastBlank = !hasVisibleText(line);
			}
			continue;
		}
		if (!innerCard) pushBlank();
		const rangeStart = lines.length;
		// An expanded thinking uses the dark inner card (1 row of padding above and below); tool cards lie directly on the outer card.
		const paintRow = innerCard
			? (line: string) => lines.push(toolCardBgRow(theme, slot, toolBgAnsi, line, width))
			: pushRow;
		if (innerCard) paintRow("");
		for (let i = first; i <= last; i++) paintRow(childLines[i]);
		if (innerCard) paintRow("");
		// The inner card's bottom padding cannot serve as a separator: following child cards still need 1 blank outer-card row.
		lastBlank = false;
		// thinking hits itself; tools are mapped back to the tool component only when they need to be expandable a second time inside the expanded card.
		if (isThinkingPreview(child)) hits.push({ child, start: rangeStart, end: lines.length });
		else if (toolHits && child.__ccTool) {
			hits.push({ child: child.__ccTool, start: rangeStart, end: lines.length });
		}
	}
	pushBlank();
	return { lines, hits };
}

function compactRoundCard(
	cardItems: Array<{ child?: any; tool?: any }>,
	toolRender: (tool: any, width: number) => string[],
	/** When true, tool rows in the card belong to the tool component and can be clicked to expand again (whole-round expanded card). */
	toolHits = false,
	/** When true, use the live slot layout: no blank rows, first row follows `↳` directly. */
	live = false,
): any {
	const children: any[] = [];
	for (const item of cardItems) {
		if (item.child) children.push(item.child);
		else if (item.tool) {
			const tool = item.tool;
			children.push({
				__ccToolCard: true,
				__ccTool: tool,
				render: (innerWidth: number) => toolRender(tool, innerWidth),
				invalidate: () => tool.invalidate?.(),
			});
		}
	}
	/** Available width for child blocks: live also gives up the marker slot for the first row's `↳ `. */
	const contentWidth = (width: number) => Math.max(0, width - 2 - (live ? 2 : 0));
	let paint:
		| {
				width: number;
				theme: unknown;
				/** The background slot is also an input to panel rows: after a config change the whole card with the old background cannot be reused. */
				bgSlot: string;
				paints: unknown[];
				lines: string[];
				hits: Array<{ child: any; start: number; end: number }>;
		  }
		| undefined;
	const layout = (width: number) => {
		const theme = themeOf();
		const bgSlot = config.expandedCardBackground;
		const innerWidth = contentWidth(width);
		const paints = children.map((child) => {
			const lines = child.render?.(innerWidth);
			return Array.isArray(lines) ? lines : [];
		});
		if (
			paint &&
			paint.width === width &&
			paint.theme === theme &&
			paint.bgSlot === bgSlot &&
			paint.paints.length === paints.length &&
			paint.paints.every((item, index) => item === paints[index])
		) {
			return paint;
		}
		const laid = layoutExpandedToolCard(theme, children, width, paints, toolHits, live);
		paint = {
			width,
			theme,
			bgSlot,
			paints,
			lines: laid.lines,
			hits: laid.hits,
		};
		return paint;
	};
	return {
		children,
		render(width: number): string[] {
			return layout(width).lines;
		},
		childAtRow(localRow: number, width: number) {
			for (const hit of layout(width).hits) {
				if (localRow >= hit.start && localRow < hit.end) return hit.child;
			}
			return null;
		},
		invalidate() {
			paint = undefined;
			for (const child of children) child.invalidate?.();
		},
	};
}

function isAssistantComponent(value: any): boolean {
	return value instanceof AssistantMessageComponent;
}

function isToolComponent(value: any): boolean {
	return value instanceof ToolExecutionComponent;
}

function detachAssistantExpansion(component: any): void {
	if (
		typeof component?.[ASSISTANT_SET_EXPANDED_KEY] !== "function" ||
		component.setExpanded !== component[ASSISTANT_SET_EXPANDED_KEY]
	) {
		return;
	}
	delete component.setExpanded;
	delete component[ASSISTANT_SET_EXPANDED_KEY];
	delete component[ASSISTANT_TOGGLE_ROUND_KEY];
	delete component[ASSISTANT_REENTRY_KEY];
}

/** Lets mouse-interaction identify clickable compact assistant rows (effective only in compact mode). */
export function isCompactAssistantComponent(value: unknown): boolean {
	if (config.mode !== "compact" || !value || typeof value !== "object") return false;
	const component = value as any;
	return (
		typeof component[ASSISTANT_SET_EXPANDED_KEY] === "function" &&
		component.setExpanded === component[ASSISTANT_SET_EXPANDED_KEY]
	);
}

export type CompactModeHooks = {
	/** Sync after session events: ownership, global expanded state, mounted components. */
	sync(ctx: any): void;
	/** Repaint all tracked assistant/tool components (used on mode switch). */
	refresh(): void;
	/** Reclaim the assistant patch in compact mode (sits above compact-thinking). */
	assertOwnership(): void;
	/** Re-render the assistant message containing the given toolCallId (refresh when thinking finishes). */
	refreshToolCallMessage(toolCallId: string | undefined): void;
	shutdown(): void;
};

type CompactModeInstallDeps = {
	query?: CompactThinkingQuery;
	writeMetadata: WriteExecutionMetadataStore;
};

type CompactModePatch = {
	active: boolean;
	prototype: any;
	assistantInstalled: (...args: any[]) => any;
	assistantOriginal: (...args: any[]) => any;
	assistantNative: (...args: any[]) => any;
	toolInstalledRender: (width: number) => string[];
	toolInstalledUpdateDisplay: () => void;
	toolOriginalRender: (width: number) => string[];
	toolOriginalUpdateDisplay: () => void;
	assertAssistantOwnership: () => void;
	dispose: () => void;
};

const trackedAssistantComponents = new Set<any>();
const trackedToolComponents = new Set<any>();
let hoveredAssistantComponent: any;

/**
 * Active-round summary getter: used to mirror into the persistent status row (pi working row).
 * Registered by installCompactMode and cleared on uninstall; reads activeRound directly without holding a round closure.
 */
let compactRunStatusGetter: (() => string | undefined) | undefined;

/** Summary text of the active round (`Running... · 9s, bash×1`); returns undefined if there is no active round. */
export function getCompactRunStatusText(): string | undefined {
	return compactRunStatusGetter?.();
}

/**
 * Round tail row record: the summary row (plus the slot card when live) hangs as a sibling component at the end of the round in the transcript container,
 * not inside the anchor. Once mutable content inside the anchor is pushed out of the viewport by tools/diffs
 * it can never be written to scrollback again (regular main screen can only diff the visible area), so Running would freeze permanently
 * at the last frame before being pushed out; the tail row always sits at the writable bottom edge, so the final Ran for really lands in history.
 * Held at module level (like trackedAssistantComponents): deduplication and cleanup across /reload.
 */
type MountedRoundTail = {
	host: any;
	container: any;
	parts: any[];
	round: any;
};
const tailByAnchor = new WeakMap<object, MountedRoundTail>();
const mountedTails = new Set<MountedRoundTail>();

export function setHoveredCompactAssistant(component: any): boolean {
	if (hoveredAssistantComponent === component) return false;
	hoveredAssistantComponent = component;
	return true;
}

/**
 * Called when a tool inside a whole-round expanded card is clicked open: lets compact's forced collapse let this one through,
 * and collapses other expanded tools in the same round (keeping a single open). No-op for tools outside a round.
 */
let roundToolExpansion: { markUserExpanded(tool: any): void } | undefined;

export function markCompactRoundToolExpanded(tool: any): void {
	roundToolExpansion?.markUserExpanded(tool);
}

/** Viewport position before panel expansion: restored on collapse, so a taller panel does not leave the viewport misaligned after collapsing. */
const panelViewportBeforeExpand = new WeakMap<
	object,
	{ scrollTop: number; followingEnd: boolean }
>();

function capturePanelViewport(card: any): void {
	if (!card || panelViewportBeforeExpand.has(card)) return;
	const view = getToolMouseTui()?.getPrimaryScrollView?.();
	if (!view || typeof view.scrollTop !== "number" || typeof view.scrollTo !== "function") return;
	panelViewportBeforeExpand.set(card, {
		scrollTop: view.scrollTop,
		followingEnd: view.isFollowingEnd !== false,
	});
}

function restorePanelViewport(card: any): void {
	const snapshot = panelViewportBeforeExpand.get(card);
	if (!snapshot) return;
	panelViewportBeforeExpand.delete(card);
	const view = getToolMouseTui()?.getPrimaryScrollView?.();
	if (!view) return;
	// Was at the bottom before expanding: hand back to the official follow; otherwise return to the pre-expansion scroll offset.
	if (snapshot.followingEnd && typeof view.scrollToEnd === "function") view.scrollToEnd();
	else if (typeof view.scrollTo === "function") view.scrollTo(snapshot.scrollTop);
}

function compactEditWriteLine(
	component: any,
	width: number,
	writeMetadata?: WriteExecutionMetadataStore,
	options: { hint?: boolean; flushLeft?: boolean } = {},
): string[] {
	const theme = themeOf();
	const name = String(component.toolName ?? "tool");
	const args = component.args ?? {};
	const path =
		typeof args.path === "string" && args.path
			? args.path
			: typeof args.file_path === "string" && args.file_path
				? args.file_path
				: "";
	const isError = component.result?.isError === true;
	const isPending = !component.result || component.isPartial === true;
	const icon = isError ? "✗" : isPending ? toolLoadingIcon() : "✓";
	const iconColor = isError ? "error" : isPending ? "accent" : "success";
	let statsText = "";
	let statsStyled = "";
	if (!isError && !isPending) {
		const stats =
			name === "edit"
				? countEditDiffStats(component.result?.details)
				: name === "write"
					? countWriteDiffStats(
							typeof args.content === "string" ? args.content : undefined,
							writeMetadata?.get(component.toolCallId)?.previousContent,
							writeMetadata?.get(component.toolCallId)?.fileExistedBeforeWrite,
						)
					: undefined;
		if (stats) {
			statsText = ` (+${stats.added} -${stats.removed})`;
			statsStyled = ` ${theme.fg("dim", "(")}${theme.fg("success", `+${stats.added}`)} ${theme.fg("error", `-${stats.removed}`)}${theme.fg("dim", ")")}`;
		}
	}
	// The expanded card Box(1,1) already pads; collapsed rows keep 1 leading space themselves
	const iconPart = `${options.flushLeft ? "" : " "}${theme.fg(iconColor, icon)} `;
	const namePart = theme.fg("toolTitle", name);
	const hintText =
		options.hint !== false && component.expanded !== true ? ` · ${showMoreHintText()}` : "";
	const fixedWidth =
		visibleWidth(iconPart) +
		visibleWidth(namePart) +
		visibleWidth(statsText) +
		visibleWidth(hintText);
	const pathWidth = Math.max(0, width - fixedWidth - (path ? 1 : 0));
	const pathPart =
		pathWidth > 0 && path ? ` ${formatDisplayPath(path, component.cwd, pathWidth)}` : "";
	const line = `${iconPart}${namePart}${theme.fg("toolTitle", pathPart)}${statsStyled}${hintText ? theme.fg("dim", hintText) : ""}`;
	return ["", truncateToWidth(line, width, "")];
}

/** expanded is written into the rich diff closure; collapsed/expanded use separate slot caches to avoid parseDiff on every frame. */
const compactRichDiffCache = new WeakMap<
	object,
	{ result: unknown; collapsed?: unknown; expanded?: unknown }
>();

type CompactEditPaintHit = {
	width: number;
	theme: unknown;
	/** The expanded card's background slot also takes part in hit testing. */
	bgSlot: string;
	expanded: boolean;
	result: unknown;
	isPartial: boolean;
	args: unknown;
	hover: boolean;
	ioHover: unknown;
	lines: string[];
};
const compactEditPaintCache = new WeakMap<object, CompactEditPaintHit>();

function compactEditIoHover(component: any): unknown {
	const view = component?.resultRendererComponent;
	return typeof view?.getHoveredSection === "function" ? view.getHoveredSection() : null;
}

/**
 * compact edit/write: title row + the same rich diff as mode=on.
 * Collapsed and expanded both go through `renderRichToolResult`; limits are not a separate set.
 * Completed results reuse rows across frames; pending is not cached, so the loader animation does not freeze.
 */
function compactEditWriteLines(
	component: any,
	width: number,
	writeMetadata?: WriteExecutionMetadataStore,
): string[] {
	const expanded = component.expanded === true;
	const isPartial = component.isPartial === true;
	const pending = !component.result || isPartial;
	const hover = isToolCallHovered(component.toolCallId);
	const ioHover = compactEditIoHover(component);
	const theme = themeOf();
	if (!pending) {
		const hit = compactEditPaintCache.get(component);
		if (
			hit &&
			hit.width === width &&
			hit.theme === theme &&
			hit.bgSlot === config.expandedCardBackground &&
			hit.expanded === expanded &&
			hit.result === component.result &&
			hit.isPartial === isPartial &&
			hit.args === component.args &&
			hit.hover === hover &&
			hit.ioHover === ioHover
		) {
			return hit.lines;
		}
	}
	const lines = paintCompactEditWrite(component, width, writeMetadata);
	if (!pending) {
		compactEditPaintCache.set(component, {
			width,
			theme,
			bgSlot: config.expandedCardBackground,
			expanded,
			result: component.result,
			isPartial,
			args: component.args,
			hover,
			ioHover: compactEditIoHover(component),
			lines,
		});
	}
	return lines;
}

function paintCompactEditWrite(
	component: any,
	width: number,
	writeMetadata?: WriteExecutionMetadataStore,
): string[] {
	const theme = themeOf();
	const result = component.result;
	const expanded = component.expanded === true;
	const isError = result?.isError === true;
	const isPending = !result || component.isPartial === true;
	let candidate: unknown;
	if (!isPending && writeMetadata) {
		let entry = compactRichDiffCache.get(component);
		if (!entry || entry.result !== result) {
			entry = { result };
			compactRichDiffCache.set(component, entry);
		}
		const slot = expanded ? "expanded" : "collapsed";
		candidate = entry[slot];
		if (!isRichDiffComponent(candidate)) {
			candidate = renderRichToolResult(
				String(component.toolName ?? ""),
				result,
				{
					expanded,
					isPartial: component.isPartial === true,
					isError,
					isHovered: () => isToolCallHovered(component.toolCallId),
				},
				theme,
				component,
				writeMetadata,
				getToolDisplayConfig,
			);
			if (isRichDiffComponent(candidate)) entry[slot] = candidate;
		}
	}
	const hasRich = isRichDiffComponent(candidate);
	if (hasRich) {
		component.resultRendererComponent = candidate;
	}

	const title = compactEditWriteLine(component, width, writeMetadata, { hint: !hasRich });
	if (!hasRich && !expanded) {
		return title;
	}

	let detail: any;
	if (hasRich) {
		detail = expanded ? candidate : insetComponent(candidate as any);
	} else {
		const outputText = sanitizeToolResultText(
			Array.isArray(result?.content)
				? result.content
						.filter((item: any) => item?.type === "text")
						.map((item: any) => String(item.text ?? ""))
						.join("\n")
				: "",
		);
		const state = (component.state ??= {});
		detail = renderExpandedToolResult(
			outputText,
			theme,
			isError,
			state.ccstyleIoView,
			component.args,
			component,
			true, // outer Box(1,1) already pads
		);
		component.resultRendererComponent = detail;
	}

	if (!expanded) {
		return [...title, ...detail.render(width)];
	}

	const box = editWriteExpandedCard(theme);
	box.addChild({
		render(innerWidth: number): string[] {
			return compactEditWriteLine(component, innerWidth, writeMetadata, {
				hint: false,
				flushLeft: true,
			}).slice(1);
		},
		invalidate() {},
	});
	box.addChild(detail);
	// Same as native ToolExecutionComponent: Spacer(1) + Box, otherwise there is 1 row less spacing after the previous tool
	return ["", ...box.render(width)];
}

function compactAssistantLineComponent(
	component: any,
	/** Static string or recomputed on each render (the Running duration must tick). */
	summary: string | (() => string),
	query?: CompactThinkingQuery,
	options: { hint?: boolean; leadingBlank?: boolean; pad?: number } = {},
): any {
	const self = component as any;
	let paint:
		| {
				width: number;
				theme: unknown;
				resolved: string;
				hover: boolean;
				hint: boolean;
				pad: number;
				frame: number;
				leadingBlank: boolean;
				lines: string[];
		  }
		| undefined;
	return {
		render(width: number): string[] {
			const theme = themeOf();
			const pad = Math.max(0, options.pad ?? (Number(self.outputPad) || 0));
			const available = Math.max(0, width - pad);
			const hint = options.hint !== false;
			const hintText = hint ? ` · ${showMoreHintText()}` : "";
			const summaryWidth = Math.max(0, available - visibleWidth(hintText));
			const resolved = typeof summary === "function" ? summary() : summary;
			const runningActive = resolved.startsWith("Running...");
			const hover = hoveredAssistantComponent === component;
			const frame = runningActive ? (query?.getThinkingAnimationFrame?.() ?? 0) : 0;
			const leadingBlank = options.leadingBlank !== false;
			if (
				paint &&
				paint.width === width &&
				paint.theme === theme &&
				paint.resolved === resolved &&
				paint.hover === hover &&
				paint.hint === hint &&
				paint.pad === pad &&
				paint.frame === frame &&
				paint.leadingBlank === leadingBlank
			) {
				return paint.lines;
			}
			const plainText = truncateToWidth(resolved, summaryWidth, "…");
			// When Dim thinking text is on, the whole row is dimmed uniformly; otherwise the tool counts stay muted.
			const plain = (value: string) => theme.fg(config.dimThinkingText ? "dim" : "muted", value);
			let text = plain(plainText);
			if (runningActive || plainText.startsWith("Ran for ")) {
				const separator = plainText.indexOf(", ");
				const heading = separator < 0 ? plainText : plainText.slice(0, separator);
				const tools = separator < 0 ? "" : plainText.slice(separator);
				if (runningActive) {
					const durationSeparator = heading.indexOf(" · ");
					const label = durationSeparator < 0 ? heading : heading.slice(0, durationSeparator);
					const duration = durationSeparator < 0 ? "" : heading.slice(durationSeparator);
					text = `${animateCompactThinkingText(label, theme, query?.getThinkingAnimationFrame?.() ?? 0)}${styleCompactThinkingText(duration, theme)}${plain(tools)}`;
				} else {
					text = `${styleCompactThinkingText(heading, theme)}${plain(tools)}`;
				}
			}
			const hintColor = hover ? "text" : "dim";
			const line = `${text}${hintText ? theme.fg(hintColor, hintText) : ""}`;
			const rendered = `${" ".repeat(pad)}${truncateToWidth(line, available, "")}`;
			const lines = leadingBlank ? ["", rendered] : [rendered];
			paint = {
				width,
				theme,
				resolved,
				hover,
				hint,
				pad,
				frame,
				leadingBlank,
				lines,
			};
			return lines;
		},
		invalidate() {
			paint = undefined;
		},
	};
}

function compactStopStatusLine(status: string, pad = 0): any {
	return {
		render(width: number): string[] {
			const theme = themeOf();
			const prefix = " ".repeat(Math.max(0, pad));
			const line = `${prefix}${theme.fg("error", status)}`;
			return ["", truncateToWidth(line, width, "")];
		},
		invalidate() {},
	};
}

/**
 * Expand entry inside slot cards: the card is a read-only spectator view; expanding goes through the summary row's own hint, so the card does not repeat the hint.
 * The hint has two sources: our showMoreHintText (`… +N more lines · click to show more`) and
 * pi's native tool card (`… (N earlier lines, ctrl+o to expand)`), so trimming is done on the rendered result.
 * Only the action words are removed; counts such as `(N more lines)` are kept.
 */
/** Action words of the expand entry: our `click to show more`, pi's `<key> to expand` (the key name may be unavailable). */
const EXPAND_ACTION = String.raw`(?:click to show more|(?:[\w/+]+\s+)?to (?:show more|expand))`;

const SLOT_HINT_PATTERNS: RegExp[] = [
	// The card is in parentheses: `(9 more lines, click to show more)` / `(195 earlier lines, ctrl+o to expand)`,
	// remove only the action words; keep the closing parenthesis and count.
	new RegExp(String.raw`,\s*[^()]*?${EXPAND_ACTION}(?=\))`),
	// Attached directly to the line end: remove the whole segment.
	// Trailing separator dot: ccstyle uses `·` throughout; also compatible with old frames and pi native `•`
	new RegExp(String.raw`\s*(?:[•·]\s*)?${EXPAND_ACTION}\s*$`),
];

function stripSlotHint(line: string): string {
	const plain = stripTerminalSequencesPreservingLayout(line);
	for (const re of SLOT_HINT_PATTERNS) {
		const match = re.exec(plain);
		if (!match) continue;
		// Delete the range rather than truncating and concatenating plain text: the closing parenthesis stays in the original style (dim) and does not fall back to the default foreground.
		return removeStyledRange(line, match.index, match.index + match[0].length);
	}
	return line;
}

/** live slot card: indent by pad; the first row's `↳` is added by the card's own live layout, with no rows added or removed. */
function compactLiveSlot(card: any, pad = 0): any {
	const innerOf = (width: number) => Math.max(0, width - Math.max(0, pad));
	return {
		render(width: number): string[] {
			const indent = " ".repeat(Math.max(0, pad));
			return card.render(innerOf(width)).map((line: string) => `${indent}${line}`);
		},
		childAtRow(localRow: number, width: number) {
			return card.childAtRow?.(localRow, innerOf(width)) ?? null;
		},
		invalidate() {
			card.invalidate();
		},
	};
}

function appendStopStatus(component: any, status: string | undefined): void {
	if (!status || !component?.contentContainer?.addChild) return;
	component.contentContainer.addChild(
		compactStopStatusLine(status, Number(component.outputPad) || 0),
	);
}

function ensureAssistantSetExpanded(component: any): void {
	if (
		typeof component[ASSISTANT_SET_EXPANDED_KEY] === "function" &&
		component.setExpanded === component[ASSISTANT_SET_EXPANDED_KEY]
	) {
		return;
	}
	if (typeof component.setExpanded === "function") {
		detachAssistantExpansion(component);
		if (typeof component.setExpanded === "function") return;
	}
	const installed = function (this: any, expanded: boolean) {
		if (config.mode !== "compact") {
			detachAssistantExpansion(this);
			return;
		}
		const toggleRound = this[ASSISTANT_TOGGLE_ROUND_KEY];
		if (typeof toggleRound === "function") {
			toggleRound(expanded);
			return;
		}
		this.expanded = expanded;
		if (typeof this.updateContent === "function" && this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	};
	component[ASSISTANT_SET_EXPANDED_KEY] = installed;
	component.setExpanded = installed;
}

function collectMountedComponents(root: any): void {
	if (!root || typeof root !== "object") return;
	const assistants = new Set<any>();
	const tools = new Set<any>();
	walkComponentTree(root, (value: any) => {
		if (isAssistantComponent(value)) {
			assistants.add(value);
			// Install setExpanded on the instance only in compact mode, to avoid Ctrl+O/mouse regressions under on/off.
			if (config.mode === "compact") ensureAssistantSetExpanded(value);
		} else if (isToolComponent(value)) {
			tools.add(value);
		}
	});
	// Replace the tracking table only when components are scanned. When a panel/custom UI is open, root often cannot scan the transcript;
	// clearing then would drop instances already registered by live updateContent/updateDisplay,
	// and /ccstyle switching could only be rebuilt via /reload.
	if (assistants.size > 0 || tools.size > 0) {
		trackedAssistantComponents.clear();
		trackedToolComponents.clear();
		for (const component of assistants) trackedAssistantComponents.add(component);
		for (const component of tools) trackedToolComponents.add(component);
	} else if (config.mode === "compact") {
		for (const component of trackedAssistantComponents) ensureAssistantSetExpanded(component);
	}
}

export function installCompactMode(deps: CompactModeInstallDeps): CompactModeHooks {
	const previous = patchRegistry.get<CompactModePatch>(COMPACT_MODE_PATCH_KEY);
	if (previous) previous.dispose();

	const assistantPrototype = AssistantMessageComponent.prototype as any;
	const toolPrototype = ToolExecutionComponent.prototype as any;
	const patch: CompactModePatch = {
		active: true,
		prototype: assistantPrototype,
		assistantInstalled: undefined as any,
		assistantOriginal: assistantPrototype.updateContent,
		assistantNative: assistantPrototype.updateContent,
		toolInstalledRender: undefined as any,
		toolInstalledUpdateDisplay: undefined as any,
		toolOriginalRender: toolPrototype.render,
		toolOriginalUpdateDisplay: toolPrototype.updateDisplay,
		assertAssistantOwnership: () => {},
		dispose: () => {},
	};

	const passThroughAssistant = (component: any, message: any, isStreaming?: boolean): any => {
		const self = component as any;
		if (self[ASSISTANT_REENTRY_KEY] === patch)
			return patch.assistantNative.call(component, message, isStreaming);
		self[ASSISTANT_REENTRY_KEY] = patch;
		try {
			return patch.assistantOriginal.call(component, message, isStreaming);
		} finally {
			delete self[ASSISTANT_REENTRY_KEY];
		}
	};

	type CompactRound = {
		anchor: any;
		messages: Map<any, any>;
		detachedMessages: any[];
		active: boolean;
		suppressedToolIds: Set<string>;
		/** Tool id rendered inline in the live slot; handed back to the outer layer together with the slot when the round ends. */
		liveSlotToolIds: Set<string>;
		/** Deadline timestamp of the quiet period after finishing; until then it still renders as spectator state and folds when due. */
		settleUntil?: number;
		foldTimer?: ReturnType<typeof setTimeout>;
		/** Round wall-clock start, ensuring the Running duration increases continuously. */
		startedAt: number;
		endedAt?: number;
		/** Round tail row (summary + live slot card), hung at the end of the round in the transcript container. */
		tail?: MountedRoundTail;
	};
	let activeRound: CompactRound | undefined;
	let roundByComponent = new WeakMap<object, CompactRound>();
	const expandedRoundToolIds = new Set<string>();
	/** Round tools the user explicitly opened; forced collapse does not push these ids back. */
	const explicitRoundToolIds = new Set<string>();
	const liveSlotToolIds = new Set<string>();
	const pendingFoldRounds = new Set<CompactRound>();
	let uiRef: { requestRender?: (force?: boolean) => void } | undefined;
	let roundTickTimer: ReturnType<typeof setInterval> | undefined;

	const roundWallMs = (round: CompactRound): number => {
		const end = round.active ? Date.now() : (round.endedAt ?? Date.now());
		return Math.max(1, end - round.startedAt);
	};

	const summarize = (messages: Iterable<any>, runningActive?: boolean, round?: CompactRound) =>
		buildMessagesSummary(
			messages,
			deps.query,
			runningActive,
			round ? roundWallMs(round) : undefined,
		);

	const stopRoundTick = (): void => {
		if (!roundTickTimer) return;
		clearInterval(roundTickTimer);
		roundTickTimer = undefined;
	};

	// Own tick: the getter recomputes wall-clock on render; also drives the Running sweep (setCompactSummaryActive).
	const ensureRoundTick = (): void => {
		if (roundTickTimer) return;
		roundTickTimer = setInterval(() => {
			if (!patch.active || !activeRound?.active) {
				stopRoundTick();
				return;
			}
			settleStrandedRounds();
			try {
				// Non-force: keep the fullscreen layout cache and diff drawing.
				uiRef?.requestRender?.();
			} catch {
				/* no UI */
			}
		}, 250);
	};

	/** Spectating: the active round, or a round whose quiet period after finishing has not elapsed (the slot card is still on screen). */
	const roundLive = (round: CompactRound): boolean =>
		round.active || (round.settleUntil !== undefined && Date.now() < round.settleUntil);

	const clearFoldTimer = (round: CompactRound): void => {
		if (round.foldTimer !== undefined) {
			clearTimeout(round.foldTimer);
			round.foldTimer = undefined;
		}
		round.settleUntil = undefined;
		pendingFoldRounds.delete(round);
	};

	/** End the round's active state; no repaint at all. */
	const finalizeRound = (round: CompactRound): void => {
		clearFoldTimer(round);
		round.active = false;
		if (round.endedAt === undefined) round.endedAt = Date.now();
		if (activeRound === round) {
			activeRound = undefined;
			deps.query?.setCompactSummaryActive?.(false);
			stopRoundTick();
		}
	};

	/**
	 * End the round's active state; with render=true it uses the quiet period and folds after a FOLD_SETTLE_MS delay.
	 * Grouping semantics are unaffected: activeRound yields immediately, so new messages are not merged into the already-finished round.
	 */
	const endRound = (round: CompactRound, render = false): void => {
		if (!render || !round.active) {
			finalizeRound(round);
			if (render) renderRound(round);
			return;
		}
		finalizeRound(round);
		if (round.foldTimer !== undefined) return;
		round.settleUntil = Date.now() + FOLD_SETTLE_MS;
		pendingFoldRounds.add(round);
		round.foldTimer = setTimeout(() => {
			round.foldTimer = undefined;
			round.settleUntil = undefined;
			pendingFoldRounds.delete(round);
			renderRound(round);
		}, FOLD_SETTLE_MS);
	};

	/** When a new round takes over, immediately fold a round still in its quiet period, merging two transitions into one. */
	const flushSettle = (): void => {
		for (const round of [...pendingFoldRounds]) {
			clearFoldTimer(round);
			renderRound(round);
		}
	};

	const renderAssistantWithoutThinking = (
		component: any,
		message: any,
		isStreaming?: boolean,
	): any => {
		const content = Array.isArray(message?.content) ? message.content : [];
		const result = passThroughAssistant(
			component,
			{
				...message,
				content: content.filter((item: any) => item?.type !== "thinking"),
			},
			isStreaming,
		);
		component.lastMessage = message;
		return result;
	};

	/** compact allows only a single open: collapse one tool card's expanded state. */
	const collapseTool = (tool: any): void => {
		if (typeof tool?.setExpanded === "function") tool.setExpanded(false);
		else {
			tool.expanded = false;
			tool.updateDisplay?.();
		}
	};

	/** Collapse expanded tool cards by condition. */
	const collapseTools = (shouldCollapse: (tool: any) => boolean): void => {
		for (const tool of trackedToolComponents) {
			if (tool.expanded === true && shouldCollapse(tool)) collapseTool(tool);
		}
	};

	const markRoundToolUserExpanded = (tool: any): void => {
		const id = String(tool?.toolCallId ?? "");
		if (!id || !expandedRoundToolIds.has(id)) return;
		for (const other of trackedToolComponents) {
			const otherId = String(other?.toolCallId ?? "");
			if (other === tool || !expandedRoundToolIds.has(otherId) || other.expanded !== true) continue;
			explicitRoundToolIds.delete(otherId);
			collapseTool(other);
		}
		explicitRoundToolIds.add(id);
	};
	roundToolExpansion = { markUserExpanded: markRoundToolUserExpanded };

	const roundMessages = (round: CompactRound): any[] => [
		...round.messages.values(),
		...round.detachedMessages,
	];

	/** Text mirrored to the persistent status row: only the current active round counts (used by working-message when the summary row is pushed out of the viewport). */
	compactRunStatusGetter = () => {
		const round = activeRound;
		return round?.active ? summarize(roundMessages(round), true, round) || undefined : undefined;
	};

	const roundToolCallIds = (round: CompactRound): Set<string> => {
		const ids = new Set<string>();
		for (const message of roundMessages(round)) {
			for (const item of Array.isArray(message?.content) ? message.content : []) {
				if (item?.type === "toolCall" && typeof item.id === "string") ids.add(item.id);
			}
		}
		return ids;
	};

	/**
	 * The transcript container (pi chatContainer) where the anchor lives.
	 * Prefer the parent pointer the grouping patch sets at addChild; otherwise find the direct parent container along the tui component tree.
	 */
	const tailContainerOf = (anchor: any): any => {
		const keyed = anchor?.[TOOL_GROUPING_PARENT_KEY];
		if (keyed && Array.isArray(keyed.children) && keyed.children.includes(anchor)) {
			return keyed;
		}
		let found: any;
		walkComponentTree(getToolMouseTui(), (value: any) => {
			if (found) return false;
			if (Array.isArray(value?.children) && value.children.includes(anchor)) {
				found = value;
				return false;
			}
			return undefined;
		});
		return found;
	};

	/** Direct parent container of a component in the tree. After a TUI switch/reparent the cached container goes stale. */
	const containerOfHost = (host: any): any => {
		let found: any;
		walkComponentTree(getToolMouseTui(), (value: any) => {
			if (found) return false;
			if (Array.isArray(value?.children) && value.children.includes(host)) {
				found = value;
				return false;
			}
			return undefined;
		});
		return found;
	};

	/** Container the tail row is actually in; if the cached container is stale, find it again via the tree. */
	const tailHostContainer = (tail: MountedRoundTail): any =>
		containerOfHost(tail.host) ??
		(tail.container?.children?.includes?.(tail.host) === true ? tail.container : undefined);

	/** Remove the tail row: remove from the container it is actually in, so a stale cache does not remove from nothing and leave the row in the tree. */
	const removeTailHost = (tail: MountedRoundTail): void => {
		tailHostContainer(tail)?.removeChild?.(tail.host);
	};

	const ensureTailHost = (round: CompactRound): MountedRoundTail => {
		if (round.tail) return round.tail;
		// Remove a stale old-round tail row left on the same anchor (a new round built after reset/regroup) first, to avoid a double summary.
		const stale = tailByAnchor.get(round.anchor);
		if (stale) {
			removeTailHost(stale);
			mountedTails.delete(stale);
			tailByAnchor.delete(round.anchor);
		}
		const tail: MountedRoundTail = { host: undefined, container: undefined, parts: [], round };
		const host: any = {
			outputPad: Number(round.anchor?.outputPad) || 0,
			children: [],
			render: (width: number) => tail.parts.flatMap((part: any) => part?.render?.(width) ?? []),
			childAtRow(localRow: number, width: number) {
				let offset = 0;
				for (const part of tail.parts) {
					const lines = part?.render?.(width);
					const count = Array.isArray(lines) ? lines.length : 0;
					if (localRow < offset + count) {
						return part?.childAtRow?.(localRow - offset, width) ?? null;
					}
					offset += count;
				}
				return null;
			},
			invalidate: () => {
				for (const part of tail.parts) part?.invalidate?.();
			},
		};
		Object.defineProperty(host, "expanded", {
			configurable: true,
			get: () => tail.round?.anchor?.expanded === true,
			set: (value: boolean) => {
				const anchor = tail.round?.anchor;
				if (anchor) anchor.expanded = value;
			},
		});
		// Click/hover ownership is the same expand entry as the anchor; toggle is rebuilt on every renderRound, so forward by value.
		// Dereference dynamically via tail.round: on rebuild handover the anchor may become another component.
		ensureAssistantSetExpanded(host);
		Object.defineProperty(host, "roundAnchor", {
			configurable: true,
			get: () => tail.round?.anchor,
		});
		host[ASSISTANT_TOGGLE_ROUND_KEY] = (expanded: boolean) =>
			tail.round?.anchor?.[ASSISTANT_TOGGLE_ROUND_KEY]?.(expanded);
		tail.host = host;
		tailByAnchor.set(round.anchor, tail);
		mountedTails.add(tail);
		round.tail = tail;
		return tail;
	};

	/**
	 * Tail row placement. While running (including the quiet period) the tail row is always the last row of the container: the count row is pinned to the
	 * transcript bottom edge, and hint rows/custom entries arriving while running can only land above it, so the count
	 * is not pushed away from the bottom and split into two rows. After the round ends the summary row falls back to after the round's last member,
	 * and foreign rows are moved below the summary row, so notification rows always land outside the round boundary.
	 */
	const syncTailPosition = (round: CompactRound): void => {
		const tail = round.tail;
		if (!tail?.host) return;
		const container =
			tail.container?.children?.includes?.(round.anchor) === true
				? tail.container
				: tailContainerOf(round.anchor);
		if (!container || !Array.isArray(container.children)) return;
		tail.container = container;
		const children = container.children as any[];
		const current = children.indexOf(tail.host);
		if (current >= 0) children.splice(current, 1);
		const ids = roundToolCallIds(round);
		const matchesTool = (value: any): boolean =>
			typeof value?.toolCallId === "string" && ids.has(value.toolCallId);
		const isMember = (value: any): boolean =>
			round.messages.has(value) ||
			matchesTool(value) ||
			(Array.isArray(value?.children) && value.children.some(matchesTool));
		let first = -1;
		let last = -1;
		for (let i = 0; i < children.length; i++) {
			if (!isMember(children[i])) continue;
			if (first < 0) first = i;
			last = i;
		}
		const lastMember = last >= 0 ? children[last] : undefined;
		const intruders: any[] = [];
		for (let i = last - 1; i > first; i--) {
			if (!isMember(children[i])) intruders.unshift(children.splice(i, 1)[0]);
		}
		if (lastMember) last = children.indexOf(lastMember);
		const insertAt = last < 0 ? children.length : last + 1;
		if (roundLive(round)) {
			// Live round: foreign rows are pushed after the last member, and the tail row takes the last place in the container.
			children.splice(insertAt, 0, ...intruders);
			children.push(tail.host);
		} else {
			children.splice(insertAt, 0, tail.host, ...intruders);
		}
		tail.host[TOOL_GROUPING_PARENT_KEY] = container;
	};

	const unmountRoundTail = (round: CompactRound): void => {
		const tail = round.tail;
		if (!tail) return;
		round.tail = undefined;
		removeTailHost(tail);
		mountedTails.delete(tail);
		if (tailByAnchor.get(round.anchor) === tail) tailByAnchor.delete(round.anchor);
	};

	/**
	 * pi appends new tool cards at the container end (after the tail row): on updateDisplay, push the owning round's
	 * tail row back to the end. Only rounds in live/quiet period still grow tools.
	 */
	const syncTailForTool = (toolCallId: string): void => {
		if (!toolCallId) return;
		for (const round of [activeRound, ...pendingFoldRounds]) {
			if (round?.tail && roundToolCallIds(round).has(toolCallId)) {
				syncTailPosition(round);
				return;
			}
		}
	};

	/**
	 * Inherit the old round on refresh rebuild: resetRounds clears only the index and does not remove the compact tail row,
	 * so a leftover tail row carries the old round. Only the same component replaying the same message (lastMessage replay)
	 * counts as a rebuild: keep the wall-clock start, the detached tool history, and the tail row component itself;
	 * an old round that already finished lands directly as collapsed (no swing back to Running, no replay of the quiet period),
	 * and one still active only reconnects the wall clock so the Running duration continues.
	 */
	const adoptPriorRound = (round: CompactRound, message: any): void => {
		let prior: CompactRound | undefined;
		for (const tail of mountedTails) {
			const stale = tail.round as CompactRound | undefined;
			if (
				stale &&
				// Identify the component first: on replay the message object is not necessarily the same (session reread/rebuild),
				// and relying on message identity alone would miss a round that should be reconnected, leaving the summary row behind.
				(stale.anchor === round.anchor ||
					stale.messages.has(round.anchor) ||
					stale.detachedMessages.includes(message))
			) {
				prior = stale;
				break;
			}
		}
		if (!prior) return;
		round.startedAt = prior.startedAt;
		if (prior.detachedMessages.length) round.detachedMessages.push(...prior.detachedMessages);
		if (!prior.active) {
			round.active = false;
			round.endedAt = prior.endedAt ?? round.startedAt;
		}
		const tail = prior.tail;
		if (tail) {
			prior.tail = undefined;
			if (tailByAnchor.get(prior.anchor) === tail) tailByAnchor.delete(prior.anchor);
			tail.round = round;
			tailByAnchor.set(round.anchor, tail);
			round.tail = tail;
		}
	};

	/** Create a new active round: literal + activation + adopting the old round on refresh rebuild. */
	const createRound = (anchor: any, message: any): CompactRound => {
		const round: CompactRound = {
			anchor,
			messages: new Map(),
			detachedMessages: [],
			active: true,
			suppressedToolIds: new Set(),
			liveSlotToolIds: new Set(),
			startedAt: Date.now(),
		};
		activateRound(round);
		adoptPriorRound(round, message);
		return round;
	};

	/**
	 * Tail row mount entry: makeParts produces content by render state (collapsed: [summary row], live:
	 * [summary row, slot card]), and identity decides which component owns in-row hover/click (in tail-row mode it is the
	 * host, hit-testing goes straight to it). When the anchor is not mounted in any container (standalone rendering) fall back to
	 * contentContainer, matching the old behavior.
	 */
	const mountRoundTail = (round: CompactRound, makeParts: (identity: any) => any[]): void => {
		if (!tailContainerOf(round.anchor)) {
			// anchor is not in any container (standalone rendering/unmounted): fall back to inside the anchor, matching the old behavior.
			unmountRoundTail(round);
			for (const part of makeParts(round.anchor)) {
				round.anchor?.contentContainer?.addChild?.(part);
			}
			return;
		}
		const tail = ensureTailHost(round);
		tail.parts = makeParts(tail.host);
		tail.host.children = tail.parts;
		syncTailPosition(round);
	};

	/**
	 * Last block still thinking = thinking is still growing; once body text or a tool call follows, it counts as finished.
	 * Spectator state previews only this kind; finished thinking is folded straight into the summary row and no Thought row stays on screen.
	 */
	const hasTrailingThinking = (message: any): boolean => {
		const content = Array.isArray(message?.content) ? message.content : [];
		for (let i = content.length - 1; i >= 0; i--) {
			const item = content[i];
			if (item?.type === "thinking") return true;
			if (item?.type === "toolCall") return false;
			if (item?.type === "text" && String(item.text ?? "").trim()) return false;
		}
		return false;
	};

	/** Running tool: started and no final result yet. */
	const isRunningTool = (tool: any): boolean =>
		tool?.executionStarted === true && (!tool.result || tool.isPartial === true);

	/**
	 * Live spectator state: body + summary row render like the collapsed state, with just one slot card under the summary row.
	 * - Thinking: preview only the last message still thinking; its block is the current latest content;
	 * - Tools: take the slot only when there is no active thinking; running first, otherwise the round's most recent, kept even when finished;
	 * - The slot holds only one block (thinking or tool); it rotates only when a new thinking block/tool call arrives;
	 * - All of the round's tools are taken over by the slot card; the outer layer no longer makes standalone rows.
	 * Visibility is decided only here; when the round ends (renderRound not active) only the slot card disappears.
	 */
	const renderRoundLive = (
		round: CompactRound,
		stopStatus: string | undefined,
		getSummary: () => string,
	): void => {
		// Message still thinking = current latest content, takes the slot first.
		let previewComponent: any;
		for (const [component, message] of round.messages) {
			if (hasTrailingThinking(message)) previewComponent = component;
		}

		const thinkingKids: any[] = [];
		for (const [component, message] of round.messages) {
			if (component !== previewComponent) {
				component.contentContainer?.clear?.();
				continue;
			}
			passThroughAssistant(component, message);
			const kids = Array.isArray(component.contentContainer?.children)
				? [...component.contentContainer.children]
				: [];
			component.contentContainer?.clear?.();
			// Only take the thinking preview block into the slot; finished thinking is folded into the summary row.
			for (const kid of kids) {
				if (typeof kid?.setHintHovered === "function") thinkingKids.push(kid);
			}
		}
		// Body renders like the collapsed state (without thinking): live and finished have the same shape, on finish only the slot card disappears.
		renderAssistantWithoutThinking(round.anchor, round.messages.get(round.anchor));

		const toolsById = new Map<string, any>();
		for (const tool of trackedToolComponents) {
			if (typeof tool?.toolCallId === "string") toolsById.set(tool.toolCallId, tool);
		}
		let runningTool: any;
		let lastTool: any;
		for (const [, message] of round.messages) {
			for (const item of Array.isArray(message?.content) ? message.content : []) {
				if (item?.type !== "toolCall" || typeof item.id !== "string") continue;
				const tool = toolsById.get(item.id);
				// edit/write keep their own compact row and do not enter the slot.
				if (EDIT_WRITE_TOOLS.has(String(tool?.toolName ?? item.name ?? ""))) continue;
				round.liveSlotToolIds.add(item.id);
				liveSlotToolIds.add(item.id);
				if (!tool) continue;
				lastTool = tool;
				if (isRunningTool(tool)) runningTool = tool;
			}
		}
		// Single slot block: the latest active thinking; otherwise the round's most recent tool (grows in place while running, kept when finished).
		const slotTool = thinkingKids.length > 0 ? undefined : (runningTool ?? lastTool);
		const cardItems: Array<{ child?: any; tool?: any }> = slotTool
			? [{ tool: slotTool }]
			: thinkingKids.map((child) => ({ child }));

		const anchor = round.anchor;
		const pad = Number(anchor.outputPad) || 0;
		// The summary row and slot card hang on the round tail row (at the end of the round inside the transcript container, not inside the anchor):
		// while running it always sits at the writable viewport bottom edge, and the final Ran for lands in scrollback in place, leaving no
		// Running frame frozen after being pushed out of the viewport.
		mountRoundTail(round, (identity) => {
			const parts: any[] = [compactAssistantLineComponent(identity, getSummary, deps.query)];
			if (cardItems.length > 0) {
				parts.push(
					compactLiveSlot(
						compactRoundCard(
							cardItems,
							(tool, innerWidth) => patch.toolOriginalRender.call(tool, innerWidth),
							false,
							true,
						),
						pad,
					),
				);
			}
			return parts;
		});
		appendStopStatus(anchor, stopStatus);
	};

	const renderRound = (round: CompactRound): void => {
		const messages = roundMessages(round);
		const stopStatus = roundStopStatus(messages);
		if (stopStatus) endRound(round);
		// While Running, recompute the duration on each render (including the wall-clock floor); fixed after finishing.
		// During the quiet period the round has already finished, so the summary row shows Ran for directly, and only the slot card lingers one more beat.
		const getSummary = () => summarize(roundMessages(round), round.active, round);
		const summary = getSummary();
		for (const id of round.suppressedToolIds) expandedRoundToolIds.delete(id);
		round.suppressedToolIds.clear();
		// When the round collapses (or this round is not expanded), forget the user's single-open choice and collapse tools taken over by the panel as well:
		// without the latter step, an opened tool would fall into toolInstalledRender's pass-through branch with its own expanded state,
		// and once the panel collapses it would render as a standalone card.
		if (round.anchor.expanded !== true) {
			const ids = roundToolCallIds(round);
			for (const id of ids) explicitRoundToolIds.delete(id);
			collapseTools(
				(tool) =>
					ids.has(String(tool.toolCallId ?? "")) &&
					!EDIT_WRITE_TOOLS.has(String(tool.toolName ?? "")),
			);
		}
		for (const id of round.liveSlotToolIds) liveSlotToolIds.delete(id);
		round.liveSlotToolIds.clear();

		for (const [component, message] of round.messages) {
			component.lastMessage = message;
			ensureAssistantSetExpanded(component);
			component[ASSISTANT_TOGGLE_ROUND_KEY] = (expanded: boolean) => {
				const wasExpanded = round.anchor.expanded === true;
				if (expanded && !wasExpanded) capturePanelViewport(round.anchor);
				for (const member of round.messages.keys()) member.expanded = expanded;
				if (!expanded) {
					for (const id of round.suppressedToolIds) expandedRoundToolIds.delete(id);
					round.suppressedToolIds.clear();
				}
				renderRound(round);
				if (!expanded && wasExpanded) restorePanelViewport(round.anchor);
			};
		}

		if (round.anchor.expanded === true) {
			// Expanded content stays where the summary row is: after the round's last member (including write/edit).
			// Placing it inside the anchor would jump to the round start and cover the write/edit in between.
			// When the anchor is not mounted in the transcript there is no such position, so fall back to inside the anchor.
			const mounted = Boolean(tailContainerOf(round.anchor));
			const toolsById = new Map<string, any>();
			for (const tool of trackedToolComponents) {
				if (typeof tool?.toolCallId === "string") toolsById.set(tool.toolCallId, tool);
			}
			// Assistant text renders natively and is not put in the panel (the panel keeps only thinking and tool cards).
			// thinking/tool cards are each wrapped in a panel per contiguous run; emit text first, then panels,
			// otherwise a thinking inside the message content ([thinking, text, toolCall]) would cover the text.
			const anchorChildren: any[] = [];
			let cardItems: Array<{ child?: any; tool?: any }> = [];
			const flushPanel = () => {
				if (cardItems.length === 0) return;
				if (cardItems.every((item) => !item.tool && isSpacerComponent(item.child))) {
					for (const item of cardItems) anchorChildren.push(item.child);
				} else {
					// Leave 1 blank row outside the card above the panel: the panel background is the same color as userMessage,
					// and adjacent they would look like one block; add 1 row of padding at the top of the card to keep it symmetric.
					anchorChildren.push(new Spacer(1));
					anchorChildren.push(
						compactRoundCard(
							cardItems,
							(tool, innerWidth) => patch.toolOriginalRender.call(tool, innerWidth),
							// Whole-round expanded card: tool rows in the card belong to the tool component and can be clicked to expand again.
							true,
						),
					);
				}
				cardItems = [];
			};
			const takeChild = (child: any, outside: boolean) => {
				if (!outside) {
					cardItems.push({ child });
					return;
				}
				flushPanel();
				anchorChildren.push(child);
			};
			const placedToolIds = new Set<string>();
			const placeTool = (id: string, fallbackName?: string) => {
				const tool = toolsById.get(id);
				if (!tool || EDIT_WRITE_TOOLS.has(String(tool.toolName ?? fallbackName ?? ""))) return;
				if (placedToolIds.has(id)) return;
				placedToolIds.add(id);
				cardItems.push({ tool });
			};
			type LocalEntry = { outside: boolean; child?: any; toolId?: string; toolName?: string };
			for (const [component, message] of round.messages) {
				passThroughAssistant(component, message);
				const kids = Array.isArray(component.contentContainer?.children)
					? [...component.contentContainer.children]
					: [];
				component.contentContainer?.clear?.();
				const cursor = { i: 0 };
				let inThinkingRun = false;
				// Collect this message's output first and then emit: text (including its leading Spacer) is placed before the panels.
				const local: LocalEntry[] = [];
				const takeRun = (outside: boolean) => {
					while (cursor.i < kids.length && isSpacerComponent(kids[cursor.i])) {
						local.push({ outside, child: kids[cursor.i++] });
					}
					if (cursor.i < kids.length) local.push({ outside, child: kids[cursor.i++] });
				};
				for (const item of Array.isArray(message?.content) ? message.content : []) {
					if (item?.type === "thinking") {
						if (!String(item.thinking ?? "").trim()) continue;
						if (!inThinkingRun) {
							takeRun(false);
							inThinkingRun = true;
						}
						continue;
					}
					inThinkingRun = false;
					if (item?.type === "text" && String(item.text ?? "").trim()) {
						takeRun(true);
						continue;
					}
					if (item?.type === "toolCall" && typeof item.id === "string") {
						local.push({ outside: false, toolId: item.id, toolName: item.name });
					}
				}
				while (cursor.i < kids.length) local.push({ outside: false, child: kids[cursor.i++] });
				for (const entry of local) if (entry.outside) takeChild(entry.child, true);
				for (const entry of local) {
					if (entry.outside) continue;
					if (entry.toolId) placeTool(entry.toolId, entry.toolName);
					else takeChild(entry.child, false);
				}
			}
			for (const message of round.detachedMessages) {
				for (const item of Array.isArray(message?.content) ? message.content : []) {
					if (item?.type === "toolCall" && typeof item.id === "string") {
						placeTool(item.id, item.name);
					}
				}
			}
			const ids = roundToolCallIds(round);
			for (const id of ids) {
				round.suppressedToolIds.add(id);
				expandedRoundToolIds.add(id);
				if (!placedToolIds.has(id)) placeTool(id);
			}
			// Round expansion opens only the outer card. Normal tools stay collapsed, so long output does not recursively fill the screen;
			// ones the user opened individually (explicitRoundToolIds) are not pushed back.
			collapseTools(
				(tool) =>
					ids.has(String(tool.toolCallId ?? "")) &&
					!EDIT_WRITE_TOOLS.has(String(tool.toolName ?? "")) &&
					!explicitRoundToolIds.has(String(tool.toolCallId ?? "")),
			);
			flushPanel();
			if (mounted) {
				// Body stays on its own assistant message, and the panel hangs back at the summary row's original position.
				const outside: any[] = [];
				const panel: any[] = [];
				for (const child of anchorChildren) {
					(typeof child?.childAtRow === "function" ? panel : outside).push(child);
				}
				for (const child of outside) round.anchor.contentContainer.addChild(child);
				if (panel.length > 0) mountRoundTail(round, () => panel);
				else unmountRoundTail(round);
			} else {
				unmountRoundTail(round);
				for (const child of anchorChildren) round.anchor.contentContainer.addChild(child);
			}
			// Tools inside the expanded card will show error, while the outer layer still hangs abort/length, so it is not hidden only in collapsed tools.
			appendStopStatus(round.anchor, stopStatus);
			return;
		}

		if (roundLive(round)) {
			// Spectator state: a single slot card (active thinking preview + current tool), automatically retracted when the round ends.
			renderRoundLive(round, stopStatus, getSummary);
			return;
		}

		for (const [component, message] of round.messages) {
			if (component === round.anchor) {
				renderAssistantWithoutThinking(component, message);
				// Empty summary hangs no row (the getter may also be briefly empty at the instant Running starts)
				if (summary || round.active) {
					mountRoundTail(round, (identity) => [
						compactAssistantLineComponent(identity, getSummary, deps.query),
					]);
				} else {
					unmountRoundTail(round);
				}
				// Tool rows are hidden when collapsed: abort/error/length must hang outside the summary.
				appendStopStatus(component, stopStatus);
			} else {
				component.contentContainer?.clear?.();
			}
		}
	};

	const activateRound = (round: CompactRound): void => {
		flushSettle();
		round.active = true;
		if (!round.startedAt) round.startedAt = Date.now();
		delete round.endedAt;
		activeRound = round;
		deps.query?.setCompactSummaryActive?.(true);
		ensureRoundTick();
	};

	const finishRound = (round: CompactRound): void => endRound(round, true);

	const resetRounds = (): void => {
		for (const round of [...pendingFoldRounds]) clearFoldTimer(round);
		activeRound = undefined;
		roundByComponent = new WeakMap();
		expandedRoundToolIds.clear();
		explicitRoundToolIds.clear();
		liveSlotToolIds.clear();
		// The tail row is a transcript sibling component: in compact it stays as a static row (consistent with the original in-anchor summary;
		// when a round is rebuilt on the same anchor ensureTailHost deduplicates and removes it); outside compact it is removed,
		// so the compact summary is not carried into default rendering.
		for (const tail of [...mountedTails]) {
			const container = tailHostContainer(tail);
			if (!container) {
				mountedTails.delete(tail);
				continue;
			}
			tail.container = container;
			if (config.mode === "compact") continue;
			container.removeChild(tail.host);
			mountedTails.delete(tail);
			if (tail.round?.tail === tail) tail.round.tail = undefined;
			if (tail.round?.anchor && tailByAnchor.get(tail.round.anchor) === tail) {
				tailByAnchor.delete(tail.round.anchor);
			}
		}
		deps.query?.setCompactSummaryActive?.(false);
		stopRoundTick();
	};

	/**
	 * Fallback: resetRounds drops the round index but keeps the mounted tail row, and a round that replay failed to reconnect would stay
	 * active forever - the tail row shows Running... forever (duration still growing) yet no longer counts new tools. An active round that is neither the active
	 * round nor in the quiet period is finished in place, so it does not hang on screen forever.
	 */
	const settleStrandedRounds = (): void => {
		for (const tail of [...mountedTails]) {
			const round = tail.round as CompactRound | undefined;
			if (!round?.active || round === activeRound || pendingFoldRounds.has(round)) continue;
			endRound(round, true);
		}
	};

	patch.assistantInstalled = function (this: any, message: any, isStreaming?: boolean) {
		const self = this as any;
		// Same as compact-thinking: losing isStreaming makes mermaid streaming render flicker back and forth.
		if (isStreaming !== undefined) self.isStreaming = isStreaming;
		if (self[ASSISTANT_REENTRY_KEY] === patch) {
			return patch.assistantNative.call(this, message, isStreaming);
		}
		self.lastMessage = message;
		trackedAssistantComponents.add(this);
		if (!patch.active || config.mode !== "compact") {
			return passThroughAssistant(this, message, isStreaming);
		}
		if (!self.contentContainer || typeof self.contentContainer.clear !== "function") {
			return passThroughAssistant(this, message, isStreaming);
		}

		const content = Array.isArray(message?.content) ? message.content : [];
		const hasToolCalls = content.some((item: any) => item?.type === "toolCall");
		const hasText = content.some(
			(item: any) => item?.type === "text" && typeof item.text === "string" && item.text.trim(),
		);
		self.hasToolCalls = hasToolCalls;

		if (hasToolCalls) {
			let round = roundByComponent.get(this);
			if (hasText && (!round || round.anchor !== this)) {
				if (round) round.messages.delete(this);
				if (activeRound) finishRound(activeRound);
				round = createRound(this, message);
				roundByComponent.set(this, round);
			} else if (!round) {
				round = activeRound ?? createRound(this, message);
				roundByComponent.set(this, round);
			}
			round.messages.set(this, message);
			renderRound(round);
			return undefined;
		}

		if (hasText) {
			const round = roundByComponent.get(this);
			const previousMessage = round?.messages.get(this);
			if (round && previousMessage && (round.anchor !== this || round.messages.size > 1)) {
				// After the final answer starts, the current component restores native text; its finished thinking
				// stays in the previous round's summary, avoiding a new standalone Thought row.
				round.messages.delete(this);
				round.detachedMessages.push(previousMessage);
				roundByComponent.delete(this);
				finishRound(round);
				return renderAssistantWithoutThinking(this, message);
			}
			if (round) {
				// In spectator state the anchor still holds the slot card, so it must be repainted to retract it.
				endRound(round, true);
				roundByComponent.delete(this);
				return passThroughAssistant(this, message);
			}
			if (activeRound) finishRound(activeRound);
			return renderAssistantWithoutThinking(this, message);
		}

		const hasThinking = content.some((item: any) => item?.type === "thinking");
		if (hasThinking) {
			let round = roundByComponent.get(this);
			if (!round) {
				round = activeRound ?? createRound(this, message);
				roundByComponent.set(this, round);
			}
			round.messages.set(this, message);
			renderRound(round);
			return undefined;
		}

		// abort/error/length with no visible content: use the outer status row directly and end the round in progress.
		const loneStatus = messageStopStatus(message);
		if (loneStatus) {
			if (activeRound) finishRound(activeRound);
			self.contentContainer.clear();
			appendStopStatus(this, loneStatus);
			return undefined;
		}

		self.contentContainer.clear();
		return undefined;
	};

	patch.toolInstalledRender = function (this: any, width: number) {
		if (!patch.active || config.mode !== "compact") {
			return patch.toolOriginalRender.call(this, width);
		}
		const name = String(this.toolName ?? "");
		if (EDIT_WRITE_TOOLS.has(name)) {
			if (this.executionStarted && (!this.result || this.isPartial === true))
				scheduleAnimation(this);
			return compactEditWriteLines(this, width, deps.writeMetadata);
		}
		// Agent/Task etc. are the same as normal tools: not externalized when collapsed (the live panel uses an independent widget).
		if (expandedRoundToolIds.has(String(this.toolCallId ?? ""))) return [];
		// live spectator state: this round's tools are rendered inline by the slot card and the outer layer makes no standalone rows,
		// so the card is not repeatedly mounted/unmounted as tools finish.
		if (liveSlotToolIds.has(String(this.toolCallId ?? ""))) return [];
		// Normal tools show no standalone row when collapsed (the summary row already counts them); standalone expansion uses the original renderer.
		if (this.expanded === true) {
			return patch.toolOriginalRender.call(this, width);
		}
		return [];
	};

	patch.toolInstalledUpdateDisplay = function (this: any) {
		const id = String(this.toolCallId ?? "");
		if (patch.active && config.mode === "compact" && expandedRoundToolIds.has(id)) {
			// Ones the user opened stay expanded; the rest (including those pulled back from global expand) keep being force-collapsed.
			if (this.expanded !== true) explicitRoundToolIds.delete(id);
			else if (!explicitRoundToolIds.has(id)) this.expanded = false;
		}
		const result = patch.toolOriginalUpdateDisplay.call(this);
		if (!patch.active) return result;
		trackedToolComponents.add(this);
		if (config.mode === "compact") syncTailForTool(id);
		return result;
	};

	patch.assertAssistantOwnership = () => {
		// compact must be outermost: claim from the compact-thinking wrapper, or when taking back mode=on/off
		// actively release ownership to original/native. Unknown external wrappers are not taken over, to avoid recursion.
		if (!patch.active || assistantPrototype.updateContent === patch.assistantInstalled) return;
		const current = assistantPrototype.updateContent;
		if ((current as any)[COMPACT_THINKING_PATCH_KEY] === true) {
			patch.assistantOriginal = current;
			assistantPrototype.updateContent = patch.assistantInstalled;
			return;
		}
		if (current === patch.assistantOriginal || current === patch.assistantNative) {
			assistantPrototype.updateContent = patch.assistantInstalled;
		}
	};

	(patch.assistantInstalled as any)[PROTOTYPE_ORIGINAL_KEY] = patch.assistantNative;

	patch.dispose = () => {
		if (!patch.active) return;
		patch.active = false;
		if (roundToolExpansion?.markUserExpanded === markRoundToolUserExpanded) {
			roundToolExpansion = undefined;
		}
		if (assistantPrototype.updateContent === patch.assistantInstalled) {
			assistantPrototype.updateContent = patch.assistantOriginal;
		}
		if (toolPrototype.render === patch.toolInstalledRender) {
			toolPrototype.render = patch.toolOriginalRender;
		}
		if (toolPrototype.updateDisplay === patch.toolInstalledUpdateDisplay) {
			toolPrototype.updateDisplay = patch.toolOriginalUpdateDisplay;
		}
		patchRegistry.dispose(COMPACT_MODE_PATCH_KEY, patch);
		for (const component of trackedAssistantComponents) detachAssistantExpansion(component);
		trackedAssistantComponents.clear();
		trackedToolComponents.clear();
		hoveredAssistantComponent = undefined;
		resetRounds();
		compactRunStatusGetter = undefined;
	};

	assistantPrototype.updateContent = patch.assistantInstalled;
	toolPrototype.render = patch.toolInstalledRender;
	toolPrototype.updateDisplay = patch.toolInstalledUpdateDisplay;
	patchRegistry.install(COMPACT_MODE_PATCH_KEY, patch);

	const syncGlobalExpanded = (ctx: any): void => {
		let globalExpanded = false;
		try {
			globalExpanded = ctx?.ui?.getToolsExpanded?.() === true;
		} catch {
			// Stay collapsed in tests or without a UI context.
		}
		for (const component of trackedAssistantComponents) component.expanded = globalExpanded;
		for (const component of trackedToolComponents) component.expanded = globalExpanded;
	};

	return {
		sync(ctx: any) {
			if (!patch.active) return;
			uiRef = ctx?.ui;
			resetRounds();
			// Always keep the patch on the chain: mode=on/off goes through passThrough, still writing lastMessage
			// and the tracked set, so /ccstyle switching back to compact does not need /reload.
			patch.assertAssistantOwnership();
			if (config.mode === "compact") syncGlobalExpanded(ctx);
			else hoveredAssistantComponent = undefined;
			refreshTrackedComponents();
		},
		refresh() {
			if (!patch.active) return;
			resetRounds();
			patch.assertAssistantOwnership();
			if (config.mode !== "compact") hoveredAssistantComponent = undefined;
			refreshTrackedComponents();
		},
		assertOwnership() {
			if (!patch.active) return;
			patch.assertAssistantOwnership();
		},
		refreshToolCallMessage(toolCallId: string | undefined) {
			if (!patch.active || typeof toolCallId !== "string" || !toolCallId) return;
			for (const component of [...trackedAssistantComponents]) {
				const message = component.lastMessage;
				const contains =
					Array.isArray(message?.content) &&
					message.content.some((item: any) => item?.type === "toolCall" && item.id === toolCallId);
				if (!contains) continue;
				try {
					component.updateContent?.(message);
				} catch {
					trackedAssistantComponents.delete(component);
				}
			}
		},
		shutdown() {
			patch.dispose();
		},
	};
}

function refreshTrackedComponents(): void {
	for (const component of [...trackedAssistantComponents]) {
		try {
			if (config.mode !== "compact") detachAssistantExpansion(component);
			refreshTranscriptComponent(component);
		} catch {
			trackedAssistantComponents.delete(component);
		}
	}
	for (const component of [...trackedToolComponents]) {
		try {
			// The shared implementation handles updateDisplay; invalidate belongs to compact-mode's tracking semantics.
			refreshTranscriptComponent(component);
			component.invalidate?.();
		} catch {
			trackedToolComponents.delete(component);
		}
	}
}

/** Collects components rebuilt by /reload after session events, for renderer/index.ts. */
export function refreshCompactModeComponents(root: any): void {
	collectMountedComponents(root);
}
