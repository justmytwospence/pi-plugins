import { backgroundAnsi, foregroundAnsi, mixColors, type Color, type TerminalColorMode } from "@earendil-works/pi-tui";

export type ResourceMark = { text: string; color: string; highlight?: boolean };
/** Connection and selection state, independent of source-category colors. */
export const GLYPHS = {
	live: { text: "●", color: "success" },
	attention: { text: "●", color: "warning" },
	failed: { text: "✕", color: "error" },
	pending: { text: "◌", color: "dim" },
	idle: { text: "○", color: "dim" },
	favorite: { text: "★", color: "warning" },
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
export function categoryStyle(theme: ContextTheme, category: ContextCategory): {
	swatch(text: string): string;
	fill(text: string): string;
} {
	const token = CATEGORIES[category].foreground;
	const color = theme.colors?.[token];
	const background = theme.colors?.userMessageBg;
	const labelColor = theme.colors?.text;
	const mode = theme.getColorMode?.();
	return {
		swatch: (text) => theme.fg(token, text),
		fill: (text) => color && background && labelColor && mode
			? `${foregroundAnsi(labelColor, mode)}${backgroundAnsi(mixColors(background, color, 0.2), mode)}${text}\x1b[0m`
			: theme.fg("text", text),
	};
}
