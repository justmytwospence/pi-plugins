import type { ProfileModel } from "./agents.ts";

export type Tier = "fast" | "balanced" | "strong" | "premium";

/** Known model families within a single provider and, for Google, a single subscription route. */
export interface ProviderPolicy {
  profileProvider: string;
  modelPrefix: string;
  tiers: Partial<Record<Tier, RegExp>>;
  generationSuffixes?: Partial<Record<Tier, string>>;
}

const CLAUDE: ProviderPolicy = {
  profileProvider: "anthropic", modelPrefix: "",
  tiers: { fast: /^claude-haiku-/u, balanced: /^claude-sonnet-/u, strong: /^claude-opus-/u, premium: /^claude-fable-/u },
};
const OPENAI: ProviderPolicy = {
  profileProvider: "openai", modelPrefix: "",
  tiers: { fast: /-luna$/u, balanced: /-terra$/u, strong: /-sol$/u, premium: /-astra$/u },
  generationSuffixes: { fast: "luna", balanced: "terra", strong: "sol" },
};
const GEMINI_VERSION = String.raw`\d+(?:\.\d+)*`;
const GEMINI: ProviderPolicy = {
  profileProvider: "google", modelPrefix: "",
  tiers: {
    fast: new RegExp(`^gemini-${GEMINI_VERSION}-flash-lite$`, "u"),
    balanced: new RegExp(`^gemini-${GEMINI_VERSION}-(?:hydrogen|flash)$`, "u"),
    strong: new RegExp(`^gemini-${GEMINI_VERSION}-(?:argon|pro)$`, "u"),
    premium: new RegExp(`^gemini-${GEMINI_VERSION}-carbon$`, "u"),
  },
};
const ANTIGRAVITY_GEMINI: ProviderPolicy = {
  profileProvider: "google", modelPrefix: "antigravity-",
  tiers: {
    fast: new RegExp(`^antigravity-gemini-${GEMINI_VERSION}-(?:hydrogen|flash)$`, "u"),
    balanced: new RegExp(`^antigravity-gemini-${GEMINI_VERSION}-(?:hydrogen|flash)$`, "u"),
    strong: new RegExp(`^antigravity-gemini-${GEMINI_VERSION}-(?:argon|pro)$`, "u"),
    premium: new RegExp(`^antigravity-gemini-${GEMINI_VERSION}-carbon$`, "u"),
  },
};
const ANTIGRAVITY_CLAUDE: ProviderPolicy = {
  profileProvider: "anthropic", modelPrefix: "antigravity-",
  tiers: {
    fast: /^antigravity-claude-sonnet-/u,
    balanced: /^antigravity-claude-sonnet-/u,
    strong: /^antigravity-claude-opus-/u,
  },
};
const MUSE_VERSION = String.raw`\d+(?:\.\d+)*`;
const MUSE: ProviderPolicy = {
  profileProvider: "muse-code", modelPrefix: "",
  tiers: {
    fast: new RegExp(`^muse-spark-${MUSE_VERSION}$`, "u"),
    balanced: new RegExp(`^muse-spark-${MUSE_VERSION}$`, "u"),
    strong: new RegExp(`^muse-wonder-${MUSE_VERSION}$`, "u"),
  },
};
const KNOWN: Record<string, ProviderPolicy> = { anthropic: CLAUDE, openai: OPENAI, "openai-codex": OPENAI, "muse-code": MUSE };

/** No policy for an unknown provider or an unrecognized Google route. */
export function providerPolicy(parentModel: string): ProviderPolicy | undefined {
  const slash = parentModel.indexOf("/");
  if (slash < 1) return undefined;
  const provider = parentModel.slice(0, slash);
  const id = parentModel.slice(slash + 1);
  if (provider === "google") {
    if (id.startsWith("antigravity-claude-")) return ANTIGRAVITY_CLAUDE;
    if (id.startsWith("antigravity-gemini-")) return ANTIGRAVITY_GEMINI;
    return id.startsWith("gemini-") ? GEMINI : undefined;
  }
  return Object.hasOwn(KNOWN, provider) ? KNOWN[provider] : undefined;
}

/** Built-in profiles may be rebased across provider aliases; user agent files never are. */
export function routeBuiltinProfile(entry: ProfileModel, parentModel: string, policy: ProviderPolicy): ProfileModel {
  const provider = parentModel.slice(0, parentModel.indexOf("/"));
  const id = entry.model.slice(entry.model.indexOf("/") + 1);
  return { ...entry, model: `${provider}/${policy.modelPrefix}${id}` };
}
