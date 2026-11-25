import { describe, expect, it } from "vitest";
import { CiWatcher, type CiConfig } from "../src/watcher.ts";
import { clock, fail, fakeExec, OLD, ok, run, SHA } from "./fake.ts";

const cfg: CiConfig = { watch: true, ignore: [], maxRounds: 3 };
const ref = { repo: "o/r", oldSha: OLD, newSha: SHA, branch: "main", forced: false };

function setup(batches: Array<ReturnType<typeof run>[]>, log = "boom: assertion failed") {
  const c = clock();
  let i = 0;
  const { exec, calls } = fakeExec([
    [/^gh run list/, () => ok(JSON.stringify(batches[Math.min(i++, batches.length - 1)]))],
    [/^gh run view/, ok(log)],
    [/^gh api/, ok(SHA)],
  ]);
  const events: Array<{ channel: string; data: any }> = [];
  const delivered: Array<{ id: string; text: string; wake: boolean }> = [];
  let changes = 0;
  const watcher = new CiWatcher({ exec, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, emit: (channel, data) => events.push({ channel, data }), deliver: (id, text, wake) => delivered.push({ id, text, wake }), changed: () => changes++ });
  return { c, watcher, calls, events, delivered, changes: () => changes };
}

describe("CiWatcher", () => {
  it("stays quiet on green and reports it to bg:external", async () => {
    const x = setup([[run({ status: "in_progress", conclusion: "" })], [run()]]);
    const done = x.watcher.watch(ref, cfg, "/r");
    await x.c.advance(120_000);
    await done;
    expect(x.delivered).toEqual([]);
    expect(x.events.map((e) => e.data.state)).toEqual(["running", "done"]);
    expect(x.events[1]!.data).toMatchObject({ id: `ci:${SHA.slice(0, 7)}`, summary: "green: 1 run" });
    expect(x.events.every((e) => e.data.settle === undefined)).toBe(true);
    expect(x.watcher.entries(x.c.now())[0]).toMatchObject({ status: "done" });
  });

  it("wakes the agent once on red, with the log tail and the revert range", async () => {
    const x = setup([[run({ conclusion: "failure", workflowName: "Checks", url: "https://github.com/o/r/actions/runs/9" })]]);
    const done = x.watcher.watch(ref, cfg, "/r");
    await x.c.advance(60_000);
    await done;
    expect(x.delivered).toHaveLength(1);
    const d = x.delivered[0]!;
    expect(d.wake).toBe(true);
    expect(d.id).toBe(`ci:${SHA.slice(0, 7)}`);
    expect(d.text).toContain(`CI failed for main ${SHA.slice(0, 7)} in o/r: 1 of 1 runs.`);
    expect(d.text).toContain("### Checks: failure (https://github.com/o/r/actions/runs/9)");
    expect(d.text).toContain("```text\nboom: assertion failed\n```");
    expect(d.text).toContain(`git revert --no-edit ${OLD}..${SHA.slice(0, 7)}`);
    expect(d.text).toContain("pi-ship watches the new push");
    expect(x.events.at(-1)!.data).toMatchObject({ state: "failed", result: d.text });
  });

  it("omits the revert line for a forced push or an unknown old sha", async () => {
    for (const r of [{ ...ref, forced: true }, { ...ref, oldSha: undefined }]) {
      const x = setup([[run({ conclusion: "failure" })]]);
      const done = x.watcher.watch(r, cfg, "/r");
      await x.c.advance(60_000);
      await done;
      expect(x.delivered[0]!.text).not.toContain("git revert");
    }
  });

  it("stops waking the agent at the third red in a row, and a green resets the count", async () => {
    const red = [run({ conclusion: "failure" })];
    const x = setup([red]);
    for (let n = 1; n <= 3; n++) {
      const done = x.watcher.watch({ ...ref, newSha: String(n).repeat(40) }, cfg, "/r");
      await x.c.advance(60_000);
      await done;
    }
    expect(x.delivered.map((d) => d.wake)).toEqual([true, true, false]);
    expect(x.delivered[2]!.text).toContain("CI has failed 3 pushes in a row on main");
  });

  it("resets the red count when CI is green", async () => {
    const batches: Array<Array<ReturnType<typeof run>>> = [[run({ conclusion: "failure" })], [run({ conclusion: "failure" })], [run()], [run({ conclusion: "failure" })]];
    // each watch makes two list calls (the run, then the confirmation look), so feed each batch twice
    const y = setup(batches.flatMap((b) => [b, b]));
    for (let n = 1; n <= 4; n++) {
      const done = y.watcher.watch({ ...ref, newSha: String(n).repeat(40) }, cfg, "/r");
      await y.c.advance(60_000);
      await done;
    }
    expect(y.delivered.map((d) => d.wake)).toEqual([true, true, true]);
  });

  it("skips ignored workflows", async () => {
    const x = setup([[run({ workflowName: "Docs", conclusion: "failure" }), run({ databaseId: 2, workflowName: "Checks" })]]);
    const done = x.watcher.watch(ref, { ...cfg, ignore: ["Docs"] }, "/r");
    await x.c.advance(60_000);
    await done;
    expect(x.delivered).toEqual([]);
  });

  it("ends quietly when no runs appear within 3 minutes", async () => {
    const x = setup([[]]);
    const done = x.watcher.watch(ref, cfg, "/r");
    await x.c.advance(200_000);
    await done;
    expect(x.delivered).toEqual([]);
    expect(x.watcher.entries(x.c.now())[0]).toMatchObject({ status: "done", detail: "no CI runs" });
  });

  it("gives up after 90 minutes of running CI without waking the agent", async () => {
    const x = setup([[run({ status: "in_progress", conclusion: "" })]]);
    const done = x.watcher.watch(ref, cfg, "/r");
    await x.c.advance(91 * 60_000);
    await done;
    expect(x.delivered).toEqual([]);
    expect(x.watcher.entries(x.c.now())[0]).toMatchObject({ status: "failed" });
    expect(x.watcher.entries(x.c.now())[0]!.detail).toContain("CI still running after 90 min");
  });

  it("stops the older watch of the same branch when a new push supersedes it", async () => {
    const x = setup([[run({ status: "in_progress", conclusion: "" })]]);
    const first = x.watcher.watch(ref, cfg, "/r");
    await x.c.advance(20_000);
    const second = x.watcher.watch({ ...ref, newSha: "c".repeat(40) }, cfg, "/r");
    await x.c.advance(1_000);
    await first;
    const list = x.watcher.entries(x.c.now());
    expect(list.find((w) => w.sha === SHA)).toMatchObject({ status: "stopped", detail: "superseded by ccccccc" });
    expect(list.find((w) => w.sha === "c".repeat(40))?.status).toBe("running");
    x.watcher.dispose();
    await second;
  });

  it("resolves a short or local ref before watching, and fails quietly when it cannot", async () => {
    const c = clock();
    const { exec } = fakeExec([[/^git rev-parse/, fail("bad ref", 128)]]);
    const delivered: unknown[] = [];
    const w = new CiWatcher({ exec, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, emit: () => undefined, deliver: (...a) => delivered.push(a), changed: () => undefined });
    await w.watch({ ...ref, newSha: "HEAD" }, cfg, "/r");
    expect(w.entries(c.now())[0]).toMatchObject({ status: "failed" });
    expect(delivered).toEqual([]);
  });
});
