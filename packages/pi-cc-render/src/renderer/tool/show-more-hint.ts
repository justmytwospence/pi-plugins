/**
 * show-more hint text: in fullscreen, mouse hover/click is available, so the hint is "click to show more";
 * other modes (regular keeps the terminal's native scrollback and does not enable mouse reporting) show the default expand shortcut.
 *
 * The tui mode is maintained by mouse-interaction in a renderer callback; when not installed it is treated as fullscreen,
 * keeping pure rendering tests and existing behavior unchanged.
 */
import { getKeybindings } from "@earendil-works/pi-tui";

let toolTuiFullscreen: boolean | undefined;

export function setToolTuiFullscreen(value: boolean): void {
	toolTuiFullscreen = value;
}

export function isToolTuiFullscreen(): boolean {
	return toolTuiFullscreen !== false;
}

function formatKeyPart(part: string): string {
	// Matches pi's built-in keybinding-hints: on macOS alt is shown as option
	return process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
}

/** Display text for the default expand shortcut (app.tools.expand); falls back to ctrl+o when unconfigured. */
export function expandShortcutText(): string {
	const keys = getKeybindings().getKeys("app.tools.expand");
	if (keys.length === 0) return "ctrl+o";
	return keys
		.join("/")
		.split("/")
		.map((part) => part.split("+").map(formatKeyPart).join("+"))
		.join("/");
}

export function showMoreHintText(): string {
	return isToolTuiFullscreen() ? "click to show more" : `${expandShortcutText()} to show more`;
}

/** Collapse hint for expanded cards, positioned symmetrically to the collapsed showMoreHintText. */
export function collapseHintText(): string {
	return isToolTuiFullscreen() ? "↑ Collapse" : `${expandShortcutText()} to collapse`;
}

/** Whether this row carries the expanded-state collapse hint (used for hint hover hit-testing on expanded cards). */
export function isCollapseHintLine(plainLine: string): boolean {
	return plainLine.includes(collapseHintText());
}
