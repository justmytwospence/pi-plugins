/**
 * In fullscreen, ! / !! while the agent is still streaming attach to the dock (pendingMessages).
 * The host only calls flushPendingBashComponents on the next regular submit, so the card stays pinned above the input after the command ends.
 * Add one flush at the end of handleBashCommand.
 */
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { FLUSH_DOCKED_BASH_PATCH, patchRegistry } from "../../utils/patch-keys.ts";

type Patch = {
	active: boolean;
	prototype: any;
	original: (...args: any[]) => unknown;
	installed: (...args: any[]) => unknown;
};

export function installFlushDockedBash(): void {
	const prototype = InteractiveMode.prototype as any;
	const previous = patchRegistry.get<Patch>(FLUSH_DOCKED_BASH_PATCH);
	if (previous) previous.active = false;
	const original =
		previous && prototype.handleBashCommand === previous.installed
			? previous.original
			: prototype.handleBashCommand;
	const patch: Patch = {
		active: true,
		prototype,
		original,
		installed: async function (this: any, ...args: any[]) {
			const result = await original.apply(this, args);
			if (patch.active) this.flushPendingBashComponents();
			return result;
		},
	};
	prototype.handleBashCommand = patch.installed;
	patchRegistry.install(FLUSH_DOCKED_BASH_PATCH, patch);
}
