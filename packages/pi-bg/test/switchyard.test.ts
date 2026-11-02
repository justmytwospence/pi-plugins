import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import adapter from "../src/switchyard/adapter.ts";

type Ctx = Parameters<NonNullable<typeof adapter.onStatus>>[2];
type UINode = Parameters<Ctx["setPanel"]>[1];
type PanelOptions = Parameters<Ctx["setPanel"]>[2];

function makeCtx() {
  const store = new Map<string, unknown>();
  const panels: { slot: string; node: UINode | null; opts?: PanelOptions }[] = [];
  const ctx = {
    state: {
      get: <T = unknown>(key: string) => store.get(key) as T | undefined,
      set: (key: string, value: unknown) => void store.set(key, structuredClone(value)),
      delete: (key: string) => void store.delete(key),
      keys: () => [...store.keys()],
    },
    setPanel: (slot: string, node: UINode | null, opts?: PanelOptions) => void panels.push({ slot, node, opts }),
  };
  return { ctx, panels };
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
