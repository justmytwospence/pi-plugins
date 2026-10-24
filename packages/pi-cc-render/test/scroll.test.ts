import { describe, expect, it, vi } from "vitest";
import { isFullscreenAtBottom, scrollTranscriptToBottom, transcriptScrollView } from "../src/renderer/mouse/scroll.ts";

function view(following: boolean, child: unknown) {
	return { isFollowingEnd: following, child, scrollToEnd: vi.fn() };
}

/** Main's transcript beside a panel whose scroll view is primary while it has focus (pi-sidebar). */
function split(panelPrimary: boolean) {
	const main = view(true, { children: [{}, {}] });
	const panel = view(false, { render: () => [] });
	const tui = {
		layoutRoot: { entries: [{ component: { children: [main] } }, { component: {} }, { component: { children: [panel] } }] },
		getPrimaryScrollView: () => (panelPrimary ? panel : main),
		get isFollowingOutput() {
			return this.getPrimaryScrollView().isFollowingEnd;
		},
		scrollToBottom: vi.fn(),
		requestRender: vi.fn(),
	};
	return { main, panel, tui };
}

describe("dock button's transcript", () => {
	it("is the primary scroll view when it holds the transcript", () => {
		const { main, tui } = split(false);
		expect(transcriptScrollView(tui)).toBe(main);
		expect(isFullscreenAtBottom(tui)).toBe(true);
	});

	it("stays main's transcript while another scroll view is primary", () => {
		const { main, tui } = split(true);
		expect(transcriptScrollView(tui)).toBe(main);
		// The focused panel is scrolled up, main is not: the button stays hidden.
		expect(isFullscreenAtBottom(tui)).toBe(true);
		main.isFollowingEnd = false;
		expect(isFullscreenAtBottom(tui)).toBe(false);
	});

	it("scrolls main's transcript, not the primary view, when clicked", () => {
		const { main, tui } = split(true);
		scrollTranscriptToBottom(tui);
		expect(main.scrollToEnd).toHaveBeenCalled();
		expect(tui.scrollToBottom).not.toHaveBeenCalled();
		const plain = split(false);
		scrollTranscriptToBottom(plain.tui);
		expect(plain.tui.scrollToBottom).toHaveBeenCalled();
	});

	it("falls back to the host's state without a layout", () => {
		expect(isFullscreenAtBottom({ isFollowingOutput: false })).toBe(false);
		expect(isFullscreenAtBottom({})).toBe(true);
	});
});
