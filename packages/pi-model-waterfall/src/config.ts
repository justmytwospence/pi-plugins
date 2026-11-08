import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_WATERFALL_ORDER, SUPPORTED_WATERFALL_MODELS, type WaterfallProvider } from "./decision.ts";

/** Only supported subscription-verified providers, with no implicit additions. */
export function parseWaterfallOrder(value: unknown): WaterfallProvider[] {
  if (!Array.isArray(value)) throw new Error("order must be an array of supported provider IDs.");
  const order: WaterfallProvider[] = [];
  for (const provider of value) {
    if (typeof provider !== "string" || !SUPPORTED_WATERFALL_MODELS.some(model => model.provider === provider))
      throw new Error("order contains an unsupported provider ID.");
    if (order.includes(provider as WaterfallProvider)) throw new Error("order contains duplicate provider IDs.");
    order.push(provider as WaterfallProvider);
  }
  return order;
}

/** Project order replaces global order. Invalid policy fails closed, without exposing contents. */
export function loadWaterfallConfig(cwd: string, agentDir: string): { order: WaterfallProvider[]; error?: string } {
  let result: { order: WaterfallProvider[]; error?: string } = { order: [...DEFAULT_WATERFALL_ORDER] };
  for (const path of [join(agentDir, "model-waterfall.json"), join(cwd, ".pi", "model-waterfall.json")]) {
    let contents: string;
    try { contents = readFileSync(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") result = { order: [], error: `${path}: cannot read configuration.` };
      continue;
    }
    let config: unknown;
    try { config = JSON.parse(contents); }
    catch { result = { order: [], error: `${path}: malformed JSON.` }; continue; }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      result = { order: [], error: `${path}: expected a configuration object.` };
      continue;
    }
    if (!Object.hasOwn(config, "order")) continue;
    try { result = { order: parseWaterfallOrder((config as Record<string, unknown>).order) }; }
    catch (error) { result = { order: [], error: `${path}: ${(error as Error).message}` }; }
  }
  return result;
}
