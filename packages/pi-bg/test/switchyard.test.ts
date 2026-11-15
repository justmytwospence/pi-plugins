import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import adapter, { progressValue } from "../src/switchyard/adapter.ts";

type Ctx = Parameters<NonNullable<typeof adapter.onStatus>>[2];
type UINode = Parameters<Ctx["setPanel"]>[1];
type PanelOptions = Parameters<Ctx["setPanel"]>[2];

function makeCtx(modern = false, initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(structuredClone(initial)));
  const panels: { slot: string; node: Parameters<Ctx["setPanel"]>[1]; opts?: Parameters<Ctx["setPanel"]>[2] }[] = [];
  const contributions: { id: string; value: Parameters<NonNullable<Ctx["setContribution"]>>[1] }[] = [];
  const ctx: Ctx = {
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
