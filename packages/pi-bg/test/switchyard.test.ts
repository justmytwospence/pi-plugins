import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import adapter, { duration, LINGER_MS, progressValue, type TaskRecord } from "../src/switchyard/adapter.ts";

type Ctx = Parameters<NonNullable<typeof adapter.onStatus>>[2];
type UINode = Parameters<Ctx["setPanel"]>[1];
type PanelOptions = Parameters<Ctx["setPanel"]>[2];

function makeCtx(modern = false, initial: Record<string, unknown> = {}, features?: string[]) {
  const store = new Map(Object.entries(structuredClone(initial)));
  const panels: { slot: string; node: Parameters<Ctx["setPanel"]>[1]; opts?: Parameters<Ctx["setPanel"]>[2] }[] = [];
  const contributions: { id: string; value: Parameters<NonNullable<Ctx["setContribution"]>>[1] }[] = [];
  const ctx: Ctx = {
    ...(features ? { features } : {}),
    state: {
      get: <T = unknown>(key: string) => store.get(key) as T | undefined,
      set: (key: string, value: unknown) => void store.set(key, structuredClone(value)),
      delete: (key: string) => void store.delete(key),
      keys: () => [...store.keys()],
    },
    setPanel: (slot, node, opts) => void panels.push({ slot, node, opts }),
    ...(modern ? { setContribution: (id: string, value: Parameters<NonNullable<Ctx["setContribution"]>>[1]) => void contributions.push({ id, value }) } : {}),
  };
  return { ctx, panels, contributions, snapshot: () => Object.fromEntries(store) };
}

const dir = new URL("../src/switchyard/", import.meta.url);

describe("bg switchyard adapter", () => {
  it("bg status -> progress or text panel with renderer state; clearing removes it", async () => {
    const { ctx, panels } = makeCtx();
    expect(await adapter.onStatus("bg", "2/4 jobs running", ctx)).toBe(true);
    await adapter.onStatus("bg", "1 job running", ctx);
    await adapter.onWidget("bg", ["build  running", "test   queued"], ctx);
    await adapter.onStatus("bg", undefined, ctx);
    await adapter.onWidget("bg", undefined, ctx);
    expect(await adapter.onStatus("other", "x", ctx)).toBe(false);
    expect(panels[0]).toMatchObject({
      slot: "bg",
      node: { t: "progress", label: "2/4 jobs running", value: 0.5 },
    });
    expect(panels[1]).toMatchObject({ node: { t: "text", text: "1 job running" } });
    expect(panels[2]).toMatchObject({
      node: { t: "section" },
      opts: { state: { status: "1 job running", lines: ["build  running", "test   queued"] } },
    });
    expect(panels.at(-1)).toMatchObject({ node: null });
    expect(ctx.state.get("bg")).toBeUndefined();
  });

  it("reads percentages", async () => {
    const { ctx, panels } = makeCtx();
    await adapter.onStatus("bg", "build 40%", ctx);
    expect(panels[0]?.node).toMatchObject({ t: "progress", value: 0.4 });
  });

  it("ships a manifest that points at its adapter and web renderer", () => {
    const manifest = JSON.parse(readFileSync(new URL("switchyard-adapter.json", dir), "utf8"));
    expect(manifest).toMatchObject({ id: "bg", server: "adapter.ts", webRenderer: "bg-renderer.html" });
    expect(existsSync(new URL(manifest.server, dir))).toBe(true);
    const html = readFileSync(new URL(manifest.webRenderer, dir), "utf8");
    expect(html).toContain('"render"');
    expect(html).toContain('type: "resize"');
    expect(html).toContain("Content-Security-Policy");
  });
});


describe("background Switchyard presentation", () => {
  it("publishes slots, restores display without polling, and tombstones the legacy panel", () => {
    const { ctx, contributions, panels, snapshot } = makeCtx(true);
    expect(adapter.onStatus("other", "ignore", ctx)).toBe(false);
    expect(adapter.onWidget("other", ["ignore"], ctx)).toBe(false);
    adapter.onStatus("bg", "tests 3/5", ctx);
    adapter.onWidget("bg", ["tests running"], ctx);
    expect(panels.every((p) => p.slot === "bg" && p.node === null)).toBe(true);
    expect(contributions.slice(-2)).toMatchObject([
      { id: "bg", value: { placement: "session.panel", title: "Background", state: { status: "tests 3/5", lines: ["tests running"] } } },
      { id: "bg-pill", value: { placement: "composer.pill", node: { t: "progress", value: 0.6 } } },
    ]);
    const restored = makeCtx(true, snapshot());
    adapter.onRestore(restored.ctx);
    expect(restored.contributions).toEqual(contributions.slice(-2));
    expect(restored.snapshot()).toEqual(snapshot());
  });

  it("keeps unknown progress explicit and does not infer completion when status disappears", () => {
    const { ctx, contributions } = makeCtx(true);
    adapter.onStatus("bg", "still running", ctx);
    expect(contributions.at(-1)?.value?.node).toEqual({ t: "text", text: "still running" });
    adapter.onWidget("bg", ["progress unknown"], ctx);
    adapter.onStatus("bg", undefined, ctx);
    expect(contributions.at(-1)).toEqual({ id: "bg-pill", value: null });
    expect(contributions.at(-2)?.value?.node).toEqual({ t: "list", items: [{ t: "text", text: "progress unknown" }] });
    adapter.onWidget("bg", undefined, ctx);
    expect(contributions.slice(-2)).toEqual([{ id: "bg", value: null }, { id: "bg-pill", value: null }]);
    expect(ctx.state.get("bg")).toBeUndefined();
  });

  it("retains the desktop renderer state and portable fallback on legacy hosts", () => {
    const { ctx, panels, snapshot } = makeCtx(false);
    adapter.onStatus("bg", "40%", ctx);
    adapter.onWidget("bg", ["build"], ctx);
    expect(panels.at(-1)).toMatchObject({
      slot: "bg", opts: { title: "Background", state: { status: "40%", lines: ["build"] }, mobileFallback: "40%\nbuild" },
    });
    const restored = makeCtx(false, snapshot());
    adapter.onRestore(restored.ctx);
    expect(restored.panels).toEqual(panels.slice(-1));
    expect(progressValue("unknown")).toBeUndefined();
    expect(progressValue("0/0")).toBeUndefined();
    expect(progressValue("0%")).toBe(0);
    expect(progressValue("120%")).toBe(1);
    expect(progressValue("2/4")).toBe(0.5);
  });
});

describe("contract v2", () => {
  const V2 = ["tool.views.v1", "ui.nodes.v2", "adapter.trackers.v1", "interaction.kinds.v1"];
  const now = Date.now();
  const task = (over: Partial<TaskRecord>): TaskRecord => ({
    version: 1, id: "a1", name: "train", kind: "job", status: "running", origin: "agent", command: "python train.py",
    cwd: "/w", logPath: "/tmp/a1.log", startedAt: now - 192_000, ready: false, keep: false, ...over,
  });
  const entry = (t: TaskRecord) => ({ type: "custom", customType: "pi-bg:task", data: t });
  const latest = (contributions: { id: string; value: unknown }[], id: string) =>
    contributions.filter((c) => c.id === id).at(-1)?.value;

  it("tasks from pi-bg:task entries are a Background tracker with one row per task", () => {
    const { ctx, contributions, panels } = makeCtx(true, {}, V2);
    adapter.onEntry(entry(task({ progress: { fraction: 0.42, note: "epoch 3" } })), ctx);
    adapter.onEntry(entry(task({ id: "s1", name: "vite", kind: "service", ready: true, startedAt: now - 30_000 })), ctx);
    adapter.onEntry(entry(task({ id: "b1", name: "build", status: "failed", exitCode: 2, startedAt: now - 70_000, endedAt: now - 10_000 })), ctx);
    expect(latest(contributions, "bg-tracker")).toMatchObject({
      placement: "composer.tracker",
      title: "Background",
      node: {
        t: "rows",
        rows: [
          { title: "train", status: "42%", meta: expect.stringMatching(/^for 3m 1[12]s · epoch 3$/) },
          { title: "vite", status: "ready", meta: expect.stringMatching(/^service · for 3\d?s$/) },
          { title: "build", status: "failed (exit 2)", tone: "danger", meta: "after 1m 0s" },
        ],
      },
      tracker: { count: "2 running", status: "running", step: "train 42%" },
    });
    expect(latest(contributions, "bg")).toBeNull();
    expect(latest(contributions, "bg-pill")).toBeNull();
    expect(panels.every((p) => p.node === null)).toBe(true);
    // The status only refreshes the times; it is never parsed and never shown generically.
    expect(adapter.onStatus("bg", "bg: train 42% 3m", ctx)).toBe(true);
    expect(adapter.onWidget("bg", ["x"], ctx)).toBe(true);
    adapter.onEntry(entry(task({ status: "done", endedAt: now })), ctx);
    adapter.onEntry(entry(task({ id: "s1", name: "vite", kind: "service", status: "killed", startedAt: now - 30_000, endedAt: now - 1000 })), ctx);
    expect(latest(contributions, "bg-tracker")).toMatchObject({ tracker: { status: "ok" } });
    expect((latest(contributions, "bg-tracker") as { tracker: object }).tracker).not.toHaveProperty("count");
  });

  it("an old ended list lingers no longer than LINGER_MS, and malformed entries are ignored", () => {
    const { ctx, contributions } = makeCtx(true, {}, V2);
    adapter.onEntry(entry(task({ version: 2 } as unknown as Partial<TaskRecord>)), ctx);
    adapter.onEntry({ type: "custom", customType: "other", data: task({}) }, ctx);
    expect(contributions).toEqual([]);
    adapter.onEntry(entry(task({ status: "done", endedAt: now - LINGER_MS - 1000 })), ctx);
    expect(latest(contributions, "bg-tracker")).toBeNull();
  });

  it("before v2 the entries change nothing and the status text drives the legacy panel", () => {
    const { ctx, contributions } = makeCtx(true);
    adapter.onEntry(entry(task({})), ctx);
    expect(contributions.filter((c) => c.id === "bg-tracker")).toEqual([]);
    adapter.onStatus("bg", "2/4 jobs", ctx);
    expect(latest(contributions, "bg-pill")).toMatchObject({ placement: "composer.pill" });
  });

  it("the bg tools get rows, naming the task", () => {
    const { ctx } = makeCtx(true, {}, V2);
    adapter.onEntry(entry(task({ status: "done", endedAt: now })), ctx);
    expect(adapter.toolView({ toolCallId: "1", name: "bg_run", args: { command: "python train.py", kind: "job", name: "train" } }, ctx)).toEqual({
      kind: "command", verb: "Started", activeVerb: "Starting", target: "train", meta: ["job"],
      detail: { t: "code", text: "python train.py", lang: "bash" },
    });
    expect(adapter.toolView({ toolCallId: "2", name: "bg_wait", args: { id: "train" }, result: {} }, ctx)).toMatchObject({
      verb: "Waited on", target: "train", meta: ["done"],
    });
    expect(adapter.toolView({ toolCallId: "3", name: "bg_wait", args: {} }, ctx)).toMatchObject({ target: "the next task" });
    expect(adapter.toolView({ toolCallId: "4", name: "bg_kill", args: { id: "a1" }, result: {}, isError: true }, ctx)).toMatchObject({
      verb: "Stopped", target: "train", meta: ["done", "failed"],
    });
    expect(adapter.toolView({ toolCallId: "5", name: "bash", args: {} }, ctx)).toBeUndefined();
  });

  it("formats durations", () => {
    expect([duration(42_000), duration(192_000), duration(3_900_000)]).toEqual(["42s", "3m 12s", "1h 5m"]);
  });
});

