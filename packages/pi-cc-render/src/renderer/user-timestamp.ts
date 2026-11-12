/**
 * Draws a right-aligned, human-readable time on the middle row of each user prompt block.
 *
 * Patches UserMessageComponent.prototype.render. The time goes only where the row has spare room, never on the first or
 * last row (they carry the OSC 133 zone markers), and a prompt restored from the session shows its recorded time while a
 * live one shows the time it was first drawn (Pi passes `timestamp` only for restored messages).
 */
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { config } from "../config/config.ts";
import { USER_TIMESTAMP_PATCH, patchRegistry } from "../utils/patch-keys.ts";
import { formatClock, labelBlock, timestampsEnabled } from "../transcript-style.ts";
import { getMessageDisplayTheme } from "./tool/message-display.ts";

const FIRST_SEEN = Symbol.for("pi.ccstyle.user-timestamp-first-seen");

type Patch = {
	active: boolean;
	prototype: { render: (width: number) => string[] };
	installed: (width: number) => string[];
	original: (width: number) => string[];
	dispose: () => void;
};

export function installUserTimestamps(): () => void {
	const previous = patchRegistry.get<Patch>(USER_TIMESTAMP_PATCH);
	if (previous) previous.dispose();
	const prototype = (UserMessageComponent as any).prototype as Patch["prototype"];
	const original = prototype.render;
	const patch: Patch = {
		active: true,
		prototype,
		original,
		installed: function (this: any, width: number): string[] {
			const lines = original.call(this, width);
			if (!patch.active || config.mode === "off" || !timestampsEnabled() || lines.length < 3) return lines;
			const theme = getMessageDisplayTheme();
			if (!theme?.bg) return lines;
			const stamp = this.timestamp ?? (this[FIRST_SEEN] ??= Date.now());
			const clock = formatClock(stamp);
			if (!clock) return lines;
			return labelBlock(lines, clock, width, {
				skipEdges: true,
				bg: (text) => theme.bg("userMessageBg", text),
				fg: (text) => theme.fg("dim", text),
			});
		},
		dispose: () => {
			patch.active = false;
			if (prototype.render === patch.installed) prototype.render = original;
			patchRegistry.dispose(USER_TIMESTAMP_PATCH, patch);
		},
	};
	prototype.render = patch.installed;
	patchRegistry.install(USER_TIMESTAMP_PATCH, patch);
	return patch.dispose;
}
