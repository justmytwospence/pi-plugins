import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "../../config/config.ts";
import { setStartupResourcesTheme } from "./startup-resources.ts";
import { readStartupContext, type StartupContextSnapshot } from "./startup-context.ts";
import { attachStartupHost, disposeStartupHost, getStartupHost, getStartupHostForManager, type StartupHostState } from "./startup-state.ts";
import { renderContextTreemap } from "./startup-treemap.ts";
import {
	EARLY_STARTUP_HEADER_PATCH,
	EARLY_STARTUP_HEADER_SWAP_KEY,
	patchRegistry,
} from "../../utils/patch-keys.ts";

const LOADING: StartupContextSnapshot = {
	stage: "initializing", modelLabel: "Model unknown", usedEstimate: 0, sources: [], attribution: { files: false, skills: false }, caveats: [],
};

/** Explicit snapshot keeps collection out of the component's render path. */
export function renderHeaderLines(
	width: number,
	theme: Parameters<typeof renderContextTreemap>[2],
	snapshot: StartupContextSnapshot,
): string[] {
	return renderContextTreemap(snapshot, width, theme);
}

function refreshHeader(state: StartupHostState): void {
	const previous = state.contextSnapshot;
	const next = readStartupContext(state.mode);
	if (next.stage === "initializing" && previous && previous.stage !== "initializing") return;
	if (JSON.stringify(previous) === JSON.stringify(next)) return;
	state.contextSnapshot = next;
	state.repaint?.();
}

/** Component factory for the host's setHeader: the theme is injected by the host. */
function headerFactory(
	getSnapshot: () => StartupContextSnapshot,
	invalidateHeader?: () => void,
): (tui: unknown, theme: any) => { render(width: number): string[]; invalidate(): void } {
	return (_tui: unknown, theme: any) => {
		setStartupResourcesTheme(() => theme);
		return {
			render(width: number): string[] {
				return renderHeaderLines(width, theme, getSnapshot());
			},
			invalidate() { invalidateHeader?.(); },
		};
	};
}

function stateForContext(ctx: any): StartupHostState | undefined {
	const id = ctx?.sessionManager?.getSessionId?.();
	return (id ? getStartupHost(id) : undefined) ?? (ctx?.sessionManager ? getStartupHostForManager(ctx.sessionManager) : undefined);
}

/** Install into the existing header slot without replacing an early owner's snapshot. */
export function applyStartupHeader(ctx: any): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setHeader !== "function" || !config.showStartupHeader) return;
	const state = stateForContext(ctx);
	if (state) {
		attachStartupHost(state.mode);
		state.repaint = () => ctx.ui.requestRender?.();
		if (state.refresh) state.refresh();
		else refreshHeader(state);
	}
	ctx.ui.setHeader(headerFactory(() => state?.contextSnapshot ?? LOADING));
}

type EarlyHeaderPatch = {
	active: boolean;
	original: (...args: any[]) => unknown;
	installed: (...args: any[]) => unknown;
};

type HeaderContainerSwap = {
	original: (child: any) => unknown;
	installed: (child: any) => unknown;
};

/** Swap the native header on insertion, before Pi's first paint. */
export function installEarlyStartupHeader(): void {
	const prototype = (InteractiveMode as any)?.prototype;
	if (!prototype || typeof prototype.init !== "function") return;
	const previous = patchRegistry.get<EarlyHeaderPatch>(EARLY_STARTUP_HEADER_PATCH);
	if (previous) previous.active = false;
	const original = previous && prototype.init === previous.installed ? previous.original : prototype.init;
	const patch: EarlyHeaderPatch = {
		active: true,
		original,
		installed: async function (this: any, ...args: any[]) {
			installHeaderContainerSwap(this, patch);
			return original.apply(this, args);
		},
	};
	prototype.init = patch.installed;
	patchRegistry.install(EARLY_STARTUP_HEADER_PATCH, patch);
}

/** Wraps headerContainer.addChild once; a reload takes ownership of the previous wrapper. */
function installHeaderContainerSwap(mode: any, patch: EarlyHeaderPatch): void {
	const container = mode?.headerContainer;
	if (!container || typeof container.addChild !== "function") return;
	const previous = container[EARLY_STARTUP_HEADER_SWAP_KEY] as HeaderContainerSwap | undefined;
	const original = previous && container.addChild === previous.installed
		? previous.original
		: container.addChild.bind(container);
	const installed = function (child: any) {
		const result = original(child);
		if (!patch.active || !config.showStartupHeader || child !== mode.builtInHeader) return result;
		if (typeof mode.setExtensionHeader !== "function") return result;
		try {
			const state = attachStartupHost(mode);
			// A loading paint is valid until the session is ready. Never collect inside render().
			refreshHeader(state);
			state.repaint = () => mode.ui?.requestRender?.();
			mode.setExtensionHeader(headerFactory(() => state.contextSnapshot ?? LOADING));
		} catch {
			// If swapping the header fails, leave Pi's native header intact.
		}
		return result;
	};
	container.addChild = installed;
	container[EARLY_STARTUP_HEADER_SWAP_KEY] = { original, installed };
}

/** Restore Pi's header when /ccstyle disables this feature. */
export function clearStartupHeader(ctx: any): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setHeader !== "function") return;
	ctx.ui.setHeader(undefined);
}

export default function piStartupHeader(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) setStartupResourcesTheme(() => ctx.ui.theme);
		applyStartupHeader(ctx);
	});

	const onRefresh = pi.on.bind(pi) as (event: string, handler: (event: unknown, ctx: any) => void) => void;
	for (const event of ["model_select", "session_tree", "session_compact", "agent_end", "agent_settled"] as const) {
		onRefresh(event, (_event, ctx) => {
			if (!config.showStartupHeader || !ctx.hasUI) return;
			const state = stateForContext(ctx);
			if (!state) return;
			attachStartupHost(state.mode);
			if (state.refresh) state.refresh();
			else refreshHeader(state);
		});
	}

	pi.on("session_shutdown", async (_event, ctx) => {
		const state = stateForContext(ctx);
		if (state) disposeStartupHost(state.mode);
		if (ctx.hasUI) ctx.ui.setHeader(undefined);
	});
}
