import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Spacer,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { TOOL_LOADING_INTERVAL_MS, toolLoadingIcon } from "../../utils/tool-loading-icon.ts";
import {
	CODEMODE_TOOL_NAME,
	codemodeCalls,
	codemodeOutputLineCount,
	codemodeSummaryParts,
} from "./codemode.ts";
import { getToolMouseTui } from "../mouse/scroll.ts";
import { mcpToolTitle } from "./mcp-title.ts";
import { collapseHintText, isToolTuiFullscreen, showMoreHintText } from "./show-more-hint.ts";
import { stripAnsi, stripBackgroundAnsi, stripLeadingStatusIcon } from "../../utils/ansi-text.ts";
import { walkComponentTree } from "../../utils/component-tree.ts";
import {
	fitToolCallSummary,
	backgroundTaskTitle,
	humanizeToolLabel,
	renderToolSummary,
	toolCallSummary,
	type ToolCallSummary,
} from "./names.ts";
import { toolViewportWidth } from "./result.ts";
import {
	patchRegistry,
	TOOL_GROUPING_GENERATION_KEY as GENERATION_KEY,
	TOOL_GROUPING_PARENT_KEY as PARENT_KEY,
	TOOL_GROUPING_PATCH_KEY as PATCH_KEY,
} from "../../utils/patch-keys.ts";

const NON_GROUPABLE = new Set(["edit", "write", "apply_patch", "exit_plan_mode", "finish_plan"]);

type Patch = {
	owner: object;
	active: boolean;
	prototype: any;
	original: { addChild: Function; removeChild: Function; clear: Function };
	installed: { addChild: Function; removeChild: Function; clear: Function };
	groups: Set<ToolGroupComponent>;
	enabled: () => boolean;
	generation: number;
	lastEnabled: boolean;
	theme?: any;
	animationTimer: ReturnType<typeof setTimeout> | null;
};

function toolName(tool: any): string {
	return String(tool?.toolName ?? tool?.toolDefinition?.name ?? "tool");
}

/**
 * Title: MCP tools use the real tool name exposed by the adapter; others fall back to the humanized tool name.
 */
function toolTitle(tool: any): string {
	const name = toolName(tool);
	return (
		mcpToolTitle({
			toolName: name,
			definition: tool?.toolDefinition ?? tool?.builtInToolDefinition,
		}) ??
		backgroundTaskTitle(name) ??
		humanizeToolLabel(name)
	);
}

function isGroupable(value: unknown): boolean {
	return value instanceof ToolExecutionComponent && !NON_GROUPABLE.has(toolName(value));
}

function isIgnorable(value: unknown): boolean {
	if (value instanceof Spacer) return true;
	if (!(value instanceof AssistantMessageComponent)) return false;
	const children = (value as any).contentContainer?.children;
	return Array.isArray(children) && children.length === 0;
}

function previousSibling(
	children: any[],
	start: number,
): { child: any; index: number } | undefined {
	let skipped = 0;
	for (let index = start; index >= 0; index--) {
		const child = children[index];
		if (isIgnorable(child) && skipped < 3) {
			skipped++;
			continue;
		}
		return { child, index };
	}
	return undefined;
}

type ToolStatus = "pending" | "success" | "error";

function status(tool: any): ToolStatus {
	if (tool?.result?.isError) return "error";
	if (tool?.isPartial === true || (tool?.executionStarted && !tool?.result)) return "pending";
	return tool?.result ? "success" : "pending";
}

function statusIcon(value: ToolStatus): string {
	if (value === "success") return "✓";
	if (value === "error") return "✗";
	return toolLoadingIcon();
}

function scheduleGroupAnimation(patch: Patch): void {
	if (patch.animationTimer || !patch.active) return;
	patch.animationTimer = setTimeout(() => {
		patch.animationTimer = null;
		if (!patch.active) return;
		let needsRender = false;
		for (const group of patch.groups) {
			if (
				(group.children as any[]).some(
					(tool) => tool?.executionStarted && status(tool) === "pending",
				)
			) {
				group.invalidate();
				// Group cards are not ToolExecutionComponent: their invalidate() doesn't request a render;
				// without this step the spinner only advances when something else renders (stutters/freezes under parallel tools).
				needsRender = true;
			}
		}
		if (needsRender) requestAnimationRender(patch);
	}, TOOL_LOADING_INTERVAL_MS);
	patch.animationTimer.unref?.();
}

/** Borrow a child tool card's ui to request a frame; falls back to the extension-held TUI slot when no child card exists. */
function requestAnimationRender(patch: Patch): void {
	for (const group of patch.groups) {
		const ui = (group.children as any[]).find(
			(tool) => typeof tool?.ui?.requestRender === "function",
		)?.ui;
		if (ui) {
			ui.requestRender();
			return;
		}
	}
	getToolMouseTui()?.requestRender?.();
}

/** Kitty (APC `G`) or iTerm2 (OSC 1337 File) image sequence: pi-tui's Image puts one on a single row. */
const IMAGE_SEQUENCE_RE = /\x1b_G|\x1b\]1337;File=/;

/** Text rows of a child paint. Image rows are dropped: they are drawn once, below the group, by toolImageLines. */
function visibleLines(lines: string[]): string[] {
	return lines.filter((line) => !IMAGE_SEQUENCE_RE.test(line) && stripAnsi(line).trim());
}

/** Indent of image rows under a group, lining them up with the child rows' content. */
const IMAGE_INDENT = "   ";

/**
 * Images in a tool's result (pi's ToolExecutionComponent keeps them in imageComponents, already
 * filtered by the showImages setting and the terminal's capabilities), each after a blank row.
 * Group rows summarise their children, so without this an image read inside a group never draws.
 */
function toolImageLines(tool: any, width: number): string[] {
	const images: unknown[] = Array.isArray(tool?.imageComponents) ? tool.imageComponents : [];
	const lines: string[] = [];
	for (const image of images) {
		let rendered: unknown;
		try {
			rendered = (image as Component | undefined)?.render?.(Math.max(1, width - IMAGE_INDENT.length));
		} catch {
			continue;
		}
		if (!Array.isArray(rendered) || rendered.length === 0) continue;
		lines.push("", ...rendered.map((line) => IMAGE_INDENT + String(line)));
	}
	return lines;
}

function stripLeadingSpaces(line: string, count: number): string {
	let offset = 0;
	let removed = 0;
	let ansi = "";
	while (offset < line.length) {
		const control = line.slice(offset).match(/^\x1b\[[0-?]*[ -/]*[@-~]/)?.[0];
		if (control) {
			ansi += control;
			offset += control.length;
			continue;
		}
		if (removed < count && line[offset] === " ") {
			removed++;
			offset++;
			continue;
		}
		break;
	}
	return ansi + line.slice(offset);
}

/** Build a slot background row filling width; bgAnsiOverride can replace the background ANSI (e.g. for brightening). */
export function paddedBackgroundRow(
	theme: any,
	slot: string,
	content: string,
	width: number,
	bgAnsiOverride?: string,
): string {
	const innerWidth = Math.max(0, width - 2);
	const clipped = truncateToWidth(stripBackgroundAnsi(content), innerWidth, "");
	const row = ` ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} `;
	const bgAnsi =
		bgAnsiOverride ||
		(typeof theme?.bg === "function"
			? theme.getBgAnsi?.(slot) || theme.bg(slot, "").match(/^\x1b\[[0-?]*[ -/]*[@-~]/)?.[0] || ""
			: "");
	const stable = bgAnsi ? row.replace(/\x1b\[(?:0)?m/g, (reset) => reset + bgAnsi) : row;
	if (!bgAnsi) return typeof theme?.bg === "function" ? theme.bg(slot, stable) : row;
	return `${bgAnsi}${stable}\x1b[49m`;
}

function toolSummary(tool: any): ToolCallSummary {
	return toolCallSummary(toolName(tool), tool?.args ?? {}, {
		title: toolTitle(tool),
		variant: "grouping",
		cwd: tool?.cwd,
	});
}

/**
 * codemode collapsed row: once there is a result, report that call's stats (same metrics as the single-card summary line),
 * so several long code preview rows in one card stay distinguishable. Falls back to the code preview before a result exists.
 */
function codemodeResultSummary(tool: any): ToolCallSummary | undefined {
	if (toolName(tool) !== CODEMODE_TOOL_NAME || !tool?.result) return undefined;
	const parts = codemodeSummaryParts(
		codemodeCalls(tool.result),
		codemodeOutputLineCount(tool.result),
		tool?.isPartial === true,
	);
	return { main: `${toolTitle(tool)} ${parts.join(" · ")}`, detail: "" };
}

function toolNameList(tools: any[]): string {
	const counts = new Map<string, number>();
	for (const tool of tools) counts.set(toolName(tool), (counts.get(toolName(tool)) ?? 0) + 1);
	return [...counts].map(([name, count]) => `${name}${count > 1 ? `×${count}` : ""}`).join(", ");
}

let nextGroupId = 1;

type SettledGroupCache = {
	width: number;
	hover: boolean;
	theme: unknown;
	fullscreen: boolean;
	children: readonly unknown[];
	args: unknown[];
	results: unknown[];
	lines: string[];
};

type ExpandedGroupCache = {
	width: number;
	hover: boolean;
	theme: unknown;
	fullscreen: boolean;
	/** Background slot participates in cache hit checks: already expanded groups must not keep the old background after a config change. */
	bgSlot: string;
	paints: readonly unknown[];
	lines: string[];
};

export class ToolGroupComponent extends Container {
	readonly toolCallId = `ccstyle-tool-group-${nextGroupId++}`;
	readonly toolName = "Tool group";
	private _expanded = false;
	/** Whether the group is expanded (read-only; for tests and external state reads). */
	get expanded(): boolean {
		return this._expanded;
	}
	private hintHovered = false;
	private readonly patch: Patch;
	/** Caches only completed, collapsed groups; pending ones are computed every frame. */
	private settledCache: SettledGroupCache | undefined;
	/** Expanded groups: reuse whole-card rows when child tool paint references are unchanged. */
	private expandedPaintCache: ExpandedGroupCache | undefined;

	constructor(patch: Patch) {
		super();
		this.patch = patch;
		patch.groups.add(this);
	}

	private clearPaintCache(): void {
		this.settledCache = undefined;
		this.expandedPaintCache = undefined;
	}

	addTool(tool: any): void {
		this.clearPaintCache();
		this.children.push(tool);
		tool[PARENT_KEY] = this;
	}

	releaseTools(): any[] {
		this.clearPaintCache();
		const tools = [...this.children];
		this.children.length = 0;
		this.patch.groups.delete(this);
		return tools;
	}

	removeTool(tool: any): void {
		this.clearPaintCache();
		const index = this.children.indexOf(tool);
		if (index >= 0) this.children.splice(index, 1);
		if (tool?.[PARENT_KEY] === this) delete tool[PARENT_KEY];
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) this.clearPaintCache();
		this._expanded = expanded;
		for (const tool of this.children)
			(tool as Component & { setExpanded?: (expanded: boolean) => void }).setExpanded?.(expanded);
	}

	setHintHovered(hovered: boolean): void {
		if (this.hintHovered !== hovered) this.clearPaintCache();
		this.hintHovered = hovered;
	}

	/**
	 * When expanded, locate the inner component by local row (null = row belongs to the group itself: blank/header/footer row).
	 * Row counting matches render: width width-2 + blank line filtering.
	 */
	childAtRow(localRow: number, width: number): { component: any; row: number } | null {
		if (!this._expanded || localRow < 2) return null;
		let offset = 2;
		for (const tool of this.children) {
			let lines: string[] = [];
			try {
				const rendered = tool.render?.(Math.max(1, width - 2));
				if (Array.isArray(rendered)) lines = visibleLines(rendered.map((line) => String(line)));
			} catch {
				lines = [];
			}
			const lineCount = Math.max(1, lines.length);
			if (localRow < offset + lineCount) {
				return { component: tool, row: localRow - offset };
			}
			offset += lineCount;
		}
		return null;
	}

	invalidate(): void {
		this.clearPaintCache();
		for (const tool of this.children) tool.invalidate?.();
	}

	private settledCacheHit(width: number): string[] | undefined {
		const cache = this.settledCache;
		if (!cache || this._expanded) return;
		// An image can change without a new result (a JPEG draws once pi's PNG transcoder has loaded), and
		// Image caches its own rows, so groups holding one always repaint.
		if ((this.children as any[]).some((tool) => tool?.imageComponents?.length)) return;
		if (
			cache.width !== width ||
			cache.hover !== this.hintHovered ||
			cache.theme !== this.patch.theme ||
			cache.fullscreen !== isToolTuiFullscreen()
		) {
			return;
		}
		const tools = this.children as any[];
		if (cache.children.length !== tools.length) return;
		for (let i = 0; i < tools.length; i++) {
			const tool = tools[i];
			if (
				cache.children[i] !== tool ||
				cache.args[i] !== tool?.args ||
				cache.results[i] !== tool?.result ||
				status(tool) === "pending"
			) {
				return;
			}
		}
		return cache.lines;
	}

	private storeSettledCache(width: number, lines: string[]): void {
		this.settledCache = {
			width,
			hover: this.hintHovered,
			theme: this.patch.theme,
			fullscreen: isToolTuiFullscreen(),
			children: [...this.children],
			args: (this.children as any[]).map((tool) => tool?.args),
			results: (this.children as any[]).map((tool) => tool?.result),
			lines,
		};
	}

	render(width: number): string[] {
		const cached = this.settledCacheHit(width);
		if (cached) return cached;
		const theme = this.patch.theme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const counts = { pending: 0, success: 0, error: 0 };
		for (const tool of this.children) counts[status(tool)]++;
		const countText = (["pending", "success", "error"] as const)
			.filter((key) => counts[key])
			.map((key) => {
				const label = key === "pending" ? "running" : key === "success" ? "done" : "failed";
				const color = key === "pending" ? "accent" : key;
				return `${fg(color, String(counts[key]))} ${label}`;
			})
			.join(` ${fg("dim", "·")} `);
		const names = new Set(this.children.map(toolName));
		const label = names.size === 1 ? toolTitle(this.children[0]) : "Multiple Tools";
		const overall: ToolStatus = counts.error ? "error" : counts.pending ? "pending" : "success";
		if (
			(this.children as any[]).some((tool) => tool?.executionStarted && status(tool) === "pending")
		)
			scheduleGroupAnimation(this.patch);
		const overallColor = overall === "pending" ? "accent" : overall;
		const nameList = names.size > 1 ? ` ${fg("dim", `· ${toolNameList(this.children)}`)}` : "";
		// Dot stays dim; hover only highlights the clickable text.
		const hintText = this._expanded ? collapseHintText() : showMoreHintText();
		const hint = `${fg("dim", "·")} ${fg(this.hintHovered ? "text" : "dim", hintText)}`;
		const lines = [
			"",
			truncateToWidth(
				` ${fg(overallColor, "●")} ${label}: ${countText}${nameList} ${hint}`,
				toolViewportWidth(width),
				"…",
			),
		];
		const total = this.children.length;
		const childPaints = this._expanded
			? (this.children as any[]).map((tool) => tool.render?.(Math.max(1, width - 2)))
			: undefined;
		if (this._expanded && childPaints) {
			const expandedHit = this.expandedPaintCache;
			if (
				expandedHit &&
				expandedHit.width === width &&
				expandedHit.hover === this.hintHovered &&
				expandedHit.theme === this.patch.theme &&
				expandedHit.fullscreen === isToolTuiFullscreen() &&
				expandedHit.bgSlot === config.expandedCardBackground &&
				expandedHit.paints.length === childPaints.length &&
				expandedHit.paints.every((paint, index) => paint === childPaints[index])
			) {
				return expandedHit.lines;
			}
		}
		const expandedLines: string[] = [];
		for (let index = 0; index < total; index++) {
			const tool = this.children[index];
			const toolStatus = status(tool);
			const color = toolStatus === "pending" ? "accent" : toolStatus;
			const branch = index === total - 1 ? "└" : "├";
			const continuation = index === total - 1 ? "  " : "│ ";
			if (!this._expanded) {
				const summary = codemodeResultSummary(tool) ?? toolSummary(tool);
				const prefix = ` ${fg("dim", branch)} ${fg(color, statusIcon(toolStatus))} `;
				const detail = fg("dim", summary.detail);
				// Same width as single tool card titles, so the wide-screen right margin matches
				const rowWidth = toolViewportWidth(width);
				const mainWidth = Math.max(0, rowWidth - visibleWidth(prefix) - visibleWidth(detail));
				lines.push(
					truncateToWidth(
						`${prefix}${renderToolSummary(summary, mainWidth, fg)}${detail}`,
						rowWidth,
						"",
					),
				);
				continue;
			}
			const rendered = visibleLines(Array.isArray(childPaints?.[index]) ? childPaints[index] : []);
			if (rendered.length) {
				rendered[0] = stripLeadingStatusIcon(rendered[0])
					.replace(/^ +/, "")
					.replace(/^((?:\x1b\[[0-?]*[ -/]*[@-~])*) +/, "$1");
			}
			const childLines = rendered.length ? rendered : [toolSummary(tool).main];
			for (let lineIndex = 0; lineIndex < childLines.length; lineIndex++) {
				const content =
					// Continuation lines only strip the outer Box's 1-cell left pad, preserving Input/Output relative indent
					lineIndex === 0 ? childLines[lineIndex] : stripLeadingSpaces(childLines[lineIndex], 1);
				const prefix =
					lineIndex === 0
						? `${fg("dim", branch)} ${fg(color, statusIcon(toolStatus))} `
						: fg("dim", continuation);
				expandedLines.push(prefix + content);
			}
		}
		if (this._expanded) {
			// Expanded panels use a single background slot (ccstyle convention), not varied by state.
			const backgroundSlot = config.expandedCardBackground;
			for (const line of expandedLines) {
				lines.push(paddedBackgroundRow(theme, backgroundSlot, line, width));
			}
			lines.push(paddedBackgroundRow(theme, backgroundSlot, "", width));
			for (const tool of this.children) lines.push(...toolImageLines(tool, width));
			this.expandedPaintCache = {
				width,
				hover: this.hintHovered,
				theme: this.patch.theme,
				fullscreen: isToolTuiFullscreen(),
				bgSlot: backgroundSlot,
				paints: childPaints ?? [],
				lines,
			};
		} else {
			for (const tool of this.children) lines.push(...toolImageLines(tool, width));
		}
		if (!this._expanded && counts.pending === 0) {
			this.storeSettledCache(width, lines);
		}
		return lines;
	}
}

function ungroup(patch: Patch): void {
	for (const group of [...patch.groups]) {
		const parent = (group as any)[PARENT_KEY];
		const children = parent?.children;
		if (!Array.isArray(children)) {
			patch.groups.delete(group);
			continue;
		}
		const index = children.indexOf(group);
		if (index < 0) {
			patch.groups.delete(group);
			continue;
		}
		const tools = group.releaseTools();
		for (const tool of tools) tool[PARENT_KEY] = parent;
		children.splice(index, 1, ...tools);
	}
}

function normalizeGroup(patch: Patch, group: ToolGroupComponent): void {
	if (group.children.length > 1) return;
	const parent = (group as any)[PARENT_KEY];
	const index = parent?.children?.indexOf(group) ?? -1;
	const tools = group.releaseTools();
	delete (group as any)[PARENT_KEY];
	if (index < 0) {
		for (const tool of tools) delete tool[PARENT_KEY];
		return;
	}
	if (tools.length === 1) {
		tools[0][PARENT_KEY] = parent;
		parent.children.splice(index, 1, tools[0]);
	} else {
		parent.children.splice(index, 1);
	}
}

function maybeGroup(patch: Patch, parent: any, component: any): void {
	if (
		!patch.active ||
		!patch.enabled() ||
		parent instanceof ToolGroupComponent ||
		!isGroupable(component)
	)
		return;
	component[GENERATION_KEY] = patch.generation;
	const children = parent?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(component);
	const prior = previousSibling(children, index - 1);
	if (!prior) return;
	if (prior.child instanceof ToolGroupComponent && (prior.child as any).patch === patch) {
		children.splice(index, 1);
		prior.child.addTool(component);
		return;
	}
	if (!isGroupable(prior.child) || prior.child[GENERATION_KEY] !== patch.generation) return;
	const group = new ToolGroupComponent(patch);
	group.addTool(prior.child);
	group.addTool(component);
	(group as any)[PARENT_KEY] = parent;
	children[prior.index] = group;
	children.splice(index, 1);
}

/** /reload doesn't re-run addChild; scan current mounted roots and feed existing tools back through the same grouping rules. */
function regroup(patch: Patch, root: any): void {
	if (!patch.active || !patch.enabled() || !root) return;
	walkComponentTree(root, (value: any) => {
		// Group cards and groupable tools are grouping boundaries: don't descend further (matches the original traversal filter).
		if (value instanceof ToolGroupComponent || isGroupable(value)) return false;
		const children = value.children;
		if (Array.isArray(children)) {
			for (const child of [...children]) {
				if (child && typeof child === "object") child[PARENT_KEY] = value;
				maybeGroup(patch, value, child);
			}
		}
	});
}

export type ToolGroupingHooks = {
	setTheme(theme: any): void;
	refresh(root?: any): void;
	shutdown(): void;
};

export function installToolGrouping(getEnabled: () => boolean): ToolGroupingHooks {
	const prototype = Container.prototype as any;
	const previous = patchRegistry.get<Patch>(PATCH_KEY);
	if (previous) {
		previous.active = false;
		previous.enabled = () => false;
		if (previous.animationTimer) clearTimeout(previous.animationTimer);
		previous.animationTimer = null;
		ungroup(previous);
	}
	const original = {
		addChild:
			previous && prototype.addChild === previous.installed.addChild
				? previous.original.addChild
				: prototype.addChild,
		removeChild:
			previous && prototype.removeChild === previous.installed.removeChild
				? previous.original.removeChild
				: prototype.removeChild,
		clear:
			previous && prototype.clear === previous.installed.clear
				? previous.original.clear
				: prototype.clear,
	};
	const patch: Patch = {
		owner: {},
		active: true,
		prototype,
		original,
		installed: undefined as any,
		groups: new Set(),
		enabled: getEnabled,
		generation: 0,
		lastEnabled: getEnabled(),
		animationTimer: null,
	};
	patch.installed = {
		addChild: function (this: any, component: any) {
			const result = patch.original.addChild.call(this, component);
			if (component && typeof component === "object") component[PARENT_KEY] = this;
			maybeGroup(patch, this, component);
			return result;
		},
		removeChild: function (this: any, component: any) {
			const group = component?.[PARENT_KEY];
			if (group instanceof ToolGroupComponent && (group as any)[PARENT_KEY] === this) {
				group.removeTool(component);
				normalizeGroup(patch, group);
				return;
			}
			const result = patch.original.removeChild.call(this, component);
			if (component?.[PARENT_KEY] === this) delete component[PARENT_KEY];
			if (this instanceof ToolGroupComponent) normalizeGroup(patch, this);
			if (component instanceof ToolGroupComponent) {
				for (const tool of component.releaseTools()) delete tool[PARENT_KEY];
			}
			return result;
		},
		clear: function (this: any) {
			for (const child of [...(this.children ?? [])]) {
				if (child instanceof ToolGroupComponent) {
					for (const tool of child.releaseTools()) delete tool[PARENT_KEY];
				}
				if (child?.[PARENT_KEY] === this) delete child[PARENT_KEY];
			}
			if (this instanceof ToolGroupComponent) patch.groups.delete(this);
			return patch.original.clear.call(this);
		},
	};
	prototype.addChild = patch.installed.addChild;
	prototype.removeChild = patch.installed.removeChild;
	prototype.clear = patch.installed.clear;
	patchRegistry.install(PATCH_KEY, patch);
	return {
		setTheme(theme: any) {
			patch.theme = theme;
		},
		refresh(root?: any) {
			const enabled = patch.enabled();
			if (enabled !== patch.lastEnabled) {
				patch.lastEnabled = enabled;
				if (enabled) patch.generation++;
			}
			if (enabled) regroup(patch, root);
			else ungroup(patch);
		},
		shutdown() {
			if (!patch.active) return;
			patch.active = false;
			if (patch.animationTimer) clearTimeout(patch.animationTimer);
			patch.animationTimer = null;
			patch.enabled = () => false;
			ungroup(patch);
			if (prototype.addChild === patch.installed.addChild)
				prototype.addChild = patch.original.addChild;
			if (prototype.removeChild === patch.installed.removeChild)
				prototype.removeChild = patch.original.removeChild;
			if (prototype.clear === patch.installed.clear) prototype.clear = patch.original.clear;
		},
	};
}
