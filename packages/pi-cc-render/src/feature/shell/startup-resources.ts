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
import { attachStartupHost, disposeStartupHost } from "./startup-state.ts";
import { createInteractiveSection, createSplashActionController } from "./startup-interactions.ts";
export { GLYPHS } from "./startup-style.ts";

/**
 * Readable replacement for the collapsed startup listing ([Context] / [Skills] / [Prompts] / [Extensions]).
 *
 * Pi prints each section as one comma-joined run of labels, which for extensions means a wall of repeated
 * `owner/repo:packages/pi-x/src` paths. Here every section gets a heading with a count, and every section
 * (Context, Skills, Prompts, Extensions, MCP) is split the same way: by level (project, then user, then
 * path or extension), each level labelled with its count even when it is the only one. Inside a level,
 * local entries come first, then packages (one sub-heading per package with several entries, the rest
 * together under `packages`), as pi's own expanded listing nests them. Entries show by short name in
 * aligned columns.
 * Context files and skills are what the model carries in every request, so they also show an estimated
 * token cost: a total on the heading, per-file counts for context files (largest first) and a count
 * after every skill, colored by weight (dim, muted, warning, error). The expanded view (ctrl+o) is left to pi.
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
	/** Estimated tokens the whole section adds to every request; shown on the heading when above zero. */
	tokens?: number;
	/** The model's context window, when known; colors the heading total by its share of it. */
	contextWindow?: number;
	/**
	 * "lines" lists one entry per line; "grid" packs short names into columns; "columns" puts each group side
	 * by side as its own column (heading on top, entries under it), wrapping to a new band when out of width.
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
	return group.items.length + (group.children ?? []).reduce((sum, child) => sum + groupCount(child), 0);
}

function allGroups(groups: ResourceGroup[]): ResourceGroup[] {
	return groups.flatMap((group) => [group, ...allGroups(group.children ?? [])]);
}

/** Column-major grid (reads down, like `ls`) that never splits an entry and never exceeds `width`. */
export function layoutGrid(items: string[], width: number, indent: number): string[] {
	if (items.length === 0) return [];
	const cell = Math.max(...items.map((item) => visibleWidth(item))) + COLUMN_GAP;
	const available = Math.max(1, width - indent);
	const maxColumns = Math.max(1, Math.floor((available + COLUMN_GAP) / cell));
	const rows = Math.ceil(items.length / Math.min(maxColumns, items.length));
	const columns = Math.ceil(items.length / rows);
	const lines: string[] = [];
	for (let row = 0; row < rows; row++) {
		let line = " ".repeat(indent);
		for (let column = 0; column < columns; column++) {
			const item = items[column * rows + row];
			if (item === undefined) continue;
			const last = column === columns - 1 || items[(column + 1) * rows + row] === undefined;
			line += last ? item : item + " ".repeat(cell - visibleWidth(item));
		}
		lines.push(truncateToWidth(line, width));
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
type Candidate = { columns: number; rows: number; width: number; widths: Array<{ name: number; count: number; total: number }> };

function candidateShapes(group: ResourceGroup, available: number, theme: StartupTheme, category?: ResourceSection["category"]): { cells: Cell[]; heading: string; shapes: Candidate[] } {
	const heading = `${theme.fg("accent", group.label ?? "")} ${theme.fg("dim", String(group.items.length))}`;
	const cells: Cell[] = markedItems(group, theme).map((name, index) => {
		const right = rightText(group, index);
		return {
			name: `${category ? `${categoryStyle(theme, category).swatch("■")} ` : ""}${prefixText(group, index, theme)}${name}`,
			count: right?.text ?? "",
			color: right?.color ?? "dim",
			...(group.actions?.[index] ? { action: group.actions[index] } : {}),
		};
	});
	const shapes: Candidate[] = [];
	for (let columns = 1; columns <= Math.max(1, Math.floor(cells.length / 3)); columns++) {
		const rows = Math.ceil(cells.length / columns);
		const actualColumns = Math.ceil(cells.length / Math.max(1, rows));
		const lastColumn = cells.length - (columns - 1) * rows;
		if (actualColumns !== columns || (columns > 1 && lastColumn < 3)) continue;
		const widths = Array.from({ length: columns }, (_, index) => {
			const items = cells.slice(index * rows, (index + 1) * rows);
			const count = Math.max(0, ...items.map((cell) => visibleWidth(cell.count)));
			const natural = Math.max(0, ...items.map((cell) => visibleWidth(cell.name)));
			const name = columns === 1 ? Math.min(natural, Math.max(0, available - (count ? count + 2 : 0))) : natural;
			const gap = name && count ? 2 : 0;
			return { name, count, total: name + gap + count };
		});
		const width = Math.max(visibleWidth(heading), widths.reduce((sum, item) => sum + item.total, 0) + COLUMN_GAP * (columns - 1));
		if (width <= available || columns === 1) shapes.push({ columns, rows, width: Math.min(available, width), widths });
	}
	// A wider candidate with no height benefit can never improve a band.
	return { cells, heading, shapes: shapes.filter((shape) => !shapes.some((other) => other !== shape && other.width <= shape.width && other.rows <= shape.rows && (other.width < shape.width || other.rows < shape.rows))) };
}

function columnBlock(shape: Candidate, cells: Cell[], heading: string, available: number, theme: StartupTheme): Block {
	const width = Math.min(available, shape.width);
	const lines = [truncateToWidth(heading, width)];
	const hits: CellHit[] = [];
	for (let row = 0; row < shape.rows; row++) {
		let line = "";
		for (let column = 0; column < shape.columns; column++) {
			if (column) line += " ".repeat(COLUMN_GAP);
			const at = column * shape.rows + row;
			const cell = cells[at];
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

type Band = { blocks: Block[]; width: number; height: number; splits: number; key: string };
function compareChoices(a: { height: number; splits: number; bands: number; key: string }, b: typeof a): number {
	return a.height - b.height || a.splits - b.splits || a.bands - b.bands || a.key.localeCompare(b.key);
}

/** Bounded width-DP for each contiguous band, then a partition DP across groups. */
function layoutColumns(groups: ResourceGroup[], indent: number, ctx: RenderContext): SectionLayout {
	const available = Math.max(1, ctx.width - indent);
	const options = groups.map((group) => {
		const { cells, heading, shapes } = candidateShapes(group, available, ctx.theme, ctx.section.category);
		return shapes.map((shape) => columnBlock(shape, cells, heading, available, ctx.theme));
	});
	const partition: Array<{ height: number; splits: number; bands: number; key: string; value: Band[] } | undefined> = Array(groups.length + 1).fill(undefined);
	partition[groups.length] = { height: 0, splits: 0, bands: 0, key: "", value: [] };
	for (let start = groups.length - 1; start >= 0; start--) {
		let frontier = new Map<string, Band>([["0:0", { blocks: [], width: 0, height: 0, splits: 0, key: "" }]]);
		for (let end = start; end < groups.length; end++) {
			const next = new Map<string, Band>();
			for (const band of frontier.values()) for (const block of options[end]!) {
				const width = band.width + (band.blocks.length ? COLUMN_GAP : 0) + block.width;
				if (width > available) continue;
				const choice: Band = {
					blocks: [...band.blocks, block], width,
					height: Math.max(band.height, block.height), splits: band.splits + block.columns - 1,
					key: `${band.key}${block.columns.toString().padStart(3, "0")}`,
				};
				const key = `${width}:${choice.height}`;
				const old = next.get(key);
				if (!old || compareChoices({ ...choice, bands: 1 }, { ...old, bands: 1 }) < 0) next.set(key, choice);
			}
			if (!next.size) break;
			frontier = next;
			const tail = partition[end + 1]!;
			for (const band of frontier.values()) {
				const choice = { height: band.height + tail.height, splits: band.splits + tail.splits, bands: 1 + tail.bands, key: band.key + tail.key, value: [band, ...tail.value] };
				const best = partition[start];
				if (!best || compareChoices(choice, best) < 0) partition[start] = choice;
			}
		}
	}
	const lines: string[] = [];
	const hits: SplashHit[] = [];
	for (const band of partition[0]?.value ?? []) {
		for (let row = 0; row < band.height; row++) {
			let line = " ".repeat(indent);
			for (const block of band.blocks) {
				const offset = visibleWidth(line);
				const chunk = block.lines[row] ?? "";
				line += chunk + " ".repeat(Math.max(0, block.width - visibleWidth(chunk)) + COLUMN_GAP);
				for (const hit of block.hits) if (hit.row === row) hits.push({ row: lines.length, startCol: offset + hit.startCol, endCol: Math.min(ctx.width, offset + hit.endCol), action: hit.action });
			}
			lines.push(truncateToWidth(line.trimEnd(), ctx.width));
		}
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
		lines.push(truncateToWidth(
			`${" ".repeat(indent)}${ctx.theme.fg("accent", group.label!)} ${ctx.theme.fg("dim", String(groupCount(group)))}`,
			ctx.width,
		));
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

export function layoutSection(section: ResourceSection, width: number, theme: StartupTheme): SectionLayout {
	if (width <= 0) return { lines: [], hits: [] };
	const cost = section.tokens !== undefined
		? ` ${theme.fg(windowShareColor(section.tokens, section.contextWindow), `· ~${formatTokens(section.tokens)} tok`)}`
		: "";
	const attention = section.attention ? ` ${theme.fg("warning", `· ${section.attention}`)}` : "";
	const legend = (section.legend ?? []).map((part) => ` ${theme.fg("dim", "·")} ${theme.fg(part.color, part.text)}`).join("");
	const swatch = section.category ? `${categoryStyle(theme, section.category).swatch("■")} ` : "";
	const heading = `${swatch}${theme.bold(theme.fg("mdHeading", section.title))} ${theme.fg("dim", String(section.count))}${cost}${attention}${legend}`;
	const ctx: RenderContext = {
		section,
		width,
		theme,
		allTokens: allGroups(section.groups).flatMap((group) => group.tokens ?? []),
		countEnd: countColumn(section.groups, INDENT),
	};
	const lines = [truncateToWidth(heading, width)];
	const hits: SplashHit[] = [];
	if (section.layout === "columns") {
		const columns = layoutColumns(section.groups, INDENT, ctx);
		hits.push(...columns.hits.map((hit) => ({ ...hit, row: hit.row + 1 })));
		lines.push(...columns.lines);
	} else for (const group of section.groups) lines.push(...renderGroup(group, INDENT, ctx));
	for (const note of section.notes ?? []) {
		lines.push(truncateToWidth(`${" ".repeat(INDENT)}${theme.fg(note.color, note.text)}`, width));
	}
	return { lines, hits: hits.filter((hit) => hit.endCol > hit.startCol && !!sliceByColumn(lines[hit.row] ?? "", hit.startCol, hit.endCol)) };
}

export function renderSection(section: ResourceSection, width: number, theme: StartupTheme): string[] {
	return layoutSection(section, width, theme).lines;
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
	connected: GLYPHS.live,
	"needs-auth": GLYPHS.attention,
	failed: GLYPHS.failed,
	connecting: GLYPHS.pending,
	disabled: GLYPHS.idle,
	disconnected: GLYPHS.idle,
	unknown: GLYPHS.idle,
};

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

/** One entry per row, state on the left and explicit status/count on the right, in adaptive scope columns. */
export function buildMcpSection(
	entries: McpEntry[],
	status: (name: string) => McpStatus | undefined,
	detail: (name: string) => string | undefined = () => undefined,
	tools: (name: string) => number | undefined = () => undefined,
): ResourceSection | undefined {
	if (entries.length === 0) return undefined;
	const sorted = [...entries].sort((a, b) => compareNames(a.name, b.name));
	const groups: ResourceGroup[] = [];
	const notes: ResourceMark[] = [];
	let needAuth = 0;
	let failed = 0;
	for (const level of MCP_LEVELS) {
		const inLevel = sorted.filter((entry) => entry.level === level);
		if (inLevel.length === 0) continue;
		const states = inLevel.map((entry) => entry.enabled === false ? "disabled" : status(entry.name) ?? "unknown");
		const right = inLevel.map((entry, index): ResourceMark => {
			const state = states[index]!;
			if (state === "needs-auth") needAuth++;
			if (state === "failed") {
				failed++;
				const why = detail(entry.name);
				if (why) notes.push({ text: `${entry.name}: ${why}`, color: "error" });
			}
			const count = state === "connected" ? tools(entry.name) : undefined;
			const text = state === "connected" && count !== undefined
				? `connected · ${count} tool${count === 1 ? "" : "s"}`
				: state === "needs-auth" ? "needs sign-in" : state;
			return { text, color: state === "needs-auth" ? "warning" : state === "failed" ? "error" : "dim" };
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
	const problems = [needAuth && `${needAuth} need${needAuth === 1 ? "s" : ""} sign-in`, failed && `${failed} failed`].filter(Boolean);
	return {
		title: "MCP",
		count: entries.length,
		layout: "columns",
		groups,
		category: "mcp",
		...(problems.length > 0 ? { attention: `${problems.join(", ")}, /mcp to fix` } : {}),
		...(notes.length > 0 ? { notes } : {}),
	};
}

/** The configured MCP servers as a section, with their live state; undefined when none are configured. */
export function collectMcpSection(
	mode: any,
	entries: McpEntry[] = collectMcpEntries(mode),
	statuses: ReadonlyMap<string, McpObservation> = new Map(),
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
	);
}

// ---- Models (pi only prints the scope as one line before the TUI starts) ----

export type ModelEntry = { provider: string; id: string; contextWindow?: number; thinkingLevel?: string };

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
 * The models section, one line per model under a heading per provider, providers side by side as far as the
 * width allows (the columns layout Context uses): every current-generation model of each
 * provider with credentials, plus the favorites (enabledModels or --models, with any thinking level) and the
 * session's model wherever they are. Favorites carry a star and come first in their provider, in the order they
 * are configured; the session's model is highlighted in green. Every model shows its context window on the right.
 */
export function buildModelsSection(
	available: ModelEntry[],
	favorites: ModelEntry[] = [],
	current?: { provider: string; id: string },
): ResourceSection | undefined {
	const key = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
	const byKey = new Map(available.map((model) => [key(model), model]));
	const favoriteKeys = new Set(favorites.map(key));
	const providers = new Map<string, ModelEntry[]>();
	const add = (model: ModelEntry) => {
		const list = providers.get(model.provider) ?? [];
		if (!list.some((entry) => entry.id === model.id)) list.push(model);
		providers.set(model.provider, list);
	};
	for (const favorite of favorites) add({ ...byKey.get(key(favorite)), ...favorite });
	const availableProviders = new Map<string, ModelEntry[]>();
	for (const model of available) availableProviders.set(model.provider, [...(availableProviders.get(model.provider) ?? []), model]);
	for (const [, list] of availableProviders) {
		const current = currentGeneration(list.map((model) => model.id));
		const rest = list.filter((model) => current.has(model.id) && !favoriteKeys.has(key(model)));
		for (const model of rest.sort((a, b) => compareNames(a.id, b.id))) add(model);
	}
	if (current && byKey.has(key(current))) add(byKey.get(key(current))!);
	const count = [...providers.values()].reduce((sum, list) => sum + list.length, 0);
	if (count === 0) return undefined;
	const groups: ResourceGroup[] = [...providers].sort(([a], [b]) => compareNames(a, b)).map(([provider, list]) => {
		const marks = list.map((model) => (current && key(model) === key(current) ? CURRENT_MARK : undefined));
		const prefixes = list.map((model) => (favoriteKeys.has(key(model)) ? FAVORITE_MARK : undefined));
		return {
			label: provider,
			items: list.map((model) => (model.thinkingLevel ? `${model.id}:${model.thinkingLevel}` : model.id)),
			actions: list.map((model) => ({ kind: "model", provider, id: model.id, ...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {}) })),
			right: list.map((model) => formatContextWindow(model.contextWindow)),
			...(marks.some(Boolean) ? { marks } : {}),
			...(prefixes.some(Boolean) ? { prefixes } : {}),
		};
	});
	return {
		title: "Models",
		count,
		layout: "columns",
		groups,
	};
}

/** The session's models as a section; undefined when there are none or pi's model API is missing. */
export function collectModelsSection(mode: any): ResourceSection | undefined {
	try {
		const session = mode?.session;
		const scopedModels = (session?.scopedModels ?? []) as Array<{ model: any; thinkingLevel?: string }>;
		const favorites: ModelEntry[] = scopedModels.map((entry) => ({
			provider: entry.model.provider,
			id: entry.model.id,
			...(entry.model.contextWindow ? { contextWindow: entry.model.contextWindow } : {}),
			...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
		}));
		const available: ModelEntry[] = ([...(session?.modelRuntime?.getAvailableSnapshot?.() ?? [])] as any[]).map(
			(model) => ({ provider: model.provider, id: model.id, contextWindow: model.contextWindow }),
		);
		const current = session?.model ? { provider: session.model.provider, id: session.model.id } : undefined;
		return buildModelsSection(available, favorites, current);
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
export function watchMcpState(mode: any, component: unknown, update: (entries: McpEntry[], statuses: ReadonlyMap<string, McpObservation>) => void, headerOnly = false): () => void {
	stopStartupResources();
	if (!headerOnly) mcpState.mount();
	const cache = new McpConfigCache();
	const reader = new McpStatusReader();
	let entries: McpEntry[] = [];
	let stopped = false;
	const alive = () => !stopped && config.showStartupHeader && mode?.loadedResourcesContainer?.children?.includes(component);
	const publish = () => { if (alive()) update(entries, reader.statuses); };
	const tick = () => {
		if (!alive()) { stop(); return; }
		attachStartupHost(mode).refresh?.();
		if (headerOnly) return;
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

/** Replaces collapsed native sections; the native expanded content and diagnostics remain untouched. */
function replaceSections(mode: any, options: unknown, pi?: ExtensionAPI): void {
	stopStartupResources();
	const children: any[] = mode?.loadedResourcesContainer?.children;
	if (!Array.isArray(children)) return;
	const titled = children.map((child) => [child, sectionTitle(child)] as const).filter(([, title]) => title);
	const listing = (options as { force?: boolean } | undefined)?.force || mode.shouldShowStartupDetails?.() || titled.length > 0;
	if (!listing) {
		// The native quiet view has no resource headings. Keep one invisible watcher for the live header,
		// without mounting the MCP status replacement or swallowing Pi's native warnings.
		const host = attachStartupHost(mode);
		mountedModes.add(mode);
		host.onDispose?.();
		host.onDispose = undefined;
		let last = "";
		host.refresh = () => {
			const state = attachStartupHost(mode);
			const snapshot = readStartupContext(mode);
			const now = JSON.stringify(snapshot);
			if (now !== last) {
				last = now;
				state.contextSnapshot = snapshot;
				mode.ui?.requestRender?.();
			}
		};
		host.refresh();
		const sentinel = { render: () => [], invalidate() {} };
		children.push(sentinel);
		watchMcpState(mode, sentinel, () => {}, true);
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
	const section = () => collectMcpSection(mode, mcpEntries, statuses);
	const theme = () => hostTheme?.() ?? PLAIN_THEME;
	const refresh = () => {
		const current = attachStartupHost(mode);
		if (generation !== current.generation) { generation = current.generation; lastSnapshot = ""; lastMcp = ""; }
		let changed = false;
		const snapshot = readStartupContext(mode);
		try {
			const sections = collectSections(mode, options as { extensions?: any[] } | undefined, snapshot);
			const model = collectModelsSection(mode);
			if (model) sections.Models = model;
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
	const interactive = (getSection: () => ResourceSection | undefined) =>
		controller ? createInteractiveSection(getSection, theme, (action) => void controller.activate(action)) : {
			render(width: number) { const section = getSection(); return section ? renderSection(section, width, theme()) : []; },
			invalidate() {},
		};
	const modelComponent = interactive(() => host.resourceSections?.Models);
	const modelSpacer = { render: () => host.resourceSections?.Models ? [""] : [], invalidate() {} };
	const modelAt = titled.length ? children.indexOf(titled[0]![0]) : 0;
	children.splice(modelAt, 0, modelComponent, modelSpacer);
	const anchor = titled.find(([, title]) => title === "Extensions") ?? titled[titled.length - 1];
	const mcpAt = anchor ? children.indexOf(anchor[0]) + 2 : children.length;
	const component = interactive(section);
	const spacer = { render: () => mcpEntries.length > 0 || statuses.size > 0 ? [""] : [], invalidate() {} };
	children.splice(mcpAt, 0, component, spacer);
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
	for (const [child, title] of titled) {
		const expandedRender = child.render.bind(child);
		child.render = (width: number) => {
			const section = host.resourceSections?.[title!];
			return child.state?.expanded || !section
				? expandedRender(width)
				: renderSection(section, width, theme());
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
 * MCP section is on screen it shows the same thing next to each server, so the warning is taken in (its
 * configuration lines, which belong to no server, still show) and the later reconnect and sign-in confirmations
 * update the marks.
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
