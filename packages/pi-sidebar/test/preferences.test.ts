import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ratioAt } from "../src/config.ts";
import { RatioStore, readPreferences } from "../src/preferences.ts";

const file = () => path.join(mkdtempSync(path.join(tmpdir(), "pi-sidebar-prefs-")), "nested", "pi-sidebar.json");

describe("remembered divider", () => {
  it("falls back to the default until a share is saved, per orientation", async () => {
    const f = file();
    const store = new RatioStore(f, 0.5);
    expect(store.get("right")).toBe(0.5);
    store.set("right", 0.3, false);
    expect(store.get("right")).toBe(0.3);
    expect(store.get("down")).toBe(0.5);
    store.set("right", 0.35, true);
    await store.flushed();
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ ratio: { right: 0.35 } });
    expect(new RatioStore(f, 0.5).get("right")).toBe(0.35);
    store.set("right", undefined, true);
    await store.flushed();
    expect(new RatioStore(f, 0.6).get("right")).toBe(0.6);
  });

  it("clamps shares and ignores a broken file", () => {
    const f = file();
    const store = new RatioStore(f, 0.5);
    store.set("down", 0.99, false);
    expect(store.get("down")).toBe(0.85);
    const broken = path.join(mkdtempSync(path.join(tmpdir(), "pi-sidebar-prefs-")), "p.json");
    writeFileSync(broken, "{not json");
    expect(readPreferences(broken)).toEqual({ ratio: {} });
  });

  it("turns a divider position into Sidebar's share", () => {
    expect(ratioAt(82, 165)).toBeCloseTo(82 / 164);
    expect(ratioAt(0, 165)).toBe(0.85);
    expect(ratioAt(165, 165)).toBe(0.15);
  });
});
