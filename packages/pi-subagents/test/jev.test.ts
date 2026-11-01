import { describe, expect, test } from "vitest";
import { askJev, type ClassifierRegistry, type ClassifierResult, type JevConfig } from "../src/jev.ts";

const config: JevConfig = { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 100 };
const success: ClassifierResult = { model: "jev-latest", stopReason: "stop", answers: {} };
const timeout: ClassifierResult = { model: "jev-latest", stopReason: "error", errorMessage: "timed out", answers: {} };

function fakeRegistry(respond: (attempt: number) => ClassifierResult | Promise<ClassifierResult>) {
  let calls = 0;
  const registry: ClassifierRegistry = {
    findOfType: () => ({}),
    classify: async () => respond(++calls),
  };
  return { registry, calls: () => calls };
}

const ask = (registry: ClassifierRegistry, signal?: AbortSignal, options?: { retryTimeout?: boolean }) =>
  askJev(registry, config, { task: "test" }, {}, signal, options);

describe("askJev timeout retry policy", () => {
  test("retries a timed-out attempt once by default", async () => {
    const fake = fakeRegistry((n) => n === 1 ? timeout : success);
    expect(await ask(fake.registry)).toMatchObject({ ok: true, model: "jev-latest" });
    expect(fake.calls()).toBe(2);
  });

  test("does not retry a timeout when the evaluation disables retries", async () => {
    const fake = fakeRegistry(() => timeout);
    expect(await ask(fake.registry, undefined, { retryTimeout: false })).toEqual({ ok: false, reason: "timed out" });
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
    expect(await ask(fake.registry, controller.signal)).toEqual({ ok: false, reason: "timed out" });
    expect(fake.calls()).toBe(1);
  });
});
