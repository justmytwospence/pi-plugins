import {
	getKeybindings,
	KeybindingsManager,
	matchesKey,
	ScrollView,
	setKeybindings,
	TUI_KEYBINDINGS,
	TuiAltScreen,
	VStack,
	type Component,
	type Terminal,
} from "@earendil-works/pi-tui";
// Use the SDK's actual empty-target Proxy, not a Proxy around the renderer.
// This SDK calls the internal reference module tui-renderer.js.
import { createInteractiveTuiReference } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, setConfig } from "../src/config/config.ts";
import {
	installToolMouseInteraction,
	teardownToolMouseInteraction,
} from "../src/renderer/mouse/interaction.ts";

const CTRL_U = "\x15";
const CTRL_D = "\x04";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const WHEEL_UP = "\x1b[<64;2;2M";
const WHEEL_DOWN = "\x1b[<65;2;2M";
const MOUSE_PRESS = "\x1b[<0;2;2M";
const savedConfig = { ...config };
const savedKeybindings = getKeybindings();
const renderers: Renderer[] = [];

type ViewportHandler = (this: Renderer, data: string) => unknown;
// Access only private SDK state needed to exercise the public installation API.
// Pick retains the public surface without intersecting the SDK's private handler.
type Renderer = Pick<TuiAltScreen, keyof TuiAltScreen> & {
	handleViewportInput: ViewportHandler;
	wheelScrollLines: number;
};
type Widget = Component;

beforeEach(() => {
	setConfig({ ...savedConfig, mode: "on", scrollStepLines: 3 });
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.altScreen.halfPageUp": "ctrl+u",
		"tui.altScreen.halfPageDown": "ctrl+d",
		"tui.altScreen.lineUp": "ctrl+b",
	}));
});

afterEach(() => {
	try {
		teardownToolMouseInteraction();
	} finally {
		vi.restoreAllMocks();
		for (const renderer of renderers.splice(0)) renderer.stop();
		setKeybindings(savedKeybindings);
		setConfig(savedConfig);
	}
});

function createRenderer() {
	let input: ((data: string) => void) | undefined;
	const terminal: Terminal = {
		columns: 120, rows: 20, kittyProtocolActive: false,
		start(onInput) { input = onInput; },
		stop() { input = undefined; },
		async drainInput() {},
		write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {},
		setTitle() {}, setProgress() {}, setProgramStatus() {},
	};
	const checkpointInput = vi.fn<(data: string) => void>();
	const editor = { render: () => ["editor"], invalidate() {}, handleInput: checkpointInput };
	const transcript = new ScrollView({
		render: () => Array.from({ length: 120 }, (_, index) => `transcript ${index}`),
		invalidate() {},
	}, { primary: true, scrollbar: "hidden" });
	const tui = new TuiAltScreen(terminal, false, undefined, { wheelScrollLines: 1 }) as unknown as Renderer;
	renderers.push(tui);
	tui.setLayoutRoot(new VStack([
		{ component: transcript, basis: 0, grow: 1 },
		{ component: editor },
	]));
	tui.setFocus(editor);
	tui.start();
	tui.renderNow();
	transcript.scrollTo(40);
	tui.renderNow();
	return {
		tui, transcript, editor, checkpointInput,
		send(data: string) {
			expect(input, "TuiAltScreen.start must supply the real terminal input callback").toBeTypeOf("function");
			input!(data);
			tui.renderNow();
		},
	};
}

function createHost(initial: Renderer, refuseReceiverProbe = false) {
	let current = initial;
	const reference = createInteractiveTuiReference(() => current as unknown as TuiAltScreen);
	const proxy = refuseReceiverProbe ? new Proxy(reference, {
		set(target, property, value) {
			if (typeof property === "symbol" && property.description === "pi-plugins.tui-receiver") return false;
			return Reflect.set(target, property, value);
		},
	}) : reference;
	let widget: Widget | undefined;
	const ui = {
		setWidget(_key: string, factory: ((tui: unknown, theme: unknown) => Widget) | undefined) {
			widget = factory?.(proxy, {});
		},
		onTerminalInput(listener: Parameters<TuiAltScreen["addInputListener"]>[0]) {
			return current.addInputListener(listener);
		},
	};
	return {
		proxy,
		install() { installToolMouseInteraction({ mode: "tui", hasUI: true, ui }); },
		renderWidget() {
			expect(widget).toBeDefined();
			widget!.render(120);
		},
		replace(renderer: Renderer) { current = renderer; },
	};
}

/** The editor reserves Ctrl+U/D; the SDK's earlier viewport listener must decline them. */
function installEditorGuard(tui: Renderer, editor: Component): ViewportHandler {
	const original = tui.handleViewportInput;
	const guard: ViewportHandler = function (data) {
		if (this.getFocusedComponent() === editor && (matchesKey(data, "ctrl+u") || matchesKey(data, "ctrl+d"))) {
			return undefined;
		}
		return Reflect.apply(original, this, [data]);
	};
	Object.defineProperty(tui, "handleViewportInput", {
		configurable: true, enumerable: false, writable: true, value: guard,
	});
	return guard;
}

function viewportMarker(tui: Renderer): symbol {
	const marker = Object.getOwnPropertySymbols(tui).find(
		(key) => key.description === "ccstyle.fullscreen-viewport-patch",
	);
	expect(marker, "the compatibility marker must live on the resolved renderer").toBeDefined();
	return marker!;
}

/** Older SDKs expose this numeric property; current SDKs use the real accelerator's setter. */
function exposeWheelSetting(tui: Renderer, original: number): void {
	Object.defineProperty(tui, "wheelScrollLines", {
		configurable: true,
		get(this: any) { return this.wheelScroll.lines; },
		set(this: TuiAltScreen, lines: number) { this.setWheelScrollLines(lines); },
	});
	tui.wheelScrollLines = original;
}

describe("fullscreen viewport input through the SDK stable reference", () => {
	it("fails closed when a Proxy refuses receiver resolution", () => {
		const { tui, transcript, editor, checkpointInput, send } = createRenderer();
		const guard = installEditorGuard(tui, editor);
		const host = createHost(tui, true);
		host.install();
		host.renderWidget();
		expect(tui.handleViewportInput).toBe(guard);
		expect(Object.getOwnPropertySymbols(tui).filter(key =>
			key.description === "pi-plugins.tui-receiver" || key.description === "ccstyle.fullscreen-viewport-patch",
		)).toEqual([]);
		const top = transcript.scrollTop;
		send(CTRL_U);
		expect(transcript.scrollTop).toBe(top);
		expect(checkpointInput).toHaveBeenLastCalledWith(CTRL_U);
	});
	it.each(["before", "after"] as const)("preserves an editor guard installed %s CC without stealing native navigation", (order) => {
		const { tui, transcript, editor, checkpointInput, send } = createRenderer();
		const host = createHost(tui);
		// Prove these really conflict in the SDK, without stubbing its viewport handler.
		const start = transcript.scrollTop;
		send(CTRL_U);
		expect(transcript.scrollTop).toBe(start - Math.floor(transcript.viewportHeight / 2));
		send(CTRL_D);
		expect(transcript.scrollTop).toBe(start);
		expect(checkpointInput).not.toHaveBeenCalled();

		if (order === "before") installEditorGuard(tui, editor);
		host.install();
		if (order === "after") installEditorGuard(tui, editor);
		host.renderWidget();
		send(CTRL_U);
		send(CTRL_D);
		expect(checkpointInput.mock.calls).toEqual([[CTRL_U], [CTRL_D]]);
		expect(transcript.scrollTop).toBe(start);

		send(PAGE_UP);
		expect(transcript.scrollTop).toBe(start - (transcript.viewportHeight - 4));
		send(PAGE_DOWN);
		expect(transcript.scrollTop).toBe(start);
		send(WHEEL_UP);
		expect(transcript.scrollTop).toBe(start - 1);
		send(WHEEL_DOWN);
		expect(transcript.scrollTop).toBe(start);
		send("\x02"); // Unreserved Ctrl+B remains a configured native line-up binding.
		expect(transcript.scrollTop).toBe(start - 1);
		send("x");
		expect(checkpointInput.mock.calls).toEqual([[CTRL_U], [CTRL_D], ["x"]]);
	});

	it("restores an absent own handler on the renderer, not the empty proxy target", () => {
		const { tui } = createRenderer();
		const original = tui.handleViewportInput;
		const host = createHost(tui);
		expect(Object.getOwnPropertyDescriptor(tui, "handleViewportInput")).toBeUndefined();
		host.install();
		expect(tui.handleViewportInput).not.toBe(original);
		expect(Reflect.ownKeys(host.proxy)).toEqual([]);
		expect(Object.getOwnPropertyDescriptor(host.proxy, "handleViewportInput")).toBeUndefined();
		const marker = viewportMarker(tui);
		expect(Reflect.get(tui, marker)).toBe(true);
		host.renderWidget();
		teardownToolMouseInteraction();
		expect(Object.getOwnPropertyDescriptor(tui, "handleViewportInput")).toBeUndefined();
		expect(tui.handleViewportInput).toBe(original);
		expect(Reflect.get(tui, marker)).toBe(false);
	});

	it.each(["data", "accessor"] as const)("restores the exact prior own %s descriptor and its current handler", (kind) => {
		const { tui, editor, checkpointInput, send } = createRenderer();
		const original = installEditorGuard(tui, editor);
		const descriptor: PropertyDescriptor = kind === "data"
			? { configurable: true, enumerable: true, writable: false, value: original }
			: { configurable: true, enumerable: false, get: () => original, set: vi.fn() };
		Object.defineProperty(tui, "handleViewportInput", descriptor);
		const host = createHost(tui);
		host.install();
		expect(tui.handleViewportInput).not.toBe(original);
		send(CTRL_U);
		expect(checkpointInput.mock.calls).toEqual([[CTRL_U]]);
		teardownToolMouseInteraction();
		expect(Object.getOwnPropertyDescriptor(tui, "handleViewportInput")).toEqual(descriptor);
		expect(tui.handleViewportInput).toBe(original);
	});

	it("preserves a newer wrapper and makes its buried CC wrapper inert even for mouse packets", () => {
		const { tui } = createRenderer();
		const result = { data: "downstream" };
		const original = vi.fn(function (this: TuiAltScreen, _data: string) { return result; });
		tui.handleViewportInput = original;
		const host = createHost(tui);
		host.install();
		const cc = tui.handleViewportInput;
		const newer = vi.fn(function (this: TuiAltScreen, data: string) {
			return Reflect.apply(cc, this, [data]);
		});
		tui.handleViewportInput = newer;
		const descriptor = Object.getOwnPropertyDescriptor(tui, "handleViewportInput");
		teardownToolMouseInteraction();
		expect(Object.getOwnPropertyDescriptor(tui, "handleViewportInput")).toEqual(descriptor);
		expect(tui.handleViewportInput).toBe(newer);
		const layout = vi.spyOn(tui as any, "currentLayout", "get");
		// A mouse press would consult layout before delegating if the buried patch stayed active.
		expect(tui.handleViewportInput(MOUSE_PRESS)).toBe(result);
		expect(tui.handleViewportInput(CTRL_U)).toBe(result);
		expect(layout).not.toHaveBeenCalled();
		expect(original.mock.calls).toEqual([[MOUSE_PRESS], [CTRL_U]]);
		expect(original.mock.contexts).toEqual([tui, tui]);
		layout.mockRestore();
	});

	it("rebinds on widget render after renderer replacement without stale bound closures", () => {
		const first = createRenderer();
		const second = createRenderer();
		const firstOriginal = installEditorGuard(first.tui, first.editor);
		const secondOriginal = installEditorGuard(second.tui, second.editor);
		const firstDescriptor = Object.getOwnPropertyDescriptor(first.tui, "handleViewportInput");
		const secondDescriptor = Object.getOwnPropertyDescriptor(second.tui, "handleViewportInput");
		const host = createHost(first.tui);
		host.install();
		const firstPatched = first.tui.handleViewportInput;
		host.replace(second.tui);
		host.renderWidget();
		expect(Object.getOwnPropertyDescriptor(first.tui, "handleViewportInput")).toEqual(firstDescriptor);
		expect(first.tui.handleViewportInput).toBe(firstOriginal);
		expect(second.tui.handleViewportInput).not.toBe(secondOriginal);
		expect(second.tui.handleViewportInput).not.toBe(firstPatched);
		const oldTop = first.transcript.scrollTop;
		const newTop = second.transcript.scrollTop;
		second.send(CTRL_U);
		second.send(CTRL_D);
		second.send(PAGE_UP);
		expect(second.checkpointInput.mock.calls).toEqual([[CTRL_U], [CTRL_D]]);
		expect(first.checkpointInput).not.toHaveBeenCalled();
		expect(first.transcript.scrollTop).toBe(oldTop);
		expect(second.transcript.scrollTop).toBe(newTop - (second.transcript.viewportHeight - 4));
		teardownToolMouseInteraction();
		expect(Object.getOwnPropertyDescriptor(second.tui, "handleViewportInput")).toEqual(secondDescriptor);
	});

	it("tears down the captured renderer when the proxy swaps without another widget render", () => {
		const first = createRenderer();
		const second = createRenderer();
		const original = installEditorGuard(first.tui, first.editor);
		installEditorGuard(second.tui, second.editor);
		exposeWheelSetting(first.tui, 7);
		exposeWheelSetting(second.tui, 11);
		const firstDescriptor = Object.getOwnPropertyDescriptor(first.tui, "handleViewportInput");
		const secondDescriptor = Object.getOwnPropertyDescriptor(second.tui, "handleViewportInput");
		const host = createHost(first.tui);
		host.install();
		const marker = viewportMarker(first.tui);
		host.replace(second.tui);
		teardownToolMouseInteraction();
		expect(Object.getOwnPropertyDescriptor(first.tui, "handleViewportInput")).toEqual(firstDescriptor);
		expect(first.tui.handleViewportInput).toBe(original);
		expect(first.tui.wheelScrollLines).toBe(7);
		expect(Reflect.get(first.tui, marker)).toBe(false);
		expect(Object.getOwnPropertyDescriptor(second.tui, "handleViewportInput")).toEqual(secondDescriptor);
		expect(second.tui.wheelScrollLines).toBe(11);
		expect(Object.getOwnPropertyDescriptor(second.tui, marker)).toBeUndefined();
	});

	it.each([false, true])("restores wheel settings only while CC still owns the value (external change: %s)", (externalChange) => {
		const { tui, transcript, send } = createRenderer();
		exposeWheelSetting(tui, 7);
		const host = createHost(tui);
		host.install();
		expect(tui.wheelScrollLines).toBe(3);
		const start = transcript.scrollTop;
		send(WHEEL_UP);
		expect(transcript.scrollTop).toBe(start - 3);
		if (externalChange) tui.wheelScrollLines = 11;
		teardownToolMouseInteraction();
		expect(tui.wheelScrollLines).toBe(externalChange ? 11 : 7);
	});

	it("syncs a changed scrollStepLines while active but restores the true original", () => {
		const { tui } = createRenderer();
		exposeWheelSetting(tui, 7);
		const host = createHost(tui);
		host.install();
		expect(tui.wheelScrollLines).toBe(3);
		setConfig({ ...config, scrollStepLines: 5 });
		host.renderWidget();
		expect(tui.wheelScrollLines).toBe(5);
		host.renderWidget();
		teardownToolMouseInteraction();
		expect(tui.wheelScrollLines).toBe(7);
	});
});
