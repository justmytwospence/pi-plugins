import { ModelRuntime, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { createBtwModelRuntimeOptions, createBtwResourceLoader, hasUsableModelAuth, stripDynamicSystemPromptFooter } from "../src/session.ts";
import { BTW_SYSTEM_PROMPT } from "../src/thread.ts";
import { deferred, model } from "./harness.ts";

afterEach(() => vi.restoreAllMocks());

test("resource loader inherits prompt instructions only, with no parent registrations", async () => {
  const ctx = { getSystemPrompt: () => "<tools>parent descriptions</tools>\nInstructions\nCurrent date and time: yesterday\nCurrent working directory: /old" } as ExtensionCommandContext;
  const loader = createBtwResourceLoader(ctx);
  expect(loader.getSystemPrompt()).toBe("<tools>parent descriptions</tools>\nInstructions");
  expect(loader.getAppendSystemPrompt()).toEqual([BTW_SYSTEM_PROMPT]);
  expect(loader.getExtensions().extensions).toEqual([]);
  expect(loader.getExtensions().errors).toEqual([]);
  expect(loader.getSkills().skills).toEqual([]); expect(loader.getPrompts().prompts).toEqual([]);
  expect(loader.getThemes().themes).toEqual([]); expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
  expect(loader.getSystemPromptSource()).toBeUndefined(); expect(loader.getAppendSystemPromptSources()).toEqual([]);
  await loader.reload(); loader.extendResources({} as never);
  expect(stripDynamicSystemPromptFooter("No footer")).toBe("No footer");
});

function runtime() {
  return { registerNativeProvider: vi.fn(), registerProvider: vi.fn(), refresh: vi.fn(async () => {}), setRuntimeApiKey: vi.fn(async () => {}) };
}
function context(config: { native?: unknown; provider?: unknown; source?: string; auth?: unknown } = {}) {
  return { modelRegistry: {
    getRegisteredNativeProvider: () => config.native, getRegisteredProviderConfig: () => config.provider,
    getProviderAuthStatus: () => ({ source: config.source ?? "none" }),
    getApiKeyAndHeaders: vi.fn(async () => config.auth ?? { ok: true, apiKey: "unit-placeholder" }),
  } } as unknown as ExtensionCommandContext;
}

test("child model runtime is independent, model discovery stays offline, runtime credentials/providers are copied explicitly", async () => {
  const child = runtime(); const create = vi.spyOn(ModelRuntime, "create").mockResolvedValue(child as unknown as ModelRuntime);
  const native = { name: "unit" }; const provider = { baseUrl: "unused" };
  const result = await createBtwModelRuntimeOptions(context({ native, provider, source: "runtime" }), model);
  expect(result.modelRuntime).toBe(child);
  expect(create).toHaveBeenCalledWith({ allowModelNetwork: false });
  expect(child.registerNativeProvider).toHaveBeenCalledWith(native); expect(child.registerProvider).not.toHaveBeenCalled();
  expect(child.refresh).toHaveBeenCalledWith({ allowNetwork: false });
  expect(child.setRuntimeApiKey).toHaveBeenCalledWith(model.provider, "unit-placeholder");
});

test("normal providers still get an explicit offline runtime instead of SDK defaults", async () => {
  const child = runtime(); vi.spyOn(ModelRuntime, "create").mockResolvedValue(child as unknown as ModelRuntime);
  await createBtwModelRuntimeOptions(context(), model);
  expect(child.refresh).toHaveBeenCalledWith({ allowNetwork: false });
  expect(child.setRuntimeApiKey).not.toHaveBeenCalled();
  expect(child.registerNativeProvider).not.toHaveBeenCalled();
});

test("late runtime creation checks generation before further work and never revisits stale parent context", async () => {
  const gate = deferred<ModelRuntime>(); vi.spyOn(ModelRuntime, "create").mockReturnValue(gate.promise);
  let active = true; const child = runtime();
  const check = () => { if (!active) throw new Error("stale"); };
  const pending = createBtwModelRuntimeOptions(context(), model, check);
  active = false; gate.resolve(child as unknown as ModelRuntime);
  await expect(pending).rejects.toThrow("stale");
  expect(child.refresh).not.toHaveBeenCalled();
});

test("credential checks support headers/env/configured auth but do not treat failed resolution as usable", () => {
  const ctx = { modelRegistry: { hasConfiguredAuth: () => false } } as unknown as ExtensionCommandContext;
  expect(hasUsableModelAuth(ctx, model, { ok: false, error: "failed" })).toBe(false);
  expect(hasUsableModelAuth(ctx, model, { ok: true, apiKey: "" })).toBe(false);
  expect(hasUsableModelAuth(ctx, model, { ok: true, apiKey: "", headers: { value: "unit-placeholder" } })).toBe(true);
  expect(hasUsableModelAuth(ctx, model, { ok: true, apiKey: "", env: { value: "unit-placeholder" } })).toBe(true);
});
