import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { formatContextWindow, formatTokens } from "./startup-resources.ts";
import { CATEGORIES, categoryStyle, type ContextCategory, type ContextTheme } from "./startup-style.ts";
import type { ContextSource, StartupContextSnapshot } from "./startup-context.ts";

export type ContextRectangle = { x: number; y: number; width: number; height: number; source: ContextSource };
const positive = (sources: ContextSource[]) => sources.filter((source) => source.tokens > 0).sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Split at the closest cumulative half, then divide the longest physical axis. */
export function layoutContextTreemap(sources: ContextSource[], width: number, height: number): ContextRectangle[] {
	const result: ContextRectangle[] = [];
	function partition(items: ContextSource[], x: number, y: number, w: number, h: number): void {
		if (!items.length || w <= 0 || h <= 0) return;
		if (items.length === 1) {
			result.push({ x, y, width: w, height: h, source: items[0]! });
			return;
		}
		const horizontal = w >= 2 * h;
		const dimension = horizontal ? w : h;
		if (dimension < 2) {
			const category = items.every((item) => item.category === items[0]!.category) ? items[0]!.category : "other";
			result.push({ x, y, width: w, height: h, source: {
				id: `other:${items.map((item) => item.id).join(",")}`, category,
				label: `Other ${items.length}`, tokens: items.reduce((sum, item) => sum + item.tokens, 0), children: items,
			} });
			return;
		}
		const total = items.reduce((sum, item) => sum + item.tokens, 0);
		let best = 1;
		let partial = items[0]!.tokens;
		let distance = Math.abs(total / 2 - partial);
		for (let i = 2; i < items.length; i++) {
			partial += items[i - 1]!.tokens;
			const next = Math.abs(total / 2 - partial);
			if (next < distance) { best = i; distance = next; }
		}
		const left = items.slice(0, best);
		const leftWeight = left.reduce((sum, item) => sum + item.tokens, 0);
		const size = Math.max(0, Math.min(dimension, Math.round(dimension * leftWeight / total)));
		if (horizontal) {
			partition(left, x, y, size, h);
			partition(items.slice(best), x + size, y, w - size, h);
		} else {
			partition(left, x, y, w, size);
			partition(items.slice(best), x, y + size, w, h - size);
		}
	}
	partition(positive(sources), 0, 0, Math.max(0, Math.floor(width)), Math.max(0, Math.floor(height)));
	return result;
}

function fit(text: string, width: number): string { return truncateToWidth(text, width, "…"); }
function appendWrapped(lines: string[], parts: string[], width: number): void {
	let row = "";
	for (const part of parts) {
		if (visibleWidth(part) > width) {
			if (row) { lines.push(row); row = ""; }
			lines.push(fit(part, width));
			continue;
		}
		const next = row ? `${row}  ${part}` : part;
		if (visibleWidth(next) > width && row) { lines.push(row); row = part; }
		else row = next;
	}
	if (row) lines.push(row);
}
function totals(sources: ContextSource[]): Map<ContextCategory, number> {
	const values = new Map<ContextCategory, number>();
	for (const source of sources) values.set(source.category, (values.get(source.category) ?? 0) + source.tokens);
	return values;
}
/** Round cumulative boundaries; never assign a fake minimum cell to a small category. */
export function capacitySegments(snapshot: StartupContextSnapshot, width: number): Array<{ category?: ContextCategory; width: number }> {
	const window = snapshot.contextWindow;
	if (!window || width <= 0) return [];
	const segments: Array<{ category?: ContextCategory; width: number }> = [];
	let cumulative = 0;
	let previous = 0;
	for (const [category, tokens] of totals(snapshot.sources)) {
		cumulative += tokens;
		const end = Math.min(width, Math.round(width * cumulative / window));
		if (end > previous) segments.push({ category, width: end - previous });
		previous = end;
	}
	if (previous < width) segments.push({ width: width - previous });
	return segments;
}

function mapSources(sources: ContextSource[], width: number, height: number): ContextRectangle[] {
	const categories = layoutContextTreemap(sources, width, height);
	return categories.flatMap((tile) => {
		const children = positive(tile.source.children ?? []);
		if (!children.length || tile.width < 12 || tile.height < 2) return [tile];
		const minimum = tile.source.tokens / (tile.width * tile.height);
		const large = children.filter((item) => item.tokens >= minimum);
		const tiny = children.filter((item) => item.tokens < minimum);
		if (tiny.length) {
			const weight = tiny.reduce((n, item) => n + item.tokens, 0);
			if (weight * tile.width * tile.height < tile.source.tokens) return [tile];
			large.push({ id: `${tile.source.id}:other`, category: tile.source.category, label: `Other ${tiny.length}`, tokens: weight, children: tiny });
		}
		return layoutContextTreemap(large, tile.width, tile.height).map((child) => ({ ...child, x: child.x + tile.x, y: child.y + tile.y }));
	});
}

/** Resource map rendering only; collection and cache updates happen in the owner tick, never here. */
export function renderContextTreemap(snapshot: StartupContextSnapshot, width: number, theme: ContextTheme): string[] {
	width = Math.max(0, Math.floor(width));
	if (!width) return [];
	const lines: string[] = [];
	if (snapshot.stage === "initializing") return [fit("Starting context · loading…", width)];
	const window = snapshot.contextWindow;
	const percent = window ? Math.round(snapshot.usedEstimate * 100 / window) : undefined;
	const title = `${snapshot.stage === "starting" ? "Starting context" : "Context"} · ~${formatTokens(snapshot.usedEstimate)} / ${window ? formatContextWindow(window) : "window unknown"}${percent === undefined ? "" : ` · ${percent}%`}`;
	const suffix = ` · ${snapshot.modelLabel} · pi ${VERSION}`;
	const compact = `${snapshot.stage === "starting" ? "Start" : "Context"} · ~${formatTokens(snapshot.usedEstimate)}/${window ? formatContextWindow(window) : "?"}${percent === undefined ? "" : ` · ${percent}%`}`;
	lines.push(fit(width < 24 ? `~${formatTokens(snapshot.usedEstimate)}${percent === undefined ? " · window unknown" : ` · ${percent}%`}` : visibleWidth(title + suffix) <= width ? title + suffix : visibleWidth(title) <= width ? title : compact, width));
	if (snapshot.stage === "unavailable") lines.push(fit("Context estimate unavailable or partial", width));
	if (width < 24) {
		appendWrapped(lines, [...totals(snapshot.sources)].map(([category, tokens]) => `${CATEGORIES[category].label} ~${formatTokens(tokens)}`), width);
	} else {
		lines.push(fit("Sources · occupied context", width));
		const height = width >= 48 ? 4 : 2;
		const cells: Array<Array<{ char: string; category?: ContextCategory }>> = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ char: " " })));
		for (const rect of mapSources(snapshot.sources, width, height)) {
			for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) cells[y]![x] = { char: " ", category: rect.source.category };
			const name = `${rect.source.label} ~${formatTokens(rect.source.tokens)}`;
			if (rect.width >= visibleWidth(name) + 2 && rect.height > 0) {
				let col = rect.x + 1;
				let previousCell: number | undefined;
				for (const { segment } of graphemes.segment(name)) {
					const cellWidth = visibleWidth(segment);
					if (cellWidth === 0) {
						if (previousCell !== undefined) cells[rect.y]![previousCell]!.char += segment;
						continue;
					}
					if (col + cellWidth > rect.x + rect.width - 1 || col + cellWidth > width) break;
					cells[rect.y]![col] = { char: segment, category: rect.source.category };
					previousCell = col;
					for (let extra = 1; extra < cellWidth; extra++) cells[rect.y]![col + extra] = { char: "", category: rect.source.category };
					col += cellWidth;
				}
			}
		}
		for (const row of cells) {
			let output = "";
			for (let i = 0; i < row.length;) {
				const category = row[i]!.category;
				let end = i + 1;
				while (end < row.length && row[end]!.category === category) end++;
				const text = row.slice(i, end).map((cell) => cell.char).join("");
				output += category ? categoryStyle(theme, category).fill(text) : text;
				i = end;
			}
			lines.push(fit(output, width));
		}
	}
	if (window && width >= 24) {
		let strip = "";
		for (const segment of capacitySegments(snapshot, width)) {
			let content = " ".repeat(segment.width);
			if (!segment.category && segment.width >= 11) content = ` Available `.padEnd(segment.width);
			strip += segment.category ? categoryStyle(theme, segment.category).fill(content) : theme.fg("dim", content);
		}
		lines.push(strip);
	}
	const key = [...totals(snapshot.sources)].map(([category, tokens]) => categoryStyle(theme, category).swatch(`■ ${CATEGORIES[category].label} ~${formatTokens(tokens)}`));
	// Use visibleWidth so ANSI styling never changes wrap geometry.
	appendWrapped(lines, key, width);
	for (const caveat of snapshot.caveats) {
		const words = caveat.split(" ");
		let row = "";
		for (const word of words) {
			const next = row ? `${row} ${word}` : word;
			if (visibleWidth(next) > width && row) { lines.push(theme.fg("dim", row)); row = word; }
			else row = next;
		}
		if (row) lines.push(theme.fg("dim", fit(row, width)));
	}
	return lines;
}
