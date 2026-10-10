// Shared verbatim by pi-herdr and opencode-herdr (test/core).
import { describe, expect, it } from "vitest";
import { type ChildAgent, type ChildRecord, Children, type ChildrenDeps, childPreamble, slugName } from "../../src/core/children.ts";
import { fakeCall } from "./fake.ts";

/** A stand-in agent: `pi`-style arguments, replies looked up by session. */
function testAgent(replies: Record<string, string>): ChildAgent {
  return {
    kind: "pi",
    args: (opts, name) => ["--name", name, ...(opts.model ? ["--model", opts.model] : []), ...(opts.thinking ? ["--thinking", opts.thinking] : [])],
    reply: async (rec) => (rec.session ? replies[rec.session] : undefined),
  };
}

/** A herdr with one parent pane and the child panes it creates; agent state is set by the test. */
function world(opts: { liveNames?: string[]; startError?: { code: string; message: string } } = {}) {
  const session = "/sessions/child.jsonl";
  const agent = { agent: "pi", interactive_ready: true, agent_status: "idle", completion_seq: 1 as number | undefined, state_change_seq: 1, agent_session: { kind: "path", value: session } };
  const state = { agent, paneGone: false, agentGone: false };
  const f = fakeCall({
    "pane.get": (p) => (p.pane_id === "w1:p1" ? { result: { pane: { pane_id: "w1:p1", workspace_id: "w1" } } } : state.paneGone ? { error: { code: "not_found", message: "pane not found" } } : { result: { pane: { pane_id: p.pane_id } } }),
    "agent.list": () => ({ result: { agents: (opts.liveNames ?? []).map((name) => ({ name })) } }),
    "tab.create": () => ({ result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } } }),
    "pane.layout": () => ({ result: { layout: { panes: [{ pane_id: "w1:p1", rect: { width: 200, height: 50 } }] } } }),
    "pane.split": () => ({ result: { pane: { pane_id: "w1:p3" } } }),
    "worktree.open": () => ({ result: { already_open: false, workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } } }),
    "agent.start": () => (opts.startError ? { error: opts.startError } : { result: { agent: { ...agent } } }),
    "agent.get": () => (state.paneGone || state.agentGone ? { error: { code: "not_found", message: "agent not found" } } : { result: { agent: { ...state.agent } } }),
    "agent.prompt": () => ({ result: {} }),
    "agent.read": () => ({ result: { read: { text: "working on it" } } }),
  });
  const delivered: { rec: ChildRecord; text: string; reply?: string }[] = [];
  const holds: [string, boolean][] = [];
  const persisted: ChildRecord[] = [];
  const execs: string[][] = [];
  const deps: ChildrenDeps = {
    call: f.call,
    agent: testAgent({ [session]: "All done: 3 files changed." }),
    selfPane: "w1:p1",
    exec: async (cmd, args) => {
      execs.push([cmd, ...args]);
      if (cmd === "worktree" && args[0] === "path") return { code: 0, stdout: "/repo/.worktrees/feat-x\n", stderr: "" };
      if (cmd === "git") return { code: 0, stdout: "/repo/.git\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    persist: (rec) => persisted.push(rec),
    deliver: (rec, text, reply) => delivered.push({ rec, text, reply }),
    hold: (rec, on) => holds.push([rec.name, on]),
    pollMs: 60_000,
    readyPollMs: 1,
  };
  return { f, state, delivered, holds, persisted, execs, children: new Children(deps) };
}

describe("names", () => {
  it("slugs tasks into herdr agent names", () => {
    expect(slugName("Fix the flaky auth tests in CI")).toBe("fix-flaky-auth");
    expect(slugName("123 go")).toBe("c-123-go");
    expect(slugName("!!!")).toBe("child");
    expect(slugName("supercalifragilisticexpialidocious word")).toMatch(/^[a-z][a-z0-9-]{0,23}$/u);
  });

  it("avoids live agent names", async () => {
    const w = world({ liveNames: ["review", "review-2"] });
    expect(await w.children.uniqueName("review")).toBe("review-3");
  });
});

describe("children", () => {
  it("spawns in a tab, prompts with the preamble, and delivers the reply after the turn", async () => {
    const w = world();
    const rec = await w.children.spawn({ task: "Review the auth module", cwd: "/repo", model: "anthropic/claude-opus-5-5", thinking: "high" });
    expect(rec).toMatchObject({ name: "review-auth-module", paneId: "w1:p2", where: "tab", awaiting: true });
    expect(w.f.of("tab.create")[0]!.params).toMatchObject({ workspace_id: "w1", cwd: "/repo", label: "review-auth-module", focus: false });
    expect(w.f.of("agent.start")[0]!.params).toMatchObject({
      name: "review-auth-module",
      kind: "pi",
      pane_id: "w1:p2",
      args: ["--name", "review-auth-module", "--model", "anthropic/claude-opus-5-5", "--thinking", "high"],
    });
    const prompt = w.f.of("agent.prompt")[0]!.params;
    expect(prompt.target).toBe("w1:p2");
    expect(prompt.text.startsWith("[You are a child pi session.")).toBe(true);
    expect(prompt.text.endsWith("Review the auth module")).toBe(true);
    expect(w.holds).toEqual([["review-auth-module", true]]);

    // Still idle with the same completion: the prompt has not started yet.
    await w.children.tick();
    expect(w.delivered).toHaveLength(0);
    w.state.agent.agent_status = "working";
    w.state.agent.completion_seq = undefined;
    await w.children.tick();
    expect(w.delivered).toHaveLength(0);
    w.state.agent.agent_status = "done";
    w.state.agent.completion_seq = 7;
    await w.children.tick();
    expect(w.delivered).toHaveLength(1);
    expect(w.delivered[0]!.reply).toBe("All done: 3 files changed.");
    expect(w.delivered[0]!.text).toContain('Herdr child "review-auth-module" (tab, pane w1:p2) replied:');
    expect(w.holds.at(-1)).toEqual(["review-auth-module", false]);
    expect(w.children.get("review-auth-module").awaiting).toBe(false);

    // A turn the user starts in the child's pane is not reported.
    w.state.agent.agent_status = "working";
    await w.children.tick();
    w.state.agent.agent_status = "idle";
    w.state.agent.completion_seq = 8;
    await w.children.tick();
    expect(w.delivered).toHaveLength(1);
  });

  it("detects a fast turn by its completion_seq alone", async () => {
    const w = world();
    await w.children.spawn({ task: "quick", name: "quick", cwd: "/repo" });
    w.state.agent.completion_seq = 2;
    await w.children.tick();
    expect(w.delivered).toHaveLength(1);
  });

  it("splits beside the pane and opens worktrees through the worktree script", async () => {
    const w = world();
    const s = await w.children.spawn({ task: "watch tests", name: "tests", where: "split", cwd: "/repo" });
    expect(s.paneId).toBe("w1:p3");
    expect(w.f.of("pane.split")[0]!.params).toMatchObject({ target_pane_id: "w1:p1", direction: "right" });
    const t = await w.children.spawn({ task: "build feature x", name: "feat", where: "worktree", branch: "feat/x", cwd: "/repo" });
    expect(w.execs[0]).toEqual(["worktree", "new", "feat/x", "--no-open"]);
    expect(w.f.of("worktree.open")[0]!.params).toMatchObject({ cwd: "/repo", path: "/repo/.worktrees/feat-x" });
    expect(t).toMatchObject({ paneId: "w9:p1", workspaceId: "w9", cwd: "/repo/.worktrees/feat-x", branch: "feat/x" });
    expect(w.f.of("agent.prompt").at(-1)!.params.text).toContain("on branch feat/x");
    await expect(w.children.spawn({ task: "x", where: "worktree", cwd: "/repo" })).rejects.toThrow(/needs `branch`/u);
  });

  it("refuses to prompt a blocked child and reports a closed one", async () => {
    const w = world();
    await w.children.spawn({ task: "t", name: "c", cwd: "/repo" });
    w.state.agent.agent_status = "blocked";
    await expect(w.children.send("c", "more")).rejects.toThrow(/waiting on a dialog/u);
    w.state.paneGone = true;
    await w.children.tick();
    expect(w.delivered[0]!.text).toContain("was closed before it replied");
    expect(w.children.get("c").closed).toBe(true);
    await expect(w.children.send("c", "more")).rejects.toThrow(/closed/u);
    await expect(w.children.send("nobody", "x")).rejects.toThrow(/No child "nobody"/u);
  });

  it("closes the new pane when pi does not start", async () => {
    const w = world({ startError: { code: "timeout", message: "agent did not start" } });
    await expect(w.children.spawn({ task: "t", name: "c", cwd: "/repo" })).rejects.toThrow(/did not start/u);
    expect(w.f.of("pane.close")[0]!.params).toEqual({ pane_id: "w1:p2" });
  });

  it("reads, lists, interrupts and closes", async () => {
    const w = world();
    await w.children.spawn({ task: "Long task here", name: "c", cwd: "/repo" });
    w.state.agent.agent_status = "working";
    expect(await w.children.read("c")).toContain("Screen:\nworking on it");
    expect(await w.children.list()).toMatch(/^c {2}working \(reply pending\) {2}tab {2}pane w1:p2 {2}Long task here/u);
    expect(await w.children.interrupt("c")).toContain("Escape");
    expect(w.f.of("agent.send_keys")[0]!.params).toEqual({ target: "w1:p2", keys: ["esc"] });
    w.state.agent.agent_status = "idle";
    expect(await w.children.read("c")).toContain("Last reply:\nAll done");
    expect(await w.children.close("c")).toContain("Closed c's pane");
    expect(w.holds.at(-1)).toEqual(["c", false]);
    expect(w.persisted.at(-1)).toMatchObject({ name: "c", closed: true, awaiting: false });
  });

  it("restores awaited children and holds for them", () => {
    const w = world();
    w.children.restore([{ name: "c", paneId: "w1:p2", where: "tab", cwd: "/r", task: "t", createdAt: 0, awaiting: true }]);
    expect(w.holds).toEqual([["c", true]]);
    w.children.shutdown();
    expect(w.holds.at(-1)).toEqual(["c", false]);
  });

  it("tells the child where it works", () => {
    expect(childPreamble("pi", "w1:p1", { where: "worktree", branch: "b", cwd: "/r/.worktrees/b" })).toContain("git worktree of your own (/r/.worktrees/b) on branch b");
    expect(childPreamble("opencode", "w1:p1", { where: "tab", cwd: "/r" })).toMatch(/^\[You are a child opencode session\. Another opencode session/u);
    expect(childPreamble("pi", "w1:p1", { where: "tab", cwd: "/r" })).not.toContain("worktree");
  });

  it("treats a pane that is already gone as closed", async () => {
    const w = world();
    await w.children.spawn({ task: "t", name: "c", cwd: "/repo" });
    const gone = new Children({ ...(w.children as any).deps, call: async (method: string) => (method === "pane.close" ? { error: { code: "pane_not_found", message: "pane w1:p2 not found" } } : { result: {} }) });
    gone.restore([w.children.get("c")]);
    expect(await gone.close("c")).toContain("Closed c's pane");
    expect(gone.get("c").closed).toBe(true);
  });
});
