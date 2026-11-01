import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli, validateCliRequest } from "../src/cli.js";
import { registerDecisionsProvider } from "../src/provider.js";
import { resetSystem1Runtime, resolveSystem1Route, type ClassifierQuestion, type System1Backend } from "../src/system1.js";

vi.mock("../src/provider.js", () => ({ registerDecisionsProvider: vi.fn(async () => true) }));

let directory: string;
const request = { state: "legacy state", questions: { approved: { type: "noul", instructions: "Approved?" } } };
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function select(backend: System1Backend | System1Backend[]) {
  writeFileSync(join(directory, "system1.json"), JSON.stringify(Array.isArray(backend) ? { waterfall: backend } : { backend }));
}
function registry(nativeAvailable = true) {
  return {
    registerProvider: vi.fn(),
    findOfType: vi.fn((_type: string, provider: string, id: string) =>
      !nativeAvailable && provider === "system1-openai" ? undefined : { type: "classifier", provider, id,
        api: provider === "system1-openai" ? "openai-decisions" : "typesafe-system-one", baseUrl: "https://api.openai.com/v1" }),
    classify: vi.fn(async (model: { id: string; provider: string }, context: { state: Record<string, unknown>; questions: Record<string, ClassifierQuestion> }) => ({
      stopReason: "stop", model: model.id, usage,
      answers: Object.fromEntries(Object.entries(context.questions).map(([id, q]) => [id,
        q.type === "bool" ? { type: "bool", probability: 0.83 } : q.type === "score" ? { type: "score", score: 0.6, confidence: 0.7 } :
          { type: "choice", choice: Object.keys(q.criteria)[0], probabilities: Object.fromEntries(Object.keys(q.criteria).map((key, i) => [key, i === 0 ? 1 : 0])), confidence: 1 },
      ])),
    })),
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-system1-cli-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.mocked(registerDecisionsProvider).mockReset().mockResolvedValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("runCli", () => {
  it("exports preflight validation without model or credential runtime construction", () => {
    expect(validateCliRequest({ questions: request.questions })).toMatchObject({ exitCode: 2, stdout: "" });
    expect(validateCliRequest(request)).toBeUndefined();
    select("openai-decisions");
    expect(validateCliRequest({ ...request, assets: {} })).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("assets") });
    expect(registerDecisionsProvider).not.toHaveBeenCalled();
  });
  it.each(["jev", "openai-decisions"] as const)("normalizes ordinary legacy questions for %s with actual provenance", async (backend) => {
    select(backend);
    const reg = registry();
    const result = await runCli({ ...request, questions: {
      approved: request.questions.approved,
      bool: { type: "bool", instructions: "Yes?", criteria: { true: "Accept" } },
      choice: { type: "choice", instructions: "Which?", criteria: { a: "First", b: "Second" } },
      score: { type: "score", instructions: "How much?", criteria: ["Low", "High"] },
    } }, reg);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    const provider = backend === "jev" ? "typesafe" : "system1-openai";
    const model = backend === "jev" ? "jev-latest" : "gpt-6-luna";
    const key = JSON.stringify([backend, provider, model]);
    expect(output).toEqual({ backend, provider, model, waterfall: [backend], selectionKey: key, targetKey: key,
      fallback: false, attempts: [{ backend, provider, model, targetKey: key, status: "succeeded",
        latencyMs: expect.any(Number), sdkCalls: 1, usage }], answers: expect.any(Object), usage });
    expect(output.answers.score.score).toBe(0.6);
    expect(output.answers.approved.probability).toBe(0.83);
    expect(registerDecisionsProvider).toHaveBeenCalledOnce();
    expect(reg.findOfType).toHaveBeenCalledWith("classifier", output.provider, output.model);
    expect(reg.classify.mock.calls[0][1]).toMatchObject({ state: { input: "legacy state" }, questions: {
      approved: { type: "bool", criteria: { true: "True", false: "False" } },
      bool: { type: "bool", criteria: { true: "Accept", false: "False" } },
    } });
    expect(reg.classify).toHaveBeenCalledOnce();
  });
  it.each([null, false, 3, ["first", "second"]])("wraps legacy nonobject state %j", async (state) => {
    const reg = registry();
    expect((await runCli({ ...request, state }, reg)).exitCode).toBe(0);
    expect(reg.classify.mock.calls[0][1]).toMatchObject({ state: { input: state } });
  });
  it("keeps object state unchanged and defaults an absent setting to Jev", async () => {
    const reg = registry();
    const state = { input: "already an object" };
    const result = await runCli({ ...request, state }, reg);
    expect(JSON.parse(result.stdout).backend).toBe("jev");
    expect(reg.classify.mock.calls[0][1].state).toBe(state);
  });
  it("supports ordinary Jev model overrides, without requiring the optional native host capability", async () => {
    vi.mocked(registerDecisionsProvider).mockResolvedValue(false);
    const reg = registry();
    const result = await runCli({ ...request, model: "jev-preview" }, reg);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ backend: "jev", model: "jev-preview" });
    expect(reg.findOfType).toHaveBeenCalledWith("classifier", "typesafe", "jev-preview");
  });
  it.each([
    ["jev", "openai-decisions"], ["openai-decisions", "jev"],
  ] satisfies System1Backend[][])("uses only the first successful rung of %j → %j", async (first, second) => {
    select([first, second]);
    const reg = registry();
    const result = await runCli(request, reg);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ backend: first, waterfall: [first, second], fallback: false,
      selectionKey: resolveSystem1Route({ provider: "typesafe", model: "jev-latest" }).key,
      attempts: [{ backend: first, status: "succeeded", sdkCalls: 1 }] });
    expect(reg.classify).toHaveBeenCalledOnce();
  });
  it.each([
    ["jev", "openai-decisions"], ["openai-decisions", "jev"],
  ] satisfies System1Backend[][])("reports the actual fallback for %j → %j and aggregates attempted usage once", async (first, second) => {
    select([first, second]);
    const reg = registry();
    reg.classify.mockResolvedValueOnce({ model: "failed-model", answers: {}, usage, stopReason: "error",
      errorMessage: "429 insufficient_quota credits exhausted private-provider-body" } as never);
    const result = await runCli(request, reg);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    const provider = second === "jev" ? "typesafe" : "system1-openai";
    const model = second === "jev" ? "jev-latest" : "gpt-6-luna";
    expect(output).toMatchObject({ backend: second, provider, model, waterfall: [first, second], fallback: true,
      selectionKey: resolveSystem1Route({ provider: "typesafe", model: "jev-latest" }).key,
      targetKey: JSON.stringify([second, provider, model]),
      attempts: [{ backend: first, status: "failed", code: "quota_exhausted", sdkCalls: 1, usage },
        { backend: second, status: "succeeded", sdkCalls: 1, usage }],
      usage: { ...usage, input: 20, output: 4, totalTokens: 24 } });
    expect(output.answers.approved.probability).toBe(0.83);
    expect(result.stderr).toBe(first === "jev"
      ? "System 1: Jev unavailable (quota or credits exhausted); trying OpenAI Decisions.\n"
      : "System 1: OpenAI Decisions unavailable (quota or credits exhausted); trying Jev.\n");
    expect(result.stdout + result.stderr).not.toContain("private-provider-body");
    expect(reg.classify).toHaveBeenCalledTimes(2);
  });
  it("keeps a server-reported Jev model distinct from the configured target key", async () => {
    select(["jev", "openai-decisions"]);
    const reg = registry();
    reg.classify.mockResolvedValueOnce({ model: "jev-version-123", answers: { approved: { type: "bool", probability: 0.4 } },
      stopReason: "stop" } as never);
    const result = await runCli(request, reg);
    expect(JSON.parse(result.stdout)).toMatchObject({ model: "jev-version-123", fallback: false,
      targetKey: JSON.stringify(["jev", "typesafe", "jev-latest"]), usage: null,
      attempts: [{ model: "jev-latest", sdkCalls: 1 }] });
  });
  it.each([false, "throws"] as const)("keeps Jev viable after optional native registration returns %j", async (registered) => {
    vi.mocked(registerDecisionsProvider).mockImplementation(async () => {
      if (registered === "throws") throw new Error("private-registration-body");
      return registered;
    });
    for (const waterfall of [["jev"], ["jev", "openai-decisions"], ["openai-decisions", "jev"]] satisfies System1Backend[][]) {
      select(waterfall);
      const reg = registry(false);
      const result = await runCli(request, reg);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ backend: "jev", waterfall, fallback: waterfall[0] !== "jev" });
      expect(reg.classify).toHaveBeenCalledOnce();
      expect(reg.classify.mock.calls[0][0].provider).toBe("typesafe");
      expect(result.stderr).not.toContain("private-registration-body");
      if (waterfall[0] === "openai-decisions") {
        expect(result.stderr).toContain("trying Jev");
        expect(JSON.parse(result.stdout).attempts).toMatchObject([
          { backend: "openai-decisions", code: "unavailable_model", sdkCalls: 0 }, { backend: "jev", sdkCalls: 1 },
        ]);
      } else expect(result.stderr).toBe("");
    }
  });
  it("works without the optional registry registration method", async () => {
    select(["openai-decisions", "jev"]);
    const { registerProvider: _unused, ...reg } = registry(false);
    expect((await runCli(request, reg)).exitCode).toBe(0);
    expect(registerDecisionsProvider).not.toHaveBeenCalled();
    expect(reg.classify).toHaveBeenCalledOnce();
  });
  it("fails only after the entire configured chain is exhausted and keeps stdout empty", async () => {
    select(["jev", "openai-decisions"]);
    const reg = registry();
    reg.classify.mockResolvedValue({ model: "failed-model", answers: {}, stopReason: "error",
      errorMessage: "401 invalid API key private-provider-body" } as never);
    const result = await runCli(request, reg);
    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toContain("System 1: Jev unavailable");
    expect(result.stderr).toContain("trying OpenAI Decisions");
    expect(result.stderr).toContain("OpenAI Decisions unavailable");
    expect(result.stderr).toContain("system1: ");
    expect(result.stderr).not.toContain("private-provider-body");
    expect(reg.classify).toHaveBeenCalledTimes(2);
  });
  it("does not fail over after a native safety refusal", async () => {
    select(["openai-decisions", "jev"]);
    const reg = registry();
    reg.classify.mockResolvedValueOnce({ model: "gpt-6-luna", answers: {}, stopReason: "error",
      errorMessage: "OpenAI Decisions refused to answer approved" } as never);
    const result = await runCli(request, reg);
    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toContain("safety refusals do not fail over");
    expect(reg.classify).toHaveBeenCalledOnce();
  });
  it.each([
    undefined, null, "string", [], {}, { questions: request.questions }, { state: "x" },
    { ...request, questions: [] }, { ...request, questions: {} }, { ...request, unexpected: true },
    { ...request, model: 1 }, { ...request, model: "" },
    { ...request, questions: { x: { type: "bool" } } },
    { ...request, questions: { x: { type: "bool", instructions: 1 } } },
    { ...request, questions: { x: { type: "bool", instructions: "x", criteria: null } } },
    { ...request, questions: { x: { type: "bool", instructions: "x", criteria: { true: 1 } } } },
    { ...request, questions: { x: { type: "choice", instructions: "x", criteria: [] } } },
    { ...request, questions: { x: { type: "choice", instructions: "x", criteria: {} } } },
    { ...request, questions: { x: { type: "choice", instructions: "x", criteria: { x: 1 } } } },
    { ...request, questions: { x: { type: "score", instructions: "x", criteria: [1] } } },
    { ...request, questions: { x: { type: "score", instructions: "x", criteria: [] } } },
    { ...request, questions: { x: { type: "wrong", instructions: "x" } } },
  ])("rejects invalid input before provider registration/credential resolution: %j", async (input) => {
    const reg = registry();
    const result = await runCli(input, reg);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^system1: /u);
    expect(registerDecisionsProvider).not.toHaveBeenCalled();
    expect(reg.findOfType).not.toHaveBeenCalled();
    expect(reg.classify).not.toHaveBeenCalled();
  });
  it("rejects nonserializable state before provider lookup", async () => {
    const state: Record<string, unknown> = {};
    state.cycle = state;
    expect((await runCli({ ...request, state }, registry())).exitCode).toBe(2);
    expect(registerDecisionsProvider).not.toHaveBeenCalled();
  });
  it.each([
    ["jev", "openai-decisions"], ["openai-decisions", "jev"], ["openai-decisions"],
  ] satisfies System1Backend[][])("rejects model overrides for the entire %j policy before bootstrap", async (...waterfall) => {
    select(waterfall);
    const input = { ...request, model: "jev-preview" };
    const reg = registry();
    expect(validateCliRequest(input)).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("model override") });
    expect(await runCli(input, reg)).toMatchObject({ exitCode: 2, stdout: "", stderr: expect.stringContaining("Jev-only") });
    expect(registerDecisionsProvider).not.toHaveBeenCalled();
    expect(reg.findOfType).not.toHaveBeenCalled();
    expect(reg.classify).not.toHaveBeenCalled();
  });
  it.each([
    [{ ...request, assets: {} }, "assets"],
    [{ ...request, long_context: false }, "long_context"],
    [{ ...request, questions: { box: { type: "box", instructions: "Find it" } } }, "box"],
  ])("directs experimental requests to the explicit Jev-only legacy helper before any call: %j", async (input, reason) => {
    for (const policy of [undefined, "jev", ["jev"], "openai-decisions", ["jev", "openai-decisions"], ["openai-decisions", "jev"]] as const) {
      if (policy) select(typeof policy === "string" ? policy : [...policy]);
      const reg = registry();
      expect(validateCliRequest(input)).toMatchObject({ exitCode: 2 });
      const result = await runCli(input, reg);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(reason);
      expect(result.stderr).toContain("legacy jev-ask");
      expect(result.stderr).toContain('explicit Jev-only chain (waterfall: ["jev"])');
      expect(registerDecisionsProvider).not.toHaveBeenCalled();
      expect(reg.findOfType).not.toHaveBeenCalled();
      expect(reg.classify).not.toHaveBeenCalled();
    }
  });
  it.each([true, false, "throws"] as const)("fences chain edits after registration outcome %j, even with an unchanged first rung", async (registered) => {
    select(["jev", "openai-decisions"]);
    vi.mocked(registerDecisionsProvider).mockImplementationOnce(async () => {
      select(["jev"]);
      if (registered === "throws") throw new Error("private-registration-body");
      return registered;
    });
    const reg = registry();
    const result = await runCli(request, reg);
    expect(result).toMatchObject({ exitCode: 1, stdout: "", stderr: expect.stringContaining("selection changed") });
    expect(reg.findOfType).not.toHaveBeenCalled();
    expect(reg.classify).not.toHaveBeenCalled();
  });
  it("does not reinterpret an override when registration switches Jev to Decisions", async () => {
    vi.mocked(registerDecisionsProvider).mockImplementationOnce(async () => { select("openai-decisions"); return true; });
    const reg = registry();
    expect(await runCli({ ...request, model: "jev-preview" }, reg)).toMatchObject({ exitCode: 1, stdout: "",
      stderr: expect.stringContaining("selection changed") });
    expect(reg.classify).not.toHaveBeenCalled();
  });
  it.each(["reorder", "malformed"] as const)("fences a %s policy during bootstrap without model lookup", async (change) => {
    select(["jev", "openai-decisions"]);
    vi.mocked(registerDecisionsProvider).mockImplementationOnce(async () => {
      if (change === "reorder") select(["openai-decisions", "jev"]);
      else writeFileSync(join(directory, "system1.json"), "{broken");
      return true;
    });
    const reg = registry();
    expect(await runCli(request, reg)).toMatchObject({ exitCode: 1, stdout: "", stderr: expect.stringContaining("selection changed") });
    expect(reg.findOfType).not.toHaveBeenCalled();
    expect(reg.classify).not.toHaveBeenCalled();
  });
  it("fences a manual reset during registration", async () => {
    const reg = registry();
    vi.mocked(registerDecisionsProvider).mockImplementationOnce(async () => { resetSystem1Runtime(reg); return true; });
    expect(await runCli(request, reg)).toMatchObject({ exitCode: 1, stdout: "", stderr: expect.stringContaining("selection changed") });
    expect(reg.classify).not.toHaveBeenCalled();
  });
  it("accepts legacy canonicalization during registration without a policy change", async () => {
    select("jev");
    vi.mocked(registerDecisionsProvider).mockImplementationOnce(async () => { select(["jev"]); return true; });
    expect((await runCli(request, registry())).exitCode).toBe(0);
  });
  it("reports malformed selection as unavailable, without registering or falling back", async () => {
    writeFileSync(join(directory, "system1.json"), "{broken");
    const reg = registry();
    expect((await runCli(request, reg)).exitCode).toBe(1);
    expect(registerDecisionsProvider).not.toHaveBeenCalled();
    expect(reg.classify).not.toHaveBeenCalled();
  });
  it.each([
    { waterfall: [], backend: "jev" }, { waterfall: ["jev", "jev"] }, { waterfall: ["jev", "unknown"] },
  ])("rejects an invalid authoritative chain before registration: %j", async (setting) => {
    writeFileSync(join(directory, "system1.json"), JSON.stringify(setting));
    const reg = registry();
    expect(validateCliRequest(request)).toMatchObject({ exitCode: 1 });
    expect(await runCli(request, reg)).toMatchObject({ exitCode: 1, stdout: "" });
    expect(registerDecisionsProvider).not.toHaveBeenCalled();
    expect(reg.findOfType).not.toHaveBeenCalled();
    expect(reg.classify).not.toHaveBeenCalled();
  });
  it("uses the authoritative waterfall rather than its legacy primary mirror", async () => {
    writeFileSync(join(directory, "system1.json"), JSON.stringify({ waterfall: ["openai-decisions", "jev"], backend: "jev" }));
    const result = await runCli(request, registry());
    expect(JSON.parse(result.stdout)).toMatchObject({ backend: "openai-decisions", waterfall: ["openai-decisions", "jev"] });
  });
  it("exhausts an unsupported native-only host without trying unconfigured Jev", async () => {
    select("openai-decisions");
    vi.mocked(registerDecisionsProvider).mockResolvedValue(false);
    const reg = registry(false);
    const result = await runCli(request, reg);
    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toContain("OpenAI Decisions");
    expect(reg.findOfType).toHaveBeenCalledExactlyOnceWith("classifier", "system1-openai", "gpt-6-luna");
    expect(reg.classify).not.toHaveBeenCalled();
  });
  it.each(["No API key for provider", "401 invalid API key", "429 insufficient_quota credits exhausted"])
    ("exits 1 for native provider failures without fallback: %s", async (message) => {
      select("openai-decisions");
      const reg = registry();
      reg.classify.mockResolvedValueOnce({ model: "gpt-6-luna", answers: {}, stopReason: "error", errorMessage: message } as never);
      const result = await runCli(request, reg);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("OpenAI Decisions");
      expect(reg.findOfType).toHaveBeenCalledOnce();
      expect(reg.findOfType).toHaveBeenCalledWith("classifier", "system1-openai", "gpt-6-luna");
      expect(reg.classify).toHaveBeenCalledOnce();
    });
  it("does not leak raw provider/registration exceptions", async () => {
    const reg = registry();
    reg.classify.mockRejectedValueOnce(new Error("secret-private-body"));
    expect((await runCli(request, reg)).stderr).not.toContain("secret-private-body");
    vi.mocked(registerDecisionsProvider).mockRejectedValueOnce(new Error("secret-private-key"));
    const result = await runCli(request, registry());
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("secret-private-key");
  });
});

// A completely synthetic installed SDK. Its jiti stub verifies the selected host/module root;
// runCli itself is exercised above with the real shared helper and fake classifier registry.
function fakeSdk() {
  const sdk = join(directory, "pi-coding-agent");
  mkdirSync(join(sdk, "dist"), { recursive: true });
  writeFileSync(join(sdk, "package.json"), '{"name":"pi-coding-agent","type":"module"}');
  writeFileSync(join(sdk, "dist", "index.js"), `
    import { writeFileSync } from "node:fs";
    export class ModelRuntime { static async create(options) {
      writeFileSync(new URL("../runtime-created", import.meta.url), "created");
      return options;
    } }
    export class ModelRegistry { constructor(runtime) { this.runtime = runtime; } }
  `);
  const jiti = join(sdk, "node_modules", "jiti");
  mkdirSync(jiti, { recursive: true });
  writeFileSync(join(jiti, "package.json"), '{"name":"jiti","type":"module","main":"index.js"}');
  writeFileSync(join(jiti, "index.js"), `
    import { pathToFileURL } from "node:url";
    export function createJiti(base, options) {
      return {
        esmResolve: (specifier) => pathToFileURL(base + "." + specifier.replaceAll("/", "_")).href,
        import: async (module) => {
          if (!module.endsWith("/packages/pi-system1/src/cli.ts")) throw new Error("wrong CLI module");
          return {
            validateCliRequest: (request) => !request || !Object.hasOwn(request, "state")
              ? {exitCode: 2, stdout: "", stderr: "system1: state is required\\n"} : undefined,
            runCli: async (request, registry) => ({
            exitCode: request.exitCode ?? 0,
            stdout: JSON.stringify({ request, base, options, module, runtime: registry.runtime }) + "\\n",
            stderr: request.stderr ?? "",
          }) };
        },
      };
    }
  `);
  writeFileSync(join(sdk, "dist", "cli.js"), "#!/usr/bin/env node\n");
  chmodSync(join(sdk, "dist", "cli.js"), 0o755);
  return sdk;
}
const bin = fileURLToPath(new URL("../bin/ask.mjs", import.meta.url));
function invoke(input: string, env: Record<string, string> = {}, args: string[] = []) {
  return spawnSync(process.execPath, [bin, ...args], { input, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PI_PACKAGE_DIR: join(directory, "missing-sdk"), ...env } });
}

describe("plain Node installed-host bootstrap", () => {
  it("honors PI_PACKAGE_DIR, loads its jiti and imports only this component's CLI", () => {
    const sdk = fakeSdk();
    const result = invoke(JSON.stringify(request), { PI_PACKAGE_DIR: sdk });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.request).toEqual(request);
    expect(output.base).toBe(join(sdk, "dist", "index.js"));
    expect(output.module).toBe(fileURLToPath(new URL("../src/cli.ts", import.meta.url)));
    expect(output.runtime).toEqual({ allowModelNetwork: false, refreshOnCreate: false });
    expect(Object.keys(output.options.alias)).toEqual([
      "@earendil-works/pi-ai/providers/all", "@earendil-works/pi-ai",
    ]);
    expect(Object.values(output.options.alias).every((value) => (value as string).startsWith(sdk))).toBe(true);
  });
  it("loads the real CLI through jiti with only the fake installed host's native APIs", () => {
    const sdk = fakeSdk();
    const hostModules = join(sdk, "node_modules");
    rmSync(join(hostModules, "jiti"), { recursive: true });
    const jitiPackage = dirname(dirname(fileURLToPath(import.meta.resolve("jiti"))));
    symlinkSync(jitiPackage, join(hostModules, "jiti"), "dir");
    const ai = join(hostModules, "@earendil-works", "pi-ai");
    mkdirSync(ai, { recursive: true });
    writeFileSync(join(ai, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", type: "module", exports: {
      ".": "./index.js", "./providers/all": "./all.js",
    } }));
    writeFileSync(join(ai, "index.js"), `
      export function envApiKeyAuth(name, envVars) { return { name, envVars }; }
      export function createProvider(input) { return {
        ...input, getModels: () => [], getAllModels: () => input.models,
        classify: (model, context, options) => input.classifiers[model.api].classify(model, context, options),
      }; }
    `);
    writeFileSync(join(ai, "all.js"), `
      import { classify } from "./decisions.js";
      export function builtinProviders() { return [{ id: "openai", classify, getAllModels: () => [{
        type: "classifier", id: "gpt-6-luna", provider: "openai", api: "openai-decisions",
        baseUrl: "https://api.openai.com/v1", name: "Fake native metadata",
      }] }]; }
    `);
    writeFileSync(join(ai, "decisions.js"), `
      export async function classify(model, context, options) {
        if (options.maxRetries !== 0) throw new Error("retries enabled");
        return { model: model.id, stopReason: "stop", answers: Object.fromEntries(
          Object.keys(context.questions).map(id => [id, {type: "bool", probability: 0.91}])
        ) };
      }
    `);
    writeFileSync(join(sdk, "dist", "index.js"), `
      export class ModelRuntime { static async create(options) { return options; } }
      export class ModelRegistry {
        constructor(runtime) { this.runtime = runtime; }
        registerProvider(provider) { this.provider = provider; }
        findOfType(type, provider, id) {
          return this.provider?.getAllModels().find(m => m.type === type && m.provider === provider && m.id === id);
        }
        classify(model, context, options) { return this.provider.classify(model, context, options); }
      }
    `);
    select("openai-decisions");
    const result = invoke(JSON.stringify(request), { PI_PACKAGE_DIR: sdk });
    expect(result.status, result.stderr).toBe(0);
    const key = JSON.stringify(["openai-decisions", "system1-openai", "gpt-6-luna"]);
    expect(JSON.parse(result.stdout)).toEqual({ backend: "openai-decisions", provider: "system1-openai", model: "gpt-6-luna",
      waterfall: ["openai-decisions"], selectionKey: key, targetKey: key, fallback: false,
      attempts: [{ backend: "openai-decisions", provider: "system1-openai", model: "gpt-6-luna", targetKey: key,
        status: "succeeded", latencyMs: expect.any(Number), sdkCalls: 1 }],
      answers: { approved: { type: "bool", probability: 0.91 } }, usage: null });
  });
  it("finds the installed SDK from a real pi executable, skipping npm's dev bin", () => {
    const sdk = fakeSdk();
    const bins = join(directory, "bin");
    const devBins = join(directory, "node_modules", ".bin");
    mkdirSync(bins);
    mkdirSync(devBins, { recursive: true });
    symlinkSync(join(sdk, "dist", "cli.js"), join(bins, "pi"));
    writeFileSync(join(devBins, "pi"), "#!/bin/sh\nexit 99\n");
    chmodSync(join(devBins, "pi"), 0o755);
    const result = invoke(JSON.stringify(request), { PI_PACKAGE_DIR: "", PATH: `${devBins}:${bins}:/usr/bin:/bin` });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).base).toBe(realpathSync(join(sdk, "dist", "index.js")));
  });
  it("forwards all runCli streams and exit status", () => {
    const sdk = fakeSdk();
    const result = invoke(JSON.stringify({ ...request, exitCode: 2, stderr: "test error\n" }), { PI_PACKAGE_DIR: sdk });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("test error\n");
    expect(JSON.parse(result.stdout).request.exitCode).toBe(2);
  });
  it.each(["", "not JSON", "{broken"])("rejects invalid stdin before trying to discover/load the SDK: %s", (input) => {
    const result = invoke(input);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("system1: stdin is not valid JSON\n");
  });
  it("rejects parsed invalid requests before creating the installed SDK runtime", () => {
    const sdk = fakeSdk();
    const result = invoke(JSON.stringify({ questions: request.questions }), { PI_PACKAGE_DIR: sdk });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("system1: state is required\n");
    expect(existsSync(join(sdk, "runtime-created"))).toBe(false);
  });
  it("rejects arguments before bootstrap", () => {
    const result = invoke(JSON.stringify(request), {}, ["--model", "other"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("takes no arguments");
  });
  it("fails without fallback when the installed SDK is missing", () => {
    const result = invoke(JSON.stringify(request));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("installed Pi bootstrap failed");
  });
});
