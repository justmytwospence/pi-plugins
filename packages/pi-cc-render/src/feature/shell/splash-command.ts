import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { queryWaterfall } from "../../waterfall-contract.ts";
import { readStartupContext } from "./startup-context.ts";
import { getInteractiveModeForManager } from "./startup-header.ts";
import {
	collectMcpEntries,
	collectMcpSection,
	collectModelsSection,
	collectSections,
	planSplashSections,
	renderSection,
	type ResourceSection,
	type StartupTheme,
} from "./startup-resources.ts";
import { renderContextTreemap } from "./startup-treemap.ts";

export const SPLASH_ENTRY_TYPE = "cc-render:splash";
const ORDER = ["Extensions", "Context", "Skills", "Prompts", "MCP"] as const;

type Frozen = { sections: Record<string, ResourceSection>; context: ReturnType<typeof readStartupContext>; rows: number };

/**
 * One frozen splash, built once from the live session when first rendered. Unlike the startup
 * splash it never polls, never measures the chat and never replans: its folds are planned for
 * one screen once per width, and its lines are cached per width and theme.
 */
export function freezeSplash(mode: any, rungs = undefined as Parameters<typeof collectModelsSection>[2]): Frozen | undefined {
	if (!mode?.session) return undefined;
	const context = readStartupContext(mode);
	let sections: Record<string, ResourceSection> = {};
	try { sections = collectSections(mode, undefined, context); } catch { /* Partial loader. */ }
	try {
		const mcp = collectMcpSection(mode, collectMcpEntries(mode), new Map(), context);
		if (mcp) sections.MCP = mcp;
	} catch { /* MCP unavailable. */ }
	const models = collectModelsSection(mode, [], rungs);
	if (models) sections.Models = models;
	const rows = Number(mode.ui?.terminal?.rows);
	return { sections, context, rows: Number.isFinite(rows) && rows > 0 ? rows : 40 };
}

export function renderFrozenSplash(frozen: Frozen, width: number, theme: StartupTheme): string[] {
	const map = renderContextTreemap(frozen.context, width, theme);
	// Leave room for the editor and footer below; fold whole sections like startup does.
	const listed = Object.fromEntries([...ORDER, "Models"].filter((name) => frozen.sections[name]).map((name) => [name, frozen.sections[name]!]));
	const planned = planSplashSections(listed, width, theme, Math.max(0, frozen.rows - map.length - 10));
	const lines: string[] = [""];
	for (const name of ORDER) {
		const section = planned[name];
		if (section) lines.push(...renderSection(section, width, theme), "");
	}
	lines.push(...map);
	if (planned.Models) lines.push("", ...renderSection(planned.Models, width, theme));
	lines.push("");
	return lines;
}

export function installSplashCommand(pi: ExtensionAPI): void {
	const frozen = new Map<string, Frozen>();
	let manager: object | undefined;
	pi.registerEntryRenderer(SPLASH_ENTRY_TYPE, (entry, _options, theme) => {
		let cache: { width: number; lines: string[] } | undefined;
		return {
			invalidate() { cache = undefined; },
			render(width: number) {
				if (cache?.width === width) return cache.lines;
				if (!frozen.has(entry.id)) {
					// Resumed entries freeze the current session too: the splash shows this session, now.
					const built = manager ? freezeSplash(getInteractiveModeForManager(manager), queryWaterfall(pi.events)?.rungs) : undefined;
					if (built) frozen.set(entry.id, built);
				}
				const snapshot = frozen.get(entry.id);
				const lines = snapshot ? renderFrozenSplash(snapshot, width, theme as StartupTheme) : [];
				if (snapshot) cache = { width, lines };
				return lines;
			},
		};
	});
	pi.on("session_start", (_event, ctx) => { manager = ctx.sessionManager; });
	pi.on("session_shutdown", () => { frozen.clear(); manager = undefined; });
	pi.registerCommand("splash", {
		description: "Show the startup splash (resources, context map and models) again in the transcript",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) return;
			manager = ctx.sessionManager;
			if (!getInteractiveModeForManager(ctx.sessionManager)) {
				ctx.ui.notify("The splash needs Pi's interactive mode.", "warning");
				return;
			}
			pi.appendEntry(SPLASH_ENTRY_TYPE, { version: 1 });
		},
	});
}
