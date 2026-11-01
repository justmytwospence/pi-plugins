import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piSidebar from "../src/index.ts";
import { installEnvironmentObserver } from "../src/family/observer.ts";
import { OBSERVER_ENV } from "../src/family/protocol.ts";
import { GUARD_ENV } from "../src/guard.ts";
import { FakePi, fakeCtx } from "./fake.ts";

// Enrollment transport is unrelated to the factory's guard-only notification wiring.
vi.mock("../src/family/observer.ts", async (original) => ({
  ...await original<typeof import("../src/family/observer.ts")>(),
  installEnvironmentObserver: vi.fn(),
}));

let agentDir: string;
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "sidebar-guard-notifications-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv(GUARD_ENV, "1");
  writeFileSync(join(agentDir, "system1.json"), JSON.stringify({ waterfall: ["jev", "openai-decisions"] }));
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
});

describe("guard-only System 1 notifications", () => {
  it.each([
    { observer: false, exhausted: false },
    { observer: true, exhausted: false },
    { observer: false, exhausted: true },
    { observer: true, exhausted: true },
  ])("binds before early returns (observer: $observer, exhausted: $exhausted)", async ({ observer, exhausted }) => {
    vi.stubEnv(OBSERVER_ENV, observer ? "test-enrollment" : "");
    const pi = new FakePi();
    piSidebar(pi as never);
    expect(installEnvironmentObserver).toHaveBeenCalledTimes(observer ? 1 : 0);
    expect(pi.commands.size).toBe(0);
    expect(pi.shortcuts.size).toBe(0);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);

    const { ctx: base, notes } = fakeCtx();
    const registry = {
      findOfType: (_type: string, provider: string, id: string) => ({
        provider, id, api: provider === "system1-openai" ? "openai-decisions" : "typesafe",
        baseUrl: "https://api.openai.com/v1",
      }),
      classify: vi.fn(async (model: { provider: string }) => {
        if (model.provider === "typesafe") return { answers: {}, stopReason: "error", errorMessage: "quota exhausted" };
        // The failure must be visible before attempting the fallback, not merely after it.
        expect(notes).toEqual([{ message: "System 1: Jev unavailable (quota or credits exhausted); trying OpenAI Decisions.", level: "warning" }]);
        return exhausted
          ? { answers: {}, stopReason: "error", errorMessage: "no API key" }
          : { answers: { q: { type: "bool", probability: 0.01 } }, stopReason: "stop" };
      }),
    };
    const ctx = { ...base, modelRegistry: registry };
    await pi.emit("session_start", {}, ctx);
    try {
      expect(registry.classify).not.toHaveBeenCalled();
      const result = await pi.emit("tool_call", { toolName: "mcp__unknown__call", input: {} }, ctx);
      if (exhausted) {
        expect(result).toEqual({ block: true, reason: expect.stringMatching(/could not be confirmed/) });
        expect(notes).toHaveLength(2);
        expect(notes[1]).toMatchObject({ message: expect.stringMatching(/no configured providers remain/), level: "warning" });
      } else {
        expect(result).toBeUndefined();
        expect(notes).toHaveLength(1);
      }
      expect(registry.classify).toHaveBeenCalledTimes(2);
      expect(pi.entries.some((entry) => entry.customType === "system1:decision")).toBe(true);
      expect(pi.entries.some((entry) => entry.customType === "custom_message")).toBe(false);
    } finally {
      await pi.emit("session_shutdown", { reason: "quit" }, ctx);
    }
  });
});
