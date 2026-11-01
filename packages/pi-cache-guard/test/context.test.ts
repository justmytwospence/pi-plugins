import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compact } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";

import { DECISION_TYPE, leanContext } from "../src/context.ts";
import { JEV_MODELS, askJev, probe, resolveJev } from "../src/jev.ts";
import { SYSTEM1_CHANGED, resolveSystem1Target } from "../src/system1.ts";

const settingFile = () => path.join(process.env.PI_CODING_AGENT_DIR!, "system1.json");
const cacheFile = () => path.join(process.env.PI_CODING_AGENT_DIR!, "cache-guard.json");
const select = (backend: "jev" | "openai-decisions") => writeFileSync(settingFile(), JSON.stringify({ backend }));
const decisions = { provider: "system1-openai", id: "gpt-6-luna", api: "openai-decisions", baseUrl: "https://api.openai.com/v1" };
afterEach(() => {
  rmSync(settingFile(), { force: true });
  rmSync(cacheFile(), { force: true });
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  compact: vi.fn(async (preparation: any, _model: unknown, _key: unknown, _headers: unknown, instructions: unknown) => ({
    summary: `LLM summary of ${preparation.messagesToSummarize.length} messages${instructions ? ` (${instructions})` : ""}`,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1_100, cost: { input: 0.004, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.006 } },
  })),
}));

const usage = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

type Answerer = (questions: Record<string, any>, state: any) => any;

/** A Pi model registry with Jev (or without, when `available` is empty). */
function registry(answer: Answerer, available = [{ provider: "typesafe", id: "jev-latest" }]) {
  const calls: Array<{ state: any; questions: Record<string, any>; model: any; options: any }> = [];
  const discovered: string[] = [];
  return {
    calls,
    discovered,
    getAvailableOfType: async (_type: string, provider: string) => {
      discovered.push(provider);
      return available.filter((m) => m.provider === provider);
    },
    findOfType: (_type: string, provider: string, id: string) => provider === decisions.provider ? { ...decisions, id } : { provider, id },
    classify: async (model: unknown, context: any, options?: any) => {
      calls.push({ ...context, model, options });
      const result = await answer(context.questions, context.state);
      if (result && typeof result === "object" && "stopReason" in result) return result;
      return { model: "jev-latest", stopReason: "stop", answers: result, usage: usage(300) };
    },
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
  };
}

function setup(answer: Answerer, available?: Array<{ provider: string; id: string }>) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: Array<{ customType: string; data: any }> = [];
  const listeners = new Map<string, Array<() => void>>();
  const events = {
    on: (name: string, handler: () => void) => listeners.set(name, [...(listeners.get(name) ?? []), handler]),
    emit: (name: string) => { for (const listener of listeners.get(name) ?? []) listener(); },
  };
  const pi = {
    events,
    on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data: data as any }),
  };
  const lean = leanContext(pi as any);
  const reg = registry(answer, available);
  const notes: string[] = [];
  const status = new Map<string, string | undefined>();
  const ctx: any = {
    cwd: "/nonexistent",
    hasUI: true,
    model: { provider: "anthropic", id: "claude-opus-5-5" },
    modelRegistry: reg,
    ui: { notify: (message: string) => notes.push(message), setStatus: (key: string, text: string | undefined) => status.set(key, text) },
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "user", content: "Fix the retry test" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Running the tests." }] } },
      ],
      getSessionId: () => "s1",
    },
  };
  const emit = async (name: string, event: any) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
    return result;
  };
  return { lean, reg, ctx, emit, entries, notes, status, events };
}

const big = Array.from({ length: 2_000 }, (_, i) => (i === 1_000 ? "Error: expected 3 retries, got 1" : `ok ${i} ${"-".repeat(10)}`)).join("\n");
const toolResult = (id = "t1") => ({ type: "tool_result", toolCallId: id, toolName: "bash", input: { command: "npm test" }, content: [{ type: "text", text: big }], isError: true });

const keepErrors: Answerer = (questions, state) =>
  Object.fromEntries(
    Object.keys(questions).map((id) => {
      const block = id.startsWith("block::") ? String(state?.output?.[id.slice(7)] ?? "") : "";
      return [id, { type: "bool", probability: block.includes("Error") ? 0.9 : 0.05 }];
    }),
  );

test("large output is trimmed to the needed blocks and saved in full", async () => {
  const { reg, emit, entries, status } = setup(keepErrors);
  await emit("session_start", { reason: "startup" });
  await emit("before_agent_start", { prompt: "x" });
  const out: any = await emit("tool_result", toolResult());
  const text: string = out.content[0].text;
  expect(text).toContain("Error: expected 3 retries, got 1");
  expect(text).toMatch(/\[… \d+ lines omitted …\]/u);
  expect(text.length).toBeLessThan(big.length / 5);
  const full = /Full output: (\S+)/u.exec(text)?.[1] as string;
  expect(full).toContain("/cache-guard/tool-output/s1/");
  expect(readFileSync(full, "utf8")).toBe(big);
  expect(out.usage.input).toBe(300);
  expect(reg.calls[0]?.state.intent).toMatchObject({ user_request: "Fix the retry test", agent_said: "Running the tests.", tool: "bash" });
  expect(entries[0]).toMatchObject({ customType: DECISION_TYPE, data: { kind: "trim", tool: "bash", lines: 2_000 } });
  expect(status.get("lean-context")).toMatch(/^lean: −\d+k tok$/u);

  // Asking for the same thing again in the same turn returns it in full.
  expect(await emit("tool_result", toolResult("t2"))).toBeUndefined();
  expect(reg.calls).toHaveLength(1);
});

test("codemode trims final batched output but preserves nested results and script intent", async () => {
  const { reg, emit } = setup(keepErrors);
  await emit("session_start", {});
  const input = { code: 'text(await tools.bash({ command: "npm test" }));' };
  const event = { ...toolResult("code1"), toolName: "codemode", input };
  expect(await emit("tool_result", { ...event, parentToolCallId: "outer" })).toBeUndefined();
  expect(reg.calls).toHaveLength(0);
  const out: any = await emit("tool_result", event);
  expect(out.content[0].text).toContain("Error: expected 3 retries, got 1");
  expect(out.content[0].text.length).toBeLessThan(big.length / 5);
  expect(reg.calls[0].state.intent).toMatchObject({ tool: "codemode", arguments: JSON.stringify(input) });
  const full = /Full output: (\S+)/u.exec(out.content[0].text)?.[1] as string;
  expect(readFileSync(full, "utf8")).toBe(big);
});

test("codemode preserves final output when the script needs it all", async () => {
  const { emit } = setup((q, st) => ({ ...keepErrors(q, st), needs_all: { type: "bool", probability: 0.9 } }));
  await emit("session_start", {});
  const out: any = await emit("tool_result", { ...toolResult(), toolName: "codemode" });
  expect(out.content).toBeUndefined();
});

test("no trim when the agent needs it all, when most would be kept, or Jev fails", async () => {
  const needsAll = setup((q, st) => ({ ...keepErrors(q, st), needs_all: { type: "bool", probability: 0.9 } }));
  await needsAll.emit("session_start", {});
  expect(((await needsAll.emit("tool_result", toolResult())) as any).content).toBeUndefined();
  const most = setup((q) => Object.fromEntries(Object.keys(q).map((id) => [id, { type: "bool", probability: id === "needs_all" ? 0 : 0.8 }])));
  await most.emit("session_start", {});
  expect(((await most.emit("tool_result", toolResult())) as any).content).toBeUndefined();
  const down = setup(() => ({ stopReason: "error", errorMessage: "timeout", answers: {} }));
  await down.emit("session_start", {});
  expect(await down.emit("tool_result", toolResult())).toBeUndefined();
});

test("without Jev nothing is trimmed and Jev is never asked", async () => {
  const { reg, emit } = setup(keepErrors, []);
  await emit("session_start", {});
  expect(await emit("tool_result", toolResult())).toBeUndefined();
  expect(reg.calls).toHaveLength(0);
});

test("small output and nested calls pass through without Jev", async () => {
  const { reg, emit } = setup(keepErrors);
  await emit("session_start", {});
  expect(await emit("tool_result", { ...toolResult(), content: [{ type: "text", text: "ok" }] })).toBeUndefined();
  expect(await emit("tool_result", { ...toolResult(), parentToolCallId: "p" })).toBeUndefined();
  expect(reg.calls).toHaveLength(0);
});

const keepFirstDropSecond: Answerer = (questions) =>
  Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "choice", choice: id === "keep::U001" ? "verbatim" : id === "keep::U002" ? "drop" : "summarize", probabilities: {}, confidence: 1 }]));

const compaction = (reason = "manual", customInstructions?: string) => ({
  type: "session_before_compact",
  reason,
  customInstructions,
  willRetry: false,
  branchEntries: [],
  signal: new AbortController().signal,
  preparation: {
    firstKeptEntryId: "e9",
    tokensBefore: 50_000,
    previousSummary: undefined,
    isSplitTurn: false,
    turnPrefixMessages: [],
    messagesToSummarize: [
      { role: "user", content: "Use pnpm, never npm." },
      { role: "assistant", content: [{ type: "text", text: "Exploring." }] },
      { role: "user", content: "Now add a cache." },
    ],
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set(["src/cache.ts"]) },
    settings: {},
  },
});

test("compaction audit records the classifier's actual resolved model", async () => {
  const { lean, emit, entries } = setup((questions, state) => ({
    stopReason: "stop",
    model: "jev-concrete-revision",
    answers: keepFirstDropSecond(questions, state),
    usage: usage(300),
  }));
  await emit("session_start", {});
  lean.armJevCompaction({ strict: true });
  const out: any = await emit("session_before_compact", compaction());
  expect(out.compaction.details.cacheGuard.mode).toBe("jev");
  expect(entries.at(-1)?.data.classifier).toEqual({ backend: "jev", provider: "typesafe", model: "jev-concrete-revision" });
});

const directMarker = "plan-mode-direct:550e8400-e29b-41d4-a716-446655440000";

test.each(["manual", "threshold", "overflow"])("direct plan compaction bypasses %s filtering without consuming an armed request", async (reason) => {
  for (const armed of [false, true]) {
    const { lean, reg, emit, entries, notes } = setup(keepFirstDropSecond);
    await emit("session_start", {});
    if (armed) lean.armJevCompaction({ goal: "reserved quick goal", strict: true });
    vi.mocked(compact).mockClear();

    expect(await emit("session_before_compact", compaction(reason, directMarker))).toBeUndefined();
    expect(reg.calls).toHaveLength(0);
    expect(compact).not.toHaveBeenCalled();
    expect(entries).toHaveLength(0);
    expect(notes).toHaveLength(0);

    const next: any = await emit("session_before_compact", compaction());
    expect(reg.calls).toHaveLength(1);
    expect(next.compaction.details.cacheGuard.mode).toBe(armed ? "jev" : "filtered");
    if (armed) {
      expect(reg.calls[0]?.state.current_goal).toBe("reserved quick goal");
      expect(compact).not.toHaveBeenCalled();
      const after: any = await emit("session_before_compact", compaction());
      expect(after.compaction.details.cacheGuard.mode).toBe("filtered");
    }
  }
});

test("direct plan compaction preserves the previous failure", async () => {
  const { lean, reg, emit } = setup(() => ({ stopReason: "error", errorMessage: "Request timed out", answers: {} }));
  await emit("session_start", {});
  lean.armJevCompaction({ strict: true });
  expect(await emit("session_before_compact", compaction())).toEqual({ cancel: true });
  const failure = lean.lastFailure();
  expect(failure).toBe("classification failed (timed out)");
  const calls = reg.calls.length;
  vi.mocked(compact).mockClear();
  expect(await emit("session_before_compact", compaction("manual", directMarker))).toBeUndefined();
  expect(lean.lastFailure()).toBe(failure);
  expect(reg.calls).toHaveLength(calls);
  expect(compact).not.toHaveBeenCalled();
});

test.each([
  undefined,
  "keep the plan",
  "plan-mode-direct:",
  "plan-mode-direct:not-a-uuid",
  "plan-mode-direct:550e8400e29b41d4a716446655440000",
  "plan-mode-direct:550e8400-e29b-41d4-a716-44665544000g",
  ` ${directMarker}`,
  `${directMarker} `,
  `${directMarker}\n`,
  `${directMarker}\nextra`,
  `prefix:${directMarker}`,
  directMarker.replace("plan-mode-direct", "PLAN-MODE-DIRECT"),
])("ordinary or malformed instructions retain compaction behavior: %j", async (instructions) => {
  for (const armed of [false, true]) {
    const { lean, reg, emit } = setup(keepFirstDropSecond);
    await emit("session_start", {});
    if (armed) lean.armJevCompaction({ strict: true });
    vi.mocked(compact).mockClear();
    const out: any = await emit("session_before_compact", compaction("manual", instructions));
    expect(reg.calls).toHaveLength(1);
    expect(out.compaction.details.cacheGuard.mode).toBe(armed ? "jev" : "filtered");
    expect(vi.mocked(compact).mock.calls).toHaveLength(armed ? 0 : 1);
    if (armed) {
      const next: any = await emit("session_before_compact", compaction());
      expect(next.compaction.details.cacheGuard.mode).toBe("filtered");
    }
  }
});

test("a Jev compaction writes the summary in code, judged against the goal", async () => {
  const { lean, reg, emit, entries } = setup(keepFirstDropSecond);
  await emit("session_start", {});
  lean.armJevCompaction({ goal: "fix the parser", strict: true });
  const out: any = await emit("session_before_compact", compaction());
  expect(reg.calls[0]?.state.current_goal).toBe("fix the parser");
  expect(out.compaction.firstKeptEntryId).toBe("e9");
  expect(out.compaction.summary).toMatch(/^# Compacted quickly/u);
  expect(out.compaction.summary).toContain("**User:** Use pnpm, never npm.");
  expect(out.compaction.summary).not.toContain("Exploring.");
  expect(out.compaction.summary).toContain("Modified: src/cache.ts");
  expect(out.compaction.usage.input).toBe(300);
  expect(out.compaction.details.cacheGuard).toEqual({ mode: "jev", verbatim: 1, summarize: 1, drop: 1 });
  expect(entries.at(-1)).toMatchObject({ customType: DECISION_TYPE, data: { kind: "compact", jevOnly: true } });
  // Armed for one compaction only: the next /compact filters and lets Pi summarize.
  const next: any = await emit("session_before_compact", compaction("manual", "keep the plan"));
  expect(next.compaction.summary).toMatch(/^LLM summary of 2 messages \(keep the plan\)/u);
  expect(next.compaction.summary).toContain("## Kept verbatim\n\n**User:** Use pnpm, never npm.");
  expect(next.compaction.usage.input).toBe(1_300);
  expect(next.compaction.details.cacheGuard.mode).toBe("filtered");
});

test("strict: a Jev failure cancels the compaction and says why; overflow falls back to Pi", async () => {
  const down = setup(() => ({ stopReason: "error", errorMessage: "Request timed out", answers: {} }));
  await down.emit("session_start", {});
  down.lean.armJevCompaction({ strict: true });
  expect(await down.emit("session_before_compact", compaction())).toEqual({ cancel: true });
  expect(down.lean.lastFailure()).toBe("classification failed (timed out)");
  expect(await down.emit("session_before_compact", compaction("overflow"))).toBeUndefined();
  expect(down.notes.at(-1)).toBe("Quick compaction: classification failed (timed out); using Pi's compaction.");
  // A failed /compact filter leaves Pi's compaction alone, quietly.
  const notes = down.notes.length;
  expect(await down.emit("session_before_compact", compaction("threshold"))).toBeUndefined();
  expect(down.notes.length).toBe(notes);

  const none = setup(keepFirstDropSecond, []);
  await none.emit("session_start", {});
  none.lean.armJevCompaction({ strict: true });
  expect(await none.emit("session_before_compact", compaction())).toEqual({ cancel: true });
  expect(none.lean.lastFailure()).toBe("System 1 is unavailable (no provider with Jev has credentials)");
  expect(await none.emit("session_before_compact", compaction())).toBeUndefined();
});

test("resolveJev: the configured provider, else the most direct one Pi can reach", async () => {
  const asked: Array<string | undefined> = [];
  const available = (...ids: string[]) => ({
    getAvailableOfType: async (_type: string, provider?: string) => {
      asked.push(provider);
      return ids.map((id) => ({ provider: id.split("/")[0]!, id: id.slice(id.indexOf("/") + 1) })).filter((m) => m.provider === provider);
    },
    classify: () => undefined,
  });
  expect(await resolveJev(available("openrouter/~typesafe/jev-latest", "typesafe/jev-latest"), { enabled: true, provider: "", model: "" })).toEqual({
    kind: "ready",
    target: JEV_MODELS[0],
    others: [JEV_MODELS[1]],
  });
  expect(await resolveJev(available("openrouter/~typesafe/jev-latest", "typesafe/jev-latest"), { enabled: true, provider: "openrouter", model: "" })).toMatchObject({
    kind: "ready",
    target: { provider: "openrouter", model: "~typesafe/jev-latest" },
  });
  expect(await resolveJev(available("typesafe/jev-latest"), { enabled: true, provider: "vercel-ai-gateway", model: "" })).toMatchObject({ kind: "missing" });
  expect(await resolveJev(available(), { enabled: true, provider: "", model: "" })).toEqual({ kind: "missing", reason: "no provider with Jev has credentials" });
  expect(await resolveJev(available("typesafe/jev-latest"), { enabled: false, provider: "", model: "" })).toEqual({ kind: "off" });
  expect(await resolveJev({}, { enabled: true, provider: "", model: "" })).toMatchObject({ kind: "missing", reason: expect.stringContaining("classifier") });
  // Only the providers that serve Jev are asked.
  expect(new Set(asked)).toEqual(new Set(["typesafe", "openrouter", "vercel-ai-gateway", "cloudflare-workers-ai", "opencode"]));
});

const nativeKeep: Answerer = (questions) => Object.fromEntries(Object.keys(questions).map((id) => [id, {
  type: "choice", choice: "verbatim", probabilities: { verbatim: 1, summarize: 0, drop: 0 }, confidence: 1,
}]));
const manyMessages = () => Array.from({ length: 250 }, (_, i) => ({ role: "user", content: `Requirement ${i}` }));

test("Decisions availability checks only its isolated provider, never Jev discovery", async () => {
  select("openai-decisions");
  const reg = registry(keepErrors, [decisions]);
  const found = await resolveJev(reg, { enabled: true, provider: "openrouter", model: "legacy-jev" });
  expect(found).toEqual({ kind: "ready", target: { provider: decisions.provider, model: decisions.id }, others: [] });
  expect(reg.discovered).toEqual(["system1-openai"]);
  expect(reg.calls).toEqual([]);
  writeFileSync(settingFile(), "{broken");
  reg.discovered.length = 0;
  expect(await resolveJev(reg, { enabled: true, provider: "typesafe", model: "jev-latest" })).toMatchObject({ kind: "missing", reason: expect.stringContaining("configuration") });
  expect(reg.discovered).toEqual([]);
  expect(await resolveJev(reg, { enabled: false, provider: "typesafe", model: "jev-latest" })).toEqual({ kind: "off" });
});

test("Decisions missing credentials or adapter stays unavailable without fallback", async () => {
  select("openai-decisions");
  for (const reg of [registry(keepErrors), { ...registry(keepErrors, [decisions]), findOfType: () => undefined }]) {
    expect(await resolveJev(reg, { enabled: true, provider: "", model: "" })).toMatchObject({ kind: "missing", reason: expect.stringContaining("/login system1-openai") });
    expect(reg.calls).toEqual([]);
    expect(reg.discovered.every((provider) => provider === "system1-openai")).toBe(true);
  }
});

test("legacy askJev/probe follow System 1, report provenance and preserve failure usage", async () => {
  select("openai-decisions");
  const reg = registry(keepErrors, [decisions]);
  const target = { provider: "typesafe", model: "jev-latest" };
  const result = await probe(reg, target);
  expect(result).toMatchObject({ ok: true, backend: "openai-decisions", provider: decisions.provider, model: decisions.id, selectionKey: resolveSystem1Target(target).key, usage: usage(300) });
  expect(reg.calls[0]?.options.retries).toBe(0);
  const down = registry(() => ({ stopReason: "error", errorMessage: "insufficient_quota", answers: {}, usage: usage(70) }), [decisions]);
  expect(await askJev(down, target, 5_000, {}, { q: { type: "bool", instructions: "test", criteria: { true: "yes", false: "no" } } })).toMatchObject({ ok: false, reason: expect.stringContaining("quota"), usage: usage(70) });
  expect(down.calls).toHaveLength(1);
});

test("trim and compaction recheck selection without waiting for before_agent_start or 60s", async () => {
  const h = setup(keepErrors, [{ provider: "typesafe", id: "jev-latest" }, decisions]);
  await h.emit("session_start", {});
  expect((await h.lean.jev(h.ctx)).kind).toBe("ready");
  select("openai-decisions");
  const trimmed: any = await h.emit("tool_result", toolResult());
  expect(trimmed.content[0].text).toContain("lines omitted");
  expect(h.reg.calls[0]?.model.provider).toBe("system1-openai");
  expect(h.reg.calls[0]?.options.retries).toBe(0);
  expect(h.entries[0]?.data.classifier).toEqual({ backend: "openai-decisions", provider: decisions.provider, model: decisions.id });

  const c = setup(nativeKeep, [{ provider: "typesafe", id: "jev-latest" }, decisions]);
  await c.emit("session_start", {});
  select("jev");
  c.lean.armJevCompaction({ strict: true });
  const out: any = await c.emit("session_before_compact", compaction());
  expect(out.compaction.summary).toContain("Use pnpm");
  expect(c.reg.calls[0]?.model.provider).toBe("typesafe");
});

test("a System 1 change invalidates cached missing availability immediately", async () => {
  const h = setup(keepErrors, []);
  await h.emit("session_start", {});
  expect((await h.lean.jev(h.ctx)).kind).toBe("missing");
  const count = h.reg.discovered.length;
  h.reg.getAvailableOfType = async (_type, provider) => {
    h.reg.discovered.push(provider);
    return [{ provider: "typesafe", id: "jev-latest" }].filter((m) => m.provider === provider);
  };
  h.events.emit(SYSTEM1_CHANGED);
  expect((await h.lean.jev()).kind).toBe("ready");
  expect(h.reg.discovered.length).toBeGreaterThan(count);
});

test("a pending availability lookup cannot start trimming on its old selection", async () => {
  const h = setup(keepErrors);
  let release!: (models: Array<{ provider: string; id: string }>) => void;
  h.reg.getAvailableOfType = () => new Promise((resolve) => { release = resolve; });
  await h.emit("session_start", {});
  const trimming = h.emit("tool_result", toolResult());
  // Resolve each legacy discovery lookup, after switching the global setting.
  select("openai-decisions");
  for (let i = 0; i < 5; i++) {
    release([{ provider: "typesafe", id: "jev-latest" }]);
    await Promise.resolve();
  }
  expect(await trimming).toBeUndefined();
  expect(h.reg.calls).toEqual([]);
});

test.each([false, true])("pending trim output is discarded after a backend change (event: %s)", async (emitEvent) => {
  let release!: (answers: any) => void;
  let started!: () => void;
  const called = new Promise<void>((resolve) => { started = resolve; });
  const h = setup((q, state) => {
    started();
    return new Promise((resolve) => { release = () => resolve(keepErrors(q, state)); });
  }, [{ provider: "typesafe", id: "jev-latest" }, decisions]);
  await h.emit("session_start", {});
  const pending = h.emit("tool_result", toolResult());
  await called;
  select("openai-decisions");
  if (emitEvent) h.events.emit(SYSTEM1_CHANGED);
  release({});
  const out: any = await pending;
  expect(out?.content).toBeUndefined();
  expect(h.entries).toEqual([]);
  expect(h.lean.savedChars()).toBe(0);
  if (emitEvent) expect(h.reg.calls[0]?.options.signal.aborted).toBe(true);
  else expect(out.usage.input).toBe(300);
});

test.each([true, false])("failed later compaction batches retain usage and existing fallback (strict: %s)", async (strict) => {
  writeFileSync(cacheFile(), JSON.stringify({ compact: { concurrency: 1 } }));
  let calls = 0;
  const h = setup((q) => ++calls === 2 ? { stopReason: "error", errorMessage: "401 Unauthorized", answers: {}, usage: usage(80) } : nativeKeep(q, {}));
  await h.emit("session_start", {});
  if (strict) h.lean.armJevCompaction({ strict: true });
  const event = compaction(strict ? "manual" : "overflow");
  event.preparation.messagesToSummarize = manyMessages() as any;
  vi.mocked(compact).mockClear();
  expect(await h.emit("session_before_compact", event)).toEqual(strict ? { cancel: true } : undefined);
  expect(h.reg.calls).toHaveLength(2);
  expect(compact).not.toHaveBeenCalled();
  expect(h.entries.at(-1)?.data).toMatchObject({ kind: "compact", failed: true, usage: usage(380) });
  if (!strict) expect(h.notes.at(-1)).toContain("using Pi's compaction");
});

test.each([false, true])("multi-batch compaction never mixes backend selections (event: %s)", async (emitEvent) => {
  writeFileSync(cacheFile(), JSON.stringify({ compact: { concurrency: 1 } }));
  let calls = 0;
  const h = setup((q) => {
    calls++;
    if (calls === 1) {
      select("openai-decisions");
      if (emitEvent) h.events.emit(SYSTEM1_CHANGED);
    }
    return nativeKeep(q, {});
  }, [{ provider: "typesafe", id: "jev-latest" }, decisions]);
  await h.emit("session_start", {});
  h.lean.armJevCompaction({ strict: true });
  const event = compaction();
  event.preparation.messagesToSummarize = manyMessages() as any;
  expect(await h.emit("session_before_compact", event)).toEqual({ cancel: true });
  expect(h.reg.calls).toHaveLength(1);
  expect(h.lean.lastFailure()).toMatch(/cancelled|System 1 changed/u);
  expect(h.entries.every((entry) => entry.data.failed)).toBe(true);
});

test("strict quick compaction cancels an already-aborted request without spending or summarizing", async () => {
  const h = setup(nativeKeep);
  await h.emit("session_start", {});
  h.lean.armJevCompaction({ strict: true });
  const controller = new AbortController();
  controller.abort();
  vi.mocked(compact).mockClear();
  expect(await h.emit("session_before_compact", { ...compaction(), signal: controller.signal })).toEqual({ cancel: true });
  expect(h.reg.calls).toEqual([]);
  expect(compact).not.toHaveBeenCalled();
});

test.each([false, true])("a switch during a later compaction batch cancels and retains earlier usage (event: %s)", async (emitEvent) => {
  writeFileSync(cacheFile(), JSON.stringify({ compact: { concurrency: 1 } }));
  let calls = 0;
  let started!: () => void;
  const secondStarted = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const h = setup((q) => {
    if (++calls !== 2) return nativeKeep(q, {});
    started();
    return new Promise((resolve) => { release = () => resolve(nativeKeep(q, {})); });
  }, [{ provider: "typesafe", id: "jev-latest" }, decisions]);
  await h.emit("session_start", {});
  h.lean.armJevCompaction({ strict: true });
  const event = compaction();
  event.preparation.messagesToSummarize = manyMessages() as any;
  const pending = h.emit("session_before_compact", event);
  await secondStarted;
  select("openai-decisions");
  if (emitEvent) h.events.emit(SYSTEM1_CHANGED);
  release();
  vi.mocked(compact).mockClear();
  expect(await pending).toEqual({ cancel: true });
  expect(h.reg.calls).toHaveLength(2);
  expect(h.reg.calls.every((call) => call.model.provider === "typesafe")).toBe(true);
  expect(h.entries.at(-1)?.data).toMatchObject({ failed: true, usage: { input: emitEvent ? 300 : 600 } });
  if (emitEvent) expect(h.reg.calls[1]?.options.signal.aborted).toBe(true);
  expect(compact).not.toHaveBeenCalled();
});

test("all batches of a successful Decisions compaction retain the selected target and usage", async () => {
  select("openai-decisions");
  const h = setup(nativeKeep, [decisions]);
  await h.emit("session_start", {});
  h.lean.armJevCompaction({ strict: true });
  const event = compaction();
  event.preparation.messagesToSummarize = manyMessages() as any;
  const out: any = await h.emit("session_before_compact", event);
  expect(out.compaction.usage).toEqual(usage(900));
  expect(h.reg.calls).toHaveLength(3);
  expect(h.reg.calls.every((call) => call.model.provider === "system1-openai")).toBe(true);
  expect(h.entries.at(-1)?.data.classifier).toEqual({ backend: "openai-decisions", provider: decisions.provider, model: decisions.id });
});

test("failed trimming retains classifier usage without changing the tool content", async () => {
  select("openai-decisions");
  const h = setup(() => ({ stopReason: "error", errorMessage: "invalid answer", answers: {}, usage: usage(80) }), [decisions]);
  await h.emit("session_start", {});
  expect(await h.emit("tool_result", { ...toolResult(), usage: usage(20) })).toEqual({ usage: usage(100) });
  expect(h.lean.savedChars()).toBe(0);
  expect(h.entries).toEqual([]);
});

test("Decisions quick compaction keeps the existing deterministic summary", async () => {
  select("openai-decisions");
  const h = setup(nativeKeep, [decisions]);
  await h.emit("session_start", {});
  h.lean.armJevCompaction({ strict: true });
  const out: any = await h.emit("session_before_compact", compaction());
  expect(out.compaction.details.cacheGuard).toEqual({ mode: "jev", verbatim: 3, summarize: 0, drop: 0 });
  expect(out.compaction.usage).toEqual(usage(300));
  expect(h.reg.discovered).toEqual(["system1-openai"]);
});
