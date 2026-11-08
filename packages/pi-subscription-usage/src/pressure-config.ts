import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_LIMITS, limitsPolicy, type LimitsPolicy } from "./quota-pressure.ts";

/** Overlay legacy and current quota settings, from global to project scope. */
export function loadPressurePolicy(cwd: string): LimitsPolicy {
  const scopes = [path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "agents"),
    process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"),
    path.join(cwd, ".agents"), path.join(cwd, ".pi")];
  let policy = limitsPolicy(DEFAULT_LIMITS);
  for (const scope of scopes) for (const file of ["auto-effort.json", "quota-pressure.json"]) {
    try {
      const value: unknown = JSON.parse(readFileSync(path.join(scope, file), "utf8"));
      const limits = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).limits : undefined;
      policy = limitsPolicy(limits, policy);
    } catch { /* Missing or invalid layers do not override prior settings. */ }
  }
  return policy;
}
