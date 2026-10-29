// Crews (src/crew.ts): the board from herdr's snapshot, the coordinator's update, the `crew`
// prompt section, claims and sync against a real git repository with worktrees, and index.ts's
// wiring with a fake pi and a fake herdr.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Children, type ChildRecord, type Exec } from "../src/core/children.ts";
import { board, Crew, CREW_MESSAGE, CrewWatch, crewDigest, MAX_DIGEST_LINES, parseWorktrees, type Repo, sectionText, SEEN_ENTRY, type Snapshot, syncCrew } from "../src/crew.ts";
import piHerdr from "../src/index.ts";
import { PI_CHILD } from "../src/session.ts";
import { fakeCall } from "./core/fake.ts";
import { remoteRepo } from "./git-fixture.ts";

const until = async (ok: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

const REPO: Repo = { common: "/r/.git", root: "/r", dir: "/r/.git/pi-crew" };
const TREES = parseWorktrees([
  "worktree /r", "HEAD 1", "branch refs/heads/main", "",
  "worktree /r/.worktrees/feature-a", "HEAD 2", "branch refs/heads/feature/a", "",
  "worktree /r/.worktrees/b", "HEAD 3", "detached", "",
].join("\n"));

const snap = (over: Partial<{ aStatus: string; aSeq: number; aSummary: string; pr: string }> = {}): Snapshot => ({
  workspaces: [
    { workspace_id: "w1", worktree: { checkout_path: "/r", repo_key: "/r/.git", is_linked_worktree: false } },
    { workspace_id: "w2", tokens: { pr: over.pr ?? "#12 draft" }, worktree: { checkout_path: "/r/.worktrees/feature-a", repo_key: "/r/.git", is_linked_worktree: true } },
    { workspace_id: "w3", worktree: { checkout_path: "/other", repo_key: "/other/.git" } },
  ],
  agents: [
    { name: "coord", agent: "pi", pane_id: "w1:p1", cwd: "/r", workspace_id: "w1", agent_status: "working", completion_seq: 5 },
    { name: "feat-a", agent: "pi", pane_id: "w2:p1", cwd: "/r/.worktrees/feature-a/src", workspace_id: "w2", agent_status: over.aStatus ?? "done", completion_seq: over.aSeq ?? 3, tokens: { summary: over.aSummary ?? "Added the parser" }, agent_session: { value: "/s/a.jsonl" } },
    { agent: "pi", pane_id: "w3:p1", cwd: "/other", workspace_id: "w3", agent_status: "idle" },
  ],
});

describe("board and digest", () => {
  it("parses worktrees and places agents by the longest checkout prefix, ignoring other repositories", () => {
    expect(TREES.map((t) => [t.path, t.branch, t.main])).toEqual([["/r", "main", true], ["/r/.worktrees/feature-a", "feature/a", false], ["/r/.worktrees/b", undefined, false]]);
    const rows = board(snap(), TREES, REPO);
    expect(rows.map((r) => [r.label, r.workspaceIds, r.pr, r.agents.map((a) => a.paneId)])).toEqual([
      ["main", ["w1"], undefined, ["w1:p1"]],
      ["feature/a", ["w2"], "#12 draft", ["w2:p1"]],
      ["b", [], undefined, []],
    ]);
    expect(rows[1]!.agents[0]).toMatchObject({ status: "idle", completionSeq: 3, summary: "Added the parser", session: "/s/a.jsonl" });
  });

  it("lists every worktree first, then only what changed, and nothing when nothing did", () => {
    const first = crewDigest(board(snap(), TREES, REPO), undefined)!;
    expect(first.text.split("\n")).toEqual([
      expect.stringContaining("[Crew status from pi-herdr, not the user"),
      "- feature/a (feat-a w2:p1, idle, #12 draft): Added the parser",
      "- b: no space and no agent; herdr action=crew op=sync starts its pi",
    ]);
    expect(crewDigest(board(snap(), TREES, REPO), first.seen)).toBeUndefined();
    const later = crewDigest(board(snap({ aSeq: 4, aSummary: "Rebased onto main", pr: "#12 ✓ approved" }), TREES, REPO), first.seen)!;
    expect(later.text.split("\n")).toEqual([
      expect.stringContaining("[Crew since your last turn"),
      "- feature/a (feat-a w2:p1, idle, #12 ✓ approved): Rebased onto main",
    ]);
    const gone = crewDigest(board(snap(), TREES.slice(0, 2), REPO), first.seen)!;
    expect(gone.text).toContain("- b: its worktree is gone");
  });

  it("caps an update and clips long lines", () => {
    const trees = [TREES[0]!, ...Array.from({ length: 20 }, (_, i) => ({ path: `/r/.worktrees/t${i}`, branch: `t${i}`, main: false }))];
    const d = crewDigest(board({ workspaces: [], agents: [{ agent: "pi", pane_id: "x:p1", cwd: "/r/.worktrees/t0", agent_status: "idle", tokens: { summary: "s".repeat(400) } }] }, trees, REPO), undefined)!;
    const lines = d.text.split("\n").slice(1);
    expect(lines).toHaveLength(MAX_DIGEST_LINES + 1);
    expect(lines.at(-1)).toContain("and 8 more");
    expect(lines[0]!.length).toBeLessThanOrEqual(160);
  });

  it("writes the section for the coordinator, a member and a repository without a crew", () => {
    expect(sectionText({ directivesPath: "/d.md", role: "none" })).toBeUndefined();
    expect(sectionText({ directives: "- Draft PRs only", directivesPath: "/d.md", role: "none" })).toContain("Directives for every session in this repository (/d.md");
    const member = sectionText({ directivesPath: "/d.md", role: "member", coordinator: { name: "r-coord", paneId: "w1:p1" } })!;
    expect(member).toContain('coordinated by the pi session "r-coord" (herdr pane w1:p1)');
    expect(member).toContain("do not report routine progress");
    const coordinator = sectionText({ directives: "- x", directivesPath: "/d.md", role: "coordinator" })!;
    expect(coordinator).toContain("You coordinate this repository's worktree sessions");
    expect(coordinator).toContain("directives file /d.md");
  });
});

/** A real repository with a main checkout and two worktrees under .worktrees/. */
function gitRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crew-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", ".worktrees/feature-a", "-b", "feature/a");
  git("worktree", "add", "-q", ".worktrees/b", "-b", "b");
  return { root, a: join(root, ".worktrees/feature-a"), b: join(root, ".worktrees/b"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const realExec: Exec = async (cmd, args, cwd) => {
  try {
    return { code: 0, stdout: execFileSync(cmd, args, { cwd, stdio: "pipe" }).toString(), stderr: "" };
  } catch (e: any) {
    return { code: typeof e.status === "number" ? e.status : 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? e.message) };
  }
};

/** A herdr with the coordinator (w1:p1) in the main checkout and a pi without a name in worktree a. */
function herdr(g: ReturnType<typeof gitRepo>) {
  const live = new Set(["w1:p1", "w2:p1"]);
  const agents: any[] = [
    { agent: "pi", pane_id: "w1:p1", cwd: g.root, workspace_id: "w1", agent_status: "idle", completion_seq: 1 },
    { agent: "pi", pane_id: "w2:p1", cwd: g.a, workspace_id: "w2", agent_status: "idle", completion_seq: 2, tokens: { summary: "Wrote tests" } },
  ];
  const f = fakeCall({
    "session.snapshot": () => ({ result: { snapshot: {
      workspaces: [
        { workspace_id: "w1", worktree: { checkout_path: g.root, repo_key: join(g.root, ".git") } },
        { workspace_id: "w2", worktree: { checkout_path: g.a, repo_key: join(g.root, ".git") } },
      ],
      agents: structuredClone(agents),
    } } }),
    "agent.get": (p) => (live.has(p.target) ? { result: { agent: structuredClone(agents.find((a) => a.pane_id === p.target)) ?? { agent: "pi", pane_id: p.target, cwd: g.root } } } : { error: { code: "not_found", message: "no agent" } }),
    "agent.list": () => ({ result: { agents: agents.filter((a) => a.name).map((a) => ({ name: a.name })) } }),
    "agent.rename": (p) => { const a = agents.find((x) => x.pane_id === p.target); if (a) a.name = p.name; return { result: {} }; },
    "worktree.open": () => ({ result: { already_open: false, workspace: { workspace_id: "w3" }, root_pane: { pane_id: "w3:p1" } } }),
    "agent.start": (p) => { agents.push({ name: p.name, agent: "pi", pane_id: p.pane_id, cwd: g.b, workspace_id: "w3", agent_status: "idle" }); live.add(p.pane_id); return { result: {} }; },
  });
  return { f, agents, live };
}

describe("claims, sections and sync in a git repository", () => {
  let g: ReturnType<typeof gitRepo>;
  beforeEach(() => { g = gitRepo(); });
  afterEach(() => g.cleanup());

  it("claims the crew, refuses a second live claimant without takeover, and gives members the link and directives", async () => {
    const h = herdr(g);
    const crew = new Crew({ call: h.f.call, exec: realExec, selfPane: "w1:p1" });
    const claimed = await crew.claim({ paneId: "w1:p1", session: "/s/coord.jsonl", cwd: g.root });
    expect(claimed.text).toContain("This session now coordinates");
    const file = JSON.parse(readFileSync(join(g.root, ".git/pi-crew/coordinator.json"), "utf8"));
    expect(file).toMatchObject({ paneId: "w1:p1", session: "/s/coord.jsonl", name: expect.stringMatching(/-coord$/u) });

    const other = new Crew({ call: h.f.call, exec: realExec, selfPane: "w2:p1" });
    await expect(other.claim({ paneId: "w2:p1", cwd: g.a })).rejects.toThrow(/already coordinates/u);

    writeFileSync(join(g.root, ".git/pi-crew/directives.md"), "- Draft PRs only; never request reviewers.\n");
    const member = await other.section({ paneId: "w2:p1", cwd: g.a });
    expect(member).toContain(`coordinated by the pi session "${file.name}" (herdr pane w1:p1)`);
    expect(member).toContain("- Draft PRs only; never request reviewers.");
    const coordinator = await crew.section({ paneId: "w1:p1", session: "/s/coord.jsonl", cwd: g.root });
    expect(coordinator).toContain("You coordinate this repository's worktree sessions");

    // The coordinator's pane is gone: members lose the link, keep the directives, and may take over.
    h.live.delete("w1:p1");
    const orphan = await new Crew({ call: h.f.call, exec: realExec, selfPane: "w2:p1" }).section({ paneId: "w2:p1", cwd: g.a });
    expect(orphan).not.toContain("coordinated by");
    expect(orphan).toContain("Draft PRs only");
  });

  it("reclaims the role for the same session in a new pane", async () => {
    const h = herdr(g);
    const crew = new Crew({ call: h.f.call, exec: realExec, selfPane: "w1:p1" });
    await crew.claim({ paneId: "w1:p1", session: "/s/coord.jsonl", cwd: g.root });
    expect(await crew.reclaim({ paneId: "w5:p1", session: "/s/coord.jsonl", cwd: g.root })).toBe(true);
    expect(JSON.parse(readFileSync(join(g.root, ".git/pi-crew/coordinator.json"), "utf8")).paneId).toBe("w5:p1");
    expect(await crew.reclaim({ paneId: "w6:p1", session: "/s/other.jsonl", cwd: g.root })).toBe(false);
  });

  it("syncs: attaches and names the pi already in one worktree, opens the other and resumes pi there", async () => {
    const h = herdr(g);
    const deps = { call: h.f.call, exec: realExec, selfPane: "w1:p1" };
    const crew = new Crew(deps);
    const children = new Children({ call: h.f.call, agent: PI_CHILD, selfPane: "w1:p1", exec: realExec, persist: () => undefined, deliver: () => undefined, hold: () => undefined, pollMs: 60_000, readyPollMs: 1 });
    const ops = { children: children.records, uniqueName: (w: string) => children.uniqueName(w), attach: (o: any) => children.attach(o), readyPollMs: 1 };
    const out = await syncCrew(crew, deps, { paneId: "w1:p1", cwd: g.root }, ops);
    expect(out).toContain("- feature/a: attached its pi as your child a (w2:p1, idle)");
    expect(out).toContain("- b: opened its space and resumed its latest pi session there as your child b (w3:p1)");
    expect(h.f.of("agent.rename").map((c) => c.params)).toContainEqual({ target: "w2:p1", name: "a" });
    expect(h.f.of("worktree.open")[0]!.params).toEqual({ cwd: g.root, path: g.b, focus: false });
    expect(h.f.of("agent.start")[0]!.params).toMatchObject({ name: "b", kind: "pi", pane_id: "w3:p1", args: ["--continue"] });
    expect([...children.records.values()].map((r: ChildRecord) => [r.name, r.paneId, r.where, r.branch]).sort()).toEqual([["a", "w2:p1", "worktree", "feature/a"], ["b", "w3:p1", "worktree", "b"]]);

    // Again: nothing new is opened or started.
    const again = await syncCrew(crew, deps, { paneId: "w1:p1", cwd: g.root }, ops);
    expect(again).toContain("already your child a");
    expect(again).toContain("already your child b");
    expect(h.f.of("agent.start")).toHaveLength(1);
  });
});

describe("index.ts wiring", () => {
  let g: ReturnType<typeof gitRepo>;
  beforeEach(() => {
    g = gitRepo();
    vi.stubEnv("HERDR_ENV", "1"); vi.stubEnv("HERDR_SOCKET_PATH", "/fixture/no-socket");
    vi.stubEnv("HERDR_PANE_ID", "w1:p1"); vi.stubEnv("PI_HERDR_PR", "0");
  });
  afterEach(() => { g.cleanup(); vi.unstubAllEnvs(); });

  function harness(cwd: string) {
    const manager = SessionManager.inMemory(cwd);
    const handlers = new Map<string, Array<(e: any, c: any) => unknown>>();
    const bus = createEventBus();
    let tool: any;
    const pi = {
      on: (event: string, fn: any) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]); return () => undefined; },
      events: { on: bus.on, emit: (channel: string, data: unknown) => bus.emit(channel, data) },
      appendEntry: (customType: string, data: unknown) => { manager.appendCustomEntry(customType, structuredClone(data)); },
      sendMessage: () => undefined,
      registerTool: (t: any) => { tool = t; },
      getActiveTools: () => [], setActiveTools: () => undefined, getThinkingLevel: () => "medium", getSessionName: () => undefined,
    };
    const ctx = { mode: "tui", hasUI: true, cwd, model: { id: "m" }, ui: { notify: () => undefined }, sessionManager: manager, isIdle: () => true };
    const emit = async (event: string, payload: any = {}) => {
      const out: any[] = [];
      for (const fn of handlers.get(event) ?? []) out.push(await fn(payload, ctx));
      return out;
    };
    const prompt = async (messageType: "user" | "custom" = "user") => {
      const event = { type: "before_agent_start", messageType, prompt: "where we at?", systemPromptOptions: { sections: {} as Record<string, string> } };
      const [result] = await emit("before_agent_start", event);
      return { result, section: event.systemPromptOptions.sections.crew };
    };
    return { pi: pi as unknown as ExtensionAPI, manager, emit, prompt, tool: () => tool, ctx };
  }

  it("crew sync makes this session the coordinator; its prompts then carry one update per change, and members get the link", async () => {
    const h = herdr(g);
    const p = harness(g.root);
    piHerdr(p.pi, { call: h.f.call, exec: realExec, pollMs: 1 });
    await p.emit("session_start");
    expect((await p.prompt()).section).toBeUndefined();

    const synced = await p.tool().execute("1", { action: "crew", op: "sync" }, undefined, undefined, p.ctx);
    expect(synced.content[0].text).toContain("This session now coordinates");

    const first = await p.prompt();
    expect(first.section).toContain("You coordinate this repository's worktree sessions");
    expect(first.result).toMatchObject({ message: { customType: CREW_MESSAGE, display: true } });
    expect(first.result.message.content).toContain("- feature/a (a w2:p1, idle): Wrote tests");
    expect(p.manager.getBranch().some((e: any) => e.type === "custom" && e.customType === SEEN_ENTRY)).toBe(true);

    expect((await p.prompt()).result).toBeUndefined();
    h.agents[1]!.completion_seq = 3;
    h.agents[1]!.tokens.summary = "Opened PR #7";
    // A run a child's reply starts gets no update; the user's next prompt does.
    expect((await p.prompt("custom")).result).toBeUndefined();
    const next = (await p.prompt()).result.message.content as string;
    expect(next.split("\n").slice(1)).toEqual(["- feature/a (a w2:p1, idle): Opened PR #7"]);

    const status = await p.tool().execute("2", { action: "crew" }, undefined, undefined, p.ctx);
    expect(status.content[0].text).toContain("this session coordinates it");
    expect(status.content[0].text).toContain("[child]");

    // A member session in worktree a gets the coordinator link in its prompt.
    vi.stubEnv("HERDR_PANE_ID", "w2:p1");
    const m = harness(g.a);
    piHerdr(m.pi, { call: h.f.call, exec: realExec, pollMs: 1 });
    await m.emit("session_start");
    const member = await m.prompt();
    expect(member.section).toContain("(herdr pane w1:p1)");
    expect(member.result).toBeUndefined();
    await m.emit("session_shutdown");
    await p.emit("session_shutdown");
  });
});

describe("drift and overlap in the crew", () => {
  it("puts a worktree's drift on its line and new overlaps on their own lines, once", () => {
    const s = snap();
    s.workspaces![1]!.tokens = { pr: "#12 draft", drift: "↓2 main · 1 overlap" };
    const overlaps = [{ a: "feature/a", b: "b", files: ["x.js"] }];
    const first = crewDigest(board(s, TREES, REPO), undefined, overlaps)!;
    expect(first.text).toContain("- feature/a (feat-a w2:p1, idle, #12 draft, ↓2 main · 1 overlap): Added the parser");
    expect(first.text).toContain("- overlap: feature/a ↔ b: 1 shared file (x.js)");
    expect(crewDigest(board(s, TREES, REPO), first.seen, overlaps)).toBeUndefined();
    const worse = crewDigest(board(s, TREES, REPO), first.seen, [{ ...overlaps[0]!, conflicts: ["x.js"] }])!;
    expect(worse.text.split("\n").slice(1)).toEqual(["- overlap: feature/a ↔ b: would conflict in x.js"]);
    // An overlap that went away is dropped silently, never reported as a gone worktree.
    expect(crewDigest(board(s, TREES, REPO), worse.seen, [])).toBeUndefined();
  });
});

describe("CrewWatch", () => {
  let r: ReturnType<typeof remoteRepo>;
  beforeEach(() => { r = remoteRepo(); });
  afterEach(() => r.cleanup());

  function watch(extra: Partial<ConstructorParameters<typeof CrewWatch>[0]> = {}) {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args, cwd) => { calls.push([cmd, ...args]); return realExec(cmd, args, cwd); };
    const f = fakeCall({ "session.snapshot": () => ({ result: { snapshot: { workspaces: [], agents: [] } } }) });
    const crew = new Crew({ call: f.call, exec, selfPane: "w1:p1" });
    const repo: Repo = { common: r.common, root: r.root, dir: join(r.common, "pi-crew") };
    let push: ((e: any) => void) | undefined;
    const w = new CrewWatch({ crew, repo, exec, remoteMs: 0, minFetchGapMs: 0, debounceMs: 50, subscribe: (onEvent) => { push = onEvent; return { close: () => undefined }; }, ...extra });
    const fetches = () => calls.filter((c) => c[1] === "fetch");
    return { w, calls, fetches, push: (e: any) => push!(e) };
  }
  const ws = (pr: string) => ({ event: "workspace_metadata_updated", data: { workspace: { workspace_id: "w2", tokens: { pr }, worktree: { repo_key: r.common, is_linked_worktree: true, checkout_path: r.a } } } });

  it("fetches when a crew PR turns merged, not on other metadata", async () => {
    const x = watch();
    x.push(ws("#1 ✓ approved"));
    x.push(ws("#1 ✓ approved"));
    x.push({ event: "workspace_metadata_updated", data: { workspace: { workspace_id: "w9", tokens: { pr: "#9 merged" }, worktree: { repo_key: "/elsewhere/.git" } } } });
    await new Promise((res) => setTimeout(res, 50));
    expect(x.fetches()).toHaveLength(0);
    x.push(ws("#1 merged"));
    await until(() => x.fetches().length === 1);
    expect(x.fetches()[0]).toEqual(["git", "fetch", "--quiet", "--no-tags", "origin", "main"]);
    x.w.close();
  });

  it("checks the remote cheaply and fetches only when a base moved", async () => {
    const x = watch();
    expect(await x.w.checkRemote()).toBe(false);
    expect(x.calls.some((c) => c[1] === "ls-remote")).toBe(true);
    expect(x.fetches()).toHaveLength(0);
    r.upstream("other.txt", "moved\n", "upstream move", false);
    expect(await x.w.checkRemote()).toBe(true);
    expect(x.fetches()).toHaveLength(1);
    expect(await x.w.checkRemote()).toBe(false);
    x.w.close();
  });

  it("recomputes sibling overlaps when a branch moves", async () => {
    const seen: number[] = [];
    const x = watch({ onOverlaps: (o) => seen.push(o.length) });
    await until(() => seen.length >= 1);
    expect(x.w.overlaps).toEqual([]);
    r.commit(r.a, "shared.txt", "one\nA\nthree\n");
    r.commit(r.b, "shared.txt", "one\nB\nthree\n");
    // The fake snapshot has no spaces, so rows come from git worktree list with the default base.
    await until(() => x.w.overlaps.length === 1, 4_000);
    expect(x.w.overlaps[0]).toMatchObject({ a: "a", b: "b", files: ["shared.txt"] });
    x.w.close();
  });
});

describe("drift in a worktree session (index.ts)", () => {
  let r: ReturnType<typeof remoteRepo>;
  beforeEach(() => {
    r = remoteRepo();
    vi.stubEnv("HERDR_ENV", "1"); vi.stubEnv("HERDR_SOCKET_PATH", "/fixture/no-socket");
    vi.stubEnv("HERDR_PANE_ID", "w2:p1"); vi.stubEnv("PI_HERDR_PR", "0");
  });
  afterEach(() => { r.cleanup(); vi.unstubAllEnvs(); });

  it("shows drift on its space and gets one passive note when the base moves under its files", async () => {
    mkdirSync(join(r.common, "pi-crew"), { recursive: true });
    r.commit(r.a, "shared.txt", "one\nTWO-a\nthree\n");
    const f = fakeCall({ "pane.get": (p) => ({ result: { pane: { pane_id: p.pane_id, workspace_id: "w2" } } }) });
    const manager = SessionManager.inMemory(r.a);
    const handlers = new Map<string, Array<(e: any, c: any) => unknown>>();
    const sent: any[] = [];
    const bus = createEventBus();
    const pi = {
      on: (event: string, fn: any) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]); return () => undefined; },
      events: { on: bus.on, emit: (c: string, d: unknown) => bus.emit(c, d) },
      appendEntry: (t: string, d: unknown) => { manager.appendCustomEntry(t, structuredClone(d)); },
      sendMessage: (message: any, options: any) => sent.push({ message, options }),
      registerTool: () => undefined,
      getActiveTools: () => [], setActiveTools: () => undefined, getThinkingLevel: () => "medium", getSessionName: () => undefined,
    };
    const ctx = { mode: "tui", hasUI: true, cwd: r.a, model: { id: "m" }, ui: { notify: () => undefined }, sessionManager: manager, isIdle: () => true };
    const emit = async (event: string, payload: any = {}) => { for (const fn of handlers.get(event) ?? []) await fn(payload, ctx); };
    piHerdr(pi as unknown as ExtensionAPI, { call: f.call, exec: realExec, pollMs: 1 });
    await emit("session_start");
    const driftTokens = () => f.of("workspace.report_metadata").filter((c) => c.params.tokens && "drift" in c.params.tokens).map((c) => c.params.tokens.drift);
    await until(() => f.of("workspace.report_metadata").some((c) => c.params.tokens?.crew_base === "main"));
    expect(sent).toHaveLength(0);

    r.upstream("other.txt", "y\n");
    await until(() => driftTokens().includes("↓1 main"), 5_000);
    expect(sent).toHaveLength(0); // behind, but not on its files: the token only

    r.upstream("shared.txt", "one\nTWO-main\nthree\n");
    await until(() => sent.length === 1, 5_000);
    expect(sent[0].options).toEqual({ deliverAs: "nextTurn" });
    expect(sent[0].message.customType).toBe("herdr-drift");
    expect(sent[0].message.content).toContain("shared.txt");
    expect(driftTokens().at(-1)).toMatch(/^↓2 main (✗ conflict|· 1 overlap)$/u);

    // The same upstream again (its own turn ending) is not a second note.
    await emit("agent_settled");
    await new Promise((res) => setTimeout(res, 2_000));
    expect(sent).toHaveLength(1);
    await emit("session_shutdown");
  }, 15_000);
});
