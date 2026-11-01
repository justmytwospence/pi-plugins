import { describe, expect, it } from "vitest";
import { backgroundAnsi, foregroundAnsi, mixColors, parseColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { capacitySegments, categoryShareBlocks, layoutContextTreemap, renderContextTreemap } from "../src/feature/shell/startup-treemap.ts";
import { categoryBlockStyle, categoryStyle } from "../src/feature/shell/startup-style.ts";
import { ESTIMATE_CAVEAT, type ContextSource, type StartupContextSnapshot } from "../src/feature/shell/startup-context.ts";

const source = (id: string, tokens: number, category: ContextSource["category"] = "files"): ContextSource => ({ id, label: id, category, tokens });
const snapshot = (sources: ContextSource[], contextWindow?: number): StartupContextSnapshot => ({
	stage: "starting", modelLabel: "p/m", contextWindow, usedEstimate: sources.reduce((sum, item) => sum + item.tokens, 0), sources,
	attribution: { files: true, skills: true }, caveats: [ESTIMATE_CAVEAT],
});
const theme = (name: string) => ({
	fg: (_token: string, text: string) => text,
	colors: {
		mdLink: parseColor(name === "dark" ? "#4488cc" : "#224488"),
		accent: parseColor(name === "dark" ? "#5588bb" : "#224488"),
		customMessageLabel: parseColor(name === "dark" ? "#aa77cc" : "#663399"),
		syntaxNumber: parseColor(name === "dark" ? "#cc8844" : "#884422"),
		syntaxKeyword: parseColor(name === "dark" ? "#aa66cc" : "#663388"),
		muted: parseColor(name === "dark" ? "#999999" : "#777777"),
		dim: parseColor(name === "dark" ? "#666666" : "#999999"),
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
	it("allocates exact cumulative category cells to leading sources and aggregates small ones", () => {
		const files = source("files", 1000);
		const tile = { x: 0, y: 0, width: 100, height: 1, source: files };
		const children = [source("first", 620), source("second", 240), source("third", 140)];
		expect(categoryShareBlocks([{ ...files, children }], tile)).toEqual([
			{ kind: "first", start: 0, width: 62, tokens: 620 },
			{ kind: "second", start: 62, width: 24, tokens: 240 },
			{ kind: "remainder", start: 86, width: 14, tokens: 140 },
		]);
		const split = [source("a", 500), source("b", 480), source("tiny", 20)];
		expect(categoryShareBlocks([{ ...files, children: split }], { ...tile, width: 60 })).toEqual([
			{ kind: "first", start: 0, width: 30, tokens: 500 },
			{ kind: "second", start: 30, width: 29, tokens: 480 },
			{ kind: "remainder", start: 59, width: 1, tokens: 20 },
		]);
		const small = [source("first", 940), source("second", 35), source("third", 25)];
		expect(categoryShareBlocks([{ ...files, children: small }], { ...tile, width: 60 })).toEqual([
			{ kind: "first", start: 0, width: 56, tokens: 940 },
			{ kind: "remainder", start: 56, width: 4, tokens: 60 },
		]);
		const balanced = Array.from({ length: 10 }, (_, i) => source(`tool${i}`, 100));
		expect(categoryShareBlocks([{ ...files, children: balanced }], { ...tile, width: 60 })).toEqual([
			{ kind: "first", start: 0, width: 6, tokens: 100 },
			{ kind: "second", start: 6, width: 6, tokens: 100 },
			{ kind: "remainder", start: 12, width: 48, tokens: 800 },
		]);
		expect(categoryShareBlocks([source("only", 1000)], { ...tile, width: 3 })).toEqual([{ kind: "first", start: 0, width: 3, tokens: 1000 }]);
		// Cumulative rounding can give a source an extra cell; it cannot give a small source an invented four-cell shade.
		for (let width = 1; width <= 180; width++) {
			const blocks = categoryShareBlocks([{ ...files, children: split }], { ...tile, width });
			expect(blocks.reduce((sum, block) => sum + block.width, 0)).toBe(width);
			if (blocks.at(-1)?.kind === "remainder") expect(blocks.reduce((sum, block) => sum + block.tokens, 0)).toBe(1000);
			for (const [index, block] of blocks.entries()) {
				expect(block.start).toBe(blocks.slice(0, index).reduce((sum, previous) => sum + previous.width, 0));
				if (block.kind !== "remainder") expect(block.width).toBeGreaterThanOrEqual(4);
			}
		}
	});
	it("paints three current-theme tints with category-relative labels at dark/light client widths", () => {
		const files = { ...source("files", 1000), children: [source("a", 620), source("b", 240), source("c", 140)] };
		for (const name of ["dark", "light"]) {
			const current = theme(name);
			for (const [kind, blend] of [["first", 0.08], ["second", 0.45], ["remainder", 0.78]] as const) {
				const tint = mixColors(current.colors.mdLink, current.colors.userMessageBg, blend);
				const painted = categoryBlockStyle(current, "files", kind)!("  62%  ");
				expect(painted).toContain(backgroundAnsi(tint, "truecolor"));
				// The saturated leading tint needs the dark background as text; pale tints need normal text.
				expect(painted).toContain(foregroundAnsi(kind === "first" ? current.colors.userMessageBg : current.colors.text, "truecolor"));
			}
			for (const width of [46, 120, 180]) {
				const lines = renderContextTreemap(snapshot([files], 200_000), width, current);
				const strip = stripTerminalSequences(lines[2]!);
				expect(strip).toContain("62%");
				expect(strip).toContain("24%");
				expect(strip).toContain("14%");
				expect(lines[2]!.match(/\x1b\[48;2;/g)).toHaveLength(3);
				expect(lines[2]).not.toContain("█");
				expect(lines[2]).not.toContain("┃");
				expect(visibleWidth(lines[2]!)).toBe(width);
			}
			const modified = { ...current, colors: { ...current.colors, mdLink: parseColor("#b63030") } };
			expect(categoryBlockStyle(modified, "files", "first")!("x")).not.toBe(categoryBlockStyle(current, "files", "first")!("x"));
		}
	});
	it("keeps category labels, keys, estimates and server-level MCP shares without extra rows", () => {
		const joined = "\u{1F469}\u200D\u{1F4BB}".repeat(6);
		const sources: ContextSource[] = [
			{ id: "files", category: "files", label: "Files", tokens: 6500, children: [source(joined, 4800), source("e\u0301".repeat(6), 1700)] },
			source("system", 3300, "system"), source("skills", 1900, "skills"), source("tools", 6300, "tools"),
		];
		const lines = renderContextTreemap(snapshot(sources, 1_048_576), 120, theme("light"));
		const label = stripTerminalSequences(lines[1]!);
		for (const name of ["Files", "System", "Tools"]) expect(label).toContain(name);
		expect(lines.join("\n")).toContain("Skills ~1.9k");
		expect(lines[0]).toContain("2% of 1M (~18k)");
		expect(lines.join("\n")).not.toContain("Capacity ·");
		expect(lines.join("\n")).not.toContain("Sources ·");
		expect(lines.slice(1, 3)).toHaveLength(2);
		expect(lines[2]).toContain("\x1b[48;2;");
		expect(lines.join("\n")).not.toContain(joined);
		const manyMcp = [source("one", 700, "mcp"), source("two", 300, "mcp")];
		const mcpTile = renderContextTreemap(snapshot(manyMcp, 200_000), 46, theme("dark"));
		expect(stripTerminalSequences(mcpTile[1]!)).toContain("MCP");
		expect(stripTerminalSequences(mcpTile[2]!)).toContain("70%");
		expect(stripTerminalSequences(mcpTile[2]!)).toContain("30%");
		const mcp = [
			{ ...source("large server", 700, "mcp"), children: [source("a", 350, "mcp"), source("b", 350, "mcp")] },
			{ ...source("small server", 300, "mcp"), children: [source("c", 300, "mcp")] },
		];
		expect(categoryShareBlocks([mcp[0]!], { x: 0, y: 0, width: 10, height: 1, source: source("mcp", 700, "mcp") }))
			.toEqual([{ kind: "first", start: 0, width: 10, tokens: 700 }]);
		expect(categoryShareBlocks(mcp, { x: 0, y: 0, width: 60, height: 1, source: source("mcp", 1000, "mcp") })).toEqual([
			{ kind: "first", start: 0, width: 42, tokens: 700 }, { kind: "second", start: 42, width: 18, tokens: 300 },
		]);
		const narrow = renderContextTreemap(snapshot(sources, 200_000), 24, theme("light"));
		expect(narrow.join("\n")).toContain("Skills ~1.9k");
		expect(narrow.every((line) => visibleWidth(line) <= 24)).toBe(true);
		const noBar = renderContextTreemap(snapshot(sources, 200_000), 23, theme("light"));
		expect(noBar.join("\n")).toContain("Skills ~1.9k");
		expect(noBar.every((line) => !line.includes("\x1b[48;"))).toBe(true);
	});
	it("labels the small-category line as a key for the bar rather than another context cost", () => {
		const sources = [source("mcp", 8800, "mcp"), source("tools", 7700, "tools"),
			source("files", 6500), source("system", 3300, "system"), source("skills", 1900, "skills")];
		const lines = renderContextTreemap(snapshot(sources, 1_048_576), 100, theme("dark")).map(stripTerminalSequences);
		expect(lines).toHaveLength(4); // summary, category labels, strip, and its existing key
		expect(lines[3]).toMatch(/^Small category totals: ■ System ~3\.3k  ■ Skills ~1\.9k$/);
		const narrow = renderContextTreemap(snapshot(sources, 1_048_576), 46, theme("dark")).map(stripTerminalSequences);
		expect(narrow.join("\n")).toContain("Key: ■");
		expect(narrow.every((line) => visibleWidth(line) <= 46)).toBe(true);
	});
	it("omits percent text unless its own block has two padding cells", () => {
		const files = { ...source("files", 100), children: [source("first", 70), source("second", 30)] };
		const narrow = renderContextTreemap(snapshot([source("system", 300, "system"), files], 200_000), 24, theme("dark"));
		// Files occupies six cells: its four-cell first block cannot fit "70%" plus two padding cells.
		expect(stripTerminalSequences(narrow[2]!)).not.toContain("70%");
		expect(stripTerminalSequences(narrow[2]!)).not.toContain("30%");
		const crowded = { ...source("files", 100), children: [source("first", 75), source("second", 25)] };
		const lines = renderContextTreemap(snapshot([source("system", 200, "system"), crowded], 200_000), 24, theme("light"));
		expect(stripTerminalSequences(lines[2]!)).toContain("75%");
		expect(stripTerminalSequences(lines[2]!)).not.toContain("25%");
		expect(visibleWidth(lines[2]!)).toBe(24);
		const tile = { x: 0, y: 0, width: 8, height: 1, source: source("files", 100) };
		expect(categoryShareBlocks([crowded], tile)).toEqual([
			{ kind: "first", start: 0, width: 6, tokens: 75 }, { kind: "remainder", start: 6, width: 2, tokens: 25 },
		]);
	});
	it("falls back to contrasting category-colored glyphs when concrete theme colors are missing", () => {
		const files = { ...source("files", 1000), children: [source("a", 500), source("b", 480), source("tiny", 20)] };
		for (const current of [
			{ fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m` },
			{ ...theme("light"), colors: { mdLink: parseColor("#999999"), text: parseColor("#111111") } },
		]) {
			expect(categoryBlockStyle(current, "files", "first")).toBeUndefined();
			const lines = renderContextTreemap(snapshot([files], 200_000), 60, current);
			expect(stripTerminalSequences(lines[2]!)).toMatch(/█{30}▓{29}░/);
			expect(lines[2]).not.toContain("\x1b[48;");
			expect(visibleWidth(lines[2]!)).toBe(60);
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
		const detailed = renderContextTreemap({ ...snapshot(sources, 200), thinkingLevel: "xhigh", caveats: [ESTIMATE_CAVEAT, "window unknown"] }, 120, theme("dark"));
		expect(detailed[0]).toContain("p/m:xhigh");
		const narrowModel = renderContextTreemap({ ...snapshot(sources, 200), modelLabel: "anthropic/claude-opus-5-5", thinkingLevel: "xhigh" }, 46, theme("dark"));
		expect(narrowModel[0]).toMatch(/Start.*250%\/200.*claude-opus-5-5:xhigh/);
		expect(detailed.join("\n")).not.toContain(ESTIMATE_CAVEAT);
		expect(detailed.join("\n")).toContain("window unknown");
		const initial = renderContextTreemap({ ...snapshot([], undefined), stage: "initializing" }, 12, theme("light"));
		expect(initial).toHaveLength(1);
	});
});
