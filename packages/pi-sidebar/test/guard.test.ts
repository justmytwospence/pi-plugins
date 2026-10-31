import { describe, expect, it } from "vitest";
import { findBlockedCommandSegment } from "../src/bash-policy.ts";
import { judgeCall, type GuardHost } from "../src/guard.ts";

function host(options: { probability?: number; jev?: boolean; tools?: Record<string, object>; guarded?: boolean } = {}) {
  const asked: Array<Record<string, unknown>> = [];
  const registry = options.jev === false
    ? undefined
    : {
        findOfType: () => ({ id: "jev" }),
        classify: async (_model: unknown, context: { state: Record<string, unknown> }) => {
          asked.push(context.state);
          return { answers: { q: { type: "bool", probability: options.probability ?? 0.01 } }, stopReason: "stop" };
        },
      };
  const value: GuardHost = {
    cwd: "/repo",
    registry,
    tool: (name) => (options.tools?.[name] ? ({ name, description: `${name} tool`, ...options.tools[name] } as never) : undefined),
    subagentsGuarded: () => options.guarded ?? true,
  };
  return { host: value, asked };
}

describe("judgeCall", () => {
  it("refuses tools that change files or shared state", async () => {
    for (const tool of ["edit", "write", "todo", "ask_user_question", "enter_plan_mode", "exit_plan_mode", "herdr", "herdr_child"]) {
      const verdict = await judgeCall(tool, {}, host().host);
      expect(verdict.allowed, tool).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toMatch(/read-only/);
    }
  });

  it("allows reading, web, codemode and its own background-job tools without asking Jev", async () => {
    const h = host();
    for (const tool of ["read", "grep", "find", "ls", "web_search", "fetch_content", "get_search_content", "source_check", "web_enable", "codemode", "tool_search", "bg_wait", "bg_logs", "sidebar_agents", "sidebar_transcript"]) {
      expect((await judgeCall(tool, {}, h.host)).allowed, tool).toBe(true);
    }
    expect(h.asked).toEqual([]);
  });

  it("follows MCP-style hints", async () => {
    const h = host({ tools: { mcp__db__query: { annotations: { readOnlyHint: true } }, mcp__db__drop: { annotations: { destructiveHint: true } } } });
    expect((await judgeCall("mcp__db__query", {}, h.host)).allowed).toBe(true);
    expect((await judgeCall("mcp__db__drop", {}, h.host)).allowed).toBe(false);
  });

  it("runs read-only shell commands, and asks Jev about the rest", async () => {
    const quiet = host({ probability: 0.9 });
    expect((await judgeCall("bash", { command: "rg -n -i durable docs 2>/dev/null | head" }, quiet.host)).allowed).toBe(true);
    expect(quiet.asked).toEqual([]);
    const refused = await judgeCall("bash", { command: "npm install" }, quiet.host);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reason).toMatch(/90% likely/);
    expect(quiet.asked[0]).toMatchObject({ tool: "bash", arguments: JSON.stringify({ command: "npm install" }) });
    const fine = host({ probability: 0.3 });
    expect((await judgeCall("bash", { command: "node --version" }, fine.host)).allowed).toBe(true);
  });

  it("judges background commands the same way", async () => {
    expect((await judgeCall("bg_run", { command: "rg foo src", kind: "job" }, host({ probability: 0.9 }).host)).allowed).toBe(true);
    expect((await judgeCall("bg_run", { command: "npm run build", kind: "job" }, host({ probability: 0.9 }).host)).allowed).toBe(false);
  });

  it("asks Jev about unfamiliar tools, and refuses when Jev is unavailable", async () => {
    expect((await judgeCall("mcp__notes__search", { q: "x" }, host({ probability: 0.02 }).host)).allowed).toBe(true);
    expect((await judgeCall("mcp__notes__create", { title: "x" }, host({ probability: 0.95 }).host)).allowed).toBe(false);
    const offline = await judgeCall("mcp__notes__search", {}, host({ jev: false }).host);
    expect(offline.allowed).toBe(false);
    if (!offline.allowed) expect(offline.reason).toMatch(/could not be confirmed/);
  });

  it("refuses process control and workflow authority regardless of hints or Jev", async () => {
    const tools = ["bg_kill", "ask_planner", "finish_plan", "continue_plan", "plan_ask_planner", "plan_submit_merged", "plan_mode_question", "plan_mode_complete"];
    const h = host({ probability: 0, tools: Object.fromEntries(tools.map((name) => [name, { annotations: { readOnlyHint: true } }])) });
    for (const tool of tools) expect((await judgeCall(tool, {}, h.host)).allowed, tool).toBe(false);
    expect(h.asked).toEqual([]);
  });

  it("keeps observational subagent calls without guard propagation but rejects controls deterministically", async () => {
    const h = host({ probability: 0, guarded: false, tools: { subagent: { annotations: { readOnlyHint: true } } } });
    for (const action of ["status", "result"]) expect((await judgeCall("subagent", { action, id: "child" }, h.host)).allowed).toBe(true);
    for (const action of ["steer", "stop", "resume", "unknown"]) expect((await judgeCall("subagent", { action, id: "child" }, h.host)).allowed).toBe(false);
    expect((await judgeCall("subagent", { task: "research" }, h.host)).allowed).toBe(false);
    expect(h.asked).toEqual([]);
  });

  it("refuses worktree creation for single, parallel and chained research", async () => {
    const h = host({ probability: 0 });
    for (const input of [{ task: "research", worktree: true }, { tasks: [{ task: "research", worktree: true }] }, { chain: [{ task: "research", worktree: true }] }]) {
      expect((await judgeCall("subagent", input, h.host)).allowed).toBe(false);
    }
    for (const input of [{ task: "research", worktree: false }, { tasks: [{ task: "research" }] }, { chain: [{ task: "research" }] }]) {
      expect((await judgeCall("subagent", input, h.host)).allowed).toBe(true);
    }
    expect(h.asked).toEqual([]);
  });

  it("starts subagents only when they will run under the same guard", async () => {
    expect((await judgeCall("subagent", { task: "find X" }, host({ guarded: true }).host)).allowed).toBe(true);
    expect((await judgeCall("subagent", { task: "find X" }, host({ guarded: false }).host)).allowed).toBe(false);
  });
});

describe("Sidebar's shell policy", () => {
  const allowed = (command: string) => findBlockedCommandSegment(command, {}, "/repo") === undefined;

  it("reads as freely as main", () => {
    for (const command of [
      'rg -n -i "durable" /opt/x/docs',
      'D=/opt/x; grep -rli "durable" $D/docs $D/README.md 2>/dev/null | head',
      "ls *.md",
      "cd packages && git log --oneline -3",
      "wc -l < README.md",
      "cat a 2>&1 | head",
      "ls $HOME",
    ]) expect(allowed(command), command).toBe(true);
  });

  it("still refuses changes, substitution and unknown variables", () => {
    for (const command of [
      "sed -i s/a/b/ f",
      "echo hi > out.txt",
      "echo hi >> out.txt",
      "echo $(rm -rf x)",
      "echo `id`",
      "rm -rf build",
      "grep x $UNKNOWN",
      "X=-delete; find . $X",
      "git commit -m x",
    ]) expect(allowed(command), command).toBe(false);
  });
});
