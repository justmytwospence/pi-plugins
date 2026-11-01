import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { setPiInvocation } from "../src/child.ts";
import subagents, { recordedRun } from "../src/index.ts";
import { SYSTEM1_CHANGED } from "../src/system1.ts";
import { FAMILY_CHANNEL } from "../src/family-contract.ts";
import { harness, usage } from "./harness.ts";
import { fakeUI } from "./ui-helpers.ts";

beforeAll(() => initTheme("dark"));
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  setPiInvocation(undefined);
  vi.unstubAllEnvs();
});

function distribution(criteria: Record<string, string>, wanted: string) {
  const labels = Object.keys(criteria);
  return { type: "choice", choice: wanted, confidence: 0.8, probabilities: Object.fromEntries(labels.map((label) => [label, label === wanted ? 0.8 : 0.2 / (labels.length - 1)])) };
}

async function setup(backend: "jev" | "openai-decisions", classify?: (model: any, context: any, options: any) => any) {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-system1-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  const select = (selected: string) => writeFileSync(path.join(dir, "system1.json"), JSON.stringify({ backend: selected }));
  select(backend);
  mkdirSync(path.join(dir, ".pi"));
  writeFileSync(path.join(dir, ".pi/pi-subagents.json"), JSON.stringify({ providerTiers: { worker: { fast: "worker/small", balanced: "worker/mid", strong: "worker/big" } } }));
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures/fake-pi-loop.mjs")] });
  const calls: Array<{ model: any; options: any }> = [];
  const registry = {
    getAll: () => [],
    findOfType: (_type: string, provider: string, id: string) => ({ provider, id, api: provider === "system1-openai" ? "openai-decisions" : "typesafe", baseUrl: "https://api.openai.com/v1" }),
    classify: async (model: any, context: any, options: any) => {
      calls.push({ model, options });
      if (classify) return classify(model, context, options);
      const wanted: Record<string, string> = { role: "worker", tier: "strong", effort: "high" };
      return { stopReason: "stop", answers: Object.fromEntries(Object.entries(context.questions).map(([id, question]: [string, any]) => [id, distribution(question.criteria, wanted[id]!)])), usage: usage(10) };
    },
  };
  const h = harness();
  const listeners = new Map<string, Array<() => void>>();
  h.pi.events.on = (channel: string, fn: () => void) => {
    listeners.set(channel, [...(listeners.get(channel) ?? []), fn]);
    return () => undefined;
  };
  let tool: any;
  h.pi.registerTool = (value: unknown) => void (tool = value);
  subagents(h.pi);
  const ctx = h.ctx({ cwd: dir, ui: fakeUI(), model: { provider: "worker", id: "parent" }, modelRegistry: registry });
  await h.emit("session_start", {}, ctx);
  cleanup.push(() => h.emit("session_shutdown", {}, ctx));
  return { h, ctx, calls, select, send: () => { for (const fn of listeners.get(SYSTEM1_CHANGED) ?? []) fn(); }, run: (params: Record<string, unknown> = {}) => tool.execute("pick", { task: "Implement the specified change", async: true, ...params }, undefined, undefined, ctx) };
}

test.each(["jev", "openai-decisions"] as const)("%s routing retains actual classifier provenance through run records and restoration", async (backend) => {
  const env = await setup(backend);
  const result = await env.run();
  const classifier = backend === "jev" ? { backend, provider: "typesafe", model: "jev-latest" } : { backend, provider: "system1-openai", model: "gpt-6-luna" };
  expect(env.calls[0]!.model).toMatchObject({ provider: classifier.provider, id: classifier.model });
  expect(env.calls[0]!.options.retries).toBe(0);
  const run = result.details.runs[0];
  expect(run).toMatchObject({ agent: "worker", model: "worker/big", thinking: "high", classifier, byJev: { agent: true, model: true, thinking: true } });
  const record = env.h.entries.find((entry) => entry.customType === "subagents:run" && (entry.data as any).id === run.id)!.data as any;
  expect(record.classifier).toEqual(classifier);
  expect(recordedRun(record).classifier).toEqual(classifier);
  const { classifier: _removed, ...legacy } = record;
  expect(recordedRun(legacy).classifier).toBeUndefined();
  const pinned = await env.run({ agent: "worker", model: "other/pinned", thinking: "low" });
  expect(env.calls).toHaveLength(1);
  expect(pinned.details.runs[0]).toMatchObject({ model: "other/pinned", thinking: "low", byJev: { agent: false, model: false, thinking: false } });
  expect(pinned.details.runs[0].classifier).toBeUndefined();
});

test("a disabled adaptive classifier remains disabled in Decisions mode", async () => {
  const env = await setup("openai-decisions");
  writeFileSync(path.join(env.ctx.cwd, ".pi/pi-subagents.json"), JSON.stringify({ jev: { enabled: false }, providerTiers: { worker: { balanced: "worker/mid" } } }));
  await env.h.emit("session_start", {}, env.ctx);
  const run = (await env.run({ agent: "worker" })).details.runs[0];
  expect(env.calls).toHaveLength(0);
  expect(run).toMatchObject({ model: "worker/mid", thinking: "medium", byJev: { model: false, thinking: false } });
  expect(run.classifier).toBeUndefined();
});

test("a file-only backend switch between requests selects the new target without a watcher", async () => {
  const env = await setup("jev");
  expect((await env.run()).details.runs[0].classifier.backend).toBe("jev");
  env.select("openai-decisions");
  expect((await env.run()).details.runs[0].classifier.backend).toBe("openai-decisions");
  expect(env.calls.map((call) => call.model.provider)).toEqual(["typesafe", "system1-openai"]);
});

test.each([false, true])("a backend switch during a pending pick discards it (changed event: %s)", async (event) => {
  let entered!: () => void;
  const called = new Promise<void>((resolve) => { entered = resolve; });
  let finish!: (result: unknown) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  const env = await setup("jev", () => { entered(); return pending; });
  const running = env.run({ agent: "worker" });
  await called;
  env.select("openai-decisions");
  if (event) env.send();
  finish({ stopReason: "stop", answers: { tier: { type: "choice", choice: "strong", confidence: 1, probabilities: { strong: 1 } }, effort: { type: "choice", choice: "xhigh", confidence: 1, probabilities: { xhigh: 1 } } } });
  const run = (await running).details.runs[0];
  expect(run).toMatchObject({ model: "worker/mid", thinking: "medium", byJev: { agent: false, model: false, thinking: false } });
  expect(run.classifier).toBeUndefined();
});

test.each([false, true])("a completed pick is rechecked after delayed run enrollment (switch back: %s)", async (switchBack) => {
  const env = await setup("jev");
  let entered!: () => void;
  const enrolling = new Promise<void>((resolve) => { entered = resolve; });
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  env.h.pi.events.emit = (channel: string, request: any) => {
    if (channel === FAMILY_CHANNEL) request.service = { prepare: async () => { entered(); await pending; return undefined; } };
  };
  const running = env.run({ agent: "worker" });
  await enrolling;
  env.select("openai-decisions"); // No event: the spawn boundary must reread the file too.
  if (switchBack) {
    env.send();
    env.select("jev");
    env.send(); // The key alone cannot detect a switch away and back; generation must also match.
  }
  finish();
  const run = (await running).details.runs[0];
  expect(run).toMatchObject({ model: "worker/mid", thinking: "medium", byJev: { model: false, thinking: false } });
  expect(run.classifier).toBeUndefined();
});

test("an unavailable Decisions result uses deterministic fallback without changing explicit pins or trying Jev", async () => {
  const env = await setup("openai-decisions", () => ({ stopReason: "error", errorMessage: "insufficient_quota", answers: {}, usage: usage(4) }));
  const run = (await env.run({ agent: "worker", model: "other/pinned" })).details.runs[0];
  expect(run).toMatchObject({ model: "other/pinned", thinking: "medium", byJev: { model: false, thinking: false } });
  expect(run.classifier).toBeUndefined();
  expect(env.calls.map((call) => call.model.provider)).toEqual(["system1-openai"]);
});
