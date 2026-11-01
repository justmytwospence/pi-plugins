import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { BUILTIN_AGENTS, GENERAL, WORKER } from "../src/agents.ts";
import subagents, { DEFAULT_CONFIG, ROLE_MODEL, ROLE_MODEL_READY, type RoleModelRequest, roleModel } from "../src/index.ts";
import { harness } from "./harness.ts";
import { fakeUI } from "./ui-helpers.ts";

const dirs: string[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
});

type RegistryModel = Parameters<typeof roleModel>[3][number];
const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", reasoning: true };
const opus = { provider: "anthropic", id: "claude-opus-5-5", reasoning: true };
const parent = "anthropic/claude-opus-5-5";
const workerReply = { model: "anthropic/claude-sonnet-5-5", thinking: "medium", source: "profile" };
const badAvailability = [
  null, {}, "anthropic/claude-sonnet-5-5", [null], [[]], ["anthropic/claude-sonnet-5-5"],
  [{ id: sonnet.id }], [{ provider: sonnet.provider }],
  [{ ...sonnet, provider: 1 }], [{ ...sonnet, id: 1 }],
  [{ ...sonnet, provider: "" }], [{ ...sonnet, id: "" }],
  [{ ...sonnet, provider: " \t" }], [{ ...sonnet, id: " \n" }],
  [{ ...sonnet, provider: "anthropic/other" }], [sonnet, { provider: "anthropic" }],
];
const badCwds = [null, 1, {}, [], "", " \t\n"];

function write(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), "subagents-role-"));
  dirs.push(root);
  const [user, live, a, b, bare] = ["user", "live", "a", "b", "bare"].map((name) => {
    const dir = path.join(root, name);
    mkdirSync(dir);
    return dir;
  }) as [string, string, string, string, string];
  vi.stubEnv("PI_CODING_AGENT_DIR", user);
  return { user, live, a, b, bare };
}

function bus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(channel: string, handler: (data: unknown) => void) {
      const handlers = listeners.get(channel) ?? new Set();
      listeners.set(channel, handlers);
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    emit: vi.fn((channel: string, data: unknown) => {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
    }),
  };
}

function runtime(cwd: string, models: readonly RegistryModel[] = [sonnet, opus], events = bus()) {
  const h = harness();
  h.pi.events = events;
  subagents(h.pi);
  const getAll = vi.fn(() => models);
  const ctx = h.ctx({ cwd, ui: fakeUI(), modelRegistry: { getAll, find: () => undefined } });
  const start = (context = ctx) => h.emit("session_start", { type: "session_start" }, context);
  const stop = (reason = "quit") => h.emit("session_shutdown", { type: "session_shutdown", reason }, ctx);
  const ask = (fields: Partial<RoleModelRequest> = {}): RoleModelRequest => {
    const request: RoleModelRequest = { role: "worker", parent, thinking: "xhigh", ...fields };
    events.emit(ROLE_MODEL, request);
    return request;
  };
  cleanups.push(() => stop());
  return { h, ctx, getAll, events, start, stop, ask };
}

function agentFile(dir: string, model: string, thinking: string) {
  write(path.join(dir, "agents", "worker.md"), `---\nname: worker\ndescription: override\nmodel: ${model}\nthinking: ${thinking}\n---\n`);
}

function tierFile(dir: string, model: string) {
  write(path.join(dir, "pi-subagents.json"), JSON.stringify({ providerTiers: { p: { balanced: model } } }));
}

test("roleModel gives the role's profile on the parent's provider", () => {
  const request = { role: "worker", parent: "anthropic/claude-opus-5-5", thinking: "xhigh" };
  expect(roleModel(request, BUILTIN_AGENTS, DEFAULT_CONFIG, [sonnet, opus], "low")).toEqual({ model: "anthropic/claude-sonnet-5-5", thinking: "medium", source: "profile" });
});

test("roleModel falls back to the balanced tier", () => {
  const config = { ...DEFAULT_CONFIG, providerTiers: { p: { balanced: "p/mid" } } };
  expect(roleModel({ role: "worker", parent: "p/big", thinking: "high" }, BUILTIN_AGENTS, config, [], "low")).toEqual({ model: "p/mid", thinking: "high", source: "tier" });
});

test("roleModel falls back to the parent's model and the fallback effort", () => {
  expect(roleModel({ role: "worker", parent: "q/x" }, BUILTIN_AGENTS, DEFAULT_CONFIG, [], "low")).toEqual({ model: "q/x", thinking: "low", source: "default" });
});

test("roleModel ignores requests it cannot answer", () => {
  const ask = (data: unknown) => roleModel(data, BUILTIN_AGENTS, DEFAULT_CONFIG, [], "low");
  expect(ask({ role: "nobody", parent: "q/x" })).toBeUndefined();
  expect(ask({ role: "worker", parent: "noslash" })).toBeUndefined();
  expect(ask({ role: "worker", parent: "q/x", reply: { model: "a/b", thinking: "low", source: "default" } })).toBeUndefined();
  expect(ask(null)).toBeUndefined();
});

test("omitting availability preserves unregistered profile and file defaults", () => {
  expect(roleModel({ role: "worker", parent }, BUILTIN_AGENTS, DEFAULT_CONFIG, [], "low")).toEqual(workerReply);
  const agents = [{ ...WORKER, models: undefined, model: "p/file" }];
  expect(roleModel({ role: "worker", parent: "p/parent" }, agents, DEFAULT_CONFIG, [], "low"))
    .toEqual({ model: "p/file", thinking: "low", source: "profile" });
});

test.each(badAvailability.map((value) => [value]))("roleModel rejects malformed availability: %j", (availableModels) => {
  expect(roleModel({ role: "worker", parent, availableModels }, BUILTIN_AGENTS, DEFAULT_CONFIG, [sonnet, opus], "low")).toBeUndefined();
});

test.each(badCwds.map((value) => [value]))("roleModel rejects malformed cwd: %j", (cwd) => {
  expect(roleModel({ role: "worker", parent, cwd }, BUILTIN_AGENTS, DEFAULT_CONFIG, [sonnet, opus], "low")).toBeUndefined();
});

test("availability is a registry intersection, not permission to invent models or an unrestricted empty set", () => {
  const invented = { provider: "anthropic", id: "claude-sonnet-99" };
  for (const availableModels of [[], [invented], [{ ...sonnet, provider: "other" }]]) {
    expect(roleModel({ role: "worker", parent, availableModels }, BUILTIN_AGENTS, DEFAULT_CONFIG, [sonnet, opus], "low")).toBeUndefined();
  }
  expect(roleModel({ role: "worker", parent, availableModels: [sonnet] }, BUILTIN_AGENTS, DEFAULT_CONFIG, [], "low")).toBeUndefined();
  expect(roleModel({ role: "worker", parent, availableModels: [invented, sonnet] }, BUILTIN_AGENTS, DEFAULT_CONFIG, [sonnet, opus], "low")).toEqual(workerReply);
});

test("profiles use only the newest available family member on the parent's provider", () => {
  const older = { ...sonnet, id: "claude-sonnet-6" };
  const newer = { ...sonnet, id: "claude-sonnet-7" };
  const foreign = { ...sonnet, provider: "other", id: "claude-sonnet-100" };
  const models = [sonnet, opus, older, newer, foreign];
  const availableModels: readonly { provider: string; id: string }[] = Object.freeze([older, newer, foreign]);
  expect(roleModel({ role: "worker", parent, availableModels }, BUILTIN_AGENTS, DEFAULT_CONFIG, models, "low"))
    .toEqual({ model: "anthropic/claude-sonnet-7", thinking: "medium", source: "profile" });
});

test("an unavailable profile falls through to balanced, then an available parent", () => {
  const mid = { provider: "anthropic", id: "custom-mid", type: "chat" };
  const config = { ...DEFAULT_CONFIG, providerTiers: { anthropic: { balanced: "anthropic/custom-mid" } } };
  const ask = (availableModels: readonly RegistryModel[]) => roleModel(
    { role: "worker", parent, availableModels }, BUILTIN_AGENTS, config, [sonnet, opus, mid], "low",
  );
  expect(ask([mid, opus])).toEqual({ model: "anthropic/custom-mid", thinking: "low", source: "tier" });
  expect(ask([opus])).toEqual({ model: parent, thinking: "low", source: "default" });
});

test("file defaults, provider tiers, legacy tiers and parent are tried only when available", () => {
  const models = ["file", "tier", "legacy", "parent"].map((id) => ({ provider: "p", id }));
  const agents = [{ ...WORKER, models: undefined, model: "p/file" }];
  const config = { ...DEFAULT_CONFIG, tiers: { balanced: "p/legacy" }, providerTiers: { p: { balanced: "p/tier" } } };
  for (const [offset, source] of ["profile", "tier", "tier", "default"].entries()) {
    expect(roleModel({ role: "worker", parent: "p/parent", availableModels: models.slice(offset) }, agents, config, models, "low"))
      .toEqual({ model: `p/${models[offset]!.id}`, thinking: "low", source });
  }
  expect(agents[0]!.model).toBe("p/file");
  expect(config.providerTiers.p.balanced).toBe("p/tier");
  expect(config.tiers.balanced).toBe("p/legacy");
});

test("unavailable configured tiers cannot mask a provider's available balanced preset", () => {
  const config = { ...DEFAULT_CONFIG, tiers: { balanced: "anthropic/legacy-missing" }, providerTiers: { anthropic: { balanced: "anthropic/provider-missing" } } };
  expect(roleModel({ role: "general", parent, availableModels: [sonnet] }, BUILTIN_AGENTS, config, [sonnet, opus], "medium"))
    .toEqual({ model: "anthropic/claude-sonnet-5-5", thinking: "medium", source: "tier" });
});

test("an available but unrelated candidate does not make an unavailable selected parent usable", () => {
  const other = { provider: "p", id: "unrelated" };
  expect(roleModel({ role: "general", parent: "p/missing", availableModels: [other] }, BUILTIN_AGENTS, DEFAULT_CONFIG, [other], "low")).toBeUndefined();
});

test("profiles, file defaults and configured tiers never cross provider", () => {
  const foreign = { provider: "other", id: "model" };
  const own = { provider: "p", id: "parent" };
  const agents = [{ ...WORKER, models: { p: { model: "other/model", thinking: "high" } }, model: "other/model" }];
  const config = { ...DEFAULT_CONFIG, tiers: { balanced: "other/model" }, providerTiers: { p: { balanced: "other/model" } } };
  const ask = (availableModels: RegistryModel[]) => roleModel({ role: "worker", parent: "p/parent", availableModels }, agents, config, [foreign, own], "low");
  expect(ask([foreign, own])).toEqual({ model: "p/parent", thinking: "low", source: "default" });
  expect(ask([foreign])).toBeUndefined();
});

test.each([
  { api: "pi-virtual" }, { type: "classifier" }, { type: "image" }, { type: "" },
])("availability excludes registry metadata %j even when the caller claims chat", (metadata) => {
  const excluded = { ...sonnet, ...metadata };
  const availableModels = [{ ...sonnet, api: "anthropic-messages", type: "chat" }, opus];
  expect(roleModel({ role: "worker", parent, availableModels }, BUILTIN_AGENTS, DEFAULT_CONFIG, [excluded, opus], "low"))
    .toEqual({ model: parent, thinking: "low", source: "default" });
  expect(roleModel({ role: "worker", parent, availableModels: [sonnet] }, BUILTIN_AGENTS, DEFAULT_CONFIG, [excluded], "low")).toBeUndefined();
});

test.each([
  { metadata: { reasoning: false }, thinking: "off" },
  { metadata: { reasoning: true }, thinking: "high" },
  { metadata: { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } }, thinking: "xhigh" },
])("profile thinking is clamped with registry metadata: $thinking", ({ metadata, thinking }) => {
  const agents = [{ ...WORKER, models: { anthropic: { model: "anthropic/claude-sonnet-5-5", thinking: "xhigh" } } }];
  const forged = { ...sonnet, reasoning: !metadata.reasoning, thinkingLevelMap: { xhigh: metadata.thinkingLevelMap ? null : "xhigh" } };
  expect(roleModel({ role: "worker", parent, availableModels: [forged] }, agents, DEFAULT_CONFIG, [{ ...sonnet, ...metadata }], "low"))
    .toEqual({ model: "anthropic/claude-sonnet-5-5", thinking, source: "profile" });
});

test("readiness is published last at startup and teardown queries cannot answer", async () => {
  const { live } = sandbox();
  const r = runtime(live);
  const observations: Array<{ ready: boolean; reply: RoleModelRequest["reply"] }> = [];
  expect(ROLE_MODEL_READY).toBe("subagents:role-model-ready");
  r.events.on(ROLE_MODEL_READY, (data) => {
    observations.push({ ready: (data as { ready: boolean }).ready, reply: r.ask().reply });
  });
  expect(r.ask().reply).toBeUndefined();
  expect(observations).toEqual([]);
  await r.start();
  expect(observations).toEqual([{ ready: true, reply: workerReply }]);
  expect(r.events.emit.mock.calls.filter(([channel]) => channel !== ROLE_MODEL).at(-1))
    .toEqual([ROLE_MODEL_READY, { ready: true }]);
  expect(r.ask().reply).toEqual(workerReply);
  await r.stop();
  expect(observations).toEqual([{ ready: true, reply: workerReply }, { ready: false, reply: undefined }]);
  expect(r.ask().reply).toBeUndefined();
});

test("the bus rejects invalid requests and preserves a pre-filled reply", async () => {
  const { live } = sandbox();
  const r = runtime(live);
  await r.start();
  for (const fields of [
    ...badAvailability.map((availableModels) => ({ availableModels })),
    ...badCwds.map((cwd) => ({ cwd })),
  ]) {
    const request = { role: "worker", parent, ...fields };
    expect(() => r.events.emit(ROLE_MODEL, request)).not.toThrow();
    expect(request).not.toHaveProperty("reply");
  }
  for (const request of [null, undefined, 1, {}, { role: "missing", parent }]) {
    expect(() => r.events.emit(ROLE_MODEL, request)).not.toThrow();
  }
  const reply: NonNullable<RoleModelRequest["reply"]> = { model: "other/model", thinking: "off", source: "default" };
  expect(r.ask({ reply }).reply).toBe(reply);
  expect(r.ask({ availableModels: [] }).reply).toBeUndefined();
  expect(r.ask({ availableModels: [opus] }).reply).toEqual({ model: parent, thinking: "xhigh", source: "default" });
});

test("destination agent discovery honors project over user over built-in without leaking between cwd queries", async () => {
  const { user, live, a, b, bare } = sandbox();
  const userModel = { ...sonnet, id: "user-worker" };
  agentFile(user, "anthropic/user-worker", "low");
  agentFile(path.join(live, ".pi"), "anthropic/claude-sonnet-5-5", "medium");
  agentFile(path.join(a, ".pi"), parent, "high");
  agentFile(path.join(b, ".pi"), "anthropic/claude-sonnet-5-5", "off");
  const r = runtime(live, [sonnet, opus, userModel]);
  await r.start();
  const ask = (cwd?: string) => r.ask({ cwd, availableModels: [sonnet, opus, userModel] }).reply;
  expect(ask()).toEqual(workerReply);
  expect(ask(a)).toEqual({ model: parent, thinking: "high", source: "profile" });
  expect(ask(path.relative(live, b))).toEqual({ model: "anthropic/claude-sonnet-5-5", thinking: "off", source: "profile" });
  expect(ask(bare)).toEqual({ model: "anthropic/user-worker", thinking: "low", source: "profile" });
  expect(ask(a)).toEqual({ model: parent, thinking: "high", source: "profile" });
  expect(ask()).toEqual(workerReply);
});

test("destination tiers merge user/project overrides while no cwd keeps the live configuration", async () => {
  const { user, live, a, b, bare } = sandbox();
  const models = ["parent", "user", "live", "a", "b", "changed"].map((id) => ({ provider: "p", id }));
  tierFile(user, "p/user");
  tierFile(path.join(live, ".pi"), "p/live");
  tierFile(path.join(a, ".pi"), "p/a");
  tierFile(path.join(b, ".pi"), "p/b");
  const r = runtime(live, models);
  await r.start();
  const ask = (cwd?: string) => r.ask({ role: GENERAL.name, parent: "p/parent", thinking: "medium", cwd, availableModels: models }).reply;
  const expected = (id: string) => ({ model: `p/${id}`, thinking: "medium", source: "tier" });
  expect(ask()).toEqual(expected("live"));
  expect(ask(a)).toEqual(expected("a"));
  expect(ask(path.relative(live, b))).toEqual(expected("b"));
  expect(ask(bare)).toEqual(expected("user"));
  tierFile(path.join(live, ".pi"), "p/changed");
  tierFile(path.join(a, ".pi"), "p/changed");
  expect(ask(a)).toEqual(expected("changed"));
  expect(ask(b)).toEqual(expected("b"));
  expect(ask(live)).toEqual(expected("changed"));
  expect(ask()).toEqual(expected("live"));
});

test("reload replaces the role provider even when old synchronous bus listeners remain", async () => {
  const { live, a } = sandbox();
  const events = bus();
  const ready: unknown[] = [];
  events.on(ROLE_MODEL_READY, (data) => ready.push(data));
  const old = runtime(live, [sonnet, opus], events);
  await old.start();
  expect(old.ask().reply).toEqual(workerReply);
  await old.stop("reload");
  const fresh = runtime(a, [opus], events);
  expect(fresh.ask().reply).toBeUndefined();
  await fresh.start();
  expect(fresh.ask({ thinking: "low" }).reply).toEqual({ model: parent, thinking: "low", source: "default" });
  await fresh.stop();
  expect(fresh.ask().reply).toBeUndefined();
  expect(ready).toEqual([{ ready: true }, { ready: false }, { ready: true }, { ready: false }]);
});

test.each(["shutdown", "new context", "same context restart"])("a role query cannot publish after synchronous %s reentry", async (transition) => {
  const { live, a } = sandbox();
  const r = runtime(live);
  await r.start();
  let reentered: Promise<unknown> | undefined;
  const nextCtx = transition === "new context" ? r.h.ctx({ ...r.ctx, cwd: a, ui: fakeUI() }) : r.ctx;
  r.getAll.mockImplementationOnce(() => {
    reentered = transition === "shutdown" ? r.stop() : r.start(nextCtx);
    return [sonnet, opus];
  }).mockReturnValue([opus]);
  expect(r.ask().reply).toBeUndefined();
  expect(reentered).toBeDefined();
  await reentered;
  expect(r.ask({ thinking: "low" }).reply).toEqual(transition === "shutdown" ? undefined : { model: parent, thinking: "low", source: "default" });
});

test.each(["shutdown", "new context"])("startup interrupted by %s cannot publish stale readiness", async (transition) => {
  const { live, a } = sandbox();
  const r = runtime(live);
  const nextCtx = r.h.ctx({ ...r.ctx, cwd: a, ui: fakeUI(), modelRegistry: { getAll: () => [opus] } });
  let reentered: Promise<unknown> | undefined;
  r.ctx.ui.addAutocompleteProvider = () => {
    reentered = transition === "shutdown" ? r.stop() : r.start(nextCtx);
  };
  await r.start();
  expect(reentered).toBeDefined();
  await reentered;
  expect(r.events.emit.mock.calls.filter(([channel]) => channel === ROLE_MODEL_READY))
    .toEqual([[ROLE_MODEL_READY, { ready: transition !== "shutdown" }]]);
  expect(r.ask({ thinking: "low" }).reply).toEqual(transition === "shutdown" ? undefined : { model: parent, thinking: "low", source: "default" });
});
