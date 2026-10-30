import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
} from "../src/modes.ts";
import { fakeJev, harness, userEntry } from "./harness.ts";

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "pi-tool-gate-modes-"));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(configDir, "xdg"));
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(configDir, "pi"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});
const safe = {
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
  const h = harness();
  toolGate(h.pi);
  const jev = fakeJev(() => safe);
  const ctx = h.ctx({ modelRegistry: jev.registry, sessionManager: { getBranch: () => branch } });
  return { h, jev, ctx, branch };
}
const start = async (s: ReturnType<typeof setup>) => { await s.h.emit("session_start", { type: "session_start" }, s.ctx); return s; };

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
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plan.md" });
    for (const mode of ["chat", "plan", "work"]) {
      await h.shortcuts.get("shift+tab").handler(ctx);
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
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("yolo");
    await h.commands.get("gate").handler("on", ctx);
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("auto");
    await h.commands.get("gate").handler("off", ctx);
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain("chat");
  });
  test("bare pickers have undecorated short rows and use the blocked helper", async () => {
    const { h, ctx } = await start(setup());
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plan.md" });
    for (const [command, options, answer] of [["mode", ["Work", "Chat", "Plan"], "Chat"], ["approvals", ["Auto", "Yolo"], "Yolo"]] as const) {
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
    h.pi.events.emit(WORKFLOW_SET, { mode: "work" });
    expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toBe("workflow: exec");
    await h.shortcuts.get("alt+a").handler(ctx);
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
    expect(h.events.every(event => event.channel === WORKFLOW_QUERY)).toBe(true);
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
      expect(ctx.ui.status.get(WORKFLOW_STATUS_KEY)).toContain(workflow);
    }
    await h.shortcuts.get("alt+a").handler(ctx);
    expect(ctx.ui.status.get(MODE_STATUS_KEY)).toContain("yolo");
  });
});

describe("workflow guards precede approvals", () => {
  test.each(["auto", "yolo"])("plan+%s only writes its plan file and still judges commands", async approval => {
    const { h, jev, ctx } = await start(setup());
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plans/calm-river.md" });
    await h.commands.get("approvals").handler(approval, ctx);
    h.pi.events.emit(WORKFLOW_SET, { mode: "plan" });
    expect(await h.emit("tool_call", call("write", { path: "/tmp/plans/calm-river.md", content: "# Plan" }), ctx)).toBeUndefined();
    for (const tool of ["edit", "write"]) expect(await h.emit("tool_call", call(tool, { path: "src/a.ts", content: "x", edits: [] }), ctx)).toMatchObject({ block: true, reason: expect.stringMatching(/Plan mode is on:.*plan file/su) });
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    expect(await h.emit("tool_call", call("bash", { command: "npm test" }), ctx)).toBeUndefined();
    expect(jev.calls).toHaveLength(1);
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
    expect(jev.calls).toHaveLength(0);
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
    expect(h.messages.at(-1)).toMatchObject({ opts: { deliverAs: "steer" }, message: { content: expect.stringMatching(/Chat mode is active/u) } });
    expect(await h.emit("before_agent_start", { prompt: "x" }, ctx)).toBeUndefined();
  });
});
