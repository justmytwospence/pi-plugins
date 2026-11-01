import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import nextPrompt from "../src/index.ts";
import { SYSTEM1_CHANGED } from "../src/system1.js";
import { harness } from "./harness.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "next-system1-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
const backend = (value: string) => writeFileSync(path.join(root, "system1.json"), JSON.stringify({ backend: value }));
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

async function setup(ghost = false) {
  const h = harness();
  const diagnostics = nextPrompt(h.pi);
  const calls: Array<{ model: any; signal: AbortSignal; finish: (probability?: number, error?: boolean) => void }> = [];
  // Entirely local fake, including native adapter metadata. No credential lookup or network.
  const registry = {
    findOfType: (_type: string, provider: string, id: string) => ({ provider, id, api: "openai-decisions", baseUrl: "https://api.openai.com/v1" }),
    classify: (model: any, _context: unknown, options: { signal: AbortSignal }) => new Promise((resolve) => {
      calls.push({ model, signal: options.signal, finish: (probability = 0.9, error = false) => resolve({
        model: model.id, stopReason: error ? "error" : "stop", answers: { useful: { type: "bool", probability } }, ...(error ? { errorMessage: "unavailable" } : {}),
      }) });
    }),
  };
  const ctx = h.ctx({ cwd: root, modelRegistry: registry });
  const ui = ctx.ui;
  if (ghost) ui.editor.render = () => ["\x1b[7m \x1b[0m"];
  await h.emit("session_start", {}, ctx);
  const begin = async (text: string) => {
    await h.emit("input", { text: "go" }, ctx);
    await h.emit("agent_start", {}, ctx);
    await h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: `Done.\n<next>${text}</next>` }] } }, ctx);
    await h.emit("agent_before_settle", { outcome: "completed" }, ctx);
    return { settled: h.emit("agent_settled", {}, ctx) };
  };
  const rendered = () => (ghost ? ui.renderEditor() : ui.widgetLines("next-prompt"))?.join("").replace(/\x1b\[[0-9;]*m/g, "") ?? "";
  return { h, ctx, ui, diagnostics, calls, begin, rendered };
}

test.each([0.1, 0.9, undefined])("watcher-independent delayed vetting discards the old backend (%s)", async probability => {
  const s = await setup();
  const { settled } = await s.begin("Old backend handoff");
  expect(s.calls).toHaveLength(1);
  backend("openai-decisions");
  s.calls[0]!.finish(probability, probability === undefined);
  await settled;
  expect(s.rendered()).toBe("");
  expect(s.diagnostics().offer).toBe("none");
  expect(s.diagnostics().vet).toContain("System 1 changed");
  expect(s.ui.editorWrites).toEqual([]);
});

test("a change event cancels pending vetting without stale fail-open display", async () => {
  const s = await setup();
  const { settled } = await s.begin("Old handoff");
  backend("openai-decisions");
  s.h.pi.events.emit(SYSTEM1_CHANGED, {});
  expect(s.calls[0]!.signal.aborted).toBe(true);
  await settled;
  expect(s.diagnostics().offer).toBe("none");
  s.calls[0]!.finish();
  await flush();
  expect(s.rendered()).toBe("");
});

test.each([0.1, 0.9])("old backend result cannot show or remove the new backend's suggestion (%s)", async probability => {
  const s = await setup();
  const old = await s.begin("Old backend handoff");
  backend("openai-decisions");
  s.h.pi.events.emit(SYSTEM1_CHANGED, {});
  const fresh = await s.begin("New backend handoff");
  expect(s.calls[1]!.model).toMatchObject({ provider: "system1-openai", id: "gpt-6-luna" });
  s.calls[1]!.finish();
  await fresh.settled;
  expect(s.rendered()).toContain("New backend handoff");
  s.calls[0]!.finish(probability);
  await old.settled;
  await flush();
  expect(s.rendered()).toContain("New backend handoff");
  expect(s.diagnostics().vet).toBe("approved");
  expect(s.ui.press("\t")).toBe(true);
  expect(s.ui.editorText).toBe("New backend handoff");
});

test("another generation on the same backend owns its verdict and display", async () => {
  const s = await setup();
  const old = await s.begin("Old generation");
  const fresh = await s.begin("New generation");
  s.calls[1]!.finish();
  await fresh.settled;
  s.calls[0]!.finish(0.1);
  await old.settled;
  expect(s.rendered()).toContain("New generation");
  expect(s.diagnostics().vet).toBe("approved");
});

test.each(["external", "explicit"])("a stale vet cannot withdraw a newer %s offer", async kind => {
  const s = await setup();
  const old = await s.begin("Automatic handoff");
  if (kind === "external") s.h.pi.events.emit("prompt:offer", { source: "fixture", text: "Owned handoff" });
  else {
    const result = s.h.tools.get("offer_prompt").execute("offer", { text: "Owned handoff" }, undefined, undefined, s.ctx);
    expect(s.rendered()).toContain("Owned handoff");
    await flush();
    expect((await result).details.status).toBe("displayed");
  }
  backend("openai-decisions");
  s.h.pi.events.emit(SYSTEM1_CHANGED, {});
  s.calls[0]!.finish(0.1);
  await old.settled;
  expect(s.rendered()).toContain("Owned handoff");
  expect(s.ui.press("\t")).toBe(true);
  expect(s.ui.editorText).toBe("Owned handoff");
});

test.each([false, true].flatMap(ghost => ["accept", "stash", "event", "draft-clear"].map(action => ({ ghost, action }))))("old automatic offer is invalidated at $action (ghost=$ghost)", async ({ ghost, action }) => {
  const s = await setup(ghost);
  const current = await s.begin("Stale automatic handoff");
  s.calls[0]!.finish();
  await current.settled;
  expect(s.rendered()).toContain("Stale automatic handoff");
  if (action === "draft-clear") {
    s.ui.edit("private draft");
    await flush();
  }
  backend("openai-decisions");
  if (action === "accept") expect(s.ui.press("\t")).toBe(false);
  else if (action === "stash") {
    const request: { text?: string } = {};
    s.h.pi.events.emit("prompt:take-next", request);
    expect(request.text).toBeUndefined();
  } else if (action === "event") s.h.pi.events.emit(SYSTEM1_CHANGED, {});
  else {
    s.ui.setEditorText("");
    await flush();
  }
  expect(s.rendered()).not.toContain("Stale automatic handoff");
  expect(s.diagnostics().offer).toBe("none");
  expect(s.ui.editorText).toBe("");
  expect(s.ui.editorWrites).toEqual(action === "draft-clear" ? [""] : []);
});

test("a current-backend classifier failure still fails open without touching the draft", async () => {
  backend("openai-decisions");
  const s = await setup();
  s.ui.edit("private draft");
  const current = await s.begin("Fail-open handoff");
  s.calls[0]!.finish(0.9, true);
  await current.settled;
  expect(s.diagnostics().vet).toBe("unavailable (shown)");
  expect(s.diagnostics().offer).toBe("concealed");
  expect(s.ui.editorText).toBe("private draft");
  expect(s.ui.editorWrites).toEqual([]);
  s.ui.edit("");
  await flush();
  expect(s.rendered()).toContain("Fail-open handoff");
});
