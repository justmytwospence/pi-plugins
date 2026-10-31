import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { layoutSection, type ResourceSection, type SplashAction, type SplashHit, type StartupTheme } from "./startup-resources.ts";
import type { StartupHostState } from "./startup-state.ts";

/** Display-only section: Container/viewport routing supplies component-local coordinates. */
export function createInteractiveSection(
	getSection: () => ResourceSection | undefined,
	getTheme: () => StartupTheme,
	actions: (action: SplashAction) => void,
): Component & { dispose(): void } {
	let width: number | undefined;
	let hits: SplashHit[] = [];
	let height = 0;
	let disposed = false;
	const invalidate = () => {
		width = undefined;
		hits = [];
		height = 0;
	};
	return {
		render(nextWidth) {
			if (disposed) return [];
			// Recompute lines and hit rectangles together, including after a theme change or resize.
			invalidate();
			const section = getSection();
			const layout = section ? layoutSection(section, nextWidth, getTheme()) : { lines: [], hits: [] };
			width = nextWidth;
			hits = layout.hits;
			height = layout.lines.length;
			return layout.lines;
		},
		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			if (disposed || event.type !== "click" || event.button !== "left" || event.shift || event.alt || event.ctrl ||
				(event.clickCount ?? 1) !== 1 || width !== event.width || event.y < 0 || event.y >= height ||
				event.x < 0 || event.x >= event.width) return undefined;
			const hit = hits.find((candidate) => candidate.row === event.y && event.x >= candidate.startCol && event.x < candidate.endCol);
			if (!hit) return undefined;
			actions(hit.action);
			return { handled: true, render: false };
		},
		invalidate,
		dispose() { disposed = true; invalidate(); },
	};
}

export type SplashActionController = {
	activate(action: SplashAction): Promise<void>;
	/** Drop pending completions on reload or unmount. */
	dispose(): void;
};

/** The owner supplies the per-mode host. A fresh extension context is read at click time, never captured across sessions. */
export function createSplashActionController(
	pi: ExtensionAPI,
	mode: any,
	host: StartupHostState,
): SplashActionController {
	const generation = host.generation;
	let disposed = false;
	const current = () => !disposed && host.mode === mode && host.generation === generation && sameSession(mode, host);
	const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "warning") => {
		if (current()) ctx.ui.notify(message, type);
	};
	const refresh = () => {
		if (!current()) return;
		host.refresh?.();
		host.repaint?.();
		mode.ui?.requestRender?.();
	};
	const activate = async (action: SplashAction): Promise<void> => {
		if (!current() || host.actionBusy) return;
		let ctx: ExtensionContext;
		try {
			ctx = mode.session.extensionRunner.createContext();
			if (ctx.mode !== "tui") return;
			if (!ctx.isIdle()) {
				notify(ctx, action.kind === "model"
					? "Wait for the current turn before switching models."
					: "Wait for the current turn before opening MCP controls.");
				return;
			}
		} catch { return; } // A replaced session's extension context is invalid.
		host.actionBusy = true;
		try {
			if (action.kind === "model") await selectModel(action, ctx);
			else await openMcp(action, ctx);
		} catch (error) {
			notify(ctx, action.kind === "model"
				? `Unable to switch model ${action.provider}/${action.id}: ${error instanceof Error ? error.message : String(error)}`
				: "MCP controls unavailable; use /mcp.", "error");
		} finally {
			if (current()) {
				host.actionBusy = false;
			refresh();
			}
		}
	};
	const selectModel = async (action: Extract<SplashAction, { kind: "model" }>, ctx: ExtensionContext) => {
		const selected = ctx.model;
		const sameModel = selected?.provider === action.provider && selected?.id === action.id;
		if (sameModel && (!action.thinkingLevel || action.thinkingLevel === pi.getThinkingLevel())) return;
		const model = ctx.modelRegistry.find(action.provider, action.id);
		if (!model) {
			notify(ctx, `Model unavailable: ${action.provider}/${action.id}.`, "error");
			return;
		}
		if (!sameModel) {
			const switched = await pi.setModel(model); // Session only: never modify the global default.
			if (!current()) return;
			if (!switched) {
				notify(ctx, `Model authentication unavailable: ${action.provider}/${action.id}.`, "error");
				return;
			}
		}
		if (!current()) return;
		if (action.thinkingLevel) pi.setThinkingLevel(action.thinkingLevel as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
		mode.updateAvailableProviderCount?.();
		mode.footer?.invalidate?.();
		mode.updateEditorBorderColor?.();
		mode.showStatus?.(`Model: ${model.id}`);
		if (typeof mode.maybeWarnAboutAnthropicSubscriptionAuth === "function") {
			void Promise.resolve().then(() => mode.maybeWarnAboutAnthropicSubscriptionAuth(model)).catch(() => {});
		}
		refresh();
	};
	const openMcp = async (action: Extract<SplashAction, { kind: "mcp" }>, ctx: ExtensionContext) => {
		const runner = mode.session?.extensionRunner;
		const command = runner?.getCommand?.("mcp");
		if (command?.sourceInfo?.path !== "builtin:mcp" || typeof command.handler !== "function" ||
			typeof runner?.createCommandContext !== "function") {
			notify(ctx, "MCP controls unavailable; use /mcp.");
			return;
		}
		const commandContext = runner.createCommandContext();
		if (!commandContext || commandContext.mode !== "tui" || !current()) {
			notify(ctx, "MCP controls unavailable; use /mcp.");
			return;
		}
		notify(ctx, `MCP controls: ${action.name}`, "info");
		// Empty /mcp opens the native manager without selecting a server or saving configuration.
		await command.handler("", commandContext);
	};
	return { activate, dispose: () => { if (current()) host.actionBusy = false; disposed = true; } };
}

function sameSession(mode: any, host: StartupHostState): boolean {
	try {
		const id = mode.sessionManager?.getSessionId?.() ?? mode.session?.sessionManager?.getSessionId?.() ?? "";
		return id === host.sessionId;
	} catch { return false; }
}
