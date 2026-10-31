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
	updateHeaderSpacers(ctx, true);
}

type HeaderSpacer = { setLines: (lines: number) => void; render: (width: number) => string[] };
type SavedSpacer = { component: HeaderSpacer; lines: number };
type HeaderSpacing = {
	mode: any;
	before?: SavedSpacer;
	after?: SavedSpacer;
	awaitingAfter: boolean;
};

type EarlyHeaderPatch = {
	active: boolean;
	original: (...args: any[]) => unknown;
	installed: (...args: any[]) => unknown;
	modes: Set<HeaderSpacing>;
};

type HeaderContainerSwap = {
	original: (child: any) => unknown;
	installed: (child: any) => unknown;
	spacing: HeaderSpacing;
};

/** Only Pi's one-line Spacer beside its native header is eligible, never unrelated components. */
function nativeHeaderSpacer(child: any): SavedSpacer | undefined {
	if (child?.constructor?.name !== "Spacer" || typeof child.setLines !== "function" || typeof child.render !== "function") return;
	const lines = child.render(1);
	if (!Array.isArray(lines) || lines.length !== 1 || lines[0] !== "") return;
	return { component: child, lines: lines.length };
}

function setSpacing(spacing: HeaderSpacing, hidden: boolean): void {
	for (const saved of [spacing.before, spacing.after]) {
		if (saved) saved.component.setLines(hidden ? 0 : saved.lines);
	}
}

function updateHeaderSpacers(ctx: any, hidden: boolean): void {
	const patch = patchRegistry.get<EarlyHeaderPatch>(EARLY_STARTUP_HEADER_PATCH);
	if (!patch?.active) return;
	for (const spacing of patch.modes) {
		const mode = spacing.mode;
		if (ctx?.sessionManager && mode.sessionManager !== ctx.sessionManager && mode.session?.sessionManager !== ctx.sessionManager) continue;
		setSpacing(spacing, hidden);
	}
}

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
		modes: previous?.modes ?? new Set<HeaderSpacing>(),
		installed: async function (this: any, ...args: any[]) {
			installHeaderContainerSwap(this, patch);
			return original.apply(this, args);
		},
	};
	prototype.init = patch.installed;
	patchRegistry.install(EARLY_STARTUP_HEADER_PATCH, patch);
	// A reload reclaims live containers without stacking another addChild wrapper.
	for (const spacing of patch.modes) {
		installHeaderContainerSwap(spacing.mode, patch);
		const children = spacing.mode.headerContainer?.children;
		setSpacing(spacing, config.showStartupHeader && Array.isArray(children) && children.includes(spacing.mode.customHeader));
	}
}

/** Wraps headerContainer.addChild once; a reload takes ownership of the previous wrapper. */
function installHeaderContainerSwap(mode: any, patch: EarlyHeaderPatch): void {
	const container = mode?.headerContainer;
	if (!container || typeof container.addChild !== "function") return;
	const previous = container[EARLY_STARTUP_HEADER_SWAP_KEY] as HeaderContainerSwap | undefined;
	const original = previous && container.addChild === previous.installed
		? previous.original
		: container.addChild.bind(container);
	const spacing = previous?.spacing ?? { mode, awaitingAfter: false };
	patch.modes.add(spacing);
	const installed = function (child: any) {
		const result = original(child);
		if (!patch.active) return result;
		const children: any[] = container.children;
		if (!Array.isArray(children)) return result;
		const index = children.indexOf(child);
		if (child === mode.builtInHeader) {
			spacing.before = index > 0 ? nativeHeaderSpacer(children[index - 1]) : undefined;
			spacing.awaitingAfter = !!spacing.before;
			if (config.showStartupHeader && typeof mode.setExtensionHeader === "function") {
				try {
					mode.setExtensionHeader(emptyHeader);
					// Do not hide rows if Pi could not replace its native header.
					if (children.includes(mode.customHeader)) setSpacing(spacing, true);
				} catch {
					// If swapping the header fails, leave Pi's native header intact.
				}
			}
		} else if (spacing.awaitingAfter) {
			spacing.awaitingAfter = false;
			const header = mode.customHeader ?? mode.builtInHeader;
			if (index > 0 && children[index - 1] === header) {
				spacing.after = nativeHeaderSpacer(child);
				if (spacing.after && config.showStartupHeader && children.includes(mode.customHeader)) setSpacing(spacing, true);
			}
			if (!spacing.after) setSpacing(spacing, false);
		}
		return result;
	};
	container.addChild = installed;
	container[EARLY_STARTUP_HEADER_SWAP_KEY] = { original, installed, spacing };
}

/** Restore Pi's header when /ccstyle disables this feature. */
export function clearStartupHeader(ctx: any): void {
	if (ctx?.hasUI && typeof ctx.ui?.setHeader === "function") ctx.ui.setHeader(undefined);
	updateHeaderSpacers(ctx, false);
}

export default function piStartupHeader(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) setStartupResourcesTheme(() => ctx.ui.theme);
		applyStartupHeader(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		clearStartupHeader(ctx);
	});
}
