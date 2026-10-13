import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { walkComponentTree } from "../utils/component-tree.ts";
import { COMPACT_MODE_PATCH_KEY, patchRegistry } from "../utils/patch-keys.ts";

// In the pi-coding-agent type declarations AssistantMessageComponent can only be used as a value,
// so updateContent/lastMessage are accessed through structural types.
type TranscriptComponentInternals = {
	lastMessage?: AssistantMessage;
	updateContent(message: AssistantMessage): void;
	invalidate?(): void;
};

/**
 * Re-renders a single constructed component: assistant re-renders with the latest message (compact thinking),
 * tool forces updateDisplay (its content may still be in the old shell container).
 * Does not swallow exceptions - the caller decides how to handle failures.
 */
export function refreshTranscriptComponent(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if (value instanceof AssistantMessageComponent) {
		const self = value as unknown as TranscriptComponentInternals;
		if (self.lastMessage) self.updateContent(self.lastMessage);
		else self.invalidate?.();
		return true;
	}
	if (value instanceof ToolExecutionComponent) {
		// updateDisplay is a private method, but after resume it is the only entry point that brings content back into the correct
		// shell container (the prototype chain already includes the global tool rendering patch).
		(value as unknown as { updateDisplay(): void }).updateDisplay();
		return true;
	}
	return false;
}

/**
 * Scans the mounted tree and re-renders all constructed assistant/tool components.
 * For scenarios after reload/resume/compaction where "pi rebuilt with the original prototypes and patches were installed afterwards".
 * Walks value.children and value.getMountedRoots?.() (seen set guards against cycles),
 * and isolates each component failure with try/catch so the rest are unaffected.
 */

/**
 * Patch chain order invariant: in compact mode compact-mode must sit outside compact-thinking
 * (so the round summary can aggregate tool stats). After resume/reload with no new messages,
 * the re-claim triggered by message_update does not run, so assert once here before any redraw.
 * The assertion is idempotent: a no-op when the chain order is already correct; also safe in mode=on (the outer layer passes through).
 */
function assertCompactModeOutermost(): void {
	try {
		const patch = patchRegistry.get<{ assertAssistantOwnership?: () => void }>(
			COMPACT_MODE_PATCH_KEY,
		);
		if (patch && typeof patch.assertAssistantOwnership === "function") {
			patch.assertAssistantOwnership();
		}
	} catch {
		// Skip when there is no compact-mode patch or the assertion fails; the scan still runs.
	}
}

export function refreshMountedTranscript(tui?: unknown): void {
	if (!tui || typeof (tui as any).getMountedRoots !== "function") return;
	// Fix the chain order before redrawing: when the scan triggers updateContent, compact-mode is already outermost.
	assertCompactModeOutermost();
	walkComponentTree(tui, (value: any) => {
		try {
			refreshTranscriptComponent(value);
		} catch {
			// One component failing does not block the rest; later session_tree/redraw retries.
		}
	});
}
