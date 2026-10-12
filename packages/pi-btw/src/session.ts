// Sub-session plumbing: a resource loader carrying the parent's system prompt, a model runtime
// that reaches the parent's providers, and credential checks.
// Origin: pi-btw 0.6.1 extensions/btw.ts (MIT, Dan Bachelder).
// Prompt inheritance carries instructions/context only; no parent tools, extensions,
// MCP servers, skills or prompt-template registrations are loaded in a child.
import {
  createExtensionRuntime,
  ModelRuntime,
  type CreateAgentSessionOptions,
  type ExtensionCommandContext,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { BTW_SYSTEM_PROMPT, type SessionModel } from "./thread.ts";

export function stripDynamicSystemPromptFooter(systemPrompt: string): string {
  return systemPrompt
    .replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
    .replace(/\nCurrent working directory:[^\n]*$/u, "")
    .trim();
}

export function createBtwResourceLoader(
  ctx: ExtensionCommandContext,
  appendSystemPrompt: string[] = [BTW_SYSTEM_PROMPT],
): ResourceLoader {
  const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());

  const resourceLoader: ResourceLoader = {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => appendSystemPrompt,
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async (_options) => {},
  };

  return resourceLoader;
}

export async function createBtwModelRuntimeOptions(
  ctx: ExtensionCommandContext,
  model: SessionModel,
  checkCurrent: () => void = () => {},
): Promise<Pick<CreateAgentSessionOptions, "modelRuntime">> {
  const nativeProvider = ctx.modelRegistry.getRegisteredNativeProvider(model.provider);
  const providerConfig = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
  const hasRuntimeApiKey = ctx.modelRegistry.getProviderAuthStatus(model.provider).source === "runtime";

  // Read any parent-only credentials before constructing the independent runtime.
  const auth = hasRuntimeApiKey ? await ctx.modelRegistry.getApiKeyAndHeaders(model) : undefined;
  checkCurrent();
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  checkCurrent();
  if (nativeProvider) {
    modelRuntime.registerNativeProvider(nativeProvider);
  } else if (providerConfig) {
    modelRuntime.registerProvider(model.provider, providerConfig);
  }
  await modelRuntime.refresh({ allowNetwork: false });
  checkCurrent();

  // --api-key is stored only in the parent runtime.
  if (auth?.ok && auth.apiKey) {
    await modelRuntime.setRuntimeApiKey(model.provider, auth.apiKey);
    checkCurrent();
  }

  return { modelRuntime };
}

export function hasResolvedAuthValues(values?: Record<string, string | null | undefined>): boolean {
  return !!values && Object.values(values).some((value) => typeof value === "string" && value.length > 0);
}

export function hasUsableModelAuth(
  ctx: ExtensionCommandContext,
  model: SessionModel,
  auth: Awaited<ReturnType<ExtensionCommandContext["modelRegistry"]["getApiKeyAndHeaders"]>>,
): boolean {
  if (!auth.ok) {
    return false;
  }

  return (
    !!auth.apiKey ||
    hasResolvedAuthValues(auth.headers) ||
    hasResolvedAuthValues(auth.env) ||
    ctx.modelRegistry.hasConfiguredAuth(model)
  );
}
