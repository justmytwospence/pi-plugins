import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { loadSettings } from "../src/config.ts";
import { DEFAULT_SETTINGS } from "../src/core.ts";

test("legacy and cache-guard settings overlay in scope order, sanitizing effort fields", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cache-migration-"));
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldXdg = process.env.XDG_CONFIG_HOME;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  const cwd = path.join(root, "project");
  const scopes = [path.join(root, "config", "agents"), path.join(root, "agent"), path.join(cwd, ".agents"), path.join(cwd, ".pi")];
  const put = (scope: number, file: string, data: unknown) => {
    mkdirSync(scopes[scope], { recursive: true });
    writeFileSync(path.join(scopes[scope], file), JSON.stringify(data));
  };
  try {
    put(0, "auto-effort.json", { enabled: false, warn: { minCost: 99 }, effortUpdates: { enabled: false, models: ["a/*"] } });
    put(0, "cache-guard.json", { effortUpdates: { enabled: true } });
    put(1, "auto-effort.json", { effortUpdates: { models: ["b/*", 1] } });
    put(1, "cache-guard.json", { effortUpdates: { enabled: "bad", models: null }, warn: { minCost: 2 } });
    put(2, "auto-effort.json", { effortUpdates: { enabled: false } });
    put(2, "cache-guard.json", { effortUpdates: { models: [] } });
    put(3, "auto-effort.json", { effortUpdates: { models: "bad" } });
    put(3, "cache-guard.json", { effortUpdates: { enabled: null } });
    const settings = loadSettings(cwd);
    expect(settings.effortUpdates).toEqual({ enabled: false, models: [] });
    expect(settings.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(settings.warn.minCost).toBe(2);
  } finally {
    process.env.PI_CODING_AGENT_DIR = oldAgent;
    process.env.XDG_CONFIG_HOME = oldXdg;
    rmSync(root, { recursive: true, force: true });
  }
});
