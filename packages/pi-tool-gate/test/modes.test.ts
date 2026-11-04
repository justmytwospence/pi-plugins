import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isAcceptEditsBash } from "../src/bash.ts";
import toolGate from "../src/index.ts";
import {
  APPROVAL_ENTRY, EXEC_CHANGED, MODE_CHANGED, MODE_CYCLE, MODE_ENTRY, MODE_SET, MODE_STATUS_KEY,
  nextApproval, nextWorkflow, parseApproval, parseLegacyCombinedMode, parseWorkflow, PLAN_PROVIDER,
  restoreBranchModes, workflowCycle, workflowStatus, modeStatus, WORKFLOW_CHANGED, WORKFLOW_CYCLE,
  WORKFLOW_ENTRY, WORKFLOW_QUERY, WORKFLOW_SET, WORKFLOW_STATUS_KEY,
  type WorkflowSetRequest, type WorkflowCycleRequest,
} from "../src/modes.ts";
import { FLOW_ENTRY, queryFlow, requestWorkflow } from "../src/flow-contract.ts";
import { queryFooterActions } from "../src/footer-actions.ts";
import { SETTINGS_CYCLE_CHANNEL, settingsCycles } from "../src/settings-cycle.ts";
import { ProviderFlowController } from "../src/provider-flows.ts";
import { fakeJev, harness, userEntry } from "./harness.ts";

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
};
const call = (toolName: string, input: Record<string, unknown>, id = "t1") => ({ type: "tool_call", toolCallId: id, toolName, input });
const entry = (customType: string, data: Record<string, unknown>) => ({ type: "custom", customType, data });
const defaults = { workflow: "work", approval: "auto", execActive: false } as const;
function configure(config: Record<string, unknown>) {
  mkdirSync(path.join(configDir, "xdg", "agents"), { recursive: true });
  writeFileSync(path.join(configDir, "xdg", "agents", "tool-gate.json"), JSON.stringify(config));
}
function setup(branch: any[] = [userEntry("Fix the failing test")]) {
  const cwd = path.join(configDir, "app");
  mkdirSync(cwd, { recursive: true });
  const h = harness({ nonGitCwd: cwd });
  toolGate(h.pi);
  const jev = fakeJev(() => safe);
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
  test("parsers keep legacy migration explicit and exec lifecycle-owned", () => {
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
  test("workflow and approval cycles never synthesize exec or legacy approvals", () => {
    expect(workflowCycle(true)).toEqual(["work", "chat", "plan"]);
    expect(workflowCycle(false)).toEqual(["work", "chat"]);
    expect(nextWorkflow("work", true)).toBe("chat");
    expect(nextWorkflow("chat", true)).toBe("plan");
    expect(nextWorkflow("plan", true)).toBe("work");
    expect(nextWorkflow("chat", false)).toBe("work");
    expect(nextWorkflow("plan", false)).toBe("work");
    expect(nextWorkflow("exec", true)).toBe("exec");
    expect(nextWorkflow("exec", false)).toBe("exec");
    expect(nextApproval("auto")).toBe("bypassPermissions");
    for (const mode of ["bypassPermissions", "default", "acceptEdits"] as const) expect(nextApproval(mode)).toBe("auto");
  });
  test("exact event, durable-entry and status keys", () => {
    expect([WORKFLOW_SET, WORKFLOW_CYCLE, WORKFLOW_CHANGED, PLAN_PROVIDER, EXEC_CHANGED, WORKFLOW_QUERY]).toEqual([
      "workflow-mode:set", "workflow-mode:cycle", "workflow-mode:changed", "workflow-mode:plan-provider", "workflow-mode:exec", "workflow-mode:query",
    ]);
    expect([MODE_SET, MODE_CYCLE, MODE_CHANGED]).toEqual(["permission-mode:set", "permission-mode:cycle", "permission-mode:changed"]);
    expect([WORKFLOW_ENTRY, APPROVAL_ENTRY, MODE_ENTRY, WORKFLOW_STATUS_KEY, MODE_STATUS_KEY]).toEqual([
      "tool-gate:workflow", "tool-gate:approvals", "tool-gate:mode", "workflow-mode", "permission-mode",
    ]);
    expect(workflowStatus("work", "shift+tab")).toBe("workflow: work (shift+tab to cycle)");
    expect(workflowStatus("plan", undefined)).toBe("workflow: plan");
    expect(workflowStatus("exec", "shift+tab")).toBe("workflow: exec");
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
  test("exec is an overlay from the latest lifecycle record, not a persisted base workflow", () => {
    const records = [entry(WORKFLOW_ENTRY, { version: 1, mode: "plan" }), entry(APPROVAL_ENTRY, { version: 1, mode: "bypassPermissions" }), entry("plan-mode:exec", { active: true })];
    expect(restoreBranchModes(records, defaults)).toEqual({ workflow: "plan", approval: "bypassPermissions", execActive: true });
    expect(restoreBranchModes([...records, entry("plan-mode:exec", { active: false })], defaults)).toEqual({ workflow: "work", approval: "bypassPermissions", execActive: false });
  });
  test.each(["chat", "plan"] as const)("inactive exec snapshots preserve %s unless exec was active", (workflow) => {
    const inactive = entry("plan-mode:exec", { active: false });
    const selected = entry(WORKFLOW_ENTRY, { version: 1, mode: workflow });
    expect(restoreBranchModes([selected, inactive, inactive], defaults)).toEqual({ ...defaults, workflow });
    expect(restoreBranchModes([inactive], { ...defaults, workflow })).toEqual({ ...defaults, workflow });
    const stopped = [entry("plan-mode:exec", { active: true }), selected, inactive];
    expect(restoreBranchModes(stopped, defaults)).toEqual(defaults);
    expect(restoreBranchModes([...stopped, selected, inactive], defaults)).toEqual({ ...defaults, workflow });
  });
  test("invalid records cannot escalate permissions and supplied defaults are not mutated", () => {
    const restrictive = { workflow: "chat", approval: "default", execActive: false } as const;
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
    for (const [command, options, answer] of [["mode", ["Work", "Chat", "Plan", "Operating mode..."], "Chat"], ["approvals", ["Auto", "Yolo"], "Yolo"]] as const) {
      ctx.ui.selectAnswers.push(answer);
      const before = h.events.length;
      await h.commands.get(command).handler("", ctx);
      expect(ctx.ui.selects.at(-1)?.title).toBe(command === "mode" ? "Workflow" : "Approvals");
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
  test("exec is lifecycle-owned, refuses changes with recovery guidance, and preserves approvals", async () => {
    const { h, ctx } = await start(setup());
    h.pi.events.emit(EXEC_CHANGED, { active: true, source: "transition" });
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toBe("workflow: exec");
    for (const arg of ["work", "chat", "plan", ""]) {
      await h.commands.get("mode").handler(arg, ctx);
      expect(ctx.ui.notes.at(-1)?.message).toMatch(/Exec is active.*\/plan-exec.*\/plan-exec stop/u);
    }
    await h.shortcuts.get("shift+tab").handler(ctx);
    await settingsCycles(h.pi).flush();
    h.pi.events.emit(WORKFLOW_SET, { mode: "work" });
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toBe("workflow: exec");
    await h.shortcuts.get("alt+a").handler(ctx);
    await settingsCycles(h.pi).flush();
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("yolo");
    expect(h.entries.filter(e => e.customType === WORKFLOW_ENTRY).some(e => (e.data as any).mode === "exec")).toBe(false);
    h.pi.events.emit(EXEC_CHANGED, { active: false, source: "transition" });
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("work");
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("yolo");
    await h.commands.get("mode").handler("exec", ctx);
    expect(ctx.ui.notes.at(-1)?.message).toMatch(/handoff/u);
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("work");
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
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toBe("workflow: exec");
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
    expect(reply.mock.calls.at(-1)?.[0].mode).toBe("exec");
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
  test.each(["chat", "plan", "work"] as const)("exec to %s tree restore ignores exec snapshots in either listener order", async mode => {
    for (const snapshotFirst of [true, false]) {
      const { h, ctx, branch } = await start(setup([entry("plan-mode:exec", { active: true })]));
      ctx.isIdle = () => false;
      branch.splice(0, branch.length, ...(mode === "work" ? [] : [entry(WORKFLOW_ENTRY, { version: 1, mode })]));
      const before = { entries: h.entries.length, messages: h.messages.length, notes: ctx.ui.notes.length };
      const snapshot = () => h.pi.events.emit(EXEC_CHANGED, { active: false, source: "restore" });
      if (snapshotFirst) {
        snapshot();
        expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toBe("workflow: exec");
      }
      await h.emit("session_tree", {}, ctx);
      if (!snapshotFirst) snapshot();
      // Late snapshots from the previous branch cannot overlay the destination either.
      h.pi.events.emit(EXEC_CHANGED, { active: true, source: "restore" });
      h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/restored-plan.md" });
      expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain(`workflow: ${mode}`);
      expect({ entries: h.entries.length, messages: h.messages.length, notes: ctx.ui.notes.length }).toEqual(before);
      expect(h.events.filter(event => event.channel === WORKFLOW_CHANGED).slice(-2).every(event => event.data.source === "restore")).toBe(true);
    }
  });
  test("only a real exec termination persists work and broadcasts a transition", async () => {
    const { h, ctx } = await start(setup([entry("plan-mode:exec", { active: true })]));
    h.pi.events.emit(EXEC_CHANGED, { active: false, source: "restore" });
    expect(h.entries).toHaveLength(0);
    h.pi.events.emit(EXEC_CHANGED, { active: false, source: "transition" });
    h.pi.events.emit(EXEC_CHANGED, { active: false, source: "transition" });
    expect(h.entries).toEqual([{ customType: WORKFLOW_ENTRY, data: { version: 1, mode: "work" } }]);
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("work");
    expect(h.events.filter(event => event.channel === WORKFLOW_CHANGED).at(-1)?.data).toMatchObject({ mode: "work", previous: "exec", source: "transition" });
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
    expect(queryFlow(h.pi.events)?.workflow).toBe("work");
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("auto");
    expect(h.entries.filter(e => [WORKFLOW_ENTRY, APPROVAL_ENTRY].includes(e.customType))).toEqual([]);
    expect(h.events.slice(events).filter(e => [WORKFLOW_CHANGED, MODE_CHANGED].includes(e.channel))).toEqual([]);
    expect(h.messages).toEqual([]);
    expect(h.entries.filter(e => e.customType === "settings:cycle")).toHaveLength(1);
    expect(h.entries.filter(e => e.customType === "settings:cycle-state").length).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(queryFlow(h.pi.events)?.workflow).toBe("plan");
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
    expect(queryFlow(h.pi.events)?.workflow).toBe("work");
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.all([first.result, second.result, ...approvals.map(r => r.result)])).toEqual([true, true, true, true]);
    expect(h.entries.filter(e => [WORKFLOW_ENTRY, APPROVAL_ENTRY].includes(e.customType))).toEqual([]);
    expect(h.messages).toEqual([]);
    expect(settingsCycles(h.pi).snapshot()?.phase).toBe("unchanged");
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("auto");
  });

  test("footer actions return before settlement so rapid activation can stage a round trip", async () => {
    const { h } = await start(setup());
    const action = queryFooterActions(h.pi.events)["workflow.cycle"]!;
    await action.run();
    expect(settingsCycles(h.pi).snapshot()?.phase).toBe("pending");
    await action.run();
    await vi.advanceTimersByTimeAsync(1000);
    expect(settingsCycles(h.pi).snapshot()?.phase).toBe("unchanged");
    expect(queryFlow(h.pi.events)?.workflow).toBe("work");
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

  test.each(["setter", "picker", "exec"])("explicit %s cancels previews and remains immediate", async action => {
    const { h, ctx } = await start(setup());
    const request: WorkflowCycleRequest = {};
    h.pi.events.emit(WORKFLOW_CYCLE, request);
    if (action === "setter") h.pi.events.emit(WORKFLOW_SET, { mode: "chat" });
    else if (action === "picker") await h.commands.get("approvals").handler("", ctx);
    else h.pi.events.emit(EXEC_CHANGED, { active: true, source: "transition" });
    expect(await request.result).toBe(false);
    expect(queryFlow(h.pi.events)?.workflow).toBe(action === "setter" ? "chat" : action === "exec" ? "exec" : "work");
    await vi.advanceTimersByTimeAsync(1000);
    expect(settingsCycles(h.pi).snapshot()?.phase).toBe("cancelled");
  });

  test("new cycles are refused while an asynchronous workflow commit is applying", async () => {
    const { h, ctx } = await start(setup());
    ctx.isIdle = () => true;
    const snapshot = { ...queryFlow(h.pi.events)!, operatingMode: "linked" as const };
    const state = vi.spyOn(ProviderFlowController.prototype, "snapshot").mockImplementation(() => snapshot);
    let release!: () => void;
    const holding = new Promise<void>(resolve => { release = resolve; });
    const prepare = vi.spyOn(ProviderFlowController.prototype, "prepareWorkflow").mockImplementation(async (_next, _ctx, commit) => {
      await holding;
      commit?.();
      return { ok: true, snapshot };
    });
    try {
      const pending: WorkflowCycleRequest = {};
      h.pi.events.emit(WORKFLOW_CYCLE, pending);
      await vi.advanceTimersByTimeAsync(1000);
      expect(settingsCycles(h.pi).snapshot()?.phase).toBe("applying");
      for (const channel of [WORKFLOW_CYCLE, MODE_CYCLE]) {
        const refused: { result?: Promise<boolean> } = {};
        h.pi.events.emit(channel, refused);
        expect(await refused.result).toBe(false);
        expect(ctx.ui.notes.at(-1)?.message).toBe("Wait for the current settings change to finish.");
      }
      expect(prepare).toHaveBeenCalledTimes(1);
      release();
      expect(await pending.result).toBe(true);
      expect(settingsCycles(h.pi).snapshot()?.phase).toBe("applied");
    } finally {
      release();
      prepare.mockRestore();
      state.mockRestore();
    }
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
    expect(queryFlow(h.pi.events)?.workflow).toBe("chat");
  });

  test("non-TUI cycles remain immediate without a settings journal", async () => {
    const { h, ctx } = await start(setup());
    ctx.mode = "rpc";
    const request: WorkflowCycleRequest = {};
    h.pi.events.emit(WORKFLOW_CYCLE, request);
    expect(queryFlow(h.pi.events)?.workflow).toBe("chat");
    expect(await request.result).toBe(true);
    expect(h.entries.some(entry => entry.customType === "settings:cycle")).toBe(false);
    expect(h.messages.filter(({ message }) => message.customType === "workflow:transition")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("forwarded user cycles retain the shortcut's Linked busy check and revalidate at commit", async () => {
    const { h, ctx } = await start(setup());
    const snapshot = queryFlow(h.pi.events)!;
    const spy = vi.spyOn(ProviderFlowController.prototype, "snapshot").mockImplementation(() => ({ ...snapshot, operatingMode: "linked" }));
    try {
      ctx.isIdle = () => false;
      await h.shortcuts.get("shift+tab").handler(ctx);
      const request: WorkflowCycleRequest & { userInitiated: boolean } = { userInitiated: true };
      h.pi.events.emit(WORKFLOW_CYCLE, request);
      expect(await request.result).toBe(false);
      expect(h.entries).toEqual([]);
      expect(ctx.ui.notes.slice(-2).every((note: { message: string }) => /current turn/u.test(note.message))).toBe(true);
      ctx.isIdle = () => true;
      const pending: WorkflowCycleRequest & { userInitiated: boolean } = { userInitiated: true };
      h.pi.events.emit(WORKFLOW_CYCLE, pending);
      ctx.isIdle = () => false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending.result).toBe(false);
      expect(settingsCycles(h.pi).snapshot()?.phase).toBe("failed");
      expect(h.entries.filter(e => e.customType === WORKFLOW_ENTRY)).toEqual([]);
    } finally { spy.mockRestore(); }
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
  test.each(["auto", "yolo"])("plan+%s only writes its plan file, runs only read-only commands and leaves other tools to approvals", async approval => {
    const { h, jev, ctx } = await start(setup());
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plans/calm-river.md" });
    await h.commands.get("approvals").handler(approval, ctx);
    h.pi.events.emit(WORKFLOW_SET, { mode: "plan" });
    expect(await h.emit("tool_call", call("write", { path: "/tmp/plans/calm-river.md", content: "# Plan" }), ctx)).toBeUndefined();
    for (const tool of ["edit", "write"]) expect(await h.emit("tool_call", call(tool, { path: "src/a.ts", content: "x", edits: [] }), ctx)).toMatchObject({ block: true, reason: expect.stringMatching(/Plan mode is on:.*plan file/su) });
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    for (const [tool, command] of [["bash", "npm test"], ["bash", "sed -i s/a/b/ x"], ["bg_run", "npm test"]]) {
      expect(await h.emit("tool_call", call(tool, { command }), ctx)).toMatchObject({ block: true, reason: expect.stringMatching(/^Plan mode is on: only read-only commands run/u) });
    }
    expect(await h.emit("tool_call", call("bash", { command: "git status && rg -n x" }), ctx)).toBeUndefined();
    expect(jev.calls).toHaveLength(0);
    // Other tools are the approval setting's: auto judges them, yolo runs them.
    expect(await h.emit("tool_call", call("subagent", { task: "explore" }), ctx)).toBeUndefined();
    expect(jev.calls).toHaveLength(approval === "auto" ? 1 : 0);
    expect(ctx.ui.selects).toHaveLength(0);
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
  test.each(["auto", "yolo"])("chat+%s blocks mutations, MCP and allow rules without judging", async approval => {
    configure({ permissions: { allow: ["Bash(npm test:*)", "mcp__notes__write"] } });
    const { h, jev, ctx } = await start(setup());
    await h.commands.get("approvals").handler(approval, ctx);
    await h.commands.get("mode").handler("chat", ctx);
    for (const [tool, input] of [["read", { path: "a.ts" }], ["bash", { command: "git log --oneline" }], ["web_search", { query: "x" }]] as const) expect(await h.emit("tool_call", call(tool, input), ctx)).toBeUndefined();
    for (const [tool, input] of [["edit", { path: "src/a.ts", edits: [] }], ["write", { path: "src/a.ts", content: "x" }], ["bash", { command: "npm test" }], ["mcp__notes__write", { text: "x" }], ["subagent", { task: "x" }]] as const) expect(await h.emit("tool_call", call(tool, input), ctx)).toMatchObject({ block: true, reason: expect.stringMatching(/Chat mode is on:/u) });
    expect(ctx.ui.selects).toHaveLength(0);
    expect(jev.calls).toHaveLength(0);
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
  test.each([false, true])("work/exec auto still judges ordinary mutations (exec=%s)", async exec => {
    const { h, jev, ctx } = await start(setup());
    h.pi.events.emit(EXEC_CHANGED, { active: exec, source: "transition" });
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    expect(await h.emit("tool_call", call("bash", { command: "npm test" }), ctx)).toBeUndefined();
    expect(jev.calls).toHaveLength(1);
  });
  test.each([false, true])("work/exec yolo retain critical-removal protections (exec=%s)", async exec => {
    const { h, jev, ctx } = await start(setup());
    h.pi.events.emit(EXEC_CHANGED, { active: exec, source: "transition" });
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

  test("explicit selections and Exec mark transitions while shortcut/event cycles use the settings journal", async () => {
    const { h, ctx } = await start(setup());
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plan.md" });
    await h.commands.get("mode").handler("chat", ctx);
    await h.shortcuts.get("shift+tab").handler(ctx);
    await settingsCycles(h.pi).flush();
    h.pi.events.emit(WORKFLOW_SET, { mode: "work" });
    h.pi.events.emit(WORKFLOW_CYCLE, {});
    await settingsCycles(h.pi).flush();
    h.pi.events.emit(EXEC_CHANGED, { active: true, source: "transition" });
    h.pi.events.emit(EXEC_CHANGED, { active: false, source: "transition" });
    expect(markers(h)).toEqual([
      ["work", "chat", "read-only discussion"],
      ["plan", "work", "edits and actions"],
      ["chat", "exec", "implementing approved plan"],
      ["exec", "work", "edits and actions"],
    ].map(([previous, mode, explanation]) => ({
      message: {
        customType: "workflow:transition", content: `${mode} · ${explanation}`,
        display: true, details: { version: 1, previous, mode },
      },
      opts: { triggerTurn: false },
    })));
  });

  test("startup, branch restores, queries, providers, approvals and repeated selections stay silent", async () => {
    const { h, ctx, branch } = await start(setup([entry(WORKFLOW_ENTRY, { version: 1, mode: "chat" })]));
    expect(markers(h)).toEqual([]);
    for (const mode of ["plan", "exec", "work"] as const) {
      branch.splice(0, branch.length, ...(mode === "exec"
        ? [entry("plan-mode:exec", { active: true })]
        : [entry(WORKFLOW_ENTRY, { version: 1, mode })]));
      await h.emit("session_tree", {}, ctx);
      expect(markers(h)).toEqual([]);
    }
    const reply = vi.fn();
    h.pi.events.emit(WORKFLOW_QUERY, { entries: [entry(WORKFLOW_ENTRY, { version: 1, mode: "plan" })], cwd: ctx.cwd, reply });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ mode: "plan", source: "restore" }));
    for (const planFile of ["/tmp/plan.md", "/tmp/plan.md", "/tmp/other-plan.md"]) h.pi.events.emit(PLAN_PROVIDER, { planFile });
    for (const active of [true, false]) h.pi.events.emit(EXEC_CHANGED, { active, source: "restore" });
    await h.commands.get("approvals").handler("yolo", ctx);
    await h.shortcuts.get("alt+a").handler(ctx);
    await settingsCycles(h.pi).flush();
    h.pi.events.emit(MODE_SET, { mode: "default" });
    h.pi.events.emit(MODE_CYCLE, {});
    await settingsCycles(h.pi).flush();
    await h.commands.get("mode").handler("work", ctx);
    h.pi.events.emit(WORKFLOW_SET, { mode: "work" });
    h.pi.events.emit(EXEC_CHANGED, { active: false, source: "transition" });
    expect(markers(h)).toEqual([]);
    h.pi.events.emit(EXEC_CHANGED, { active: true, source: "transition" });
    expect(markers(h)).toHaveLength(1);
    h.pi.events.emit(EXEC_CHANGED, { active: true, source: "transition" });
    h.pi.events.emit(WORKFLOW_SET, { mode: "chat" });
    expect(markers(h)).toHaveLength(1);
  });

  test.each([
    ["work", "success", "edits and actions"],
    ["chat", "thinkingLow", "read-only discussion"],
    ["plan", "customMessageLabel", "research and plan only"],
    ["exec", "warning", "implementing approved plan"],
  ])("registered renderer styles %s as a bold badge with a muted explanation", (mode, role, explanation) => {
    const { h } = setup();
    const renderer = h.messageRenderers.get("workflow:transition");
    expect(renderer).toBeTypeOf("function");
    const theme = {
      fg: vi.fn((role: string, text: string) => `<${role}>${text}</${role}>`),
      bold: vi.fn((text: string) => `<bold>${text}</bold>`),
    };
    const previous = mode === "work" ? "exec" : "work";
    const rendered = renderer!({ content: "fallback", details: { version: 1, previous, mode } }, { expanded: false }, theme);
    expect(rendered.render(200).map((line: string) => line.trimEnd())).toEqual([`<bold><${role}>${mode}</${role}></bold><dim> · </dim><muted>${explanation}</muted>`]);
    expect(theme.fg.mock.calls).toEqual([[role, `${mode}`], ["dim", " · "], ["muted", explanation]]);
    expect(theme.bold.mock.calls).toEqual([[`<${role}>${mode}</${role}>`]]);
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

describe("flow commands, protocol and optional footer actions", () => {
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
    expect(await requestWorkflow(h.pi.events, "plan")).toMatchObject({ ok: false });
    expect(await requestWorkflow(h.pi.events, "chat")).toMatchObject({ ok: true, snapshot: { operatingMode: "independent", workflow: "chat" } });
  });
  test("queries and actions are absent before startup, pure when ready, and stale after tree/shutdown", async () => {
    const s = setup();
    expect(queryFlow(s.h.pi.events)).toBeUndefined();
    expect(queryFooterActions(s.h.pi.events)).toEqual({});
    await start(s);
    const before = s.h.entries.length;
    const snapshot = queryFlow(s.h.pi.events, true);
    expect(snapshot).toMatchObject({ operatingMode: "independent", ready: true, workflow: "work" });
    const actions = queryFooterActions(s.h.pi.events);
    expect(Object.keys(actions)).toEqual(["workflow.cycle", "workflow.open", "flow.open", "approvals.open"]);
    expect(actions["workflow.cycle"]?.key).toBe("shift+tab");
    expect(actions["approvals.open"]?.key).toBe("alt+a");
    expect(s.h.entries).toHaveLength(before);
    s.ctx.ui.selectAnswers.push(undefined);
    await actions["approvals.open"]!.run();
    expect(s.ctx.ui.selects.at(-1)).toEqual({ title: "Approvals", options: ["Auto", "Yolo"] });
    expect(s.ctx.ui.status.get(MODE_STATUS_KEY)).toContain("auto");
    await s.h.emit("session_tree", {}, s.ctx);
    const selects = s.ctx.ui.selects.length;
    await actions["approvals.open"]!.run();
    expect(s.ctx.ui.selects).toHaveLength(selects);
    await s.h.emit("session_shutdown", {}, s.ctx);
    expect(queryFlow(s.h.pi.events)).toBeUndefined();
    expect(queryFooterActions(s.h.pi.events)).toEqual({});
  });
  test("Independent operating picker is short and cannot change models without a ready role provider", async () => {
    const s = await start(setup());
    s.ctx.isIdle = () => true;
    s.ctx.model = { provider: "test", id: "local" };
    s.ctx.modelRegistry = { getAvailable: async () => [{ ...s.ctx.model, api: "openai-completions" }] };
    await s.h.commands.get("flow").handler("", s.ctx);
    expect(s.ctx.ui.selects.at(-1)).toEqual({ title: "Operating mode", options: ["Independent", "Flow status"] });
    await s.h.commands.get("flow").handler("linked", s.ctx);
    expect(s.ctx.ui.notes.at(-1)?.message).toMatch(/Role defaults unavailable/u);
    expect(queryFlow(s.h.pi.events)?.operatingMode).toBe("independent");
    expect(s.h.entries.some(entry => entry.customType === FLOW_ENTRY)).toBe(false);
    await s.h.commands.get("flow").handler("status", s.ctx);
    expect(s.ctx.ui.notes.at(-1)?.message).toMatch(/Available flows: none.*Role defaults unavailable/su);
  });
  test("malformed restored Linked stays locked and blocks every prompt source and tool until explicit recovery", async () => {
    const s = await start(setup([
      entry(WORKFLOW_ENTRY, { version: 1, mode: "plan" }),
      entry(APPROVAL_ENTRY, { version: 1, mode: "bypassPermissions" }),
      entry(FLOW_ENTRY, { version: 1, operatingMode: "linked", revision: 8 }),
    ]));
    s.ctx.isIdle = () => true;
    expect(queryFlow(s.h.pi.events)).toMatchObject({ operatingMode: "linked", blocked: expect.stringContaining("missing or invalid") });
    expect(s.ctx.ui.status.get("tool-gate:flow")).toBe("Linked blocked · /flow");
    queryFlow(s.h.pi.events, true);
    expect(s.ctx.ui.status.get("tool-gate:flow")).toBeUndefined();
    for (const source of ["interactive", "rpc", "extension"]) expect(await s.h.emit("input", { text: "act", source }, s.ctx)).toEqual({ action: "handled" });
    expect(await s.h.emit("tool_call", call("read", { path: "src/a.ts" }), s.ctx)).toMatchObject({ block: true, reason: expect.stringContaining("missing or invalid") });
    s.ctx.abort = vi.fn(); // This factory-only host has no captured native session.
    await s.h.emit("before_agent_start", {}, s.ctx);
    expect(s.ctx.abort).toHaveBeenCalledOnce();
    expect(s.ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("plan");
    await s.h.commands.get("flow").handler("independent", s.ctx);
    expect(queryFlow(s.h.pi.events)).toMatchObject({ operatingMode: "independent", workflow: "plan" });
    expect(await s.h.emit("input", { text: "act", source: "extension" }, s.ctx)).toBeUndefined();
    expect(s.ctx.ui.status.get(MODE_STATUS_KEY)).toContain("yolo");
    expect(s.h.entries.filter(e => e.customType === WORKFLOW_ENTRY || e.customType === APPROVAL_ENTRY)).toEqual([]);
  });
  test("Linked Exec pickers offer status and Independent, not new workflows or providers", async () => {
    const s = await start(setup([
      entry("plan-mode:exec", { active: true, planFile: "/tmp/approved.md" }),
      entry(FLOW_ENTRY, { version: 1, operatingMode: "linked", revision: 1 }),
    ]));
    s.ctx.isIdle = () => true;
    const status = vi.fn();
    s.h.pi.events.on("pi-plugins.footer-actions.v1", (request: any) => { request.actions["execution.status"] = { label: "Execution status", run: status }; });
    const actions = queryFooterActions(s.h.pi.events);
    expect(actions["workflow.cycle"]?.key).toBeUndefined();
    await actions["workflow.cycle"]!.run();
    expect(status).toHaveBeenCalledTimes(1);
    for (const command of ["mode", "flow"]) {
      await s.h.commands.get(command).handler("", s.ctx);
      expect(s.ctx.ui.selects.at(-1)?.options).toEqual(["Execution status", "Use Independent mode"]);
    }
    await s.h.commands.get("flow").handler("independent", s.ctx);
    expect(queryFlow(s.h.pi.events)).toMatchObject({ operatingMode: "independent", workflow: "exec" });
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

describe("subagents inherit approvals", () => {
  const request = (h: ReturnType<typeof harness>, probe = false) => {
    const req: any = { version: 1, env: {}, ...(probe ? { probe: true } : {}) };
    h.pi.events.emit("pi-plugins.subagent-env.v1", req);
    return req.env;
  };
  test("a parent passes its approval down, and chat to children of chat or plan", async () => {
    const { h, ctx } = await start(setup());
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plan.md" });
    expect(request(h)).toEqual({ PI_TOOL_GATE_APPROVAL: "auto" });
    await h.commands.get("approvals").handler("yolo", ctx);
    expect(request(h)).toEqual({ PI_TOOL_GATE_APPROVAL: "bypassPermissions" });
    for (const mode of ["chat", "plan"]) {
      await h.commands.get("mode").handler(mode, ctx);
      expect(request(h)).toEqual({ PI_TOOL_GATE_APPROVAL: "bypassPermissions", PI_TOOL_GATE_WORKFLOW: "chat" });
    }
    expect(request(h, true)).toEqual({});
  });
  test("a subagent starts with what it inherited unless its branch records otherwise", async () => {
    vi.stubEnv("PI_SUBAGENT", "1");
    vi.stubEnv("PI_TOOL_GATE_APPROVAL", "bypassPermissions");
    vi.stubEnv("PI_TOOL_GATE_WORKFLOW", "chat");
    const child = await start(setup());
    expect(child.ctx.ui.status.get(MODE_STATUS_KEY)).toContain("yolo");
    expect(child.ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("chat");
    const forked = await start(setup([entry(APPROVAL_ENTRY, { version: 1, mode: "auto" }), entry(WORKFLOW_ENTRY, { version: 1, mode: "work" })]));
    expect(forked.ctx.ui.status.get(MODE_STATUS_KEY)).toContain("auto");
    expect(forked.ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("work");
  });
  test("outside a subagent, or with an unknown value, the variables change nothing", async () => {
    vi.stubEnv("PI_TOOL_GATE_APPROVAL", "bypassPermissions");
    vi.stubEnv("PI_TOOL_GATE_WORKFLOW", "chat");
    const plain = await start(setup());
    expect(plain.ctx.ui.status.get(MODE_STATUS_KEY)).toContain("auto");
    expect(plain.ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("work");
    vi.stubEnv("PI_SUBAGENT", "1");
    vi.stubEnv("PI_TOOL_GATE_APPROVAL", "yolo");
    vi.stubEnv("PI_TOOL_GATE_WORKFLOW", "work");
    const odd = await start(setup());
    expect(odd.ctx.ui.status.get(MODE_STATUS_KEY)).toContain("auto");
    expect(odd.ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("work");
  });
});
