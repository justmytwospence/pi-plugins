import { TuiMainScreen } from "@earendil-works/pi-tui";
import { MAIN_SCREEN_DO_RENDER_PATCH, patchRegistry } from "./patch-keys.ts";

/**
 * The host's 0.84+ tui reference is a lazy Proxy (createInteractiveTuiReference):
 * each get of a function property returns a new wrapper, resolved to the current implementation only at call time.
 * Capturing doRender/render/handleInput through it resolves back to itself and recurses infinitely,
 * so when a lazy Proxy is detected all "capture then wrap" patches must be skipped.
 */
export function isLazyProxyTui(tui: any): boolean {
	if (!tui || typeof tui !== "object") return false;
	const probe = tui.requestRender;
	return typeof probe === "function" && probe !== tui.requestRender;
}

type MainScreenDoRenderPatch = {
	active: boolean;
	original: (lines: string[]) => string[];
	installed: (lines: string[]) => string[];
};

/**
 * In regular (TuiMainScreen) mode doRender uses differential painting: once the first changed line falls
 * above previousViewportTop (a region the terminal cannot write into scrollback), the only option is
 * fullRender(true) - \x1b[2J\x1b[H\x1b[3J clears the screen and wipes the whole scrollback.
 * The summary-line animation and streaming body of a compact live turn render above the turn's tool cards/diff panel;
 * once the diff panel lands and pushes the content below beyond the screen height, every later redraw hits this branch: scrollback
 * is cleared repeatedly, the scrollbar bounces back and the viewport is pinned until the output ends.
 *
 * Lines above the viewport cannot be rewritten anyway, leaving two paths: "clear scrollback and reprint" or "keep old text in scrollback".
 * This picks the latter: applyLineResets is the last stage that sees the whole frame before the diff comparison;
 * it aligns the above-viewport prefix of previousLines directly to the new frame, so the diff sees only the writable region and paints incrementally as usual.
 * The only cost is that those few scrollback lines keep the content of the last actual write.
 */
export function installMainScreenDoRenderPatch(): void {
	const prototype = TuiMainScreen.prototype as any;
	if (typeof prototype?.applyLineResets !== "function") return;
	const previous = patchRegistry.get<MainScreenDoRenderPatch>(MAIN_SCREEN_DO_RENDER_PATCH);
	if (previous) previous.active = false;
	const original =
		previous && prototype.applyLineResets === previous.installed
			? previous.original
			: prototype.applyLineResets;
	const patch: MainScreenDoRenderPatch = {
		active: true,
		original,
		installed(this: any, lines: string[]) {
			const result = original.call(this, lines);
			if (!patch.active) return result;
			const prev = this.previousLines;
			if (!Array.isArray(prev)) return result;
			const top = Math.min(
				Math.max(0, Math.floor(Number(this.previousViewportTop) || 0)),
				result.length,
			);
			for (let i = 0; i < top; i++) prev[i] = result[i];
			return result;
		},
	};
	prototype.applyLineResets = patch.installed;
	patchRegistry.install(MAIN_SCREEN_DO_RENDER_PATCH, patch);
}
