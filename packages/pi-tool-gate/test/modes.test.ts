import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isAcceptEditsBash } from "../src/bash.ts";
import toolGate from "../src/index.ts";
import {
  APPROVAL_ENTRY, MODE_CHANGED, MODE_CYCLE, MODE_ENTRY, MODE_SET, MODE_STATUS_KEY,
  nextApproval, nextWorkflow, parseApproval, parseLegacyCombinedMode, parseWorkflow, PLAN_PROVIDER,
  restoreBranchModes, workflowCycle, workflowStatus, modeStatus, WORKFLOW_CHANGED, WORKFLOW_CYCLE,
  WORKFLOW_ENTRY, WORKFLOW_QUERY, WORKFLOW_SET, WORKFLOW_STATUS_KEY,
  type WorkflowSetRequest, type WorkflowCycleRequest,
} from "../src/modes.ts";
import { queryFooterActions } from "../src/footer-actions.ts";
import { SETTINGS_CYCLE_CHANNEL, settingsCycles } from "../src/settings-cycle.ts";
import { declareReadOnlyCalls } from "../src/read-only-call.ts";
import { fakeJev, harness, userEntry } from "./harness.ts";
import { PROMPTING_ENTRY, PROMPTING_STATUS_KEY } from "../src/prompting.ts";
import { inheritedModes, PROMPTING_ENV, subagentEnv } from "../src/subagent-env.ts";

const approvalsQuestion = (state: "on" | "off") => `Approvals · Permission prompts: ${state}\n/gate prompts default restores inherited/config policy.`;

let configDir: string;
beforeEach(() => {
  configDir = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-tool-gate-modes-")));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(configDir, "xdg"));
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(configDir, "pi"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});
const safe = {
  requested: { type: "bool", probability: 0.1 },
  in_scope: { type: "bool", probability: 0.95 }, irreversible: { type: "bool", probability: 0.05 },
  remote_change: { type: "bool", probability: 0.02 }, exfiltration: { type: "bool", probability: 0.01 },
  impact: { type: "score", score: 1, confidence: 0.9 },
  // The workflows' read check for commands the parser cannot follow: these tests' commands write.
  only_reads: { type: "bool", probability: 0.05 },
  // The scoped plan workflow's check: these tests' commands may change the repository.
  leaves_repo_unchanged: { type: "bool", probability: 0.05 },
};
const call = (toolName: string, input: Record<string, unknown>, id = "t1") => ({ type: "tool_call", toolCallId: id, toolName, input });
const entry = (customType: string, data: Record<string, unknown>) => ({ type: "custom", customType, data });
const defaults = { workflow: "work", approval: "auto" } as const;
const workflowOf = (ctx: { ui: { status: Map<string, string | undefined> } }) => /^workflow: (\w+)/u.exec(ctx.ui.status.get(WORKFLOW_STATUS_KEY) ?? "")?.[1];
function configure(config: Record<string, unknown>) {
  mkdirSync(path.join(configDir, "xdg", "agents"), { recursive: true });
  writeFileSync(path.join(configDir, "xdg", "agents", "tool-gate.json"), JSON.stringify(config));
}
function setup(branch: any[] = [userEntry("Fix the failing test")], answers: any = safe, exec?: (cmd: string, args: string[]) => any) {
  const cwd = path.join(configDir, "app");
  mkdirSync(cwd, { recursive: true });
  const h = harness({ nonGitCwd: cwd, ...(exec ? { exec } : {}) });
  toolGate(h.pi);
  const jev = fakeJev((questions) => (typeof answers === "function" ? answers(questions) : answers));
  const ctx = h.ctx({ cwd, modelRegistry: jev.registry, sessionManager: {
    getBranch: () => branch, getSessionId: () => "modes-session", getLeafId: () => null,
  } });
  return { h, jev, ctx, branch };
}
const start = async (s: ReturnType<typeof setup>) => { await s.h.emit("session_start", { type: "session_start" }, s.ctx); return s; };

test.each(["auto", "manual", "accept-edits", "yolo"])("missing classifier preserves %s approval semantics", async (mode) => {
  const s = await start(setup());
  s.ctx.modelRegistry = undefined;
  await s.h.commands.get("approvals").handler(mode, s.ctx);
  const result = await s.h.emit("tool_call", call("bash", { command: "npm publish" }), s.ctx);
  if (mode === "yolo") expect(result).toBeUndefined();
  else expect(result).toMatchObject({ block: true });
  expect(s.ctx.ui.selects).toHaveLength(mode === "manual" || mode === "accept-edits" ? 1 : 0);
  expect(s.jev.calls).toHaveLength(0);
});

test.each(["chat", "plan", "work"])("missing classifier in %s workflow never silently permits mutations", async (mode) => {
  const s = await start(setup());
  s.ctx.modelRegistry = undefined;
  s.h.pi.events.emit(PLAN_PROVIDER, { available: true, planFile: "/tmp/test-plan.md" });
  await s.h.commands.get("mode").handler(mode, s.ctx);
  expect(await s.h.emit("tool_call", call("bash", { command: "npm publish" }), s.ctx)).toMatchObject({ block: true });
});

describe("independent mode helpers and protocol", () => {
  test("parsers keep legacy migration explicit and never accept the removed exec workflow", () => {
    for (const [input, output] of [["manual", "default"], ["accept-edits", "acceptEdits"], ["acceptEdits", "acceptEdits"], ["yolo", "bypassPermissions"], ["bypass", "bypassPermissions"], ["auto", "auto"]]) {
      expect(parseApproval(input)).toBe(output);
      expect(parseLegacyCombinedMode(input)).toBe(output);
    }
    for (const value of ["chat", "plan"]) {
      expect(parseLegacyCombinedMode(value)).toBe(value);
      expect(parseApproval(value)).toBeUndefined();
    }
    for (const value of ["work", "chat", "plan"]) expect(parseWorkflow(value)).toBe(value);
    for (const value of ["exec", "yolo", "nope", undefined, null, 1]) expect(parseWorkflow(value)).toBeUndefined();
    expect(parseApproval("nope")).toBeUndefined();
  });
  test("workflow and approval cycles never synthesize legacy approvals", () => {
    expect(workflowCycle(true)).toEqual(["work", "chat", "plan"]);
    expect(workflowCycle(false)).toEqual(["work", "chat"]);
    expect(nextWorkflow("work", true)).toBe("chat");
    expect(nextWorkflow("chat", true)).toBe("plan");
    expect(nextWorkflow("plan", true)).toBe("work");
    expect(nextWorkflow("chat", false)).toBe("work");
    expect(nextWorkflow("plan", false)).toBe("work");
    expect(nextApproval("auto")).toBe("bypassPermissions");
    for (const mode of ["bypassPermissions", "default", "acceptEdits"] as const) expect(nextApproval(mode)).toBe("auto");
  });
  test("exact event, durable-entry and status keys", () => {
    expect([WORKFLOW_SET, WORKFLOW_CYCLE, WORKFLOW_CHANGED, PLAN_PROVIDER, WORKFLOW_QUERY]).toEqual([
      "workflow-mode:set", "workflow-mode:cycle", "workflow-mode:changed", "workflow-mode:plan-provider", "workflow-mode:query",
    ]);
    expect([MODE_SET, MODE_CYCLE, MODE_CHANGED]).toEqual(["permission-mode:set", "permission-mode:cycle", "permission-mode:changed"]);
    expect([WORKFLOW_ENTRY, APPROVAL_ENTRY, MODE_ENTRY, WORKFLOW_STATUS_KEY, MODE_STATUS_KEY]).toEqual([
      "tool-gate:workflow", "tool-gate:approvals", "tool-gate:mode", "workflow-mode", "permission-mode",
    ]);
    expect(workflowStatus("work", "shift+tab")).toBe("workflow: work (shift+tab to cycle)");
    expect(workflowStatus("plan", undefined)).toBe("workflow: plan");
    expect(modeStatus("auto", "alt+a")).toBe("⏵⏵ auto mode on (alt+a to cycle)");
    expect(modeStatus("bypassPermissions", undefined)).toBe("⏵⏵ yolo mode on");
    expect(modeStatus("default", undefined)).toContain("manual (legacy)");
    expect(modeStatus("acceptEdits", undefined)).toContain("accept edits (legacy)");
  });
});

describe("chronological branch migration", () => {
  test("old plan/chat preserve the preceding restrictive or yolo approval", () => {
    for (const approval of ["default", "acceptEdits", "bypassPermissions"] as const) {
      expect(restoreBranchModes([entry(MODE_ENTRY, { mode: approval }), entry(MODE_ENTRY, { mode: "plan" }), entry(MODE_ENTRY, { mode: "chat" })], defaults)).toEqual({ ...defaults, workflow: "chat", approval });
    }
    expect(restoreBranchModes([entry(MODE_ENTRY, { mode: "chat" }), entry(MODE_ENTRY, { mode: "manual" })], defaults)).toEqual({ ...defaults, approval: "default" });
  });
  test("new records affect one axis only, interleaved with old and inline records", () => {
    const records = [entry(MODE_ENTRY, { mode: "yolo" }), entry("plan-mode:inline", { active: true }), entry(APPROVAL_ENTRY, { version: 1, mode: "default" }), entry(WORKFLOW_ENTRY, { version: 1, mode: "chat" }), entry("plan-mode:inline", { active: false })];
    expect(restoreBranchModes(records, defaults)).toEqual({ ...defaults, workflow: "chat", approval: "default" });
    records.push(entry("plan-mode:inline", { active: true }), entry("plan-mode:inline", { active: false }));
    expect(restoreBranchModes(records, defaults).workflow).toBe("work");
  });
  test("plan-mode:exec records no longer overlay or end a workflow", () => {
    const records = [entry(WORKFLOW_ENTRY, { version: 1, mode: "plan" }), entry(APPROVAL_ENTRY, { version: 1, mode: "bypassPermissions" })];
    const exec = [entry("plan-mode:exec", { active: true }), entry("plan-mode:exec", { active: false })];
    expect(restoreBranchModes([...records, ...exec], defaults)).toEqual({ workflow: "plan", approval: "bypassPermissions" });
    expect(restoreBranchModes([...exec, ...records], defaults)).toEqual({ workflow: "plan", approval: "bypassPermissions" });
  });
  test("invalid records cannot escalate permissions and supplied defaults are not mutated", () => {
    const restrictive = { workflow: "chat", approval: "default" } as const;
    const records = [null, {}, entry(MODE_ENTRY, { mode: "invalid" }), entry(WORKFLOW_ENTRY, { version: 1, mode: "exec" }), entry(APPROVAL_ENTRY, { version: 2, mode: "bypassPermissions" }), entry(APPROVAL_ENTRY, { version: 1, mode: "yolo" }), entry("plan-mode:exec", { active: "true" })];
    expect(restoreBranchModes(records, restrictive)).toEqual(restrictive);
    expect(restoreBranchModes([], restrictive)).not.toBe(restrictive);
  });
});

describe("isAcceptEditsBash", () => {
  const cwd = "/Users/me/Projects/app";
  test("filesystem commands inside the project", () => {
    for (const command of ["mkdir -p src/new && touch src/new/a.ts", "mv src/a.ts src/b.ts", "sed -i 's/a/b/' src/a.ts", "rm -rf build && ls"]) expect(isAcceptEditsBash(command, cwd)).toBe(true);
  });
  test("anything else, or a file outside the project, is not covered", () => {
    for (const command of ["npm install", "cp src/a.ts /tmp/a.ts", "cd /tmp && touch x", "rm -rf .", "touch .env", "sed -i 's/a/b/w out' src/a.ts", "touch $(echo x)", "echo hi > src/a.ts"]) expect(isAcceptEditsBash(command, cwd)).toBe(false);
  });
});

describe("workflow and approval ownership", () => {
  test("new sessions publish work and auto on independent keys and events", async () => {
    const { h, ctx } = await start(setup());
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toBe("workflow: work (shift+tab to cycle)");
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toBe("⏵⏵ auto mode on (alt+a to cycle)");
    expect(h.shortcuts.get("shift+tab").description).toBe("Cycle workflow (work, chat, plan)");
    expect(h.shortcuts.get("alt+a").description).toBe("Toggle approvals (auto, yolo)");
    expect(h.events.filter(e => e.channel === WORKFLOW_CHANGED).at(-1)?.data).toMatchObject({ mode: "work", cycle: ["work", "chat"], source: "restore" });
    expect(h.events.filter(e => e.channel === MODE_CHANGED).at(-1)?.data).toMatchObject({ mode: "auto", cycle: ["auto", "bypassPermissions"] });
  });
  test("independent shortcuts persist only their axis; provider adds plan", async () => {
    const { h, ctx } = await start(setup());
    await h.shortcuts.get("alt+a").handler(ctx);
    await settingsCycles(h.pi).flush();
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plan.md" });
    for (const mode of ["chat", "plan", "work"]) {
      await h.shortcuts.get("shift+tab").handler(ctx);
      await settingsCycles(h.pi).flush();
      expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain(`workflow: ${mode}`);
      expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("yolo");
    }
    expect(h.entries.filter(e => e.customType === WORKFLOW_ENTRY).map(e => e.data)).toEqual(["chat", "plan", "work"].map(mode => ({ version: 1, mode })));
    expect(h.entries.filter(e => e.customType === APPROVAL_ENTRY).map(e => e.data)).toEqual([{ version: 1, mode: "bypassPermissions" }]);
    expect(h.entries.some(e => e.customType === MODE_ENTRY)).toBe(false);
    const change = h.events.filter(e => e.channel === WORKFLOW_CHANGED).at(-1)?.data;
    expect(change).toMatchObject({ mode: "work", previous: "plan", cycle: ["work", "chat", "plan"], source: "transition" });
    expect(h.events.filter(e => e.channel === MODE_CHANGED).at(-1)?.data).not.toHaveProperty("prePlanMode");
  });
  test("without a provider plan is refused and absent from cycling", async () => {
    const { h, ctx } = await start(setup());
    await h.commands.get("mode").handler("plan", ctx);
    expect(ctx.ui.notes.at(-1)?.message).toMatch(/needs pi-plan-mode/u);
    for (const mode of ["chat", "work"]) {
      h.pi.events.emit(WORKFLOW_CYCLE, {});
      await settingsCycles(h.pi).flush();
      expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain(`workflow: ${mode}`);
    }
    h.pi.events.emit(MODE_SET, { mode: "plan" });
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("work");
  });
  test("commands and events select independent axes, including compatibility aliases", async () => {
    const { h, ctx } = await start(setup());
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plan.md" });
    for (const workflow of ["chat", "plan", "work"]) {
      await h.commands.get("mode").handler(workflow, ctx);
      expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain(`workflow: ${workflow}`);
    }
    h.pi.events.emit(WORKFLOW_SET, { mode: "chat" });
    for (const command of ["mode", "approvals"]) {
      for (const [alias, label] of [["yolo", "yolo"], ["manual", "manual (legacy)"], ["accept-edits", "accept edits (legacy)"], ["auto", "auto"]]) {
        await h.commands.get(command).handler(alias, ctx);
        expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain(label);
        expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("chat");
      }
    }
    h.pi.events.emit(MODE_CYCLE, {});
    await settingsCycles(h.pi).flush();
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("yolo");
    await h.commands.get("gate").handler("on", ctx);
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("auto");
    await h.commands.get("gate").handler("off", ctx);
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("chat");
  });
  test("bare pickers have undecorated short rows and use the blocked helper", async () => {
    const { h, ctx } = await start(setup());
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plan.md" });
    for (const [command, options, answer] of [["mode", ["Work", "Chat", "Plan"], "Chat"], ["approvals", ["Auto", "Yolo", "Turn permission prompts off"], "Yolo"]] as const) {
      ctx.ui.selectAnswers.push(answer);
      const before = h.events.length;
      await h.commands.get(command).handler("", ctx);
      expect(ctx.ui.selects.at(-1)?.title).toBe(command === "mode" ? "Workflow" : approvalsQuestion("on"));
      expect(ctx.ui.selects.at(-1)?.options).toEqual(options);
      expect(h.events.slice(before).filter(e => e.channel === "herdr:blocked").map(e => e.data.active)).toEqual([true, false]);
    }
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("chat");
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("yolo");
  });
  test("no-UI commands reply with status and usage rather than opening pickers", async () => {
    const s = setup(); s.ctx.hasUI = false;
    await start(s);
    for (const command of ["mode", "approvals"]) await s.h.commands.get(command).handler("", s.ctx);
    expect(s.ctx.ui.selects).toHaveLength(0);
    const replies = JSON.stringify([...s.ctx.ui.notes, ...s.h.messages]);
    expect(replies).toMatch(/\/mode/u);
    expect(replies).toMatch(/\/approvals/u);
  });
  test("session_tree restores only the active branch, retaining provider availability", async () => {
    const { h, ctx, branch } = await start(setup([entry(MODE_ENTRY, { mode: "yolo" }), entry(MODE_ENTRY, { mode: "plan" })]));
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plan.md" });
    branch.splice(0, branch.length, entry(APPROVAL_ENTRY, { version: 1, mode: "default" }), entry(WORKFLOW_ENTRY, { version: 1, mode: "chat" }));
    await h.emit("session_tree", { type: "session_tree" }, ctx);
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("chat");
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("manual (legacy)");
    await h.shortcuts.get("shift+tab").handler(ctx);
    await settingsCycles(h.pi).flush();
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("plan");
    branch.push(entry("plan-mode:exec", { active: true }));
    await h.emit("session_tree", { type: "session_tree" }, ctx);
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("chat");
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("manual (legacy)");
  });
});

describe("restore snapshots and destination queries", () => {
  test("factory-time query uses destination cwd defaults synchronously without side effects", async () => {
    const cwd = path.join(configDir, "destination");
    mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    writeFileSync(path.join(cwd, ".pi", "tool-gate.json"), JSON.stringify({ defaultWorkflow: "chat", defaultApproval: "manual" }));
    const { h, ctx } = setup();
    const reply = vi.fn();
    const query = (entries: unknown[]) => h.pi.events.emit(WORKFLOW_QUERY, { entries, cwd, reply });
    query([]);
    expect(reply).toHaveBeenLastCalledWith({ mode: "chat", cycle: ["work", "chat"], key: "shift+tab", source: "restore" });
    query([entry("plan-mode:exec", { active: true })]);
    expect(reply.mock.calls.at(-1)?.[0].mode).toBe("chat");
    expect(h.entries).toHaveLength(0);
    expect(h.events.every(event => event.channel === WORKFLOW_QUERY || (event.channel === SETTINGS_CYCLE_CHANNEL && event.data.type === "discover"))).toBe(true);
    expect(ctx.ui.notes).toHaveLength(0);
    expect(ctx.ui.status.size).toBe(0);
    await h.emit("session_start", {}, ctx);
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("work");
    await h.commands.get("mode").handler("chat", ctx);
    const before = { entries: h.entries.length, messages: h.messages.length, notes: ctx.ui.notes.length };
    query([entry(WORKFLOW_ENTRY, { version: 1, mode: "plan" })]);
    expect(reply.mock.calls.at(-1)?.[0].mode).toBe("plan");
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("chat");
    expect({ entries: h.entries.length, messages: h.messages.length, notes: ctx.ui.notes.length }).toEqual(before);
    expect(h.events.at(-1)?.channel).toBe(WORKFLOW_QUERY);
  });
});

describe("settings cycle previews", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("workflow and approval shortcuts share one trailing deadline with no intermediate effects", async () => {
    const { h, ctx } = await start(setup());
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plan.md" });
    const events = h.events.length;
    await h.shortcuts.get("shift+tab").handler(ctx);
    expect(settingsCycles(h.pi).snapshot()).toMatchObject({ phase: "pending", settings: [
      { key: "workflow", baseline: "work", target: "chat", actual: "work" },
    ] });
    await vi.advanceTimersByTimeAsync(300);
    await h.shortcuts.get("shift+tab").handler(ctx);
    await h.shortcuts.get("alt+a").handler(ctx);
    await vi.advanceTimersByTimeAsync(399);
    expect(workflowOf(ctx)).toBe("work");
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("auto");
    expect(h.entries.filter(e => [WORKFLOW_ENTRY, APPROVAL_ENTRY].includes(e.customType))).toEqual([]);
    expect(h.events.slice(events).filter(e => [WORKFLOW_CHANGED, MODE_CHANGED].includes(e.channel))).toEqual([]);
    expect(h.messages).toEqual([]);
    expect(h.entries.filter(e => e.customType === "settings:cycle")).toHaveLength(1);
    expect(h.entries.filter(e => e.customType === "settings:cycle-state").length).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(workflowOf(ctx)).toBe("plan");
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("yolo");
    expect(h.entries.filter(e => e.customType === WORKFLOW_ENTRY)).toEqual([
      { customType: WORKFLOW_ENTRY, data: { version: 1, mode: "plan" } },
    ]);
    expect(h.events.slice(events).filter(e => e.channel === WORKFLOW_CHANGED && e.data.source === "transition")).toHaveLength(1);
    expect(h.messages.filter(({ message }) => message.customType === "workflow:transition")).toEqual([]);
    expect(settingsCycles(h.pi).snapshot()?.phase).toBe("applied");
  });

  test("event callers get a synchronously assigned promise for the final burst, including no-op", async () => {
    const { h, ctx } = await start(setup());
    const first: WorkflowCycleRequest = {};
    const second: WorkflowCycleRequest = {};
    const approvals: { result?: Promise<boolean> }[] = [{}, {}];
    h.pi.events.emit(WORKFLOW_CYCLE, first);
    let settled = false;
    void first.result!.then(() => { settled = true; });
    h.pi.events.emit(WORKFLOW_CYCLE, second);
    for (const request of approvals) h.pi.events.emit(MODE_CYCLE, request);
    expect(first.result).toBeInstanceOf(Promise);
    expect(approvals[0].result).toBeInstanceOf(Promise);
    await vi.advanceTimersByTimeAsync(399);
    expect(settled).toBe(false);
    expect(workflowOf(ctx)).toBe("work");
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.all([first.result, second.result, ...approvals.map(r => r.result)])).toEqual([true, true, true, true]);
    expect(h.entries.filter(e => [WORKFLOW_ENTRY, APPROVAL_ENTRY].includes(e.customType))).toEqual([]);
    expect(h.messages).toEqual([]);
    expect(settingsCycles(h.pi).snapshot()?.phase).toBe("unchanged");
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("auto");
  });

  test("footer actions return before settlement so rapid activation can stage a round trip", async () => {
    const { h, ctx } = await start(setup());
    const action = queryFooterActions(h.pi.events)["workflow.cycle"]!;
    await action.run();
    expect(settingsCycles(h.pi).snapshot()?.phase).toBe("pending");
    await action.run();
    await vi.advanceTimersByTimeAsync(1000);
    expect(settingsCycles(h.pi).snapshot()?.phase).toBe("unchanged");
    expect(workflowOf(ctx)).toBe("work");
  });

  test("only a final chat change emits a hidden agent notice, not a duplicate visible transition", async () => {
    const { h, ctx } = await start(setup());
    ctx.isIdle = () => false;
    await h.shortcuts.get("shift+tab").handler(ctx);
    expect(h.messages).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toMatchObject({ message: { customType: "tool-gate:chat-notice", display: false }, opts: { deliverAs: "steer" } });
  });

  test.each(["setter", "picker"])("explicit %s cancels previews and remains immediate", async action => {
    const { h, ctx } = await start(setup());
    const request: WorkflowCycleRequest = {};
    h.pi.events.emit(WORKFLOW_CYCLE, request);
    if (action === "setter") h.pi.events.emit(WORKFLOW_SET, { mode: "chat" });
    else await h.commands.get("approvals").handler("", ctx);
    expect(await request.result).toBe(false);
    expect(workflowOf(ctx)).toBe(action === "setter" ? "chat" : "work");
    await vi.advanceTimersByTimeAsync(1000);
    expect(settingsCycles(h.pi).snapshot()?.phase).toBe("cancelled");
  });

  test("journal leaf advancement preserves branch ancestry ownership", async () => {
    const { h, ctx, branch } = await start(setup());
    ctx.sessionManager.getBranch = () => [...branch, ...h.entries.map((entry, index) => ({ type: "custom", id: `journal-${index}`, ...entry }))];
    ctx.sessionManager.getLeafId = () => ctx.sessionManager.getBranch().at(-1)?.id ?? null;
    const request: WorkflowCycleRequest = {};
    h.pi.events.emit(WORKFLOW_CYCLE, request);
    expect(ctx.sessionManager.getLeafId()).toMatch(/^journal-/u);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await request.result).toBe(true);
    expect(workflowOf(ctx)).toBe("chat");
  });

  test("non-TUI cycles remain immediate without a settings journal", async () => {
    const { h, ctx } = await start(setup());
    ctx.mode = "rpc";
    const request: WorkflowCycleRequest = {};
    h.pi.events.emit(WORKFLOW_CYCLE, request);
    expect(workflowOf(ctx)).toBe("chat");
    expect(await request.result).toBe(true);
    expect(h.entries.some(entry => entry.customType === "settings:cycle")).toBe(false);
    expect(h.messages.filter(({ message }) => message.customType === "workflow:transition")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

});

describe("configuration compatibility", () => {
  test.each([
    [{ defaultMode: "chat" }, "chat", "auto"],
    [{ defaultMode: "manual" }, "work", "manual (legacy)"],
    [{ defaultMode: "yolo" }, "work", "yolo"],
    [{ defaultMode: "yolo", defaultWorkflow: "chat", defaultApproval: "manual" }, "chat", "manual (legacy)"],
  ])("defaults map axes independently: %j", async (config, workflow, approval) => {
    configure(config);
    const { ctx } = await start(setup());
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain(`workflow: ${workflow}`);
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain(approval);
  });
  test.each([
    [{ cycleShortcut: "ctrl+g" }, "ctrl+g", "alt+a"],
    [{ cycleShortcut: "ctrl+g", workflowShortcut: "alt+w", approvalShortcut: "alt+y" }, "alt+w", "alt+y"],
    [{ workflowShortcut: "", approvalShortcut: "" }, "", ""],
    [{ workflowShortcut: false, cycleShortcut: "ctrl+g", approvalShortcut: 42 }, "ctrl+g", "alt+a"],
    [{ workflowShortcut: {}, cycleShortcut: null, approvalShortcut: [] }, "shift+tab", "alt+a"],
    [{ workflowShortcut: null, cycleShortcut: "", approvalShortcut: null }, "", "alt+a"],
    [{ workflowShortcut: "", cycleShortcut: false, approvalShortcut: "" }, "", ""],
  ])("shortcut precedence and disabling: %j", async (config, workflowKey, approvalKey) => {
    configure(config);
    const { h, ctx } = await start(setup());
    expect([...h.shortcuts.keys()]).toEqual([workflowKey, approvalKey].filter(Boolean));
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toBe(workflowStatus("work", workflowKey || undefined));
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toBe(modeStatus("auto", approvalKey || undefined));
  });
  test("duplicate configured keys report a collision and only workflow runs", async () => {
    configure({ workflowShortcut: "alt+w", approvalShortcut: "alt+w" });
    const { h, ctx } = await start(setup());
    expect([...h.shortcuts.keys()]).toEqual(["alt+w"]);
    expect(JSON.stringify(ctx.ui.notes)).toMatch(/same|collision|duplicate|conflict/iu);
    await h.shortcuts.get("alt+w").handler(ctx);
    await settingsCycles(h.pi).flush();
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("chat");
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("auto");
  });
  test("persisted branch values take precedence over explicit defaults", async () => {
    configure({ defaultWorkflow: "chat", defaultApproval: "yolo" });
    const { ctx } = await start(setup([
      entry(WORKFLOW_ENTRY, { version: 1, mode: "work" }),
      entry(APPROVAL_ENTRY, { version: 1, mode: "default" }),
    ]));
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("workflow: work");
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("manual (legacy)");
  });
  test("a legacy plan default without a provider falls back to work before acting", async () => {
    configure({ defaultMode: "plan", defaultApproval: "manual" });
    const { h, ctx } = await start(setup());
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("workflow: work");
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("manual (legacy)");
  });
  test("deprecated mixed modes config does not restrict either cycle", async () => {
    configure({ modes: ["manual"] });
    const { h, ctx } = await start(setup());
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plan.md" });
    for (const workflow of ["chat", "plan", "work"]) {
      await h.shortcuts.get("shift+tab").handler(ctx);
      await settingsCycles(h.pi).flush();
      expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain(workflow);
    }
    await h.shortcuts.get("alt+a").handler(ctx);
    await settingsCycles(h.pi).flush();
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("yolo");
  });
});

describe("workflow guards precede approvals", () => {
  // The gate compares canonical paths (/tmp is /private/tmp on macOS).
  const TMP = realpathSync("/tmp");
  const PLAN = `${TMP}/plans/calm-river.md`;
  const SCRATCH = `${TMP}/plans/calm-river.spike`;
  const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
  const plan = async (approval: string, answers: any = safe, exec?: (cmd: string, args: string[]) => any, config: Record<string, unknown> = {}) => {
    if (Object.keys(config).length) configure(config);
    const s = await start(setup(undefined, answers, exec));
    s.h.pi.events.emit(PLAN_PROVIDER, { planFile: PLAN, scratchDir: SCRATCH });
    await s.h.commands.get("approvals").handler(approval, s.ctx);
    s.h.pi.events.emit(WORKFLOW_SET, { mode: "plan" });
    await s.h.emit("before_agent_start", { prompt: "x" }, s.ctx);
    return s;
  };
  const run = (s: Awaited<ReturnType<typeof plan>>, tool: string, input: Record<string, unknown>, id = "t1") => s.h.emit("tool_call", call(tool, input, id), s.ctx);
  const questionsOf = (s: Awaited<ReturnType<typeof plan>>) => s.jev.calls.map(c => Object.keys(c.questions).join());

  test.each(["auto", "yolo"])("plan+%s writes the plan file and its scratch directory, never the repository", async approval => {
    const s = await plan(approval);
    expect(await run(s, "write", { path: PLAN, content: "# Plan" })).toBeUndefined();
    expect(await run(s, "write", { path: `${SCRATCH}/x.ts`, content: "x" }, "t2")).toBeUndefined();
    expect(await run(s, "edit", { path: `${SCRATCH}/sub/y.ts`, edits: [] }, "t3")).toBeUndefined();
    for (const tool of ["edit", "write"]) {
      expect(await run(s, tool, { path: "src/a.ts", content: "x", edits: [] }, `r-${tool}`)).toMatchObject({
        block: true, reason: expect.stringMatching(new RegExp(`nothing in the repository may be edited.*plan file, ${esc(PLAN)}, and scratch files under ${esc(SCRATCH)}`, "su")),
      });
    }
    // The scratch directory is not a prefix match on its name.
    expect(await run(s, "write", { path: `${SCRATCH}s/x`, content: "x" }, "t4")).toMatchObject({ block: true });
    expect(s.ctx.ui.selects).toHaveLength(0);
  });

  test.each(["auto", "yolo"])("plan+%s: commands that only read run, writes into the repository block without a question", async approval => {
    const s = await plan(approval);
    expect(await run(s, "bash", { command: "git status && rg -n x" })).toBeUndefined();
    for (const [i, command] of ["sed -i s/a/b/ src/x", "echo hi > src/new.ts", "rm src/a.ts", "touch .git/HEAD"].entries()) {
      expect(await run(s, "bash", { command }, `w${i}`), command).toMatchObject({ block: true, reason: expect.stringMatching(/Plan mode is on: this bash call would write .*in the repository/u) });
    }
    expect(await run(s, "bg_run", { command: "echo x > src/b.ts" }, "bg")).toMatchObject({ block: true, reason: expect.stringContaining("this bg_run call would write") });
    expect(s.jev.calls).toHaveLength(0);
  });

  test.each(["auto", "yolo"])("plan+%s: a command that does more than read runs when System 1 says it leaves the repository unchanged", async approval => {
    const s = await plan(approval, { ...safe, leaves_repo_unchanged: { type: "bool", probability: 0.95 } });
    expect(await run(s, "bash", { command: "npm test" })).toBeUndefined();
    expect(await run(s, "bash", { command: `mkdir -p ${SCRATCH} && echo 1 > ${SCRATCH}/probe.ts && node ${SCRATCH}/probe.ts` }, "t2")).toBeUndefined();
    // The scope question first, then (auto only) the approval judge; yolo asks nothing more.
    const scope = questionsOf(s).filter(q => q === "leaves_repo_unchanged");
    expect(scope).toHaveLength(2);
    expect(s.jev.calls.length).toBe(approval === "auto" ? 4 : 2);
    expect(s.jev.calls[0]!.state).toMatchObject({ repo_root: path.join(configDir, "app"), scratch_dir: SCRATCH });
    expect(s.h.entries.filter(e => e.customType === "tool-gate:decision" && (e.data as any).check === "plan-scope" && (e.data as any).action === "allow")).toHaveLength(2);
    expect(s.ctx.ui.selects).toHaveLength(0);
  });

  test("plan: a command System 1 thinks changes the repository blocks, and so does an unanswered question", async () => {
    const s = await plan("auto");
    expect(await run(s, "bash", { command: "npm run codegen" })).toMatchObject({ block: true, reason: expect.stringMatching(new RegExp(`System 1 judged that this one might.*Write spikes and prototypes under ${esc(SCRATCH)}`, "su")) });
    expect(questionsOf(s)).toEqual(["leaves_repo_unchanged"]);
    const down = await plan("auto", { stopReason: "error", answers: {}, errorMessage: "unavailable" });
    expect(await run(down, "bash", { command: "npm test" })).toMatchObject({ block: true, reason: expect.stringContaining("System 1 could not confirm that this one does not") });
    expect(down.h.entries.some(e => e.customType === "tool-gate:decision" && (e.data as any).check === "plan-scope" && (e.data as any).action === "block" && (e.data as any).errorClass)).toBe(true);
  });

  test("plan: a write that git ignores is not a repository change", async () => {
    const root = path.join(configDir, "app");
    const exec = (cmd: string, args: string[]) =>
      cmd === "git" && args.includes("check-ignore")
        ? { code: 0, stdout: `${root}/dist/out.js\n`, stderr: "", killed: false }
        : cmd === "env" ? { code: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git\n", killed: false } : undefined;
    const s = await plan("yolo", { ...safe, leaves_repo_unchanged: { type: "bool", probability: 0.95 } }, exec);
    expect(await run(s, "bash", { command: "echo x > dist/out.js" })).toBeUndefined();
    expect(await run(s, "bash", { command: "echo x > dist/other.js" }, "t2")).toMatchObject({ block: true, reason: expect.stringContaining("would write") });
  });

  test('planShell "read-only" in the user config keeps the old read-only plan workflow', async () => {
    const s = await plan("auto", safe, undefined, { planShell: "read-only" });
    for (const [tool, command] of [["bash", "npm test"], ["bash", "sed -i s/a/b/ x"], ["bg_run", "npm test"]]) {
      expect(await run(s, tool, { command }, `${tool}-${command}`)).toMatchObject({ block: true, reason: expect.stringMatching(/^Plan mode is on: only read-only commands run/u) });
    }
    expect(questionsOf(s)).toEqual(["only_reads", "only_reads", "only_reads"]);
  });

  test("plan leaves other tools to the approval setting", async () => {
    for (const approval of ["auto", "yolo"]) {
      const s = await plan(approval);
      expect(await run(s, "subagent", { task: "explore" })).toBeUndefined();
      expect(s.jev.calls).toHaveLength(approval === "auto" ? 1 : 0);
      // When the subagent provider honors subagent-env, its children inherit the plan: a read, not judged.
      s.h.pi.events.on("pi-plugins.subagent-env.v1", (r: any) => { if (r?.probe) r.supported = true; });
      expect(await run(s, "subagent", { task: "explore2" }, "t2")).toBeUndefined();
      expect(s.jev.calls).toHaveLength(approval === "auto" ? 1 : 0);
    }
  });

  test("a scratch write is never held by the directory policy, even under a derived path", async () => {
    configure({ directories: { derived: [{ path: "/tmp/plans", hint: "Edit the source." }] } });
    const s = await plan("auto");
    expect(await run(s, "write", { path: `${SCRATCH}/x.ts`, content: "x" })).toBeUndefined();
    expect(s.ctx.ui.selects).toHaveLength(0);
  });
  test.each(["chat", "plan"] as const)("%s: reads outside the project and of credentials follow the approval setting", async workflow => {
    const { h, ctx } = await start(setup());
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plans/calm-river.md" });
    h.pi.events.emit(WORKFLOW_SET, { mode: workflow });
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    const outside = call("read", { path: "~/Projects/gate-test-other/a.ts" }, "o1");
    const secret = call("bash", { command: "cat .env" }, "s1");
    expect(await h.emit("tool_call", outside, ctx)).toMatchObject({ block: true, reason: expect.stringMatching(/outside this project's directories/u) });
    expect(await h.emit("tool_call", secret, ctx)).toMatchObject({ block: true, reason: expect.stringMatching(/touches credentials/u) });
    await h.commands.get("approvals").handler("yolo", ctx);
    expect(await h.emit("tool_call", { ...outside, toolCallId: "o2" }, ctx)).toBeUndefined();
    expect(await h.emit("tool_call", { ...secret, toolCallId: "s2" }, ctx)).toBeUndefined();
    expect(ctx.ui.selects).toHaveLength(0);
  });
  test.each(["work", "chat", "plan"] as const)("%s: deny rules apply under every approval setting", async workflow => {
    configure({ permissions: { deny: ["Bash(git log:*)", "Read(notes/**)"] } });
    const { h, ctx } = await start(setup());
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plans/calm-river.md" });
    h.pi.events.emit(WORKFLOW_SET, { mode: workflow });
    for (const approval of ["auto", "yolo", "manual"]) {
      await h.commands.get("approvals").handler(approval, ctx);
      expect(await h.emit("tool_call", call("bash", { command: "git log -1" }), ctx)).toMatchObject({ block: true, reason: expect.stringMatching(/deny rule Bash\(git log:\*\)/u) });
      expect(await h.emit("tool_call", call("read", { path: "notes/a.md" }), ctx)).toMatchObject({ block: true, reason: expect.stringMatching(/deny rule Read/u) });
    }
    expect(ctx.ui.selects).toHaveLength(0);
  });
  test.each(["auto", "yolo"])("chat+%s blocks mutations, MCP and allow rules; only an unparsed command gets a read check", async approval => {
    configure({ permissions: { allow: ["Bash(npm test:*)", "mcp__notes__write"] } });
    const { h, jev, ctx } = await start(setup());
    await h.commands.get("approvals").handler(approval, ctx);
    await h.commands.get("mode").handler("chat", ctx);
    for (const [tool, input] of [["read", { path: "a.ts" }], ["bash", { command: "git log --oneline" }], ["web_search", { query: "x" }]] as const) expect(await h.emit("tool_call", call(tool, input), ctx)).toBeUndefined();
    for (const [tool, input] of [["edit", { path: "src/a.ts", edits: [] }], ["write", { path: "src/a.ts", content: "x" }], ["bash", { command: "npm test" }], ["mcp__notes__write", { text: "x" }], ["subagent", { task: "x", worktree: true }]] as const) expect(await h.emit("tool_call", call(tool, input), ctx)).toMatchObject({ block: true, reason: expect.stringMatching(/Chat mode is on:/u) });
    expect(ctx.ui.selects).toHaveLength(0);
    expect(jev.calls).toHaveLength(1);
    expect(Object.keys(jev.calls[0]!.questions)).toEqual(["only_reads"]);
  });
  // As pi-subagents answers probes on the subagent-env contract.
  const honorSubagentEnv = (h: ReturnType<typeof harness>) => h.pi.events.on("pi-plugins.subagent-env.v1", (r: any) => { if (r?.probe) r.supported = true; });
  test("chat runs subagents: their children start in chat too", async () => {
    const { h, ctx } = await start(setup());
    honorSubagentEnv(h);
    await h.commands.get("approvals").handler("yolo", ctx);
    await h.commands.get("mode").handler("chat", ctx);
    for (const input of [{ task: "explore" }, { action: "run", tasks: [{ task: "a" }] }, { action: "resume", id: "x" }]) {
      expect(await h.emit("tool_call", call("subagent", input), ctx)).toBeUndefined();
    }
    for (const input of [{ action: "steer", id: "x", message: "edit it" }, { task: "x", worktree: true }]) {
      expect(await h.emit("tool_call", call("subagent", input), ctx)).toMatchObject({ block: true, reason: expect.stringMatching(/^Chat mode is on:/u) });
    }
  });
  test("chat blocks subagent runs when no provider honors subagent-env", async () => {
    const { h, ctx } = await start(setup());
    await h.commands.get("approvals").handler("yolo", ctx);
    await h.commands.get("mode").handler("chat", ctx);
    expect(await h.emit("tool_call", call("subagent", { task: "explore" }), ctx)).toMatchObject({ block: true, reason: expect.stringMatching(/^Chat mode is on:/u) });
  });
  test("chat+auto runs a judged read without a second judgment", async () => {
    const s = setup();
    const jev = fakeJev(() => ({ ...safe, only_reads: { type: "bool", probability: 0.97 } }));
    s.ctx.modelRegistry = jev.registry;
    const { h, ctx } = await start(s);
    await h.commands.get("approvals").handler("auto", ctx);
    await h.commands.get("mode").handler("chat", ctx);
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    expect(await h.emit("tool_call", call("bash", { command: "python3 -c \"print(1)\"" }), ctx)).toBeUndefined();
    expect(jev.calls).toHaveLength(1);
    expect(Object.keys(jev.calls[0]!.questions)).toEqual(["only_reads"]);
  });
  test.each([[0.97, true], [0.6, false]] as const)("chat runs an unparsed command System 1 is sure only reads (%s)", async (probability, runs) => {
    const s = setup();
    const jev = fakeJev(() => ({ only_reads: { type: "bool", probability } }));
    s.ctx.modelRegistry = jev.registry;
    const { h, ctx } = await start(s);
    await h.commands.get("approvals").handler("yolo", ctx);
    await h.commands.get("mode").handler("chat", ctx);
    const command = "python3 -c \"import json; print(json.load(open('a.json'))['x'])\"";
    const result = await h.emit("tool_call", call("bash", { command }), ctx);
    if (runs) expect(result).toBeUndefined();
    else expect(result).toMatchObject({ block: true, reason: expect.stringMatching(/^Chat mode is on: .*System 1 judged that it may do more than read/su) });
    expect(jev.calls[0]!.state).toMatchObject({ tool_call: { tool: "bash", arguments: command } });
  });
  test.each(["chat", "plan"] as const)("%s: calls their tool's owner says only read run without judging; its other calls do not", async workflow => {
    const { h, jev, ctx } = await start(setup());
    // As pi-herdr answers on the read-only-call contract.
    declareReadOnlyCalls(h.pi.events, "herdr", input => input.action === "list" || input.action === "read");
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plans/calm-river.md" });
    h.pi.events.emit(WORKFLOW_SET, { mode: workflow });
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    expect(await h.emit("tool_call", call("herdr", { action: "list" }, "l1"), ctx)).toBeUndefined();
    expect(await h.emit("tool_call", call("herdr", { action: "read", name: "a" }, "r1"), ctx)).toBeUndefined();
    expect(jev.calls).toHaveLength(0);
    const send = await h.emit("tool_call", call("herdr", { action: "send", name: "a", message: "x" }, "s1"), ctx);
    // Chat blocks it; plan leaves it to the approval setting, which judges it.
    if (workflow === "chat") expect(send).toMatchObject({ block: true, reason: expect.stringMatching(/^Chat mode is on:/u) });
    else expect(jev.calls).toHaveLength(1);
    expect(ctx.ui.selects).toHaveLength(0);
  });
  test.each(["auto", "yolo"])("chat+%s lets reads with expansions past the workflow, leaving them to the approval setting", async approval => {
    const { h, jev, ctx } = await start(setup());
    await h.commands.get("approvals").handler(approval, ctx);
    await h.commands.get("mode").handler("chat", ctx);
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    const reads = ["for f in a.ts b.ts; do rg -n x \"$f\"; done", "wc -l $(rg -l x src)", "rg -l x | xargs grep -n y"];
    for (const [i, command] of reads.entries()) {
      const result = await h.emit("tool_call", call("bash", { command }, `r${i}`), ctx);
      expect((result as { reason?: string } | undefined)?.reason ?? "").not.toMatch(/Chat mode is on/u);
    }
    // The workflow passes them; auto still judges what it cannot parse, yolo runs it.
    expect(jev.calls.length > 0).toBe(approval === "auto");
    const blocked = await h.emit("tool_call", call("bash", { command: "rg -l x | xargs rm" }, "w1"), ctx);
    expect(blocked).toMatchObject({ block: true, reason: expect.stringMatching(/^Chat mode is on: .*run simpler read-only commands.*do not retry it/su) });
  });
  test("manual asks for mutations without Jev; accept-edits allows only project edits", async () => {
    const { h, jev, ctx } = await start(setup());
    await h.commands.get("approvals").handler("manual", ctx);
    expect(await h.emit("tool_call", call("read", { path: "a.ts" }), ctx)).toBeUndefined();
    ctx.ui.selectAnswers.push("Block", "Allow once");
    expect(await h.emit("tool_call", call("edit", { path: "src/a.ts", edits: [] }), ctx)).toMatchObject({ block: true });
    expect(await h.emit("tool_call", call("bash", { command: "npm test" }), ctx)).toBeUndefined();
    await h.commands.get("approvals").handler("accept-edits", ctx);
    expect(await h.emit("tool_call", call("write", { path: "src/new.ts", content: "x" }), ctx)).toBeUndefined();
    expect(await h.emit("tool_call", call("bash", { command: "mkdir -p src/lib" }), ctx)).toBeUndefined();
    ctx.ui.selectAnswers.push("Block", "Block");
    expect(await h.emit("tool_call", call("write", { path: "/etc/hosts", content: "x" }), ctx)).toMatchObject({ block: true });
    expect(await h.emit("tool_call", call("bash", { command: "npm publish" }), ctx)).toMatchObject({ block: true });
    expect(jev.calls).toHaveLength(0);
    expect(ctx.ui.selects).toHaveLength(4);
  });
  test("work auto still judges ordinary mutations", async () => {
    const { h, jev, ctx } = await start(setup());
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    expect(await h.emit("tool_call", call("bash", { command: "npm test" }), ctx)).toBeUndefined();
    expect(jev.calls).toHaveLength(1);
  });
  test("work yolo retains critical-removal protections", async () => {
    const { h, jev, ctx } = await start(setup());
    await h.commands.get("approvals").handler("yolo", ctx);
    expect(await h.emit("tool_call", call("bash", { command: "npm publish" }), ctx)).toBeUndefined();
    expect(await h.emit("tool_call", call("write", { path: "/etc/hosts", content: "x" }), ctx)).toBeUndefined();
    ctx.ui.selectAnswers.push("Block");
    expect(await h.emit("tool_call", call("bash", { command: "rm -rf ~" }), ctx)).toMatchObject({ block: true });
    for (const command of ["eval ".repeat(32) + "rm -rf /", `cd /tmp; rm -rf ${ctx.cwd}`, "bash -oc pipefail 'rm -rf /'", "echo '<<true'\nrm -rf /"]) {
      ctx.ui.selectAnswers.push("Block");
      expect(await h.emit("tool_call", call("bash", { command }), ctx)).toMatchObject({ block: true });
    }
    expect(jev.calls).toHaveLength(0);
  });
});

describe("visible workflow transitions", () => {
  const markers = (h: ReturnType<typeof harness>) => h.messages.filter(({ message }) => message.customType === "workflow:transition");

  test("explicit selections mark transitions while shortcut/event cycles use the settings journal", async () => {
    const { h, ctx } = await start(setup());
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plan.md" });
    await h.commands.get("mode").handler("chat", ctx);
    await h.shortcuts.get("shift+tab").handler(ctx);
    await settingsCycles(h.pi).flush();
    h.pi.events.emit(WORKFLOW_SET, { mode: "work" });
    h.pi.events.emit(WORKFLOW_CYCLE, {});
    await settingsCycles(h.pi).flush();
    expect(markers(h)).toEqual([
      ["work", "chat", "read-only discussion"],
      ["plan", "work", "edits and actions"],
    ].map(([previous, mode, explanation]) => ({
      message: {
        customType: "workflow:transition", content: `${mode} · ${explanation}`,
        display: false, details: { version: 1, previous, mode },
      },
      opts: { triggerTurn: false },
    })));
  });

  test("startup, branch restores, queries, providers, approvals and repeated selections stay silent", async () => {
    const { h, ctx, branch } = await start(setup([entry(WORKFLOW_ENTRY, { version: 1, mode: "chat" })]));
    expect(markers(h)).toEqual([]);
    for (const mode of ["plan", "work"] as const) {
      branch.splice(0, branch.length, entry(WORKFLOW_ENTRY, { version: 1, mode }));
      await h.emit("session_tree", {}, ctx);
      expect(markers(h)).toEqual([]);
    }
    const reply = vi.fn();
    h.pi.events.emit(WORKFLOW_QUERY, { entries: [entry(WORKFLOW_ENTRY, { version: 1, mode: "plan" })], cwd: ctx.cwd, reply });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ mode: "plan", source: "restore" }));
    for (const planFile of ["/tmp/plan.md", "/tmp/plan.md", "/tmp/other-plan.md"]) h.pi.events.emit(PLAN_PROVIDER, { planFile });
    await h.commands.get("approvals").handler("yolo", ctx);
    await h.shortcuts.get("alt+a").handler(ctx);
    await settingsCycles(h.pi).flush();
    h.pi.events.emit(MODE_SET, { mode: "default" });
    h.pi.events.emit(MODE_CYCLE, {});
    await settingsCycles(h.pi).flush();
    await h.commands.get("mode").handler("work", ctx);
    h.pi.events.emit(WORKFLOW_SET, { mode: "work" });
    expect(markers(h)).toEqual([]);
    h.pi.events.emit(WORKFLOW_SET, { mode: "chat" });
    h.pi.events.emit(WORKFLOW_SET, { mode: "chat" });
    expect(markers(h)).toHaveLength(1);
  });

  test.each([
    ["work", "success", "edits and actions"],
    ["chat", "thinkingLow", "read-only discussion"],
    ["plan", "customMessageLabel", "research and plan only"],
  ])("registered renderer draws %s as an info row with a coloured mode and a muted explanation", (mode, role, explanation) => {
    const { h } = setup();
    const renderer = h.messageRenderers.get("workflow:transition");
    expect(renderer).toBeTypeOf("function");
    const theme = {
      fg: vi.fn((role: string, text: string) => `<${role}>${text}</${role}>`),
      bold: vi.fn((text: string) => `<bold>${text}</bold>`),
    };
    const previous = mode === "work" ? "chat" : "work";
    const rendered = renderer!({ content: "fallback", details: { version: 1, previous, mode } }, { expanded: false }, theme);
    expect(rendered.render(200).map((line: string) => line.trimEnd())).toEqual([` <muted>○</muted> <${role}>${mode}</${role}><dim> · </dim><muted>${explanation}</muted>`]);
    expect(theme.fg.mock.calls).toEqual([["muted", "○"], [role, `${mode}`], ["dim", " · "], ["muted", explanation]]);
  });

  test.each([
    undefined, null, {}, { version: 2, previous: "work", mode: "chat" },
    { version: 1, previous: "invalid", mode: "chat" },
    { version: 1, previous: "work", mode: "invalid" },
    { version: 1, previous: "work", mode: "work" },
    { version: 1, mode: "chat" }, { version: 1, previous: "work" },
  ])("malformed transition details %j fall back to unstyled text", details => {
    const { h } = setup();
    const renderer = h.messageRenderers.get("workflow:transition")!;
    const theme = { fg: vi.fn(), bold: vi.fn() };
    for (const content of ["Fallback text", [
      { type: "text", text: "Fallback " }, { type: "image", data: "ignored", mimeType: "image/png" }, { type: "text", text: "text" },
    ]]) {
      expect(renderer({ content, details }, {}, theme).render(200).map((line: string) => line.trimEnd())).toEqual(["Fallback text"]);
    }
    expect(theme.fg).not.toHaveBeenCalled();
    expect(theme.bold).not.toHaveBeenCalled();
  });
});

describe("workflow requests and optional footer actions", () => {
  test("explicit workflow requests stay synchronous and cycles return an awaitable final result", async () => {
    const { h, ctx } = await start(setup());
    const set: WorkflowSetRequest = { mode: "chat" };
    h.pi.events.emit(WORKFLOW_SET, set);
    expect(set.result).toBeInstanceOf(Promise);
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("chat");
    expect(await set.result).toBe(true);
    const cycle: WorkflowCycleRequest = {};
    h.pi.events.emit(WORKFLOW_CYCLE, cycle);
    expect(cycle.result).toBeInstanceOf(Promise);
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("chat");
    await settingsCycles(h.pi).flush();
    expect(await cycle.result).toBe(true);
    const plan: WorkflowSetRequest = { mode: "plan" };
    h.pi.events.emit(WORKFLOW_SET, plan);
    expect(await plan.result).toBe(false);
    expect(workflowOf(ctx)).toBe("work");
  });
  test("actions are absent before startup, pure when ready, and stale after tree/shutdown", async () => {
    const s = setup();
    expect(queryFooterActions(s.h.pi.events)).toEqual({});
    await start(s);
    const before = s.h.entries.length;
    const actions = queryFooterActions(s.h.pi.events);
    expect(Object.keys(actions)).toEqual(["workflow.cycle", "workflow.open", "approvals.open"]);
    expect(actions["workflow.cycle"]?.label).toBe("Cycle workflow");
    expect(actions["workflow.cycle"]?.key).toBe("shift+tab");
    expect(actions["approvals.open"]?.key).toBe("alt+a");
    expect(s.h.entries).toHaveLength(before);
    s.ctx.ui.selectAnswers.push(undefined);
    await actions["approvals.open"]!.run();
    expect(s.ctx.ui.selects.at(-1)).toEqual({ title: approvalsQuestion("on"), options: ["Auto", "Yolo", "Turn permission prompts off"] });
    expect(s.ctx.ui.status.get(MODE_STATUS_KEY)).toContain("auto");
    await s.h.emit("session_tree", {}, s.ctx);
    const selects = s.ctx.ui.selects.length;
    await actions["approvals.open"]!.run();
    expect(s.ctx.ui.selects).toHaveLength(selects);
    await s.h.emit("session_shutdown", {}, s.ctx);
    expect(queryFooterActions(s.h.pi.events)).toEqual({});
  });
  test("the workflow picker offers only the plain workflows and the removed /flow command is gone", async () => {
    const s = await start(setup());
    s.h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plan.md" });
    s.ctx.ui.selectAnswers.push(undefined);
    await s.h.commands.get("mode").handler("", s.ctx);
    expect(s.ctx.ui.selects.at(-1)).toEqual({ title: "Workflow", options: ["Work", "Chat", "Plan"] });
    expect(s.h.commands.has("flow")).toBe(false);
    await s.h.commands.get("mode").handler("exec", s.ctx);
    expect(s.ctx.ui.notes.at(-1)?.message).toMatch(/Usage: \/mode \[work\|chat\|plan\]/u);
    expect(workflowOf(s.ctx)).toBe("work");
  });
});

describe("workflow notices are independent of approvals", () => {
  test("chat notices are once-only and approval changes do not announce an exit", async () => {
    const { h, ctx } = await start(setup());
    expect(await h.emit("before_agent_start", { prompt: "x" }, ctx)).toBeUndefined();
    await h.commands.get("mode").handler("chat", ctx);
    const enter: any = await h.emit("before_agent_start", { prompt: "x" }, ctx);
    expect(enter.message.content).toMatch(/Chat mode is active/u);
    await h.commands.get("approvals").handler("yolo", ctx);
    expect(await h.emit("before_agent_start", { prompt: "x" }, ctx)).toBeUndefined();
    await h.commands.get("mode").handler("work", ctx);
    const exit: any = await h.emit("before_agent_start", { prompt: "x" }, ctx);
    expect(exit.message.content).toMatch(/left chat mode/iu);
    expect(exit.message.content).toMatch(/may now make edits/u);
  });
  test("leaving chat for plan does not say edits are allowed", async () => {
    const { h, ctx } = await start(setup());
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plan.md" });
    await h.commands.get("mode").handler("chat", ctx);
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    await h.commands.get("mode").handler("plan", ctx);
    const notice: any = await h.emit("before_agent_start", { prompt: "x" }, ctx);
    expect(JSON.stringify(notice)).not.toMatch(/may now make edits/u);
    await h.commands.get("approvals").handler("yolo", ctx);
    expect(await h.emit("before_agent_start", { prompt: "x" }, ctx)).toBeUndefined();
  });
  test("mid-turn chat changes steer immediately, not on the next user message", async () => {
    const { h, ctx } = await start(setup());
    ctx.isIdle = () => false;
    await h.commands.get("mode").handler("chat", ctx);
    const reminders = h.messages.filter(({ message }) => message.customType === "tool-gate:chat-notice");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({ opts: { deliverAs: "steer" }, message: { display: false, content: expect.stringMatching(/Chat mode is active/u) } });
    expect(await h.emit("before_agent_start", { prompt: "x" }, ctx)).toBeUndefined();
  });
});

describe("permission prompting controls and lifecycle", () => {
  test("commands report source, persist booleans and reset, and publish exact status independently of approvals", async () => {
    configure({ denyInsteadOfPrompting: true });
    const { h, ctx } = await start(setup());
    const gate = h.commands.get("gate");
    expect(ctx.ui.status.get(PROMPTING_STATUS_KEY)).toBe("permission prompts: off");
    await gate.handler("prompts", ctx);
    expect(ctx.ui.notes.at(-1)?.message).toBe("Permission prompts: off (source: config).");
    await gate.handler("prompts on", ctx);
    expect(ctx.ui.notes.at(-1)?.message).toBe("Permission prompts: on (source: session).");
    expect(ctx.ui.status.get(PROMPTING_STATUS_KEY)).toBe("permission prompts: on");
    await gate.handler("prompts off", ctx);
    expect(ctx.ui.notes.at(-1)?.message).toBe("Permission prompts: off (source: session).");
    await gate.handler("prompts default", ctx);
    expect(ctx.ui.notes.at(-1)?.message).toBe("Permission prompts: off (source: config).");
    expect(h.entries.filter(e => e.customType === PROMPTING_ENTRY).map(e => e.data)).toEqual([
      { version: 1, denyInsteadOfPrompting: false }, { version: 1, denyInsteadOfPrompting: true }, { version: 1, denyInsteadOfPrompting: null },
    ]);
    expect(h.entries.some(e => e.customType === APPROVAL_ENTRY || e.customType === WORKFLOW_ENTRY)).toBe(false);
    await gate.handler("status", ctx);
    expect(ctx.ui.notes.at(-1)?.message).toContain("Permission prompts: off (source: config).");
    expect(gate.description).toContain("off denies, never approves");
    expect(gate.getArgumentCompletions("prompts").map((c: any) => c.value)).toEqual(["prompts", "prompts on", "prompts off", "prompts default"]);
  });

  test("invalid arguments and identical overrides neither persist nor cancel a pending settings preview", async () => {
    const { h, ctx } = await start(setup());
    const gate = h.commands.get("gate");
    await gate.handler("prompts off", ctx);
    const settings = settingsCycles(h.pi);
    h.pi.events.emit(MODE_CYCLE, {});
    expect(settings.snapshot()?.phase).toBe("pending");
    const before = h.entries.length;
    for (const arg of ["prompts off", "prompts", "prompts nope", "prompts off extra", "prompts default extra", "prompts on off"]) {
      await gate.handler(arg, ctx);
      expect(h.entries).toHaveLength(before);
      expect(settings.snapshot()?.phase).toBe("pending");
      if (arg.includes("extra") || arg === "prompts nope" || arg === "prompts on off") {
        expect(ctx.ui.notes.at(-1)).toEqual({ message: "Usage: /gate prompts [on|off|default].", type: "warning" });
      }
    }
    await gate.handler("prompts on", ctx);
    expect(settings.snapshot()).toMatchObject({ phase: "cancelled", reason: "Permission prompting selected explicitly." });
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("auto");
    expect(ctx.ui.status.get(PROMPTING_STATUS_KEY)).toBe("permission prompts: on");
    await settings.flush();
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("auto");
  });

  test("the explicit picker and footer action toggle only prompting, retain short options and show reset guidance", async () => {
    const { h, ctx } = await start(setup());
    await h.commands.get("mode").handler("chat", ctx);
    await h.commands.get("approvals").handler("yolo", ctx);
    const action = queryFooterActions(h.pi.events)["approvals.open"]!;
    for (const state of ["on", "off"] as const) {
      const toggle = `Turn permission prompts ${state === "on" ? "off" : "on"}`;
      ctx.ui.selectAnswers.push(toggle);
      await action.run();
      expect(ctx.ui.selects.at(-1)).toEqual({ title: approvalsQuestion(state), options: ["Auto", "Yolo", toggle] });
      expect(ctx.ui.selects.at(-1)!.options.every((option: string) => option.length <= 42)).toBe(true);
      expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("yolo");
      expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("chat");
      expect(ctx.ui.status.get(PROMPTING_STATUS_KEY)).toBe(`permission prompts: ${state === "on" ? "off" : "on"}`);
    }
  });

  test("headless approvals status includes disposition and reset without a picker", async () => {
    const { h, ctx } = await start(setup());
    ctx.hasUI = false;
    await h.commands.get("gate").handler("prompts off", ctx);
    await h.commands.get("approvals").handler("", ctx);
    expect(ctx.ui.selects).toHaveLength(0);
    expect(ctx.ui.notes.at(-1)?.message).toContain("Permission prompts: off (source: session).");
    expect(ctx.ui.notes.at(-1)?.message).toContain("/gate prompts default");
  });

  test("branch moves, resets, reload and a new session never leak the previous override", async () => {
    const { h, ctx, branch } = await start(setup());
    const gate = h.commands.get("gate");
    await gate.handler("prompts off", ctx);
    branch.push(entry(PROMPTING_ENTRY, { version: 1, denyInsteadOfPrompting: true }));
    await h.emit("session_tree", {}, ctx);
    expect(ctx.ui.status.get(PROMPTING_STATUS_KEY)).toBe("permission prompts: off");
    const reloaded = await start(setup([...branch]));
    expect(reloaded.ctx.ui.status.get(PROMPTING_STATUS_KEY)).toBe("permission prompts: off");
    branch.push(entry(PROMPTING_ENTRY, { version: 1, denyInsteadOfPrompting: false }));
    await h.emit("session_tree", {}, ctx);
    expect(ctx.ui.status.get(PROMPTING_STATUS_KEY)).toBe("permission prompts: on");
    configure({ denyInsteadOfPrompting: true });
    branch.push(entry(PROMPTING_ENTRY, { version: 1, denyInsteadOfPrompting: null }));
    await h.emit("session_tree", {}, ctx);
    await gate.handler("prompts", ctx);
    expect(ctx.ui.notes.at(-1)?.message).toBe("Permission prompts: off (source: config).");
    branch.splice(0, branch.length, userEntry("another branch"));
    configure({ denyInsteadOfPrompting: false });
    await h.emit("session_tree", {}, ctx);
    expect(ctx.ui.status.get(PROMPTING_STATUS_KEY)).toBe("permission prompts: on");
    await gate.handler("prompts off", ctx);
    await h.emit("session_start", {}, ctx);
    expect(ctx.ui.status.get(PROMPTING_STATUS_KEY)).toBe("permission prompts: on");
  });

  test("approval/workflow cycles and legacy gate on/off preserve the independent disposition", async () => {
    const { h, ctx } = await start(setup());
    await h.commands.get("gate").handler("prompts off", ctx);
    for (const channel of [MODE_CYCLE, WORKFLOW_CYCLE, MODE_CYCLE, WORKFLOW_CYCLE]) {
      h.pi.events.emit(channel, {});
      await settingsCycles(h.pi).flush();
      expect(ctx.ui.status.get(PROMPTING_STATUS_KEY)).toBe("permission prompts: off");
    }
    for (const arg of ["off", "on"]) {
      await h.commands.get("gate").handler(arg, ctx);
      expect(ctx.ui.status.get(PROMPTING_STATUS_KEY)).toBe("permission prompts: off");
    }
  });

  test.each(["true", "false"])("a subagent explicitly inherits prompting %s with configured true", async value => {
    configure({ denyInsteadOfPrompting: true });
    vi.stubEnv("PI_SUBAGENT", "1");
    vi.stubEnv(PROMPTING_ENV, value);
    const { h, ctx } = await start(setup());
    await h.commands.get("gate").handler("prompts", ctx);
    expect(ctx.ui.notes.at(-1)?.message).toBe(`Permission prompts: ${value === "true" ? "off" : "on"} (source: inherited).`);
    expect(subagentEnv("auto", "work", value === "true")[PROMPTING_ENV]).toBe(value);
  });

  test.each(["", "TRUE", "FALSE", "1", "0", "null", "nope"])("invalid inherited prompting %j is ignored", value => {
    expect(inheritedModes({ PI_SUBAGENT: "1", [PROMPTING_ENV]: value })).toEqual({});
    expect(inheritedModes({ [PROMPTING_ENV]: "true" })).toEqual({});
    expect(inheritedModes({ [PROMPTING_ENV]: "false" })).toEqual({});
  });
});

describe("subagents inherit approvals", () => {
  const request = (h: ReturnType<typeof harness>, probe = false) => {
    const req: any = { version: 1, env: {}, ...(probe ? { probe: true } : {}) };
    h.pi.events.emit("pi-plugins.subagent-env.v1", req);
    return req.env;
  };
  test("a parent passes its approval down, and chat to children of chat or plan", async () => {
    const { h, ctx } = await start(setup());
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plan.md" });
    expect(request(h)).toEqual({ PI_TOOL_GATE_APPROVAL: "auto", [PROMPTING_ENV]: "false" });
    await h.commands.get("gate").handler("prompts off", ctx);
    expect(request(h)).toEqual({ PI_TOOL_GATE_APPROVAL: "auto", [PROMPTING_ENV]: "true" });
    await h.commands.get("approvals").handler("yolo", ctx);
    expect(request(h)).toEqual({ PI_TOOL_GATE_APPROVAL: "bypassPermissions", [PROMPTING_ENV]: "true" });
    await h.commands.get("mode").handler("chat", ctx);
    expect(request(h)).toEqual({ PI_TOOL_GATE_APPROVAL: "bypassPermissions", PI_TOOL_GATE_WORKFLOW: "chat", [PROMPTING_ENV]: "true" });
    // A planning parent's children inherit plan and its scratch directory.
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plan.md", scratchDir: "/tmp/plan.spike" });
    await h.commands.get("mode").handler("plan", ctx);
    expect(request(h)).toEqual({ PI_TOOL_GATE_APPROVAL: "bypassPermissions", PI_TOOL_GATE_WORKFLOW: "plan", PI_TOOL_GATE_SCRATCH: `${realpathSync("/tmp")}/plan.spike`, [PROMPTING_ENV]: "true" });
    expect(request(h, true)).toEqual({});
  });
  test("a subagent starts with what it inherited unless its branch records otherwise", async () => {
    vi.stubEnv("PI_SUBAGENT", "1");
    vi.stubEnv("PI_TOOL_GATE_APPROVAL", "bypassPermissions");
    vi.stubEnv("PI_TOOL_GATE_WORKFLOW", "chat");
    vi.stubEnv(PROMPTING_ENV, "true");
    const child = await start(setup());
    expect(child.ctx.ui.status.get(PROMPTING_STATUS_KEY)).toBe("permission prompts: off");
    await child.h.commands.get("gate").handler("prompts", child.ctx);
    expect(child.ctx.ui.notes.at(-1)?.message).toBe("Permission prompts: off (source: inherited).");
    await child.h.commands.get("gate").handler("prompts on", child.ctx);
    expect(child.ctx.ui.status.get(PROMPTING_STATUS_KEY)).toBe("permission prompts: on");
    await child.h.commands.get("gate").handler("prompts default", child.ctx);
    expect(child.ctx.ui.status.get(PROMPTING_STATUS_KEY)).toBe("permission prompts: off");
    expect(child.ctx.ui.status.get(MODE_STATUS_KEY)).toContain("yolo");
    expect(child.ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("chat");
    const forked = await start(setup([entry(APPROVAL_ENTRY, { version: 1, mode: "auto" }), entry(WORKFLOW_ENTRY, { version: 1, mode: "work" }), entry(PROMPTING_ENTRY, { version: 1, denyInsteadOfPrompting: false })]));
    expect(forked.ctx.ui.status.get(MODE_STATUS_KEY)).toContain("auto");
    expect(forked.ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("work");
    expect(forked.ctx.ui.status.get(PROMPTING_STATUS_KEY)).toBe("permission prompts: on");
  });
  test("a child of a planning parent starts in plan with the parent's scratch directory and is told once", async () => {
    const scratch = `${realpathSync("/tmp")}/parent.spike`;
    vi.stubEnv("PI_SUBAGENT", "1");
    vi.stubEnv("PI_TOOL_GATE_WORKFLOW", "plan");
    vi.stubEnv("PI_TOOL_GATE_SCRATCH", scratch);
    const child = await start(setup());
    expect(workflowOf(child.ctx)).toBe("plan");
    expect(child.h.events.some(e => e.channel === WORKFLOW_CHANGED && e.data.mode === "plan" && e.data.delegated === true)).toBe(true);
    // No plan provider has announced a plan: the gate still does not drop the child back to work.
    const first: any = await child.h.emit("before_agent_start", { prompt: "x" }, child.ctx);
    expect(first.message).toMatchObject({ customType: "tool-gate:delegated-plan-notice", content: expect.stringContaining(scratch) });
    expect(await child.h.emit("before_agent_start", { prompt: "y" }, child.ctx)).toBeUndefined();
    expect(workflowOf(child.ctx)).toBe("plan");
    let snapshot: any;
    child.h.pi.events.emit(WORKFLOW_QUERY, { entries: [], cwd: child.ctx.cwd, reply: (reply: unknown) => { snapshot = reply; } });
    expect(snapshot).toMatchObject({ mode: "plan", delegated: true });
    // The child's own plan-mode announcement cannot move its scratch directory or give it a plan file.
    child.h.pi.events.emit(PLAN_PROVIDER, { planFile: `${realpathSync("/tmp")}/own.md`, scratchDir: `${realpathSync("/tmp")}/own.spike` });
    const call2 = (tool: string, input: Record<string, unknown>, id: string) => child.h.emit("tool_call", call(tool, input, id), child.ctx);
    expect(await call2("write", { path: `${scratch}/note.md`, content: "x" }, "a")).toBeUndefined();
    expect(await call2("write", { path: `${realpathSync("/tmp")}/own.md`, content: "x" }, "b")).toMatchObject({ block: true });
    expect(await call2("edit", { path: "src/a.ts", edits: [] }, "c")).toMatchObject({ block: true, reason: expect.stringContaining(`scratch files under ${scratch}`) });
    expect(await call2("bash", { command: "echo x > src/new.ts" }, "d")).toMatchObject({ block: true, reason: expect.stringContaining("would write") });
    // Its own children inherit the same scope.
    const req: any = { version: 1, env: {} };
    child.h.pi.events.emit("pi-plugins.subagent-env.v1", req);
    expect(req.env).toMatchObject({ PI_TOOL_GATE_WORKFLOW: "plan", PI_TOOL_GATE_SCRATCH: scratch });
  });
  test("a restored session remembers it was told, and a relative scratch directory is ignored", async () => {
    vi.stubEnv("PI_SUBAGENT", "1");
    vi.stubEnv("PI_TOOL_GATE_WORKFLOW", "plan");
    vi.stubEnv("PI_TOOL_GATE_SCRATCH", "relative/dir");
    expect(inheritedModes()).toEqual({ workflow: "plan" });
    const child = await start(setup([entry("tool-gate:delegated-plan-notice", { told: true })]));
    expect(await child.h.emit("before_agent_start", { prompt: "x" }, child.ctx)).toBeUndefined();
    expect(await child.h.emit("tool_call", call("write", { path: "relative/dir/x", content: "x" }), child.ctx)).toMatchObject({ block: true, reason: expect.stringContaining("only outside the repository") });
  });
  test("outside a subagent, or with an unknown value, the variables change nothing", async () => {
    vi.stubEnv("PI_TOOL_GATE_APPROVAL", "bypassPermissions");
    vi.stubEnv("PI_TOOL_GATE_WORKFLOW", "chat");
    vi.stubEnv(PROMPTING_ENV, "true");
    const plain = await start(setup());
    expect(plain.ctx.ui.status.get(PROMPTING_STATUS_KEY)).toBe("permission prompts: on");
    expect(plain.ctx.ui.status.get(MODE_STATUS_KEY)).toContain("auto");
    expect(plain.ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("work");
    vi.stubEnv("PI_SUBAGENT", "1");
    vi.stubEnv("PI_TOOL_GATE_APPROVAL", "yolo");
    vi.stubEnv("PI_TOOL_GATE_WORKFLOW", "work");
    vi.stubEnv(PROMPTING_ENV, "TRUE");
    const odd = await start(setup());
    expect(odd.ctx.ui.status.get(PROMPTING_STATUS_KEY)).toBe("permission prompts: on");
    expect(odd.ctx.ui.status.get(MODE_STATUS_KEY)).toContain("auto");
    expect(odd.ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("work");
  });
});
