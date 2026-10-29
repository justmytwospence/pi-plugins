import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { inspect } from "node:util";
import { config } from "../../config/config.ts";
import { formatBashCommand } from "./bash-format.ts";
import { createBashBlockHighlighter, createCodeBlockHighlighter } from "./diff/diff-highlight.ts";
import { showMoreHintText } from "./show-more-hint.ts";
import { TOOL_LOADING_INTERVAL_MS, toolLoadingIcon } from "../../utils/tool-loading-icon.ts";
import { getToolMouseTui } from "../mouse/scroll.ts";
import { sanitizeToolResultText } from "../../utils/tool-result-sanitize.ts";

const TOOL_VIEWPORT_WIDTH_RATIO = 0.8;
/** Wide-screen right margin cap: use a fixed margin once the proportional margin exceeds this many columns. */
const TOOL_VIEWPORT_MAX_GUTTER = 24;

export function toolViewportWidth(width: number): number {
	return Math.max(
		1,
		Math.floor(width * TOOL_VIEWPORT_WIDTH_RATIO),
		Math.floor(width) - TOOL_VIEWPORT_MAX_GUTTER,
	);
}

/** One-level indent wrapper, same as the default tool result. Children only deduct the always-added 1 column; the extra 2 columns of ↳ rows are absorbed by truncateToWidth. */
export function insetComponent(component: any): any {
	const wrapped: Record<string, unknown> = {
		render: (width: number) =>
			component.render(Math.max(1, width - 1)).map((line: string) => {
				const nestedMarker = line.replace(/^((?:\x1b\[[0-?]*[ -/]*[@-~])*)↳/, "$1  ↳");
				return truncateToWidth(` ${nestedMarker}`, Math.max(0, width), "");
			}),
		invalidate: () => component.invalidate?.(),
	};
	// Remainder rows declared by the inner diff: the mouse layer only sees this wrapper component.
	if (typeof component.isCollapsedHintLine === "function") {
		wrapped.isCollapsedHintLine = (line: string) => component.isCollapsedHintLine(line);
	}
	return wrapped;
}

function rawTextFromResult(result: any): string {
	return Array.isArray(result?.content)
		? result.content
				.filter((item: any) => item?.type === "text")
				.map((item: any) => String(item.text ?? ""))
				.join("\n")
		: "";
}

function detailsFromResult(result: any): string {
	if (result?.details === undefined) return "";
	const details =
		typeof result.details === "string"
			? result.details
			: inspect(result.details, { depth: 8, breakLength: 100, compact: false });
	return sanitizeToolResultText(details, 16_384);
}

export function textFromResult(result: any, expanded = false): string {
	// Compact previews only need short text; bound sanitize work.
	const content = sanitizeToolResultText(rawTextFromResult(result), 16_384);
	const details = detailsFromResult(result);
	if (!content) return details;
	if (!expanded || !details || details === content) return content;
	return `${content}\nDetails:\n${details}`;
}

export function outputLineCount(result: any): number {
	const text = rawTextFromResult(result).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
	return text ? text.split("\n").length : 0;
}

export function countLines(text: string): number {
	return text
		.trim()
		.split("\n")
		.filter((line) => line.trim().length > 0).length;
}

function hasExpandableResult(text: string): boolean {
	return countLines(text) > 1;
}

const activeAnimationContexts = new Set<any>();
let sharedAnimationTimer: ReturnType<typeof setTimeout> | null = null;

function clearAnimation(context: any) {
	if (context?.state) context.state.ccstyleAnimationLight = false;
	if (!context?.state?.ccstyleAnimationScheduled) return;
	context.state.ccstyleAnimationScheduled = false;
	activeAnimationContexts.delete(context);
	if (activeAnimationContexts.size === 0 && sharedAnimationTimer) {
		clearTimeout(sharedAnimationTimer);
		sharedAnimationTimer = null;
	}
}

export function clearAllAnimations() {
	for (const ctx of activeAnimationContexts) {
		ctx.state.ccstyleAnimationScheduled = false;
		ctx.state.ccstyleAnimationLight = false;
	}
	activeAnimationContexts.clear();
	if (sharedAnimationTimer) {
		clearTimeout(sharedAnimationTimer);
		sharedAnimationTimer = null;
	}
}

export function scheduleAnimation(
	context: any,
	options: { light?: boolean; intervalMs?: number } = {},
) {
	const state = (context.state ??= {});
	// light: caller re-fetches the loading frame inside render() itself, so the timer only requests a redraw;
	// otherwise the timer goes through context.invalidate() (compact summaries etc. rely on it to rebuild).
	// Written from this call's options every time, so a leftover light flag doesn't make a later non-light call skip invalidate.
	state.ccstyleAnimationLight = Boolean(options.light);
	if (state.ccstyleAnimationScheduled) return;
	state.ccstyleAnimationScheduled = true;
	activeAnimationContexts.add(context);
	if (!sharedAnimationTimer) {
		sharedAnimationTimer = setTimeout(() => {
			sharedAnimationTimer = null;
			const contexts = Array.from(activeAnimationContexts);
			activeAnimationContexts.clear();
			const tui = getToolMouseTui();
			const canRequestRender = typeof tui?.requestRender === "function";
			let lightFrames = false;
			for (const ctx of contexts) {
				ctx.state.ccstyleAnimationScheduled = false;
				if (ctx.state.ccstyleAnimationLight && canRequestRender) lightFrames = true;
				else ctx.invalidate?.();
			}
			if (lightFrames) tui.requestRender();
		}, options.intervalMs ?? TOOL_LOADING_INTERVAL_MS);
	}
}

export function pendingIcon(_name: string): string {
	return toolLoadingIcon();
}

type ToolVisualState = "pending" | "success" | "error";

export function settledIcon(name: string, state: ToolVisualState | undefined): string {
	if (state === "success") return "✓";
	if (state === "error") return "✗";
	// toolIcon(name) always returned "●" and has been inlined; name is kept for a stable export signature.
	return "●";
}

export function setToolVisualState(context: any, visualState: ToolVisualState) {
	const state = (context.state ??= {});
	if (visualState !== "pending") clearAnimation(context);
	if (state.ccstyleToolVisualState === visualState) return;
	state.ccstyleToolVisualState = visualState;
	// Do not invalidate synchronously from renderResult. Pi is already rendering
	// this tool row; recursively scheduling another render here can retain both
	// the finalized result component and its previous secondary/partial component,
	// which displays the result summary twice. The current render pass also
	// refreshes renderCall, so the settled icon still updates immediately.
}

function getToolVisualState(context: any): ToolVisualState | undefined {
	return context?.state?.ccstyleToolVisualState as ToolVisualState | undefined;
}

export function resolveToolVisualState(context: any): ToolVisualState | undefined {
	const visualState = getToolVisualState(context);
	if (visualState || context?.isPartial !== false) return visualState;
	const settledState: ToolVisualState = context?.isError ? "error" : "success";
	setToolVisualState(context, settledState);
	return settledState;
}

export function toolIconColor(context: any): "accent" | "error" | "success" | "muted" {
	const visualState = getToolVisualState(context);
	if (context?.isError || visualState === "error") return "error";
	if (visualState === "success") return "success";
	if (context?.isPartial || context?.executionStarted || visualState === "pending") return "accent";
	return "muted";
}

export function isToolExpanded(options: any, context: any): boolean {
	const local = context?.state?.ccstyleToolExpanded;
	return typeof local === "boolean" ? local : Boolean(options?.expanded ?? context?.expanded);
}

/** Keep the guide aligned when long result lines wrap at the viewport edge. */
export class ExpandedToolResultText {
	private text: string;
	private prefix: string;
	private normalizedText: string;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(text: string, prefix: string) {
		this.text = text;
		this.prefix = prefix;
		this.normalizedText = text.replace(/\t/g, "   ").replace(/\n+$/, "");
	}

	setText(text: string): void {
		if (this.text === text) return;
		this.text = text;
		this.normalizedText = text.replace(/\t/g, "   ").replace(/\n+$/, "");
		this.invalidate();
	}

	setPrefix(prefix: string): void {
		if (this.prefix === prefix) return;
		this.prefix = prefix;
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;

		const prefixWidth = visibleWidth(this.prefix);
		const contentWidth = Math.max(1, width - prefixWidth);
		const lines = wrapTextWithAnsi(this.normalizedText, contentWidth).map((line) =>
			truncateToWidth(this.prefix + line, width, ""),
		);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/** Expand hint next to the truncated body's last line `… +N more lines`; click opens the full preview. */
export const SHOW_MORE_LABEL = "· click to show more";

export type ToolIoSection = "input" | "output";

// Module-local token: /reload creates a fresh token, so stale view instances are
// replaced instead of retaining their old render implementation.
const EXPANDED_TOOL_IO_VIEW_GENERATION = Symbol("ccstyle-expanded-tool-io-view");

/**
 * Expanded tool body with clear Input / Output sections (Grok Build–style).
 *
 * Visual frame:
 *   ├ Input  click to show more
 *   │ path: src/a.ts
 *   │
 *   └ Output  click to show more
 *     result line…
 *
 * flushLeft=true (only mode=on expanded cards): drop the tree rail's leading space; the outer Box(1,1) provides 1 cell of padding.
 *
 * Reused across re-renders via context.lastComponent when possible.
 */
export class ExpandedToolIoView {
	readonly [EXPANDED_TOOL_IO_VIEW_GENERATION] = true;
	private inputBody: string;
	private outputBody: string;
	private isError: boolean;
	private theme: any;
	private maxOutputLines: number;
	private maxInputLines: number;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private hoveredSection: ToolIoSection | null = null;
	/** Which sections currently show the show-more affordance (after last render). */
	private truncated: { input: boolean; output: boolean } = { input: false, output: false };
	/** 0-based header line indexes that carry show-more after last render. */
	private showMoreHeaderRows: { input?: number; output?: number } = {};
	/** Code block in Input (codemode's `code`): colored lines override the default dim/muted style. */
	private inputCode?:
		| {
				startLine: number;
				language: string;
				standalone: boolean;
				code: string;
				theme: unknown;
				rows: () => string[];
		  }
		| undefined;

	/** flushLeft: render flush left (mode=on expanded cards); default false keeps the leading space (shared paths like compact). */
	private flushLeft: boolean;

	constructor(
		theme: any,
		inputBody: string,
		outputBody: string,
		isError: boolean,
		maxOutputLines = config.expandedOutputMaxLines,
		maxInputLines = config.expandedInputMaxLines,
		flushLeft = false,
	) {
		this.theme = theme;
		this.inputBody = inputBody;
		this.outputBody = outputBody;
		this.isError = isError;
		this.maxOutputLines = Math.max(1, maxOutputLines);
		this.maxInputLines = Math.max(1, maxInputLines);
		this.flushLeft = flushLeft;
	}

	setContent(
		inputBody: string,
		outputBody: string,
		isError: boolean,
		maxOutputLines?: number,
		maxInputLines?: number,
		flushLeft?: boolean,
	): void {
		const nextOut =
			maxOutputLines !== undefined ? Math.max(1, maxOutputLines) : this.maxOutputLines;
		const nextIn = maxInputLines !== undefined ? Math.max(1, maxInputLines) : this.maxInputLines;
		const nextFlush = flushLeft !== undefined ? flushLeft : this.flushLeft;
		if (
			this.inputBody === inputBody &&
			this.outputBody === outputBody &&
			this.isError === isError &&
			this.maxOutputLines === nextOut &&
			this.maxInputLines === nextIn &&
			this.flushLeft === nextFlush
		) {
			return;
		}
		this.inputBody = inputBody;
		this.outputBody = outputBody;
		this.isError = isError;
		this.maxOutputLines = nextOut;
		this.maxInputLines = nextIn;
		this.flushLeft = nextFlush;
		this.invalidate();
	}

	getInputBody(): string {
		return this.inputBody;
	}

	/**
	 * Register the Input code block: cli-highlight synchronously as a baseline, shiki upgrades asynchronously, and once it lands
	 * redraw via invalidate. Built only once per code and theme (the view caches lines by width).
	 */
	private highlighter(block: InputCodeBlock): () => string[] {
		const redraw = () => {
			// The view's own line cache + the outer tool card (clears paint cache and calls requestRender)
			this.invalidate();
			invalidateIoView(this);
		};
		return block.language === "bash"
			? createBashBlockHighlighter(block.code, this.theme, redraw)
			: createCodeBlockHighlighter(block.code, block.language, this.theme, redraw);
	}

	setInputCode(block: InputCodeBlock | undefined): void {
		if (!block) {
			if (this.inputCode) {
				this.inputCode = undefined;
				this.invalidate();
			}
			return;
		}
		if (this.inputCode?.code === block.code && this.inputCode.theme === this.theme) {
			this.inputCode.startLine = block.startLine;
			this.inputCode.standalone = block.standalone;
			return;
		}
		this.inputCode = {
			startLine: block.startLine,
			language: block.language,
			standalone: block.standalone,
			code: block.code,
			theme: this.theme,
			rows: this.highlighter(block),
		};
		this.invalidate();
	}

	/**
	 * When the whole Input is a code block, return the language and code so the full preview can wrap it in a fence (the popup renders
	 * Markdown; fenced code blocks are colored by pi's highlightCode). Returns undefined when mixed with other fields.
	 */
	getInputCodeFence(): { language: string; code: string } | undefined {
		const block = this.inputCode;
		return block?.standalone ? { language: block.language, code: block.code } : undefined;
	}

	/** Colored content of a source line in the code block (leading indent stripped); undefined when outside the block. */
	private inputCodeLine(sourceIndex: number): string | undefined {
		const block = this.inputCode;
		if (!block) return undefined;
		const offset = sourceIndex - block.startLine;
		if (offset < 0) return undefined;
		const rows = block.rows();
		return offset < rows.length ? rows[offset] : undefined;
	}

	getOutputBody(): string {
		return this.outputBody.trim() ? this.outputBody : "Done";
	}

	setHoveredSection(section: ToolIoSection | null): void {
		if (this.hoveredSection === section) return;
		this.hoveredSection = section;
		this.invalidate();
	}

	getHoveredSection(): ToolIoSection | null {
		return this.hoveredSection;
	}

	/** True when the plain truncation footer carries show-more. Input continuation lines carry │, Output does not. */
	matchShowMoreLine(plainLine: string): ToolIoSection | null {
		const line = plainLine.replace(/\x1b\[[0-9;]*m/g, "");
		if (!line.includes(` · ${showMoreHintText()}`) || !/\+\d+ more lines/.test(line)) return null;
		if (this.truncated.input && line.includes("│")) return "input";
		if (this.truncated.output) return "output";
		return null;
	}

	/** Precise header rows marked for show-more hit testing (last render). */
	showMoreHeaderLineIndexes(): ReadonlyArray<{ section: ToolIoSection; line: number }> {
		const out: Array<{ section: ToolIoSection; line: number }> = [];
		if (this.showMoreHeaderRows.input !== undefined) {
			out.push({ section: "input", line: this.showMoreHeaderRows.input });
		}
		if (this.showMoreHeaderRows.output !== undefined) {
			out.push({ section: "output", line: this.showMoreHeaderRows.output });
		}
		return out;
	}

	/** Column range (1-based, visible cells) of show-more on a rendered header, if present. */
	showMoreHitbox(plainLine: string): { startCol: number; endCol: number } | null {
		const line = plainLine.replace(/\x1b\[[0-9;]*m/g, "");
		const label = ` · ${showMoreHintText()}`;
		const idx = line.lastIndexOf(label);
		if (idx < 0) return null;
		const before = line.slice(0, idx);
		const startCol = visibleWidth(before) + 1;
		const endCol = startCol + visibleWidth(label) - 1;
		return { startCol, endCol };
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) {
			return withIoViewMarkers(this, this.cachedLines);
		}

		const theme = this.theme;
		const safeWidth = Math.max(1, Math.floor(width));
		// flushLeft: flush left (outer Box handles 1 cell of pad); otherwise keep 1 leading space (shared with compact)
		const lead = this.flushLeft ? "" : " ";
		const rail = `${lead}│ `;
		const railWidth = visibleWidth(rail);
		const bodyWidth = toolViewportWidth(safeWidth);
		const contentWidth = Math.max(1, bodyWidth - railWidth);
		const bodyColor = this.isError ? "error" : "toolOutput";
		const lines: string[] = [];
		this.truncated = { input: false, output: false };
		this.showMoreHeaderRows = {};

		const pushHeader = (corner: "├" | "└", label: string) => {
			const mark = theme.fg("dim", `${lead}${corner} `);
			const title = theme.fg(
				"accent",
				typeof theme.bold === "function" ? theme.bold(label) : label,
			);
			lines.push(truncateToWidth(mark + title, safeWidth, ""));
		};

		const pushRailLine = (styledContent: string, continued = true) => {
			// Continuation rail; Output body is indented 2 cells relative to └ (+ optional lead)
			const prefix = continued ? rail : `${lead}  `;
			lines.push(truncateToWidth(theme.fg("dim", prefix) + styledContent, safeWidth, ""));
		};

		const pushBlankRail = () => {
			lines.push(truncateToWidth(theme.fg("dim", `${lead}│`), safeWidth, ""));
		};

		const pushBody = (
			body: string,
			opts: { input?: boolean; limit: number; continued?: boolean; section: ToolIoSection },
		): boolean /* truncated */ => {
			const raw = body.replace(/\t/g, "   ").replace(/\n+$/, "");
			if (!raw.trim()) {
				pushRailLine(theme.fg("dim", "(empty)"), opts.continued);
				return false;
			}
			const sourceLines = raw.split("\n");
			const wrapped: string[] = [];
			for (const [index, source] of sourceLines.entries()) {
				if (opts.input) {
					// Code block lines use the colored version (indent stripped); others use the default dim/muted
					wrapped.push(...wrapInputLine(source, contentWidth, theme, this.inputCodeLine(index)));
					continue;
				}
				const styled = theme.fg(bodyColor, source);
				const parts = wrapTextWithAnsi(styled, contentWidth);
				if (parts.length === 0) wrapped.push(styled);
				else wrapped.push(...parts);
			}
			// Prefer source-line count so plain multi-line dumps always cap, even when
			// theme/wrap measurements disagree slightly.
			const truncated = wrapped.length > opts.limit || sourceLines.length > opts.limit;
			const visible = truncated ? wrapped.slice(0, Math.min(opts.limit, wrapped.length)) : wrapped;
			for (const line of visible) pushRailLine(line, opts.continued);
			if (truncated) {
				const hidden = Math.max(0, wrapped.length - visible.length);
				if (hidden > 0) {
					// Hover only highlights the text; the dot stays dim (consistent with group hint).
					const more =
						theme.fg("dim", " ·") +
						theme.fg(
							this.hoveredSection === opts.section ? "text" : "dim",
							` ${showMoreHintText()}`,
						);
					pushRailLine(theme.fg("dim", `… +${hidden} more lines`) + more, opts.continued);
					this.showMoreHeaderRows[opts.section] = lines.length - 1;
				}
			}
			return truncated;
		};

		const hasInput = this.inputBody.trim().length > 0;
		const outputText = this.getOutputBody();

		// Decide show-more from the same truncation rules as pushBody.
		const inputWouldTruncate =
			hasInput &&
			bodyExceedsLineLimit(
				this.inputBody,
				this.maxInputLines,
				contentWidth,
				true,
				theme,
				bodyColor,
				(inputIndex: number) => this.inputCodeLine(inputIndex),
			);
		const outputWouldTruncate = bodyExceedsLineLimit(
			outputText,
			this.maxOutputLines,
			contentWidth,
			false,
			theme,
			bodyColor,
		);

		if (hasInput) {
			this.truncated.input = inputWouldTruncate;
			pushHeader("├", "Input");
			pushBody(this.inputBody, {
				input: true,
				limit: this.maxInputLines,
				continued: true,
				section: "input",
			});
			pushBlankRail();
			this.truncated.output = outputWouldTruncate;
			pushHeader("└", "Output");
			pushBody(outputText, {
				limit: this.maxOutputLines,
				continued: false,
				section: "output",
			});
		} else {
			this.truncated.output = outputWouldTruncate;
			pushHeader("└", "Output");
			pushBody(outputText, {
				limit: this.maxOutputLines,
				continued: false,
				section: "output",
			});
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return withIoViewMarkers(this, lines);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export function isExpandedToolIoView(value: unknown): value is ExpandedToolIoView {
	return Boolean(
		value &&
			typeof value === "object" &&
			(value as ExpandedToolIoView)[EXPANDED_TOOL_IO_VIEW_GENERATION] === true &&
			typeof (value as ExpandedToolIoView).getInputBody === "function" &&
			typeof (value as ExpandedToolIoView).getOutputBody === "function" &&
			typeof (value as ExpandedToolIoView).setHoveredSection === "function" &&
			typeof (value as ExpandedToolIoView).render === "function",
	);
}

/** Input line coloring: `key: value` split into dim key + muted value; other lines fully muted. */
function styleInputSourceLine(line: string, theme: any): string {
	const match = line.match(/^([A-Za-z_][\w.-]*)(:\s*)(.*)$/);
	if (!match) return theme.fg("muted", line);
	const [, key, sep, rest] = match;
	return theme.fg("dim", key + sep) + theme.fg("muted", rest ?? "");
}

/**
 * Wrap one Input source line. Without styledBody it behaves exactly as before (other tools unaffected);
 * for code blocks (styledBody = colored, indent-stripped lines) continuation lines follow the source's leading indent: hugging the rail
 * would read as a new line, so strip the indent first, reduce the wrap width accordingly, then add it back to every line.
 * Line-count checks (bodyExceedsLineLimit) share this logic with actual rendering so the expand hint matches.
 */
function wrapInputLine(
	source: string,
	contentWidth: number,
	theme: any,
	styledBody?: string,
): string[] {
	if (styledBody === undefined) {
		const styled = styleInputSourceLine(source, theme);
		const parts = wrapTextWithAnsi(styled, contentWidth);
		return parts.length ? parts : [styled];
	}
	const lead = /^[ \t]*/.exec(source)?.[0] ?? "";
	const leadWidth = visibleWidth(lead);
	const room = Math.max(1, contentWidth - leadWidth);
	let parts = wrapTextWithAnsi(styledBody, room);
	// A wrapped line hangs two cells under its start, so the continuation does not read as a new line
	const hang = parts.length > 1 && room > 8 ? "  " : "";
	if (hang) parts = wrapTextWithAnsi(styledBody, room - hang.length);
	const rows = parts.length ? parts : [styledBody];
	if (!leadWidth && !hang) return rows;
	const prefix = theme.fg("muted", lead);
	const hanging = theme.fg("muted", lead + hang);
	return rows.map((row, index) => (index === 0 ? prefix : hanging) + row);
}

/** True when body needs truncation at the given line limit (source lines or wrapped rows). */
function bodyExceedsLineLimit(
	body: string,
	limit: number,
	contentWidth: number,
	asInput: boolean,
	theme: any,
	bodyColor = "toolOutput",
	/** Code block source lines take colored content; line-count checks and actual rendering follow the same rules. */
	codeLine?: (sourceIndex: number) => string | undefined,
): boolean {
	const raw = body.replace(/\t/g, "   ").replace(/\n+$/, "");
	if (!raw.trim()) return false;
	const sourceLines = raw.split("\n");
	if (sourceLines.length > limit) return true;
	let total = 0;
	for (const [index, source] of sourceLines.entries()) {
		const parts = asInput
			? wrapInputLine(source, contentWidth, theme, codeLine?.(index))
			: wrapTextWithAnsi(theme.fg(bodyColor, source), contentWidth);
		total += Math.max(1, parts.length);
		if (total > limit) return true;
	}
	return false;
}

export function renderCollapsedToolResult(body: string, collapsedHint = ""): string {
	return `   ↳ ${body}${collapsedHint}`;
}

export function renderCollapsedToolResultToWidth(
	body: string,
	collapsedHint: string,
	width: number,
	prefix = "   ↳ ",
): string {
	const previewWidth = toolViewportWidth(width);
	const bodyWidth = Math.max(1, previewWidth - visibleWidth(prefix) - visibleWidth(collapsedHint));
	return truncateToWidth(
		prefix + middleTruncateToWidth(body, bodyWidth) + collapsedHint,
		previewWidth,
		"",
	);
}

/** Truncate to width from the start (keep the beginning, elide the tail) without inserting ANSI reset (safe on card backgrounds). */
export function headTruncateToWidth(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return "…";
	let left = "";
	for (const char of Array.from(text)) {
		if (visibleWidth(left + "…" + char) > width) break;
		left += char;
	}
	return `${left}…`;
}

/** Truncate to width keeping both head and tail (used for collapsed rows and tool titles). */
export function middleTruncateToWidth(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return "…";
	const chars = Array.from(text);
	const leftWidth = Math.ceil((width - 1) / 2);
	let left = "";
	let right = "";
	for (const char of chars) {
		if (visibleWidth(left + char) > leftWidth) break;
		left += char;
	}
	for (const char of chars.reverse()) {
		if (visibleWidth(left + "…" + char + right) > width) break;
		right = char + right;
	}
	return `${left}…${right}`;
}

/**
 * Code block in an expanded card's Input: source line start index (relative to text) + language + code with leading indent stripped.
 * standalone = the whole Input is this code block (no `code:` label), so the full preview can fence the whole thing.
 */
export type InputCodeBlock = {
	startLine: number;
	language: string;
	code: string;
	standalone: boolean;
};

export type ToolInputBody = { text: string; codeBlock?: InputCodeBlock };

/** Decide colorable args by field name: the `code` of codemode / mcpscript is a JS script. */
const INPUT_CODE_LANGUAGES: Record<string, string> = { code: "javascript" };

/** A shell tool call: a command string and at most a timeout. */
function bashArgs(args: unknown): { command: string; timeout?: unknown } | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const record = args as Record<string, unknown>;
	if (typeof record.command !== "string" || !record.command.trim()) return undefined;
	if (Object.keys(record).some((key) => key !== "command" && key !== "timeout")) return undefined;
	return { command: record.command, timeout: record.timeout };
}

/** Expanded Input of a shell call: the formatted command alone, highlighted as bash. */
function formatBashInputBody(
	shell: { command: string; timeout?: unknown },
	maxChars: number,
	onReady?: () => void,
): ToolInputBody {
	let code = sanitizeToolResultText(formatBashCommand(shell.command, onReady));
	if (shell.timeout !== undefined && shell.timeout !== null) code += `\n# timeout: ${String(shell.timeout)}s`;
	if (code.length > maxChars) return { text: `${code.slice(0, maxChars)}…` };
	// Highlighted with its indentation (a heredoc body is Python or JSON); the highlighter strips it per row
	return {
		text: code,
		codeBlock: { startLine: 0, language: "bash", code: code.replace(/\t/g, "   "), standalone: true },
	};
}

/** Pretty-print tool call args for the expanded Input section. */
export function formatToolInputBody(
	args: unknown,
	maxChars = 8_000,
	/** Called when asynchronous formatting (shfmt) finishes and the body should be requested again. */
	onReady?: () => void,
): ToolInputBody {
	if (args === undefined || args === null) return { text: "" };
	if (config.readableBash) {
		const shell = bashArgs(args);
		if (shell) return formatBashInputBody(shell, maxChars, onReady);
	}
	if (typeof args !== "object") {
		const text = sanitizeToolResultText(String(args));
		return { text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text };
	}
	if (Array.isArray(args)) {
		try {
			const json = JSON.stringify(args, null, 2);
			return { text: json.length > maxChars ? `${json.slice(0, maxChars)}…` : json };
		} catch {
			return { text: sanitizeToolResultText(String(args)) };
		}
	}

	const entries = Object.entries(args as Record<string, unknown>).filter(
		([, value]) => value !== undefined,
	);
	if (entries.length === 0) return { text: "" };

	// Stable, human-first field order for common tools.
	const preferred = [
		"path",
		"file_path",
		"command",
		"query",
		"pattern",
		"url",
		"name",
		"message",
		"content",
		"old_string",
		"new_string",
	];
	entries.sort(([left], [right]) => {
		const li = preferred.indexOf(left);
		const ri = preferred.indexOf(right);
		if (li === -1 && ri === -1) return left.localeCompare(right);
		if (li === -1) return 1;
		if (ri === -1) return -1;
		return li - ri;
	});

	const lines: string[] = [];
	let codeBlock: InputCodeBlock | undefined;
	for (const [rawKey, value] of entries) {
		const key = sanitizeToolResultText(rawKey);
		if (typeof value === "string") {
			const safeValue = sanitizeToolResultText(value);
			if (safeValue.includes("\n")) {
				const expanded = safeValue.replace(/\t/g, "   ");
				const language = INPUT_CODE_LANGUAGES[key];
				// With only a code field (codemode etc.) the whole Input is the script, and the `code:` label is noise
				const standaloneCode = Boolean(language) && entries.length === 1;
				if (!standaloneCode) lines.push(`${key}:`);
				if (language) {
					// Indentation is handled by wrapInputLine; coloring only gets the body with leading indent stripped
					codeBlock = {
						startLine: lines.length,
						language,
						code: expanded
							.split("\n")
							.map((line) => line.replace(/^[ \t]*/, ""))
							.join("\n"),
						standalone: standaloneCode,
					};
				}
				for (const line of expanded.split("\n")) {
					lines.push(`  ${line}`);
				}
			} else {
				lines.push(`${key}: ${safeValue}`);
			}
			continue;
		}
		if (typeof value === "number" || typeof value === "boolean" || value === null) {
			lines.push(`${key}: ${String(value)}`);
			continue;
		}
		try {
			const json = JSON.stringify(value, null, 2);
			if (json.includes("\n")) {
				lines.push(`${key}:`);
				for (const line of json.split("\n")) lines.push(`  ${line}`);
			} else {
				lines.push(`${key}: ${json}`);
			}
		} catch {
			lines.push(`${key}: [unserializable]`);
		}
	}
	const text = lines.join("\n");
	// After truncation, line numbers no longer align with colored lines, so return plain text only
	if (text.length > maxChars) return { text: `${text.slice(0, maxChars)}…` };
	return codeBlock ? { text, codeBlock } : { text };
}

export function formatToolInputArgs(args: unknown, maxChars = 8_000): string {
	return formatToolInputBody(args, maxChars).text;
}

export function hasExpandableDetail(outputText: string, args: unknown): boolean {
	if (hasExpandableResult(outputText)) return true;
	return formatToolInputArgs(args).trim().length > 0;
}

export function renderExpandedToolResult(
	body: string,
	theme: any,
	isError: boolean,
	lastComponent?: unknown,
	args?: unknown,
	context?: any,
	/** mode=on expanded cards are flush left; compact etc. keep the default leading space */
	flushLeft = false,
): ExpandedToolIoView | ExpandedToolResultText | Text {
	const { text: inputBody, codeBlock } = formatToolInputBody(args, 8_000, () => {
		if (typeof context?.invalidate === "function") context.invalidate();
	});
	const outputBody = body;
	const maxOutputLines = config.expandedOutputMaxLines;
	const maxInputLines =
		config.readableBash && codeBlock?.language === "bash"
			? Math.max(config.expandedInputMaxLines, config.expandedBashInputMaxLines)
			: config.expandedInputMaxLines;

	// Prefer structured Input/Output when we have args or non-empty output.
	if (inputBody.trim() || outputBody.trim()) {
		let view: ExpandedToolIoView;
		if (isExpandedToolIoView(lastComponent)) {
			lastComponent.setContent(
				inputBody,
				outputBody,
				isError,
				maxOutputLines,
				maxInputLines,
				flushLeft,
			);
			view = lastComponent;
		} else {
			view = new ExpandedToolIoView(
				theme,
				inputBody,
				outputBody,
				isError,
				maxOutputLines,
				maxInputLines,
				flushLeft,
			);
		}
		view.setInputCode(codeBlock);
		if (context) rememberIoView(context, view);
		return view;
	}

	if (context?.state) context.state.ccstyleIoView = undefined;
	const color = isError ? "error" : "muted";
	return new Text(theme.fg(color, renderCollapsedToolResult("Done")), 0, 0);
}

const toolViewMarker = (id: number, section: ToolIoSection) =>
	`_cc:v${id}:${section === "input" ? "i" : "o"}`;

/** Per-frame ExpandedToolIoView ids for unambiguous show-more hit testing. */
export type IoViewFrameState = {
	viewIds: Map<ExpandedToolIoView, number>;
	idToView: Map<number, ExpandedToolIoView>;
	nextId: number;
};
let activeIoViewFrame: IoViewFrameState | null = null;

function frameViewId(view: ExpandedToolIoView): number | null {
	if (!activeIoViewFrame) return null;
	let id = activeIoViewFrame.viewIds.get(view);
	if (id === undefined) {
		id = activeIoViewFrame.nextId++;
		activeIoViewFrame.viewIds.set(view, id);
		activeIoViewFrame.idToView.set(id, view);
	}
	return id;
}

/** cachedLines stay clean; only the returned paint copy carries show-more view markers. */
function withIoViewMarkers(view: ExpandedToolIoView, lines: string[]): string[] {
	const id = frameViewId(view);
	if (id === null) return lines;
	// Mark by exact header row from render — never scan body text for Input/Output labels.
	const marked = lines.slice();
	for (const { section, line } of view.showMoreHeaderLineIndexes()) {
		if (line < 0 || line >= marked.length) continue;
		marked[line] = `${marked[line]}${toolViewMarker(id, section)}`;
	}
	return marked;
}
const ioViewInvalidators = new WeakMap<ExpandedToolIoView, () => void>();
function rememberIoView(context: any, view: ExpandedToolIoView): void {
	if (!context || typeof context !== "object") return;
	if (typeof context.invalidate === "function") {
		ioViewInvalidators.set(view, () => context.invalidate());
	}
	if (!context.state || typeof context.state !== "object") context.state = {};
	context.state.ccstyleIoView = view;
}

/** Refresh the previous/next view after hover state changes (context.invalidate cached in ioViewInvalidators). */
export function invalidateIoView(view: ExpandedToolIoView): void {
	ioViewInvalidators.get(view)?.();
}

/** Read/write the current IoView frame id table during mouse frame rendering (used by mouse-interaction's doRender wrapper). */
export function getActiveIoViewFrame(): IoViewFrameState | null {
	return activeIoViewFrame;
}

export function setActiveIoViewFrame(frame: IoViewFrameState | null): void {
	activeIoViewFrame = frame;
}
