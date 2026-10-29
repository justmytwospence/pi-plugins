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
 * The expanded view (ctrl+o) is left to pi.
 */

type Scope = "user" | "project" | "path";

export type ResourceEntry = {
	/** Short display name. */
	name: string;
	/** Package source label (npm name or git owner/repo); undefined for local files. */
	source?: string;
	scope: Scope;
};

export type ResourceGroup = {
	/** Sub-heading; undefined when the section needs none. */
	label?: string;
	items: string[];
};

export type ResourceSection = {
	title: string;
	count: number;
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

function compareNames(a: string, b: string): number {
	return a.localeCompare(b);
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

/**
 * Groups entries by origin: local files per scope, then packages that contribute several entries (own
 * sub-heading with a count), then every single-entry package together. `singleton` picks what a lone package
 * entry is listed as: its package name (extensions) or its own name (skills, prompts).
 */
export function groupEntries(
	entries: ResourceEntry[],
	singleton: "source" | "name",
): ResourceGroup[] {
	const locals = new Map<Scope, string[]>();
	const packages = new Map<string, { source: string; scope: Scope; entries: ResourceEntry[] }>();
	for (const entry of entries) {
		if (entry.source === undefined) {
			locals.set(entry.scope, [...(locals.get(entry.scope) ?? []), entry.name]);
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
		if (items) groups.push({ label: scope, items: items.sort(compareNames) });
	}

	const lone: string[] = [];
	const multi = [...packages.values()]
		.filter((group) => {
			if (group.entries.length > 1) return true;
			lone.push(singleton === "source" ? group.source : group.entries[0]!.name);
			return false;
		})
		.sort((a, b) => compareNames(a.source, b.source));
	for (const group of multi) {
		const names = stripSharedPrefix(
			group.entries.map((entry) => entry.name),
			"pi-",
		);
		const label = group.scope === "user" ? group.source : `${group.source} (${group.scope})`;
		groups.push({ label, items: names.sort(compareNames) });
	}
	if (lone.length > 0) groups.push({ label: "packages", items: lone.sort(compareNames) });

	// A lone local group needs no sub-heading: the section title already says what it is.
	if (groups.length === 1 && groups[0]!.label !== undefined && packages.size === 0) {
		groups[0] = { items: groups[0]!.items };
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

export function renderSection(
	section: ResourceSection,
	width: number,
	theme: StartupTheme,
): string[] {
	const heading = `${theme.bold(theme.fg("mdHeading", section.title))} ${theme.fg("dim", String(section.count))}`;
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
			for (const item of group.items) lines.push(truncateToWidth(`${" ".repeat(indent)}${item}`, width));
		} else {
			lines.push(...layoutGrid(group.items, width, indent));
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

	const contextFiles = [
		...(loader.getSystemPromptSource() ? [loader.getSystemPromptSource()] : []),
		...loader.getAppendSystemPromptSources(),
		...loader.getAgentsFiles().agentsFiles,
	];
	if (contextFiles.length > 0) {
		sections.Context = {
			title: "Context",
			count: contextFiles.length,
			layout: "lines",
			groups: [{ items: contextFiles.map((file: any) => mode.formatContextPath(file.path)) }],
		};
	}

	const skills = loader.getSkills().skills as any[];
	if (skills.length > 0) {
		sections.Skills = {
			title: "Skills",
			count: skills.length,
			layout: "grid",
			groups: groupEntries(
				skills.map((skill) => ({ name: skill.name, ...entryOrigin(mode, skill.sourceInfo) })),
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
