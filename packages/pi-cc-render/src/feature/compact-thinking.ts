// Local inline implementation of compact-thinking. Forked from pi-compact-thinking (MIT,
// https://github.com/tifandotme/pi-extensions/tree/master/packages/pi-compact-thinking).
// Differences:
// 1. No longer depends on the upstream package: config is decoupled and controlled by claude-code-style via installCompactThinking
//    /updateConfig (module-level config object; no longer reads/writes compact-thinking.json).
// 2. Merges the upstream fork patch: keeps the thinking animation during subagent tool (Agent/Agents) execution,
//    until tool_execution_end or the next text/thinking boundary.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Box, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
// The expanded card background is a ccstyle rendering convention, not part of upstream CompactThinkingConfig, so read the global config directly.
import { config as styleConfig } from "../config/config.ts";
import { isToolTuiFullscreen } from "../renderer/tool/show-more-hint.ts";
import {
	animateCompactThinkingText,
	formatThoughtDuration,
	styleCompactThinkingText,
} from "../renderer/compact-mode.ts";
import { refreshMountedTranscript } from "../renderer/transcript-refresh.ts";
import {
	ASSISTANT_TOOLS_EXPANDED_KEY,
	COMPACT_THINKING_OWNER,
	COMPACT_THINKING_PATCH_KEY,
	patchRegistry,
	PROTOTYPE_ORIGINAL_KEY,
} from "../utils/patch-keys.ts";
// The re-export of TUI in pi-tui type declarations fails to resolve, so use a minimal local structural type (only requestRender is used).
type RenderTui = { requestRender(force?: boolean): void };

// In pi-coding-agent type declarations, AssistantMessageComponent can only be used as a value.
type AssistantMessageComponentLike = InstanceType<typeof AssistantMessageComponent>;

export type CompactThinkingConfig = {
	useSummaryTitlesAsThinkingTitle: boolean;
	previewLines: number;
	animationIntervalMs: number;
};

export type CompactThinkingController = {
	updateConfig(next: CompactThinkingConfig): void;
	/**
	 * Read-only query: total visible thinking duration (ms) of an assistant message.
	 * Lets the compact rendering layer build the `Thought for 8s` summary without a second timer.
	 * Returns undefined when there is no record and no thinking in progress.
	 */
	getMessageThinkingDurationMs?(messageTimestamp: number): number | undefined;
	/** Whether the current message is still in compact-thinking's active thinking state. */
	isMessageThinkingActive?(messageTimestamp: number): boolean;
	/** Reuse the animation frame from compact-thinking's config instead of a separate animation timer. */
	getThinkingAnimationFrame?(): number;
	/** Reuse compact-thinking's animation loop while the compact summary stays loading. */
	setCompactSummaryActive?(active: boolean): void;
};

type DurationEntryData = {
	messageTimestamp: number;
	contentIndex: number;
	durationMs: number;
};

type SummaryPart = {
	title: string;
	body: string;
};

type ActiveThinking = {
	messageTimestamp: number;
	contentIndex: number;
	startedAt: number;
};

// The re-export of MarkdownTransformer in pi-coding-agent type declarations fails to resolve, so use a minimal local structural type.
type MarkdownTransformer = (
	markdown: string,
	context: {
		messageType: "user" | "assistant" | "assistant-thinking";
		isStreaming: boolean;
		availableWidth: number;
	},
) => string;

type AssistantInternals = {
	contentContainer: {
		clear(): void;
		addChild(component: Component): void;
	};
	hideThinkingBlock: boolean;
	markdownTheme: ConstructorParameters<typeof Markdown>[3];
	hiddenThinkingLabel: string;
	outputPad: number;
	isStreaming: boolean;
	markdownTransformers: readonly MarkdownTransformer[];
	lastMessage?: AssistantMessage;
	hasToolCalls: boolean;
	updateContent(message: AssistantMessage): void;
};

type PatchedPrototype = typeof AssistantMessageComponent.prototype & {
	updateContent: (message: AssistantMessage, isStreaming?: boolean) => void;
	setExpanded?: (expanded: boolean) => void;
};

// Config is controlled by claude-code-style (installCompactThinking injects initial values,
// updateConfig updates at runtime); upstream config file reads/writes are removed.
const config: CompactThinkingConfig = {
	useSummaryTitlesAsThinkingTitle: true,
	previewLines: 3,
	animationIntervalMs: 90,
};

const DURATION_ENTRY_TYPE = "compact-thinking-duration";

/** Read-only query delegate for the currently active session (used by the compact rendering layer). */
type ThinkingDurationQuery = (messageTimestamp: number) => number | undefined;
type ThinkingActiveQuery = (messageTimestamp: number) => boolean;
let activeThinkingQuery: ThinkingDurationQuery | undefined;
let activeThinkingStateQuery: ThinkingActiveQuery | undefined;
let activeThinkingAnimationFrameQuery: (() => number) | undefined;
let activeCompactSummarySetter: ((active: boolean) => void) | undefined;

function restoreDurationEntries(
	entries: Array<{ type: string; customType?: string; data?: unknown }>,
	completedDurations: Map<number, Map<number, number>>,
) {
	completedDurations.clear();
	for (const entry of entries) {
		if (
			entry.type !== "custom" ||
			entry.customType !== DURATION_ENTRY_TYPE ||
			!entry.data ||
			typeof entry.data !== "object"
		) {
			continue;
		}

		const data = entry.data as Partial<DurationEntryData>;
		if (
			typeof data.messageTimestamp !== "number" ||
			!Number.isFinite(data.messageTimestamp) ||
			typeof data.contentIndex !== "number" ||
			!Number.isInteger(data.contentIndex) ||
			typeof data.durationMs !== "number" ||
			!Number.isFinite(data.durationMs) ||
			data.durationMs < 1
		) {
			continue;
		}

		let durations = completedDurations.get(data.messageTimestamp);
		if (!durations) {
			durations = new Map();
			completedDurations.set(data.messageTimestamp, durations);
		}
		durations.set(data.contentIndex, data.durationMs);
	}
}

// Collapsed thinking expands with the transcript's expand key (app.tools.expand, Ctrl+O), as in Claude Code.
function getThinkingToggleHint() {
	const keys = getKeybindings().getKeys("app.tools.expand");
	return keys.length > 0 ? `${keys.join("/")} to expand` : undefined;
}

function thinkingExpandAction(): string | undefined {
	return isToolTuiFullscreen() ? "click to show more" : getThinkingToggleHint();
}

// Wrap only the tail window; cache uncolored wrapped lines and color them on retrieval, so theme switches don't hit stale ANSI.
type PreviewCacheEntry = { lines: string[]; hiddenBefore: number };
const previewCache = new Map<string, PreviewCacheEntry>();
export const THINKING_PREVIEW_CACHE_MAX = 2_048;
const PREVIEW_BUDGET_MIN_CHARS = 2_000;
const PREVIEW_BUDGET_SLACK_LINES = 2;

function getCachedPreview(key: string): PreviewCacheEntry | undefined {
	const entry = previewCache.get(key);
	if (!entry) return undefined;
	previewCache.delete(key);
	previewCache.set(key, entry);
	return entry;
}

function cachePreview(key: string, entry: PreviewCacheEntry): void {
	previewCache.delete(key);
	while (previewCache.size >= THINKING_PREVIEW_CACHE_MAX) {
		const oldest = previewCache.keys().next().value;
		if (oldest === undefined) break;
		previewCache.delete(oldest);
	}
	previewCache.set(key, entry);
}

export function clearThinkingPreviewCache(): void {
	previewCache.clear();
	expandedWrapCache.clear();
}

type ExpandedWrapEntry = { text: string; lines: string[] };
const expandedWrapCache = new Map<string, ExpandedWrapEntry>();
export const THINKING_EXPANDED_WRAP_CACHE_MAX = 64;

function expandedWrapKey(messageTimestamp: number, runStartIndex: number, width: number): string {
	return `${messageTimestamp}:${runStartIndex}:${width}`;
}

function wrapExpandedThinking(
	messageTimestamp: number,
	runStartIndex: number,
	text: string,
	width: number,
): string[] {
	const key = expandedWrapKey(messageTimestamp, runStartIndex, width);
	const hit = expandedWrapCache.get(key);
	if (hit && hit.text === text) {
		expandedWrapCache.delete(key);
		expandedWrapCache.set(key, hit);
		return hit.lines;
	}
	const lines = wrapTextWithAnsi(text.replace(/\t/g, "   "), Math.max(1, width));
	expandedWrapCache.delete(key);
	while (expandedWrapCache.size >= THINKING_EXPANDED_WRAP_CACHE_MAX) {
		const oldest = expandedWrapCache.keys().next().value;
		if (oldest === undefined) break;
		expandedWrapCache.delete(oldest);
	}
	expandedWrapCache.set(key, { text, lines });
	return lines;
}

function evictExpandedWraps(messageTimestamp: number, runStartIndex: number): void {
	for (const key of expandedWrapCache.keys()) {
		const [ts, run] = key.split(":");
		if (Number(ts) === messageTimestamp && Number(run) === runStartIndex) {
			expandedWrapCache.delete(key);
		}
	}
}

export function thinkingPreviewCacheSize(): number {
	return previewCache.size;
}

export function thinkingExpandedWrapCacheSize(): number {
	return expandedWrapCache.size;
}

/** Estimate wrapped line count by visible width without a full Text wrap. Counts hidden lines even for long segments without newlines. */
function countWrappedLines(text: string, contentWidth: number): number {
	if (!text) return 0;
	const width = Math.max(1, contentWidth);
	let lines = 0;
	for (const raw of text.replace(/\t/g, "   ").split(/\r\n|\r|\n/)) {
		const w = visibleWidth(raw);
		lines += w === 0 ? 1 : Math.ceil(w / width);
	}
	return lines;
}

function padPreviewLine(line: string, width: number, padding: number): string {
	const left = padding > 0 ? " ".repeat(padding) : "";
	const right = padding > 0 ? " ".repeat(padding) : "";
	const withMargins = left + line + right;
	return withMargins + " ".repeat(Math.max(0, width - visibleWidth(withMargins)));
}

function layoutThinkingPreview(
	text: string,
	width: number,
	padding: number,
): { visible: string[]; hiddenLines: number } {
	if (!text || config.previewLines <= 0) return { visible: [], hiddenLines: 0 };
	const contentWidth = Math.max(1, width - padding * 2);
	const budget = Math.max(
		width * (config.previewLines + PREVIEW_BUDGET_SLACK_LINES),
		PREVIEW_BUDGET_MIN_CHARS,
	);
	let source = text;
	let cut = 0;
	if (source.length > budget) {
		const start = source.length - budget;
		const newline = source.indexOf("\n", start);
		cut = newline === -1 ? start : newline + 1;
		if (cut < source.length) source = source.slice(cut);
		else cut = 0;
	}
	const cacheKey = `${width}:${padding}:${cut}:${source}`;
	let entry = getCachedPreview(cacheKey);
	if (!entry) {
		entry = {
			lines: wrapTextWithAnsi(source.replace(/\t/g, "   "), contentWidth),
			hiddenBefore: cut > 0 ? countWrappedLines(text.slice(0, cut), contentWidth) : 0,
		};
		cachePreview(cacheKey, entry);
	}
	const hiddenLines = entry.hiddenBefore + Math.max(0, entry.lines.length - config.previewLines);
	const visible = hiddenLines > 0 ? entry.lines.slice(-config.previewLines) : entry.lines;
	return { visible, hiddenLines };
}

function hiddenPreviewHint(
	hiddenLines: number,
	forceExpandHint = false,
): { prefix: string; action: string; suffix: string } | undefined {
	const action = thinkingExpandAction() ?? "";
	if (hiddenLines > 0) {
		const noun = hiddenLines === 1 ? "line" : "lines";
		// Same style as other hints: joined with a small dot, no commas or parentheses
		return {
			prefix: ` · ${hiddenLines} more ${noun}${action ? " · " : ""}`,
			action,
			suffix: "",
		};
	}
	if (forceExpandHint && isToolTuiFullscreen()) {
		return { prefix: " · ", action: "click to show more", suffix: "" };
	}
	return undefined;
}

const expandedThinking = new Set<number>();

/** Collapsed preview + expanded full text. In fullscreen, clicking the hint expands; a single click on the expanded card collapses it (not while drag-selecting text). */
export class ThinkingPreviewBlock implements Component {
	private heading: string;
	private text: string;
	private padding: number;
	readonly messageTimestamp: number;
	readonly runStartIndex: number;
	private style: (text: string) => string;
	private theme: Theme | undefined;
	private _expanded: boolean;
	/** Expanded by the host's Ctrl+O (app.tools.expand) state rather than a click on this block. */
	private forced = false;
	private hintHovered = false;
	private collapsedMemo:
		| {
				width: number;
				previewLines: number;
				hintHovered: boolean;
				expandAction: string | undefined;
				lines: string[];
		  }
		| undefined;

	constructor(
		heading: string,
		text: string,
		padding: number,
		messageTimestamp: number,
		style: (text: string) => string,
		theme?: Theme,
		runStartIndex = 0,
	) {
		this.heading = heading;
		this.text = text;
		this.padding = padding;
		this.messageTimestamp = messageTimestamp;
		this.runStartIndex = runStartIndex;
		this.style = style;
		this.theme = theme;
		this._expanded = expandedThinking.has(messageTimestamp);
	}

	private paint(color: string, text: string): string {
		return this.theme && typeof this.theme.fg === "function"
			? this.theme.fg(color as never, text)
			: text;
	}

	get expanded(): boolean {
		return this._expanded || this.forced;
	}

	/** Follow the host's Ctrl+O state; a click (setExpanded) still collapses this block on its own. */
	setForcedExpanded(forced: boolean): void {
		if (this.forced !== forced) this.collapsedMemo = undefined;
		this.forced = forced;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded !== expanded) this.collapsedMemo = undefined;
		this.forced = false;
		this._expanded = expanded;
		if (expanded) expandedThinking.add(this.messageTimestamp);
		else {
			expandedThinking.delete(this.messageTimestamp);
			evictExpandedWraps(this.messageTimestamp, this.runStartIndex);
		}
	}

	setHintHovered(hovered: boolean): void {
		if (this.hintHovered !== hovered) this.collapsedMemo = undefined;
		this.hintHovered = hovered;
	}

	private headingLines(width: number, hiddenLines: number, padding: number): string[] {
		const hint = this.expanded
			? undefined
			: hiddenPreviewHint(hiddenLines, Boolean(this.text) && config.previewLines <= 0);
		if (!hint) return new Text(this.heading, padding, 0).render(width);
		const rawHint = hint.prefix + hint.action + hint.suffix;
		const contentWidth = Math.max(1, width - padding * 2);
		const headingBudget = Math.max(0, contentWidth - visibleWidth(rawHint));
		const clipped =
			visibleWidth(this.heading) > headingBudget
				? truncateToWidth(this.heading, headingBudget, "")
				: this.heading;
		const action = this.paint(this.hintHovered ? "text" : "dim", hint.action);
		return new Text(
			clipped + this.paint("dim", hint.prefix) + action + this.paint("dim", hint.suffix),
			padding,
			0,
		).render(width);
	}

	private bodyLines(width: number, padding: number): { lines: string[]; hiddenLines: number } {
		if (!this.text || (config.previewLines <= 0 && !this.expanded)) {
			return { lines: [], hiddenLines: 0 };
		}
		if (this.expanded) {
			return {
				lines: wrapExpandedThinking(this.messageTimestamp, this.runStartIndex, this.text, width),
				hiddenLines: 0,
			};
		}
		const preview = layoutThinkingPreview(this.text, width, padding);
		return { lines: preview.visible, hiddenLines: preview.hiddenLines };
	}

	render(width: number) {
		if (this.expanded) {
			const innerWidth = Math.max(1, width - 2);
			const body = this.bodyLines(innerWidth, 0);
			const heading = this.headingLines(innerWidth, 0, 0);
			const inner = body.lines.length
				? [...heading, ...body.lines.map((line) => this.style(line))]
				: heading;
			const bgFn =
				this.theme && typeof this.theme.bg === "function"
					? (text: string) => this.theme!.bg(styleConfig.expandedCardBackground, text)
					: undefined;
			const box = new Box(1, 1, bgFn);
			box.addChild({
				render: () => inner,
				invalidate() {},
			});
			return box.render(width);
		}

		const expandAction = thinkingExpandAction();
		if (
			this.collapsedMemo?.width === width &&
			this.collapsedMemo.previewLines === config.previewLines &&
			this.collapsedMemo.hintHovered === this.hintHovered &&
			this.collapsedMemo.expandAction === expandAction
		) {
			return this.collapsedMemo.lines;
		}

		const body = this.bodyLines(width, this.padding);
		const heading = this.headingLines(width, body.hiddenLines, this.padding);
		const lines = body.lines.length
			? [
					...heading,
					...body.lines.map((line) => padPreviewLine(this.style(line), width, this.padding)),
				]
			: heading;
		this.collapsedMemo = {
			width,
			previewLines: config.previewLines,
			hintHovered: this.hintHovered,
			expandAction,
			lines,
		};
		return lines;
	}

	invalidate() {
		this.collapsedMemo = undefined;
	}
}

function parseSummaryPart(text: string): SummaryPart | undefined {
	const match = /^\s*\*\*([^\n]+?)\*\*[ \t]*(?:\r?\n(?:\r?\n)?([\s\S]*))?\s*$/.exec(text);
	if (!match) return undefined;
	return { title: match[1].trim(), body: (match[2] ?? "").trim() };
}

function parseLatestStreamingSummary(text: string): SummaryPart | undefined {
	// Providers do not consistently insert a blank line between streamed
	// summary parts, so accept a bold title at the start of any source line.
	const titlePattern = /(?:^|\r?\n)\s*\*\*([^\n*]+?)\*\*[ \t]*(?:\r?\n)?/g;
	let latest: RegExpExecArray | undefined;
	let match: RegExpExecArray | null;
	while ((match = titlePattern.exec(text))) latest = match;
	if (!latest) return parseSummaryPart(text);

	return {
		title: latest[1].trim(),
		body: text.slice(latest.index + latest[0].length).trim(),
	};
}

function isOpenAiResponsesMessage(message: AssistantMessage) {
	return (
		message.api === "openai-responses" ||
		message.api === "openai-codex-responses" ||
		message.api === "azure-openai-responses"
	);
}

function getLatestOpenAiSummary(thinkingSignature: string | undefined): SummaryPart | undefined {
	if (!thinkingSignature) return undefined;

	try {
		const item = JSON.parse(thinkingSignature) as {
			type?: unknown;
			summary?: Array<{ type?: unknown; text?: unknown }>;
		};
		if (item.type !== "reasoning" || !Array.isArray(item.summary)) {
			return undefined;
		}

		for (let i = item.summary.length - 1; i >= 0; i--) {
			const part = item.summary[i];
			if (part.type !== "summary_text" || typeof part.text !== "string") {
				continue;
			}
			const parsed = parseSummaryPart(part.text);
			if (parsed) return parsed;
		}
	} catch {
		// Invalid or provider-specific signatures use the generic fallback.
	}
	return undefined;
}

const WIDGET_ID = "compact-thinking-render-loop";

// Inlined from upstream index.ts (including the subagent fork patch).
function createTransform(
	messageType: "assistant" | "assistant-thinking",
	self: AssistantInternals,
) {
	// Same chaining semantics as pi's built-in applyMarkdownTransformers:
	// on exception, keep the current markdown and continue with the next transformer.
	return (markdown: string, availableWidth: number): string => {
		let out = markdown;
		for (const transformer of self.markdownTransformers ?? []) {
			try {
				const result = transformer(out, {
					messageType,
					isStreaming: self.isStreaming,
					availableWidth,
				});
				if (typeof result === "string") out = result;
			} catch {
				// Keep the current markdown and continue
			}
		}
		return out;
	};
}

function compactThinking(pi: ExtensionAPI) {
	const prototype = AssistantMessageComponent.prototype as PatchedPrototype;
	const originalUpdateContent = prototype.updateContent;

	activeThinkingStateQuery = (messageTimestamp) =>
		activeThinking?.messageTimestamp === messageTimestamp;
	activeThinkingAnimationFrameQuery = () => animationFrame;
	activeThinkingQuery = (messageTimestamp) => {
		let total = 0;
		const durations = completedDurations.get(messageTimestamp);
		if (durations) {
			for (const duration of durations.values()) total += duration;
		}
		if (activeThinking?.messageTimestamp === messageTimestamp) {
			total += Math.max(1, Date.now() - activeThinking.startedAt);
		}
		return total > 0 ? total : undefined;
	};

	const completedDurations = new Map<number, Map<number, number>>();
	const streamingComponents = new Set<AssistantMessageComponentLike>();
	let activeThinking: ActiveThinking | undefined;
	let activeTheme: Theme | undefined;
	let activeTui: RenderTui | undefined;
	let latestComponent: AssistantMessageComponentLike | undefined;
	let latestComponentTimestamp: number | undefined;
	let animationTimer: ReturnType<typeof setInterval> | undefined;
	let animationFrame = 0;
	let compactSummaryActive = false;
	let patchInstalled = true;
	// Main's Ctrl+O state, for components Pi has not called setExpanded on yet (new messages, rebuilds).
	let mainToolsExpanded: () => boolean = () => false;

	function toolsExpanded(self: AssistantInternals): boolean {
		const own = (self as unknown as Record<symbol, unknown>)[ASSISTANT_TOOLS_EXPANDED_KEY];
		return typeof own === "boolean" ? own : mainToolsExpanded();
	}

	// Ctrl+O (app.tools.expand) expands collapsed thinking too, as Claude Code's transcript toggle does.
	// Pi calls setExpanded on every expandable chat child, and hosts such as pi-sidebar call it on
	// their own chat's children, so assistant messages become expandable here. Compact mode installs
	// its own per-instance setExpanded over this one.
	const ownedSetExpanded = !Object.hasOwn(prototype, "setExpanded");
	const installedSetExpanded = function (this: AssistantInternals, expanded: boolean) {
		const self = this as unknown as Record<symbol, unknown>;
		if (self[ASSISTANT_TOOLS_EXPANDED_KEY] === expanded) return;
		self[ASSISTANT_TOOLS_EXPANDED_KEY] = expanded;
		if (this.hideThinkingBlock && this.lastMessage) this.updateContent(this.lastMessage);
	};
	if (ownedSetExpanded) prototype.setExpanded = installedSetExpanded;

	function thinkingStyle(text: string) {
		return styleCompactThinkingText(text, activeTheme);
	}

	function summaryTitleStyle(text: string) {
		return styleCompactThinkingText(text, activeTheme, true);
	}

	function animatedText(text: string, baseStyle: (value: string) => string, animate: boolean) {
		if (!animate) return baseStyle(text);
		return animateCompactThinkingText(
			text,
			activeTheme,
			animationFrame,
			baseStyle === summaryTitleStyle,
		);
	}

	function getCompletedDuration(messageTimestamp: number, startIndex: number, endIndex: number) {
		const durations = completedDurations.get(messageTimestamp);
		if (!durations) return undefined;
		for (let index = endIndex; index >= startIndex; index--) {
			const duration = durations.get(index);
			if (duration !== undefined) return duration;
		}
		return undefined;
	}

	function isActiveRun(message: AssistantMessage, startIndex: number, endIndex: number) {
		return (
			activeThinking?.messageTimestamp === message.timestamp &&
			activeThinking.contentIndex >= startIndex &&
			activeThinking.contentIndex <= endIndex
		);
	}

	prototype.updateContent = function patchedUpdateContent(
		message: AssistantMessage,
		isStreaming?: boolean,
	) {
		const component = this as AssistantMessageComponentLike;
		const self = this as unknown as AssistantInternals;
		// Losing isStreaming -> mermaid streaming mis-renders and flickers back and forth.
		self.isStreaming = isStreaming ?? self.isStreaming;
		self.lastMessage = message;
		latestComponent = component;
		latestComponentTimestamp = message.timestamp;

		// Visible mode is intentionally untouched: Shift+Tab restores Pi's exact
		// built-in Thinking Markdown renderer, including every OpenAI summary stage.
		if (!self.hideThinkingBlock) {
			originalUpdateContent.call(this, message, self.isStreaming);
			return;
		}

		if (activeThinking?.messageTimestamp === message.timestamp) {
			streamingComponents.add(component);
		}

		self.contentContainer.clear();
		const hasActiveThinking =
			activeThinking?.messageTimestamp === message.timestamp &&
			message.content.some((content) => content.type === "thinking");
		const hasVisibleContent =
			hasActiveThinking ||
			message.content.some(
				(content) =>
					(content.type === "text" && content.text.trim()) ||
					(content.type === "thinking" && content.thinking.trim()),
			);
		// Reserve Pi's normal leading spacer even before the first thinking token.
		// This prevents the placeholder heading from jumping down one row when
		// summary/body content begins streaming.
		if (hasVisibleContent) self.contentContainer.addChild(new Spacer(1));

		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];

			if (content.type === "text" && content.text.trim()) {
				self.contentContainer.addChild(
					new Markdown(content.text.trim(), self.outputPad, 0, self.markdownTheme, undefined, {
						transform: createTransform("assistant", self),
					}),
				);
				continue;
			}

			if (content.type !== "thinking") continue;

			const runStartIndex = i;
			const hasVisibleContentBefore = message.content
				.slice(0, runStartIndex)
				.some(
					(previous) =>
						(previous.type === "text" && previous.text.trim()) ||
						(previous.type === "thinking" && previous.thinking.trim()),
				);
			const thinkingBlocks: string[] = [];
			let latestSummary: SummaryPart | undefined;
			for (; i < message.content.length; i++) {
				const thinkingContent = message.content[i];
				if (thinkingContent.type !== "thinking") break;
				const thinking = thinkingContent.thinking.trim();
				if (!thinking) continue;
				thinkingBlocks.push(thinking);

				if (config.useSummaryTitlesAsThinkingTitle && isOpenAiResponsesMessage(message)) {
					const contentIsActive =
						activeThinking?.messageTimestamp === message.timestamp &&
						activeThinking.contentIndex === i;
					// During streaming, thinkingSignature may contain only the previously
					// completed summary parts. Prefer the live text so a newly arriving
					// title immediately replaces the old one instead of appearing in its
					// preview body. Once complete, the structured signature is canonical.
					latestSummary = contentIsActive
						? (parseLatestStreamingSummary(thinking) ??
							getLatestOpenAiSummary(thinkingContent.thinkingSignature) ??
							latestSummary)
						: (getLatestOpenAiSummary(thinkingContent.thinkingSignature) ??
							parseLatestStreamingSummary(thinking) ??
							latestSummary);
				}
			}
			const runEndIndex = i - 1;
			i--;
			const active = isActiveRun(message, runStartIndex, runEndIndex);
			// OpenAI can spend several seconds reasoning before it emits the first
			// summary token. Keep an empty active block visible as animated
			// "Thinking..." during that otherwise silent interval.
			if (thinkingBlocks.length === 0 && !active) continue;
			if (hasVisibleContentBefore) {
				self.contentContainer.addChild(new Spacer(1));
			}

			const elapsedMs = activeThinking
				? Math.max(1, Date.now() - activeThinking.startedAt)
				: undefined;
			const completedMs = getCompletedDuration(message.timestamp, runStartIndex, runEndIndex);
			const durationMs = active ? elapsedMs : completedMs;
			const durationText = durationMs === undefined ? undefined : formatThoughtDuration(durationMs);

			let heading: string;
			if (active && latestSummary) {
				heading =
					animatedText(latestSummary.title, summaryTitleStyle, true) +
					(durationText ? thinkingStyle(` · ${durationText}`) : "");
			} else if (active) {
				const label = self.hiddenThinkingLabel || "Thinking...";
				heading =
					animatedText(label, thinkingStyle, true) +
					(durationText ? thinkingStyle(` · ${durationText}`) : "");
			} else {
				// Completed compact blocks use one provider-independent status line.
				// Without a duration record (interrupted stream/old session/missing entry or misaligned index), don't fall back to the loading text
				// "Thinking...": use the summary title or a neutral "Thought" instead.
				heading = thinkingStyle(
					durationText ? `Thought for ${durationText}` : (latestSummary?.title ?? "Thought"),
				);
			}
			const previewSource = (latestSummary?.body ?? thinkingBlocks.join("\n\n")).trim();
			const block = new ThinkingPreviewBlock(
				heading,
				previewSource,
				self.outputPad,
				message.timestamp,
				thinkingStyle,
				activeTheme,
				runStartIndex,
			);
			if (toolsExpanded(self)) block.setForcedExpanded(true);
			self.contentContainer.addChild(block);

			const hasVisibleContentAfter = message.content
				.slice(i + 1)
				.some(
					(next) =>
						(next.type === "text" && next.text.trim()) ||
						(next.type === "thinking" && next.thinking.trim()),
				);
			if (hasVisibleContentAfter) self.contentContainer.addChild(new Spacer(1));
		}

		const hasToolCalls = message.content.some((content) => content.type === "toolCall");
		self.hasToolCalls = hasToolCalls;

		if (message.stopReason === "length") {
			self.contentContainer.addChild(new Spacer(1));
			self.contentContainer.addChild(
				new Text(
					activeTheme
						? activeTheme.fg(
								"error",
								"Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
							)
						: "Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
					self.outputPad,
					0,
				),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				self.contentContainer.addChild(new Spacer(1));
				self.contentContainer.addChild(
					new Text(
						activeTheme ? activeTheme.fg("error", abortMessage) : abortMessage,
						self.outputPad,
						0,
					),
				);
			} else if (message.stopReason === "error") {
				const errorMessage = message.errorMessage || "Unknown error";
				self.contentContainer.addChild(new Spacer(1));
				self.contentContainer.addChild(
					new Text(
						activeTheme
							? activeTheme.fg("error", `Error: ${errorMessage}`)
							: `Error: ${errorMessage}`,
						self.outputPad,
						0,
					),
				);
			}
		}
	};
	const installedUpdateContent = prototype.updateContent;
	(installedUpdateContent as any)[COMPACT_THINKING_PATCH_KEY] = true;

	function ensureAnimationTimer() {
		if (animationTimer) return;
		animationTimer = setInterval(() => {
			animationFrame++;
			for (const component of streamingComponents) {
				const self = component as unknown as AssistantInternals;
				if (self.lastMessage) self.updateContent(self.lastMessage);
			}
			activeTui?.requestRender();
		}, config.animationIntervalMs);
	}

	function stopAnimationTimerIfIdle() {
		if (activeThinking || compactSummaryActive || !animationTimer) return;
		clearInterval(animationTimer);
		animationTimer = undefined;
	}

	activeCompactSummarySetter = (active) => {
		compactSummaryActive = active;
		if (active) ensureAnimationTimer();
		else stopAnimationTimerIfIdle();
		activeTui?.requestRender();
	};

	function startThinking(message: AssistantMessage, contentIndex: number) {
		activeThinking = {
			messageTimestamp: message.timestamp,
			contentIndex,
			startedAt: Date.now(),
		};
		streamingComponents.clear();
		animationFrame = 0;

		// Depending on event-listener order, Pi may have rendered the empty
		// thinking_start partial just before this extension receives the event.
		// Re-render that component immediately so users do not wait for the first
		// summary delta before seeing the animation.
		if (latestComponent && latestComponentTimestamp === message.timestamp) {
			streamingComponents.add(latestComponent);
			const self = latestComponent as unknown as AssistantInternals;
			self.updateContent(message);
			activeTui?.requestRender();
		}

		if (animationTimer) clearInterval(animationTimer);
		animationTimer = undefined;
		ensureAnimationTimer();
	}

	function finishThinking() {
		if (!activeThinking) return;
		const finished = activeThinking;
		const durationMs = Math.max(1, Date.now() - finished.startedAt);
		let durations = completedDurations.get(finished.messageTimestamp);
		if (!durations) {
			durations = new Map();
			completedDurations.set(finished.messageTimestamp, durations);
		}
		durations.set(finished.contentIndex, durationMs);
		pi.appendEntry(DURATION_ENTRY_TYPE, {
			messageTimestamp: finished.messageTimestamp,
			contentIndex: finished.contentIndex,
			durationMs,
		} as DurationEntryData);

		activeThinking = undefined;
		stopAnimationTimerIfIdle();

		const components = [...streamingComponents];
		streamingComponents.clear();
		for (const component of components) {
			const self = component as unknown as AssistantInternals;
			if (self.lastMessage) self.updateContent(self.lastMessage);
		}
		activeTui?.requestRender();
	}

	// ---- fork patch: keep the thinking animation during subagent tool execution ----

	// Subagent tools can run for minutes: keep the thinking loading animation
	// alive for the whole execution and only finalize once the tool ends or the
	// model emits the next text/thinking boundary.
	function resumeAgentThinking(message: AssistantMessage | undefined) {
		if (activeThinking) return;
		const content = message?.content;
		if (!Array.isArray(content)) return;
		const index = content.findIndex((item) => item?.type === "thinking");
		if (index < 0) return;
		startThinking(message as AssistantMessage, index);
	}

	function messageHasAgentTool(message: AssistantMessage | undefined) {
		return (
			Array.isArray(message?.content) &&
			message.content.some(
				(content) =>
					content?.type === "toolCall" &&
					(content.name === "Agent" ||
						content.name === "Agents" ||
						content.arguments?.subagent_type != null),
			)
		);
	}

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		const update = event.assistantMessageEvent;

		if (update.type === "thinking_start") {
			if (activeThinking?.messageTimestamp === event.message.timestamp) {
				// Some Responses-compatible providers emit a fresh thinking_start for
				// each summary/reasoning item even though no text or tool boundary has
				// ended the visible Thinking run. Follow the new content block without
				// resetting the run's original start time.
				activeThinking.contentIndex = update.contentIndex;
			} else {
				if (activeThinking) finishThinking();
				startThinking(event.message, update.contentIndex);
			}
		} else if (update.type === "thinking_delta") {
			if (!activeThinking) {
				startThinking(event.message, update.contentIndex);
			} else if (activeThinking.messageTimestamp === event.message.timestamp) {
				activeThinking.contentIndex = update.contentIndex;
			}
		} else if (update.type === "text_start") {
			finishThinking();
		} else if (update.type === "toolcall_start" || update.type === "toolcall_delta") {
			if (messageHasAgentTool(event.message)) {
				resumeAgentThinking(event.message);
			} else {
				finishThinking();
			}
		}
		// Do not finalize on thinking_end alone. OpenAI Responses providers can
		// close one reasoning item and immediately open another for the next
		// summary while Pi still renders both as one contiguous Thinking run.
		// A text/tool transition or message_end is the actual visible boundary.
	});

	// OpenAI-compatible providers may not close reasoning until the response ends.
	pi.on("tool_execution_start", (event: any) => {
		if (event.toolName === "Agent" || event.toolName === "Agents") {
			const lastMessage = (latestComponent as unknown as { lastMessage?: AssistantMessage })
				?.lastMessage;
			resumeAgentThinking(lastMessage);
		} else {
			finishThinking();
		}
	});
	pi.on("tool_execution_end", (event: any) => {
		if (event.toolName === "Agent" || event.toolName === "Agents") finishThinking();
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		// Agent tool runs after message_end; keep the ticker until tool_execution_end
		// or the next text/thinking boundary.
		if (messageHasAgentTool(event.message)) return;
		finishThinking();
	});

	pi.on("session_start", (_event, ctx) => {
		restoreDurationEntries(ctx.sessionManager.getBranch(), completedDurations);
		activeTheme = ctx.ui.theme;
		if (ctx.mode !== "tui") return;
		const ui = ctx.ui as { getToolsExpanded?: () => boolean };
		mainToolsExpanded = () => {
			try {
				return ui.getToolsExpanded?.() === true;
			} catch {
				return false;
			}
		};

		// An empty widget gives the animation loop access to requestRender without
		// enabling terminal mouse reporting or intercepting native scrollback input.
		// setWidget's factory runs synchronously, so the patch is already installed at this point.
		ctx.ui.setWidget(WIDGET_ID, (tui) => {
			activeTui = tui;
			return { render: () => [], invalidate() {} };
		});

		// On reload/resume, pi rebuilds chat components with the original prototypes before session_start
		// (rebuildChatFromMessages / renderCurrentSessionState). The shared
		// refreshMountedTranscript scans the mounted tree to redraw them, restoring compact rendering,
		// persisted durations and tool call display.
		refreshMountedTranscript(activeTui);
		activeTui?.requestRender(true);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreDurationEntries(ctx.sessionManager.getBranch(), completedDurations);
		refreshMountedTranscript(activeTui);
		activeTui?.requestRender(true);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		finishThinking();
		activeThinkingQuery = undefined;
		activeThinkingStateQuery = undefined;
		activeThinkingAnimationFrameQuery = undefined;
		activeCompactSummarySetter = undefined;
		compactSummaryActive = false;
		if (animationTimer) clearInterval(animationTimer);
		animationTimer = undefined;
		activeTui = undefined;
		activeTheme = undefined;
		latestComponent = undefined;
		latestComponentTimestamp = undefined;
		completedDurations.clear();
		streamingComponents.clear();
		expandedThinking.clear();
		clearThinkingPreviewCache();
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_ID, undefined);

		mainToolsExpanded = () => false;
		if (patchInstalled) {
			if (ownedSetExpanded && prototype.setExpanded === installedSetExpanded) {
				delete prototype.setExpanded;
			}
			if (prototype.updateContent === installedUpdateContent) {
				const wrappedOriginal = (originalUpdateContent as any)[PROTOTYPE_ORIGINAL_KEY];
				prototype.updateContent =
					typeof wrappedOriginal === "function" ? wrappedOriginal : originalUpdateContent;
			}
			patchInstalled = false;
		}
	});
}

type CompactThinkingOwner = {
	owner: object;
	stop(event?: any, ctx?: any): void;
};

type UpstreamHandler = (event: any, ctx: any) => void;

export function installCompactThinking(
	pi: ExtensionAPI,
	initialConfig: CompactThinkingConfig,
): CompactThinkingController {
	const owner = {};
	let session: { event: any; ctx: any } | undefined;
	let active = false;
	// Stable pi.on wrappers delegate here so activate/reload never double-binds.
	const delegates = new Map<string, UpstreamHandler>();
	const boundEvents = new Set<string>();

	const restoreAllDurations = (ctx: any): any => {
		const sessionManager = ctx?.sessionManager;
		if (!sessionManager || typeof sessionManager.getEntries !== "function") return ctx;
		return {
			...ctx,
			sessionManager: {
				...sessionManager,
				getBranch: () => sessionManager.getEntries(),
			},
		};
	};

	const bind = (eventName: string) => {
		if (boundEvents.has(eventName)) return;
		boundEvents.add(eventName);
		pi.on(eventName as any, (e: any, ctx: any) => {
			if (!active) return;
			const handler = delegates.get(eventName);
			if (!handler) return;
			handler(e, eventName === "session_tree" ? restoreAllDurations(ctx) : ctx);
		});
	};

	const stop = (event?: any, ctx?: any) => {
		if (!active) return;
		active = false;
		const shutdown = delegates.get("session_shutdown");
		delegates.clear();
		shutdown?.(event ?? session?.event ?? {}, ctx ?? session?.ctx ?? { mode: "rpc", ui: {} });
		if (patchRegistry.get<CompactThinkingOwner>(COMPACT_THINKING_OWNER)?.owner === owner)
			patchRegistry.delete(COMPACT_THINKING_OWNER);
	};

	const activate = (event: any, ctx: any) => {
		// Headless subagent runtimes share this process. Never steal the parent
		// TUI prototype patch or kill its thinking ticker.
		if (ctx?.mode !== "tui") return;

		patchRegistry.get<CompactThinkingOwner>(COMPACT_THINKING_OWNER)?.stop(event, ctx);
		session = { event, ctx };

		// Config is controlled centrally by claude-code-style; overrides library defaults on load.
		Object.assign(config, initialConfig);
		delegates.clear();

		compactThinking({
			on(eventName: string, handler: UpstreamHandler) {
				if (eventName === "session_start") {
					// Already inside session_start — run immediately.
					handler(event, restoreAllDurations(ctx));
					return;
				}
				if (eventName === "session_shutdown") {
					delegates.set(eventName, handler);
					return;
				}
				delegates.set(eventName, handler);
				bind(eventName);
			},
			appendEntry: (...args: any[]) => (pi.appendEntry as any)(...args),
		} as unknown as ExtensionAPI);

		active = true;
		patchRegistry.install(COMPACT_THINKING_OWNER, { owner, stop });
	};

	pi.on("session_start", (event, ctx) => {
		session = { event, ctx };
		activate(event, ctx);
	});
	pi.on("session_shutdown", (event, ctx) => {
		if (patchRegistry.get<CompactThinkingOwner>(COMPACT_THINKING_OWNER)?.owner === owner)
			stop(event, ctx);
		session = undefined;
	});

	return {
		updateConfig(next) {
			Object.assign(initialConfig, next);
			Object.assign(config, next);
		},
		getMessageThinkingDurationMs(messageTimestamp) {
			return activeThinkingQuery?.(messageTimestamp);
		},
		isMessageThinkingActive(messageTimestamp) {
			return activeThinkingStateQuery?.(messageTimestamp) ?? false;
		},
		getThinkingAnimationFrame() {
			return activeThinkingAnimationFrameQuery?.() ?? 0;
		},
		setCompactSummaryActive(active) {
			activeCompactSummarySetter?.(active);
		},
	};
}
