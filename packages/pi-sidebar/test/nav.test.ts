import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAV_KEYS, navDirection, navTarget } from "../src/nav.ts";
import { routeViewportScroll, scrollActionFor } from "../src/viewport.ts";

describe("Herdr navigation", () => {
  it("reads the reserved keys the Herdr plugin sends", () => {
    // Kitty encoding of Ctrl+Alt+Shift+H and +L (shift 1 + alt 2 + ctrl 4, plus 1).
    expect(navDirection("\x1b[104;8u")).toBe("left");
    expect(navDirection("\x1b[108;8u")).toBe("right");
    expect(navDirection("x")).toBeUndefined();
  });

  it("moves between main and Sidebar along the split, and leaves Pi otherwise", () => {
    expect(navTarget("right", true, "right", false)).toBe("sidebar");
    expect(navTarget("left", true, "right", true)).toBe("main");
    expect(navTarget("left", true, "right", false)).toBe("herdr");
    expect(navTarget("right", true, "right", true)).toBe("herdr");
    expect(navTarget("down", true, "down", false)).toBe("sidebar");
    expect(navTarget("up", true, "down", true)).toBe("main");
    expect(navTarget("right", true, "down", false)).toBe("herdr");
    expect(navTarget("right", false, "right", false)).toBe("herdr");
  });

  it("uses the same keys as the Herdr plugin's script", () => {
    const script = readFileSync(new URL("../herdr-plugin/nav.sh", import.meta.url), "utf8");
    for (const [direction, key] of Object.entries(NAV_KEYS)) expect(script).toContain(`${direction}) key=${key} ;;`);
  });
});

describe("viewport scrolling", () => {
  it("maps keys to Pi's transcript scroll actions through the keybindings", () => {
    expect(scrollActionFor("\x1b[5~")).toBe("pageUp");
    expect(scrollActionFor("\x1b[6~")).toBe("pageDown");
    expect(scrollActionFor("a")).toBeUndefined();
  });

  it("sends scroll actions to Sidebar only while it owns them, and restores the renderer", () => {
    const seen: string[] = [];
    const tui = { handleViewportInput: (data: string) => { seen.push(`main:${data}`); return { consume: true }; } };
    const original = tui.handleViewportInput;
    let owns = false;
    const scrolled: string[] = [];
    const release = routeViewportScroll(tui, () => owns, (action) => scrolled.push(action));
    tui.handleViewportInput("\x1b[5~");
    owns = true;
    tui.handleViewportInput("\x1b[5~");
    tui.handleViewportInput("x");
    expect(seen).toEqual(["main:\x1b[5~", "main:x"]);
    expect(scrolled).toEqual(["pageUp"]);
    release();
    expect(tui.handleViewportInput).toBe(original);
  });

  it("leaves a renderer without the method alone", () => {
    expect(() => routeViewportScroll({}, () => true, () => {})()).not.toThrow();
  });
});
