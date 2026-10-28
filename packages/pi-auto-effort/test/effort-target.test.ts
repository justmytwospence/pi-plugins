import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import effort, { CASES } from "../eval/effort.target.ts";
import { last } from "../../../evals/shared/results.ts";
import { runEval } from "../../../evals/shared/runner.ts";
import { answers, fakeJev, usage } from "./harness.ts";

// The depth preset of a case that its expectation accepts (harness DEPTH: 0 low .. 3 xhigh, expected
// indexes 0.21, 1.05, 1.85, 2.63), and the go-ahead probability that matches the case's `ack`.
const judged = (request: string) => {
  const c = CASES.find((x) => x.request === request)!;
  return answers(c.depth, c.ack ? 0.95 : 0.05);
};

// A Jev that bills a tenth of a cent per call; `answer` picks the answers per request.
const priced = (answer: (request: string) => unknown) =>
  fakeJev((_questions, state) => {
    const reply = answer(String(state.request));
    if (reply && typeof reply === "object" && "stopReason" in reply) return reply;
    return { model: "jev-latest", stopReason: "stop" as const, answers: reply, usage: { ...usage(300), cost: { ...usage(300).cost, total: 0.001 } } };
  });

function run(argv: string[], registry: unknown) {
  const out: string[] = [];
  const err: string[] = [];
  const env = { EVAL_RESULTS_DIR: mkdtempSync(path.join(tmpdir(), "effort-target-")) };
  const code = runEval(argv, { targets: [effort], env, hasCredentials: true, registry: async () => registry, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  return { code, out, err, env };
}

describe("the effort eval target", () => {
  test("is registered as cases of pi-auto-effort", () => {
    expect([effort.id, effort.package, effort.kind]).toEqual(["effort", "pi-auto-effort", "cases"]);
  });

  test("plan counts one Jev request per case, without Jev", async () => {
    expect(CASES).toHaveLength(20);
    expect(await effort.plan({ sample: () => { throw new Error("cases do not sample"); }, compare: false, env: {}, log: () => undefined })).toEqual({
      calls: 20,
      notes: "20 requests, one Jev request each (carrying 2 questions)",
    });
  });

  test("a live run through the runner: every case in band, spend from the outcomes, one record, exit 0", async () => {
    const fake = priced((request) => judged(request));
    const r = run(["effort"], fake.registry);
    expect(await r.code).toBe(0);
    expect(fake.calls).toHaveLength(20);
    expect(fake.calls[0]!.questions).toHaveProperty("depth");
    const text = r.out.join("\n");
    expect(text).toContain("accuracy: 20/20 in band (100%); misses 0; Jev failures 0/20");
    expect(text).toMatch(/spend: \$0\.0200 over 20 calls/u);
    const [recorded] = last("effort", 1, r.env);
    expect(recorded).toMatchObject({ calls: 20, metrics: { cases: 20, inBand: 20, accuracy: 1 } });
  });

  test("a case out of band is a miss: reported, counted out of the accuracy, and the target fails", async () => {
    const wrong = CASES.find((c) => c.depth === 0 && !c.ack)!.request;
    const fake = priced((request) => (request === wrong ? answers(3, 0.05) : judged(request)));
    const r = run(["effort", "--json"], fake.registry);
    expect(await r.code).toBe(1);
    const result = JSON.parse(r.out.at(-1)!);
    expect(result.targets.effort).toMatchObject({ pass: false, metrics: { cases: 20, inBand: 19, accuracy: 0.95 } });
    expect(r.err.join("\n")).toContain("MISS");
  });

  test("one Jev failure is within the 20% limit; a Jev failure for most of the cases fails the target", async () => {
    const first = CASES[0]!.request;
    const one = run(["effort", "--json"], priced((request) => (request === first ? { model: "jev-latest", stopReason: "error", answers: {}, errorMessage: "boom" } : judged(request))).registry);
    expect(await one.code).toBe(0);
    expect(JSON.parse(one.out.at(-1)!).targets.effort).toMatchObject({ pass: true, failures: 1, metrics: { inBand: 19 } });

    const failing = run(["effort", "--json"], fakeJev(() => ({ model: "jev-latest", stopReason: "error" as const, answers: {}, errorMessage: "boom" })).registry);
    expect(await failing.code).toBe(1);
    expect(JSON.parse(failing.out.at(-1)!).targets.effort).toMatchObject({ pass: false, failures: 20, metrics: { inBand: 0, accuracy: 0 } });
  });
});
