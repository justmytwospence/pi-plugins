import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import plan, { type PlanDependencies } from "./plan.ts";
import { mcpAllowFromEnv } from "./planners.ts";
import { installScoutGuard } from "./scout-guard.ts";
import { installSystem1Notifications } from "./system1.ts";

export default async function planMode(pi: ExtensionAPI, dependencies: PlanDependencies = {}): Promise<void> {
  installSystem1Notifications(pi);
  // Scouts load this package only to enforce their MCP allowlist.
  const scoutAllow = mcpAllowFromEnv();
  if (scoutAllow) {
    installScoutGuard(pi, scoutAllow);
    return;
  }
  await plan(pi, dependencies);
}
