import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, test, vi } from "vitest";
import planMode from "../src/index.js";
import plan from "../src/plan.js";
import { MCP_ALLOW_ENV } from "../src/planners.js";
import { installScoutGuard } from "../src/scout-guard.js";
import { installSystem1Notifications } from "../src/system1.js";

vi.mock("../src/plan.js", () => ({ default: vi.fn(async () => undefined) }));
vi.mock("../src/scout-guard.js", () => ({ installScoutGuard: vi.fn() }));
vi.mock("../src/system1.js", () => ({ installSystem1Notifications: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test("the normal factory installs standalone System 1 notifications before initializing Plan mode", async () => {
  vi.stubEnv(MCP_ALLOW_ENV, undefined);
  const pi = {} as ExtensionAPI;
  const dependencies = { readSettings: async () => ({ thinkingLevel: "inherit" as const }) };
  await planMode(pi, dependencies);
  assert.equal(vi.mocked(installSystem1Notifications).mock.calls.length, 1);
  assert.deepEqual(vi.mocked(installSystem1Notifications).mock.calls[0], [pi]);
  assert.deepEqual(vi.mocked(plan).mock.calls[0], [pi, dependencies]);
  assert.ok(
    vi.mocked(installSystem1Notifications).mock.invocationCallOrder[0] < vi.mocked(plan).mock.invocationCallOrder[0],
  );
  assert.equal(vi.mocked(installScoutGuard).mock.calls.length, 0);
});

test("guard-only scouts bind notifications without initializing the planning UI", async () => {
  vi.stubEnv(MCP_ALLOW_ENV, JSON.stringify(["docs/*"]));
  const pi = {} as ExtensionAPI;
  await planMode(pi);
  assert.equal(vi.mocked(installSystem1Notifications).mock.calls.length, 1);
  assert.deepEqual(vi.mocked(installSystem1Notifications).mock.calls[0], [pi]);
  assert.deepEqual(vi.mocked(installScoutGuard).mock.calls[0], [pi, ["docs/*"]]);
  assert.ok(
    vi.mocked(installSystem1Notifications).mock.invocationCallOrder[0] <
      vi.mocked(installScoutGuard).mock.invocationCallOrder[0],
  );
  assert.equal(vi.mocked(plan).mock.calls.length, 0);
});
