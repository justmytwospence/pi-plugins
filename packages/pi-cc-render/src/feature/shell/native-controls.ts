import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONTEXT_METADATA_CHANNEL, type ContextMetadataRequest } from "../../context-metadata.ts";
import { FOOTER_ACTIONS_CHANNEL, type FooterActionsRequest } from "../../footer-actions.ts";
import { getInteractiveModeForManager } from "./startup-header.ts";

const UNAVAILABLE = "MCP controls unavailable; use /mcp.";

type NativeControlsSession = {
	manager: ExtensionContext["sessionManager"];
	id: string;
	generation: number;
	busy: boolean;
	blockedHolds: number;
};

function nativeMcpCommand(runner: any): any | undefined {
	const command = runner?.getCommand?.("mcp");
	return command?.sourceInfo?.path === "builtin:mcp" && typeof command.handler === "function"
		? command : undefined;
}

/** Native selectors do not emit prompt events: actual main-editor focus is authoritative. */
function ownsInput(mode: any, runner: any): boolean {
	const tui = mode.ui;
	return !!mode.editor && typeof tui?.getFocusedComponent === "function" &&
		typeof tui.hasOverlay === "function" && !tui.hasOverlay() &&
		tui.getFocusedComponent() === mode.editor && mode.editorContainer?.children?.includes(mode.editor) === true &&
		// The SDK runner increments this before an async custom factory mounts.
		// Fail closed on an unsupported runner rather than opening over that gap.
		runner.uiPromptDepth === 0;
}

/** Optional native capabilities; independent of startup-header and ccstyle visibility. */
export default function installNativeControls(pi: ExtensionAPI): void {
	let active: NativeControlsSession | undefined;
	let unsubscribe: Array<() => void> = [];
	const stop = () => {
		active = undefined;
		for (const off of unsubscribe.splice(0)) off();
	};
	const sameSession = (state: NativeControlsSession) => {
		try { return active === state && state.manager.getSessionId() === state.id; }
		catch { return false; }
	};

	pi.on("session_start", (_event, ctx) => {
		stop();
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		const state: NativeControlsSession = {
			manager: ctx.sessionManager, id: ctx.sessionManager.getSessionId(), generation: 0,
			busy: false, blockedHolds: 0,
		};
		active = state;
		unsubscribe.push(pi.events.on("herdr:blocked", (data) => {
			if (!sameSession(state)) return;
			const hold = data as { active?: unknown } | undefined;
			if (hold?.active === true) state.blockedHolds++;
			else if (hold?.active === false) state.blockedHolds = Math.max(0, state.blockedHolds - 1);
		}));
		unsubscribe.push(pi.events.on(CONTEXT_METADATA_CHANNEL, (data) => {
			try {
				const request = data as ContextMetadataRequest | undefined;
				if (request?.version !== 1 || request.sessionManager !== state.manager || !sameSession(state)) return;
				const generation = state.generation;
				const mode = getInteractiveModeForManager(state.manager);
				const session = mode?.session;
				const runner = session?.extensionRunner;
				if (!session || session.sessionManager !== state.manager || typeof runner?.createCommandContext !== "function") return;
				const current = () => {
					try {
						return ctx.mode === "tui" && ctx.hasUI && ctx.sessionManager === state.manager &&
							sameSession(state) && state.generation === generation &&
							getInteractiveModeForManager(state.manager) === mode && mode.session === session &&
							session.sessionManager === state.manager && session.extensionRunner === runner;
					} catch { return false; }
				};
				if (!current()) return;
				// Discovery is observational: no context creation, metadata reads or command lookup.
				request.read = () => {
					try {
						if (!current()) return;
						const create = runner.createCommandContext;
						if (typeof create !== "function" || !current()) return;
						const commandContext: ExtensionCommandContext | undefined = create.call(runner);
						if (!commandContext || !current() || commandContext.mode !== "tui" ||
							!commandContext.hasUI || commandContext.sessionManager !== state.manager) return;
						const read = commandContext.getSystemPromptOptions;
						if (typeof read !== "function" || !current()) return;
						const options = read.call(commandContext);
						if (!options || typeof options !== "object" || Array.isArray(options) ||
							typeof options.cwd !== "string" || !current()) return;
						// Only the fresh SDK options escape, never the command context or a dispatcher.
						return options;
					} catch { return; }
				};
			} catch { /* Missing/stale hosts expose no metadata capability. */ }
		}));
		unsubscribe.push(pi.events.on(FOOTER_ACTIONS_CHANNEL, (data) => {
			const request = data as FooterActionsRequest | undefined;
			if (request?.version !== 1 || !request.actions || typeof request.actions !== "object" ||
				Array.isArray(request.actions) || !sameSession(state)) return;
			try {
				const mode = getInteractiveModeForManager(state.manager);
				const session = mode?.session;
				const runner = session?.extensionRunner;
				if (typeof runner?.createCommandContext !== "function" || !nativeMcpCommand(runner)) return;
				const generation = state.generation;
				const current = () => {
					try {
						return sameSession(state) && state.generation === generation &&
							getInteractiveModeForManager(state.manager) === mode && mode.session === session &&
							session.extensionRunner === runner;
					} catch { return false; }
				};
				request.actions["mcp.open"] = {
					label: "MCP controls", key: "/mcp",
					run: async () => {
						if (!current() || state.busy) return;
						// Acquire before context creation: a nested caller cannot borrow this action.
						state.busy = true;
						let commandContext: ExtensionCommandContext | undefined;
						const notify = (message: string, level: "warning" | "error") => {
							if (!current()) return;
							try { (commandContext ?? runner.createContext()).ui.notify(message, level); }
							catch { /* Invalidated contexts cannot report into a new runtime. */ }
						};
						try {
							if (state.blockedHolds || !ownsInput(mode, runner)) return;
							commandContext = runner.createCommandContext();
							if (!commandContext || !current() || commandContext.mode !== "tui" ||
								!commandContext.hasUI || commandContext.sessionManager !== state.manager) return;
							if (!commandContext.isIdle()) {
								notify("Wait for the current turn before opening MCP controls.", "warning");
								return;
							}
							// Re-resolve the exact owner at activation, never execute a cached handler.
							const command = nativeMcpCommand(runner);
							if (!command) { notify(UNAVAILABLE, "warning"); return; }
							if (!current() || state.blockedHolds || !ownsInput(mode, runner)) return;
							// Native custom UI owns draft/focus restoration. Never synthesize /mcp input.
							await command.handler("", commandContext);
						} catch {
							notify(UNAVAILABLE, "error");
						} finally {
							state.busy = false;
						}
					},
				};
			} catch { /* Missing/stale hosts expose no capability. */ }
		}));
	});
	pi.on("session_tree", () => { if (active) active.generation++; });
	pi.on("session_shutdown", stop);
}
