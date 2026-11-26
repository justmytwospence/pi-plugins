import { describe, expect, it } from "vitest";
import adapter, { duration, VIEW_ONLY_NOTE } from "../src/switchyard/adapter.ts";

type Ctx = Parameters<NonNullable<typeof adapter.onEntry>>[1];
type Link = Parameters<Ctx["linkSubagent"]>[0];

function makeCtx(modern = false, initial: Record<string, unknown> = {}, features?: string[]) {
  const store = new Map(Object.entries(structuredClone(initial)));
  const panels: { slot: string; node: Parameters<Ctx["setPanel"]>[1]; opts?: Parameters<Ctx["setPanel"]>[2] }[] = [];
  const contributions: { id: string; value: Parameters<NonNullable<Ctx["setContribution"]>>[1] }[] = [];
  const links: unknown[] = [];
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

describe("contract v2", () => {
  const V2 = ["tool.views.v1", "ui.nodes.v2", "adapter.trackers.v1", "interaction.kinds.v1"];
  const latest = (contributions: { id: string; value: unknown }[], id: string) =>
    contributions.filter((c) => c.id === id).at(-1)?.value;
  const run = (over: Record<string, unknown>) => ({
    id: "r1", agent: "worker", task: "Fix the tests", label: "Fix tests", model: "openai/gpt-5", status: "running",
    seconds: 80, activity: "running vitest", ...over,
  });
  const update = (runs: unknown[]) => ({ toolCallId: "c1", name: "subagent", args: { task: "Fix the tests" }, partialResult: {}, details: { runs } });

  it("live runs are a Subagents tracker with one row per run", () => {
    const { ctx, contributions, links } = makeCtx(true, {}, V2);
    adapter.onToolUpdate(update([run({}), run({ id: "r2", label: "Review", agent: "reviewer", seconds: 20, activity: undefined })]), ctx);
    expect(latest(contributions, "subagents-tracker")).toMatchObject({
      placement: "composer.tracker",
      title: "Subagents",
      node: {
        t: "rows",
        rows: [
          { title: "Fix tests", status: "running", meta: "worker · openai/gpt-5 · 1m 20s · running vitest" },
          { title: "Review", status: "running", meta: "reviewer · openai/gpt-5 · 20s" },
        ],
      },
      tracker: { count: "2 running", status: "running", step: "Fix tests: running vitest" },
    });
    expect(String((latest(contributions, "subagents-tracker") as { mobileFallback: string }).mobileFallback)).toContain(VIEW_ONLY_NOTE);
    expect(latest(contributions, "subagents")).toBeNull();
    expect(latest(contributions, "subagents-pill")).toBeNull();
    expect(links).toHaveLength(2);
    adapter.onToolEnd({ toolCallId: "c1", name: "subagent", args: {}, result: {}, isError: false, details: { runs: [run({ status: "done", seconds: 95 }), run({ id: "r2", label: "Review", status: "failed", error: "boom" })] } }, ctx);
    expect(latest(contributions, "subagents-tracker")).toMatchObject({
      node: { rows: [{ title: "Fix tests", status: "done", tone: "success" }, { title: "Review", status: "failed", tone: "danger", meta: expect.stringContaining("boom") }] },
      tracker: { status: "error" },
    });
  });

  it("before v2 live updates change nothing", () => {
    const { ctx, contributions, links } = makeCtx(true);
    adapter.onToolUpdate(update([run({})]), ctx);
    expect(contributions).toEqual([]);
    expect(links).toEqual([]);
  });

  it("a subagent call is a one-line row that opens to its runs", () => {
    const { ctx } = makeCtx(true, {}, V2);
    expect(adapter.toolView({ toolCallId: "c1", name: "subagent", args: { task: "Fix the tests\nmore", agent: "worker" } }, ctx)).toEqual({
      kind: "other", verb: "Delegated", activeVerb: "Delegating", target: "Fix the tests", meta: ["worker"],
    });
    expect(adapter.toolView({ toolCallId: "c1", name: "subagent", args: { tasks: [{}, {}] }, result: {}, details: { runs: [run({ status: "done" }), run({ id: "r2", status: "done" })] } }, ctx)).toMatchObject({
      target: "2 tasks", meta: ["2 done"], detail: { t: "rows" },
    });
    expect(adapter.toolView({ toolCallId: "c1", name: "subagent", args: { action: "stop", id: "r1" } }, ctx)).toMatchObject({ verb: "Stopped subagent", target: "r1", meta: [] });
    expect(adapter.toolView({ toolCallId: "c1", name: "read", args: {} }, ctx)).toBeUndefined();
  });

  it("formats durations", () => {
    expect([duration(42), duration(192), duration(3900)]).toEqual(["42s", "3m 12s", "1h 5m"]);
  });
});

