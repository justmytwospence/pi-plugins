import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Child } from "../src/child.ts";

// External web-access is optional; use its real local source if installed, never download it.
const webStorage = path.join(process.env.PI_WEB_ACCESS_SOURCE ?? path.join(homedir(), ".pi/agent/npm/node_modules/pi-web-access"), "storage.ts");
afterEach(() => vi.unstubAllEnvs());
test.skipIf(!existsSync(webStorage))("real web-access state is process-local while auth and explicitly pinned effort work in RPC children", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "subagents-compat-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
  vi.stubEnv("PI_SUBAGENT_DEPTH", "0");
  vi.stubEnv("PI_WEB_ACCESS_CACHE_ROOT", cwd);
  // Dummy credential, never a real provider key, read only from this temporary directory.
  writeFileSync(path.join(cwd, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture-not-a-credential" } }));
  const storage = await import(webStorage);
  storage.clearResults();
  storage.storeResult("parent-only", { id: "parent-only", type: "search", timestamp: Date.now(), queries: [] });
  const invocation = { command: process.execPath, args: [path.join(import.meta.dirname, "fixtures/compat-pi.mjs"), webStorage, path.resolve(import.meta.dirname, "../../pi-auto-effort/src/index.ts"), path.join(import.meta.dirname, "harness.ts")] };
  try {
    for (let i = 0; i < 2; i++) {
      const child = new Child({ task: "fixture", cwd, model: "fixture/model", thinking: "low", sessionDir: cwd, invocation }).start();
      const state = await child.done;
      expect(state.status, state.error).toBe("done");
      expect(JSON.parse(state.output)).toEqual({ parentVisible: false, previousChildVisible: false, childVisible: true, authSeen: true, pinned: true, thinking: "low", classifications: 0, changes: 0, depth: "1" });
      expect(storage.getResult("parent-only")).not.toBeNull();
      expect(storage.getResult("child-only")).toBeNull();
    }
  } finally {
    storage.clearResults();
  }
}, 15_000);
