import { describe, expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	Block,
	formatClock,
	isVisibleEntry,
	labelBlock,
	registerRowRun,
	rightLabel,
	rowLine,
	setTimestampsEnabled,
	toneOfTool,
} from "../src/transcript-style.ts";

const theme: any = {
	fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
	bg: (c: string, t: string) => `[${c}:${t}]`,
};
const strip = (s: string) => s.replace(/<\/?[a-zA-Z]+>/g, "").replace(/\[[a-zA-Z]+:/g, "").replace(/\]/g, "");

describe("formatClock", () => {
	const now = new Date(2026, 2, 10, 15, 0).getTime();
	const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	test("today is the time only", () => {
		const d = new Date(2026, 2, 10, 14, 14);
		expect(formatClock(d.getTime(), now)).toBe(time(d));
	});
	test("within six days adds the weekday", () => {
		const d = new Date(2026, 2, 7, 14, 14);
		expect(formatClock(d.getTime(), now)).toBe(`${d.toLocaleDateString(undefined, { weekday: "short" })} ${time(d)}`);
	});
	test("same year uses month and day", () => {
		const d = new Date(2026, 0, 3, 14, 14);
		expect(formatClock(d.toISOString(), now)).toContain(d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
		expect(formatClock(d.toISOString(), now)).not.toContain("2026");
	});
	test("an earlier year includes it", () => {
		expect(formatClock(new Date(2025, 2, 3, 9, 5).getTime(), now)).toContain("2025");
	});
	test("invalid input is undefined", () => {
		expect(formatClock("nope", now)).toBeUndefined();
		expect(formatClock(undefined, now)).toBeUndefined();
	});
});

describe("rightLabel / labelBlock", () => {
	test("right-aligns with one column of padding", () => {
		const out = rightLabel("hello" + " ".repeat(35), "2:14 PM", 40)!;
		expect(visibleWidth(out)).toBe(40);
		expect(out.endsWith("2:14 PM ")).toBe(true);
	});
	test("returns undefined without room", () => {
		expect(rightLabel("x".repeat(33) + "  ", "2:14 PM", 35)).toBeUndefined();
	});
	test("wraps filler and label in bg", () => {
		const out = rightLabel("a" + " ".repeat(39), "t", 40, { bg: (s) => `{${s}}` })!;
		expect(out).toMatch(/\{ +t \}$/);
	});
	const blank = (n: number, w = 40) => Array.from({ length: n }, () => " ".repeat(w));
	test("3 rows: row 1", () => {
		const out = labelBlock(blank(3), "x", 40, { skipEdges: true });
		expect(out[1]).toContain("x");
		expect(out[0]).not.toContain("x");
	});
	test("6 rows: row 2", () => {
		expect(labelBlock(blank(6), "x", 40, { skipEdges: true })[2]).toContain("x");
	});
	test("a full middle row falls back to the next row", () => {
		const lines = blank(6);
		lines[2] = "y".repeat(40);
		expect(labelBlock(lines, "x", 40, { skipEdges: true })[3]).toContain("x");
	});
	test("skipEdges never uses an edge and no room leaves lines unchanged", () => {
		const lines = [" ".repeat(40), "y".repeat(40), " ".repeat(40)];
		expect(labelBlock(lines, "x", 40, { skipEdges: true })).toEqual(lines);
	});
});

describe("rowLine / Block", () => {
	test("glyph colour follows the tone", () => {
		expect(rowLine(theme, { tone: "failed", title: "t" }, 80)).toContain("<error>✗</error>");
		expect(rowLine(theme, { tone: "done", title: "t" }, 80)).toContain("<success>✓</success>");
	});
	test("time shows at 260 (tag-inflated) and is omitted when content is long at 46", () => {
		setTimestampsEnabled(true);
		const time = new Date().getTime();
		const spec = { tone: "info" as const, title: "Title", detail: "d".repeat(36), time };
		expect(strip(rowLine(theme, spec, 260))).toMatch(/\d:\d\d/);
		expect(strip(rowLine(theme, spec, 46))).not.toMatch(/\d:\d\d/);
	});
	test("block background follows the tone and folds with a hint", () => {
		const body = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n\n");
		const lines = new Block(theme, () => ({ tone: "done", title: "T", body, fold: 3 })).render(60);
		expect(lines[0]).toContain("toolSuccessBg");
		expect(strip(lines.join("\n"))).toContain("more line");
	});
});

describe("registerRowRun", () => {
	function fake() {
		const branch: any[] = [];
		const handlers: Record<string, Function> = {};
		let renderer: any;
		let n = 0;
		const pi: any = {
			registerEntryRenderer: (_t: string, r: any) => (renderer = r),
			on: (e: string, h: Function) => (handlers[e] = h),
			appendEntry: (customType: string, data: any) =>
				branch.push({ id: `e${n++}`, type: "custom", customType, data, timestamp: new Date().toISOString() }),
		};
		const ctx: any = { sessionManager: { getBranch: () => branch } };
		return { pi, ctx, branch, handlers, renderer: () => renderer };
	}
	const make = (f: ReturnType<typeof fake>, type: string) =>
		registerRowRun<{ n: number }>(f.pi, {
			anchorType: type,
			stateType: `${type}:state`,
			sameRun: () => true,
			merge: (a, b) => ({ n: a.n + b.n }),
			render: (s) => ({ invalidate() {}, render: () => [`n=${s.data.n}`] }),
		});
	test("a repeat updates the anchor instead of adding a row", () => {
		const f = fake();
		const run = make(f, "t1");
		run.append(f.ctx, { n: 1 });
		run.append(f.ctx, { n: 2 });
		expect(f.branch.map((e) => e.customType)).toEqual(["t1", "t1:state"]);
		expect(f.renderer()(f.branch[0], {}, theme).render(10)).toEqual(["n=3"]);
	});
	test("a visible entry in between starts a new anchor; an invisible one does not", () => {
		const f = fake();
		const run = make(f, "t2");
		run.append(f.ctx, { n: 1 });
		f.branch.push({ id: "u", type: "custom", customType: "other", data: {} });
		run.append(f.ctx, { n: 1 });
		expect(f.branch.filter((e) => e.customType === "t2")).toHaveLength(1);
		f.branch.push({ id: "m", type: "message" });
		run.append(f.ctx, { n: 1 });
		expect(f.branch.filter((e) => e.customType === "t2")).toHaveLength(2);
		expect(isVisibleEntry({ type: "usage" })).toBe(false);
	});
	test("session_start rebuilds the journal", () => {
		const f = fake();
		const run = make(f, "t3");
		run.append(f.ctx, { n: 1 });
		run.append(f.ctx, { n: 4 });
		f.handlers.session_start!({}, f.ctx);
		expect(f.renderer()(f.branch[0], {}, theme).render(10)).toEqual(["n=5"]);
	});
});

describe("toneOfTool", () => {
	test("orders error, done, running, attention", () => {
		expect(toneOfTool({ isError: true }, true)).toBe("failed");
		expect(toneOfTool({ isPartial: false }, true)).toBe("done");
		expect(toneOfTool({ executionStarted: true, isPartial: true }, false)).toBe("running");
		expect(toneOfTool({}, false)).toBe("attention");
	});
});
