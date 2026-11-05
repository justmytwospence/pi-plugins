import { expect, test } from "vitest";
import type { PlaceRequest } from "../src/place-contract.ts";
import { placeSession } from "../src/worktree-place.ts";
import { fakeCall } from "./core/fake.ts";

const move: PlaceRequest = { kind: "move", root: "/r", path: "/r/.worktrees/a", branch: "a", file: "/s/f.jsonl", title: "Task a", prompt: "go" };
const open: PlaceRequest = { kind: "open", root: "/r", path: "/r/.worktrees/a", branch: "a", title: "a" };
const deps = (fake: ReturnType<typeof fakeCall>, over: Record<string, unknown> = {}) => ({
  call: fake.call, selfPane: async () => "self", uniqueName: async (w: string) => w, isCurrent: () => true, pollMs: 0, ...over,
});
const opened = (extra: Record<string, unknown> = {}) => ({ "worktree.open": () => ({ result: { workspace: { workspace_id: "wA" }, root_pane: { pane_id: "p1" }, ...extra } }) });

test("moves into a closed worktree and closes the source pane last", async () => {
  const f = fakeCall(opened());
  const res = await placeSession(deps(f), move);
  expect(res.ok).toBe(true);
  expect(f.of("worktree.open")[0].params).toEqual({ cwd: "/r", path: "/r/.worktrees/a", focus: true });
  const args = f.of("agent.start")[0].params.args;
  expect(args).toEqual(expect.arrayContaining(["--session", "/s/f.jsonl", "--", "go"]));
  expect(f.of("agent.start")[0].params.pane_id).toBe("p1");
  expect(f.of("pane.close")).toEqual([]);
  if (res.ok) await res.close!();
  expect(f.of("pane.close")).toEqual([{ method: "pane.close", params: { pane_id: "self" } }]);
});

test("an already open worktree gets a tab", async () => {
  const f = fakeCall({ ...opened({ already_open: true }), "tab.create": () => ({ result: { root_pane: { pane_id: "p2" } } }) });
  await placeSession(deps(f), move);
  expect(f.of("tab.create")[0].params).toEqual({ workspace_id: "wA", cwd: "/r/.worktrees/a", label: "Task a", focus: true });
  expect(f.of("agent.start")[0].params.pane_id).toBe("p2");
});

test("moving to the main checkout uses its space, else a new one", async () => {
  const snapshot = { workspaces: [{ workspace_id: "wM", worktree: { checkout_path: "/r", is_linked_worktree: false } }] };
  const f = fakeCall({ "session.snapshot": () => ({ result: { snapshot } }), "tab.create": () => ({ result: { root_pane: { pane_id: "p3" } } }) });
  await placeSession(deps(f), { ...move, path: "/r" });
  expect(f.of("tab.create")[0].params).toEqual({ workspace_id: "wM", cwd: "/r", label: "Task a", focus: true });
  const g = fakeCall({ "session.snapshot": () => ({ result: { snapshot: {} } }), "workspace.create": () => ({ result: { root_pane: { pane_id: "p4" } } }) });
  await placeSession(deps(g), { ...move, path: "/r" });
  expect(g.of("workspace.create")[0].params).toEqual({ cwd: "/r", label: "r", focus: true });
});

test("open: already open only focuses; otherwise resumes", async () => {
  const f = fakeCall(opened({ already_open: true }));
  const res = await placeSession(deps(f), open);
  expect(res.ok).toBe(true);
  expect(f.of("agent.start")).toEqual([]);
  const g = fakeCall(opened());
  const r2 = await placeSession(deps(g), open);
  expect(g.of("agent.start")[0].params.args).toEqual(["--continue"]);
  expect(r2.ok && r2.close).toBeUndefined();
});

test("startup failures", async () => {
  const f = fakeCall({ ...opened({ already_open: true }), "tab.create": () => ({ result: { root_pane: { pane_id: "p2" } } }), "agent.start": () => ({ error: { code: "agent_not_ready", message: "x" } }) });
  const res = await placeSession(deps(f), move);
  expect(res.ok === false && res.error).toMatch(/dialog/);
  expect(f.of("pane.close")).toEqual([]);
  const g = fakeCall({ ...opened({ already_open: true }), "tab.create": () => ({ result: { root_pane: { pane_id: "p2" } } }), "agent.start": () => ({ error: { code: "agent_failed", message: "x" } }) });
  await placeSession(deps(g), move);
  expect(g.of("pane.close")[0].params).toEqual({ pane_id: "p2" });
  const h = fakeCall({ ...opened({ already_open: true }), "tab.create": () => ({ result: { root_pane: { pane_id: "p2" } } }), "agent.start": () => ({ error: { code: "timeout", message: "x" } }) });
  await placeSession(deps(h), move);
  expect(h.of("pane.close")).toEqual([]);
});

test("a stale session starts nothing and closes its new tab", async () => {
  const f = fakeCall({ ...opened({ already_open: true }), "tab.create": () => ({ result: { root_pane: { pane_id: "p2" } } }) });
  const res = await placeSession(deps(f, { isCurrent: () => false }), move);
  expect(res.ok).toBe(false);
  expect(f.of("agent.start")).toEqual([]);
  expect(f.of("pane.close")[0].params).toEqual({ pane_id: "p2" });
});

test("a busy pane is retried", async () => {
  let n = 0;
  const f = fakeCall({ ...opened(), "agent.start": () => (++n < 3 ? { error: { code: "agent_pane_busy", message: "b" } } : { result: {} }) });
  expect((await placeSession(deps(f), move)).ok).toBe(true);
  expect(f.of("agent.start")).toHaveLength(3);
});
