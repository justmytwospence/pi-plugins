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
function world(opts: { liveNames?: string[]; startError?: { code: string; message: string }; worktrees?: string[] } = {}) {
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
    "worktree.create": () => ({ result: { workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } } }),
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
      if (cmd === "git" && args[0] === "worktree") return { code: 0, stdout: ["/repo", ...(opts.worktrees ?? [])].map((p) => `worktree ${p}\n`).join("\n"), stderr: "" };
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
  it("attaches a running agent as a child without prompting it, then hears back from what it is sent", async () => {
    const w = world();
    const rec = w.children.attach({ name: "feature-x", paneId: "w9:p1", cwd: "/repo/.worktrees/feature-x", branch: "feature/x", workspaceId: "w9", session: "/sessions/child.jsonl" });
    expect(rec).toMatchObject({ name: "feature-x", where: "worktree", branch: "feature/x", awaiting: false });
    expect(rec.task).toContain("branch feature/x");
    expect(w.f.of("agent.prompt")).toHaveLength(0);
    expect(w.persisted.at(-1)).toMatchObject({ name: "feature-x", paneId: "w9:p1" });
    // The same pane again is the same child, whatever name is asked for.
    expect(w.children.attach({ name: "other", paneId: "w9:p1", cwd: "/repo/.worktrees/feature-x" })).toBe(rec);

    await w.children.send("feature-x", "rebase onto develop");
    w.state.agent.agent_status = "working";
    await w.children.tick();
    w.state.agent.agent_status = "idle";
    w.state.agent.completion_seq = 9;
    await w.children.tick();
    expect(w.delivered).toHaveLength(1);
    expect(w.delivered[0]!.reply).toBe("All done: 3 files changed.");
  });

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

  it("steers a working child, or queues the message until its turn ends", async () => {
    const w = world();
    await w.children.spawn({ task: "build it", name: "builder", cwd: "/repo" });
    w.state.agent.agent_status = "working";
    await w.children.tick();

    expect(await w.children.send("builder", "use the other API", "steer")).toMatchObject({ outcome: "steered", status: "working" });
    expect(w.f.of("agent.prompt")).toHaveLength(2);

    expect(await w.children.send("builder", "then do issue 1371", "queue")).toMatchObject({ outcome: "queued" });
    expect(await w.children.send("builder", "and rebase", "queue")).toMatchObject({ outcome: "queued" });
    expect(w.f.of("agent.prompt")).toHaveLength(2);
    expect(w.children.get("builder").queued).toEqual(["then do issue 1371", "and rebase"]);

    // The turn ends: its reply is delivered, then the queue goes out as one message.
    w.state.agent.agent_status = "idle";
    w.state.agent.completion_seq = 5;
    await w.children.tick();
    expect(w.delivered).toHaveLength(1);
    expect(w.f.of("agent.prompt").at(-1)!.params.text).toBe("then do issue 1371\n\nand rebase");
    expect(w.children.get("builder").queued).toBeUndefined();
    expect(w.children.get("builder").awaiting).toBe(true);

    // An idle child gets it at once, whatever the delivery.
    expect(await w.children.send("builder", "one more", "queue")).toMatchObject({ outcome: "sent", status: "idle" });
  });

  it("sends a queued message to a child working on a turn the user started", async () => {
    const w = world();
    await w.children.spawn({ task: "t", name: "solo", cwd: "/repo" });
    w.state.agent.completion_seq = 2;
    await w.children.tick();
    expect(w.children.get("solo").awaiting).toBe(false);
    w.state.agent.agent_status = "working";
    await w.children.send("solo", "later", "queue");
    await w.children.tick();
    expect(w.f.of("agent.prompt")).toHaveLength(1);
    w.state.agent.agent_status = "idle";
    await w.children.tick();
    expect(w.f.of("agent.prompt").at(-1)!.params.text).toBe("later");
    expect(w.children.get("solo").awaiting).toBe(true);
  });

  it("detects a fast turn by its completion_seq alone", async () => {
    const w = world();
    await w.children.spawn({ task: "quick", name: "quick", cwd: "/repo" });
    w.state.agent.completion_seq = 2;
    await w.children.tick();
    expect(w.delivered).toHaveLength(1);
  });

  it("splits beside the pane and creates worktrees in <repo>/.worktrees through herdr", async () => {
    const w = world();
    const s = await w.children.spawn({ task: "watch tests", name: "tests", where: "split", cwd: "/repo" });
    expect(s.paneId).toBe("w1:p3");
    expect(w.f.of("pane.split")[0]!.params).toMatchObject({ target_pane_id: "w1:p1", direction: "right" });
    const t = await w.children.spawn({ task: "build feature x", name: "feat", where: "worktree", branch: "feat/x", cwd: "/repo" });
    expect(w.execs.some(([cmd]) => cmd === "worktree")).toBe(false);
    expect(w.f.of("worktree.create")[0]!.params).toMatchObject({ cwd: "/repo", branch: "feat/x", path: "/repo/.worktrees/feat-x" });
    expect(w.f.of("worktree.open")).toHaveLength(0);
    expect(t).toMatchObject({ paneId: "w9:p1", workspaceId: "w9", cwd: "/repo/.worktrees/feat-x", branch: "feat/x" });
    expect(w.f.of("agent.prompt").at(-1)!.params.text).toContain("on branch feat/x");
    await expect(w.children.spawn({ task: "x", where: "worktree", cwd: "/repo" })).rejects.toThrow(/needs `branch`/u);
  });

  it("opens an existing <repo>/.worktrees checkout instead of creating it", async () => {
    const w = world({ worktrees: ["/repo/.worktrees/feat-x"] });
    await w.children.spawn({ task: "build feature x", name: "feat", where: "worktree", branch: "feat/x", cwd: "/repo" });
    expect(w.f.of("worktree.create")).toHaveLength(0);
    expect(w.f.of("worktree.open")[0]!.params).toMatchObject({ cwd: "/repo", path: "/repo/.worktrees/feat-x" });
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

describe("transport", () => {
  it("sends through the host's transport when it takes the message, even to a blocked child", async () => {
    const w = world();
    const sent: [string, string][] = [];
    (w.children as any).deps.transport = async (_rec: ChildRecord, text: string, delivery: string) => {
      sent.push([text, delivery]);
      return { outcome: "held" };
    };
    const rec = await w.children.spawn({ task: "Do it", cwd: "/repo" });
    expect(w.f.of("agent.prompt")).toEqual([]);
    expect(sent[0]![0]).toContain("Do it");
    w.state.agent.agent_status = "blocked";
    const r = await w.children.send(rec.name, "and this", "steer");
    expect(r).toMatchObject({ outcome: "steered", delivered: "held" });
    expect(sent[1]).toEqual(["and this", "steer"]);
  });

  it("falls back to agent.prompt when the transport cannot take it", async () => {
    const w = world();
    (w.children as any).deps.transport = async () => undefined;
    await w.children.spawn({ task: "Do it", cwd: "/repo" });
    expect(w.f.of("agent.prompt")).toHaveLength(1);
  });
});

describe("peers", () => {
  const peer = (w: ReturnType<typeof world>, over: { name?: string; machine?: string } = {}) =>
    w.children.adopt({ name: over.name ?? "lead", paneId: "w5:p1", ...(over.machine ? { machine: over.machine } : {}), cwd: "/work", task: "Review it" });

  it("awaits another agent's reply like a child's, then retires the record once it is acknowledged", async () => {
    const w = world();
    const rec = peer(w);
    expect(rec).toMatchObject({ name: "lead", where: "peer", peer: true, awaiting: false });
    expect(w.persisted).toEqual([]);
    await w.children.send("lead", "Review it", "steer");
    expect(w.f.of("agent.prompt")[0]!.params).toMatchObject({ target: "w5:p1", text: "Review it" });
    expect(w.holds).toEqual([["lead", true]]);
    expect(w.persisted.at(-1)).toMatchObject({ name: "lead", peer: true, awaiting: true });

    w.state.agent.agent_status = "working";
    await w.children.tick();
    w.state.agent.agent_status = "idle";
    w.state.agent.completion_seq = 9;
    await w.children.tick();
    expect(w.delivered).toHaveLength(1);
    expect(w.delivered[0]!.text).toContain('Agent "lead" (pane w5:p1) replied:');
    expect(w.delivered[0]!.reply).toBe("All done: 3 files changed.");
    expect(w.holds.at(-1)).toEqual(["lead", false]);

    w.children.acknowledge(rec);
    expect(w.children.records.has("lead")).toBe(false);
    expect(w.persisted.at(-1)).toMatchObject({ name: "lead", closed: true });
  });

  it("falls back to a labeled screen read when there is no session file to read", async () => {
    const w = world();
    // Another agent kind: herdr reports a session this host cannot read.
    Object.assign(w.state.agent, { agent: "codex", completion_seq: 1 });
    peer(w);
    await w.children.send("lead", "go", "steer");
    w.state.agent.agent_status = "working";
    await w.children.tick();
    w.state.agent.agent_status = "idle";
    w.state.agent.completion_seq = 2;
    await w.children.tick();
    expect(w.delivered[0]!.text).toContain("a screen read (no session file of it is read)");
    expect(w.delivered[0]!.text).toContain("working on it");
    expect(w.f.of("agent.read")[0]!.params).toMatchObject({ target: "w5:p1", source: "recent_unwrapped" });
  });

  it("awaits a peer on another machine through callFor, polling slowly, with a screen read", async () => {
    const w = world();
    const remote = fakeCall({
      "agent.get": () => ({ result: { agent: { ...w.state.agent, agent: "pi", agent_session: { kind: "path", value: "/nuc/s.jsonl" } } } }),
      "agent.prompt": () => ({ result: {} }),
      "agent.read": () => ({ result: { read: { text: "nuc screen" } } }),
    });
    const asked: string[] = [];
    (w.children as any).deps.callFor = (machine: string) => { asked.push(machine); return remote.call; };
    (w.children as any).deps.remotePollMs = 60_000;
    const rec = peer(w, { machine: "NUC" });
    expect(rec.name).toBe("NUC/lead");
    await w.children.send("NUC/lead", "go", "steer");
    expect(w.f.of("agent.get")).toEqual([]);
    expect(remote.of("agent.prompt")).toHaveLength(1);
    w.state.agent.agent_status = "working";
    await w.children.tick();
    await new Promise((r) => setTimeout(r, 5));
    w.state.agent.agent_status = "idle";
    w.state.agent.completion_seq = 3;
    // Polled once a poll interval, not on every tick.
    await w.children.tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(w.delivered).toHaveLength(0);
    (w.children as any).deps.remotePollMs = 0;
    await w.children.tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(w.delivered).toHaveLength(1);
    expect(w.delivered[0]!.text).toContain('Agent "NUC/lead" (pane w5:p1 on NUC)');
    expect(w.delivered[0]!.text).toContain("its session file is out of reach");
    expect(w.delivered[0]!.text).toContain("nuc screen");
    expect(asked.every((m) => m === "NUC")).toBe(true);
    // Its file path is the NUC's, never read here.
    expect(w.f.of("agent.get")).toEqual([]);
  });

  it("is told when the peer's pane closes before it replies", async () => {
    const w = world();
    peer(w);
    await w.children.send("lead", "go", "steer");
    w.state.paneGone = true;
    await w.children.tick();
    expect(w.delivered[0]!.text).toContain('Agent "lead" (pane w5:p1) was closed before it replied.');
    expect(w.children.records.get("lead")?.closed).toBe(true);
    w.children.acknowledge(w.children.records.get("lead")!);
    expect(w.children.records.has("lead")).toBe(false);
  });

  it("reports a machine that stays unreachable instead of awaiting forever", async () => {
    const w = world();
    (w.children as any).deps.callFor = () => async () => ({ error: { code: "machine", message: "ssh: no route" } });
    (w.children as any).deps.remotePollMs = 0;
    const rec = peer(w, { machine: "NUC" });
    rec.awaiting = true;
    (w.children as any).deps.hold(rec, true);
    for (let i = 0; i < 46; i++) {
      await w.children.tick();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(w.delivered[0]?.text).toContain("could not be reached for a while");
  });

  it("is never interrupted or closed from here, and a failed first prompt leaves no record", async () => {
    const w = world();
    const rec = peer(w);
    await expect(w.children.interrupt("lead")).rejects.toThrow("not a child of this session");
    await expect(w.children.close("lead")).rejects.toThrow("not a child of this session");
    w.state.agent.agent_status = "blocked";
    await expect(w.children.send("lead", "go", "steer")).rejects.toThrow("waiting on a dialog");
    w.children.discard(rec);
    expect(w.children.records.has("lead")).toBe(false);
    expect(w.persisted).toEqual([]);
  });

  it("reuses a peer's record for its pane, and refuses another pane while one is awaited", async () => {
    const w = world();
    const rec = peer(w);
    expect(peer(w)).toBe(rec);
    await w.children.send("lead", "go", "steer");
    expect(() => w.children.adopt({ name: "lead", paneId: "w9:p9", cwd: "/work", task: "x" })).toThrow("already tracked in another pane");
  });

  it("restores an awaited peer, and not a retired one", () => {
    const w = world();
    const live = { name: "lead", paneId: "w5:p1", where: "peer" as const, peer: true, cwd: "/work", task: "t", createdAt: 1, awaiting: true, baseline: { completionSeq: 1 } };
    const retired = { ...live, name: "old", paneId: "w6:p1", awaiting: false, closed: true };
    const pending = { ...retired, name: "gone", pendingReply: "it closed" };
    w.children.restore([live, retired, pending]);
    expect([...w.children.records.keys()]).toEqual(["lead", "gone"]);
    expect(w.holds).toEqual([["lead", true]]);
    w.children.shutdown();
  });

  it("lists a peer as one", async () => {
    const w = world();
    peer(w, { machine: "NUC" });
    (w.children as any).deps.callFor = () => async () => ({ result: { agent: { agent_status: "idle" } } });
    expect(await w.children.list()).toContain("peer on NUC");
  });
});
