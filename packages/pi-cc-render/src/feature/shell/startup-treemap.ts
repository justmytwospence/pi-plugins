import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

function categoryTiles(sources: ContextSource[], width: number, height: number): ContextRectangle[] {
	const categories: ContextSource[] = [...totals(sources)].map(([category, tokens]) => ({
		id: category, category, label: CATEGORIES[category].label, tokens,
	}));
	return layoutContextTreemap(categories, width, height);
}

/** Mark only readable child-sized regions; collect tiny leaves into one unmarked remainder. */
function itemBreaks(sources: ContextSource[], tile: ContextRectangle): number[] {
	const leaves = positive(sources.filter((source) => source.category === tile.source.category)
		.flatMap((source) => source.children?.length ? source.children : [source]));
	if (leaves.length < 2 || tile.width < 9) return [];
	const minimum = tile.source.tokens * 4 / tile.width;
	const large = leaves.filter((leaf) => leaf.tokens >= minimum);
	const other = leaves.filter((leaf) => leaf.tokens < minimum).reduce((sum, leaf) => sum + leaf.tokens, 0);
	const weights = [...large.map((leaf) => leaf.tokens), ...(other >= minimum ? [other] : [])];
	let consumed = 0;
	let previous = 0;
	const breaks: number[] = [];
	for (const weight of weights.slice(0, -1)) {
		consumed += weight;
		const boundary = Math.round(tile.width * consumed / tile.source.tokens);
		if (boundary - previous < 4 || tile.width - boundary < 4) continue;
		breaks.push(tile.x + boundary);
		previous = boundary;
	}
	return breaks;
}

/** Resource map rendering only; collection and cache updates happen in the owner tick, never here. */
export function renderContextTreemap(snapshot: StartupContextSnapshot, width: number, theme: ContextTheme): string[] {
	width = Math.max(0, Math.floor(width));
	if (!width) return [];
	const lines: string[] = [];
	if (snapshot.stage === "initializing") return [fit("Starting context · loading…", width)];
	const window = snapshot.contextWindow;
	const percent = window ? Math.round(snapshot.usedEstimate * 100 / window) : undefined;
	const summary = `${snapshot.stage === "starting" ? "Starting context" : "Context"} · ${percent === undefined ? `~${formatTokens(snapshot.usedEstimate)} · window unknown` : `${percent}% of ${formatContextWindow(window)} (~${formatTokens(snapshot.usedEstimate)})`}`;
	const title = `${summary} · ${snapshot.modelLabel}`;
	const compact = `${snapshot.stage === "starting" ? "Start" : "Context"} · ~${formatTokens(snapshot.usedEstimate)}/${window ? formatContextWindow(window) : "?"}${percent === undefined ? "" : ` · ${percent}%`}`;
	lines.push(fit(width < 24 ? `~${formatTokens(snapshot.usedEstimate)}${percent === undefined ? " · window unknown" : ` · ${percent}%`}` : visibleWidth(title) <= width ? title : visibleWidth(summary) <= width ? summary : compact, width));
	if (snapshot.stage === "unavailable") lines.push(fit("Context estimate unavailable or partial", width));
	if (width < 24) {
		appendWrapped(lines, [...totals(snapshot.sources)].map(([category, tokens]) => `${CATEGORIES[category].label} ~${formatTokens(tokens)}`), width);
	} else if (snapshot.sources.length) {
		const height = 2;
		const cells: Array<Array<{ char: string; category?: ContextCategory }>> = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ char: " " })));
		const unlabeled: ContextSource[] = [];
		for (const rect of categoryTiles(snapshot.sources, width, height)) {
			for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) cells[y]![x] = { char: " ", category: rect.source.category };
			const full = `${rect.source.label} ~${formatTokens(rect.source.tokens)}`;
			const name = rect.width >= visibleWidth(full) + 2 ? full : rect.width >= visibleWidth(rect.source.label) + 2 ? rect.source.label : "";
			if (!name) unlabeled.push(rect.source);
			let col = rect.x + 1;
			for (const { segment } of graphemes.segment(name)) {
				const cellWidth = visibleWidth(segment);
				if (!cellWidth || col + cellWidth > rect.x + rect.width - 1 || col + cellWidth > width) break;
				cells[rect.y]![col] = { char: segment, category: rect.source.category };
				for (let extra = 1; extra < cellWidth; extra++) cells[rect.y]![col + extra] = { char: "", category: rect.source.category };
				col += cellWidth;
			}
			if (rect.height > 1) for (const x of itemBreaks(snapshot.sources, rect)) {
				// The divider stays inside the category's colored fill, never exposing the default background.
				cells[rect.y + 1]![x] = { char: "│", category: rect.source.category };
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
		if (unlabeled.length) appendWrapped(lines, unlabeled.map((source) => `${source.label} ~${formatTokens(source.tokens)}`), width);
	} else lines.push(fit("No attributed sources", width));
	for (const caveat of snapshot.caveats) {
		const words = caveat.split(" ");
		let row = "";
		for (const word of words) {
			const next = row ? `${row} ${word}` : word;
			if (visibleWidth(next) > width && row) { lines.push(theme.fg("dim", fit(row, width))); row = word; }
			else row = next;
		}
		if (row) lines.push(theme.fg("dim", fit(row, width)));
	}
	return lines;
}
