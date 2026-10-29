import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { BUILTIN_AGENTS } from "../src/agents.ts";
import subagents, { DEFAULT_CONFIG, ROLE_MODEL, type RoleModelRequest, roleModel } from "../src/index.ts";
import { harness } from "./harness.ts";
import { fakeUI } from "./ui-helpers.ts";

afterEach(() => vi.unstubAllEnvs());

const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", reasoning: true };
const opus = { provider: "anthropic", id: "claude-opus-5-5", reasoning: true };

test("roleModel gives the role's profile on the parent's provider", () => {
  const request = { role: "worker", parent: "anthropic/claude-opus-5-5", thinking: "xhigh" };
  expect(roleModel(request, BUILTIN_AGENTS, DEFAULT_CONFIG, [sonnet, opus], "low")).toEqual({ model: "anthropic/claude-sonnet-5-5", thinking: "medium", source: "profile" });
});

test("roleModel falls back to the balanced tier", () => {
  const config = { ...DEFAULT_CONFIG, providerTiers: { p: { balanced: "p/mid" } } };
  expect(roleModel({ role: "worker", parent: "p/big", thinking: "high" }, BUILTIN_AGENTS, config, [], "low")).toEqual({ model: "p/mid", thinking: "high", source: "tier" });
});

test("roleModel falls back to the parent's model and the fallback effort", () => {
  expect(roleModel({ role: "worker", parent: "q/x" }, BUILTIN_AGENTS, DEFAULT_CONFIG, [], "low")).toEqual({ model: "q/x", thinking: "low", source: "default" });
});

test("roleModel ignores requests it cannot answer", () => {
  const ask = (data: unknown) => roleModel(data, BUILTIN_AGENTS, DEFAULT_CONFIG, [], "low");
  expect(ask({ role: "nobody", parent: "q/x" })).toBeUndefined();
  expect(ask({ role: "worker", parent: "noslash" })).toBeUndefined();
  expect(ask({ role: "worker", parent: "q/x", reply: { model: "a/b", thinking: "low", source: "default" } })).toBeUndefined();
  expect(ask(null)).toBeUndefined();
});

test("the bus answers only while a session is live", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-role-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  const h = harness();
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  (h.pi.events as any).on = (channel: string, handler: (data: unknown) => void) => {
    listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
    return () => undefined;
  };
  subagents(h.pi);
  const ask = (): RoleModelRequest => {
    const request: RoleModelRequest = { role: "worker", parent: "anthropic/claude-opus-5-5", thinking: "xhigh" };
    for (const handler of listeners.get(ROLE_MODEL) ?? []) handler(request);
    return request;
  };
  expect(ask().reply).toBeUndefined();
  const ctx = h.ctx({ cwd: dir, ui: fakeUI(), modelRegistry: { getAll: () => [sonnet, opus], find: () => undefined } });
  await h.emit("session_start", { type: "session_start" }, ctx);
  expect(ask().reply).toEqual({ model: "anthropic/claude-sonnet-5-5", thinking: "medium", source: "profile" });
  await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  expect(ask().reply).toBeUndefined();
});
