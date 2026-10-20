import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAV_KEYS, navDirection, navTarget } from "../src/nav.ts";

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
