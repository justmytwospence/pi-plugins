import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { emptyUsage, setPiInvocation } from "../src/child.ts";
import subagents, { recordedRun } from "../src/index.ts";
import { harness } from "./harness.ts";
import { fakeUI } from "./ui-helpers.ts";

afterEach(() => { setPiInvocation(undefined); vi.unstubAllEnvs(); });

test("native fresh and forked SessionManagers expose the selected path before a child prompt", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "subagents-native-"));
  const sessions = path.join(cwd, "sessions");
  const fresh = SessionManager.create(cwd, sessions);
  const freshPath = fresh.getSessionFile()!;
  expect(path.dirname(freshPath)).toBe(sessions);
  // A fresh session's filename is known before Pi flushes its first assistant response.
  expect(existsSync(freshPath)).toBe(false);
  fresh.appendMessage({ role: "user", content: "parent task", timestamp: 1 });
  fresh.appendMessage({ role: "assistant", content: [{ type: "text", text: "parent answer" }], api: "anthropic-messages", provider: "fixture", model: "fixture", usage: emptyUsage(), stopReason: "stop", timestamp: 2 });
  expect(existsSync(freshPath)).toBe(true);
  const fork = SessionManager.forkFrom(freshPath, cwd, sessions);
  expect(fork.getSessionFile()).not.toBe(freshPath);
  expect(path.dirname(fork.getSessionFile()!)).toBe(sessions);
  expect(existsSync(fork.getSessionFile()!)).toBe(true);
  expect(fork.getHeader()?.parentSession).toBe(freshPath);
});

test.each(["fresh", "fork"] as const)("%s child history propagates through details, running/completed records, restore, and the custom viewer", async (context) => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "subagents-history-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("FAKE_NO_DIALOG", "1");
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures/fake-pi.mjs")] });
  const h = harness();
  let tool: any;
  h.pi.registerTool = (t: unknown) => void (tool = t);
  subagents(h.pi);
  const ui = fakeUI();
  const ctx = h.ctx({ cwd: agentDir, ui, sessionManager: { getBranch: () => [], getSessionFile: () => "/parent/source.jsonl" } });
  await h.emit("session_start", {}, ctx);
  try {
    const updates: any[] = [];
    const result = await tool.execute("run", { task: "native history", context, agent: "general", model: "fixture/model", thinking: "low" }, undefined, (update: unknown) => updates.push(update), ctx);
    expect(result.details.mode).toBe("single");
    expect(result.details.runs).toHaveLength(1);
    const run = result.details.runs[0];
    expect(run).toMatchObject({ task: "native history", status: "done", output: expect.stringContaining("task=native history") });
    const kind = context === "fork" ? "forked" : "fresh";
    expect(run.sessionFile).toMatch(new RegExp(`^${agentDir}/subagents/sessions/pi-chose-${kind}-\\d+\\.jsonl$`, "u"));
    expect(run.sessionFile).not.toBe("/parent/source.jsonl");
    expect(updates.some((update) => update.details.runs.some((r: any) => r.sessionFile === run.sessionFile))).toBe(true);
    const records = h.entries.filter((entry) => entry.customType === "subagents:run").map((entry) => entry.data as any);
    expect(records.some((record) => record.status === "running" && record.sessionFile === run.sessionFile)).toBe(true);
    expect(records.at(-1)).toMatchObject({ id: run.id, sessionFile: run.sessionFile, status: "done" });
    const restored = recordedRun(records.at(-1));
    expect(restored.state.sessionFile).toBe(run.sessionFile);
    expect(restored.conversation.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    for (const action of ["status", "result"]) {
      const snapshot = await tool.execute(action, { action, id: run.id }, undefined, undefined, ctx);
      expect(snapshot.details.runs[0].sessionFile).toBe(run.sessionFile);
    }
    await h.emit("session_shutdown", {}, ctx);
    // A fresh runtime restores the recorded run and still uses its custom transcript viewer.
    const reloaded = harness();
    subagents(reloaded.pi);
    const reloadedCtx = reloaded.ctx({ cwd: agentDir, ui, sessionManager: { getBranch: () => h.entries.map((entry) => ({ ...entry, type: "custom" })) } });
    await reloaded.emit("session_start", {}, reloadedCtx);
    const opened = reloaded.commands.get("subagents").handler(run.id, reloadedCtx);
    expect(ui.customs).toHaveLength(1);
    expect(ui.customs[0]!.component.render(80).join("\n")).toContain("task=native history");
    ui.customs[0]!.component.handleInput("q");
    await opened;
    await reloaded.emit("session_shutdown", {}, reloadedCtx);
  } finally {
    await h.emit("session_shutdown", {}, ctx);
  }
});
