import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { DEFAULT_SETTINGS, NAME, type Settings, mergeSettings } from "./core.ts";
import { effortUpdatesConfig } from "./effort-updates.ts";

/**
 * Shared `~/.config/agents/cache-guard.json`, then `~/.pi/agent/cache-guard.json`, then the
 * project's `.agents/cache-guard.json` and `.pi/cache-guard.json`, each on top of the last (objects
 * merge, other values replace). Unreadable or invalid files are ignored.
 */
export function loadSettings(cwd: string): Settings {
  const scopes = [sharedConfigDir(), agentDir(), path.join(cwd, ".agents"), path.join(cwd, ".pi")];
  const texts: Array<string | undefined> = [];
  for (const scope of scopes) {
    try {
      const legacy: unknown = JSON.parse(readFileSync(path.join(scope, "auto-effort.json"), "utf8"));
      if (isRecord(legacy)) texts.push(JSON.stringify({ effortUpdates: legacy.effortUpdates }));
    } catch {
      // Missing, unreadable or malformed legacy settings do not affect this scope.
    }
    try {
      texts.push(readFileSync(path.join(scope, `${NAME}.json`), "utf8"));
    } catch {
      // Missing or unreadable settings leave earlier layers intact.
    }
  }
  let settings = structuredClone(DEFAULT_SETTINGS);
  for (const text of texts) {
    if (text === undefined) continue;
    try {
      const value: unknown = JSON.parse(text);
      if (!isRecord(value)) continue;
      const updates = effortUpdatesConfig(value.effortUpdates, settings.effortUpdates);
      settings = mergeSettings(settings, [text]);
      settings.effortUpdates = updates;
    } catch {
      // Invalid JSON leaves earlier layers intact.
    }
  }
  return settings;
}

/** `~/.pi/agent/cache-guard.json`: the Pi-only user file, which `/cache-guard jev` writes. */
export function userSettingsFile() {
  return path.join(agentDir(), `${NAME}.json`);
}

/**
 * Merge `patch` into the Pi-only user settings file (objects merge, other values replace). Throws
 * when the file exists but is not a JSON object, rather than overwrite it.
 */
export function saveUserSettings(patch: Record<string, unknown>): string {
  const file = userSettingsFile();
  let current: Record<string, unknown> = {};
  if (existsSync(file)) {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(value)) throw new Error(`${file} is not a JSON object`);
    current = value;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(merge(current, patch), null, 2)}\n`);
  return file;
}

export function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
}

/** `$XDG_CONFIG_HOME/agents` (default `~/.config/agents`): settings shared with the other ports. */
export function sharedConfigDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "agents");
}

function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? merge(current, value) : value;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
