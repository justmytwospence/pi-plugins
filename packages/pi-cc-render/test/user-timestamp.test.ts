import { afterEach, describe, expect, test } from "vitest";
import { UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../src/config/config.ts";
import { installUserTimestamps } from "../src/renderer/user-timestamp.ts";
import { setMessageDisplayTheme } from "../src/renderer/tool/message-display.ts";
import { setTimestampsEnabled } from "../src/transcript-style.ts";

const theme: any = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t };
const strip = (s: string) => s.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");

initTheme("dark");

describe("user prompt timestamps", () => {
	let dispose = () => {};
	afterEach(() => {
		dispose();
		config.showTimestamps = true;
		setTimestampsEnabled(true);
	});
	const render = (text: string, width: number, timestamp?: string) => {
		setMessageDisplayTheme(theme);
		dispose = installUserTimestamps();
		return new (UserMessageComponent as any)(text, undefined, 1, [], "id", timestamp).render(width) as string[];
	};

	for (const width of [46, 120, 180]) {
		test(`puts the time on the middle row at ${width} columns`, () => {
			const lines = render("hello", width, new Date(2026, 0, 2, 14, 14).toISOString());
			const plain = lines.map(strip);
			const stamped = plain.findIndex((l) => /\d:\d\d/.test(l));
			expect(stamped).toBeGreaterThan(0);
			expect(stamped).toBeLessThan(lines.length - 1);
			expect(plain[stamped]!.trimEnd().endsWith("M") || /\d:\d\d/.test(plain[stamped]!)).toBe(true);
			expect(visibleWidth(lines[stamped]!)).toBe(width);
		});
	}

	test("keeps the OSC 133 markers on the first and last rows", () => {
		const lines = render("hello", 120, new Date().toISOString());
		expect(lines[0]).toContain("\x1b]133;A\x07");
		expect(lines[lines.length - 1]).toContain("\x1b]133;B\x07");
	});

	test("falls back to the first-render time without a timestamp", () => {
		const lines = render("hello", 120);
		expect(lines.map(strip).some((l) => /\d:\d\d/.test(l))).toBe(true);
	});

	test("is absent when the text fills the row", () => {
		const lines = render("x".repeat(44), 46, new Date().toISOString());
		expect(lines.map(strip).some((l) => /\d:\d\d/.test(l))).toBe(false);
	});

	test("showTimestamps false disables it", () => {
		config.showTimestamps = false;
		setTimestampsEnabled(false);
		const lines = render("hello", 120, new Date().toISOString());
		expect(lines.map(strip).some((l) => /\d:\d\d/.test(l))).toBe(false);
	});
});
