import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, dryRun, runShip, type ShipConfig, type ShipCtx, type ShipDeps } from "../src/ship.ts";
import type { System1Outcome } from "../src/system1.ts";
import { fail, fakeExec, OLD, ok, SHA } from "./fake.ts";

const PUSHED = "To git@github.com:o/r.git\n   bbbbbbb..aaaaaaa  main -> main\n";

function setup(over: { cfg?: Partial<ShipConfig>; rules?: Array<[RegExp, any]>; subagents?: (req: any) => void; diff?: (req: any) => void; confirm?: boolean; hasUI?: boolean } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...over.cfg, review: { ...DEFAULT_CONFIG.review, ...over.cfg?.review } } as ShipConfig;
  const { exec, calls } = fakeExec([
    ...(over.rules ?? []),
    [/^git rev-parse --show-toplevel/, ok("/r\n")],
    [/^git rev-parse --abbrev-ref @\{upstream\}/, ok("origin/main\n")],
    [/^git merge-base/, ok(`${OLD}\n`)],
    [/^git rev-list --count/, ok("2\n")],
    [/^git status --porcelain/, ok("")],
    [/^git log --format=%s/, ok("feat: a\nfix: b\n")],
    [/^git diff --name-only/, ok("")],
    [/^git diff -U20/, ok("@@ hunk")],
    [/^git remote get-url origin/, ok("git@github.com:o/r.git\n")],
    [/^git rev-parse HEAD/, ok(`${SHA}\n`)],
    [/^git branch --show-current/, ok("main\n")],
    [/^bash -c git push/, ok(PUSHED)],
  ]);
  const delivered: Array<{ text: string; wake: boolean }> = [];
  const watched: unknown[] = [];
  const bus: Record<string, (d: any) => void> = {};
  if (over.subagents) bus["pi-plugins.subagents-run.v1"] = over.subagents;
  if (over.diff) bus["pi-plugins.diff-review-comments.v1"] = over.diff;
  const notes: string[] = [];
  const statuses: Array<string | undefined> = [];
  const confirm = vi.fn(async () => over.confirm ?? true);
  const ctx: ShipCtx = { cwd: "/r", hasUI: over.hasUI ?? true, ui: { notify: (m) => notes.push(m), setStatus: (_k, t) => statuses.push(t), confirm } };
  const deps: ShipDeps = {
    exec,
    events: { emit: (c, d) => bus[c]?.(d) },
    watcher: { watch: async (...a: unknown[]) => void watched.push(a) } as never,
    deliver: (text, wake) => delivered.push({ text, wake }),
    ask: () => async () => ({ ok: true, answers: { supported: { type: "bool", probability: 0.9 } }, latencyMs: 1 }) as unknown as System1Outcome,
  };
  const go = (args = "") => runShip(deps, ctx, cfg, args);
  return { go, calls, delivered, watched, notes, statuses, confirm, cfg };
}

const reviewOutput = (items: unknown[]) => `\`\`\`json\n${JSON.stringify(items)}\n\`\`\``;

describe("/ship", () => {
  it("--dry lists the steps and runs nothing", async () => {
    const x = setup({ cfg: { check: "npm test", humanPaths: ["scripts/release.mjs"] } });
    await x.go("--dry");
    expect(x.calls).toEqual([]);
    expect(x.notes[0]).toContain("check: npm test");
    expect(x.notes[0]).toContain("publish: git push");
    expect(dryRun(x.cfg)).toContain("review: never (no review.paths)");
  });

  it("stops and wakes the agent when the check fails", async () => {
    const x = setup({ cfg: { check: "npm test" }, rules: [[/^bash -c npm test/, { stdout: "FAIL one\n", stderr: "", code: 2 }]] });
    await x.go();
    expect(x.delivered).toHaveLength(1);
    expect(x.delivered[0]!.wake).toBe(true);
    expect(x.delivered[0]!.text).toContain("/ship stopped: `npm test` failed (exit 2).");
    expect(x.delivered[0]!.text).toContain("FAIL one");
    expect(x.calls.some((c) => c.startsWith("bash -c git push"))).toBe(false);
  });

  it("says there is nothing to publish for an empty range", async () => {
    const x = setup({ rules: [[/^git rev-list --count/, ok("0\n")]] });
    await x.go();
    expect(x.notes).toEqual(["/ship: nothing to publish"]);
    expect(x.calls.some((c) => c.startsWith("bash"))).toBe(false);
  });

  it("runs git tidy when the range has fixup commits", async () => {
    const x = setup({ rules: [[/^git log --format=%s/, ok("feat: a\nfixup! feat: a\n")], [/^bash -c git tidy/, ok("tidied")]] });
    await x.go();
    expect(x.calls.some((c) => c.startsWith('bash -c git tidy "origin/main"'))).toBe(true);
  });

  it("skips review when no path matches, and publishes then watches the parsed push", async () => {
    const x = setup({ cfg: { review: { ...DEFAULT_CONFIG.review, paths: ["packages/x/**"] } as never, check: "npm test" }, rules: [[/^bash -c npm test/, ok("ok")]] });
    await x.go();
    expect(x.calls.some((c) => c.startsWith("git diff --name-only") && c.includes(":(glob)packages/x/**"))).toBe(true);
    expect(x.watched).toHaveLength(1);
    expect((x.watched[0] as any[])[0]).toMatchObject({ repo: "o/r", oldSha: "bbbbbbb", newSha: "aaaaaaa", branch: "main" });
    expect(x.delivered).toHaveLength(1);
    expect(x.delivered[0]).toMatchObject({ wake: false });
    expect(x.delivered[0]!.text).toContain("Shipped 2 commits");
    expect(x.delivered[0]!.text).toContain("check ✓, review not needed, published with `git push`, watching CI.");
    expect(x.statuses.at(-1)).toBeUndefined();
  });

  it("falls back to HEAD and origin when the publish step prints no push", async () => {
    const x = setup({ cfg: { publish: "scripts/deploy.sh" }, rules: [[/^bash -c scripts\/deploy\.sh/, ok("deployed")]] });
    await x.go();
    expect((x.watched[0] as any[])[0]).toEqual({ repo: "o/r", oldSha: OLD, newSha: SHA, branch: "main", forced: false });
  });

  it("reports a failed publish without waking the agent or watching", async () => {
    const x = setup({ rules: [[/^bash -c git push/, { stdout: "rejected\n", stderr: "", code: 1 }]] });
    await x.go();
    expect(x.delivered[0]).toMatchObject({ wake: false });
    expect(x.delivered[0]!.text).toContain("`git push` failed (exit 1)");
    expect(x.watched).toEqual([]);
  });

  it("does not watch when ci.watch is off", async () => {
    const x = setup({ cfg: { ci: { watch: false, ignore: [], maxRounds: 3 } } });
    await x.go();
    expect(x.watched).toEqual([]);
    expect(x.delivered[0]!.text).toContain("CI not watched");
  });

  describe("review", () => {
    const reviewCfg = { review: { ...DEFAULT_CONFIG.review, always: true, lenses: ["correctness", "docs"] } as never };
    const subagents = (items: unknown[]) => (req: any) => {
      req.result = Promise.resolve({ isError: false, runs: req.tasks.map((t: any) => ({ label: t.label, status: "done", output: t.label.endsWith("correctness") ? reviewOutput(items) : reviewOutput([]) })) });
    };

    it("starts one reviewer per lens, asks System 1 about each finding and sends survivors to /diff", async () => {
      let tasks: any[] = [];
      let comments: any[] = [];
      const x = setup({
        cfg: reviewCfg,
        subagents: (req) => { tasks = req.tasks; subagents([{ path: "a.ts", line: 4, severity: "blocking", title: "Off by one", body: "see loop" }])(req); },
        diff: (req) => { comments = req.comments; req.result = Promise.resolve({ sent: 0, opened: true }); },
      });
      await x.go();
      expect(tasks.map((t) => [t.label, t.agent, t.cwd])).toEqual([["ship review: correctness", "reviewer", "/r"], ["ship review: docs", "reviewer", "/r"]]);
      expect(comments).toEqual([{ path: "a.ts", line: 4, body: "[ship · correctness · blocking] Off by one\n\nsee loop" }]);
      expect(x.confirm).toHaveBeenCalledTimes(1);
      expect((x.confirm.mock.calls[0] as unknown as string[])[1]).toContain("1 finding");
      expect(x.watched).toHaveLength(1);
      expect(x.delivered[0]!.text).toContain("review 1 finding");
    });

    it("pauses when comments went to the agent", async () => {
      const x = setup({
        cfg: reviewCfg,
        subagents: subagents([{ path: "a.ts", line: 4, title: "t", body: "b" }]),
        diff: (req) => { req.result = Promise.resolve({ sent: 1, opened: true }); },
      });
      await x.go();
      expect(x.delivered).toEqual([{ text: "/ship paused: 1 review comment went to the agent. Run /ship again after the fixes.", wake: false }]);
      expect(x.confirm).not.toHaveBeenCalled();
      expect(x.calls.some((c) => c.startsWith("bash -c git push"))).toBe(false);
    });

    it("cancels when the user declines the confirmation", async () => {
      const x = setup({ cfg: reviewCfg, confirm: false, subagents: subagents([{ path: "a.ts", line: 4, title: "t", body: "b" }]), diff: (req) => { req.result = Promise.resolve({ sent: 0, opened: true }); } });
      await x.go();
      expect(x.notes).toEqual(["/ship cancelled"]);
      expect(x.calls.some((c) => c.startsWith("bash -c git push"))).toBe(false);
    });

    it("notes a skipped review when pi-subagents is not loaded and still publishes", async () => {
      const x = setup({ cfg: reviewCfg });
      await x.go();
      expect(x.delivered[0]!.text).toContain("review skipped");
      expect(x.delivered[0]!.text).toContain("- review skipped: pi-subagents is not loaded");
      expect(x.watched).toHaveLength(1);
    });

    it("lists the findings in the confirmation when pi-diff-review is not loaded", async () => {
      const x = setup({ cfg: reviewCfg, subagents: subagents([{ path: "a.ts", line: 4, title: "Off by one", body: "b" }]) });
      await x.go();
      expect((x.confirm.mock.calls[0] as unknown as string[])[1]).toContain("a.ts:4 Off by one");
    });

    it("notes a reviewer that failed or answered without a json block", async () => {
      const x = setup({ cfg: reviewCfg, subagents: (req) => { req.result = Promise.resolve({ isError: false, runs: [{ label: "ship review: correctness", status: "failed", output: "", error: "rate limit" }, { label: "ship review: docs", status: "done", output: "no block" }] }); } });
      await x.go();
      const text = x.delivered[0]!.text;
      expect(text).toContain("- review correctness: rate limit");
      expect(text).toContain("- review docs: no json block in the answer");
    });
  });

  it("asks before publishing when the range touches humanPaths, without a review", async () => {
    const x = setup({ cfg: { humanPaths: ["scripts/release.mjs"] }, rules: [[/^git diff --name-only .* :\(glob\)scripts\/release\.mjs/, ok("scripts/release.mjs\n")]] });
    await x.go();
    expect(x.confirm).toHaveBeenCalledTimes(1);
    expect((x.confirm.mock.calls[0] as unknown as string[])[1]).toContain("files that need your review: scripts/release.mjs");
    expect(x.watched).toHaveLength(1);
  });

  it("stops instead of publishing when a confirmation is needed and there is no UI", async () => {
    const x = setup({ hasUI: false, cfg: { humanPaths: ["scripts/release.mjs"] }, rules: [[/^git diff --name-only .* :\(glob\)scripts\/release\.mjs/, ok("scripts/release.mjs\n")]] });
    await x.go();
    expect(x.delivered[0]!.text).toContain("there is no UI");
    expect(x.watched).toEqual([]);
  });

  it("refuses outside a git repository", async () => {
    const x = setup({ rules: [[/^git rev-parse --show-toplevel/, fail("not a repo", 128)]] });
    await x.go();
    expect(x.notes).toEqual(["/ship: not inside a git repository"]);
  });
});
