import { describe, expect, it } from "vitest";
import { backgroundAnsi, mixColors, parseColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { capacitySegments, layoutContextTreemap, renderContextTreemap } from "../src/feature/shell/startup-treemap.ts";
import { categoryStyle } from "../src/feature/shell/startup-style.ts";
import type { ContextSource, StartupContextSnapshot } from "../src/feature/shell/startup-context.ts";

const source = (id: string, tokens: number, category: ContextSource["category"] = "files"): ContextSource => ({ id, label: id, category, tokens });
const snapshot = (sources: ContextSource[], contextWindow?: number): StartupContextSnapshot => ({
	stage: "starting", modelLabel: "p/m", contextWindow, usedEstimate: sources.reduce((sum, item) => sum + item.tokens, 0), sources,
	attribution: { files: true, skills: true }, caveats: ["Estimated from loaded content; request hooks and provider framing may add tokens."],
});
const theme = (name: string) => ({
	fg: (_token: string, text: string) => text,
	colors: {
		mdLink: parseColor(name === "dark" ? "#4488cc" : "#224488"),
		userMessageBg: parseColor(name === "dark" ? "#111111" : "#eeeeee"),
		text: parseColor(name === "dark" ? "#eeeeee" : "#111111"),
	},
	getColorMode: () => "truecolor" as const,
});

describe("context treemap", () => {
	it("returns deterministic disjoint integer rectangles bounded by the viewport", () => {
		for (const sources of [[], [source("one", 9)], [source("a", 9999), source("b", 1), source("c", 1)], Array.from({ length: 30 }, (_, i) => source(`s${i}`, i + 1))]) {
			for (const [width, height] of [[0, 4], [1, 1], [12, 2], [46, 4]] as const) {
				const tiles = layoutContextTreemap(sources, width, height);
				expect(tiles).toEqual(layoutContextTreemap([...sources].reverse(), width, height));
				const cells = new Set<string>();
				for (const tile of tiles) {
					expect(tile.width).toBeGreaterThan(0);
					expect(tile.height).toBeGreaterThan(0);
					for (let y = tile.y; y < tile.y + tile.height; y++) for (let x = tile.x; x < tile.x + tile.width; x++) {
						expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(width);
						expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(height);
						expect(cells.has(`${x},${y}`)).toBe(false); cells.add(`${x},${y}`);
					}
				}
			}
		}
	});
	it("omits sub-cell geometry without dropping its category from the key or estimated total", () => {
		const sources = [source("system", 9_999, "system"), source("tools", 1, "tools")];
		const tiles = layoutContextTreemap(sources, 12, 2);
		expect(tiles.map((tile) => tile.source.category)).toEqual(["system"]);
		expect(tiles[0]).toMatchObject({ x: 0, y: 0, width: 12, height: 2 });
		const lines = renderContextTreemap(snapshot(sources, 10_000), 12, theme("dark"));
		expect(lines[0]).toContain("~10k");
		expect(lines.join("\n")).toContain("Tools ~1");
	});
	it("draws no fake minimum occupied segment at 200K, 922K, 1M, or unknown capacities", () => {
		for (const window of [200_000, 922_000, 1_048_576]) {
			const result = capacitySegments(snapshot([source("tiny", 1)], window), 46);
			expect(result).toEqual([{ width: 46 }]);
			const half = capacitySegments(snapshot([source("half", window / 2)], window), 46);
			expect(half.reduce((sum, item) => sum + item.width, 0)).toBe(46);
			expect(half[0]?.width).toBe(23);
		}
		expect(capacitySegments(snapshot([source("a", 1)]), 46)).toEqual([]);
		expect(capacitySegments(snapshot([source("a", 250)], 100), 100)).toEqual([{ category: "files", width: 100 }]);
	});
	it("shows one compact context summary and colored categories with meaningful internal splits", () => {
		const joined = "\u{1F469}\u200D\u{1F4BB}".repeat(6);
		const sources: ContextSource[] = [
			{ id: "files", category: "files", label: "Files", tokens: 6500, children: [source(joined, 4800), source("e\u0301".repeat(6), 1700)] },
			source("system", 3300, "system"),
			source("skills", 1900, "skills"),
			source("tools", 6300, "tools"),
		];
		const lines = renderContextTreemap(snapshot(sources, 1_048_576), 120, theme("light"));
		const tiles = lines.slice(1, 3).map(stripTerminalSequences).join("\n");
		for (const label of ["Files", "System", "Skills", "Tools"]) expect(tiles).toContain(label);
		expect(tiles).toContain("│");
		expect(tiles).not.toContain(joined);
		expect(lines[0]).toContain("2% of 1M (~18k)");
		expect(lines.join("\n")).not.toContain("Capacity ·");
		expect(lines.join("\n")).not.toContain("Sources ·");
		expect(lines.slice(1, 3)).toHaveLength(2);
		expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
		const medium = renderContextTreemap(snapshot(sources, 1_048_576), 100, theme("light"));
		for (const label of ["Files", "System", "Skills", "Tools"]) {
			expect(medium.slice(1, 3).map(stripTerminalSequences).join("\n")).toContain(label);
		}
		expect(medium.every((line) => visibleWidth(line) <= 100)).toBe(true);
		const manyMcp = [source("one", 700, "mcp"), source("two", 300, "mcp")];
		const mcpTile = stripTerminalSequences(renderContextTreemap(snapshot(manyMcp, 200_000), 46, theme("dark"))[1]!);
		expect(mcpTile).toContain("MCP");
		expect(mcpTile).not.toContain("one");
		expect(mcpTile).not.toContain("two");
		const childSplit = { ...snapshot([{ id: "files", label: "Files", category: "files" as const, tokens: 1000, children: [source("a", 500), source("b", 480), source("too small", 20)] }], 200_000) };
		const split = renderContextTreemap(childSplit, 60, theme("light"))[2]!;
		expect(stripTerminalSequences(split).match(/│/g)).toHaveLength(1);
		expect(split.indexOf("│")).toBeGreaterThan(split.indexOf("\x1b[48;2"));
		expect(split.indexOf("│")).toBeLessThan(split.lastIndexOf("\x1b[0m"));
		const tiny = renderContextTreemap(snapshot([{ id: "files", label: "Files", category: "files", tokens: 1000, children: [source("a", 990), source("tiny one", 5), source("tiny two", 5)] }], 200_000), 60, theme("light"));
		expect(stripTerminalSequences(tiny[2]!)).not.toContain("│");
		const narrow = renderContextTreemap(snapshot(sources, 200_000), 24, theme("light"));
		expect(narrow.join("\n")).toContain("Skills ~1.9k");
		expect(narrow.every((line) => visibleWidth(line) <= 24)).toBe(true);
	});
	it("uses stronger themed color on both light and dark; style rebuilds after theme changes", () => {
		for (const name of ["dark", "light"]) {
			const current = theme(name);
			const style = categoryStyle(current, "files");
			expect(style.fill("x")).toContain(backgroundAnsi(mixColors(current.colors.userMessageBg, current.colors.mdLink, 0.35), "truecolor"));
			expect(style.swatch("■")).toContain("■");
			expect(style.fill("x")).not.toBe(categoryStyle(theme(name === "dark" ? "light" : "dark"), "files").fill("x"));
		}
	});
	it("renders narrow fallback, occupancy map, overage and bounded wide/ANSI labels", () => {
		const sources = [source("寬界 context", 300, "system"), source("file", 200, "files")];
		for (const width of [12, 23, 24, 25, 46, 120, 180]) {
			const lines = renderContextTreemap(snapshot(sources, 200), width, theme("dark"));
			expect(lines[0]).toContain("250%");
			expect(lines.filter((line) => visibleWidth(line) > width).map((line) => ({ width, length: visibleWidth(line), line }))).toEqual([]);
			expect(lines.join("\n").includes("over by")).toBe(false); // Caveats are supplied by collector, not inferred during rendering.
			if (width >= 24) expect(lines.join("\n")).not.toContain("Sources · occupied context");
		}
		for (let width = 1; width <= 200; width++) {
			const lines = renderContextTreemap(snapshot(sources, 200), width, theme("dark"));
			expect(lines.every((line) => visibleWidth(line) <= width), `width ${width}`).toBe(true);
		}
		const initial = renderContextTreemap({ ...snapshot([], undefined), stage: "initializing" }, 12, theme("light"));
		expect(initial).toHaveLength(1);
	});
});
