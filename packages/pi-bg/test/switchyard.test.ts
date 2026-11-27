import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import adapter, { duration, LINGER_MS, listed, progressValue, taskRow, type TaskRecord } from "../src/switchyard/adapter.ts";

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

  it("shows a queued reason in the portable panel and iframe without treating it as progress", () => {
    const { ctx, panels } = makeCtx();
    const status = "bg: suite queued (12s; CPU 91%)";
    adapter.onStatus("bg", status, ctx);
    expect(panels.at(-1)).toMatchObject({ node: { t: "text", text: status }, opts: { mobileFallback: status } });
    adapter.onStatus("bg", `${status} · build 40% 0:20`, ctx);
    adapter.onWidget("bg", ["build running"], ctx);
    expect(panels.at(-1)?.node).toMatchObject({ t: "section", children: [{ t: "progress", value: 0.4 }, { t: "list" }] });

    const element = () => ({ className: "", textContent: "", style: { width: "" }, children: [] as unknown[], appendChild(child: unknown) { this.children.push(child); } });
    const render = (panel: (typeof panels)[number]) => {
      const root = element();
      const parent = { postMessage() {} };
      const html = readFileSync(new URL("bg-renderer.html", dir), "utf8");
      runInNewContext(html.split("<script>")[1]!.split("</script>")[0]!, {
        document: { getElementById: () => root, createElement: element, documentElement: {} },
        parent,
        window: { addEventListener: (_: string, handle: (event: unknown) => void) => handle({ source: parent, data: { type: "render", node: panel.node, state: panel.opts?.state } }) },
      });
      return root.children;
    };
    expect(render(panels[0]!)).toMatchObject([{ className: "status", textContent: status }]);
    expect(render(panels.at(-1)!)).toMatchObject([
      { className: "status", textContent: `${status} · build 40% 0:20` },
      { className: "bar", children: [{ style: { width: "40%" } }] },
      { children: [{ textContent: "build running" }] },
    ]);
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

  it("restores queued work as active and separates admission wait from execution", () => {
    const { ctx, contributions, snapshot } = makeCtx(true, {}, V2);
    const queued = task({ status: "queued", startedAt: 0, requestedAt: now - 12_000, queueReason: "CPU 91%" });
    adapter.onEntry(entry(queued), ctx);
    expect(latest(contributions, "bg-tracker")).toMatchObject({
      node: { t: "rows", rows: [{ title: "train", status: "queued", meta: expect.stringContaining("in queue · CPU 91%") }] },
      tracker: { count: "1 queued", status: "running", step: "train queued" },
      mobileFallback: expect.stringContaining("train: queued"),
    });
    expect(taskRow(queued, now)).toEqual({ title: "train", status: "queued", meta: "12s in queue · CPU 91%" });
    const restored = makeCtx(true, snapshot(), ["adapter.trackers.v1"]);
    adapter.onRestore(restored.ctx);
    expect(latest(restored.contributions, "bg-tracker")).toMatchObject({
      node: { t: "table", rows: [["train", "queued", expect.stringContaining("in queue · CPU 91%")]] },
    });
    const killed = { ...queued, status: "killed" as const, endedAt: now };
    expect(taskRow(killed, now + 180_000)).toMatchObject({ status: "stopped", meta: "12s in queue" });

    const running = { ...queued, status: "running" as const, startedAt: now, queueReason: undefined };
    expect(taskRow(running, now + 2000)).toMatchObject({ status: "running", meta: "for 2s · waited 12s" });
    expect(taskRow({ ...running, status: "done", endedAt: now + 3500 }, now + 180_000)).toMatchObject({ status: "done", meta: "after 4s · waited 12s" });
    adapter.onEntry(entry(running), ctx);
    expect(latest(contributions, "bg-tracker")).toMatchObject({ tracker: { count: "1 running", status: "running", step: "train" } });
  });

  it("orders active entries by request time and retains every queued job", () => {
    const backlog = Array.from({ length: 10 }, (_, i) => task({ id: `q${i}`, status: "queued", startedAt: 0, requestedAt: now + i + 1 }));
    const running = task({ startedAt: now });
    const ended = task({ id: "done", status: "done", endedAt: now });
    expect(listed([ended, ...backlog.toReversed(), running]).map((t) => t.id)).toEqual([running.id, ...backlog.map((t) => t.id)]);
  });

  it("an old ended list lingers no longer than LINGER_MS, and malformed entries are ignored", () => {
    const { ctx, contributions } = makeCtx(true, {}, V2);
    adapter.onEntry(entry(task({ version: 2 } as unknown as Partial<TaskRecord>)), ctx);
    adapter.onEntry(entry(task({ status: "queued" })), ctx);
    adapter.onEntry(entry(task({ requestedAt: NaN, status: "queued", startedAt: 0 })), ctx);
    adapter.onEntry(entry(task({ queueReason: 91 } as unknown as Partial<TaskRecord>)), ctx);
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

  it("gives queued submissions a queued verb in the transcript", () => {
    const { ctx } = makeCtx(true, {}, V2);
    const submitted = { toolCallId: "1", name: "bg_run", args: { command: "python train.py", heavy: true }, details: { id: "a1", status: "queued" }, result: {} };
    adapter.onEntry(entry(task({ status: "queued", startedAt: 0, requestedAt: now, queueReason: "CPU 91%" })), ctx);
    expect(adapter.toolView(submitted, ctx)).toMatchObject({ verb: "Queued", activeVerb: "Queueing", target: "train", meta: ["job", "CPU 91%"] });
    adapter.onEntry(entry(task({ status: "done", requestedAt: now, startedAt: now + 1000, endedAt: now + 2000 })), ctx);
    expect(adapter.toolView(submitted, ctx)).toMatchObject({ verb: "Queued", target: "train", meta: ["job"] });
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

