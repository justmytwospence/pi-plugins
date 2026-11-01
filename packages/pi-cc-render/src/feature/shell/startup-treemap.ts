import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatContextWindow, formatTokens } from "./startup-resources.ts";
import { CATEGORIES, categoryBlockStyle, categoryStyle, type CategoryBlockKind, type ContextCategory, type ContextTheme } from "./startup-style.ts";
import { ESTIMATE_CAVEAT, type ContextSource, type StartupContextSnapshot } from "./startup-context.ts";

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

/** Divide one category into its two leading sources (when each fits four cells) and their remainder.
 * MCP's leaves are server totals, not the declarations nested within each server.
 */
export function categoryShareBlocks(sources: ContextSource[], tile: ContextRectangle): Array<{ kind: CategoryBlockKind; start: number; width: number; tokens: number }> {
	const categorySources = sources.filter((source) => source.category === tile.source.category);
	const leaves = positive(tile.source.category === "mcp"
		? categorySources
		: categorySources.flatMap((source) => source.children?.length ? source.children : [source]));
	if (!tile.width || !tile.source.tokens) return [];
	if (leaves.length === 1) return [{ kind: "first", start: 0, width: tile.width, tokens: tile.source.tokens }];
	const blocks: Array<{ kind: CategoryBlockKind; start: number; width: number; tokens: number }> = [];
	let start = 0;
	let shownTokens = 0;
	for (const [index, leaf] of leaves.slice(0, 2).entries()) {
		const share = Math.round(tile.width * leaf.tokens / tile.source.tokens);
		const end = Math.min(tile.width, Math.round(tile.width * (shownTokens + leaf.tokens) / tile.source.tokens));
		if (share < 4 || end - start < 4) break;
		blocks.push({ kind: index === 0 ? "first" : "second", start, width: end - start, tokens: leaf.tokens });
		start = end;
		shownTokens += leaf.tokens;
	}
	if (start < tile.width) blocks.push({ kind: "remainder", start, width: tile.width - start, tokens: Math.max(0, tile.source.tokens - shownTokens) });
	return blocks;
}

function paintShareBlock(theme: ContextTheme, category: ContextCategory, block: ReturnType<typeof categoryShareBlocks>[number], total: number): string {
	const paint = categoryBlockStyle(theme, category, block.kind);
	if (!paint) return categoryStyle(theme, category).swatch(({ first: "█", second: "▓", remainder: "░" }[block.kind]).repeat(block.width));
	const percent = `${Math.round(100 * block.tokens / total)}%`;
	const label = block.width >= visibleWidth(percent) + 2 ? percent : "";
	const left = Math.floor((block.width - visibleWidth(label)) / 2);
	return paint(`${" ".repeat(left)}${label}${" ".repeat(block.width - left - visibleWidth(label))}`);
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
	const effort = snapshot.thinkingLevel ? `:${snapshot.thinkingLevel}` : "";
	const title = `${summary} · ${snapshot.modelLabel}${effort}`;
	const compact = `${snapshot.stage === "starting" ? "Start" : "Context"} · ~${formatTokens(snapshot.usedEstimate)}/${window ? formatContextWindow(window) : "?"}${percent === undefined ? "" : ` · ${percent}%`}`;
	const briefModel = snapshot.modelLabel.split("/").at(-1) ?? snapshot.modelLabel;
	const shortTitle = `${snapshot.stage === "starting" ? "Start" : "Context"} ${percent === undefined ? `~${formatTokens(snapshot.usedEstimate)}` : `${percent}%`}/${window ? formatContextWindow(window) : "?"} · ${briefModel}${effort}`;
	lines.push(fit(width < 24 ? `~${formatTokens(snapshot.usedEstimate)}${percent === undefined ? " · window unknown" : ` · ${percent}%`}` : visibleWidth(title) <= width ? title : visibleWidth(shortTitle) <= width ? shortTitle : visibleWidth(summary) <= width ? summary : compact, width));
	if (snapshot.stage === "unavailable") lines.push(fit("Context estimate unavailable or partial", width));
	if (width < 24) {
		appendWrapped(lines, [...totals(snapshot.sources)].map(([category, tokens]) => `${CATEGORIES[category].label} ~${formatTokens(tokens)}`), width);
	} else if (snapshot.sources.length) {
		type Cell = { char: string; category?: ContextCategory };
		const labels: Cell[] = Array.from({ length: width }, () => ({ char: " " }));
		const bar = Array<string>(width).fill(" ");
		const named = new Set<ContextCategory>();
		const complete = new Set<ContextCategory>();
		for (const rect of categoryTiles(snapshot.sources, width, 1)) {
			for (const block of categoryShareBlocks(snapshot.sources, rect)) {
				bar.fill("", rect.x + block.start, rect.x + block.start + block.width);
				bar[rect.x + block.start] = paintShareBlock(theme, rect.source.category, block, rect.source.tokens);
			}
			const full = `${rect.source.label} ~${formatTokens(rect.source.tokens)}`;
			const label = rect.width >= visibleWidth(full) + 2 ? full : rect.width >= visibleWidth(rect.source.label) + 2 ? rect.source.label : "";
			if (label) {
				named.add(rect.source.category);
				if (label === full) complete.add(rect.source.category);
				let col = rect.x + 1;
				for (const { segment } of graphemes.segment(label)) {
					const cellWidth = visibleWidth(segment);
					if (!cellWidth || col + cellWidth > rect.x + rect.width - 1) break;
					labels[col] = { char: segment, category: rect.source.category };
					for (let extra = 1; extra < cellWidth; extra++) labels[col + extra] = { char: "", category: rect.source.category };
					col += cellWidth;
				}
			}
		}
		const paint = (cells: Cell[]) => {
			let output = "";
			for (let i = 0; i < cells.length;) {
				const category = cells[i]!.category;
				let end = i + 1;
				while (end < cells.length && cells[end]!.category === category) end++;
				const text = cells.slice(i, end).map((cell) => cell.char).join("");
				output += category ? categoryStyle(theme, category).swatch(text) : text;
				i = end;
			}
			return fit(output, width);
		};
		if (named.size) lines.push(paint(labels));
		lines.push(fit(bar.join(""), width));
		const missing = [...totals(snapshot.sources)].filter(([category]) => !complete.has(category));
		if (missing.length) {
			// These are totals for categories too narrow to show their full name and cost above the bar.
			const key = missing.map(([category, tokens]) =>
				categoryStyle(theme, category).swatch(`■ ${CATEGORIES[category].label} ~${formatTokens(tokens)}`));
			key[0] = `${theme.fg("dim", width >= 80 ? "Small category totals: " : "Key: ")}${key[0]}`;
			appendWrapped(lines, key, width);
		}
	} else lines.push(fit("No attributed sources", width));
	for (const caveat of snapshot.caveats) {
		// The approximate token notation and docs retain the caveat without a repeated startup line.
		if (caveat === ESTIMATE_CAVEAT) continue;
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
