// Roles, the Haiku guard, quota and the rate limit through the `subagent` tool, against fake Pi children.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RATE_LIMIT_ERROR, isRateLimit, setPiInvocation } from "../src/child.ts";
import subagents, { effectiveConcurrency, promptGuidelines, resumable } from "../src/index.ts";
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

async function setup(options: { answer?: (questions: Record<string, any>) => any; ctx?: Record<string, unknown>; fixture?: string } = {}) {
  setPiInvocation(fixture(options.fixture ?? "fake-pi-loop.mjs"));
  const jev = fakeJev((questions) => options.answer?.(questions) ?? {});
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
  await h.emit("session_start", { type: "session_start" }, ctx);
  const send = (channel: string, data: unknown) => { for (const fn of listeners.get(channel) ?? []) fn(data); };
  return { h, jev, ctx, ui, send, tool: () => tool, stop: () => h.emit("session_shutdown", { type: "session_shutdown" }, ctx) };
}

test("a named profiled role asks Jev nothing; general asks the tier and effort; an implicit role ignores them", async () => {
  const s = await setup({ answer: (questions) => Object.fromEntries(Object.keys(questions).map((id) => [id, choice(id === "role" ? "worker" : id === "tier" ? "strong" : "xhigh")])) });
  const explorer = await s.tool().execute("t1", { task: "find the config loader", agent: "explorer", async: true }, undefined, undefined, s.ctx);
  expect(s.jev.calls).toHaveLength(0);
  expect(explorer.details.runs[0]).toMatchObject({ agent: "explorer", model: "anthropic/claude-sonnet-5-5", thinking: "low", byJev: { agent: false, model: false, thinking: false } });

  const general = await s.tool().execute("t2", { task: "something odd", agent: "general", async: true }, undefined, undefined, s.ctx);
  expect(Object.keys(s.jev.calls[0]!.questions)).toEqual(["tier", "effort"]);
  expect(general.details.runs[0]).toMatchObject({ model: "anthropic/claude-opus-5-5", thinking: "xhigh", byJev: { model: true, thinking: true } });

  const implicit = await s.tool().execute("t3", { task: "implement the spec in PLAN.md", async: true }, undefined, undefined, s.ctx);
  expect(Object.keys(s.jev.calls[1]!.questions)).toEqual(["role", "tier", "effort"]);
  expect(implicit.details.runs[0]).toMatchObject({ agent: "worker", model: "anthropic/claude-sonnet-5-5", thinking: "medium", byJev: { agent: true, model: false, thinking: false } });
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

test("critical quota pressure on the parent's provider runs parallel tasks one at a time, and says so", async () => {
  expect(effectiveConcurrency(4, undefined)).toBe(4);
  expect(effectiveConcurrency(4, { provider: "anthropic", tier: "caution", p: 0.6 })).toBe(4);
  expect(effectiveConcurrency(4, { provider: "anthropic", tier: "critical", p: 1 })).toBe(1);
  const s = await setup();
  s.send("quota:pressure", { provider: "openai-codex", tier: "critical", p: 1 });
  const calm = await s.tool().execute("t1", { tasks: [{ task: "a", agent: "explorer" }, { task: "b", agent: "explorer" }], async: true }, undefined, undefined, s.ctx);
  expect(calm.details.runs).toHaveLength(2);
  expect(calm.content[0].text).not.toContain("one at a time");

  s.send("quota:pressure", { provider: "anthropic", tier: "critical", p: 1, label: "5h 97%" });
  const tasks = ["c", "d", "e"].map((task) => ({ task, agent: "explorer" }));
  const tight = await s.tool().execute("t2", { tasks, async: true }, undefined, undefined, s.ctx);
  expect(tight.details.runs).toHaveLength(1);
  expect(tight.content[0].text).toContain("[Quota pressure on anthropic is critical (5h 97%): these 3 tasks run one at a time.]");
  expect(s.ui.notes.some((n: any) => String(n.message ?? n).includes("one at a time"))).toBe(true);
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
