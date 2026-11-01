import type { ClassifierModel, Provider } from "@earendil-works/pi-ai";

const PROVIDER = "system1-openai";
const MODEL = "gpt-6-luna";
const BASE_URL = "https://api.openai.com/v1";
const SETUP = "OpenAI Decisions is unavailable; enable pi-system1 and configure /login system1-openai";
const UNSUPPORTED = "OpenAI Decisions API usage requires Pi's native Decisions adapter; update Pi";
const INVALID_TARGET = "OpenAI Decisions API usage requires system1-openai/gpt-6-luna, the native Decisions API and the official OpenAI endpoint";

function nativeTarget(model: unknown): model is ClassifierModel<"openai-decisions"> {
  if (!model || typeof model !== "object") return false;
  const entry = model as Record<string, unknown>;
  return entry.type === "classifier" && entry.provider === PROVIDER && entry.id === MODEL &&
    entry.api === "openai-decisions" && (entry.baseUrl === BASE_URL || entry.baseUrl === `${BASE_URL}/`);
}

/** Optional on older Pi hosts: Jev must remain usable without the native Decisions APIs. */
export async function createDecisionsProvider(): Promise<Provider | undefined> {
  try {
    // Pi explicitly aliases providers/all for extensions. Arbitrary provider/API
    // subpaths are swallowed by its root compatibility alias in the real loader.
    const [{ createProvider, envApiKeyAuth }, { builtinProviders }] = await Promise.all([
      import("@earendil-works/pi-ai"),
      import("@earendil-works/pi-ai/providers/all"),
    ]);
    if (typeof createProvider !== "function" || typeof envApiKeyAuth !== "function" ||
        typeof builtinProviders !== "function") return undefined;
    const nativeProvider = builtinProviders().find((provider) => provider.id === "openai");
    const native = nativeProvider?.getAllModels?.().find((model) =>
      model.type === "classifier" && model.id === MODEL && model.api === "openai-decisions");
    // Provider.classify is wire dispatch, not Models.classify/auth resolution.
    // The host still resolves credentials for system1-openai before invoking it.
    const classify = nativeProvider?.classify?.bind(nativeProvider);
    if (!native || native.type !== "classifier" || !classify) return undefined;
    // Use only the classifier catalog metadata, never the built-in provider's chat/auth/headers.
    const { headers: _headers, ...metadata } = native;
    const provider = createProvider({
      id: PROVIDER,
      name: "OpenAI Decisions (API credits)",
      baseUrl: BASE_URL,
      auth: { apiKey: envApiKeyAuth("OpenAI Decisions API key", ["SYSTEM1_OPENAI_API_KEY"]) },
      models: [{ ...structuredClone(metadata), provider: PROVIDER, baseUrl: BASE_URL }],
      classifiers: { "openai-decisions": { classify } },
    });
    const dispatch = provider.classify;
    if (!dispatch) return undefined;
    return {
      ...provider,
      // models.json and request-time auth can override model endpoints. Guard the final model
      // before dispatch, including nonnative API overrides that would bypass the adapter map.
      classify: async (model, context, options) => {
        if (!nativeTarget(model)) {
          return {
            api: "openai-decisions", provider: PROVIDER, model: MODEL,
            answers: {}, stopReason: "error", timestamp: Date.now(), errorMessage: INVALID_TARGET,
          };
        }
        return dispatch(model, context, { ...options, maxRetries: 0 });
      },
    };
  } catch {
    // Missing exports, module paths or classifier metadata are a capability failure, not a
    // reason to break suite loading or expose a host/import exception in the status UI.
    return undefined;
  }
}

export async function registerDecisionsProvider(registry: { registerProvider(provider: Provider): void }): Promise<boolean> {
  const provider = await createDecisionsProvider();
  if (!provider) return false;
  registry.registerProvider(provider);
  return true;
}

type Availability = { availability: "configured" | "unavailable"; reason?: string };
type AvailabilityRegistry = {
  findOfType?(type: "classifier", provider: string, model: string): unknown;
  getModelOfType?(type: "classifier", provider: string, model: string): unknown;
  checkAuth?(provider: string): Promise<{ type?: string } | undefined>;
  getProviderAuthStatus?(provider: string): { configured: boolean };
  isConfigured?(provider: string): boolean | Promise<boolean>;
};

/** Local capability/auth inspection only: no inference, OAuth refresh or request-auth lookup. */
export async function inspectDecisionsAvailability(registry: unknown): Promise<Availability> {
  const reg = registry as AvailabilityRegistry | undefined;
  try {
    const lookup = reg?.findOfType ?? reg?.getModelOfType;
    if (typeof lookup !== "function") return { availability: "unavailable", reason: UNSUPPORTED };
    const model = lookup.call(reg, "classifier", PROVIDER, MODEL);
    if (!model) return { availability: "unavailable", reason: SETUP };
    if (!nativeTarget(model)) return { availability: "unavailable", reason: INVALID_TARGET };
    let configured: boolean;
    if (typeof reg?.checkAuth === "function") {
      configured = (await reg.checkAuth(PROVIDER))?.type === "api_key";
    } else if (typeof reg?.getProviderAuthStatus === "function") {
      // ModelRegistry's synchronous configured-auth snapshot; unlike getProviderAuth it never
      // resolves credentials or refreshes OAuth. ModelRuntime exposes checkAuth directly.
      configured = reg.getProviderAuthStatus(PROVIDER).configured === true;
    } else if (typeof reg?.isConfigured === "function") {
      configured = await reg.isConfigured(PROVIDER);
    } else {
      return { availability: "unavailable", reason: "This Pi cannot inspect local Decisions credentials; update Pi" };
    }
    return configured ? { availability: "configured" } : { availability: "unavailable", reason: SETUP };
  } catch {
    return { availability: "unavailable", reason: "OpenAI Decisions local configuration could not be inspected" };
  }
}
