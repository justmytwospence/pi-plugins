import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Shared `~/.config/agents/<name>.json`, then `~/.pi/agent/<name>.json`, then the project's
 * `.agents/<name>.json` and `.pi/<name>.json`, each on top of the last (objects merge, other
 * values replace). Unreadable or invalid files are ignored, so a typo never breaks the session.
 * A value of the wrong type (a string where the default is a number, a scalar for an object, a
 * mixed array) is ignored too, so a malformed field keeps the lower-precedence value.
 */
export function loadConfig<T extends Record<string, unknown>>(name: string, defaults: T, cwd: string): T {
  const files = [
    path.join(sharedConfigDir(), `${name}.json`),
    path.join(agentDir(), `${name}.json`),
    path.join(cwd, ".agents", `${name}.json`),
    path.join(cwd, ".pi", `${name}.json`),
  ];
  let merged: Record<string, unknown> = structuredClone(defaults);
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (isRecord(value)) merged = merge(merged, value);
    } catch {
      // Invalid JSON: keep the defaults and earlier files.
    }
  }
  return merged as T;
}

export function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
}

/** `$XDG_CONFIG_HOME/agents` (default `~/.config/agents`): settings shared with the opencode and Claude Code ports. */
export function sharedConfigDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "agents");
}

function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    if (isRecord(current)) { if (isRecord(value)) out[key] = merge(current, value); }
    else if (Array.isArray(current)) {
      if (Array.isArray(value) && (!current.length || value.every(item => typeof item === typeof current[0]))) out[key] = value;
    } else if (current === undefined || (typeof value === typeof current && (typeof value !== "number" || Number.isFinite(value)))) out[key] = value;
  }
  return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
