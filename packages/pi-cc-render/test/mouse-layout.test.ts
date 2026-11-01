import { Container, HStack, ScrollView, TuiAltScreen, VStack, type Terminal } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fullscreenContentWidth, fullscreenLeafAt } from "../src/renderer/mouse/layout.ts";
import { installToolMouseInteraction, teardownToolMouseInteraction } from "../src/renderer/mouse/interaction.ts";

const terminal = { columns: 120, rows: 20, write: vi.fn() } as unknown as Terminal;
afterEach(() => teardownToolMouseInteraction());

describe("fullscreen dock mouse layout", () => {
	it("uses the actual leaf width for fixed docks and scroll content width for transcripts", () => {
		const transcript = new ScrollView({ render: () => ["transcript"], invalidate() {} }, { scrollbar: "always" });
		const footer = { render: () => ["footer"], invalidate() {} };
		const main = new VStack([{ component: transcript, basis: 0, grow: 1 }, { component: footer }]);
		const root = new HStack([{ component: main, basis: 70 }, { component: { render: () => ["sidebar"], invalidate() {} }, basis: 50 }]);
		const frame = renderLayoutFrame(root, 120, 20, () => {});
		const footerBox = fullscreenLeafAt(frame, 1, 19)!.box;
		const transcriptBox = fullscreenLeafAt(frame, 1, 0)!.box;
		expect(fullscreenContentWidth(footerBox, 120)).toBe(70);
		expect(fullscreenContentWidth(transcriptBox, 120)).toBe(69);
	});

	it.each([0, 3])("does not render footer or editor on press before native release %i", (release) => {
		let lastWidth = 0;
		const click = vi.fn();
		const footerChild = {
			render: vi.fn((width: number) => { lastWidth = width; return ["footer control"]; }),
			invalidate() {},
			handleMouse(event: any) {
				if (event.type === "click" && event.width === lastWidth) click();
				return { handled: true, render: false };
			},
		};
		const editorChild = { render: vi.fn(() => ["editor"]), invalidate() {} };
		const footer = new Container(); footer.addChild(footerChild);
		const editor = new Container(); editor.addChild(editorChild);
		const transcript = new ScrollView({ render: () => ["transcript"], invalidate() {} });
		const main = new VStack([{ component: transcript, basis: 0, grow: 1 }, { component: editor }, { component: footer }]);
		const root = new HStack([{ component: main, basis: 70 }, { component: { render: () => ["sidebar"], invalidate() {} }, basis: 50 }]);
		const frame = renderLayoutFrame(root, 120, 20, () => {});
		const tui = new TuiAltScreen(terminal) as any;
		tui.currentLayout = frame;
		const proxy = new Proxy(tui, { get(target, key) { const value = Reflect.get(target, key, target); return typeof value === "function" ? (...args: any[]) => value.apply(target, args) : value; }, set(target, key, value) { return Reflect.set(target, key, value, target); } });
		const ui = { setWidget: (_key: string, factory: any) => { if (factory) factory(proxy, {}); }, onTerminalInput: () => () => {} };
		installToolMouseInteraction({ mode: "tui", hasUI: true, ui });
		footerChild.render.mockClear(); editorChild.render.mockClear();
		tui.handleViewportInput("\x1b[<35;2;19M"); // idle hover over the editor
		tui.handleViewportInput("\x1b[<0;2;19M");
		tui.handleViewportInput("\x1b[<0;2;19m");
		expect(editorChild.render).not.toHaveBeenCalled();
		tui.handleViewportInput("\x1b[<0;2;20M");
		expect(footerChild.render).not.toHaveBeenCalled();
		expect(editorChild.render).not.toHaveBeenCalled();
		tui.handleViewportInput(`\x1b[<${release};2;20m`);
		expect(click).toHaveBeenCalledTimes(1);
		expect(lastWidth).toBe(70);
	});
});
