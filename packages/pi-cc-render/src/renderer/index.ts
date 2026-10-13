import { ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CompactThinkingController } from "../feature/compact-thinking.ts";
import { installToolGrouping, type ToolGroupingHooks } from "./tool/grouping.ts";
import {
	installCompactMode,
	refreshCompactModeComponents,
	type CompactModeHooks,
	type CompactThinkingQuery,
} from "./compact-mode.ts";
import {
	installDefaultMode,
	installToolExpandedBackground,
	type DefaultModeHooks,
} from "./default-mode.ts";
import { installMainScreenDoRenderPatch, isLazyProxyTui } from "../utils/fullscreen-detect.ts";
import { showCcstylePanel } from "../config/panel.ts";
import {
	config,
	formatConfigStatus,
	normalizeConfig,
	setConfig,
	updateConfig,
	type CompactStyleMode,
	type Config,
} from "../config/config.ts";
import {
	installToolMouseInteraction,
	resetToolHoverState,
	scheduleSessionRender,
	teardownToolMouseInteraction,
	TOOL_MOUSE_DISABLE,
} from "./mouse/interaction.ts";
import { getToolMouseTui, noteNewTranscriptItem } from "./mouse/scroll.ts";
import { setHoveredToolGroup, setHoveredToolIo } from "./mouse/hover.ts";
import { clearAllAnimations } from "./tool/result.ts";
import { installWriteOverride, WriteExecutionMetadataStore } from "./tool/diff/index.ts";
import {
	installMessageDisplayRendering,
	refreshMessageDisplays,
	setMessageDisplayTheme,
} from "./tool/message-display.ts";

/**
 * Claude Code Style for pi - assembly entry point.
 *
 * mode=on      -> default-mode (tool card style + expanded background)
 * mode=compact -> compact-mode (collapsed message summaries)
 * shared       -> tool-grouping / message-display / mouse / write override
 */

let compactModeHooks: CompactModeHooks | undefined;

function refreshCurrentTranscript(ctx?: any, toolGrouping?: ToolGroupingHooks): void {
	const tui = getToolMouseTui();
	toolGrouping?.refresh(tui);
	refreshMessageDisplays(tui);
	refreshCompactModeComponents(tui);
	compactModeHooks?.refresh();
	tui?.requestRender?.(true);
	ctx?.ui?.requestRender?.(true);
}

function syncCompactMode(ctx: any): void {
	refreshCompactModeComponents(getToolMouseTui());
	compactModeHooks?.sync(ctx);
}

function applyStyleMode(mode: CompactStyleMode, ctx: any, toolGrouping?: ToolGroupingHooks): void {
	updateConfig({ mode });
	if (mode === "off") {
		// Native rendering: clear hover/click and disable mouse reporting to restore the terminal's default wheel.
		resetToolHoverState();
		setHoveredToolGroup(null);
		setHoveredToolIo(null, null);
		// The lazy Proxy (regular/fullscreen) does not own reporting: regular keeps terminal scrollback,
		// fullscreen belongs to the host; neither may be disabled here.
		const tui = getToolMouseTui();
		if (tui && !isLazyProxyTui(tui)) {
			tui.terminal?.write?.(TOOL_MOUSE_DISABLE);
		}
	} else if (mode === "compact") {
		// Switching to compact: first collect the current transcript, then sync the global expanded state and patch ownership.
		syncCompactMode(ctx);
	}
	// Reshape immediately once; then once more after a frame (same as session_start), after the panel/custom view
	// is removed and the main transcript is remounted, rescan the tree so /reload is not required.
	refreshCurrentTranscript(ctx, toolGrouping);
	scheduleSessionRender(() => {
		if (mode === "compact") syncCompactMode(ctx);
		refreshCurrentTranscript(ctx, toolGrouping);
	});
	ctx.ui.notify(`Claude Code style: ${mode}`, "info");
}

export default function (
	pi: ExtensionAPI,
	configOverride?: Partial<Config>,
	compactThinking?: CompactThinkingController,
) {
	// Optional override: integration tests do not depend on the user's global config.
	if (configOverride) setConfig(normalizeConfig({ ...config, ...configOverride }));
	const writeExecutionMetadata = new WriteExecutionMetadataStore();
	const mouseOwner = {};
	let installation:
		| {
				defaultMode: DefaultModeHooks;
				toolGrouping: ToolGroupingHooks;
				compactMode: CompactModeHooks;
				disposeMessageDisplay: () => void;
				disposeToolExpandedBackground: () => void;
		  }
		| undefined;

	const ensureTuiInstallation = (ctx: any) => {
		if (ctx?.mode !== "tui" || !ctx?.hasUI) return undefined;
		// The rendering layer (tool style/grouping) uses prototype and component-level patches; the host's fullscreen layout
		// renders the same components, so install in both modes.
		if (installation) return installation;
		// Differential-render patch for the regular main screen: changes above the viewport no longer trigger a scrollback-clearing fullRender.
		installMainScreenDoRenderPatch();
		const defaultMode = installDefaultMode(writeExecutionMetadata);
		const toolGrouping = installToolGrouping(() => config.mode === "on");
		const compactMode = installCompactMode({
			query: compactThinking as CompactThinkingQuery | undefined,
			writeMetadata: writeExecutionMetadata,
		});
		compactModeHooks = compactMode;
		const disposeMessageDisplay = installMessageDisplayRendering();
		// The expanded background must be installed after compact-mode and released before compact on shutdown.
		const disposeToolExpandedBackground = installToolExpandedBackground();
		installation = {
			defaultMode,
			toolGrouping,
			compactMode,
			disposeMessageDisplay,
			disposeToolExpandedBackground,
		};
		return installation;
	};

	pi.registerCommand("ccstyle", {
		description: "Configure Claude Code style and rich diff options",
		getArgumentCompletions: (prefix) => {
			const topLevel = [
				{ value: "on", label: "on", description: "Enable Claude Code style" },
				{
					value: "compact",
					label: "compact",
					description: "One summary line per assistant message",
				},
				{ value: "off", label: "off", description: "Use Pi's native renderer" },
				{ value: "status", label: "status", description: "Show full configuration" },
				{ value: "panel", label: "panel", description: "Open interactive settings panel" },
			];
			return topLevel.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!arg || arg === "panel" || arg === "on" || arg === "compact" || arg === "off") {
				if (ctx?.mode !== "tui" || !ctx?.hasUI) {
					ctx.ui?.notify?.("/ccstyle requires TUI mode", "warning");
					return;
				}
				const hooks = ensureTuiInstallation(ctx);
				if (!hooks) return;
				if (!arg || arg === "panel") {
					await showCcstylePanel(
						ctx,
						{ applyStyleMode, refreshCurrentTranscript },
						hooks.toolGrouping,
						compactThinking,
					);
				} else {
					applyStyleMode(arg as CompactStyleMode, ctx, hooks.toolGrouping);
				}
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(`Claude Code style: ${formatConfigStatus(config)}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /ccstyle [on|compact|off|status|panel]", "warning");
		},
	});

	pi.on("message_update", async (event) => {
		// compact-thinking installs another layer on top of the compact patch at session_start;
		// extension events dispatch before interactive-mode's updateContent, so re-claim here first.
		if (config.mode === "compact" && event.message?.role === "assistant") {
			compactModeHooks?.assertOwnership();
		}
	});

	// Count for the back-to-bottom button: +1 per content block landed while away from the bottom.
	pi.on("message_start", async (event) => {
		const role = event.message?.role;
		// toolResult is not its own block (rendered inside the tool card); skip it to avoid double counting with the tool card.
		if (role === "user" || role === "assistant" || role === "custom") noteNewTranscriptItem();
	});

	pi.on("tool_execution_end", async (event) => {
		if (config.mode !== "compact") return;
		// After tools such as Agent finish, refresh after a delay so compact-thinking settles into its final state first.
		const toolCallId: string | undefined = event?.toolCallId;
		setTimeout(() => {
			compactModeHooks?.refreshToolCallMessage(toolCallId);
		}, 0);
	});

	pi.on("session_start", async (event, ctx) => {
		// Defer the write ownership check by one tick: other extensions also register tools in their own session_start,
		// and this handler may not see them yet; registering now would collide on the name (the registry is first come first served),
		// silently dropping the other's write. Once all session_start handlers have run, the detection result is authoritative.
		setTimeout(() => {
			installWriteOverride(pi, writeExecutionMetadata, (owner) => {
				// Make the conflict visible: once another extension takes over write, this plugin no longer provides rich diff.
				ctx.ui?.notify?.(
					`ccstyle: write tool is already taken by ${owner.path || owner.source}; rich diff yields to it`,
					"warning",
				);
			});
		}, 0);
		const hooks = ensureTuiInstallation(ctx);
		// Mouse interaction is independent of the rendering layer: the fullscreen rendering layer yields (hooks undefined) but
		// tool click / back-to-bottom adaptation must still be installed; keep it after the rendering layer to preserve the original order.
		if (ctx?.mode === "tui" && ctx?.hasUI) installToolMouseInteraction(ctx, mouseOwner);
		if (!hooks) return;
		hooks.toolGrouping.setTheme(ctx.ui.theme);
		setMessageDisplayTheme(ctx.ui.theme);
		ctx.ui.setStatus("ccstyle", undefined);
		// First collect the resume transcript, then sync the compact patch and global expanded state.
		syncCompactMode(ctx);
		// compact-thinking's session_start handling runs after this handler (installing another
		// updateContent layer on top); sync once more after a delay so the compact patch ends up outermost.
		setTimeout(() => syncCompactMode(ctx), 0);
		scheduleSessionRender(() => hooks.toolGrouping.refresh(getToolMouseTui()));
	});

	pi.on("session_compact", async (event, ctx) => {
		const hooks = ensureTuiInstallation(ctx);
		// Compaction rebuilds the transcript without session_start. Rebind after
		// other TUI extensions may have replaced the root input dispatcher.
		if (ctx?.mode === "tui" && ctx?.hasUI) installToolMouseInteraction(ctx, mouseOwner);
		if (!hooks) return;
		hooks.toolGrouping.setTheme(ctx.ui.theme);
		setMessageDisplayTheme(ctx.ui.theme);
		syncCompactMode(ctx);
		scheduleSessionRender(() => {
			syncCompactMode(ctx);
			hooks.toolGrouping.refresh(getToolMouseTui());
		});
	});

	pi.on("session_tree", async (event, ctx) => {
		// After the session tree is rebuilt, sync once in the current frame and once in the next to replace old component references.
		if (ctx?.mode !== "tui" || !ctx?.hasUI) return;
		syncCompactMode(ctx);
		scheduleSessionRender(() => syncCompactMode(ctx));
	});

	pi.on("tool_execution_start", async (_event, ctx) => {
		installation?.toolGrouping.setTheme(ctx.ui.theme);
		noteNewTranscriptItem();
	});

	pi.on("session_shutdown", async () => {
		writeExecutionMetadata.clear();
		// Mouse interaction is independent of the rendering layer: in fullscreen installation is undefined,
		// but the onTerminalInput listener and the handleViewportInput wrapper must still be released.
		teardownToolMouseInteraction(mouseOwner);
		const current = installation;
		if (!current || !current.defaultMode.isOwner()) return;
		current.defaultMode.shutdown();
		current.toolGrouping.shutdown();
		current.disposeToolExpandedBackground();
		current.compactMode.shutdown();
		compactModeHooks = undefined;
		current.disposeMessageDisplay();
		clearAllAnimations();
		installation = undefined;
	});
}

// ---- Public exports: symbols actually consumed by the entry point/tests ----
export { getCompactThinkingConfig } from "../config/config.ts";
export {
	preservesOriginalRenderer,
	shouldRenderRichDiff,
} from "./default-mode.ts";
export {
	isMcpToolDefinition,
	mcpToolTitle,
} from "./tool/mcp-title.ts";
export {
	ExpandedToolIoView,
	ExpandedToolResultText,
	formatToolInputArgs,
	SHOW_MORE_LABEL,
} from "./tool/result.ts";
export { installToolMouseInteraction } from "./mouse/interaction.ts";
