import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "../../config/config.ts";
import { setStartupResourcesTheme } from "./startup-resources.ts";
import type { StartupContextSnapshot } from "./startup-context.ts";
import { renderContextTreemap } from "./startup-treemap.ts";
import {
	EARLY_STARTUP_HEADER_PATCH,
	EARLY_STARTUP_HEADER_SWAP_KEY,
	patchRegistry,
} from "../../utils/patch-keys.ts";

const emptyHeader = (_tui: unknown, theme: any) => {
	setStartupResourcesTheme(() => theme);
	return { render: (_width: number): string[] => [], invalidate() {} };
};

/** Explicit snapshot helper for rendering fixtures; the resource installer owns the live map. */
export function renderHeaderLines(
	width: number,
	theme: Parameters<typeof renderContextTreemap>[2],
	snapshot: StartupContextSnapshot,
): string[] {
	return renderContextTreemap(snapshot, width, theme);
}

/** Suppress the native banner; no snapshot lookup occurs before the resources are installed. */
export function applyStartupHeader(ctx: any): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setHeader !== "function" || !config.showStartupHeader) return;
	ctx.ui.setHeader(emptyHeader);
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
			mode.setExtensionHeader(emptyHeader);
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
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setHeader(undefined);
	});
}
