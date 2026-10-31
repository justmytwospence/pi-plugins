import { expect, test, vi } from "vitest";
import subagents from "../src/index.ts";
import { harness } from "./harness.ts";
import { SUBAGENT_ENV_CHANNEL, answerSubagentEnvProbes, requestSubagentEnv, type SubagentEnvRequest } from "../src/child.ts";

function bus() {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  return {
    on(channel: string, handler: (data: unknown) => void) {
      listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
    },
    emit(channel: string, data: unknown) {
      for (const handler of listeners.get(channel) ?? []) handler(data);
    },
  };
}

test("listeners add environment for the next child; bad names and values are dropped", () => {
  const events = bus();
  events.on(SUBAGENT_ENV_CHANNEL, (data) => {
    const request = data as SubagentEnvRequest;
    if (request.probe) return;
    request.env.PI_SIDEBAR_GUARD = "1";
    request.env["bad name"] = "x";
    (request.env as Record<string, unknown>).NUMBER = 1;
  });
  expect(requestSubagentEnv(events)).toEqual({ PI_SIDEBAR_GUARD: "1" });
  expect(requestSubagentEnv(undefined)).toEqual({});
});

test("the propagation probe remains available at max depth without registering delegation", () => {
  vi.stubEnv("PI_SUBAGENT_DEPTH", "999");
  try {
    const h = harness();
    const events = bus();
    h.pi.events = events;
    const register = vi.spyOn(h.pi, "registerTool");
    subagents(h.pi);
    const probe: SubagentEnvRequest = { version: 1, env: {}, probe: true };
    events.emit(SUBAGENT_ENV_CHANNEL, probe);
    expect(probe.supported).toBe(true);
    expect(register).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});

test("a probe learns that subagents get the requested environment", () => {
  const events = bus();
  answerSubagentEnvProbes(events);
  const probe: SubagentEnvRequest = { version: 1, env: {}, probe: true };
  events.emit(SUBAGENT_ENV_CHANNEL, probe);
  expect(probe.supported).toBe(true);
  expect(requestSubagentEnv(events)).toEqual({});
});
