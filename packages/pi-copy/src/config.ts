import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * `~/.pi/agent/<name>.json`, then the project's `.pi/<name>.json` on top (objects merge, other
 * values replace). Unreadable or invalid files are ignored, so a typo never breaks the session.
 */
export function loadConfig<T extends Record<string, unknown>>(name: string, defaults: T, cwd: string): T {
  const files = [path.join(agentDir(), `${name}.json`), path.join(cwd, ".pi", `${name}.json`)];
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
