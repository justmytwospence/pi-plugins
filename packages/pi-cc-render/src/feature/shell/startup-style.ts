import { colorToRgb, mixColors, styleText, type Color, type TerminalColorMode } from "@earendil-works/pi-tui";

export type ResourceMark = { text: string; color: string; highlight?: boolean };
/** Connection and selection state, independent of source-category colors. */
export const GLYPHS = {
	live: { text: "●", color: "success" },
	attention: { text: "◆", color: "warning" },
	failed: { text: "✕", color: "error" },
	pending: { text: "◌", color: "dim" },
	idle: { text: "○", color: "dim" },
	favorite: { text: "★", color: "muted" },
} as const satisfies Record<string, ResourceMark>;

export const CATEGORIES = {
	system: { label: "System", foreground: "accent" },
	files: { label: "Files", foreground: "mdLink" },
	skills: { label: "Skills", foreground: "customMessageLabel" },
	tools: { label: "Tools", foreground: "syntaxNumber" },
	mcp: { label: "MCP", foreground: "syntaxKeyword" },
	history: { label: "History", foreground: "muted" },
	other: { label: "Other", foreground: "dim" },
} as const;
export type ContextCategory = keyof typeof CATEGORIES;

export type ContextTheme = {
	fg(name: string, text: string): string;
	bold?(text: string): string;
	getFgAnsi?(name: string): string;
	getBgAnsi?(name: string): string;
	colors?: Readonly<Record<string, Color>>;
	getColorMode?: () => TerminalColorMode;
};

/** Resolve on each repaint: theme invalidation may replace concrete colors in-place. */
export function categoryStyle(theme: ContextTheme, category: ContextCategory): { swatch(text: string): string } {
	return { swatch: (text) => theme.fg(CATEGORIES[category].foreground, text) };
}

export type CategoryBlockKind = "first" | "second" | "remainder";

/** A percentage block's fill and readable text, derived afresh from the active theme. */
export function categoryBlockStyle(theme: ContextTheme, category: ContextCategory, kind: CategoryBlockKind): ((text: string) => string) | undefined {
	const colors = theme.colors;
	const foreground = colors?.[CATEGORIES[category].foreground];
	const background = colors?.background ?? colors?.userMessageBg;
	const text = colors?.text;
	const mode = theme.getColorMode?.();
	if (!foreground || !background || !text || !mode) return undefined;
	const tint = mixColors(foreground, background, { first: 0.08, second: 0.45, remainder: 0.78 }[kind]);
	const luminance = (color: Color) => {
		const { r, g, b } = colorToRgb(color);
		const linear = (channel: number) => {
			const unit = channel / 255;
			return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
		};
		return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
	};
	const tintLight = luminance(tint);
	const contrast = (color: Color) => {
		const light = luminance(color);
		return (Math.max(light, tintLight) + 0.05) / (Math.min(light, tintLight) + 0.05);
	};
	const label = contrast(text) >= contrast(background) ? text : background;
	return (value) => styleText(value, { bg: tint, fg: label }, mode);
}
