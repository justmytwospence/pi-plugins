import { describe, expect, it } from "vitest";
import { ActivityBadges } from "../src/activity-badges.ts";

describe("compact sidebar activity", () => {
  it("shows one icon and total per kind, never task names or parentheses", () => {
    const a = new ActivityBadges();
    expect(a.token()).toBeUndefined();
    a.apply("herdr:background", { active: true, label: "subagents (1)", id: "s1" });
    a.apply("herdr:background", { active: true, label: "subagents (2)", id: "s2" });
    a.apply("herdr:background", { active: true, label: "subagents (2)", id: "s3" });
    a.apply("herdr:working", { active: true, label: "Planning", id: "p" });
    a.apply("herdr:background", { active: true, label: "child auth-fix", id: "c1" });
    a.apply("herdr:background", { active: true, label: "child docs", id: "c2" });
    a.apply("herdr:background", { active: true, label: "tests · lint", id: "j1" });
    a.apply("herdr:background", { active: true, label: "build", id: "j2" });
    expect(a.token()).toBe("⑂ 5 · ≡ 1 · ↳ 2 · ⌘ 2");
    expect(a.size).toBe(8);
    a.apply("herdr:background", { active: false, id: "s2" });
    expect(a.token()).toBe("⑂ 3 · ≡ 1 · ↳ 2 · ⌘ 2");
    a.apply("herdr:background", { active: false });
    expect(a.token()).toBe("⑂ 2 · ≡ 1 · ↳ 2 · ⌘ 2");
    a.clear();
    expect(a.size).toBe(0);
    expect(a.token()).toBeUndefined();
  });

  it("preserves channel-scoped releases and handles missing or unfamiliar labels", () => {
    const a = new ActivityBadges();
    a.apply("herdr:background", { active: true, id: "shared" });
    a.apply("herdr:working", { active: true, id: "shared" });
    expect(a.token()).toBe("⌘ 1 · ≡ 1");
    a.apply("herdr:working", { active: false, id: "shared" });
    expect(a.token()).toBe("⌘ 1");
    a.apply("herdr:working", { active: false });
    expect(a.token()).toBe("⌘ 1");
    a.apply("herdr:background", { active: true, label: "subagents (0)" });
    a.apply("herdr:background", { active: true, label: `subagents (${"9".repeat(400)})` });
    expect(a.token()).toBe("⌘ 1 · ⑂ 2");
    a.apply("herdr:background", undefined);
    expect(a.token()).toBe("⑂ 2");
  });
});
