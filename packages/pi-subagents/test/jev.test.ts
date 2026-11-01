import "./isolated-agent-dir.ts";
import { describe, expect, test } from "vitest";
import { askJev, type ClassifierRegistry, type ClassifierResult, type JevConfig } from "../src/jev.ts";
import { askSystem1 } from "../src/system1.ts";

const config: JevConfig = { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 100 };
const success: ClassifierResult = { model: "jev-latest", stopReason: "stop", answers: { test: { type: "bool", probability: 0.8 } } };
const timeout: ClassifierResult = { model: "jev-latest", stopReason: "error", errorMessage: "timed out", answers: {} };

function fakeRegistry(respond: (attempt: number) => ClassifierResult | Promise<ClassifierResult>) {
  let calls = 0;
  const registry: ClassifierRegistry = {
    findOfType: () => ({}),
    classify: async (_model, _context, options) => {
      expect(options?.retries).toBe(0);
      return respond(++calls);
    },
  };
  return { registry, calls: () => calls };
}

const ask = (registry: ClassifierRegistry, signal?: AbortSignal, options?: { retryTimeout?: boolean }) =>
  askJev(registry, config, { task: "test" }, { test: { type: "bool", instructions: "Is the task specified?", criteria: { true: "Yes", false: "No" } } }, signal, options);

describe("askJev timeout retry policy", () => {
  test("the historical function name is the shared transport compatibility alias", () => {
    expect(askJev).toBe(askSystem1);
  });
  test("retries a timed-out attempt once by default", async () => {
    const fake = fakeRegistry((n) => n === 1 ? timeout : success);
    expect(await ask(fake.registry)).toMatchObject({ ok: true, model: "jev-latest" });
    expect(fake.calls()).toBe(2);
  });

  test("does not retry a timeout when the evaluation disables retries", async () => {
    const fake = fakeRegistry(() => timeout);
    expect(await ask(fake.registry, undefined, { retryTimeout: false })).toMatchObject({ ok: false, code: "exhausted", reason: "Jev: timed out", attempts: [{ status: "failed", code: "timeout", sdkCalls: 1 }] });
    expect(fake.calls()).toBe(1);
  });

  test("never retries a successful call", async () => {
    const fake = fakeRegistry(() => success);
    expect((await ask(fake.registry)).ok).toBe(true);
    expect(fake.calls()).toBe(1);
  });

  test("an abort during the timeout prevents the default retry", async () => {
    const controller = new AbortController();
    const fake = fakeRegistry(() => { controller.abort(); return timeout; });
    expect(await ask(fake.registry, controller.signal)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(fake.calls()).toBe(1);
  });
});
