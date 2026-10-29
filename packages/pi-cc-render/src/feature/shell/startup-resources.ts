import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { STARTUP_RESOURCES_PATCH, patchRegistry } from "../../utils/patch-keys.ts";

/**
 * Readable replacement for the collapsed startup listing ([Context] / [Skills] / [Prompts] / [Extensions]).
 *
 * Pi prints each section as one comma-joined run of labels, which for extensions means a wall of repeated
 * `owner/repo:packages/pi-x/src` paths. Here every section gets a heading with a count, entries are grouped
 * by where they come from (scope or package), shown by short name and laid out in aligned columns.
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
	/** Estimated tokens per item, parallel to `items`; present only when the section measures them. */
	tokens?: number[];
};

export type ResourceSection = {
	title: string;
	count: number;
	/** Estimated tokens the whole section adds to every request; shown on the heading when above zero. */
	tokens?: number;
	/** The model's context window, when known; colors the heading total by its share of it. */
	contextWindow?: number;
	/** "lines" lists one entry per line (context files); "grid" packs short names into columns. */
	layout: "lines" | "grid";
	groups: ResourceGroup[];
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

/** Colors for a whole list: absolute tiers, with outliers against the list's median bumped one tier. */
export function skillTokenColors(tokens: number[]): string[] {
	const sorted = [...tokens].sort((a, b) => a - b);
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

/** Names sorted alphabetically, with their token estimates alongside when any entry has one. */
function sortedItems(entries: ResourceEntry[]): Pick<ResourceGroup, "items" | "tokens"> {
	const sorted = [...entries].sort((a, b) => compareNames(a.name, b.name));
	const items = sorted.map((entry) => entry.name);
	return sorted.some((entry) => entry.tokens !== undefined)
		? { items, tokens: sorted.map((entry) => entry.tokens ?? 0) }
		: { items };
}

/**
 * Groups entries by origin: local files per scope, then packages that contribute several entries (own
 * sub-heading with a count), then every single-entry package together. `singleton` picks what a lone package
 * entry is listed as: its package name (extensions) or its own name (skills, prompts).
 */
export function groupEntries(
	entries: ResourceEntry[],
	singleton: "source" | "name",
): ResourceGroup[] {
	const locals = new Map<Scope, ResourceEntry[]>();
	const packages = new Map<string, { source: string; scope: Scope; entries: ResourceEntry[] }>();
	for (const entry of entries) {
		if (entry.source === undefined) {
			locals.set(entry.scope, [...(locals.get(entry.scope) ?? []), entry]);
			continue;
		}
		const key = `${entry.scope}\0${entry.source}`;
		const existing = packages.get(key);
		if (existing) existing.entries.push(entry);
		else packages.set(key, { source: entry.source, scope: entry.scope, entries: [entry] });
	}

	const groups: ResourceGroup[] = [];
	for (const scope of SCOPE_ORDER) {
		const items = locals.get(scope);
		if (items) groups.push({ label: scope, ...sortedItems(items) });
	}

	const lone: ResourceEntry[] = [];
	const multi = [...packages.values()]
		.filter((group) => {
			if (group.entries.length > 1) return true;
			const only = group.entries[0]!;
			lone.push(singleton === "source" ? { ...only, name: group.source } : only);
			return false;
		})
		.sort((a, b) => compareNames(a.source, b.source));
	for (const group of multi) {
		const names = stripSharedPrefix(
			group.entries.map((entry) => entry.name),
			"pi-",
		);
		const label = group.scope === "user" ? group.source : `${group.source} (${group.scope})`;
		groups.push({
			label,
			...sortedItems(group.entries.map((entry, index) => ({ ...entry, name: names[index]! }))),
		});
	}
	if (lone.length > 0) groups.push({ label: "packages", ...sortedItems(lone) });

	// A lone local group needs no sub-heading: the section title already says what it is.
	if (groups.length === 1 && groups[0]!.label !== undefined && packages.size === 0) {
		const { label: _label, ...unlabelled } = groups[0]!;
		groups[0] = unlabelled;
	}
	return groups;
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

/** Right-aligned token counts after the names, so sizes line up down the list. */
function linesWithTokens(group: ResourceGroup, indent: number, width: number, theme: StartupTheme): string[] {
	const counts = group.tokens!.map((tokens) => `~${formatTokens(tokens)}`);
	const nameWidth = Math.max(...group.items.map((item) => visibleWidth(item)));
	const countWidth = Math.max(...counts.map((count) => count.length));
	return group.items.map((item, index) => {
		const gap = " ".repeat(nameWidth - visibleWidth(item) + 2 + countWidth - counts[index]!.length);
		return truncateToWidth(`${" ".repeat(indent)}${item}${gap}${theme.fg("dim", counts[index]!)}`, width);
	});
}

export function renderSection(
	section: ResourceSection,
	width: number,
	theme: StartupTheme,
): string[] {
	const cost = section.tokens
		? ` ${theme.fg(windowShareColor(section.tokens, section.contextWindow), `· ~${formatTokens(section.tokens)} tok`)}`
		: "";
	const heading = `${theme.bold(theme.fg("mdHeading", section.title))} ${theme.fg("dim", String(section.count))}${cost}`;
	const lines = [heading];
	for (const group of section.groups) {
		const nested = group.label !== undefined;
		if (nested) {
			lines.push(
				`${" ".repeat(INDENT)}${theme.fg("accent", group.label!)} ${theme.fg("dim", String(group.items.length))}`,
			);
		}
		const indent = nested ? INDENT * 2 : INDENT;
		if (section.layout === "lines") {
			if (group.tokens) lines.push(...linesWithTokens(group, indent, width, theme));
			else for (const item of group.items) lines.push(truncateToWidth(`${" ".repeat(indent)}${item}`, width));
		} else {
			const colors = group.tokens ? skillTokenColors(group.tokens) : [];
			const items = group.tokens
				? group.items.map(
						(item, index) => `${item} ${theme.fg(colors[index]!, `~${formatTokens(group.tokens![index]!)}`)}`,
					)
				: group.items;
			lines.push(...layoutGrid(items, width, indent));
		}
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
		// Largest first; equal sizes keep pi's order (stable sort).
		const bySize = [...contextFiles].sort((a, b) => b.tokens - a.tokens);
		const total = bySize.reduce((sum, file) => sum + file.tokens, 0);
		sections.Context = {
			title: "Context",
			count: contextFiles.length,
			tokens: total,
			contextWindow,
			layout: "lines",
			groups: [
				{
					items: bySize.map((file) => mode.formatContextPath(file.path)),
					tokens: bySize.map((file) => file.tokens),
				},
			],
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

/** Swaps the collapsed rendering of each pi startup section for ours; the expanded rendering stays pi's. */
function replaceSections(mode: any, options: unknown): void {
	const children: any[] = mode?.loadedResourcesContainer?.children;
	if (!Array.isArray(children)) return;
	const titled = children.map((child) => [child, sectionTitle(child)] as const).filter(([, t]) => t);
	if (titled.length === 0) return;
	const sections = collectSections(mode, options as { extensions?: any[] } | undefined);
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
}
