import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters as plain } from "node:util";
import { test } from "vitest";

const sdk = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url));
const { createJiti } = await import(pathToFileURL(path.join(sdk, "dist/core/extensions/jiti-loader.js")));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { layoutFooter } = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const { querySystem1State, SYSTEM1_STATE_CHANNEL } = await jiti.import(fileURLToPath(new URL("../src/system1-contract.ts", import.meta.url)));
const { createFooterComponent, createFooterActionController } = await jiti.import(fileURLToPath(new URL("../src/interactions.ts", import.meta.url)));
const { visibleWidth, sliceByColumn } = await import(pathToFileURL(fileURLToPath(new URL("../node_modules/@earendil-works/pi-tui/dist/index.js", import.meta.url))));
const theme = { fg: (_color, text) => text, bold: (text) => text };
const status = (state = "ready", waterfall = ["jev", "openai-decisions"], actual) => ({
  waterfall, status: state,
  candidates: waterfall.map(backend => ({ backend, local: "configured",
    provider: backend === "jev" ? "typesafe" : "system1-openai", model: backend === "jev" ? "jev-latest" : "gpt-6-luna" })),
  ...(actual ? { lastUsed: { backend: actual, provider: actual === "jev" ? "typesafe" : "system1-openai",
    model: actual === "jev" ? "jev-latest" : "gpt-6-luna", at: 1900, fallback: true } } : {}),
});
const cases = () => [
  { state: status(), expected: "S1 Jev" },
  { state: status("ready", ["openai-decisions", "jev"]), expected: "S1 OpenAI" },
  { state: status("ready", ["jev"]), expected: "S1 Jev" },
  { state: status("ready", ["openai-decisions"]), expected: "S1 OpenAI" },
  { state: status("fallback", ["jev", "openai-decisions"], "openai-decisions"), expected: "S1 OpenAI" },
  { state: status("fallback", ["openai-decisions", "jev"], "jev"), expected: "S1 Jev" },
  { state: { ...status(), candidates: status().candidates.map(c => c.backend === "jev" ? { ...c, cooldownUntil: 5000 } : c) }, expected: "S1 OpenAI" },
  { state: { ...status(), candidates: status().candidates.map(c => c.backend === "jev" ? { ...c, local: "missing" } : c) }, expected: "S1 OpenAI" },
  { state: status("unknown"), expected: "S1 Jev" },
  { state: status("unavailable"), expected: "S1 unavailable" },
  { state: { ...status("unavailable"), nextRetryAt: 1999 }, expected: "S1 Jev" },
  { state: { ...status("unavailable"), nextRetryAt: 2001 }, expected: "S1 unavailable" },
];
const snapshot = () => ({
  cwd: "/tmp/system1", provider: "anthropic", model: "main-chat", thinking: "medium", oauth: true,
  context: { tokens: 12000, contextWindow: 200000, percent: 6 },
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, compactions: 0, started: 1000 },
  git: { project: "system1", branch: "main", changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0, added: 0, removed: 0 },
  quotas: [], statuses: [], now: 2000, queued: false, borderGauge: true,
  workflow: { kind: "work" }, mode: { kind: "auto", label: "auto" },
  actions: { "system1.open": {} }, system1: status(),
});
const textAt = (layout, hit) => plain(sliceByColumn(layout.lines[hit.row], hit.startCol, hit.endCol));

test("System 1 state is optional detached presentation data", () => {
  const events = new EventEmitter();
  assert.equal(querySystem1State(events), undefined);
  const published = status();
  events.on(SYSTEM1_STATE_CHANNEL, request => {
    assert.equal(request.version, 1);
    request.state = published;
  });
  assert.deepEqual(querySystem1State(events), published);
});

test("System 1 shares the Context row without adding height in Independent, Linked and Exec", () => {
  for (const width of [46, 120, 180]) for (const workflow of ["work", "plan", "exec"]) for (const linked of [false, true]) {
    const s = { ...snapshot(), workflow: { kind: workflow }, exec: workflow === "exec" ? "implementing" : undefined };
    if (linked) s.flow = { version: 1, operatingMode: "linked", revision: 1, workflow, ready: true, guardAvailable: true, transitioning: false };
    const absent = layoutFooter({ ...s, system1: undefined }, width, theme);
    for (const { state, expected } of cases()) {
      const layout = layoutFooter({ ...s, system1: state }, width, theme);
      assert.equal(layout.lines.length, absent.lines.length);
      assert.ok(layout.lines.every(line => visibleWidth(line) <= width));
      const hit = layout.hits.find(hit => hit.action === "system1.open");
      assert.ok(hit, `${expected} should fit at ${width}`);
      assert.equal(textAt(layout, hit), expected);
      assert.match(plain(layout.lines[hit.row]), /Context .*S1 /);
    }
    const compact = layoutFooter({ ...s, compact: true }, width, theme);
    assert.equal(compact.lines.length, 1);
    assert.deepEqual(compact.hits, []);
    assert.ok(!layoutFooter({ ...s, readOnly: true }, width, theme).hits.some(hit => hit.action === "system1.open"));
  }
  assert.ok(!layoutFooter({ ...snapshot(), system1: undefined }, 180, theme).hits.some(hit => hit.action === "system1.open"));
  assert.ok(!layoutFooter(snapshot(), 5, theme).hits.some(hit => hit.action === "system1.open"));
});

test("fallback and exhausted badges warn without rewriting the configured order", () => {
  for (const { state, expected } of cases()) {
    const calls = [];
    const before = structuredClone(state);
    layoutFooter({ ...snapshot(), system1: state }, 180, { ...theme, fg(color, text) { calls.push({ color, text }); return text; } });
    const badge = calls.find(call => call.text === expected);
    assert.ok(badge, expected);
    assert.equal(badge.color, expected === "S1 unavailable" ? "warning" : "muted");
    assert.deepEqual(state, before, "rendering does not mutate preference or runtime evidence");
  }
});

test("the real System 1 value opens its provider picker only while current, focused and idle", async () => {
  let generation = 1, idle = true, blocked = 0, overlay = false, prompt = 0, calls = 0;
  const editor = { render: () => [], invalidate() {}, handleInput() {} };
  const tui = { getFocusedComponent: () => editor, hasOverlay: () => overlay };
  const actions = { "system1.open": { label: "System 1", run() { calls++; } } };
  const controller = createFooterActionController({
    getEditor: () => editor, getTui: () => tui, getGeneration: () => generation,
    isCurrent: () => true, getBlocked: () => blocked, getPromptDepth: () => prompt,
    isIdle: () => idle, isLinked: () => false, getActions: () => actions,
    notify() {}, refresh() {},
  });
  const release = controller.wrapEditor(editor, tui);
  const layout = layoutFooter(snapshot(), 180, theme);
  const hit = layout.hits.find(hit => hit.action === "system1.open");
  assert.ok(hit);
  const component = createFooterComponent(() => layout, () => generation, action => controller.available(action), action => controller.activate(action));
  component.render(180);
  const click = { type: "click", button: "left", x: hit.startCol, y: hit.row, width: 180, height: layout.lines.length, shift: false, alt: false, ctrl: false };
  try {
    assert.deepEqual(component.handleMouse(click), { handled: true, render: false });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(calls, 1);
    for (const state of ["busy", "blocked", "overlay", "prompt"]) {
      idle = state !== "busy"; blocked = state === "blocked" ? 1 : 0; overlay = state === "overlay"; prompt = state === "prompt" ? 1 : 0;
      const result = component.handleMouse(click);
      if (state === "busy") assert.deepEqual(result, { handled: true, render: false }, "busy clicks may explain why the picker cannot open");
      else assert.equal(result, undefined, state);
      assert.equal(calls, 1, `${state} must not open the picker`);
    }
    idle = true; blocked = 0; overlay = false; prompt = 0;
    assert.equal(component.handleMouse({ ...click, x: hit.endCol }), undefined, "separator is not a target");
    assert.equal(component.handleMouse({ ...click, width: 120 }), undefined, "stale width is inert");
    generation++;
    assert.equal(component.handleMouse(click), undefined, "stale generation is inert");
    assert.equal(calls, 1);
  } finally { component.dispose(); release(); controller.dispose(); }
});
