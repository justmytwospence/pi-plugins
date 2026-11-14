import path from "node:path";
import { InteractiveMode, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import {
	McpConfigCache,
	McpStatusReader,
	type McpObservation,
	type McpEntry,
	type McpLevel,
	type McpStatus,
	configWarning,
	loadMcpEntries,
	normalizeMcpName,
	toolCounts,
	mcpState,
	parseAttentionMessage,
	parseOutcomeMessage,
} from "./mcp-servers.ts";
import { MCP_NOTIFY_PATCH, STARTUP_RESOURCES_PATCH, patchRegistry } from "../../utils/patch-keys.ts";
import { categoryStyle, GLYPHS } from "./startup-style.ts";
import { readStartupContext, type StartupContextSnapshot } from "./startup-context.ts";
import { renderContextTreemap } from "./startup-treemap.ts";
import { attachStartupHost, disposeStartupHost } from "./startup-state.ts";
import { queryWaterfall, type WaterfallRung, type WaterfallSnapshot } from "../../waterfall-contract.ts";
import { querySystem1State, type System1Status } from "../../system1-contract.ts";
import { createInteractiveSection, createSplashActionController } from "./startup-interactions.ts";
export { GLYPHS } from "./startup-style.ts";

/**
 * Readable replacement for the startup listing ([Extensions] / [Context] / [Skills] / [Prompts]).
 *
 * Pi prints each section as one comma-joined run of labels, which for extensions means a wall of repeated
 * `owner/repo:packages/pi-x/src` paths. Here every section gets a heading with a count, and every section
 * (Extensions, Context, Skills, Prompts, MCP) is split the same way: by level (project, then user, then
 * path or extension), each level labelled with its count even when it is the only one. Inside a level,
 * local entries come first, then packages (one sub-heading per package with several entries, the rest
 * together under `packages`), as pi's own expanded listing nests them. Entries show by short name in
 * aligned columns.
 * Context files and skills are what the model carries in every request, so they also show an estimated
 * token cost: a total on the heading, per-file counts for context files (largest first) and a count
 * after every skill, colored by weight (dim, muted, warning, error). Ctrl+O reveals the full custom listing.
 */

type Scope = "user" | "project" | "path";

export type ResourceEntry = {
	/** Short display name. */
	name: string;
	/** Package source label (npm name or git owner/repo); undefined for local files. */
	source?: string;
	scope: Scope;
	/** Estimated tokens this entry adds to every request; undefined when it adds none or is not measured. */
	tokens?: number;
};

export type ResourceGroup = {
	/** Sub-heading; undefined when the section needs none. */
	label?: string;
	items: string[];
	/** Original count, including entries represented by a folded heading. */
	count?: number;
	/** Entire subtree represented by this heading; no individual entries are hidden. */
	foldedCount?: number;
	/** Groups nested under this one, after its own items (a level's packages). */
	children?: ResourceGroup[];
	/** Estimated tokens per item, parallel to `items`; present only when the section measures them. */
	tokens?: number[];
	/** A colored word after an item, parallel to `items`; undefined entries have none. */
	marks?: Array<ResourceMark | undefined>;
	/** A one-character colored marker before an item (lines and columns layouts), parallel to `items`; blank where undefined. */
	prefixes?: Array<ResourceMark | undefined>;
	/**
	 * Right-aligned text after an item (lines and columns layouts), parallel to `items`, used when the group has
	 * no tokens: dim, or in its mark's color.
	 */
	right?: Array<string | ResourceMark | undefined>;
	/** A color for the item's name itself, parallel to `items` (a switched-off server is dim). */
	tones?: Array<string | undefined>;
	/** Mouse actions parallel to items, never inferred from display names. */
	actions?: Array<SplashAction | undefined>;
	/** A heading without its entry count (a single descriptive entry). */
	uncounted?: boolean;
};

export type SplashAction =
	| { kind: "model"; provider: string; id: string; thinkingLevel?: string }
	| { kind: "mcp"; name: string };
export type SplashHit = { row: number; startCol: number; endCol: number; action: SplashAction };
export type SectionLayout = { lines: string[]; hits: SplashHit[] };

/** `highlight` also paints the item itself in the mark's color. */
export type ResourceMark = { text: string; color: string; highlight?: boolean };

export type ResourceSection = {
	title: string;
	count: number;
	/** Entire section represented by its heading; notes and attention remain visible. */
	foldedCount?: number;
	/** Estimated tokens the whole section adds to every request; shown on the heading when above zero. */
	tokens?: number;
	/** The model's context window, when known; colors the heading total by its share of it. */
	contextWindow?: number;
	/**
	 * "lines" lists one entry per line; "grid" packs short names into columns; "columns" stacks
	 * contiguous groups vertically in width-bounded columns (each group may split its entries).
	 */
	layout: "lines" | "grid" | "columns";
	groups: ResourceGroup[];
	/** The source category swatch (never a connection-status indicator). */
	category?: "files" | "skills" | "tools" | "mcp";
	/** Shown after the heading in the warning color. */
	attention?: string;
	/** Shown after the heading, each part in its own color (a key to the section's marks). */
	legend?: ResourceMark[];
	/** Lines under the last group, indented, each in its own color (what went wrong, per server). */
	notes?: ResourceMark[];
};

export type StartupTheme = {
	fg(name: string, text: string): string;
	bold(text: string): string;
};

const SCOPE_ORDER: Scope[] = ["project", "user", "path"];
const INDENT = 2;
const COLUMN_GAP = 3;
/** Skill cost tiers (tokens per request): below MEDIUM is light (dim), from HEAVY up warns, from VERY_HEAVY up errors. */
export const MEDIUM_SKILL_TOKENS = 100;
export const HEAVY_SKILL_TOKENS = 180;
export const VERY_HEAVY_SKILL_TOKENS = 300;

const TIER_COLORS = ["dim", "muted", "warning", "error"] as const;

function tierOf(tokens: number): number {
	if (tokens >= VERY_HEAVY_SKILL_TOKENS) return 3;
	if (tokens >= HEAVY_SKILL_TOKENS) return 2;
	if (tokens >= MEDIUM_SKILL_TOKENS) return 1;
	return 0;
}

/** Theme color for a skill's token count by its absolute weight. */
export function skillTokenColor(tokens: number): string {
	return TIER_COLORS[tierOf(tokens)]!;
}

/** An entry at least this many times the list's median (and not light) is an outlier and moves up one tier. */
export const OUTLIER_FACTOR = 2;

/**
 * Colors for a list: absolute tiers, with outliers against the median bumped one tier. The median is taken
 * over `reference` (the whole section, so a level with few skills is judged against all of them).
 */
export function skillTokenColors(tokens: number[], reference: number[] = tokens): string[] {
	const sorted = [...reference].sort((a, b) => a - b);
	const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
	return tokens.map((count) => {
		const tier = tierOf(count);
		const outlier = tier >= 1 && median > 0 && count >= median * OUTLIER_FACTOR;
		return TIER_COLORS[Math.min(3, tier + (outlier ? 1 : 0))]!;
	});
}

/** Share of the context window (percent) at which the always-loaded cost turns warning, then error. */
export const WINDOW_WARN_PERCENT = 3;
export const WINDOW_ERROR_PERCENT = 6;

/** Heading color for a section's total by its share of the model's context window; dim when the window is unknown. */
export function windowShareColor(tokens: number, contextWindow?: number): string {
	if (!contextWindow || contextWindow <= 0) return "dim";
	const percent = (tokens / contextWindow) * 100;
	if (percent >= WINDOW_ERROR_PERCENT) return "error";
	if (percent >= WINDOW_WARN_PERCENT) return "warning";
	return "dim";
}

function compareNames(a: string, b: string): number {
	return a.localeCompare(b);
}

/** Characters / 4, the heuristic pi's compaction and /context use. */
export function estimateTokens(text: string): number {
	return Math.max(0, Math.ceil(text.length / 4));
}

/** `210` below a thousand, `1.4k` above, `12k` from ten thousand. */
export function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	const thousands = tokens / 1000;
	return thousands < 10 ? `${thousands.toFixed(1).replace(/\.0$/, "")}k` : `${Math.round(thousands)}k`;
}

/** What one skill adds to the system prompt: the `<skill>` block pi renders (name, description, location). */
export function skillPromptTokens(skill: { name: string; description?: string; filePath?: string; disableModelInvocation?: boolean }): number {
	if (skill.disableModelInvocation) return 0;
	return estimateTokens(
		`  <skill>\n    <name>${skill.name}</name>\n    <description>${skill.description ?? ""}</description>\n    <location>${skill.filePath ?? ""}</location>\n  </skill>`,
	);
}

/** Short name for one extension inside a multi-extension package: `packages/pi-x/src` becomes `pi-x`. */
export function packageItemName(shortPath: string): string {
	const name = shortPath
		.replace(/\\/g, "/")
		.replace(/^(extensions|packages)\//, "")
		.replace(/\/(index|main)\.(ts|js|mjs)$/, "")
		.replace(/\/(src|dist|lib)$/, "")
		.replace(/\.(ts|js|mjs)$/, "");
	return name || shortPath;
}

/** Drops a prefix shared by every item (typically `pi-`) so names read as what they are, not whose they are. */
function stripSharedPrefix(items: string[], prefix: string): string[] {
	if (items.length < 2 || !items.every((item) => item.startsWith(prefix) && item.length > prefix.length)) {
		return items;
	}
	return items.map((item) => item.slice(prefix.length));
}

/** Names sorted alphabetically, or by token cost (heaviest first, ties alphabetical) when any entry has one. */
function sortedItems(entries: ResourceEntry[]): Pick<ResourceGroup, "items" | "tokens"> {
	const measured = entries.some((entry) => entry.tokens !== undefined);
	const sorted = [...entries].sort(
		(a, b) => (measured ? (b.tokens ?? 0) - (a.tokens ?? 0) : 0) || compareNames(a.name, b.name),
	);
	const items = sorted.map((entry) => entry.name);
	return sorted.some((entry) => entry.tokens !== undefined)
		? { items, tokens: sorted.map((entry) => entry.tokens ?? 0) }
		: { items };
}

/**
 * Groups entries by level (project, user, path), every level labelled. Inside a level: its local entries,
 * then packages that contribute several entries (own sub-heading with a count), then every single-entry
 * package together under `packages`. `singleton` picks what a lone package entry is listed as: its package
 * name (extensions) or its own name (skills, prompts).
 */
export function groupEntries(
	entries: ResourceEntry[],
	singleton: "source" | "name",
): ResourceGroup[] {
	const groups: ResourceGroup[] = [];
	for (const scope of SCOPE_ORDER) {
		const inScope = entries.filter((entry) => entry.scope === scope);
		if (inScope.length === 0) continue;
		const packages = new Map<string, ResourceEntry[]>();
		for (const entry of inScope) {
			if (entry.source !== undefined) packages.set(entry.source, [...(packages.get(entry.source) ?? []), entry]);
		}
		const children: ResourceGroup[] = [];
		const lone: ResourceEntry[] = [];
		for (const [source, list] of [...packages].sort(([a], [b]) => compareNames(a, b))) {
			if (list.length === 1) {
				lone.push(singleton === "source" ? { ...list[0]!, name: source } : list[0]!);
				continue;
			}
			const names = stripSharedPrefix(
				list.map((entry) => entry.name),
				"pi-",
			);
			children.push({ label: source, ...sortedItems(list.map((entry, index) => ({ ...entry, name: names[index]! }))) });
		}
		if (lone.length > 0) children.push({ label: "packages", ...sortedItems(lone) });
		groups.push({
			label: scope,
			...sortedItems(inScope.filter((entry) => entry.source === undefined)),
			...(children.length > 0 ? { children } : {}),
		});
	}
	return groups;
}

/** Entries in a group and everything nested under it. */
export function groupCount(group: ResourceGroup): number {
	return group.count ?? group.items.length + (group.children ?? []).reduce((sum, child) => sum + groupCount(child), 0);
}

function allGroups(groups: ResourceGroup[]): ResourceGroup[] {
	return groups.flatMap((group) => [group, ...allGroups(group.children ?? [])]);
}

/** Column-major grid (reads down, like `ls`) that never splits an entry and never exceeds `width`. */
export function layoutGrid(items: string[], width: number, indent: number): string[] {
	if (items.length === 0) return [];
	const available = Math.max(1, width - indent);
	let best: { rows: number; lengths: number[]; widths: number[] } | undefined;
	for (let columns = 1; columns <= items.length; columns++) {
		const base = Math.floor(items.length / columns);
		const lengths = Array.from({ length: columns }, (_, index) => base + (index < items.length % columns ? 1 : 0));
		let offset = 0;
		const widths = lengths.map((length) => {
			const natural = Math.max(...items.slice(offset, offset + length).map((item) => visibleWidth(item)));
			offset += length;
			return natural;
		});
		const needed = widths.reduce((sum, size) => sum + size, 0) + COLUMN_GAP * (columns - 1);
		if (needed > available && columns !== 1) continue;
		const rows = lengths[0]!;
		if (!best || rows < best.rows || (rows === best.rows && columns < best.lengths.length)) best = { rows, lengths, widths };
	}
	const { rows, lengths, widths } = best!;
	const starts = lengths.map((length, index) => lengths.slice(0, index).reduce((sum, count) => sum + count, 0));
	const lines: string[] = [];
	for (let row = 0; row < rows; row++) {
		let line = " ".repeat(indent);
		for (let column = 0; column < lengths.length; column++) {
			const item = row < lengths[column]! ? items[starts[column]! + row] : undefined;
			if (item === undefined) continue;
			const next = lengths.slice(column + 1).some((length) => row < length);
			line += item + (next ? " ".repeat(widths[column]! - visibleWidth(item) + COLUMN_GAP) : "");
		}
		lines.push(truncateToWidth(line.trimEnd(), width));
	}
	return lines;
}

type RenderContext = {
	section: ResourceSection;
	width: number;
	theme: StartupTheme;
	/** Every token count in the section: the reference for outlier colors. */
	allTokens: number[];
	/** Lines layout: the column the token counts end at, so they line up across every group. */
	countEnd: number;
};

function lineCount(tokens: number): string {
	return `~${formatTokens(tokens)}`;
}

function markedItems(group: ResourceGroup, theme: StartupTheme): string[] {
	if (!group.marks && !group.tones) return group.items;
	return group.items.map((raw, index) => {
		const tone = group.tones?.[index];
		const item = tone ? theme.fg(tone, raw) : raw;
		const mark = group.marks?.[index];
		if (!mark) return item;
		const shown = mark.highlight ? theme.bold(theme.fg(mark.color, raw)) : item;
		return `${shown} ${theme.fg(mark.color, mark.text)}`;
	});
}

/** Kept for callers using the old constant; column splitting is now decided by width and row balance. */
export const COLUMN_MAX_ROWS = 8;

type Cell = { name: string; count: string; color: string; action?: SplashAction };
type CellHit = { row: number; startCol: number; endCol: number; action: SplashAction };
type Block = { lines: string[]; hits: CellHit[]; width: number; height: number; columns: number };
type Candidate = { columns: number; rows: number; width: number; lengths: number[]; widths: Array<{ name: number; count: number; total: number }> };

function groupHeading(group: ResourceGroup, available: number, theme: StartupTheme): string {
	const suffix = `${group.uncounted && !group.foldedCount ? "" : ` ${theme.fg("dim", String(groupCount(group)))}`}${group.foldedCount ? theme.fg("dim", ` · +${group.foldedCount} hidden`) : ""}`;
	const label = theme.fg("accent", group.label ?? "");
	return `${group.foldedCount ? truncateToWidth(label, Math.max(0, available - visibleWidth(suffix)), "…") : label}${suffix}`;
}

function candidateShapes(group: ResourceGroup, available: number, theme: StartupTheme, category?: ResourceSection["category"]): { cells: Cell[]; heading: string; shapes: Candidate[] } {
	const heading = groupHeading(group, available, theme);
	const cells: Cell[] = markedItems(group, theme).map((name, index) => {
		const right = rightText(group, index);
		return {
			name: `${category && category !== "mcp" ? `${categoryStyle(theme, category).swatch("■")} ` : ""}${prefixText(group, index, theme)}${name}`,
			count: right?.text ?? "",
			color: right?.color ?? "dim",
			...(group.actions?.[index] ? { action: group.actions[index] } : {}),
		};
	});
	const shapes: Candidate[] = [];
	for (let columns = 1; columns <= Math.max(1, Math.floor(cells.length / 2)); columns++) {
		const rows = Math.ceil(cells.length / columns);
		const base = Math.floor(cells.length / columns);
		const lengths = Array.from({ length: columns }, (_, index) => base + (index < cells.length % columns ? 1 : 0));
		let offset = 0;
		const widths = lengths.map((length) => {
			const items = cells.slice(offset, offset + length);
			offset += length;
			const count = Math.max(0, ...items.map((cell) => visibleWidth(cell.count)));
			const natural = Math.max(0, ...items.map((cell) => visibleWidth(cell.name)));
			const name = columns === 1 ? Math.min(natural, Math.max(0, available - (count ? count + 2 : 0))) : natural;
			const gap = name && count ? 2 : 0;
			return { name, count, total: name + gap + count };
		});
		const width = Math.max(visibleWidth(heading), widths.reduce((sum, item) => sum + item.total, 0) + COLUMN_GAP * (columns - 1));
		if (width <= available || columns === 1) shapes.push({ columns, rows, width: Math.min(available, width), lengths, widths });
	}
	// A wider candidate with no height benefit can never improve a band.
	return { cells, heading, shapes: shapes.filter((shape) => !shapes.some((other) => other !== shape && other.width <= shape.width && other.rows <= shape.rows && (other.width < shape.width || other.rows < shape.rows))) };
}

function columnBlock(shape: Candidate, cells: Cell[], heading: string, available: number, theme: StartupTheme): Block {
	const width = Math.min(available, shape.width);
	const lines = [truncateToWidth(heading, width)];
	const hits: CellHit[] = [];
	let offset = 0;
	const starts = shape.lengths.map((length) => { const start = offset; offset += length; return start; });
	for (let row = 0; row < shape.rows; row++) {
		let line = "";
		for (let column = 0; column < shape.columns; column++) {
			if (column) line += " ".repeat(COLUMN_GAP);
			const cell = row < shape.lengths[column]! ? cells[starts[column]! + row] : undefined;
			const size = shape.widths[column]!;
			if (!cell) { line += " ".repeat(size.total); continue; }
			const start = visibleWidth(line);
			const count = cell.count ? theme.fg(cell.color, cell.count) : "";
			const name = truncateToWidth(cell.name, size.name, "…");
			const gap = " ".repeat(Math.max(0, size.total - visibleWidth(name) - visibleWidth(cell.count)));
			line += name + gap + count;
			if (cell.action) {
				const nameEnd = Math.min(width, start + visibleWidth(name));
				const countStart = start + visibleWidth(name) + gap.length;
				const countEnd = Math.min(width, countStart + visibleWidth(count));
				if (nameEnd > start) hits.push({ row: row + 1, startCol: start, endCol: nameEnd, action: cell.action });
				if (countEnd > countStart) hits.push({ row: row + 1, startCol: countStart, endCol: countEnd, action: cell.action });
			}
		}
		lines.push(truncateToWidth(line.trimEnd(), width));
	}
	return { lines, hits, width, height: lines.length, columns: shape.columns };
}

/*
 * Fold planning measures hundreds of variants that share most of their group objects, so each group's
 * shapes are kept per width, theme and category. Shared results are never mutated.
 */
const shapeCache = new WeakMap<ResourceGroup, Map<string, { theme: StartupTheme; shapes: ReturnType<typeof candidateShapes> }>>();
function groupShapes(group: ResourceGroup, available: number, theme: StartupTheme, category?: ResourceSection["category"]): ReturnType<typeof candidateShapes> {
	const key = `${available}\0${category ?? ""}\0${themeProbe(theme)}`;
	let byKey = shapeCache.get(group);
	const cached = byKey?.get(key);
	if (cached?.theme === theme) return cached.shapes;
	const shapes = candidateShapes(group, available, theme, category);
	if (!byKey) shapeCache.set(group, byKey = new Map());
	if (byKey.size >= 4) byKey.clear();
	byKey.set(key, { theme, shapes });
	return shapes;
}

/**
 * The height layoutColumns arrives at, without laying anything out: the shortest tallest stack whose
 * stacks fit side by side. For a height bound, each stack takes the narrowest width at which the
 * shortest blocks no wider than it stay within the bound; a binary search finds the least bound that fits.
 */
function columnsHeight(groups: ResourceGroup[], available: number, theme: StartupTheme, category?: ResourceSection["category"]): number {
	const options = groups.map((group) => groupShapes(group, available, theme, category).shapes
		.map((shape) => ({ width: Math.min(available, shape.width), height: shape.rows + 1 })));
	const widths = [...new Set(options.flatMap((blocks) => blocks.map((block) => block.width)))].sort((a, b) => a - b);
	const least = options.map((blocks) => widths.map((width) =>
		blocks.reduce((best, block) => block.width <= width ? Math.min(best, block.height) : best, Infinity)));
	const fits = (bound: number): boolean => {
		// narrowest[i]: total width of groups i.. in stacks no taller than bound, counting one gap per stack.
		const narrowest = new Array<number>(groups.length + 1).fill(Infinity);
		narrowest[groups.length] = 0;
		for (let start = groups.length - 1; start >= 0; start--) {
			const sums = new Array<number>(widths.length).fill(0);
			for (let end = start; end < groups.length; end++) {
				let width = Infinity;
				for (let index = 0; index < widths.length; index++) {
					sums[index]! += least[end]![index]!;
					if (width === Infinity && sums[index]! <= bound) width = widths[index]!;
				}
				if (width === Infinity) break; // Even the widest blocks are too tall; more groups only add height.
				narrowest[start] = Math.min(narrowest[start]!, width + COLUMN_GAP + narrowest[end + 1]!);
			}
		}
		return narrowest[0]! - COLUMN_GAP <= available;
	};
	let low = Math.max(0, ...least.map((heights) => heights[heights.length - 1]!));
	let high = least.reduce((sum, heights) => sum + heights[heights.length - 1]!, 0);
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (fits(middle)) high = middle;
		else low = middle + 1;
	}
	return low;
}

/** renderSection(...).length, computed without rendering column layouts. */
export function sectionRows(section: ResourceSection, width: number, theme: StartupTheme): number {
	// layoutSection reserves one cell of inset, and layoutColumns indents its blocks.
	const inner = Math.max(0, Math.floor(width)) - 1;
	if (inner <= 0) return 0;
	if (section.layout !== "columns" || section.groups.length === 0) return renderSection(section, width, theme).length;
	return 1 + columnsHeight(section.groups, Math.max(1, inner - INDENT), theme, section.category) + (section.notes?.length ?? 0);
}

type Stack = { blocks: Block[]; width: number; height: number; splits: number; key: string };
type StackChoice = { width: number; height: number; splits: number; stacks: number; key: string; value: Stack[] };
function compareChoices(a: { height: number; splits: number; stacks: number; key: string }, b: typeof a): number {
	return a.height - b.height || a.splits - b.splits || a.stacks - b.stacks || a.key.localeCompare(b.key);
}

/** Width/height frontiers keep only the best split count at each state, never expanding shape combinations. */
function layoutColumns(groups: ResourceGroup[], indent: number, ctx: RenderContext): SectionLayout {
	const available = Math.max(1, ctx.width - indent);
	const options = groups.map((group) => {
		const { cells, heading, shapes } = groupShapes(group, available, ctx.theme, ctx.section.category);
		return shapes.map((shape) => columnBlock(shape, cells, heading, available, ctx.theme));
	});
	// The chosen layout is never taller than the least achievable height, so no taller state can be part of it.
	const tallest = columnsHeight(groups, available, ctx.theme, ctx.section.category);
	// A suffix choice records used width and its tallest stack; within that state fewer splits,
	// then fewer stacks wins. An ordered stack has the maximum width and summed heights of its groups.
	const partition: Array<Map<string, StackChoice>> = Array.from({ length: groups.length + 1 }, () => new Map());
	partition[groups.length]!.set("0:0", { width: 0, height: 0, splits: 0, stacks: 0, key: "", value: [] });
	for (let start = groups.length - 1; start >= 0; start--) {
		let frontier = new Map<string, Stack>([["0:0", { blocks: [], width: 0, height: 0, splits: 0, key: "" }]]);
		for (let end = start; end < groups.length; end++) {
			const next = new Map<string, Stack>();
			for (const stack of frontier.values()) for (const block of options[end]!) {
				const width = Math.max(stack.width, block.width);
				const choice: Stack = {
					blocks: [...stack.blocks, block], width,
					height: stack.height + block.height, splits: stack.splits + block.columns - 1,
					key: `${stack.key}${block.columns.toString().padStart(3, "0")},`,
				};
				if (choice.height > tallest) continue;
				const key = `${width}:${choice.height}`;
				const old = next.get(key);
				if (!old || choice.splits < old.splits || (choice.splits === old.splits && choice.key < old.key)) next.set(key, choice);
			}
			frontier = next;
			if (!frontier.size) break;
			for (const stack of frontier.values()) for (const tail of partition[end + 1]!.values()) {
				const width = stack.width + (tail.stacks ? COLUMN_GAP + tail.width : 0);
				if (width > available) continue;
				const choice: StackChoice = {
					width, height: Math.max(stack.height, tail.height), splits: stack.splits + tail.splits,
					stacks: 1 + tail.stacks, key: `${stack.key}|${tail.key}`, value: [stack, ...tail.value],
				};
				const key = `${choice.width}:${choice.height}`;
				const old = partition[start]!.get(key);
				if (!old || compareChoices(choice, old) < 0) partition[start]!.set(key, choice);
			}
		}
	}
	const best = [...partition[0]!.values()].sort(compareChoices)[0];
	const lines: string[] = [];
	const hits: SplashHit[] = [];
	for (let row = 0; row < (best?.height ?? 0); row++) {
		let line = " ".repeat(indent);
		for (const [index, stack] of (best?.value ?? []).entries()) {
			const offset = visibleWidth(line);
			let at = row;
			let block: Block | undefined;
			for (const candidate of stack.blocks) {
				if (at < candidate.height) { block = candidate; break; }
				at -= candidate.height;
			}
			const chunk = block?.lines[at] ?? "";
			line += chunk;
			if (index < best!.value.length - 1) line += " ".repeat(Math.max(0, stack.width - visibleWidth(chunk)) + COLUMN_GAP);
			for (const hit of block?.hits ?? []) if (hit.row === at) {
				hits.push({ row: row, startCol: offset + hit.startCol, endCol: Math.min(ctx.width, offset + hit.endCol), action: hit.action });
			}
		}
		lines.push(truncateToWidth(line.trimEnd(), ctx.width));
	}
	return { lines, hits };
}

/** The marker column of a lines group: the marker and a space, or as many blanks; empty without markers. */
function prefixText(group: ResourceGroup, index: number, theme: StartupTheme): string {
	if (!group.prefixes) return "";
	const mark = group.prefixes[index];
	return mark ? `${theme.fg(mark.color, mark.text)} ` : " ".repeat(PREFIX_WIDTH);
}

function rightText(group: ResourceGroup, index: number): ResourceMark | undefined {
	if (group.tokens) return { text: lineCount(group.tokens[index]!), color: "dim" };
	const right = group.right?.[index];
	return typeof right === "string" ? { text: right, color: "dim" } : right;
}

const PREFIX_WIDTH = 2;

function renderGroupItems(group: ResourceGroup, indent: number, ctx: RenderContext): string[] {
	const { section, width, theme } = ctx;
	if (section.layout === "lines") {
		const names = markedItems(group, theme);
		return names.map((name, index) => {
			const swatch = section.category ? `${categoryStyle(theme, section.category).swatch("■")} ` : "";
			const head = `${" ".repeat(indent)}${swatch}${prefixText(group, index, theme)}${name}`;
			const right = rightText(group, index);
			if (!right?.text) return truncateToWidth(head, width);
			const gap = " ".repeat(Math.max(2, ctx.countEnd - visibleWidth(head) - right.text.length));
			return truncateToWidth(`${head}${gap}${theme.fg(right.color, right.text)}`, width);
		});
	}
	const colors = group.tokens ? skillTokenColors(group.tokens, ctx.allTokens) : [];
	const items = group.tokens
		? group.items.map((item, index) => `${item} ${theme.fg(colors[index]!, lineCount(group.tokens![index]!))}`)
		: markedItems(group, theme);
	const swatch = section.category ? `${categoryStyle(theme, section.category).swatch("■")} ` : "";
	return layoutGrid(items.map((item) => swatch + item), width, indent);
}

function renderGroup(group: ResourceGroup, indent: number, ctx: RenderContext): string[] {
	const lines: string[] = [];
	const nested = group.label !== undefined;
	if (nested) {
		lines.push(truncateToWidth(`${" ".repeat(indent)}${groupHeading(group, Math.max(0, ctx.width - indent), ctx.theme)}`, ctx.width));
	}
	const inner = nested ? indent + INDENT : indent;
	lines.push(...renderGroupItems(group, inner, ctx));
	for (const child of group.children ?? []) lines.push(...renderGroup(child, inner, ctx));
	return lines;
}

/** Where the token counts of a lines section end: the widest name plus a two-space gap plus the widest count. */
function countColumn(groups: ResourceGroup[], indent: number): number {
	let names = 0;
	let counts = 0;
	const visit = (group: ResourceGroup, at: number) => {
		const inner = group.label !== undefined ? at + INDENT : at;
		const prefix = group.prefixes ? PREFIX_WIDTH : 0;
		group.items.forEach((item, index) => {
			const mark = group.marks?.[index];
			names = Math.max(names, inner + prefix + visibleWidth(item) + (mark ? 1 + visibleWidth(mark.text) : 0));
			const right = rightText(group, index);
			if (right?.text) counts = Math.max(counts, right.text.length);
		});
		for (const child of group.children ?? []) visit(child, inner);
	};
	for (const group of groups) visit(group, indent);
	return names + 2 + counts;
}

/*
 * Sections are immutable once built, and the splash renders the same ones on every frame for as long
 * as it stays in the transcript, so their layouts are kept per width and theme. Shared results must
 * not be mutated. The style probe catches a theme whose colors change in place.
 */
const sectionLayouts = new WeakMap<ResourceSection, Map<string, { theme: StartupTheme; layout: SectionLayout }>>();
const themeProbe = (theme: StartupTheme) => ["accent", "dim", "mdHeading", "warning", "error"].map((color) => theme.fg(color, "·")).join("") + theme.bold("·");

export function layoutSection(section: ResourceSection, width: number, theme: StartupTheme): SectionLayout {
	const available = Math.max(0, Math.floor(width));
	if (!available) return { lines: [], hits: [] };
	const key = `${available}\0${themeProbe(theme)}`;
	let layouts = sectionLayouts.get(section);
	const cached = layouts?.get(key);
	if (cached?.theme === theme) return cached.layout;
	const content = layoutSectionContent(section, available - 1, theme);
	const layout = {
		lines: content.lines.map((line) => ` ${line}`),
		hits: content.hits.map((hit) => ({ ...hit, startCol: hit.startCol + 1, endCol: hit.endCol + 1 })),
	};
	if (!layouts) sectionLayouts.set(section, layouts = new Map());
	if (layouts.size >= 4) layouts.clear();
	layouts.set(key, { theme, layout });
	return layout;
}

/** Reserve Pi's one-cell left inset before measuring columns and clickable regions. */
function layoutSectionContent(section: ResourceSection, width: number, theme: StartupTheme): SectionLayout {
	if (width <= 0) return { lines: [], hits: [] };
	const cost = section.tokens !== undefined
		? ` ${theme.fg(windowShareColor(section.tokens, section.contextWindow), `· ~${formatTokens(section.tokens)} tok`)}`
		: "";
	const attention = section.attention ? ` ${theme.fg("warning", `· ${section.attention}`)}` : "";
	const legend = (section.legend ?? []).map((part) => ` ${theme.fg("dim", "·")} ${theme.fg(part.color, part.text)}`).join("");
	const swatch = section.category ? `${categoryStyle(theme, section.category).swatch("■")} ` : "";
	const heading = `${swatch}${theme.bold(theme.fg("mdHeading", section.title))} ${theme.fg("dim", String(section.count))}${cost}${attention}${legend}${section.foldedCount ? theme.fg("dim", ` · +${section.foldedCount} hidden`) : ""}`;
	const ctx: RenderContext = {
		section,
		width,
		theme,
		allTokens: allGroups(section.groups).flatMap((group) => group.tokens ?? []),
		countEnd: countColumn(section.groups, INDENT),
	};
	const lines = [truncateToWidth(heading, width)];
	const hits: SplashHit[] = [];
	if (section.layout === "columns" && section.groups.length > 0) {
		const columns = layoutColumns(section.groups, INDENT, ctx);
		hits.push(...columns.hits.map((hit) => ({ ...hit, row: hit.row + 1 })));
		lines.push(...columns.lines);
	} else for (const group of section.groups) lines.push(...renderGroup(group, INDENT, ctx));
	for (const note of section.notes ?? []) {
		lines.push(truncateToWidth(`${" ".repeat(INDENT)}${theme.fg(note.color, note.text)}`, width));
	}
	return { lines, hits: hits.filter((hit) => hit.endCol > hit.startCol && !!sliceByColumn(lines[hit.row] ?? "", hit.startCol, hit.endCol - hit.startCol)) };
}

export function renderSection(section: ResourceSection, width: number, theme: StartupTheme): string[] {
	return layoutSection(section, width, theme).lines;
}

export type SplashCandidate = { section: ResourceSection; rows: number; hidden: number; losses: [number, number, number]; folds: number; order: string };
type FoldVariant = { groups: ResourceGroup[]; hidden: number; losses: [number, number, number]; folds: number; order: string };
const CANDIDATE_LIMIT = 256;

/** Protect the current model's provider and problem MCP scopes before minimizing hidden entries. */
function foldLosses(name: string, group: ResourceGroup): [number, number, number] {
	const own: [number, number, number] = [0, 0, 0];
	group.items.forEach((_, index) => {
		if (name === "Models") {
			if (group.marks?.[index]?.highlight) own[0]++;
			if (group.prefixes?.[index]?.text === GLYPHS.favorite.text) own[2]++;
		}
		if (name === "MCP" && (group.prefixes?.[index]?.color === "warning" || group.prefixes?.[index]?.color === "error")) own[1]++;
	});
	for (const child of group.children ?? []) {
		const nested = foldLosses(name, child);
		for (let index = 0; index < 3; index++) own[index]! += nested[index]!;
	}
	return own;
}

function compareFoldScore(a: { hidden: number; losses: [number, number, number]; folds: number; order: string }, b: typeof a): number {
	return (a.losses[0] + a.losses[1]) - (b.losses[0] + b.losses[1])
		|| a.hidden - b.hidden || a.losses[2] - b.losses[2] || a.folds - b.folds || a.order.localeCompare(b.order);
}

/** Exact for ordinary inventories; keep a deterministic beam when subgroup combinations exceed 256. */
export function splashSectionCandidates(name: string, original: ResourceSection, width: number, theme: StartupTheme): SplashCandidate[] {
	const measured = new WeakMap<ResourceGroup[], number>();
	const rowsFor = (groups: ResourceGroup[]) => {
		let rows = measured.get(groups);
		if (rows === undefined) measured.set(groups, rows = sectionRows({ ...original, groups }, width, theme));
		return rows;
	};
	const bounded = (variants: FoldVariant[]): FoldVariant[] => {
		if (variants.length <= CANDIDATE_LIMIT) return variants;
		return variants.sort((a, b) => (a.losses[0] + a.losses[1]) - (b.losses[0] + b.losses[1])
			|| a.hidden - b.hidden || rowsFor(a.groups) - rowsFor(b.groups)
			|| a.folds - b.folds || a.order.localeCompare(b.order)).slice(0, CANDIDATE_LIMIT);
	};
	const add = (base: FoldVariant, variant: FoldVariant): FoldVariant => ({
		groups: [...base.groups, ...variant.groups], hidden: base.hidden + variant.hidden,
		losses: base.losses.map((value, index) => value + variant.losses[index]!) as [number, number, number],
		folds: base.folds + variant.folds, order: base.order + variant.order,
	});
	const empty = (): FoldVariant => ({ groups: [], hidden: 0, losses: [0, 0, 0], folds: 0, order: "" });
	const combine = (groups: ResourceGroup[]): FoldVariant[] => {
		let variants = [empty()];
		for (const group of groups) {
			const children = group.children ? combine(group.children) : [empty()];
			const keep = children.map((child): FoldVariant => ({
				...child, groups: [child.hidden ? { ...group, children: child.groups } : group], order: `0${child.order}`,
			}));
			const count = groupCount(group);
			const fold: FoldVariant[] = group.label === undefined || count === 0 ? [] : [{
				groups: [{ label: group.label, items: [], count, foldedCount: count }],
				hidden: count, losses: foldLosses(name, group), folds: 1, order: "1",
			}];
			variants = bounded(variants.flatMap((variant) => [...keep, ...fold].map((choice) => add(variant, choice))));
		}
		return variants;
	};
	const groupVariants = combine(original.groups);
	const result = groupVariants.map((variant): SplashCandidate => {
		const section = variant.hidden ? { ...original, groups: variant.groups } : original;
		return { section, rows: variant.hidden ? rowsFor(variant.groups) : sectionRows(section, width, theme), hidden: variant.hidden,
			losses: variant.losses, folds: variant.folds, order: variant.order };
	});
	if (original.count > 0) {
		const losses = original.groups.reduce<[number, number, number]>((sum, group) => {
			const part = foldLosses(name, group);
			return sum.map((value, index) => value + part[index]!) as [number, number, number];
		}, [0, 0, 0]);
		const section = { ...original, groups: [], foldedCount: original.count };
		result.push({ section, rows: sectionRows(section, width, theme), hidden: original.count,
			losses, folds: 1, order: "2" });
	}
	if (result.length <= CANDIDATE_LIMIT) return result;
	// Reserve a safe shortest alternative even if the beam favored every protected source.
	const whole = result.pop()!;
	return [...result.sort((a, b) => (a.losses[0] + a.losses[1]) - (b.losses[0] + b.losses[1])
		|| a.hidden - b.hidden || a.rows - b.rows || a.folds - b.folds || a.order.localeCompare(b.order)).slice(0, CANDIDATE_LIMIT - 1), whole];
}

/** Width-measured row DP: each row count retains its best protected/hidden/favorite/fold outcome. */
export function planSplashSections(
	sections: Record<string, ResourceSection>, width: number, theme: StartupTheme, availableRows: number,
): Record<string, ResourceSection> {
	const names = ["Extensions", "Context", "Skills", "Prompts", "MCP", "Models"].filter((name) => sections[name]);
	if (names.reduce((sum, name) => sum + sectionRows(sections[name]!, width, theme), 0) <= availableRows) {
		return Object.fromEntries(names.map((name) => [name, sections[name]!]));
	}
	const options = names.map((name) => splashSectionCandidates(name, sections[name]!, width, theme));
	type Choice = { hidden: number; losses: [number, number, number]; folds: number; order: string; picked: SplashCandidate[] };
	let frontier = new Map<number, Choice>([[0, { hidden: 0, losses: [0, 0, 0], folds: 0, order: "", picked: [] }]]);
	for (const sectionOptions of options) {
		const next = new Map<number, Choice>();
		for (const [rows, state] of frontier) for (const option of sectionOptions) {
			const total = rows + option.rows;
			const candidate: Choice = {
				hidden: state.hidden + option.hidden,
				losses: state.losses.map((value, index) => value + option.losses[index]!) as [number, number, number],
				folds: state.folds + option.folds, order: `${state.order}/${option.order}`,
				picked: [...state.picked, option],
			};
			const existing = next.get(total);
			if (!existing || compareFoldScore(candidate, existing) < 0) next.set(total, candidate);
		}
		frontier = next;
	}
	const fitting = [...frontier].filter(([rows]) => rows <= availableRows);
	// When even every heading is too tall, the shortest safe custom listing scrolls in Pi.
	const chosen = fitting.length
		? fitting.sort((a, b) => compareFoldScore(a[1], b[1]) || a[0] - b[0])[0]![1]
		: [...frontier].sort((a, b) => a[0] - b[0] || compareFoldScore(a[1], b[1]))[0]?.[1];
	return Object.fromEntries(names.map((name, index) => [name, chosen?.picked[index]?.section ?? sections[name]!]));
}

// ---- Collecting entries from pi's InteractiveMode ----

type SourceInfoLike = { source?: string; scope?: string } | undefined;

function entryOrigin(mode: any, sourceInfo: SourceInfoLike): Pick<ResourceEntry, "source" | "scope"> {
	const scope = mode.getScopeGroup(sourceInfo) as Scope;
	return mode.isPackageSource(sourceInfo)
		? { source: mode.getCompactPackageSourceLabel(sourceInfo) || sourceInfo?.source, scope }
		: { scope };
}

function isWithin(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The level of a context file: user for the agent directory (global AGENTS.md, SYSTEM.md, APPEND_SYSTEM.md),
 * project for a file in the working directory, under it (`.pi/SYSTEM.md`) or in one of its ancestors (the
 * AGENTS.md files pi picks up walking up from it), path for anything else (a file given on the command line).
 */
export function contextScope(file: string, agentDir: string, cwd?: string): Scope {
	const absolute = path.resolve(cwd ?? "/", file);
	if (isWithin(absolute, path.resolve(agentDir))) return "user";
	if (cwd && (isWithin(absolute, path.resolve(cwd)) || isWithin(path.resolve(cwd), path.dirname(absolute)))) {
		return "project";
	}
	return "path";
}

function localExtensionName(label: string): string {
	return label.replace(/\.(ts|js|mjs)$/, "");
}

/** Builds the compact sections from the same data pi's own listing uses; sections with nothing in them are omitted. */
export function collectSections(mode: any, options?: { extensions?: any[] }, snapshot?: StartupContextSnapshot): Record<string, ResourceSection> {
	const loader = mode.session.resourceLoader;
	const sections: Record<string, ResourceSection> = {};
	const contextWindow = snapshot?.contextWindow;
	const attributed = (category: "files" | "skills") => new Map(
		snapshot?.sources.filter((source) => source.category === category).flatMap((source) => source.children ?? []).map((source) => [source.id, source.tokens] as const) ?? [],
	);
	const files = attributed("files");
	const skillsCost = attributed("skills");
	const seenFiles = new Set<string>();
	const seenSkills = new Set<string>();
	const once = (id: string, costs: Map<string, number>, seen: Set<string>) => {
		if (seen.has(id)) return 0;
		seen.add(id);
		return costs.get(id) ?? 0;
	};
	const unavailable = [{ text: "prompt attribution unavailable", color: "dim" }];

	const appendSources = loader.getAppendSystemPromptSources() as any[];
	const cwd = mode.sessionManager?.getCwd?.() as string | undefined;
	const agentDir = (loader.agentDir as string | undefined) ?? getAgentDir();
	const contextFiles: Array<{ path: string; tokens?: number }> = [
		...(loader.getSystemPromptSource() ? [{ path: loader.getSystemPromptSource().path }] : []),
		...appendSources.map((file) => ({ path: file.path })),
		...(loader.getAgentsFiles().agentsFiles as any[]).map((file) => ({ path: file.path })),
	].map((file) => ({ ...file, ...(snapshot?.attribution.files ? { tokens: once(`file:${file.path}`, files, seenFiles) } : {}) }));
	if (contextFiles.length > 0) {
		const total = contextFiles.reduce((sum, file) => sum + (file.tokens ?? 0), 0);
		const groups: ResourceGroup[] = [];
		for (const scope of SCOPE_ORDER) {
			// Largest first; equal sizes keep pi's order (stable sort).
			const inScope = contextFiles
				.filter((file) => contextScope(file.path, agentDir, cwd) === scope)
				.sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0));
			if (inScope.length === 0) continue;
			groups.push({
				label: scope,
				items: inScope.map((file) => mode.formatContextPath(file.path)),
				...(snapshot?.attribution.files ? { tokens: inScope.map((file) => file.tokens ?? 0) } : {}),
			});
		}
		sections.Context = {
			title: "Context",
			count: contextFiles.length,
			...(snapshot?.attribution.files ? { tokens: total } : { notes: unavailable }),
			contextWindow,
			layout: "columns",
			groups,
			category: "files",
		};
	}

	const skills = loader.getSkills().skills as any[];
	if (skills.length > 0) {
		const entries = skills.map((skill) => ({
			name: skill.name,
			...(snapshot?.attribution.skills ? { tokens: once(`skill:${skill.filePath}`, skillsCost, seenSkills) } : {}),
			...entryOrigin(mode, skill.sourceInfo),
		}));
		sections.Skills = {
			title: "Skills",
			count: skills.length,
			...(snapshot?.attribution.skills ? { tokens: entries.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0) } : { notes: unavailable }),
			contextWindow,
			layout: "grid",
			category: "skills",
			groups: groupEntries(entries, "name"),
		};
	}

	const prompts = (mode.session.promptTemplates ?? []) as any[];
	if (prompts.length > 0) {
		sections.Prompts = {
			title: "Prompts",
			count: prompts.length,
			layout: "grid",
			groups: groupEntries(
				prompts.map((prompt) => ({ name: `/${prompt.name}`, ...entryOrigin(mode, prompt.sourceInfo) })),
				"name",
			),
		};
	}

	const extensions: any[] =
		options?.extensions ??
		loader
			.getExtensions()
			.extensions.filter((extension: any) => !extension.hidden)
			.map((extension: any) => ({ path: extension.path, sourceInfo: extension.sourceInfo }));
	if (extensions.length > 0) {
		const labels = mode.getCompactExtensionLabels(extensions) as string[];
		sections.Extensions = {
			title: "Extensions",
			count: extensions.length,
			layout: "grid",
			category: "tools",
			groups: groupEntries(
				extensions.map((extension, index) => {
					const origin = entryOrigin(mode, extension.sourceInfo);
					const name =
						origin.source === undefined
							? localExtensionName(labels[index] ?? extension.path)
							: packageItemName(mode.getShortPath(extension.path, extension.sourceInfo));
					return { name, ...origin };
				}),
				"source",
			),
		};
	}
	return sections;
}

// ---- MCP servers (pi's own listing has no such section) ----

const MCP_LEVELS: McpLevel[] = ["project", "user", "extension"];

const MCP_GLYPHS: Record<McpStatus, ResourceMark> = {
	connected: { text: "■", color: "success" },
	"needs-auth": { text: "□", color: "warning" },
	failed: { text: "□", color: "error" },
	connecting: { text: "□", color: "dim" },
	disabled: { text: "□", color: "dim" },
	disconnected: { text: "□", color: "dim" },
	unknown: { text: "□", color: "dim" },
};

/** Reuse the chart's prepared direct-schema estimate; an unassigned source is never charged to a server. */
function mcpSchemaMetrics(snapshot?: StartupContextSnapshot): {
	complete: boolean; total: number; byServer: Map<string, number>; unattributed: boolean;
} {
	const byServer = new Map<string, number>();
	let total = 0;
	let unattributed = false;
	if (!snapshot?.toolDeclarationsKnown) return { complete: false, total, byServer, unattributed };
	for (const source of snapshot.sources) {
		if (source.category !== "mcp") continue;
		total += source.tokens;
		if (!source.id.startsWith("mcp:") || source.id === "mcp:unknown" && source.label === "MCP") {
			unattributed = true;
			continue;
		}
		const server = normalizeMcpName(source.id.slice(4));
		if (!server) { unattributed = true; continue; }
		byServer.set(server, (byServer.get(server) ?? 0) + source.tokens);
	}
	return { complete: snapshot?.mcpOriginsKnown === true, total, byServer, unattributed };
}

/** The servers configured for this session, each with the level it is active at. */
export function collectMcpEntries(mode: any, cache?: McpConfigCache): McpEntry[] {
	try {
		const cwd = mode?.sessionManager?.getCwd?.() as string | undefined;
		const registered = (mode?.session?.extensionRunner?.runtime?.mcpServers?.list?.() ?? []) as Array<{ name: string; config?: { enabled?: boolean } }>;
		return loadMcpEntries({
			userFile: path.join(getAgentDir(), "mcp.json"),
			projectFile: cwd && mode?.settingsManager?.isProjectTrusted?.() ? path.join(cwd, ".pi", "mcp.json") : undefined,
			registered,
			cache,
		});
	} catch {
		return [];
	}
}

/** One connection square per row; connected servers show live tool counts and estimated direct-schema tokens. */
export function buildMcpSection(
	entries: McpEntry[],
	status: (name: string) => McpStatus | undefined,
	_detail: (name: string) => string | undefined = () => undefined,
	tools: (name: string) => number | undefined = () => undefined,
	snapshot?: StartupContextSnapshot,
): ResourceSection | undefined {
	if (entries.length === 0) return undefined;
	const schema = mcpSchemaMetrics(snapshot);
	const sorted = [...entries].sort((a, b) => compareNames(a.name, b.name));
	const groups: ResourceGroup[] = [];
	let needAuth = 0;
	let failed = 0;
	for (const level of MCP_LEVELS) {
		const inLevel = sorted.filter((entry) => entry.level === level);
		if (inLevel.length === 0) continue;
		const states = inLevel.map((entry) => entry.enabled === false ? "disabled" : status(entry.name) ?? "unknown");
		const right = inLevel.map((entry, index): string | undefined => {
			const state = states[index]!;
			if (state === "needs-auth") needAuth++;
			if (state === "failed") failed++;
			if (state !== "connected") return undefined;
			const count = tools(entry.name);
			const attributed = schema.byServer.get(normalizeMcpName(entry.name));
			const tokens = attributed !== undefined ? `~${formatTokens(attributed)}`
				: schema.complete && !schema.unattributed ? "~0" : "?";
			return `${count === undefined ? "?" : count} · ${tokens} tok`;
		});
		groups.push({
			label: level,
			items: inLevel.map((entry) => entry.name),
			actions: inLevel.map((entry) => ({ kind: "mcp", name: entry.name })),
			prefixes: states.map((state) => MCP_GLYPHS[state]),
			tones: states.map((state) => state === "disabled" ? "dim" : undefined),
			right,
		});
	}
	const legend: ResourceMark[] = [];
	if (needAuth) legend.push({ text: `□ ${needAuth}`, color: "warning" });
	if (failed) legend.push({ text: `□ ${failed}`, color: "error" });
	return {
		title: "MCP",
		count: entries.length,
		layout: "columns",
		groups,
		category: "mcp",
		...(schema.complete ? { tokens: schema.total, contextWindow: snapshot?.contextWindow } : {}),
		...(legend.length > 0 ? { legend } : {}),
	};
}

/** The configured MCP servers as a section, with their live state; undefined when none are configured. */
export function collectMcpSection(
	mode: any,
	entries: McpEntry[] = collectMcpEntries(mode),
	statuses: ReadonlyMap<string, McpObservation> = new Map(),
	snapshot: StartupContextSnapshot = readStartupContext(mode),
): ResourceSection | undefined {
	const effective = entries.map((entry) => {
		const observed = statuses.get(normalizeMcpName(entry.name));
		// The running session wins over disk (external edits still need /reload).
		return observed ? { ...entry, enabled: observed.status !== "disabled" } : entry;
	});
	for (const name of statuses.keys()) {
		if (!effective.some((entry) => normalizeMcpName(entry.name) === name)) effective.push({ name, level: "extension" });
	}
	let counts = new Map<string, number>();
	try { counts = toolCounts(mode?.session?.getAllTools?.() ?? []); } catch { /* Runner replacing. */ }
	const observation = (name: string) => statuses.get(normalizeMcpName(name));
	return buildMcpSection(
		effective,
		(name) => observation(name)?.status ?? mcpState.status(name),
		(name) => observation(name) ? observation(name)?.detail : mcpState.detail(name),
		(name) => observation(name)?.tools ?? counts.get(normalizeMcpName(name)),
		snapshot,
	);
}

// ---- Models (pi only prints the scope as one line before the TUI starts) ----

export type ModelEntry = { provider: string; id: string; contextWindow?: number; thinkingLevel?: string; virtual?: boolean };

/** The subscription vendor a provider bills: Muse SDK/Code and OpenAI/Codex share one rung. */
const vendorOf = (provider: string) => provider.replace(/-(sdk|code|codex)$/, "");
/**
 * The splash group a provider's models list under. openai-codex is only the route that reports the
 * ChatGPT subscription's quota, not another account or model family, so it lists under openai.
 */
const splashGroupOf = (provider: string) => (provider === "openai-codex" ? "openai" : provider);
const hours = (ms: number) => ms >= 86_400_000 ? `${Math.round(ms / 86_400_000)}d` : ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.max(1, Math.round(ms / 60_000))}m`;
/**
 * A rung's heading suffix: why the waterfall would skip it now, or, when it would not, its most-used quota
 * window (`week 62%`).
 */
function rungNote(rung: WaterfallRung, now: number): string | undefined {
	if (rung.state === "available") {
		const tightest = rung.tightest;
		return tightest && Number.isFinite(tightest.used) ? `${tightest.label} ${Math.round(tightest.used)}%` : undefined;
	}
	if (rung.state === "exhausted") {
		const reset = rung.resetAt !== undefined && Number.isFinite(rung.resetAt) && rung.resetAt > now ? `resets ${hours(rung.resetAt - now)}` : undefined;
		if (rung.provider === "google" && rung.blockingQuota?.label) return [rung.blockingQuota.label, reset].filter(Boolean).join(" · ");
		return reset ?? "quota";
	}
	return rung.state === "disabled" ? "off" : "unverified";
}

const CURRENT_MARK: ResourceMark = { ...GLYPHS.live, highlight: true };
const FAVORITE_MARK: ResourceMark = GLYPHS.favorite;

/**
 * A context window in the units vendors quote: binary for powers-of-two sizes (131072 is `128K`, 1048576 is
 * `1M`), decimal otherwise (272000 is `272K`, 1050000 is `1.05M`).
 */
export function formatContextWindow(tokens: number | undefined): string {
	if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return "";
	const binary = tokens % 1024 === 0;
	const k = binary ? 1024 : 1000;
	const m = k * k;
	const trim = (value: number) => String(Number(value.toFixed(2)));
	if (tokens >= m) return `${trim(tokens / m)}M`;
	if (tokens >= k) return `${trim(tokens / k)}K`;
	return String(tokens);
}

type ParsedModelId = {
	/** The id with its version numbers taken out: models in one family differ only by version. */
	family: string;
	/** The model line: the id's leading word (gpt, claude, antigravity), when it has one. */
	vendor?: string;
	/** Major and minor version, when the id carries one. */
	version?: [number, number];
	/**
	 * A moving alias (`-latest`), a dated snapshot or a billing lane (Muse's `-contributor`) of another entry, or
	 * an image generator listed with the chat models: never a chat model of its own.
	 */
	alias: boolean;
};

/** Reads family, line and version from an id such as `claude-opus-4-5-20251101`, `gpt-6.1-sol` or `o4-mini`. */
export function parseModelId(id: string): ParsedModelId {
	let rest = id.toLowerCase();
	// A dated snapshot (-20251101, -2024-05-13) or a moving alias (-latest) stands in for another entry.
	const alias =
		/[-_](\d{8}|\d{4}-\d{2}-\d{2})$/.test(rest) || /(^|[-_])(latest|contributor)$/.test(rest) || /(^|[-_])image([-_]|$)/.test(rest);
	rest = rest.replace(/[-_](\d{8}|\d{4}-\d{2}-\d{2})$/, "");
	const tokens = rest.split(/[-_/]/).filter(Boolean);
	const family: string[] = [];
	let version: [number, number] | undefined;
	let minorPending = false;
	for (const token of tokens) {
		if (token === "latest") continue;
		if (minorPending) {
			minorPending = false;
			// claude-opus-4-5: a bare small number right after a bare major is its minor version.
			if (/^\d{1,2}$/.test(token)) {
				version![1] = Number(token);
				continue;
			}
		}
		const match = version ? null : /^([a-z]*)(\d+)(?:\.(\d+))?([a-z]*)$/.exec(token);
		// A size (120b, 27b) is part of the name, not a version.
		if (!match || /^[bmk]$/.test(match[4]!)) {
			family.push(token);
			continue;
		}
		version = [Number(match[2]), match[3] === undefined ? 0 : Number(match[3])];
		minorPending = match[3] === undefined && !match[1] && !match[4];
		if (match[1]) family.push(match[1]);
		if (match[4]) family.push(match[4]);
	}
	const first = tokens[0] ?? "";
	return {
		family: family.join("-"),
		...(/^[a-z]{2,}$/.test(first) ? { vendor: first } : {}),
		...(version ? { version } : {}),
		alias,
	};
}

function compareVersions(a: [number, number], b: [number, number]): number {
	return a[0] - b[0] || a[1] - b[1];
}

/**
 * The current generation of one provider's models: the newest version of every family, leaving out aliases,
 * dated snapshots, billing lanes, image generators and families a generation behind. A line's generation is the newest major version among its
 * families that have more than one version (else among all of them), so a family new in a later major (Gemini
 * Argon 4 beside Flash 3.8) stays and a family last released a major ago (GPT-5.5 Pro beside GPT-6) goes.
 * Ids without a leading word (o3, o4-mini) count toward the provider's main line.
 */
export function currentGeneration(ids: string[]): Set<string> {
	const parsed = ids.map((id) => ({ id, ...parseModelId(id) })).filter((model) => !model.alias);
	const vendors = new Map<string, number>();
	for (const model of parsed) if (model.vendor) vendors.set(model.vendor, (vendors.get(model.vendor) ?? 0) + 1);
	const main = [...vendors].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
	const lines = new Map<string, Map<string, typeof parsed>>();
	for (const model of parsed) {
		const line = model.vendor ?? main;
		const families = lines.get(line) ?? new Map<string, typeof parsed>();
		families.set(model.family, [...(families.get(model.family) ?? []), model]);
		lines.set(line, families);
	}
	const keep = new Set<string>();
	for (const families of lines.values()) {
		const versioned = [...families.values()].map((list) => list.filter((model) => model.version));
		const majors = (lists: typeof versioned) => lists.flatMap((list) => list.map((model) => model.version![0]));
		const multi = versioned.filter((list) => new Set(list.map((model) => model.version!.join("."))).size > 1);
		const generation = Math.max(-Infinity, ...majors(multi.length > 0 ? multi : versioned));
		for (const list of families.values()) {
			const newest = list.reduce((best, model) =>
				!best.version || (model.version && compareVersions(model.version, best.version) > 0) ? model : best,
			);
			if (!newest.version || newest.version[0] >= generation) keep.add(newest.id);
		}
	}
	return keep;
}

/**
 * The models section, one line per model under a heading per provider, with providers in ordered
 * vertical column stacks (the columns layout Context uses): every current-generation model of each
 * provider with credentials (only the waterfall's providers when it is loaded, so a catalog
 * provider such as OpenRouter lists only favorites), plus the favorites (enabledModels or --models, with any thinking level) and the
 * session's model wherever they are. Favorites carry a star and come first in their provider, in the order they
 * are configured; the session's model is highlighted in green. Every model shows its context window on the right.
 */
export function buildModelsSection(
	available: ModelEntry[],
	favorites: ModelEntry[] = [],
	current?: { provider: string; id: string },
	waterfall?: { rungs?: WaterfallRung[]; order?: WaterfallSnapshot["order"]; now?: number },
	system1?: System1Status["candidates"],
): ResourceSection | undefined {
	const key = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
	// Virtual models (plan-mode pairs and other routers) are not provider models: `/model` lists them, the splash does not.
	available = available.filter((model) => !model.virtual);
	// Only subscription-backed Antigravity Gemini/Gemma routes belong in this Google splash group.
	// Native google/gemini-* entries may use an API key, so never substitute them for a missing route.
	const shown = (model: ModelEntry) => model.provider !== "google" || /^antigravity-(gemini|gemma)-/.test(model.id);
	available = available.filter(shown);
	const byKey = new Map(available.map((model) => [key(model), model]));
	favorites = favorites.filter((model) => shown(model) && byKey.has(key(model)));
	const favoriteKeys = new Set(favorites.map(key));
	const providers = new Map<string, ModelEntry[]>();
	// One row per id in a group: a favorite's route wins, then the session's, then openai over openai-codex.
	const isCurrent = (model: ModelEntry) => current !== undefined && key(model) === key(current);
	const priority = (model: ModelEntry) =>
		favoriteKeys.has(key(model)) ? 0 : isCurrent(model) ? 1 : model.provider === "openai-codex" ? 3 : 2;
	const add = (model: ModelEntry) => {
		const group = splashGroupOf(model.provider);
		const list = providers.get(group) ?? [];
		const index = list.findIndex((entry) => entry.id === model.id);
		if (index < 0) list.push(model);
		else if (priority(model) < priority(list[index]!)) list[index] = model;
		providers.set(group, list);
	};
	for (const favorite of favorites) add({ ...byKey.get(key(favorite)), ...favorite });
	const availableProviders = new Map<string, ModelEntry[]>();
	for (const model of available) {
		const group = splashGroupOf(model.provider);
		availableProviders.set(group, [...(availableProviders.get(group) ?? []), model]);
	}
	// Assessed rungs carry state; until the first assessment, the waterfall's fixed order still
	// decides which providers belong and where they go.
	const rungs = waterfall?.rungs ?? [];
	const ladder: Array<{ provider: string }> = rungs.length ? rungs : waterfall?.order ?? [];
	const rungOf = (provider: string) => ladder.findIndex((rung) => vendorOf(rung.provider) === vendorOf(provider));
	for (const [provider, list] of availableProviders) {
		if (ladder.length && rungOf(provider) < 0) continue;
		const current = currentGeneration(list.map((model) => model.id));
		const rest = list.filter((model) => current.has(model.id) && !favoriteKeys.has(key(model)));
		for (const model of rest.sort((a, b) => compareNames(a.id, b.id) || priority(a) - priority(b))) add(model);
	}
	if (current && byKey.has(key(current))) add(byKey.get(key(current))!);
	const count = [...providers.values()].reduce((sum, list) => sum + list.length, 0);
	if (count === 0) return undefined;
	// Providers follow the subscription waterfall's order when it is known, numbered, with
	// rungs it would skip now dimmed and labeled why; the rest follow alphabetically.
	const now = waterfall?.now ?? Date.now();
	const rank = (provider: string) => { const index = rungOf(provider); return index < 0 ? ladder.length : index; };
	const ordered = [...providers].sort(([a], [b]) => rank(a) - rank(b) || compareNames(a, b));
	const groups: ResourceGroup[] = ordered.map(([provider, list]) => {
		const marks = list.map((model) => (isCurrent(model) ? CURRENT_MARK : undefined));
		const prefixes = list.map((model) => (favoriteKeys.has(key(model)) ? FAVORITE_MARK : undefined));
		const index = rungOf(provider);
		const rung = index < 0 ? undefined : rungs[index];
		const note = rung ? rungNote(rung, now) : undefined;
		const skipped = rung !== undefined && rung.state !== "available";
		return {
			label: index < 0 ? provider : `${index + 1} ${provider}${note ? ` · ${note}` : ""}`,
			// A provider's model count says nothing worth the space; the section heading keeps the total.
			uncounted: true,
			...(skipped ? { tones: list.map(() => "dim") } : {}),
			items: list.map((model) => {
				const label = provider === "google" ? model.id.replace(/^antigravity-/, "") : model.id;
				return model.thinkingLevel ? `${label}:${model.thinkingLevel}` : label;
			}),
			actions: list.map((model) => ({ kind: "model", provider: model.provider, id: model.id, ...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {}) })),
			right: list.map((model) => formatContextWindow(model.contextWindow)),
			...(marks.some(Boolean) ? { marks } : {}),
			...(prefixes.some(Boolean) ? { prefixes } : {}),
		};
	});
	// System 1's judgment models, in its waterfall order; they are not chat models, so they are not counted.
	if (system1?.length) {
		groups.push({
			label: "System 1",
			uncounted: true,
			items: system1.map((candidate) => `${candidate.provider}/${candidate.model}`),
			right: system1.map((candidate) => candidate.backend),
			...(system1.some((candidate) => candidate.local === "missing")
				? { tones: system1.map((candidate) => (candidate.local === "missing" ? "dim" : undefined)) } : {}),
		});
	}
	return {
		title: "Models",
		count,
		layout: "columns",
		groups,
	};
}

/** The session's models as a section; undefined when there are none or pi's model API is missing. */
export function collectModelsSection(mode: any, verifiedGoogle: ModelEntry[] = [], waterfall?: Pick<WaterfallSnapshot, "rungs" | "order">, system1?: System1Status["candidates"]): ResourceSection | undefined {
	try {
		const session = mode?.session;
		const scopedModels = (session?.scopedModels ?? []) as Array<{ model: any; thinkingLevel?: string }>;
		const favorites: ModelEntry[] = scopedModels.map((entry) => ({
			provider: entry.model.provider,
			id: entry.model.id,
			...(entry.model.contextWindow ? { contextWindow: entry.model.contextWindow } : {}),
			...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
		}));
		const available: ModelEntry[] = ([...(session?.modelRuntime?.getAvailableSnapshot?.() ?? []), ...verifiedGoogle] as any[]).map(
			(model) => ({ provider: model.provider, id: model.id, contextWindow: model.contextWindow, ...(model.api === "pi-virtual" ? { virtual: true } : {}) }),
		);
		const current = session?.model ? { provider: session.model.provider, id: session.model.id } : undefined;
		return buildModelsSection(available, favorites, current, waterfall ? { rungs: waterfall.rungs, order: waterfall.order } : undefined, system1);
	} catch {
		return undefined;
	}
}

// ---- Wiring ----

type StartupResourcesPatch = {
	active: boolean;
	stop?: () => void;
	original: (...args: any[]) => unknown;
	installed: (...args: any[]) => unknown;
};

let hostTheme: (() => StartupTheme | undefined) | undefined;

/** Lets the rendering follow the host theme (set from the startup header factory and session_start). */
export function setStartupResourcesTheme(source: () => StartupTheme | undefined): void {
	hostTheme = source;
}

const PLAIN_THEME: StartupTheme = { fg: (_name, text) => text, bold: (text) => text };

function sectionTitle(child: any): string | undefined {
	if (!child || typeof child.setExpanded !== "function" || typeof child.render !== "function") return undefined;
	try {
		const first = String(child.render(80)[0] ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
		return /^\[(Context|Skills|Prompts|Extensions)\]/.exec(first)?.[1];
	} catch {
		return undefined;
	}
}

let stopMcpWatch: (() => void) | undefined;
const mountedModes = new Set<object>();

function refreshStartupHosts(): void {
	for (const mode of mountedModes) attachStartupHost(mode).refresh?.();
}

export function stopStartupResources(): void {
	stopMcpWatch?.();
	stopMcpWatch = undefined;
	mcpState.mounted = false;
}

function disposeStartupResources(): void {
	stopStartupResources();
	for (const mode of mountedModes) disposeStartupHost(mode);
	mountedModes.clear();
}

/** Poll for as long as the splash exists, not just startup. Rendering itself performs no file I/O. */
export function watchMcpState(mode: any, component: unknown, update: (entries: McpEntry[], statuses: ReadonlyMap<string, McpObservation>) => void): () => void {
	stopStartupResources();
	mcpState.mount();
	const cache = new McpConfigCache();
	const reader = new McpStatusReader();
	let entries: McpEntry[] = [];
	let stopped = false;
	const alive = () => !stopped && config.showStartupHeader && mode?.loadedResourcesContainer?.children?.includes(component);
	const publish = () => { if (alive()) update(entries, reader.statuses); };
	const tick = () => {
		if (!alive()) { stop(); return; }
		attachStartupHost(mode).refresh?.();
		entries = collectMcpEntries(mode, cache);
		publish();
		reader.refresh(mode?.session?.extensionRunner, publish);
	};
	const timer = setInterval(tick, 1000);
	timer.unref?.();
	const stop = () => {
		stopped = true;
		clearInterval(timer);
		reader.dispose();
		if (stopMcpWatch === stop) {
			stopMcpWatch = undefined;
			mcpState.mounted = false;
		}
	};
	stopMcpWatch = stop;
	tick();
	return stop;
}

/** Renders native and custom splash sections in the same format in both expansion states; diagnostics remain native. */
export function replaceSections(mode: any, options: unknown, pi?: ExtensionAPI): void {
	stopStartupResources();
	const children: any[] = mode?.loadedResourcesContainer?.children;
	if (!Array.isArray(children)) return;
	const titled = children.map((child) => [child, sectionTitle(child)] as const).filter(([, title]) => title);
	const listing = (options as { force?: boolean } | undefined)?.force || mode.shouldShowStartupDetails?.() || titled.length > 0;
	if (!listing) {
		// Quiet startup has no resource listing or map; retain Pi's native diagnostics untouched.
		if (mountedModes.delete(mode)) disposeStartupHost(mode);
		return;
	}
	const host = attachStartupHost(mode);
	mountedModes.add(mode);
	host.onDispose?.();
	const controller = pi ? createSplashActionController(pi, mode, host) : undefined;
	host.onDispose = () => controller?.dispose();
	let mcpEntries: McpEntry[] = [];
	let statuses: ReadonlyMap<string, McpObservation> = new Map();
	let lastMcp = "";
	let lastSnapshot = "";
	let generation = host.generation;
	let verifiedGoogle: ModelEntry[] = [];
	let checkedGoogleAt = -Infinity;
	let checkingGoogle = false;
	let googleRuntime: any;
	const refreshGoogle = () => {
		const runtime = mode.session?.modelRuntime;
		if (googleRuntime !== runtime) { googleRuntime = runtime; verifiedGoogle = []; checkedGoogleAt = -Infinity; }
		if (checkingGoogle || !runtime || typeof runtime.getAvailable !== "function" || typeof runtime.getModels !== "function") return;
		const registered = runtime.getModels("google")?.some((model: ModelEntry) => /^antigravity-(gemini|gemma)-/.test(model.id));
		const inSnapshot = runtime.getAvailableSnapshot?.()?.some((model: ModelEntry) => model.provider === "google" && /^antigravity-(gemini|gemma)-/.test(model.id));
		if (!registered || inSnapshot || Date.now() - checkedGoogleAt < 15_000) return;
		checkingGoogle = true;
		checkedGoogleAt = Date.now();
		// Pi's provider-scoped availability check is authenticated and read-only; unlike a full
		// catalog refresh it does not replace getAvailableSnapshot(). Never use the static catalog.
		void Promise.resolve().then(() => runtime.getAvailable("google")).then((models: ModelEntry[]) => {
			if (!mountedModes.has(mode) || mode.session?.modelRuntime !== runtime) return;
			verifiedGoogle = models.filter((model) => model.provider === "google" && /^antigravity-(gemini|gemma)-/.test(model.id));
			refresh();
		}).catch(() => { verifiedGoogle = []; }).finally(() => { checkingGoogle = false; });
	};
	const section = () => collectMcpSection(mode, mcpEntries, statuses, host.contextSnapshot ?? readStartupContext(mode));
	const theme = () => hostTheme?.() ?? PLAIN_THEME;
	const refresh = () => {
		const current = attachStartupHost(mode);
		if (generation !== current.generation) { generation = current.generation; lastSnapshot = ""; lastMcp = ""; }
		let changed = false;
		const snapshot = readStartupContext(mode);
		try {
			const sections = collectSections(mode, options as { extensions?: any[] } | undefined, snapshot);
			const model = collectModelsSection(mode, verifiedGoogle, pi ? queryWaterfall(pi.events) : undefined,
				pi ? querySystem1State(pi.events)?.candidates : undefined);
			if (model) sections.Models = model;
			refreshGoogle();
			const now = JSON.stringify(sections);
			if (now !== lastSnapshot) {
				lastSnapshot = now;
				current.resourceSections = sections;
				changed = true;
			}
		} catch { /* During load Pi may not have a complete resource loader yet. */ }
		if (JSON.stringify(snapshot) !== JSON.stringify(current.contextSnapshot)) {
			current.contextSnapshot = snapshot;
			changed = true;
		}
		if (changed) mode.ui?.requestRender?.();
	};
	host.refresh = refresh;
	host.repaint = () => mode.ui?.requestRender?.();
	refresh();
	const native = new Map<any, (width: number) => string[]>();
	// The first section (or an interactive section) plans from a render-time viewport width.
	// Measure the other children through their original renderers, never through our wrappers:
	// rendering loadedResourcesContainer here would recurse into the planner.
	const selected = (name: string, width: number, expanded: boolean) => {
		const planned = ensurePlan(width);
		return expanded ? (name === "MCP" ? section() : host.resourceSections?.[name]) : planned[name];
	};
	const initialExpanded = !!mode.getStartupExpansionState?.();
	const interactive = (getSection: (width: number, expanded: boolean) => ResourceSection | undefined) => {
		if (controller) return createInteractiveSection(getSection, theme, (action) => void controller.activate(action), initialExpanded);
		let expanded = initialExpanded;
		return {
			get expanded() { return expanded; },
			setExpanded(next: boolean) { expanded = next; },
			render(width: number) { const value = getSection(width, expanded); return value ? renderSection(value, width, theme()) : []; },
			invalidate() {},
		};
	};
	const modelComponent = interactive((width, expanded) => selected("Models", width, expanded));
	const modelSpacer = { render: () => host.resourceSections?.Models ? [""] : [], invalidate() {} };
	const mapComponent = {
		render(width: number) {
			return renderContextTreemap(host.contextSnapshot ?? {
				stage: "initializing", modelLabel: "Model unknown", usedEstimate: 0, sources: [],
				toolDeclarationsKnown: false, mcpOriginsKnown: false,
				attribution: { files: false, skills: false }, caveats: [],
			}, width, theme());
		},
		invalidate() {},
	};
	// Pi puts a Spacer before its first native section. Keep the introductory section flush left.
	if (config.showStartupHeader && children[0]?.constructor?.name === "Spacer" && children[1] === titled[0]?.[0]) {
		children.shift();
	}
	// Keep Extensions ahead of the context-related resources. Pi's diagnostics stay in
	// their native relative order; MCP follows the entire native listing before the map.
	const extension = titled.find(([, title]) => title === "Extensions")?.[0];
	const first = titled.find(([, title]) => title !== "Extensions")?.[0];
	const extensionAt = extension ? children.indexOf(extension) : -1;
	const firstAt = first ? children.indexOf(first) : -1;
	if (extensionAt > firstAt && firstAt >= 0) {
		const length = children[extensionAt + 1]?.constructor?.name === "Spacer" ? 2 : 1;
		const moved = children.splice(extensionAt, length);
		children.splice(firstAt, 0, ...moved);
	}
	const component = interactive((width, expanded) => selected("MCP", width, expanded));
	const spacer = { render: () => mcpEntries.length > 0 || statuses.size > 0 ? [""] : [], invalidate() {} };
	children.push(component, spacer);
	// Native sections (including diagnostics) end in a Spacer; when MCP is last its
	// conditional spacer serves the same purpose. Models gets one blank row of its own,
	// once the conversation starts below it.
	const tailSpacer = { render: () => mode.chatContainer?.children?.length ? [""] : [], invalidate() {} };
	children.push(mapComponent, modelSpacer, modelComponent, tailSpacer);
	const dock = ["editorContainer", "footerContainer", "statusContainer", "pendingMessagesContainer", "widgetContainerAbove", "widgetContainerBelow"];
	const height = (node: any, width: number) => typeof node?.render === "function" ? node.render(width).length : 0;
	// Every splash section asks for the plan while rendering, and the splash stays in the transcript
	// for the whole session. Pi's own containers (header, chat, editor, footer, widgets) are measured
	// once, on the first render after the splash is shown; later frames never render them again. The
	// fold budget follows the terminal's current rows, so a resized pane refits without measuring Pi
	// again. Plans are reused until the splash's own content, expansion, width or rows change.
	let fixed: number | undefined;
	const planCache = new Map<number, { inputs: unknown[]; planned: Record<string, ResourceSection> }>();
	const plans = new Map<string, Record<string, ResourceSection>>();
	const planInputs = (): unknown[] => [
		mode.ui?.terminal?.rows, fixed, attachStartupHost(mode).generation, host.resourceSections, host.contextSnapshot, lastMcp, mcpState.revision,
		component.expanded, modelComponent.expanded, children.length,
		...titled.map(([child]) => !!child.state?.expanded),
	];
	function ensurePlan(width: number): Record<string, ResourceSection> {
		const cached = planCache.get(width);
		const inputs = planInputs();
		if (cached && cached.inputs.length === inputs.length && cached.inputs.every((input, index) => input === inputs[index])) return cached.planned;
		const planned = measurePlan(width);
		if (planCache.size >= 4) planCache.clear();
		// Recompute: the first plan sets `fixed`.
		planCache.set(width, { inputs: planInputs(), planned });
		return planned;
	}
	function measurePlan(width: number): Record<string, ResourceSection> {
		const current = attachStartupHost(mode);
		if (generation !== current.generation) { generation = current.generation; plans.clear(); }
		const full = { ...host.resourceSections, MCP: section() } as Record<string, ResourceSection>;
		if (!full.MCP) delete full.MCP;
		const rows = mode.ui?.terminal?.rows;
		if (!Number.isFinite(rows)) return full;
		const outside = fixed ??= height(mode.headerContainer, width) + height(mode.chatContainer, width)
			+ dock.reduce((sum, name) => sum + height(mode[name], width), 0);
		const splashFixed: Array<() => number> = [];
		const flexible: Record<string, ResourceSection> = {};
		for (const child of children) {
			if (child === component || child === modelComponent) continue;
			const title = titled.find(([original]) => original === child)?.[1];
			if (title && full[title]) {
				if (child.state?.expanded) splashFixed.push(() => renderSection(full[title], width, theme()).length);
				else flexible[title] = full[title];
			} else splashFixed.push(() => height(native.get(child) ? { render: native.get(child) } : child, width));
		}
		if (full.MCP) {
			if (component.expanded) splashFixed.push(() => renderSection(full.MCP!, width, theme()).length);
			else flexible.MCP = full.MCP;
		}
		if (full.Models) {
			if (modelComponent.expanded) splashFixed.push(() => renderSection(full.Models!, width, theme()).length);
			else flexible.Models = full.Models;
		}
		// All splash-owned spacers and the map are included exactly once above. Any budget at or
		// below zero plans the same shortest listing, so a full screen skips measuring the splash.
		const budget = outside >= rows ? 0 : Math.max(0, rows - outside - splashFixed.reduce((sum, measure) => sum + measure(), 0));
		const expansions = [...titled.map(([child]) => !!child.state?.expanded), component.expanded, modelComponent.expanded];
		const key = JSON.stringify([width, budget, expansions, flexible]);
		let plan = plans.get(key);
		if (!plan) {
			plan = planSplashSections(flexible, width, theme(), budget);
			if (plans.size >= 8) plans.delete(plans.keys().next().value!);
			plans.set(key, plan);
		}
		return { ...full, ...plan };
	}
	watchMcpState(mode, component, (entries, observed) => {
		mcpEntries = entries;
		statuses = observed;
		const current = section();
		const now = JSON.stringify(current);
		mcpState.mounted = !!current;
		if (now !== lastMcp) {
			lastMcp = now;
			mode.ui?.requestRender?.();
		}
	});
	for (const [child, title] of titled) native.set(child, child.render.bind(child));
	for (const [child, title] of titled) {
		const expandedRender = native.get(child)!;
		child.render = (width: number) => {
			const planned = ensurePlan(width);
			const section = host.resourceSections?.[title!];
			return !section ? expandedRender(width)
				: renderSection(child.state?.expanded ? section : planned[title!] ?? section, width, theme());
		};
	}
}

export function installStartupResources(pi?: ExtensionAPI): void {
	pi?.on("session_shutdown", disposeStartupResources);
	pi?.on("model_select", refreshStartupHosts);
	pi?.on("session_tree", refreshStartupHosts);
	pi?.on("session_compact", refreshStartupHosts);
	pi?.on("agent_end", refreshStartupHosts);
	const prototype = (InteractiveMode as any)?.prototype;
	if (!prototype || typeof prototype.showLoadedResources !== "function") return;
	const previous = patchRegistry.get<StartupResourcesPatch>(STARTUP_RESOURCES_PATCH);
	if (previous) {
		previous.active = false;
		previous.stop?.();
	}
	const original =
		previous && prototype.showLoadedResources === previous.installed
			? previous.original
			: prototype.showLoadedResources;
	const patch: StartupResourcesPatch = {
		active: true,
		stop: disposeStartupResources,
		original,
		installed: function (this: any, ...args: any[]) {
			const result = original.apply(this, args);
			if (!patch.active || !config.showStartupHeader) return result;
			try {
				replaceSections(this, args[0], pi);
			} catch {
				// Fall back to pi's own listing rather than break startup.
			}
			return result;
		},
	};
	prototype.showLoadedResources = patch.installed;
	patchRegistry.install(STARTUP_RESOURCES_PATCH, patch);
	installMcpNotify(prototype);
}

type McpNotifyPatch = {
	active: boolean;
	original: (...args: any[]) => unknown;
	installed: (...args: any[]) => unknown;
};

/**
 * Pi's MCP extension reports servers that need a sign-in or failed as one warning. Once the startup listing's
 * MCP section is on screen its state marks show which servers need attention, so the warning is taken in (its
 * configuration lines, which belong to no server, still show). Native /mcp retains the details; later reconnect
 * and sign-in confirmations update the marks.
 */
export function installMcpNotify(prototype: any): void {
	if (typeof prototype.showExtensionNotify !== "function") return;
	const previous = patchRegistry.get<McpNotifyPatch>(MCP_NOTIFY_PATCH);
	if (previous) previous.active = false;
	const original =
		previous && prototype.showExtensionNotify === previous.installed ? previous.original : prototype.showExtensionNotify;
	const patch: McpNotifyPatch = {
		active: true,
		original,
		installed: function (this: any, message: string, type?: string, ...rest: any[]) {
			if (patch.active && config.showStartupHeader && mcpState.mounted && typeof message === "string") {
				try {
					const report = parseAttentionMessage(message);
					if (report) {
						mcpState.record(report);
						this.ui?.requestRender?.();
						return report.configLines.length > 0
							? original.call(this, configWarning(report), type, ...rest)
							: undefined;
					}
					const outcome = parseOutcomeMessage(message);
					if (outcome) {
						mcpState.outcome(outcome.name, outcome.state);
						this.ui?.requestRender?.();
					}
				} catch {
					// Show the message as pi wrote it rather than lose it.
				}
			}
			return original.call(this, message, type, ...rest);
		},
	};
	prototype.showExtensionNotify = patch.installed;
	patchRegistry.install(MCP_NOTIFY_PATCH, patch);
}
