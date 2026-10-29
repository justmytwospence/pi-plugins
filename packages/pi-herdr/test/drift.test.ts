// Base drift and branch overlap (src/drift.ts) against real git: a bare origin, a main checkout
// and worktrees; and the RefWatcher firing once per burst of ref changes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realExec, remoteRepo } from "./git-fixture.ts";
import { computeDrift, currentBranch, defaultBase, driftMatters, driftNote, driftToken, gitSupportsMergeTree, overlapLine, RefWatcher, siblingOverlaps } from "../src/drift.ts";

describe("drift", () => {
  let r: ReturnType<typeof remoteRepo>;
  beforeEach(() => { r = remoteRepo(); });
  afterEach(() => r.cleanup());

  it("finds the default base and the current branch", async () => {
    expect(await defaultBase(realExec, r.a)).toBe("main");
    expect(await currentBranch(realExec, r.a)).toBe("a");
  });

  it("is not behind until the base moves; then counts, lists upstream commits, and finds overlap and conflicts", async () => {
    expect(await computeDrift(realExec, r.a, "main")).toMatchObject({ behind: 0, overlap: [] });
    r.commit(r.a, "shared.txt", "one\nTWO-a\nthree\n");
    r.upstream("other.txt", "y\n");
    const behindOnly = (await computeDrift(realExec, r.a, "main"))!;
    expect(behindOnly).toMatchObject({ base: "main", behind: 1, overlap: [] });
    expect(behindOnly.upstream[0]).toContain("upstream other.txt");
    expect(driftToken(behindOnly)).toBe("↓1 main");
    expect(driftMatters(behindOnly)).toBe(false);

    r.upstream("shared.txt", "one\nTWO-main\nthree\n");
    const d = (await computeDrift(realExec, r.a, "main"))!;
    expect(d).toMatchObject({ behind: 2, overlap: ["shared.txt"] });
    if (await gitSupportsMergeTree(realExec, r.a)) {
      expect(d.conflicts).toEqual(["shared.txt"]);
      expect(driftToken(d)).toBe("↓2 main ✗ conflict");
    } else expect(driftToken(d)).toBe("↓2 main · 1 overlap");
    expect(driftMatters(d)).toBe(true);
    const note = driftNote(d);
    expect(note).toContain("origin/main moved 2 commits ahead");
    expect(note).toContain("shared.txt");
    expect(note).toContain("Rebase only if the user or a directive says so");
    expect(await computeDrift(realExec, r.a, "nope")).toBeUndefined();
  });

  it("finds sibling branches that change the same files", async () => {
    r.commit(r.a, "shared.txt", "one\nTWO-a\nthree\n");
    r.commit(r.b, "shared.txt", "one\nTWO-b\nthree\n");
    const pairs = await siblingOverlaps(realExec, r.root, [{ label: "a", branch: "a", base: "main" }, { label: "b", branch: "b", base: "main" }]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: "a", b: "b", files: ["shared.txt"] });
    if (await gitSupportsMergeTree(realExec, r.root)) expect(overlapLine(pairs[0]!)).toBe("- overlap: a ↔ b: would conflict in shared.txt");
    r.commit(r.b, "other.txt", "z\n");
    expect(await siblingOverlaps(realExec, r.root, [{ label: "a", branch: "a", base: "main" }])).toEqual([]);
  });

  it("fires once per burst of ref changes, and not after close", async () => {
    let fired = 0;
    const w = new RefWatcher({ common: r.common, kinds: ["remotes", "heads"], debounceMs: 150, onChange: () => fired++ });
    await new Promise((res) => setTimeout(res, 100));
    r.commit(r.a, "other.txt", "q\n");
    r.upstream("other.txt", "w\n");
    await new Promise((res) => setTimeout(res, 600));
    expect(fired).toBe(1);
    w.close();
    r.commit(r.a, "other.txt", "r\n");
    await new Promise((res) => setTimeout(res, 400));
    expect(fired).toBe(1);
  });
});
