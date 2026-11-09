import type { Api, Model } from "@earendil-works/pi-ai";

type Ctx = {
  model?: Model<Api>;
  sessionManager: { getBranch(): readonly unknown[] };
  modelRegistry: {
    find(provider: string, id: string): Model<Api> | undefined;
    getAvailable(): readonly Model<Api>[];
  };
};

/** Whether a model is a virtual one (a plan model pair, for example): it never reaches a provider. */
export const isVirtual = (model: { api?: string } | undefined): boolean => model?.api === "pi-virtual";

/**
 * The physical model behind the selection: the selection itself, or for a virtual model the model of the
 * branch's latest successful assistant response (undefined before one).
 */
export function routedModel(ctx: Ctx): Model<Api> | undefined {
  if (!isVirtual(ctx.model)) return ctx.model;
  const branch = ctx.sessionManager.getBranch() as readonly {
    type?: string;
    message?: { role?: string; stopReason?: string; provider?: string; model?: string };
  }[];
  for (let index = branch.length - 1; index >= 0; index--) {
    const message = branch[index]?.type === "message" ? branch[index]?.message : undefined;
    if (message?.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
    if (typeof message.provider !== "string" || typeof message.model !== "string") continue;
    const found = ctx.modelRegistry.find(message.provider, message.model);
    if (found && !isVirtual(found)) return found;
  }
  return undefined;
}

/**
 * The physical model a provider payload names, for a virtual selection: the available physical model with
 * that id (the selection's provider first).
 */
export function payloadModel(ctx: Ctx, id: unknown): Model<Api> | undefined {
  if (!isVirtual(ctx.model)) return ctx.model;
  if (typeof id !== "string") return undefined;
  const matches = ctx.modelRegistry.getAvailable().filter((model) => model.id === id && !isVirtual(model));
  return matches.find((model) => model.provider === ctx.model?.provider) ?? matches[0];
}
