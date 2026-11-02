import { describe, expect, it } from "vitest";
import adapter from "../src/switchyard/adapter.ts";

type Ctx = Parameters<NonNullable<typeof adapter.onEntry>>[1];
type Link = Parameters<Ctx["linkSubagent"]>[0];

function makeCtx() {
  const store = new Map<string, unknown>();
  const links: Link[] = [];
  const ctx = {
    state: {
      get: <T = unknown>(key: string) => store.get(key) as T | undefined,
      set: (key: string, value: unknown) => void store.set(key, structuredClone(value)),
      delete: (key: string) => void store.delete(key),
      keys: () => [...store.keys()],
    },
    linkSubagent: (link: Link) => void links.push(link),
  };
  return { ctx, links };
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
