import { expect, test } from "vitest";
import { askJev } from "../src/jev.ts";

const config = { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 10 };
const ok = { model: "jev-latest", answers: { q: { type: "bool", probability: 0.9 } }, stopReason: "stop" } as const;
const timedOut = { model: "jev-latest", answers: {}, stopReason: "error", errorMessage: "Request timed out after 10ms" } as const;

function registry(results: unknown[]) {
  const calls: unknown[] = [];
  return {
    calls,
    findOfType: () => ({ provider: "typesafe", id: "jev-latest" }),
    classify: async (_model: never, _context: unknown, options: unknown) => {
      calls.push(options);
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("askJev retries a timed-out request once", async () => {
  const reg = registry([timedOut, ok]);
  const outcome = await askJev(reg, config, {}, {});
  expect(outcome).toMatchObject({ ok: true, answers: ok.answers });
  expect(reg.calls).toEqual([{ timeoutMs: 10 }, { timeoutMs: 10 }]);
});

test("askJev gives up after the retry also times out", async () => {
  const reg = registry([timedOut, new Error("Request timed out after 10ms")]);
  expect(await askJev(reg, config, {}, {})).toEqual({ ok: false, reason: "timed out" });
  expect(reg.calls).toHaveLength(2);
});

test("askJev does not retry other errors or a cancelled request", async () => {
  const failing = registry([{ ...timedOut, errorMessage: "System One API error (400)" }]);
  expect(await askJev(failing, config, {}, {})).toMatchObject({ ok: false });
  expect(failing.calls).toHaveLength(1);

  const controller = new AbortController();
  controller.abort();
  const cancelled = registry([timedOut, ok]);
  expect(await askJev(cancelled, config, {}, {}, controller.signal)).toEqual({ ok: false, reason: "timed out" });
  expect(cancelled.calls).toHaveLength(1);
});
