import { InteractiveMode, VERSION, type AppKeybinding } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "../../config/config.ts";
import { ansi16ToRgb, ansi256ToRgb } from "../../utils/ansi-color.ts";
import { stripAnsi } from "../../utils/ansi-text.ts";
import {
	EARLY_STARTUP_HEADER_PATCH,
	EARLY_STARTUP_HEADER_SWAP_KEY,
	patchRegistry,
} from "../../utils/patch-keys.ts";
type Rgb = [number, number, number];
type StyledPart = {
	raw: string;
	styled: string;
};

const ANSI_RESET = "\x1b[0m";

// Static logo from the official install.sh (4 lines verbatim, short lines padded with trailing spaces to 8 columns) plus a blank bottom line to reach 5 lines,
// matching the height of the tips on the right; coloring is unchanged (accent gradient)
const LOGO_LINES = ["██████  ", "██  ██  ", "████  ██", "██    ██", "        "];

// Hero text (single line, replaces the native header's default "Pi can explain..." position)
const HERO_PREFIX = "There are many agent harnesses, but this one is ";
const HERO_HIGHLIGHT = "yours";
const HERO_SUFFIX = ".";

// Two-column layout: logo on the left (5 lines), native tips on the right (5 lines)
const TWO_COL_GAP = 2;
// Below this width, fall back to vertical stacking (logo + hero)
const TWO_COL_MIN_WIDTH = 48;

const FALLBACK_ACCENT_RGB: Rgb = [80, 160, 255];
const LOGO_BLOCK_WIDTH = Math.max(...LOGO_LINES.map((line) => [...line].length));
// Left column width = logo width; the right column starts after it
const LEFT_COLUMN_WIDTH = LOGO_BLOCK_WIDTH;

const PALETTE_STEPS = 24;
const PALETTE_MAX_DARKEN = 0.18;
const PALETTE_MAX_LIGHTEN = 0.18;
// In-row gradient wavelength: 1/4 of a full wave (monotonic dark to bright, avoids flicker within rows with few characters)
const PALETTE_SPAN = 0.25;
// Row-to-row phase offset: small cumulative steps give an overall diagonal gradient, dark top-left to bright bottom-right
const LOGO_ROW_PHASE_STEP = 0.08;

function getVisibleLength(text: string): number {
	return [...stripAnsi(text)].length;
}

function clampByte(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)));
}

function interpolateChannel(start: number, end: number, factor: number): number {
	return Math.round(start + (end - start) * factor);
}

function interpolateRgb(start: Rgb, end: Rgb, factor: number): Rgb {
	return [
		interpolateChannel(start[0], end[0], factor),
		interpolateChannel(start[1], end[1], factor),
		interpolateChannel(start[2], end[2], factor),
	];
}

function darkenRgb(rgb: Rgb, amount: number): Rgb {
	return [
		clampByte(rgb[0] * (1 - amount)),
		clampByte(rgb[1] * (1 - amount)),
		clampByte(rgb[2] * (1 - amount)),
	];
}

function lightenRgb(rgb: Rgb, amount: number): Rgb {
	return [
		clampByte(rgb[0] + (255 - rgb[0]) * amount),
		clampByte(rgb[1] + (255 - rgb[1]) * amount),
		clampByte(rgb[2] + (255 - rgb[2]) * amount),
	];
}

function applyTruecolor(rgb: Rgb, text: string): string {
	const [red, green, blue] = rgb;
	return `\x1b[38;2;${red};${green};${blue}m${text}${ANSI_RESET}`;
}

function parseTruecolorAnsi(ansi: string): Rgb | undefined {
	const match = ansi.match(/38;2;(\d+);(\d+);(\d+)/);
	if (!match) return undefined;

	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseAnsi256Foreground(ansi: string): Rgb | undefined {
	const match = ansi.match(/38;5;(\d+)/);
	if (!match) return undefined;

	return ansi256ToRgb(Number(match[1]));
}

function parseAnsi16Foreground(ansi: string): Rgb | undefined {
	const normalMatch = ansi.match(/(?:\[|;)(3[0-7])(?:;|m)/);
	if (normalMatch) {
		return ansi16ToRgb(Number(normalMatch[1]) - 30);
	}

	const brightMatch = ansi.match(/(?:\[|;)(9[0-7])(?:;|m)/);
	if (brightMatch) {
		return ansi16ToRgb(Number(brightMatch[1]) - 90 + 8);
	}

	return undefined;
}

function parseForegroundRgbFromAnsi(ansi: string): Rgb | undefined {
	return parseTruecolorAnsi(ansi) ?? parseAnsi256Foreground(ansi) ?? parseAnsi16Foreground(ansi);
}

function resolveAccentRgb(theme: { getFgAnsi(name: string): string }): Rgb {
	return parseForegroundRgbFromAnsi(theme.getFgAnsi("accent")) ?? FALLBACK_ACCENT_RGB;
}

function buildAccentPalette(accent: Rgb): Rgb[] {
	return Array.from({ length: PALETTE_STEPS }, (_, index) => {
		const progress = index / PALETTE_STEPS;
		const wave = -Math.cos(progress * Math.PI * 2);

		if (wave < 0) {
			return darkenRgb(accent, PALETTE_MAX_DARKEN * -wave);
		}

		return lightenRgb(accent, PALETTE_MAX_LIGHTEN * wave);
	});
}

function sampleGradientColor(palette: Rgb[], position: number): Rgb {
	const wrappedPosition = ((position % 1) + 1) % 1;
	const scaledPosition = wrappedPosition * palette.length;
	const baseIndex = Math.floor(scaledPosition) % palette.length;
	const nextIndex = (baseIndex + 1) % palette.length;
	const factor = scaledPosition - Math.floor(scaledPosition);

	return interpolateRgb(palette[baseIndex]!, palette[nextIndex]!, factor);
}

function renderGradientText(text: string, palette: Rgb[], phase: number): string {
	const characters = [...text];
	const span = Math.max(characters.length - 1, 1);

	return characters
		.map((character, index) => {
			if (character === " ") return character;
			// Monotonic dark to bright within a row (1/4 wavelength), phase offset between rows gives a diagonal gradient
			const color = sampleGradientColor(palette, (index / span) * PALETTE_SPAN + phase);
			return applyTruecolor(color, character);
		})
		.join("");
}

function createCenteredBlockLine(text: string, width: number, blockWidth: number): string {
	const leftPadding = Math.max(0, Math.floor((width - blockWidth) / 2));
	return `${" ".repeat(leftPadding)}${text}`;
}

function createCenteredStyledLine(parts: StyledPart[], width: number): string {
	const rawText = parts.map((part) => part.raw).join("");
	const leftPadding = Math.max(0, Math.floor((width - [...rawText].length) / 2));
	const styledText = parts.map((part) => part.styled).join("");
	return `${" ".repeat(leftPadding)}${styledText}`;
}

function fitLineToWidth(line: string, width: number): string {
	if (getVisibleLength(line) <= width) {
		return line;
	}

	return stripAnsi(line).slice(0, width);
}

function renderLogoLines(width: number, palette: Rgb[]): string[] {
	return LOGO_LINES.map((line, rowIndex) => {
		const phasedLine = renderGradientText(line, palette, rowIndex * LOGO_ROW_PHASE_STEP);
		return createCenteredBlockLine(phasedLine, width, LOGO_BLOCK_WIDTH);
	});
}

// ---- Right side: native default header text (matches pi's built-in startup header; key text follows the user's keybindings) ----

function formatKeyPart(part: string): string {
	// Same as pi's built-in keybinding-hints: alt is shown as option on macOS
	return process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
}

function formatKeyText(key: string): string {
	return key
		.split("/")
		.map((part) => part.split("+").map(formatKeyPart).join("+"))
		.join("/");
}

function keyText(keybinding: AppKeybinding): string {
	const keys = getKeybindings().getKeys(keybinding);
	return keys.length === 0 ? "" : formatKeyText(keys.join("/"));
}

function renderNativeLines(theme: {
	fg(name: string, text: string): string;
	bold(text: string): string;
}): string[] {
	// Color scheme copied from pi's built-in header: keys dim, descriptions muted, separators muted, version dim
	const hint = (keybinding: AppKeybinding, description: string) =>
		theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
	const rawHint = (key: string, description: string) =>
		theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);

	const logo = theme.bold(theme.fg("accent", "pi")) + theme.fg("dim", ` v${VERSION}`);
	const compact = [
		hint("app.interrupt", "interrupt"),
		rawHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
		rawHint("/", "commands"),
		rawHint("!", "bash"),
		hint("app.tools.expand", "more"),
	].join(theme.fg("muted", " · "));

	return [
		logo,
		compact,
		theme.fg(
			"dim",
			`Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.`,
		),
		"",
		// Hero text replaces the native "Pi can explain..." line position
		renderHeroParts(theme)
			.map((part) => part.styled)
			.join(""),
	];
}

function renderHeroParts(theme: {
	fg(name: string, text: string): string;
	bold(text: string): string;
}): StyledPart[] {
	return [
		{ raw: HERO_PREFIX, styled: theme.fg("accent", HERO_PREFIX) },
		{ raw: HERO_HIGHLIGHT, styled: theme.bold(theme.fg("mdLink", HERO_HIGHLIGHT)) },
		{ raw: HERO_SUFFIX, styled: theme.fg("accent", HERO_SUFFIX) },
	];
}

export function renderHeaderLines(
	width: number,
	theme: {
		getFgAnsi(name: string): string;
		fg(name: string, text: string): string;
		bold(text: string): string;
	},
): string[] {
	const accentRgb = resolveAccentRgb(theme);
	const palette = buildAccentPalette(accentRgb);

	if (width < TWO_COL_MIN_WIDTH) {
		// Narrow-screen fallback: logo + hero stacked vertically on a single line, centered
		const logoLines = renderLogoLines(width, palette);
		const heroLine = createCenteredStyledLine(renderHeroParts(theme), width);
		return ["", ...logoLines, "", heroLine, ""].map((line) => fitLineToWidth(line, width));
	}

	// Two columns: official logo (5 lines) on the left, native tips (5 lines) on the right, same height side by side, separated by a gap without overlap
	const leftLines = renderLogoLines(LEFT_COLUMN_WIDTH, palette);
	const rightLines = renderNativeLines(theme);
	const rightWidth = width - LEFT_COLUMN_WIDTH - TWO_COL_GAP;
	const padTop = Math.floor((rightLines.length - leftLines.length) / 2);
	const paddedLeft = [
		...Array.from({ length: padTop }, () => ""),
		...leftLines,
		...Array.from({ length: rightLines.length - leftLines.length - padTop }, () => ""),
	];

	return paddedLeft.map(
		(line, index) =>
			`${line}${" ".repeat(TWO_COL_GAP)}${fitLineToWidth(rightLines[index] ?? "", rightWidth)}`,
	);
}

/** Component factory for the host's setHeader: the theme is injected by the host. */
function headerFactory(): (
	tui: unknown,
	theme: any,
) => {
	render(width: number): string[];
	invalidate(): void;
} {
	return (_tui: unknown, theme: any) => ({
		render(width: number): string[] {
			return renderHeaderLines(width, theme);
		},
		invalidate() {},
	});
}

/** Installs the startup header per config. When disabled, leaves the slot alone so other extensions' headers are not cleared. */
export function applyStartupHeader(ctx: any): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setHeader !== "function" || !config.showStartupHeader) {
		return;
	}
	ctx.ui.setHeader(headerFactory());
}

type EarlyHeaderPatch = {
	active: boolean;
	original: (...args: any[]) => unknown;
	installed: (...args: any[]) => unknown;
};

type HeaderContainerSwap = {
	original: (child: any) => unknown;
	installed: (child: any) => unknown;
};

/**
 * Pi draws the native startup header before session_start: init() builds the header and calls requestRender,
 * and only then awaits tool checks and loads extensions, so an extension can at earliest swap the header at session_start, flashing the native header at startup.
 * This supplements init: the moment the native header enters the container it is replaced with ccstyle's, so the first paint is already ours.
 * Detection uses child === mode.builtInHeader, not class names; when disabled in config the slot is left alone and the native header is kept.
 */
export function installEarlyStartupHeader(): void {
	const prototype = (InteractiveMode as any)?.prototype;
	if (!prototype || typeof prototype.init !== "function") return;
	const previous = patchRegistry.get<EarlyHeaderPatch>(EARLY_STARTUP_HEADER_PATCH);
	if (previous) previous.active = false;
	const original =
		previous && prototype.init === previous.installed ? previous.original : prototype.init;
	const patch: EarlyHeaderPatch = {
		active: true,
		original,
		installed: async function (this: any, ...args: any[]) {
			installHeaderContainerSwap(this, patch);
			return original.apply(this, args);
		},
	};
	prototype.init = patch.installed;
	patchRegistry.install(EARLY_STARTUP_HEADER_PATCH, patch);
}

/** Wraps headerContainer.addChild only once; after /reload the old wrapper is taken over based on ownership. */
function installHeaderContainerSwap(mode: any, patch: EarlyHeaderPatch): void {
	const container = mode?.headerContainer;
	if (!container || typeof container.addChild !== "function") return;
	const previous = container[EARLY_STARTUP_HEADER_SWAP_KEY] as HeaderContainerSwap | undefined;
	const original =
		previous && container.addChild === previous.installed
			? previous.original
			: container.addChild.bind(container);
	const installed = function (child: any) {
		const result = original(child);
		if (!patch.active || !config.showStartupHeader || child !== mode.builtInHeader) return result;
		if (typeof mode.setExtensionHeader !== "function") return result;
		try {
			mode.setExtensionHeader(headerFactory());
		} catch {
			// If swapping the header fails, fall back to the native header without affecting startup
		}
		return result;
	};
	container.addChild = installed;
	container[EARLY_STARTUP_HEADER_SWAP_KEY] = { original, installed };
}

/** When the user turns off this extension's startup header from /ccstyle, restores the host header. */
export function clearStartupHeader(ctx: any): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setHeader !== "function") return;
	ctx.ui.setHeader(undefined);
}

export default function piStartupHeader(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		applyStartupHeader(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setHeader(undefined);
	});
}
