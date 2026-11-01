#!/usr/bin/env node
// `npm run -s eval -- [<id|package|all>...] [--package <pkg>] [--dry | --list | --last] [--json]`: the one
// command for every eval target (evals/targets.ts). All of the behavior is in evals/shared/runner.ts; this
// file loads TypeScript and injects the global classifier selection and live-only bootstrap.
// Selection reads are local configuration only; dry/list/last never construct a registry or inspect auth.
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { runEval } = await jiti.import("../evals/shared/runner.ts");
const { targets } = await jiti.import("../evals/targets.ts");
const { readSystem1Setting, resolveSystem1Target } = await jiti.import("../packages/pi-system1/src/system1.ts");
const legacyTarget = { provider: "typesafe", model: "jev-latest" };
const selection = () => resolveSystem1Target(legacyTarget, readSystem1Setting());
const target = selection();
const classifier = {
  backend: target.ok ? target.backend : "unavailable",
  provider: target.ok ? target.provider : "unavailable",
  model: target.ok ? target.model : "unavailable",
  key: target.key,
  ...(!target.ok ? { reason: target.reason } : {}),
  currentKey: () => selection().key,
  async configured(registry) {
    if (!target.ok) return false;
    const model = registry.findOfType("classifier", target.provider, target.model);
    if (!model || (target.backend === "openai-decisions" && model.api !== "openai-decisions")) return false;
    // Local configured state only, not a probe or entitlement/billing check. Never resolves a key.
    return registry.getProviderAuthStatus(target.provider).configured;
  },
};
process.exitCode = await runEval(process.argv.slice(2), {
  targets,
  classifier,
  registry: async () => {
    // Provider registration is deliberately live-only. Import the pure factory, not the extension.
    const { installedRegistry } = await jiti.import("../evals/shared/registry.ts");
    const registry = await installedRegistry();
    const { registerDecisionsProvider } = await jiti.import("../packages/pi-system1/src/provider.ts");
    await registerDecisionsProvider(registry);
    return registry;
  },
});
