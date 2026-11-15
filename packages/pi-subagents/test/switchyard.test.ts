import { describe, expect, it } from "vitest";
import adapter, { VIEW_ONLY_NOTE } from "../src/switchyard/adapter.ts";

type Ctx = Parameters<NonNullable<typeof adapter.onEntry>>[1];
type Link = Parameters<Ctx["linkSubagent"]>[0];

function makeCtx(modern = false, initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(structuredClone(initial)));
  const panels: { slot: string; node: Parameters<Ctx["setPanel"]>[1]; opts?: Parameters<Ctx["setPanel"]>[2] }[] = [];
  const contributions: { id: string; value: Parameters<NonNullable<Ctx["setContribution"]>>[1] }[] = [];
  const links: unknown[] = [];
  const ctx: Ctx = {
    state: {
      get: <T = unknown>(key: string) => store.get(key) as T | undefined,
      set: (key: string, value: unknown) => void store.set(key, structuredClone(value)),
      delete: (key: string) => void store.delete(key),
      keys: () => [...store.keys()],
    },
    setPanel: (slot, node, opts) => void panels.push({ slot, node, opts }),
    ...(modern ? { setContribution: (id: string, value: Parameters<NonNullable<Ctx["setContribution"]>>[1]) => void contributions.push({ id, value }) } : {}),
    linkSubagent: (link) => void links.push(link),
  };
  return { ctx, panels, contributions, links, snapshot: () => Object.fromEntries(store) };
}

describe("subagents switchyard adapter", () => {
  it("links runs from entries and tool results, keeping the latest per id", async () => {
    const { ctx, links } = makeCtx();
    const run = { id: "run-1", agent: "worker", task: "Fix the tests", status: "running", sessionFile: "/s/a.jsonl" };
    const entry = { type: "custom", customType: "subagents:run", data: run };
    await adapter.onEntry(entry, ctx);
    await adapter.onEntry(entry, ctx);
    await adapter.onEntry({ type: "custom", customType: "other", data: run }, ctx);
    await adapter.onToolEnd(
      {
        toolCallId: "c1",
        name: "subagent",
        args: {},
        result: {},
        isError: false,
        details: {
          mode: "single",
          runs: [
            { ...run, status: "done" },
            { id: "run-2", agent: "explorer", task: "Look", label: "Scout", status: "failed" },
          ],
        },
      },
      ctx,
    );
    expect(links).toEqual([
      { runId: "run-1", label: "worker: Fix the tests", status: "running", sessionFile: "/s/a.jsonl" },
      { runId: "run-1", label: "worker: Fix the tests", status: "done", sessionFile: "/s/a.jsonl" },
      { runId: "run-2", label: "Scout", status: "failed", sessionFile: null },
    ]);
  });

  it("reads details from the result and ignores other tools and malformed runs", async () => {
    const { ctx, links } = makeCtx();
    const base = { toolCallId: "c", args: {}, isError: false };
    await adapter.onToolEnd({ ...base, name: "bash", result: { details: { runs: [{ id: "x", status: "done" }] } } }, ctx);
    await adapter.onToolEnd({ ...base, name: "subagent", result: { details: { runs: [{ id: "x" }, null, { id: "y", status: "done", task: "t".repeat(80) }] } } }, ctx);
    expect(links).toEqual([{ runId: "y", label: `${"t".repeat(57)}...`, status: "done", sessionFile: null }]);
  });
});


describe("subagent Switchyard presentation", () => {
  it("keeps the view-only warning in a bounded fallback even for long labels", () => {
    const { ctx, contributions, links } = makeCtx(true, {
      "run:long": { runId: "long", label: "x".repeat(2500), status: "done", sessionFile: null },
    });
    adapter.onRestore(ctx);
    const fallback = contributions[0]?.value?.mobileFallback;
    expect(fallback?.length).toBeLessThanOrEqual(2000);
    expect(fallback?.endsWith(VIEW_ONLY_NOTE)).toBe(true);
    expect(links).toEqual([]);
  });

  it("links new run evidence but restores only portable, read-only presentation", () => {
    const { ctx, contributions, panels, links, snapshot } = makeCtx(true);
    const entry = { type: "custom", customType: "subagents:run", data: { id: "r1", agent: "reviewer", task: "Inspect", status: "running", sessionFile: "/tmp/r1.jsonl" } };
    adapter.onEntry(entry, ctx);
    adapter.onEntry(entry, ctx);
    expect(links).toHaveLength(1);
    expect(panels).toMatchObject([{ slot: "subagents", node: null }]);
    expect(contributions).toMatchObject([
      { id: "subagents", value: { placement: "session.panel", title: "Subagents" } },
      { id: "subagents-pill", value: { placement: "composer.pill", node: { text: "Subagents: 1 running" } } },
    ]);
    expect(JSON.stringify(contributions[0])).toContain(VIEW_ONLY_NOTE);
    const restored = makeCtx(true, snapshot());
    adapter.onRestore(restored.ctx);
    expect(restored.contributions).toEqual(contributions);
    expect(restored.links).toEqual([]);
    expect(restored.snapshot()).toEqual(snapshot());
    adapter.onRestore(restored.ctx);
    expect(restored.links).toEqual([]);
  });

  it("clears the running pill but keeps useful completed run details", () => {
    const { ctx, contributions, links } = makeCtx(true);
    const end = (runs: unknown[]) => ({ toolCallId: "t1", name: "subagent", args: {}, result: { details: { runs } }, isError: false });
    adapter.onToolEnd(end([{ id: "r1", label: "Build", status: "running" }]), ctx);
    adapter.onToolEnd(end([{ id: "r1", label: "Build", status: "done" }]), ctx);
    expect(links).toHaveLength(2);
    expect(contributions.at(-1)).toEqual({ id: "subagents-pill", value: null });
    expect(JSON.stringify(contributions.at(-2))).toContain("done");
    expect(contributions.at(-2)?.value?.mobileFallback).toContain(VIEW_ONLY_NOTE);
  });

  it("has a legacy panel fallback and clears empty presentation without emitting links", () => {
    const { ctx, panels, links } = makeCtx(false);
    adapter.onRestore(ctx);
    expect(panels.at(-1)).toMatchObject({ slot: "subagents", node: null });
    adapter.onEntry({ type: "custom", customType: "subagents:run", data: { id: "r1", status: "lost" } }, ctx);
    expect(panels.at(-1)?.opts?.mobileFallback).toContain(VIEW_ONLY_NOTE);
    expect(panels.at(-1)?.node).not.toBeNull();
    expect(links).toHaveLength(1);
    const modern = makeCtx(true);
    adapter.onRestore(modern.ctx);
    expect(modern.contributions).toEqual([{ id: "subagents", value: null }, { id: "subagents-pill", value: null }]);
    expect(modern.links).toEqual([]);
  });
});
