import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isAcceptEditsBash } from "../src/bash.ts";
import toolGate from "../src/index.ts";
import { cycleOf, MODE_CHANGED, MODE_ENTRY, nextMode, parseMode, PLAN_PROVIDER } from "../src/modes.ts";
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
  in_scope: { type: "bool", probability: 0.95 },
  irreversible: { type: "bool", probability: 0.05 },
  remote_change: { type: "bool", probability: 0.02 },
  exfiltration: { type: "bool", probability: 0.01 },
  impact: { type: "score", score: 1, confidence: 0.9 },
};

const call = (toolName: string, input: Record<string, unknown>, id = "t1") => ({ type: "tool_call", toolCallId: id, toolName, input });

function setup(branch: any[] = [userEntry("Fix the failing test")]) {
  const h = harness();
  toolGate(h.pi);
  const jev = fakeJev(() => safe);
  const ctx = h.ctx({ modelRegistry: jev.registry, sessionManager: { getBranch: () => branch } });
  return { h, jev, ctx };
}

describe("mode helpers", () => {
  test("parseMode takes config values, Claude Code names and short names", () => {
    expect(parseMode("manual")).toBe("default");
    expect(parseMode("acceptEdits")).toBe("acceptEdits");
    expect(parseMode("accept-edits")).toBe("acceptEdits");
    expect(parseMode("bypass")).toBe("bypassPermissions");
    expect(parseMode("chat")).toBe("chat");
    expect(parseMode("nope")).toBeUndefined();
  });

  test("the cycle follows Claude Code's order; plan only with a provider", () => {
    const all = ["auto", "plan", "default", "acceptEdits", "bypassPermissions"] as const;
    expect(cycleOf(all, { plan: true })).toEqual(["default", "acceptEdits", "plan", "bypassPermissions", "auto"]);
    expect(cycleOf(all, { plan: false })).toEqual(["default", "acceptEdits", "bypassPermissions", "auto"]);
    expect(nextMode("auto", ["default", "acceptEdits", "plan", "auto"])).toBe("default");
    expect(nextMode("bypassPermissions", ["default", "auto"])).toBe("default");
    expect(cycleOf(["auto", "chat", "plan"], { plan: true })).toEqual(["chat", "plan", "auto"]);
  });
});

describe("isAcceptEditsBash", () => {
  const cwd = "/Users/me/Projects/app";
  test("filesystem commands inside the project", () => {
    expect(isAcceptEditsBash("mkdir -p src/new && touch src/new/a.ts", cwd)).toBe(true);
    expect(isAcceptEditsBash("mv src/a.ts src/b.ts", cwd)).toBe(true);
    expect(isAcceptEditsBash("sed -i 's/a/b/' src/a.ts", cwd)).toBe(true);
    expect(isAcceptEditsBash("rm -rf build && ls", cwd)).toBe(true);
  });
  test("anything else, or a file outside the project, is not covered", () => {
    expect(isAcceptEditsBash("npm install", cwd)).toBe(false);
    expect(isAcceptEditsBash("cp src/a.ts /tmp/a.ts", cwd)).toBe(false);
    expect(isAcceptEditsBash("cd /tmp && touch x", cwd)).toBe(false);
    expect(isAcceptEditsBash("rm -rf .", cwd)).toBe(false);
    expect(isAcceptEditsBash("touch .env", cwd)).toBe(false);
    expect(isAcceptEditsBash("sed -i 's/a/b/w out' src/a.ts", cwd)).toBe(false);
    expect(isAcceptEditsBash("touch $(echo x)", cwd)).toBe(false);
    expect(isAcceptEditsBash("echo hi > src/a.ts", cwd)).toBe(false);
  });
});

describe("modes", () => {
  test("a new session starts in auto mode and shows it", async () => {
    const { h, ctx } = setup();
    await h.emit("session_start", { type: "session_start" }, ctx);
    expect(ctx.ui.status.get("permission-mode")).toBe("⏵⏵ auto mode on (shift+tab to cycle)");
    expect(h.shortcuts.has("shift+tab")).toBe(true);
    expect(h.events.at(-1)).toMatchObject({ channel: MODE_CHANGED, data: { mode: "auto" } });
  });

  test("shift+tab cycles; plan joins once pi-plan-mode announces itself", async () => {
    const { h, ctx } = setup();
    await h.emit("session_start", { type: "session_start" }, ctx);
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plan.md" });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await h.shortcuts.get("shift+tab").handler(ctx);
      seen.push(ctx.ui.status.get("permission-mode"));
    }
    expect(seen.map((s) => s.replace(/ \(.*\)$/u, ""))).toEqual([
      "⏸ manual mode on",
      "⏵⏵ accept edits on",
      "⏸ plan mode on",
      "⏵⏵ auto mode on",
    ]);
    expect(h.entries.filter((e) => e.customType === MODE_ENTRY).map((e: any) => e.data.mode)).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "auto",
    ]);
  });

  test("a resumed session comes back in its recorded mode", async () => {
    const { h, ctx } = setup([{ type: "custom", customType: MODE_ENTRY, data: { mode: "acceptEdits" } }]);
    await h.emit("session_start", { type: "session_start" }, ctx);
    expect(ctx.ui.status.get("permission-mode")).toMatch(/^⏵⏵ accept edits on/u);
  });

  test("manual mode asks about anything that does more than read, without Jev", async () => {
    const { h, jev, ctx } = setup();
    await h.emit("session_start", { type: "session_start" }, ctx);
    await h.commands.get("mode").handler("manual", ctx);
    expect(await h.emit("tool_call", call("read", { path: "a.ts" }), ctx)).toBeUndefined();
    ctx.ui.selectAnswers.push("Block");
    expect(await h.emit("tool_call", call("edit", { path: "src/a.ts", edits: [] }), ctx)).toMatchObject({ block: true });
    ctx.ui.selectAnswers.push("Allow once");
    expect(await h.emit("tool_call", call("bash", { command: "npm test" }), ctx)).toBeUndefined();
    expect(jev.calls).toHaveLength(0);
    expect(ctx.ui.selects).toHaveLength(2);
  });

  test("accept-edits mode runs project edits and filesystem commands, asks about the rest", async () => {
    const { h, ctx } = setup();
    await h.emit("session_start", { type: "session_start" }, ctx);
    await h.commands.get("mode").handler("accept-edits", ctx);
    expect(await h.emit("tool_call", call("write", { path: "src/new.ts", content: "x" }), ctx)).toBeUndefined();
    expect(await h.emit("tool_call", call("bash", { command: "mkdir -p src/lib" }), ctx)).toBeUndefined();
    ctx.ui.selectAnswers.push("Block");
    expect(await h.emit("tool_call", call("write", { path: "/etc/hosts", content: "x" }), ctx)).toMatchObject({ block: true });
    ctx.ui.selectAnswers.push("Block");
    expect(await h.emit("tool_call", call("bash", { command: "npm publish" }), ctx)).toMatchObject({ block: true });
    expect(ctx.ui.selects).toHaveLength(2);
  });

  test("bypass mode runs everything but critical removals", async () => {
    const { h, jev, ctx } = setup();
    await h.commands.get("mode").handler("bypass", ctx);
    expect(await h.emit("tool_call", call("bash", { command: "npm publish" }), ctx)).toBeUndefined();
    expect(await h.emit("tool_call", call("write", { path: "/etc/hosts", content: "x" }), ctx)).toBeUndefined();
    ctx.ui.selectAnswers.push("Block");
    expect(await h.emit("tool_call", call("bash", { command: "rm -rf ~" }), ctx)).toMatchObject({ block: true });
    expect(jev.calls).toHaveLength(0);
  });

  test("plan mode allows only the plan file to be written; commands go to Jev", async () => {
    const { h, jev, ctx } = setup();
    await h.emit("session_start", { type: "session_start" }, ctx);
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plans/calm-river.md" });
    h.pi.events.emit("permission-mode:set", { mode: "plan" });
    expect(ctx.ui.status.get("permission-mode")).toMatch(/^⏸ plan mode on/u);
    expect(await h.emit("tool_call", call("write", { path: "/tmp/plans/calm-river.md", content: "# Plan" }), ctx)).toBeUndefined();
    expect(await h.emit("tool_call", call("edit", { path: "src/a.ts", edits: [] }), ctx)).toMatchObject({ block: true, reason: expect.stringMatching(/plan file/u) });
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    expect(await h.emit("tool_call", call("bash", { command: "npm test" }), ctx)).toBeUndefined();
    expect(jev.calls).toHaveLength(1);
    expect(h.events.filter((e) => e.channel === MODE_CHANGED).at(-1)?.data).toMatchObject({ mode: "plan", previous: "auto", prePlanMode: "auto" });
  });

  test("plan mode is refused without pi-plan-mode", async () => {
    const { h, ctx } = setup();
    await h.emit("session_start", { type: "session_start" }, ctx);
    await h.commands.get("mode").handler("plan", ctx);
    expect(ctx.ui.notes.at(-1)?.message).toMatch(/needs pi-plan-mode/u);
    expect(ctx.ui.status.get("permission-mode")).toMatch(/^⏵⏵ auto mode on/u);
  });

  test("chat mode runs only read-only calls and blocks the rest without asking", async () => {
    const { h, jev, ctx } = setup();
    await h.emit("session_start", { type: "session_start" }, ctx);
    await h.commands.get("mode").handler("chat", ctx);
    expect(ctx.ui.status.get("permission-mode")).toBe("⏸ chat mode on (shift+tab to cycle)");
    expect(await h.emit("tool_call", call("read", { path: "a.ts" }), ctx)).toBeUndefined();
    expect(await h.emit("tool_call", call("bash", { command: "git log --oneline" }), ctx)).toBeUndefined();
    expect(await h.emit("tool_call", call("web_search", { query: "x" }), ctx)).toBeUndefined();
    for (const [tool, input] of [
      ["edit", { path: "src/a.ts", edits: [] }],
      ["write", { path: "src/a.ts", content: "x" }],
      ["bash", { command: "npm test" }],
      ["subagent", { task: "x" }],
    ] as const) {
      expect(await h.emit("tool_call", call(tool, input), ctx)).toMatchObject({ block: true, reason: expect.stringMatching(/Chat mode is on/u) });
    }
    expect(ctx.ui.selects).toHaveLength(0);
    expect(jev.calls).toHaveLength(0);
  });

  test("chat mode tells the agent with the next message, once, and again on leaving", async () => {
    const { h, ctx } = setup();
    await h.emit("session_start", { type: "session_start" }, ctx);
    expect(await h.emit("before_agent_start", { prompt: "x" }, ctx)).toBeUndefined();
    await h.commands.get("mode").handler("chat", ctx);
    const enter: any = await h.emit("before_agent_start", { prompt: "x" }, ctx);
    expect(enter.message.content).toMatch(/Chat mode is active/u);
    expect(await h.emit("before_agent_start", { prompt: "x" }, ctx)).toBeUndefined();
    await h.commands.get("mode").handler("auto", ctx);
    const exit: any = await h.emit("before_agent_start", { prompt: "x" }, ctx);
    expect(exit.message.content).toMatch(/left chat mode.*auto mode.*may now make edits/su);
  });

  test("a chat mode change mid-turn steers the agent right away", async () => {
    const { h, ctx } = setup();
    ctx.isIdle = () => false;
    await h.emit("session_start", { type: "session_start" }, ctx);
    await h.commands.get("mode").handler("chat", ctx);
    expect(h.messages.at(-1)).toMatchObject({ opts: { deliverAs: "steer" }, message: { content: expect.stringMatching(/Chat mode is active/u) } });
    expect(await h.emit("before_agent_start", { prompt: "x" }, ctx)).toBeUndefined();
  });

  test("modes limits the cycle; /mode still lists every mode", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.join(configDir, "xdg", "agents"), { recursive: true });
    writeFileSync(path.join(configDir, "xdg", "agents", "tool-gate.json"), JSON.stringify({ modes: ["chat", "plan", "auto"] }));
    const { h, ctx } = setup();
    await h.emit("session_start", { type: "session_start" }, ctx);
    h.pi.events.emit(PLAN_PROVIDER, { planFile: "/tmp/plan.md" });
    ctx.ui.selectAnswers.push(undefined);
    await h.commands.get("mode").handler("", ctx);
    expect(ctx.ui.selects[0].options.map((o: string) => o.slice(2).split(" ")[0])).toEqual(["chat", "manual", "accept-edits", "plan", "auto", "bypass"]);
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      await h.shortcuts.get("shift+tab").handler(ctx);
      seen.push(ctx.ui.status.get("permission-mode")!.replace(/ \(.*\)$/u, ""));
    }
    expect(seen).toEqual(["⏸ chat mode on", "⏸ plan mode on", "⏵⏵ auto mode on"]);
  });
});
