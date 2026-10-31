import path from "node:path";
import { InteractiveMode, getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import {
	CONNECTING_GRACE_MS,
	type McpEntry,
	type McpLevel,
	type McpStatus,
	configWarning,
	connectedNames,
	loadMcpEntries,
	mcpState,
	parseAttentionMessage,
	parseOutcomeMessage,
} from "./mcp-servers.ts";
import { MCP_NOTIFY_PATCH, STARTUP_RESOURCES_PATCH, patchRegistry } from "../../utils/patch-keys.ts";

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
	/** A colored word after an item, parallel to `items` (grid layout); undefined entries have none. */
	marks?: Array<ResourceMark | undefined>;
};

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
	/** Shown after the heading in the warning color. */
	attention?: string;
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
	if (!group.marks) return group.items;
	return group.items.map((item, index) => {
		const mark = group.marks![index];
		if (!mark) return item;
		const shown = mark.highlight ? theme.bold(theme.fg(mark.color, item)) : item;
		return `${shown} ${theme.fg(mark.color, mark.text)}`;
	});
}

/** Most entries a column holds before it splits into side-by-side sub-columns under the same heading. */
export const COLUMN_MAX_ROWS = 8;

type Block = { lines: string[]; width: number };

/** One group as a column block: its heading, then its entries (token counts right-aligned in each cell). */
function columnBlock(group: ResourceGroup, available: number, ctx: RenderContext): Block {
	const { theme } = ctx;
	const heading = `${theme.fg("accent", group.label ?? "")} ${theme.fg("dim", String(group.items.length))}`;
	const names = markedItems(group, theme);
	const counts = group.tokens?.map(lineCount);
	const cells = names.map((name, index) => ({ name, count: counts?.[index] }));
	const headingWidth = visibleWidth(heading);
	const layout = (rows: number) => {
		const columns: Array<typeof cells> = [];
		for (let at = 0; at < cells.length; at += rows) columns.push(cells.slice(at, at + rows));
		const widths = columns.map((column) => {
			const name = Math.max(...column.map((cell) => visibleWidth(cell.name)));
			const count = Math.max(0, ...column.map((cell) => cell.count?.length ?? 0));
			return { name, count, total: name + (count ? 2 + count : 0) };
		});
		const width = Math.max(headingWidth, widths.reduce((sum, w) => sum + w.total, 0) + COLUMN_GAP * (columns.length - 1));
		return { columns, widths, width };
	};
	let rows = Math.min(cells.length, COLUMN_MAX_ROWS);
	let shape = layout(Math.max(1, rows));
	while (shape.width > available && rows < cells.length) shape = layout(++rows);
	const lines = [heading];
	for (let row = 0; row < Math.max(1, rows) && cells.length > 0; row++) {
		let line = "";
		shape.columns.forEach((column, index) => {
			const cell = column[row];
			const w = shape.widths[index]!;
			const pad = index === 0 ? "" : " ".repeat(COLUMN_GAP);
			if (!cell) {
				line += pad + " ".repeat(w.total);
				return;
			}
			const count = cell.count ? theme.fg("dim", cell.count) : "";
			const gap = " ".repeat(w.total - visibleWidth(cell.name) - (cell.count?.length ?? 0));
			line += pad + cell.name + gap + count;
		});
		lines.push(line.trimEnd());
	}
	return { lines, width: shape.width };
}

/** Groups as side-by-side column blocks, packed left to right and wrapped into bands that fit `width`. */
function renderColumns(groups: ResourceGroup[], indent: number, ctx: RenderContext): string[] {
	const available = Math.max(1, ctx.width - indent);
	const blocks = groups.map((group) => columnBlock(group, available, ctx));
	const bands: Block[][] = [];
	let used = 0;
	for (const block of blocks) {
		const band = bands[bands.length - 1];
		if (band && used + COLUMN_GAP + block.width <= available) {
			band.push(block);
			used += COLUMN_GAP + block.width;
		} else {
			bands.push([block]);
			used = block.width;
		}
	}
	const lines: string[] = [];
	for (const band of bands) {
		const height = Math.max(...band.map((block) => block.lines.length));
		for (let row = 0; row < height; row++) {
			let line = " ".repeat(indent);
			band.forEach((block, index) => {
				const text = block.lines[row] ?? "";
				const last = index === band.length - 1;
				line += last ? text : text + " ".repeat(block.width - visibleWidth(text) + COLUMN_GAP);
			});
			lines.push(truncateToWidth(line.trimEnd(), ctx.width));
		}
	}
	return lines;
}

function renderGroupItems(group: ResourceGroup, indent: number, ctx: RenderContext): string[] {
	const { section, width, theme } = ctx;
	if (section.layout === "lines") {
		return group.items.map((item, index) => {
			const head = `${" ".repeat(indent)}${item}`;
			if (!group.tokens) return truncateToWidth(head, width);
			const count = lineCount(group.tokens[index]!);
			const gap = " ".repeat(Math.max(2, ctx.countEnd - visibleWidth(head) - count.length));
			return truncateToWidth(`${head}${gap}${theme.fg("dim", count)}`, width);
		});
	}
	const colors = group.tokens ? skillTokenColors(group.tokens, ctx.allTokens) : [];
	const items = group.tokens
		? group.items.map((item, index) => `${item} ${theme.fg(colors[index]!, lineCount(group.tokens![index]!))}`)
		: markedItems(group, theme);
	return layoutGrid(items, width, indent);
}

function renderGroup(group: ResourceGroup, indent: number, ctx: RenderContext): string[] {
	const lines: string[] = [];
	const nested = group.label !== undefined;
	if (nested) {
		lines.push(
			`${" ".repeat(indent)}${ctx.theme.fg("accent", group.label!)} ${ctx.theme.fg("dim", String(groupCount(group)))}`,
		);
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
		group.items.forEach((item, index) => {
			names = Math.max(names, inner + visibleWidth(item));
			if (group.tokens) counts = Math.max(counts, lineCount(group.tokens[index]!).length);
		});
		for (const child of group.children ?? []) visit(child, inner);
	};
	for (const group of groups) visit(group, indent);
	return names + 2 + counts;
}

export function renderSection(
	section: ResourceSection,
	width: number,
	theme: StartupTheme,
): string[] {
	const cost = section.tokens
		? ` ${theme.fg(windowShareColor(section.tokens, section.contextWindow), `· ~${formatTokens(section.tokens)} tok`)}`
		: "";
	const attention = section.attention ? ` ${theme.fg("warning", `· ${section.attention}`)}` : "";
	const heading = `${theme.bold(theme.fg("mdHeading", section.title))} ${theme.fg("dim", String(section.count))}${cost}${attention}`;
	const ctx: RenderContext = {
		section,
		width,
		theme,
		allTokens: allGroups(section.groups).flatMap((group) => group.tokens ?? []),
		countEnd: countColumn(section.groups, INDENT),
	};
	const lines = [heading];
	if (section.layout === "columns") lines.push(...renderColumns(section.groups, INDENT, ctx));
	else for (const group of section.groups) lines.push(...renderGroup(group, INDENT, ctx));
	for (const note of section.notes ?? []) {
		lines.push(truncateToWidth(`${" ".repeat(INDENT)}${theme.fg(note.color, note.text)}`, width));
	}
	return lines;
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
export function collectSections(mode: any, options?: { extensions?: any[] }): Record<string, ResourceSection> {
	const loader = mode.session.resourceLoader;
	const sections: Record<string, ResourceSection> = {};
	const contextWindow = mode.session?.model?.contextWindow as number | undefined;

	const appendSources = loader.getAppendSystemPromptSources() as any[];
	const appendTexts = (loader.getAppendSystemPrompt?.() ?? []) as string[];
	const cwd = mode.sessionManager?.getCwd?.() as string | undefined;
	const agentDir = (loader.agentDir as string | undefined) ?? getAgentDir();
	const contextFiles: Array<{ path: string; tokens: number }> = [
		...(loader.getSystemPromptSource()
			? [{ path: loader.getSystemPromptSource().path, tokens: estimateTokens(loader.getSystemPrompt?.() ?? "") }]
			: []),
		...appendSources.map((file, index) => ({ path: file.path, tokens: estimateTokens(appendTexts[index] ?? "") })),
		...(loader.getAgentsFiles().agentsFiles as any[]).map((file) => ({
			path: file.path,
			tokens: estimateTokens(file.content ?? ""),
		})),
	];
	if (contextFiles.length > 0) {
		const total = contextFiles.reduce((sum, file) => sum + file.tokens, 0);
		const groups: ResourceGroup[] = [];
		for (const scope of SCOPE_ORDER) {
			// Largest first; equal sizes keep pi's order (stable sort).
			const inScope = contextFiles
				.filter((file) => contextScope(file.path, agentDir, cwd) === scope)
				.sort((a, b) => b.tokens - a.tokens);
			if (inScope.length === 0) continue;
			groups.push({
				label: scope,
				items: inScope.map((file) => mode.formatContextPath(file.path)),
				tokens: inScope.map((file) => file.tokens),
			});
		}
		sections.Context = {
			title: "Context",
			count: contextFiles.length,
			tokens: total,
			contextWindow,
			layout: "columns",
			groups,
		};
	}

	const skills = loader.getSkills().skills as any[];
	if (skills.length > 0) {
		sections.Skills = {
			title: "Skills",
			count: skills.length,
			tokens: skills.reduce((sum, skill) => sum + skillPromptTokens(skill), 0),
			contextWindow,
			layout: "grid",
			groups: groupEntries(
				skills.map((skill) => ({
					name: skill.name,
					tokens: skillPromptTokens(skill),
					...entryOrigin(mode, skill.sourceInfo),
				})),
				"name",
			),
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

const MCP_MARKS: Record<Exclude<McpStatus, "connected">, ResourceMark> = {
	"needs-auth": { text: "needs sign-in", color: "warning" },
	failed: { text: "failed", color: "error" },
	connecting: { text: "connecting", color: "dim" },
};

/** The servers configured for this session, each with the level it is active at. */
export function collectMcpEntries(mode: any): McpEntry[] {
	try {
		const cwd = mode?.sessionManager?.getCwd?.() as string | undefined;
		const registered = (mode?.session?.extensionRunner?.runtime?.mcpServers?.list?.() ?? []) as Array<{ name: string }>;
		return loadMcpEntries({
			userFile: path.join(getAgentDir(), "mcp.json"),
			projectFile: cwd && mode?.settingsManager?.isProjectTrusted?.() ? path.join(cwd, ".pi", "mcp.json") : undefined,
			registered: registered.map((server) => server.name),
		});
	} catch {
		return [];
	}
}

function connectedServers(mode: any): Set<string> {
	try {
		return connectedNames((mode?.session?.getAllTools?.() ?? []) as any[]);
	} catch {
		return new Set();
	}
}

/** The MCP section: servers under the level they are configured at, with a mark on any that is not (yet) usable. */
export function buildMcpSection(
	entries: McpEntry[],
	status: (name: string) => McpStatus | undefined,
	detail: (name: string) => string | undefined = () => undefined,
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
		const marks = inLevel.map((entry) => {
			const state = status(entry.name);
			if (state === "needs-auth") needAuth++;
			if (state === "failed") {
				failed++;
				const why = detail(entry.name);
				if (why) notes.push({ text: `${entry.name}: ${why}`, color: "error" });
			}
			return state && state !== "connected" ? MCP_MARKS[state] : undefined;
		});
		groups.push({ label: level, items: inLevel.map((entry) => entry.name), ...(marks.some(Boolean) ? { marks } : {}) });
	}
	const problems = [needAuth && `${needAuth} need${needAuth === 1 ? "s" : ""} sign-in`, failed && `${failed} failed`].filter(Boolean);
	return {
		title: "MCP",
		count: entries.length,
		layout: "grid",
		groups,
		...(problems.length > 0 ? { attention: `${problems.join(", ")}, /mcp to fix` } : {}),
		...(notes.length > 0 ? { notes } : {}),
	};
}

/** The configured MCP servers as a section, with their live state; undefined when none are configured. */
export function collectMcpSection(mode: any, entries: McpEntry[] = collectMcpEntries(mode)): ResourceSection | undefined {
	const connected = connectedServers(mode);
	return buildMcpSection(
		entries,
		(name) => mcpState.status(name, connected),
		(name) => mcpState.detail(name),
	);
}

// ---- Models (pi only prints the scope as one line before the TUI starts) ----

export type ModelEntry = { provider: string; id: string; thinkingLevel?: string };

const CURRENT_MARK: ResourceMark = { text: "●", color: "success", highlight: true };

/**
 * The models section: the session's model scope (enabledModels or --models) when one is set, else every model
 * with credentials, grouped by provider in the order given, each scoped model with its thinking level and the
 * session's model highlighted in green (accent is the provider subheader color).
 */
export function buildModelsSection(
	models: ModelEntry[],
	current?: { provider: string; id: string },
	scoped = false,
): ResourceSection | undefined {
	if (models.length === 0) return undefined;
	const providers = new Map<string, ModelEntry[]>();
	for (const model of models) providers.set(model.provider, [...(providers.get(model.provider) ?? []), model]);
	const groups: ResourceGroup[] = [...providers].map(([provider, list]) => {
		const marks = list.map((model) =>
			current && model.provider === current.provider && model.id === current.id ? CURRENT_MARK : undefined,
		);
		return {
			label: provider,
			items: list.map((model) => (model.thinkingLevel ? `${model.id}:${model.thinkingLevel}` : model.id)),
			...(marks.some(Boolean) ? { marks } : {}),
		};
	});
	return { title: scoped ? "Models" : "Models (all available)", count: models.length, layout: "columns", groups };
}

/** The session's models as a section; undefined when there are none or pi's model API is missing. */
export function collectModelsSection(mode: any): ResourceSection | undefined {
	try {
		const session = mode?.session;
		const scopedModels = (session?.scopedModels ?? []) as Array<{ model: any; thinkingLevel?: string }>;
		const scoped = scopedModels.length > 0;
		const models: ModelEntry[] = scoped
			? scopedModels.map((entry) => ({
					provider: entry.model.provider,
					id: entry.model.id,
					...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
				}))
			: ([...(session?.modelRuntime?.getAvailableSnapshot?.() ?? [])] as any[]).map((model) => ({
					provider: model.provider,
					id: model.id,
				}));
		const current = session?.model ? { provider: session.model.provider, id: session.model.id } : undefined;
		return buildModelsSection(models, current, scoped);
	} catch {
		return undefined;
	}
}

// ---- Wiring ----

type StartupResourcesPatch = {
	active: boolean;
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

let mcpWatch: ReturnType<typeof setInterval> | undefined;

/** Asks for a repaint when the set of connected servers changes, while connections are still settling. */
function watchMcpState(mode: any): void {
	if (mcpWatch) clearInterval(mcpWatch);
	let last = [...connectedServers(mode)].sort().join(",");
	const timer = setInterval(() => {
		const now = [...connectedServers(mode)].sort().join(",");
		if (now !== last) {
			last = now;
			mode?.ui?.requestRender?.();
		}
		if (Date.now() - mcpState.mountedAt > 2 * CONNECTING_GRACE_MS) {
			clearInterval(timer);
			if (mcpWatch === timer) mcpWatch = undefined;
		}
	}, 1000);
	timer.unref?.();
	mcpWatch = timer;
}

/** Swaps the collapsed rendering of each pi startup section for ours; the expanded rendering stays pi's. */
function replaceSections(mode: any, options: unknown): void {
	const children: any[] = mode?.loadedResourcesContainer?.children;
	if (!Array.isArray(children)) return;
	const titled = children.map((child) => [child, sectionTitle(child)] as const).filter(([, t]) => t);
	if (titled.length === 0) return;
	const sections = collectSections(mode, options as { extensions?: any[] } | undefined);
	if (collectModelsSection(mode)) {
		// First, ahead of Context: rendered live so the current mark follows model switches.
		const at = children.indexOf(titled[0]![0]);
		const render = (width: number) => {
			const section = collectModelsSection(mode);
			return section ? renderSection(section, width, hostTheme?.() ?? PLAIN_THEME) : [];
		};
		children.splice(at, 0, { render, invalidate() {} }, { render: () => [""], invalidate() {} });
	}
	const mcpEntries = collectMcpEntries(mode);
	if (mcpEntries.length > 0) {
		// Right after Extensions (else the last titled section), followed by the same one-line spacer pi uses.
		const anchor = titled.find(([, title]) => title === "Extensions") ?? titled[titled.length - 1]!;
		const at = children.indexOf(anchor[0]);
		const render = (width: number) => {
			const section = collectMcpSection(mode, mcpEntries);
			return section ? renderSection(section, width, hostTheme?.() ?? PLAIN_THEME) : [];
		};
		const component = { render, invalidate() {} };
		const spacer = { render: () => [""], invalidate() {} };
		children.splice(at + 2, 0, component, spacer);
		mcpState.mount();
		watchMcpState(mode);
	}
	for (const [child, title] of titled) {
		const section = sections[title!];
		if (!section) continue;
		const expandedRender = child.render.bind(child);
		child.render = (width: number) =>
			child.state?.expanded
				? expandedRender(width)
				: renderSection(section, width, hostTheme?.() ?? PLAIN_THEME);
	}
}

export function installStartupResources(): void {
	const prototype = (InteractiveMode as any)?.prototype;
	if (!prototype || typeof prototype.showLoadedResources !== "function") return;
	const previous = patchRegistry.get<StartupResourcesPatch>(STARTUP_RESOURCES_PATCH);
	if (previous) previous.active = false;
	const original =
		previous && prototype.showLoadedResources === previous.installed
			? previous.original
			: prototype.showLoadedResources;
	const patch: StartupResourcesPatch = {
		active: true,
		original,
		installed: function (this: any, ...args: any[]) {
			const result = original.apply(this, args);
			if (!patch.active || !config.showStartupHeader) return result;
			try {
				replaceSections(this, args[0]);
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
						mcpState.record(report, connectedServers(this));
						this.ui?.requestRender?.();
						return report.configLines.length > 0
							? original.call(this, configWarning(report), type, ...rest)
							: undefined;
					}
					const outcome = parseOutcomeMessage(message);
					if (outcome) {
						mcpState.outcome(outcome.name, outcome.state, connectedServers(this));
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
