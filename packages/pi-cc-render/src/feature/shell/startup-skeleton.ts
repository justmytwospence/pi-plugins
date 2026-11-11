import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "../../config/config.ts";
import { querySystem1State } from "../../system1-contract.ts";
import { queryWaterfall } from "../../waterfall-contract.ts";
import { McpConfigCache } from "./mcp-servers.ts";
import { readStartupContext, type StartupContextSnapshot } from "./startup-context.ts";
import {
	collectMcpEntries,
	collectMcpSection,
	collectModelsSection,
	collectSections,
	isStartupSplashSettled,
	planSplashSections,
	renderSection,
	type ResourceSection,
	type StartupTheme,
} from "./startup-resources.ts";
import { renderContextTreemap } from "./startup-treemap.ts";

/**
 * A skeleton of the startup splash for the wait between Pi painting its TUI and the real listing mounting
 * (every extension's session_start). It shows what the resource loader already knows, in the splash's own
 * format, and shimmering placeholders for the rest. It renders nothing once the real listing is shown.
 */

let skeletonPi: ExtensionAPI | undefined;
const mcpCache = new McpConfigCache();

export function installStartupSkeleton(pi: ExtensionAPI): void {
	skeletonPi = pi;
}

const DOCK = ["editorContainer", "footerContainer", "statusContainer", "pendingMessagesContainer", "widgetContainerAbove", "widgetContainerBelow"];
const TICK_MS = 120;
const RECOLLECT_TICKS = 4;
const MAX_BAR = 48;
const BAND_RADIUS = 2;

type Data = {
	snapshot: StartupContextSnapshot;
	sections: Record<string, ResourceSection>;
	models?: ResourceSection;
	mapReady: boolean;
	outside: number;
};

const height = (node: any, width: number): number => {
	try { return typeof node?.render === "function" ? node.render(width).length : 0; } catch { return 0; }
};

/** One bar of `━`, one `fg` call per colour run; the highlight band sits at `band`. */
function shimmerBar(theme: StartupTheme, size: number, band: number): string {
	let out = "";
	let run = "";
	let bright: boolean | undefined;
	const flush = () => { if (run) out += theme.fg(bright ? "muted" : "dim", run); run = ""; };
	for (let i = 0; i < size; i++) {
		const on = Math.abs(i - band) <= BAND_RADIUS;
		if (on !== bright) { flush(); bright = on; }
		run += "━";
	}
	flush();
	return out;
}

export function createStartupSkeleton(mode: any | undefined, theme: StartupTheme): {
	render(width: number): string[];
	invalidate(): void;
	dispose(): void;
} {
	let timer: ReturnType<typeof setInterval> | undefined;
	let phase = 0;
	let data: Data | undefined;
	let dataStale = true;
	let dataWidth = -1;

	const visible = (): boolean =>
		!!mode && config.showStartupHeader && mode.shouldShowStartupDetails?.() === true && !isStartupSplashSettled(mode);

	const stop = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	const ensureTimer = () => {
		if (timer || mode.chatContainer?.children?.length || typeof mode.ui?.requestRender !== "function") return;
		timer = setInterval(() => {
			phase++;
			if (phase % RECOLLECT_TICKS === 0) dataStale = true;
			if (!visible()) stop();
			else mode.ui.requestRender();
		}, TICK_MS);
		(timer as { unref?: () => void }).unref?.();
	};

	const collect = (width: number): Data | undefined => {
		try {
			const snapshot = readStartupContext(mode);
			const sections = collectSections(mode, undefined, snapshot);
			const mcp = collectMcpSection(mode, collectMcpEntries(mode, mcpCache), new Map(), snapshot);
			if (mcp) sections.MCP = mcp;
			const waterfall = skeletonPi ? queryWaterfall(skeletonPi.events) : undefined;
			const models = waterfall
				? collectModelsSection(mode, [], waterfall, skeletonPi ? querySystem1State(skeletonPi.events)?.candidates : undefined)
				: undefined;
			const mapReady = snapshot.stage !== "initializing" && snapshot.toolDeclarationsKnown;
			const outside = height(mode.chatContainer, width) + DOCK.reduce((sum, name) => sum + height(mode[name], width), 0);
			return { snapshot, sections, models, mapReady, outside };
		} catch {
			return undefined;
		}
	};

	const placeholder = (title: string, width: number): string[] => {
		const size = Math.max(0, Math.min(width - 2, MAX_BAR));
		const band = timer ? (phase * 2) % (size + 10) - 5 : -100;
		return [` ${theme.fg("dim", title)}`, ` ${shimmerBar(theme, size, band)}`];
	};

	const layout = (width: number): string[] => {
		const current = data;
		const lines: string[] = [];
		const names = ["Extensions", "Context", "Skills", "Prompts", "MCP"] as const;
		const flexible: Record<string, ResourceSection> = {};
		for (const name of names) if (current?.sections[name]) flexible[name] = current.sections[name]!;
		if (current?.models) flexible.Models = current.models;
		const map = current?.mapReady ? renderContextTreemap(current.snapshot, width, theme) : placeholder("Starting context · loading…", width);
		const modelsPlaceholder = current?.models ? [] : placeholder("Models", width);
		// Spacers: one after each listed section, one between the map and Models.
		const listed = names.filter((name) => flexible[name]).length;
		const fixedRows = map.length + modelsPlaceholder.length + listed + 1;
		const rows = mode.ui?.terminal?.rows;
		const planned = !current || mode.getStartupExpansionState?.() || !Number.isFinite(rows)
			? flexible
			: planSplashSections(flexible, width, theme, Math.max(0, rows - current.outside - fixedRows));
		for (const name of names) {
			const section = planned[name];
			if (!section) continue;
			lines.push(...renderSection(section, width, theme), "");
		}
		lines.push(...map, "");
		lines.push(...(planned.Models ? renderSection(planned.Models, width, theme) : modelsPlaceholder));
		return lines;
	};

	return {
		render(width: number): string[] {
			if (!visible()) { stop(); return []; }
			if (width <= 1) return [];
			ensureTimer();
			if (dataStale || dataWidth !== width) {
				data = collect(width);
				dataStale = false;
				dataWidth = width;
			}
			return layout(width);
		},
		invalidate() { dataStale = true; },
		dispose() { stop(); },
	};
}
