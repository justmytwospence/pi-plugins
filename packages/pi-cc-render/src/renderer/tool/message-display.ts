import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	SkillInvocationMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { MESSAGE_DISPLAY_PATCH, patchRegistry } from "../../utils/patch-keys.ts";
import { config } from "../../config/config.ts";
import { showMoreHintText } from "./show-more-hint.ts";
import { walkComponentTree } from "../../utils/component-tree.ts";

/**
 * Takes over three message components (`<skill>` block, compaction summary, branch summary); with ccstyle on they render in
 * the same single-line style as tool calls (● Title · hint), and fall back to native when off.
 *
 * All three share the same structure: Box + markdownTheme + updateDisplay; the constructor/setExpanded/invalidate
 * paths all go through updateDisplay, so patching one place covers everything. They don't go through
 * ToolExecutionComponent and can't reuse its prototype patch, so they are managed together here.
 */

// Matches the success check in renderer/index.ts renderCall: bright green ✓ (truecolor ANSI).
const BRIGHT_GREEN = "\x1b[38;2;80;220;100m";
const ANSI_FG_RESET = "\x1b[39m";

/** Latest theme synced from the event context (same source as toolGrouping.setTheme). */
let displayTheme: any;

export function setMessageDisplayTheme(theme: any): void {
	displayTheme = theme;
}

/** Lets the tool expanded panel background etc. share the same theme source (ctx.ui.theme). */
export function getMessageDisplayTheme(): any {
	return displayTheme;
}

type DisplayKind = {
	title(component: any): string;
	body(component: any): string;
};

const SKILL_KIND: DisplayKind = {
	title: (component) => `Skill ${String(component.skillBlock?.name ?? "skill")}`,
	body: (component) => String(component.skillBlock?.content ?? ""),
};

const COMPACTION_KIND: DisplayKind = {
	title: (component) =>
		`Compacted from ${Number(component.message?.tokensBefore ?? 0).toLocaleString()} tokens`,
	body: (component) => String(component.message?.summary ?? ""),
};

const BRANCH_KIND: DisplayKind = {
	title: () => "Branch summary",
	body: (component) => String(component.message?.summary ?? ""),
};

function ensureHintHover(component: any): void {
	if (typeof component.setHintHovered === "function") return;
	component.setHintHovered = function (this: any, hovered: boolean) {
		if (this.hintHovered === hovered) return;
		this.hintHovered = hovered;
		this.invalidate?.();
	};
}

function renderCcstyle(component: any, kind: DisplayKind): void {
	const theme = displayTheme;
	if (!theme) return; // Keep native rendering until the theme is ready
	if (component.bgFn) component.setBgFn?.(undefined); // Match tool calls: remove the gray background
	if (component.paddingY !== 0) {
		component._ccstyleOriginalPaddingY = component.paddingY;
		component.paddingY = 0; // Tool components use paddingY=0; native Box defaults to 1, leaving a blank line above and below
	}
	component.clear();
	ensureHintHover(component);
	const icon = `${BRIGHT_GREEN}✓${ANSI_FG_RESET}`; // Completed message, equivalent to tool success state
	const title = theme.fg("toolTitle", kind.title(component));
	if (!component.expanded) {
		const hovered = component.hintHovered === true;
		const hint = `${theme.fg("dim", " · ")}${theme.fg(hovered ? "text" : "dim", showMoreHintText())}`;
		component.addChild(new Text(`${icon} ${title}${hint}`, 0, 0));
		return;
	}
	// Expanded card matches tools: same expanded card background + 1 cell on every side
	component.paddingX = 1;
	component.paddingY = 1;
	if (typeof theme.bg === "function" && typeof component.setBgFn === "function") {
		component.setBgFn((text: string) => theme.bg(config.expandedCardBackground, text));
	}
	component.addChild(new Text(`${icon} ${title}`, 0, 0));
	component.addChild(new Spacer(1));
	component.addChild(
		new Markdown(kind.body(component), 0, 0, component.markdownTheme, {
			color: (text: string) => theme.fg("customMessageText", text),
		}),
	);
}

type PatchEntry = {
	prototype: any;
	installed: (...args: any[]) => void;
	original: (...args: any[]) => void;
};

/** Patch updateDisplay of the three message components; returns a unified dispose (safe across /reload chains). */
export function installMessageDisplayRendering(): () => void {
	const previous = patchRegistry.get<{ dispose: () => void }>(MESSAGE_DISPLAY_PATCH);
	if (previous) previous.dispose();
	const patch: { active: boolean; entries: PatchEntry[]; dispose: () => void } = {
		active: true,
		entries: [],
		dispose: () => {},
	};
	const installOne = (ComponentClass: any, kind: DisplayKind): void => {
		const prototype = ComponentClass.prototype;
		const original = prototype.updateDisplay;
		const installed = function (this: any) {
			if (patch.active && config.mode !== "off") {
				try {
					renderCcstyle(this, kind);
					return;
				} catch {
					// Fall back to native on render failure
				}
			}
			// Restore paddingY before falling back to native, so native rendering keeps its vertical padding
			if (this._ccstyleOriginalPaddingY !== undefined) {
				this.paddingY = this._ccstyleOriginalPaddingY;
				delete this._ccstyleOriginalPaddingY;
			}
			original.call(this);
		};
		prototype.updateDisplay = installed;
		patch.entries.push({ prototype, installed, original });
	};
	installOne(SkillInvocationMessageComponent, SKILL_KIND);
	installOne(CompactionSummaryMessageComponent, COMPACTION_KIND);
	installOne(BranchSummaryMessageComponent, BRANCH_KIND);
	patch.dispose = () => {
		patch.active = false;
		for (const entry of patch.entries) {
			if (entry.prototype.updateDisplay === entry.installed) {
				entry.prototype.updateDisplay = entry.original;
			}
		}
		patchRegistry.dispose(MESSAGE_DISPLAY_PATCH, patch);
	};
	patchRegistry.install(MESSAGE_DISPLAY_PATCH, patch);
	return patch.dispose;
}

/** Structural trait shared by the three message components; CustomMessageComponent uses rebuild without updateDisplay, so it doesn't match. */
export function isMessageDisplayComponent(value: any): boolean {
	return Boolean(
		value &&
			typeof value === "object" &&
			typeof value.markdownTheme === "object" &&
			typeof value.setExpanded === "function" &&
			typeof value.updateDisplay === "function" &&
			typeof value.clear === "function",
	);
}

/** Walk the current transcript and re-render mounted message components in the current mode (/ccstyle on|off toggle). */
export function refreshMessageDisplays(root: any): void {
	walkComponentTree(root, (value: any) => {
		if (isMessageDisplayComponent(value)) {
			value.invalidate?.();
			return false;
		}
	});
}
