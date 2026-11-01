#!/usr/bin/env node
// The CLI injects pure component modules; evals/shared has no component dependencies.
// Dry/list/last read only local policy and never construct a registry or inspect auth.
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Local capability/auth only: any explicitly configured rung can make the chain viable. */
export function createEvalClassifier(route, currentKey) {
  return {
    waterfall: route.ok ? route.waterfall : [],
    targets: route.ok ? route.targets : [],
    key: route.key,
    ...(!route.ok ? { reason: route.reason } : {}),
    currentKey,
    async configured(registry) {
      if (!route.ok) return false;
      for (const target of route.targets) {
        try {
          const model = registry.findOfType("classifier", target.provider, target.model);
          if (!model || (target.backend === "openai-decisions" &&
            (model.api !== "openai-decisions" || model.baseUrl !== "https://api.openai.com/v1"))) continue;
          // This is not an entitlement/balance probe and never resolves an API key.
          if ((await registry.getProviderAuthStatus(target.provider)).configured) return true;
        } catch {
          // An unavailable optional rung must not hide another configured native target.
        }
      }
      return false;
    },
  };
}

/** Registration is optional; the executor reports unavailable native capability if it is needed. */
export async function prepareEvalRegistry(registry, registerDecisionsProvider) {
  try { await registerDecisionsProvider(registry); } catch { /* No raw provider/auth bodies on stderr. */ }
  return registry;
}

export async function main(argv = process.argv.slice(2)) {
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const { runEval } = await jiti.import("../evals/shared/runner.ts");
  const { targets } = await jiti.import("../evals/targets.ts");
  const { readSystem1Setting, resolveSystem1Route, subscribeSystem1Events, notifySystem1Notice } =
    await jiti.import("../packages/pi-system1/src/system1.ts");
  const legacyTarget = { provider: "typesafe", model: "jev-latest" };
  const selection = () => resolveSystem1Route(legacyTarget, readSystem1Setting());
  const classifier = createEvalClassifier(selection(), () => selection().key);
  let unsubscribe;
  try {
    return await runEval(argv, {
      targets,
      classifier,
      registry: async () => {
        // No extension factory, auth or model work is loaded outside live mode.
        const { installedRegistry } = await jiti.import("../evals/shared/registry.ts");
        const registry = await installedRegistry();
        await prepareEvalRegistry(registry, async (registry) => {
          const { registerDecisionsProvider } = await jiti.import("../packages/pi-system1/src/provider.ts");
          return registerDecisionsProvider(registry);
        });
        const stderrContext = { mode: "cli", stderr: (message) => console.error(message) };
        unsubscribe = subscribeSystem1Events((event) => {
          if (event.type === "notice") notifySystem1Notice(stderrContext, event.notice);
        }, registry);
        return registry;
      },
    });
  } finally {
    unsubscribe?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
