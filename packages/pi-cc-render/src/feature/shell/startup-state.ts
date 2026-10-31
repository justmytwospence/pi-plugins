import { resetStartupContext, type StartupContextSnapshot } from "./startup-context.ts";
import type { ResourceSection } from "./startup-resources.ts";

export type StartupHostState = {
	mode: object;
	sessionId: string;
	generation: number;
	contextSnapshot?: StartupContextSnapshot;
	resourceSections?: Record<string, ResourceSection>;
	actionBusy: boolean;
	/** The startup installer owns the timer and supplies these callbacks. */
	refresh?: () => void;
	repaint?: () => void;
	onDispose?: () => void;
};

const byMode = new WeakMap<object, StartupHostState>();
const bySession = new Map<string, StartupHostState>();
const activeModes = new Set<object>();
function sessionId(mode: any): string | undefined {
	try { return mode?.sessionManager?.getSessionId?.() ?? mode?.session?.sessionManager?.getSessionId?.(); }
	catch { return undefined; }
}
/** Reattach on each refresh: a session switch removes the previous lookup before registering the new one. */
export function attachStartupHost(mode: object): StartupHostState {
	const id = sessionId(mode);
	let state = byMode.get(mode);
	if (state && state.sessionId === id) return state;
	if (state) {
		if (bySession.get(state.sessionId) === state) bySession.delete(state.sessionId);
		resetStartupContext(mode);
		state.generation++;
		state.contextSnapshot = undefined;
		state.resourceSections = undefined;
		state.actionBusy = false;
		state.sessionId = id ?? "";
	} else {
		state = { mode, sessionId: id ?? "", generation: 0, actionBusy: false };
		byMode.set(mode, state);
		activeModes.add(mode);
	}
	if (id) bySession.set(id, state);
	return state;
}
export function getStartupHost(id: string): StartupHostState | undefined { return bySession.get(id); }
/** Before the first session ID exists, bind session_start to its already-installed mode, not another session's header. */
export function getStartupHostForManager(manager: object): StartupHostState | undefined {
	for (const mode of activeModes) {
		const host = mode as { sessionManager?: object; session?: { sessionManager?: object } };
		if (host.sessionManager === manager || host.session?.sessionManager === manager) return attachStartupHost(mode);
	}
	return undefined;
}
export function disposeStartupHost(mode: object): void {
	const state = byMode.get(mode);
	if (!state) return;
	state.generation++;
	resetStartupContext(mode);
	state.onDispose?.();
	state.refresh = undefined;
	state.repaint = undefined;
	state.onDispose = undefined;
	state.contextSnapshot = undefined;
	state.resourceSections = undefined;
	state.actionBusy = false;
	if (bySession.get(state.sessionId) === state) bySession.delete(state.sessionId);
	byMode.delete(mode);
	activeModes.delete(mode);
}
