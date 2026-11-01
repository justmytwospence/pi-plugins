import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels, type Credential, type CredentialStore } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createDecisionsProvider, inspectDecisionsAvailability, registerDecisionsProvider } from "../src/provider.js";

const context = {
  state: { message: "approved" },
  questions: { approved: { type: "bool" as const, instructions: "Approved?", criteria: { true: "Yes", false: "No" } } },
};

function credentials(values: Record<string, Credential> = {}): CredentialStore {
  return {
    read: vi.fn(async (id) => values[id]),
    list: async () => Object.entries(values).map(([providerId, value]) => ({ providerId, type: value.type })),
    modify: async (id, fn) => {
      const result = await fn(values[id]);
      if (result) values[id] = result;
      return values[id];
    },
    delete: async (id) => { delete values[id]; },
  };
}

async function runtime(values: Record<string, Credential> = {}, env: Record<string, string> = {}) {
  const store = credentials(values);
  const readEnv = vi.fn(async (name: string) => env[name]);
  const models = createModels({ credentials: store, authContext: { env: readEnv, fileExists: async () => false } });
  const provider = (await createDecisionsProvider())!;
  expect(provider).toBeDefined();
  models.setProvider(provider);
  return { models, store, readEnv, provider };
}

afterEach(() => {
  vi.doUnmock("@earendil-works/pi-ai");
  vi.doUnmock("@earendil-works/pi-ai/providers/openai");
  vi.doUnmock("@earendil-works/pi-ai/api/openai-decisions");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("isolated native provider", () => {
  it("clones native classifier metadata only and leaves OpenAI subscription chat unchanged", async () => {
    const original = openaiProvider();
    const before = original.getAllModels!();
    const native = before.find((model) => model.type === "classifier" && model.id === "gpt-6-luna")!;
    const provider = (await createDecisionsProvider())!;
    expect(provider.id).toBe("system1-openai");
    expect(provider.name).toBe("OpenAI Decisions (API credits)");
    expect(provider.baseUrl).toBe("https://api.openai.com/v1");
    expect(provider.getModels()).toEqual([]);
    expect(provider.getAllModels!()).toEqual([{ ...native, provider: "system1-openai", baseUrl: provider.baseUrl }]);
    expect(provider.getAllModels!()[0]).not.toBe(native);
    expect(provider.headers).toBeUndefined();
    expect(provider.auth.oauth).toBeUndefined();
    expect(provider.auth.apiKey?.login).toBeTypeOf("function");
    expect(original.id).toBe("openai");
    expect(original.auth.oauth).toBeDefined();
    expect(original.getAllModels!()).toEqual(before);
    expect(original.getModels().length).toBeGreaterThan(0);
  });

  it("uses only the dedicated environment key, never generic OpenAI or TypeSafe keys", async () => {
    const { models, store, readEnv } = await runtime({}, { OPENAI_API_KEY: "fake-generic", TYPESAFE_API_KEY: "fake-jev" });
    expect(await models.checkAuth("system1-openai")).toBeUndefined();
    expect(readEnv.mock.calls.every(([name]) => name === "SYSTEM1_OPENAI_API_KEY")).toBe(true);
    expect(store.read).toHaveBeenCalledWith("system1-openai", expect.anything());
    const configured = await runtime({}, { SYSTEM1_OPENAI_API_KEY: "fake-isolated" });
    expect(await configured.models.getAuth("system1-openai")).toMatchObject({ auth: { apiKey: "fake-isolated" } });
  });

  it("uses a provider-scoped stored key without disturbing openai OAuth", async () => {
    const oauth: Credential = { type: "oauth", access: "fake-chat", refresh: "fake-refresh", expires: Date.now() + 60_000 };
    const { models, store } = await runtime({
      openai: oauth,
      "system1-openai": { type: "api_key", key: "fake-stored" },
    }, { SYSTEM1_OPENAI_API_KEY: "fake-env" });
    expect(await models.getAuth("system1-openai")).toMatchObject({ auth: { apiKey: "fake-stored" }, source: "stored credential" });
    expect(await store.read("openai")).toBe(oauth);
    const missing = await runtime({ openai: oauth });
    expect(await missing.models.getAuth("system1-openai")).toBeUndefined();
  });

  it("reuses the native wire adapter at /v1/decisions, preserving genuine probabilities and usage", async () => {
    const { models } = await runtime({}, { SYSTEM1_OPENAI_API_KEY: "fake-isolated" });
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      answers: [{ type: "predicate", name: "approved", probability: 0.82 }],
      usage: { input_tokens: 30, output_tokens: 4 },
    }), { status: 200 }));
    const model = models.getModelOfType("classifier", "system1-openai", "gpt-6-luna")!;
    const result = await models.classify(model, context, { fetch });
    expect(result.stopReason).toBe("stop");
    expect(result.answers.approved).toEqual({ type: "bool", probability: 0.82 });
    expect(result.usage).toMatchObject({ input: 30, output: 4, totalTokens: 34 });
    const [url, options] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api.openai.com/v1/decisions");
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({ authorization: "Bearer fake-isolated" });
    expect(JSON.parse(options.body as string)).toMatchObject({ model: "gpt-6-luna", questions: [{ type: "predicate", name: "approved" }] });
  });

  it("maps native choice distributions and fractional zero-based scores without fabrication", async () => {
    const { models } = await runtime({}, { SYSTEM1_OPENAI_API_KEY: "fake-isolated" });
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      answers: [
        { type: "choice", name: "category", choice: "b", probabilities: [{ value: "a", probability: .3 }, { value: "b", probability: .7 }], confidence: .82 },
        { type: "score", name: "strength", score: 1.35, confidence: .76 },
      ],
      usage: { input_tokens: 40, output_tokens: 8 },
    }), { status: 200 }));
    const model = models.getModelOfType("classifier", "system1-openai", "gpt-6-luna")!;
    const result = await models.classify(model, {
      state: { evidence: "supplied" },
      questions: {
        category: { type: "choice", instructions: "Choose", criteria: { a: "A", b: "B" } },
        strength: { type: "score", instructions: "Rate", criteria: ["None", "Partial", "Strong"] },
      },
    }, { fetch });
    expect(result.stopReason).toBe("stop");
    expect(result.answers).toEqual({
      category: { type: "choice", choice: "b", probabilities: { a: .3, b: .7 }, confidence: .82 },
      strength: { type: "score", score: 1.35, confidence: .76 },
    });
    expect(result.usage?.totalTokens).toBe(48);
    const [url, options] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api.openai.com/v1/decisions");
    expect(JSON.parse(options.body as string).questions).toEqual([
      { type: "choice", name: "category", instructions: "Choose", choices: [{ value: "a", description: "A" }, { value: "b", description: "B" }] },
      { type: "score", name: "strength", instructions: "Rate", levels: [{ label: "None" }, { label: "Partial" }, { label: "Strong" }] },
    ]);
  });

  it("does not retry native API failures", async () => {
    const { models } = await runtime({}, { SYSTEM1_OPENAI_API_KEY: "fake-isolated" });
    const fetch = vi.fn(async () => new Response('{"error":{"message":"quota exhausted"}}', { status: 429 }));
    const model = models.getModelOfType("classifier", "system1-openai", "gpt-6-luna")!;
    expect((await models.classify(model, context, { fetch, maxRetries: 4 })).stopReason).toBe("error");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { api: "openai-responses" }, { api: "typesafe-system-one" },
    { provider: "openai" }, { id: "gpt-chat" }, { type: "chat" },
    { baseUrl: "https://chatgpt.com/backend-api" }, { baseUrl: "https://proxy.invalid/v1" },
    { baseUrl: "https://api.openai.com.evil.invalid/v1" }, { baseUrl: "http://api.openai.com/v1" },
    { baseUrl: "https://user:pass@api.openai.com/v1" }, { baseUrl: "https://api.openai.com/v1?redirect=bad" },
  ])("rejects model/API/endpoint override %j without dispatch", async (override) => {
    const provider = (await createDecisionsProvider())!;
    const fetch = vi.fn();
    const model = { ...provider.getAllModels!()[0], ...override };
    const result = await provider.classify!(model as never, context, { apiKey: "fake", fetch });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("native Decisions API");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("registers only the isolated provider", async () => {
    const registerProvider = vi.fn();
    expect(await registerDecisionsProvider({ registerProvider })).toBe(true);
    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerProvider.mock.calls[0][0].id).toBe("system1-openai");
  });

  it("returns undefined when an older host lacks native exports", async () => {
    vi.doMock("@earendil-works/pi-ai", () => ({}));
    const oldHost = await import("../src/provider.js");
    expect(await oldHost.createDecisionsProvider()).toBeUndefined();
    const registerProvider = vi.fn();
    expect(await oldHost.registerDecisionsProvider({ registerProvider })).toBe(false);
    expect(registerProvider).not.toHaveBeenCalled();
  });

  it("returns undefined on unsupported module paths or missing classifier catalog", async () => {
    vi.doMock("@earendil-works/pi-ai/api/openai-decisions", () => { throw new Error("private unsafe import failure"); });
    expect(await (await import("../src/provider.js")).createDecisionsProvider()).toBeUndefined();
    vi.doUnmock("@earendil-works/pi-ai/api/openai-decisions");
    vi.resetModules();
    vi.doMock("@earendil-works/pi-ai/providers/openai", () => ({ openaiProvider: () => ({ getAllModels: () => [] }) }));
    expect(await (await import("../src/provider.js")).createDecisionsProvider()).toBeUndefined();
  });
});

describe("local availability", () => {
  const model = { type: "classifier", id: "gpt-6-luna", provider: "system1-openai", api: "openai-decisions", baseUrl: "https://api.openai.com/v1" };
  it("uses classifier lookup plus checkAuth, never inference/request auth", async () => {
    const reg = {
      findOfType: vi.fn(() => model), checkAuth: vi.fn(async () => ({ type: "api_key" })),
      classify: vi.fn(), getProviderAuth: vi.fn(), getAuth: vi.fn(), find: vi.fn(),
    };
    expect(await inspectDecisionsAvailability(reg)).toEqual({ availability: "configured" });
    expect(reg.findOfType).toHaveBeenCalledWith("classifier", "system1-openai", "gpt-6-luna");
    expect(reg.checkAuth).toHaveBeenCalledWith("system1-openai");
    for (const fn of [reg.classify, reg.getProviderAuth, reg.getAuth, reg.find]) expect(fn).not.toHaveBeenCalled();
  });
  it("supports the ModelRegistry snapshot and local isConfigured API", async () => {
    expect(await inspectDecisionsAvailability({ findOfType: () => model, getProviderAuthStatus: () => ({ configured: true }) })).toEqual({ availability: "configured" });
    expect(await inspectDecisionsAvailability({ findOfType: () => model, isConfigured: async () => true })).toEqual({ availability: "configured" });
  });
  it("supports ModelRuntime's classifier lookup without chat lookup", async () => {
    expect(await inspectDecisionsAvailability({ getModelOfType: () => model, checkAuth: async () => ({ type: "api_key" }) })).toEqual({ availability: "configured" });
  });
  it.each([undefined, {}, { findOfType: () => undefined },
    { findOfType: () => model, checkAuth: async () => undefined },
    { findOfType: () => model, checkAuth: async () => ({ type: "oauth" }) },
    { findOfType: () => ({ ...model, baseUrl: "https://proxy.invalid/v1" }) },
    { findOfType: () => model },
  ])("reports unavailable safely for %j", async (reg) => {
    expect(await inspectDecisionsAvailability(reg)).toMatchObject({ availability: "unavailable", reason: expect.any(String) });
  });
  it("does not leak exceptions", async () => {
    const result = await inspectDecisionsAvailability({ findOfType: () => model, checkAuth: () => { throw new Error("secret credential"); } });
    expect(result.availability).toBe("unavailable");
    expect(result.reason).not.toContain("secret credential");
  });
});
