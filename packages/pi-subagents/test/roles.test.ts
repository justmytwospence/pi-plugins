// Roles, the Haiku guard, quota and the rate limit through the `subagent` tool, against fake Pi children.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RATE_LIMIT_ERROR, isRateLimit, setPiInvocation } from "../src/child.ts";
import subagents, { promptGuidelines, recordedRun, resumable } from "../src/index.ts";
import { fakeJev, harness } from "./harness.ts";
import { fakeUI, plain } from "./ui-helpers.ts";

const fixture = (name: string) => ({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", name)] });
const claude = ["claude-haiku-5", "claude-sonnet-5-5", "claude-opus-5-5"].map((id) => ({ provider: "anthropic", id }));
const choice = (best: string) => ({ type: "choice", choice: best, confidence: 0.9, probabilities: { [best]: 0.9 } });

beforeEach(() => {
  // Keep agent discovery to the built-ins.
  vi.stubEnv("PI_CODING_AGENT_DIR", mkdtempSync(path.join(tmpdir(), "subagents-roles-agent-")));
});
afterEach(() => {
  vi.unstubAllEnvs();
  setPiInvocation(undefined);
});

async function setup(options: { answer?: (questions: Record<string, any>, state: Record<string, unknown>) => any; ctx?: Record<string, unknown>; fixture?: string; concurrency?: number } = {}) {
  setPiInvocation(fixture(options.fixture ?? "fake-pi-loop.mjs"));
  const jev = fakeJev((questions, state) => options.answer?.(questions, state) ?? {});
  const h = harness();
  let tool: any;
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  h.pi.events.on = (channel: string, fn: (data: unknown) => void) => {
    listeners.set(channel, [...(listeners.get(channel) ?? []), fn]);
    return () => undefined;
  };
  h.pi.registerTool = (t: unknown) => void (tool = t);
  subagents(h.pi);
  const ui = fakeUI();
  const ctx = h.ctx({
    cwd: mkdtempSync(path.join(tmpdir(), "subagents-roles-")),
    ui,
    model: { provider: "anthropic", id: "claude-opus-5-5" },
    modelRegistry: { ...(jev.registry as object), getAll: () => claude },
    ...options.ctx,
  });
  if (options.concurrency !== undefined) {
    mkdirSync(path.join(ctx.cwd, ".pi"), { recursive: true });
    writeFileSync(path.join(ctx.cwd, ".pi", "pi-subagents.json"), JSON.stringify({ concurrency: options.concurrency }));
  }
  await h.emit("session_start", { type: "session_start" }, ctx);
  const send = (channel: string, data: unknown) => { for (const fn of listeners.get(channel) ?? []) fn(data); };
  return { h, jev, ctx, ui, send, tool: () => tool, stop: () => h.emit("session_shutdown", { type: "session_shutdown" }, ctx) };
}

test("named built-ins are task-calibrated, general asks model and effort, and implicit roles retain their answers", async () => {
  const s = await setup({ answer: (questions) => Object.fromEntries(Object.keys(questions).map((id) => [id, choice(id === "role" ? "worker" : id === "tier" ? "strong" : "xhigh")])) });
  const explorer = await s.tool().execute("t1", { task: "find the config loader", agent: "explorer", async: true }, undefined, undefined, s.ctx);
  expect(Object.keys(s.jev.calls[0]!.questions)).toEqual(["tier", "effort"]);
  expect(explorer.details.runs[0]).toMatchObject({ agent: "explorer", model: "anthropic/claude-opus-5-5", thinking: "xhigh", source: { model: "tier", thinking: "jev" }, byJev: { agent: false, model: true, thinking: true } });
  expect(s.jev.calls[0]!.state).toMatchObject({ task: "find the config loader", role: "explorer" });

  const general = await s.tool().execute("t2", { task: "something odd", agent: "general", async: true }, undefined, undefined, s.ctx);
  expect(Object.keys(s.jev.calls[1]!.questions)).toEqual(["tier", "effort"]);
  expect(general.details.runs[0]).toMatchObject({ model: "anthropic/claude-opus-5-5", thinking: "xhigh", byJev: { model: true, thinking: true } });

  const implicit = await s.tool().execute("t3", { task: "implement the spec in PLAN.md", async: true }, undefined, undefined, s.ctx);
  expect(Object.keys(s.jev.calls[2]!.questions)).toEqual(["role", "tier", "effort"]);
  expect(s.jev.calls[2]!.state.role).toBe("auto");
  expect(implicit.details.runs[0]).toMatchObject({ agent: "worker", model: "anthropic/claude-opus-5-5", thinking: "xhigh", byJev: { agent: true, model: true, thinking: true } });
  await s.stop();
});

test("on a Codex parent the same roles take Codex models, never Anthropic ones", async () => {
  const codex = ["gpt-6-luna", "gpt-6.1-luna", "gpt-6.1-terra", "gpt-6.1-sol"].map((id) => ({ provider: "openai-codex", id }));
  const s = await setup({ ctx: { model: { provider: "openai-codex", id: "gpt-6.1-sol" } } });
  (s.ctx.modelRegistry as { getAll: () => unknown[] }).getAll = () => [...claude, ...codex];
  const result = await s.tool().execute("t1", { tasks: [{ task: "a", agent: "explorer" }, { task: "b", agent: "reviewer" }, { task: "c", agent: "writer" }], async: true }, undefined, undefined, s.ctx);
  expect(result.details.runs.map((r: any) => `${r.model} ${r.thinking}`)).toEqual(["openai-codex/gpt-6-luna high", "openai-codex/gpt-6.1-sol high", "openai-codex/gpt-6.1-terra medium"]);
  await s.stop();
});

test("five concurrent Astra-parent workers independently route mechanical through hard tasks and classifier failure", async () => {
  const openai = ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"].map((id) => ({ provider: "openai", id }));
  const decisions: Record<string, [string, string]> = {
    mechanical: ["fast", "low"], specified: ["balanced", "medium"], substantive: ["strong", "high"], hard: ["premium", "xhigh"],
  };
  const s = await setup({ concurrency: 5, ctx: { model: { provider: "openai", id: "gpt-6-astra" } }, answer: (_questions, state) => {
    const decision = decisions[String(state.task)];
    return decision ? { tier: choice(decision[0]), effort: choice(decision[1]) } : { stopReason: "error", error: "classifier offline" };
  } });
  (s.ctx.modelRegistry as { getAll: () => unknown[] }).getAll = () => openai;
  const result = await s.tool().execute("batch", { tasks: ["mechanical", "specified", "substantive", "hard", "failure"].map((task) => ({ task, agent: "worker" })), async: true }, undefined, undefined, s.ctx);
  expect(result.details.runs).toHaveLength(5);
  expect(s.jev.calls).toHaveLength(5);
  for (const call of s.jev.calls) {
    expect(Object.keys(call.questions)).toEqual(["tier", "effort"]);
    expect(call.state.role).toBe("worker");
  }
  expect(result.details.runs.map((r: any) => [r.model, r.thinking])).toEqual([
    ["openai/gpt-6-luna", "low"], ["openai/gpt-6.1-terra", "medium"], ["openai/gpt-6.1-sol", "high"], ["openai/gpt-6-astra", "xhigh"], ["openai/gpt-6.1-terra", "medium"],
  ]);
  for (const run of result.details.runs.slice(0, 4)) expect(run).toMatchObject({ source: { model: "tier", thinking: "jev" }, byJev: { model: true, thinking: true } });
  expect(result.details.runs[3]).not.toHaveProperty("note");
  expect(result.details.runs[4]).toMatchObject({ source: { model: "profile", thinking: "profile" }, byJev: { model: false, thinking: false } });
  const records = s.h.entries.filter((e) => e.customType === "subagents:run").map((e) => e.data as any);
  for (const run of result.details.runs) expect(records.find((r) => r.id === run.id)).toMatchObject({ model: run.model, source: run.source });
  await s.stop();
});

test.each([
  ["google", "antigravity-gemini-4-argon", ["antigravity-gemini-3.8-flash", "antigravity-gemini-4-argon"], "antigravity-gemini-4-argon"],
  ["muse-code", "muse-wonder-1.0", ["muse-spark-1.3", "muse-wonder-1.0"], "muse-wonder-1.0"],
] as const)("%s selection stays within its route, with no fabricated premium candidate", async (provider, parent, ids, strong) => {
  const s = await setup({ ctx: { model: { provider, id: parent } }, answer: () => ({ tier: choice("strong"), effort: choice("high") }) });
  (s.ctx.modelRegistry as { getAll: () => unknown[] }).getAll = () => ids.map((id) => ({ provider, id }));
  const result = await s.tool().execute("t1", { task: "difficult review", agent: "worker", async: true }, undefined, undefined, s.ctx);
  expect(Object.keys(s.jev.calls[0]!.questions.tier.criteria)).toEqual(["fast", "balanced", "strong"]);
  expect(result.details.runs[0]).toMatchObject({ model: `${provider}/${strong}`, thinking: "high", source: { model: "tier", thinking: "jev" } });
  await s.stop();
});

test("explicit model and effort independently suppress only their question; a custom pin suppresses both", async () => {
  const s = await setup({ answer: () => ({ tier: choice("fast"), effort: choice("low") }) });
  const model = await s.tool().execute("t1", { task: "model fixed", agent: "worker", model: "anthropic/claude-opus-5-5", async: true }, undefined, undefined, s.ctx);
  expect(Object.keys(s.jev.calls[0]!.questions)).toEqual(["effort"]);
  expect(model.details.runs[0]).toMatchObject({ model: "anthropic/claude-opus-5-5", thinking: "low", source: { model: "explicit", thinking: "jev" } });
  const effort = await s.tool().execute("t2", { task: "effort fixed", agent: "worker", thinking: "xhigh", async: true }, undefined, undefined, s.ctx);
  expect(Object.keys(s.jev.calls[1]!.questions)).toEqual(["tier"]);
  expect(effort.details.runs[0]).toMatchObject({ model: "anthropic/claude-haiku-5", thinking: "xhigh", source: { model: "tier", thinking: "explicit" } });
  const cwd = s.ctx.cwd as string;
  mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(path.join(cwd, ".pi", "agents", "pinned.md"), "---\nname: pinned\ndescription: Pinned\nmodels:\n  anthropic: claude-sonnet-5-5:high\n---\nPinned agent");
  const before = s.jev.calls.length;
  const pinned = await s.tool().execute("t3", { task: "pinned", agent: "pinned", async: true }, undefined, undefined, s.ctx);
  expect(s.jev.calls).toHaveLength(before);
  expect(pinned.details.runs[0]).toMatchObject({ model: "anthropic/claude-sonnet-5-5", thinking: "high", source: { model: "profile", thinking: "profile" } });
  await s.stop();
});

test("unknown provider fallback is visible in plain start/result, rendered metadata and persisted reconstruction", async () => {
  const s = await setup({ ctx: { model: { provider: "lmstudio", id: "qwen" } }, answer: () => ({ effort: choice("high") }) });
  (s.ctx.modelRegistry as { getAll: () => unknown[] }).getAll = () => [{ provider: "lmstudio", id: "qwen", type: "chat" }];
  const result = await s.tool().execute("fallback", { task: "review a tiny change", agent: "worker", async: true }, undefined, undefined, s.ctx);
  const note = "parent fallback: no usable role or tier mapping for lmstudio";
  expect(result.details.runs[0]).toMatchObject({ model: "lmstudio/qwen", thinking: "high", source: { model: "default", thinking: "jev" }, note });
  expect(result.content[0].text).toContain(note);
  expect(s.tool().renderResult(result, { expanded: false }, plain).render(120).join("\n")).toContain("qwen (parent)");
  const record = s.h.entries.filter((e) => e.customType === "subagents:run").map((e) => e.data as any).find((r) => r.id === result.details.runs[0].id);
  expect(record).toMatchObject({ source: { model: "default", thinking: "jev" }, note });
  expect(recordedRun(record)).toMatchObject({ source: { model: "default", thinking: "jev" }, note, model: "lmstudio/qwen" });
  const liveResult = await s.tool().execute("live-result", { action: "result", id: result.details.runs[0].id }, undefined, undefined, s.ctx);
  expect(liveResult.content[0].text).toContain("lmstudio/qwen (parent)");
  expect(liveResult.content[0].text).toContain(note);
  const saved = { ...record, id: `recorded-${record.id}` };
  s.ctx.sessionManager.getBranch = () => [{ type: "custom", customType: "subagents:run", data: saved }];
  const recordedResult = await s.tool().execute("recorded-result", { action: "result", id: saved.id }, undefined, undefined, s.ctx);
  expect(recordedResult.content[0].text).toContain("lmstudio/qwen (parent)");
  expect(recordedResult.content[0].text).toContain(note);
  await s.stop();
});

test.each([
  ["a fork", { sessionManager: { getBranch: () => [], getSessionId: () => "s", getSessionFile: () => "/tmp/parent.jsonl" } }, "fork", "not Haiku: forked context"],
  ["a long parent context", { getContextUsage: () => ({ tokens: 180_000, contextWindow: 1_000_000, percent: 18 }) }, "fresh", "not Haiku: parent context 180k"],
])("the Haiku guard turns a fast general pick balanced for %s and shows why in the row", async (_name, extra, context, note) => {
  const s = await setup({ ctx: extra, answer: () => ({ tier: choice("fast"), effort: choice("low") }) });
  const result = await s.tool().execute("t1", { task: "grep for TODOs", agent: "general", context, async: true }, undefined, undefined, s.ctx);
  expect(result.details.runs[0]).toMatchObject({ model: "anthropic/claude-sonnet-5-5", note });
  expect(s.tool().renderResult(result, { expanded: false }, plain).render(200).join("\n")).toContain(`sonnet-5-5 (auto) (${note})`);
  await s.stop();
});

test.each([1, 2, 4])("critical quota pressure preserves configured parallel concurrency %i without a serialization notice", async (concurrency) => {
  const s = await setup({ concurrency });
  const tasks = ["a", "b", "c", "d", "e"].map((task) => ({ task, agent: "explorer" }));
  for (const [index, pressure] of [
    { provider: "openai-codex", tier: "critical", p: 1 },
    { provider: "anthropic", tier: "caution", p: 0.6 },
    { provider: "anthropic", tier: "critical", p: 1, label: "5h 97%" },
  ].entries()) {
    s.send("quota:pressure", pressure);
    const result = await s.tool().execute(`t${index}`, { tasks, async: true }, undefined, undefined, s.ctx);
    expect(result.details.runs).toHaveLength(concurrency);
    expect(result.content[0].text).not.toContain("one at a time");
  }
  expect(s.ui.notes.some((n: any) => String(n.message ?? n).includes("one at a time"))).toBe(false);
  await s.stop();
});

test("a run that ends on the rate limit fails with a one-line error and names resume, which accepts it", async () => {
  expect(isRateLimit("rate_limit_error: This request would exceed your account's rate limit")).toBe(true);
  expect(isRateLimit("429 Too Many Requests")).toBe(true);
  expect(isRateLimit("invalid x-api-key")).toBe(false);
  expect(resumable({ status: "failed", error: RATE_LIMIT_ERROR })).toBe(true);
  expect(resumable({ status: "failed", error: "boom" })).toBe(false);
  const s = await setup({ fixture: "fake-pi-ratelimit.mjs" });
  const result = await s.tool().execute("t1", { task: "count lines", agent: "explorer" }, undefined, undefined, s.ctx);
  expect(result.details.runs[0]).toMatchObject({ status: "failed", error: RATE_LIMIT_ERROR });
  const text = result.content[0].text as string;
  expect(text).toContain(`failed: ${RATE_LIMIT_ERROR}]`);
  const id = result.details.runs[0].id;
  expect(text).toContain(`action=resume with id ${id} continues it`);
  expect(result.isError).toBe(true);
  const resumed = await s.tool().execute("t2", { action: "resume", id }, undefined, undefined, s.ctx);
  expect(resumed.details.runs[0]).toMatchObject({ agent: "explorer", label: "count lines (resumed)", status: "failed" });
  await s.stop();
});

test("both delegation settings list the roles; economical says when delegating pays", () => {
  const economical = promptGuidelines("economical");
  const conservative = promptGuidelines("conservative");
  expect(economical[0]).toMatch(/^Delegate work that can run in parallel, is larger than one context, or is routine with a long tail/u);
  expect(economical[0]).toContain("Otherwise keep the work in this session, at lower effort when it is routine");
  expect(economical[0]).toContain("a few points of pass rate");
  expect(conservative[0]).toMatch(/^Prefer direct work for routine investigation/u);
  for (const list of [economical, conservative]) {
    expect(list[1]).toMatch(/^Choosing a role/u);
    for (const role of ["explorer", "worker", "reviewer", "researcher", "writer", "planner", "general"]) expect(list[1]).toContain(`${role} `);
  }
});
