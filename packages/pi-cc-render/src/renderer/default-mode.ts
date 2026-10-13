/**
 * default mode (config.mode === "on"): Claude Code style tool card rendering.
 *
 * Takes over call/result via a ToolExecutionComponent prototype patch; edit/write use rich diff.
 * Lifecycle matches compact-mode: installDefaultMode -> hooks.shutdown.
 */
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config, getToolDisplayConfig, type CompactStyleMode } from "../config/config.ts";
import {
	COMPONENT_TOOL_RENDER_MODE,
	GLOBAL_TOOL_RENDER_PATCH,
	patchRegistry,
	TOOL_EXPANDED_BACKGROUND_PATCH,
} from "../utils/patch-keys.ts";
import { isToolCallHovered } from "./mouse/hover.ts";
import {
	countLines,
	hasExpandableDetail,
	insetComponent,
	isToolExpanded,
	outputLineCount,
	pendingIcon,
	renderCollapsedToolResultToWidth,
	renderExpandedToolResult,
	resolveToolVisualState,
	scheduleAnimation,
	settledIcon,
	setToolVisualState,
	textFromResult,
	toolIconColor,
	toolViewportWidth,
} from "./tool/result.ts";
import { oneLine } from "../utils/format.ts";
import { showMoreHintText } from "./tool/show-more-hint.ts";
import {
	CODEMODE_TOOL_NAME,
	codemodeExpandedBody,
	createCodemodeResultComponent,
} from "./tool/codemode.ts";
import { countWriteDiffStats } from "./tool/diff/diff-renderer.ts";
import { renderRichToolResult, type WriteExecutionMetadataStore } from "./tool/diff/index.ts";
import { getMessageDisplayTheme } from "./tool/message-display.ts";
import { mcpToolTitle } from "./tool/mcp-title.ts";
import {
	fitToolCallSummary,
	humanizeToolLabel,
	renderToolSummary,
	toolCallSummary,
} from "./tool/names.ts";

// Success checkmark: bright green truecolor (consistent with message-display)
const BRIGHT_GREEN = "\x1b[38;2;80;220;100m";
const ANSI_FG_RESET = "\x1b[39m";

// Extensions such as pi-subagents provide a dedicated renderer for Agent; ccstyle must keep it.
const DEDICATED_RENDERER_TOOLS = new Set(["Agent"]);

export type DefaultModeHooks = {
	/** Whether this installation still holds the global tool rendering patch. */
	isOwner(): boolean;
	shutdown(): void;
};

type ToolRenderMethods = {
	hasRendererDefinition: (...args: any[]) => boolean;
	getRenderShell: (...args: any[]) => "default" | "self";
	getCallRenderer: (...args: any[]) => any;
	getResultRenderer: (...args: any[]) => any;
};

type ToolPaintHit = {
	width: number;
	expanded: boolean;
	isPartial: boolean;
	result: unknown;
	args: unknown;
	callHover: boolean;
	ioHover: string | null;
	lines: string[];
};

type GlobalToolRenderPatch = {
	version: 2;
	prototype: any;
	active: boolean;
	mode: () => CompactStyleMode;
	wrap: (tool: any) => any;
	byDefinition: WeakMap<object, any>;
	byName: Map<string, any>;
	downstream: ToolRenderMethods;
	installed: ToolRenderMethods;
	originalRender?: (width: number) => string[];
	originalInvalidate?: () => void;
	renderPaint?: (width: number) => string[];
	invalidatePaint?: () => void;
	paintCache?: WeakMap<object, ToolPaintHit>;
};

type ToolExpandedBackgroundPatch = {
	active: boolean;
	prototype: any;
	installed: (...args: any[]) => void;
	original: (...args: any[]) => void;
	dispose: () => void;
};

/** Both rich diff entry points (here and compact's paintCompactEditWrite) rely on renderRichToolResult
  * returning undefined to yield; this only checks mode and tool name, avoiding an extra gate that could disagree with the yield. */
export function shouldRenderRichDiff(
	mode: CompactStyleMode,
	toolName: string,
	isError: boolean,
): boolean {
	return mode === "on" && !isError && (toolName === "edit" || toolName === "write");
}

/** Tools on the exclusion list that ship their own renderer keep their original rendering. */
export function preservesOriginalRenderer(
	extensionDefinition: any,
	toolName: string,
	builtInToolDefinition?: any,
	excludeRenderers: readonly string[] = config.excludeRenderers,
): boolean {
	if (!excludeRenderers.includes(toolName)) return false;
	return [extensionDefinition, builtInToolDefinition].some(
		(definition) =>
			definition?.renderShell === "self" ||
			typeof definition?.renderCall === "function" ||
			typeof definition?.renderResult === "function",
	);
}

function renderDefault(tool: any, slot: "renderCall" | "renderResult", args: any[], fallback = "") {
	try {
		if (typeof tool?.[slot] === "function") return tool[slot](...args);
	} catch {
		// Fall through to raw fallback.
	}
	return new Text(fallback, 0, 0);
}

type ParsedTask = { id: string; status: string; subject: string };

function parseTaskList(text: string): ParsedTask[] {
	return text
		.split("\n")
		.map((line) => line.match(/^#(\d+) \[([^\]]+)] (.+)$/))
		.filter((match): match is RegExpMatchArray => Boolean(match))
		.map((match) => ({ id: match[1]!, status: match[2]!, subject: match[3]! }));
}

function taskListSummary(tasks: ParsedTask[]): string {
	const counts = { pending: 0, in_progress: 0, completed: 0 };
	for (const task of tasks) {
		if (task.status in counts) counts[task.status as keyof typeof counts]++;
	}
	return [
		`${tasks.length} tasks`,
		counts.in_progress ? `${counts.in_progress} in progress` : "",
		counts.pending ? `${counts.pending} pending` : "",
		counts.completed ? `${counts.completed} completed` : "",
	]
		.filter(Boolean)
		.join(" · ");
}

function renderExpandedTaskResult(
	toolName: string,
	text: string,
	theme: any,
	isError: boolean,
): any | undefined {
	if (isError) return undefined;
	if (toolName === "TaskList") {
		const tasks = parseTaskList(text);
		if (!tasks.length) return undefined;
		const limit = Math.max(1, config.expandedPreviewMaxLines);
		const rows = tasks.slice(0, limit).map((task) => {
			const color =
				task.status === "completed"
					? "success"
					: task.status === "in_progress"
						? "warning"
						: "muted";
			return `${theme.fg("accent", `#${task.id}`)} ${theme.fg(color, task.status)} ${theme.fg("dim", task.subject)}`;
		});
		if (tasks.length > rows.length)
			rows.push(theme.fg("muted", `… ${tasks.length - rows.length} more tasks`));
		// Flush left: the outer expanded card Box(1,1) provides 1 cell of padding
		return new Text(
			`↳ ${theme.fg("muted", taskListSummary(tasks))}\n${rows.map((r) => `  ${r}`).join("\n")}`,
			0,
			0,
		);
	}
	const line = text.trim();
	if (!line || line.includes("\n")) return undefined;
	let formatted: string | undefined;
	let match: RegExpMatchArray | null;
	if (
		toolName === "TaskCreate" &&
		(match = line.match(/^Task #(\d+) created successfully: (.+)$/))
	) {
		formatted = `${theme.fg("success", "Created task")} ${theme.fg("accent", `#${match[1]}`)} ${theme.fg("muted", match[2])}`;
	} else if (toolName === "TaskUpdate" && (match = line.match(/^Updated task #(\d+) (.+)$/))) {
		formatted = `${theme.fg("success", "Updated task")} ${theme.fg("accent", `#${match[1]}`)} ${theme.fg("muted", match[2])}`;
	} else if (toolName === "TaskExecute") {
		formatted = `${theme.fg("success", "Started")} ${theme.fg("muted", line)}`;
	} else if (toolName === "TaskStop") {
		formatted = `${theme.fg("success", "Stopped")} ${theme.fg("muted", line)}`;
	}
	return formatted ? new Text(`↳ ${formatted}`, 0, 0) : undefined;
}

/** Wraps any tool definition with ccstyle call/result. */
function createCcstyleTool(
	originalTool: any,
	writeExecutionMetadata: WriteExecutionMetadataStore,
): any {
	const toolName = originalTool.name;
	const label = originalTool.label || toolName;
	const defaultTitle = label === toolName ? humanizeToolLabel(label) : label;
	// MCP tools use the real tool name exposed by the adapter, without humanizing it
	const title = mcpToolTitle({ toolName, definition: originalTool }) ?? defaultTitle;

	return {
		...originalTool,
		renderShell: "self",
		renderCall(args: any, theme: any, context: any) {
			if (config.mode === "off") {
				return renderDefault(originalTool, "renderCall", [args, theme, context], String(toolName));
			}

			const visualState = resolveToolVisualState(context);
			const isPending =
				visualState === "pending" ||
				(!visualState && (context?.isPartial || context?.executionStarted));
			const animating = isPending && Boolean(context?.executionStarted);
			if (animating) scheduleAnimation(context, { light: true });
			const settledRawIcon = isPending ? "" : settledIcon(toolName, visualState);
			const settledIconStyled =
				visualState === "success"
					? `${BRIGHT_GREEN}${settledRawIcon}${ANSI_FG_RESET}`
					: theme.fg(toolIconColor(context), settledRawIcon);
			// Per-frame spinner: the frame is taken inside render(); the animation timer only needs requestRender,
			// no longer rebuilding the whole card through updateDisplay on every tick.
			const pendingIconStyled = () => theme.fg(toolIconColor(context), pendingIcon(toolName));
			const summary = toolCallSummary(toolName, args, {
				title,
				variant: "default",
				cwd: context?.cwd,
			});
			let writeStatsText = "";
			let writeStatsStyled = "";
			if (toolName === "write" && visualState === "success") {
				const meta = writeExecutionMetadata.get(context?.toolCallId);
				const stats = countWriteDiffStats(
					typeof args?.content === "string" ? args.content : undefined,
					meta?.previousContent,
					meta?.fileExistedBeforeWrite,
				);
				if (stats) {
					writeStatsText = ` (+${stats.added} -${stats.removed})`;
					writeStatsStyled = ` ${theme.fg("dim", "(")}${theme.fg("success", `+${stats.added}`)} ${theme.fg("error", `-${stats.removed}`)}${theme.fg("dim", ")")}`;
				}
			}
			const extraText = writeStatsText || summary.detail;
			const extraStyled = writeStatsStyled || theme.fg("dim", summary.detail);
			let cachedWidth: number | undefined;
			let cachedLine: string | undefined;
			let cachedIcon: string | undefined;
			const expanded = Boolean(context?.expanded);
			return {
				render(width: number) {
					// A lightweight tick only calls requestRender; renewing here keeps the animation self-sustaining.
					if (animating) scheduleAnimation(context, { light: true });
					const icon = isPending ? pendingIconStyled() : settledIconStyled;
					if (cachedLine !== undefined && cachedWidth === width && cachedIcon === icon) {
						return [cachedLine];
					}
					const viewportWidth = toolViewportWidth(width);
					// Expanded state flush left (outer Box already pads 1); collapsed self-shell keeps 1 leading space
					const lead = expanded ? "" : " ";
					const callWidth = Math.max(
						0,
						viewportWidth - visibleWidth(icon) - 1 - (expanded ? 0 : 1),
					);
					const mainWidth = Math.max(0, callWidth - visibleWidth(extraText));
					cachedWidth = width;
					cachedIcon = icon;
					// Truncate the path in the middle to the final available width, so a second truncation of the whole line does not hide the file name.
					cachedLine = `${lead}${icon} ${renderToolSummary(summary, mainWidth, theme.fg.bind(theme))}${extraStyled}`;
					return [truncateToWidth(cachedLine, viewportWidth, "")];
				},
				invalidate() {
					cachedLine = undefined;
					cachedIcon = undefined;
				},
			};
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (config.mode === "off") {
				return renderDefault(
					originalTool,
					"renderResult",
					[result, options, theme, context],
					textFromResult(result),
				);
			}

			const expanded = isToolExpanded(options, context);
			const isError = Boolean(options?.isError || context?.isError);
			// codemode: collapsed draws its own sub-call tree; expanded shows all sub-calls and the output without the script header
			if (toolName === CODEMODE_TOOL_NAME) {
				if (!options?.isPartial) setToolVisualState(context, isError ? "error" : "success");
				if (expanded) {
					return renderExpandedToolResult(
						codemodeExpandedBody(result),
						theme,
						isError,
						context?.lastComponent,
						context?.args,
						context,
						true,
					);
				}
				// Collapsed no longer reuses the expanded view, so hover/mouse hits do not point at a hidden component
				if (context?.state) context.state.ccstyleIoView = undefined;
				const toolCallId = context?.toolCallId;
				return createCodemodeResultComponent({
					result,
					theme,
					running: Boolean(options?.isPartial),
					isError,
					isHovered: () => isToolCallHovered(toolCallId),
				});
			}
			if (options?.isPartial) {
				// Expanded flush left (Box provides 1 cell of padding); collapsed keeps 3-cell alignment with the title
				const pending = expanded ? "↳ Pending…" : "   ↳ Pending…";
				return new Text(theme.fg("muted", pending), 0, 0);
			}

			setToolVisualState(context, isError ? "error" : "success");
			const toolCallId = context?.toolCallId;
			if (shouldRenderRichDiff(config.mode, toolName, Boolean(isError))) {
				// The getter makes Diff indicator / wrap / limits take effect on the next paint
				const richResult = renderRichToolResult(
					toolName,
					result,
					{
						...options,
						expanded,
						// Global shared state keeps old result renderer closures from getting lost after /reload
						isHovered: () => isToolCallHovered(toolCallId),
					},
					theme,
					context,
					writeExecutionMetadata,
					getToolDisplayConfig,
				);
				// Expanded padding is provided by Box(1,1); collapsed insets one indent level
				if (richResult) return expanded ? richResult : insetComponent(richResult);
			}

			const text = textFromResult(result, expanded);
			const args = context?.args;
			if (expanded) {
				const taskResult = renderExpandedTaskResult(toolName, text, theme, Boolean(isError));
				if (taskResult) return taskResult;
			}
			const tasks = !isError && toolName === "TaskList" ? parseTaskList(text) : [];
			const outputLines = outputLineCount(result) || countLines(text);
			const lineWord = outputLines === 1 ? "line" : "lines";
			const action = toolName === "read" ? "loaded" : "returned";
			const rendered = tasks.length
				? taskListSummary(tasks)
				: isError
					? text
						? // 72 matches the original result.ts default, keeping the error summary truncation width.
							oneLine(text, 72)
						: "Failed"
					: outputLines
						? `${outputLines} ${lineWord} ${action}`
						: "Done";
			const expandable = !expanded && (tasks.length > 0 || hasExpandableDetail(text, args));
			const hintText = showMoreHintText();
			const hintPrefix = expandable ? theme.fg("dim", " · ") : "";
			const hint = expandable ? hintPrefix + theme.fg("dim", hintText) : "";
			const hoveredHint = expandable ? hintPrefix + theme.fg("text", hintText) : "";
			if (expanded) {
				return renderExpandedToolResult(
					text || "",
					theme,
					Boolean(isError),
					context?.lastComponent,
					args,
					context,
					true, // mode=on: flush left, outer Box(1,1) provides 1 cell of padding
				);
			}
			if (context?.state) context.state.ccstyleIoView = undefined;
			let cachedWidth: number | undefined;
			let cachedLine: string | undefined;
			let cachedHoveredLine: string | undefined;
			return {
				render(width: number) {
					if (cachedLine === undefined || cachedWidth !== width) {
						cachedWidth = width;
						cachedLine = theme.fg(
							isError ? "error" : "muted",
							renderCollapsedToolResultToWidth(rendered, hint, width),
						);
						cachedHoveredLine = theme.fg(
							isError ? "error" : "muted",
							renderCollapsedToolResultToWidth(rendered, hoveredHint, width),
						);
					}
					return [isToolCallHovered(toolCallId) ? cachedHoveredLine! : cachedLine];
				},
				invalidate() {},
			};
		},
	};
}

function syncToolShell(component: any, shell: "default" | "self"): void {
	const target = shell === "self" ? component.selfRenderContainer : component.contentBox;
	if (!target || !Array.isArray(component.children)) return;
	const candidates = new Set(
		[component.contentText, component.contentBox, component.selfRenderContainer].filter(Boolean),
	);
	const indexes = component.children
		.map((child: any, index: number) => (candidates.has(child) ? index : -1))
		.filter((index: number) => index >= 0);
	const targetIndex = indexes[0];
	// During construction getRenderShell runs before Pi mounts the shell; do not mount here, or the constructor would add it twice.
	if (targetIndex === undefined) return;
	component.children[targetIndex] = target;
	for (const index of indexes.sort((left: number, right: number) => right - left)) {
		if (index !== targetIndex) component.children.splice(index, 1);
	}
}

function shouldGloballyStyleTool(component: any, patch: GlobalToolRenderPatch): boolean {
	const extensionDefinition = component.toolDefinition;
	const builtInDefinition = component.builtInToolDefinition;
	const definition = extensionDefinition ?? builtInDefinition;
	const toolName = String(component.toolName || definition?.name || "");
	// compact also reuses the same ccstyle call/result, so collapsed tool cards do not fall back to Pi's native style.
	const useCcstyle =
		patch.mode() !== "off" &&
		!DEDICATED_RENDERER_TOOLS.has(toolName) &&
		!preservesOriginalRenderer(extensionDefinition, toolName, builtInDefinition);
	component[COMPONENT_TOOL_RENDER_MODE] = useCcstyle;
	return useCcstyle;
}

function getGloballyStyledTool(component: any, patch: GlobalToolRenderPatch): any {
	const definition = component.toolDefinition ?? component.builtInToolDefinition;
	if (definition && typeof definition === "object") {
		let wrapped = patch.byDefinition.get(definition);
		if (!wrapped) {
			wrapped = patch.wrap(definition);
			patch.byDefinition.set(definition, wrapped);
		}
		return wrapped;
	}

	const name = String(component.toolName || "tool");
	let wrapped = patch.byName.get(name);
	if (!wrapped) {
		wrapped = patch.wrap({ name, label: name });
		patch.byName.set(name, wrapped);
	}
	return wrapped;
}

function prototypeToolRenderMethods(prototype: any): ToolRenderMethods {
	return {
		hasRendererDefinition: prototype.hasRendererDefinition,
		getRenderShell: prototype.getRenderShell,
		getCallRenderer: prototype.getCallRenderer,
		getResultRenderer: prototype.getResultRenderer,
	};
}

function isOwnershipAwarePatch(value: any): value is GlobalToolRenderPatch {
	if (!value || value.version !== 2 || !value.installed || !value.downstream) return false;
	return ["hasRendererDefinition", "getRenderShell", "getCallRenderer", "getResultRenderer"].every(
		(name) =>
			typeof value.installed[name] === "function" && typeof value.downstream[name] === "function",
	);
}

function downstreamForGlobalToolInstall(
	prototype: any,
	previous: GlobalToolRenderPatch | undefined,
): ToolRenderMethods {
	const current = prototypeToolRenderMethods(prototype);
	if (!previous || previous.prototype !== prototype || !isOwnershipAwarePatch(previous)) {
		return current;
	}
	return {
		hasRendererDefinition:
			current.hasRendererDefinition === previous.installed.hasRendererDefinition
				? previous.downstream.hasRendererDefinition
				: current.hasRendererDefinition,
		getRenderShell:
			current.getRenderShell === previous.installed.getRenderShell
				? previous.downstream.getRenderShell
				: current.getRenderShell,
		getCallRenderer:
			current.getCallRenderer === previous.installed.getCallRenderer
				? previous.downstream.getCallRenderer
				: current.getCallRenderer,
		getResultRenderer:
			current.getResultRenderer === previous.installed.getResultRenderer
				? previous.downstream.getResultRenderer
				: current.getResultRenderer,
	};
}

function disconnectGlobalToolRenderPatch(patch: GlobalToolRenderPatch | undefined): void {
	if (!patch) return;
	patch.active = false;
	patch.byDefinition = new WeakMap();
	patch.byName.clear();
}

function ioHoverOf(tool: any): string | null {
	const view = tool?.resultRendererComponent;
	if (!view || typeof view.getHoveredSection !== "function") return null;
	return view.getHoveredSection();
}

function toolPaintMatches(hit: ToolPaintHit, tool: any, width: number): boolean {
	return (
		hit.width === width &&
		hit.expanded === Boolean(tool.expanded) &&
		hit.isPartial === Boolean(tool.isPartial) &&
		hit.result === tool.result &&
		hit.args === tool.args &&
		hit.callHover === isToolCallHovered(tool.toolCallId) &&
		hit.ioHover === ioHoverOf(tool)
	);
}

function installGlobalToolRendering(
	writeExecutionMetadata: WriteExecutionMetadataStore,
): GlobalToolRenderPatch {
	const prototype = (ToolExecutionComponent as any).prototype;
	const previous = patchRegistry.get<GlobalToolRenderPatch>(GLOBAL_TOOL_RENDER_PATCH);
	const downstream = downstreamForGlobalToolInstall(prototype, previous);
	const originalRender =
		previous?.originalRender && prototype.render === previous.renderPaint
			? previous.originalRender
			: prototype.render;
	const originalInvalidate =
		previous?.originalInvalidate && prototype.invalidate === previous.invalidatePaint
			? previous.originalInvalidate
			: prototype.invalidate;
	if (isOwnershipAwarePatch(previous)) disconnectGlobalToolRenderPatch(previous);

	const patch: GlobalToolRenderPatch = {
		version: 2,
		prototype,
		active: true,
		mode: () => config.mode,
		wrap: (tool: any) => createCcstyleTool(tool, writeExecutionMetadata),
		byDefinition: new WeakMap(),
		byName: new Map(),
		downstream,
		installed: undefined as any,
		originalRender,
		originalInvalidate,
		paintCache: new WeakMap(),
	};

	patch.installed = {
		hasRendererDefinition: function (this: any, ...args: any[]) {
			if (patch.active && shouldGloballyStyleTool(this, patch)) return true;
			return patch.downstream.hasRendererDefinition.apply(this, args);
		},
		getRenderShell: function (this: any, ...args: any[]) {
			if (!patch.active) return patch.downstream.getRenderShell.apply(this, args);
			const useCcstyle = shouldGloballyStyleTool(this, patch);
			const shell = useCcstyle
				? this.expanded
					? "default"
					: "self"
				: patch.downstream.getRenderShell.apply(this, args);
			syncToolShell(this, shell);
			return shell;
		},
		getCallRenderer: function (this: any, ...args: any[]) {
			if (patch.active && shouldGloballyStyleTool(this, patch)) {
				return getGloballyStyledTool(this, patch).renderCall;
			}
			return patch.downstream.getCallRenderer.apply(this, args);
		},
		getResultRenderer: function (this: any, ...args: any[]) {
			if (patch.active && shouldGloballyStyleTool(this, patch)) {
				return getGloballyStyledTool(this, patch).renderResult;
			}
			return patch.downstream.getResultRenderer.apply(this, args);
		},
	};

	prototype.hasRendererDefinition = patch.installed.hasRendererDefinition;
	prototype.getRenderShell = patch.installed.getRenderShell;
	prototype.getCallRenderer = patch.installed.getCallRenderer;
	prototype.getResultRenderer = patch.installed.getResultRenderer;
	// Fullscreen scrolling/selection renders the whole tree every frame; reuse the previous frame's lines when content is unchanged, avoiding redoing diff/Box.
	patch.renderPaint = function (this: any, width: number): string[] {
		if (!patch.active || patch.mode() === "off") {
			return originalRender.call(this, width);
		}
		const cache = patch.paintCache;
		// A running partial tool owns a time-varying spinner. Light animation ticks
		// request a repaint without invalidating the component, so settled-content
		// caching must not intercept those paints.
		const cacheable = !(this.executionStarted && this.isPartial);
		const hit = cacheable ? cache?.get(this) : undefined;
		if (hit && toolPaintMatches(hit, this, width)) return hit.lines;
		const lines = originalRender.call(this, width);
		if (cacheable) {
			cache?.set(this, {
				width,
				expanded: Boolean(this.expanded),
				isPartial: Boolean(this.isPartial),
				result: this.result,
				args: this.args,
				callHover: isToolCallHovered(this.toolCallId),
				ioHover: ioHoverOf(this),
				lines,
			});
		} else {
			cache?.delete(this);
		}
		return lines;
	};
	patch.invalidatePaint = function (this: any): void {
		patch.paintCache?.delete(this);
		originalInvalidate.call(this);
	};
	prototype.render = patch.renderPaint;
	prototype.invalidate = patch.invalidatePaint;
	patchRegistry.install(GLOBAL_TOOL_RENDER_PATCH, patch);
	return patch;
}

function deactivateGlobalToolRendering(patch: GlobalToolRenderPatch): void {
	if (!patch.active) return;
	disconnectGlobalToolRenderPatch(patch);
	const prototype = patch.prototype;
	if (prototype.hasRendererDefinition === patch.installed.hasRendererDefinition) {
		prototype.hasRendererDefinition = patch.downstream.hasRendererDefinition;
	}
	if (prototype.getRenderShell === patch.installed.getRenderShell) {
		prototype.getRenderShell = patch.downstream.getRenderShell;
	}
	if (prototype.getCallRenderer === patch.installed.getCallRenderer) {
		prototype.getCallRenderer = patch.downstream.getCallRenderer;
	}
	if (prototype.getResultRenderer === patch.installed.getResultRenderer) {
		prototype.getResultRenderer = patch.downstream.getResultRenderer;
	}
	if (patch.renderPaint && prototype.render === patch.renderPaint && patch.originalRender) {
		prototype.render = patch.originalRender;
	}
	if (
		patch.invalidatePaint &&
		prototype.invalidate === patch.invalidatePaint &&
		patch.originalInvalidate
	) {
		prototype.invalidate = patch.originalInvalidate;
	}
}

/** Expanded panel background unified to the user message background color; collapsed rows keep the native status color.
  *  Must be installed after compact-mode and released before compact-mode on shutdown. */
export function installToolExpandedBackground(): () => void {
	const previous = patchRegistry.get<ToolExpandedBackgroundPatch>(TOOL_EXPANDED_BACKGROUND_PATCH);
	if (previous) previous.dispose();
	const prototype = ToolExecutionComponent.prototype as unknown as { updateDisplay: () => void };
	const original = prototype.updateDisplay;
	const patch: ToolExpandedBackgroundPatch = {
		active: true,
		prototype,
		installed: function (this: any) {
			original.call(this);
			if (!patch.active || config.mode !== "on" || !this.expanded) return;
			const theme = getMessageDisplayTheme();
			if (!theme?.bg) return;
			const box = this.contentBox;
			// Outermost expanded card: 1 cell of inner padding on all sides
			if (box) {
				box.paddingX = 1;
				box.paddingY = 1;
				if (box.setBgFn) {
					box.setBgFn((text: string) => theme.bg(config.expandedCardBackground, text));
				}
			}
		},
		original,
		dispose: () => {
			patch.active = false;
			if (prototype.updateDisplay === patch.installed) {
				prototype.updateDisplay = original;
			}
			patchRegistry.dispose(TOOL_EXPANDED_BACKGROUND_PATCH, patch);
		},
	};
	prototype.updateDisplay = patch.installed;
	patchRegistry.install(TOOL_EXPANDED_BACKGROUND_PATCH, patch);
	return patch.dispose;
}

/** Installs the default mode global tool rendering patch (excluding the expanded background, see installToolExpandedBackground). */
export function installDefaultMode(
	writeExecutionMetadata: WriteExecutionMetadataStore,
): DefaultModeHooks {
	const globalToolRendering = installGlobalToolRendering(writeExecutionMetadata);
	return {
		isOwner() {
			return (
				patchRegistry.owns(GLOBAL_TOOL_RENDER_PATCH, globalToolRendering) &&
				globalToolRendering.active
			);
		},
		shutdown() {
			deactivateGlobalToolRendering(globalToolRendering);
		},
	};
}
