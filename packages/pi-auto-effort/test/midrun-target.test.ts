import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import midrun, { CASES } from "../eval/midrun.target.ts";
import { last } from "../../../evals/shared/results.ts";
import { runEval } from "../../../evals/shared/runner.ts";
import { answers, fakeJev, usage } from "./harness.ts";

// The depth preset that lands in a stretch's band: its top level (harness DEPTH 1 expects 1.05 for
// [0, 1]; DEPTH 3 expects 2.63 for [2, 3]), with the band widened by half a level each side.
const judged = (request: string) => {
  const c = CASES.find((x) => x.request === request)!;
  return answers(c.max, 0.05);
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
  const env = { EVAL_RESULTS_DIR: mkdtempSync(path.join(tmpdir(), "midrun-target-")) };
  const code = runEval(argv, { targets: [midrun], env, hasCredentials: true, registry: async () => registry, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  return { code, out, err, env };
}

describe("the midrun eval target", () => {
  test("is registered as cases of pi-auto-effort", () => {
    expect([midrun.id, midrun.package, midrun.kind]).toEqual(["midrun", "pi-auto-effort", "cases"]);
  });

  test("plan counts one Jev request per stretch, without Jev", async () => {
    expect(CASES).toHaveLength(4);
    expect(await midrun.plan({ sample: () => { throw new Error("cases do not sample"); }, compare: false, env: {}, log: () => undefined })).toEqual({
      calls: 4,
      notes: "4 stretches, one Jev request each (carrying 1 question)",
    });
  });

  test("a live run through the runner: every stretch in band, spend from the outcomes, one record, exit 0", async () => {
    const fake = priced((request) => judged(request));
    const r = run(["midrun"], fake.registry);
    expect(await r.code).toBe(0);
    expect(fake.calls).toHaveLength(4);
    const text = r.out.join("\n");
    expect(text).toContain("accuracy: 4/4 in band (100%); misses 0; Jev failures 0/4");
    expect(text).toMatch(/spend: \$0\.0040 over 4 calls/u);
    const [recorded] = last("midrun", 1, r.env);
    expect(recorded).toMatchObject({ calls: 4, metrics: { cases: 4, inBand: 4, accuracy: 1 } });
  });

  test("a stretch out of band is a miss, and the target fails", async () => {
    const wrong = CASES[2]!.request;
    const fake = priced((request) => (request === wrong ? answers(0, 0.05) : judged(request)));
    const r = run(["midrun", "--json"], fake.registry);
    expect(await r.code).toBe(1);
    const result = JSON.parse(r.out.at(-1)!);
    expect(result.targets.midrun).toMatchObject({ pass: false, metrics: { cases: 4, inBand: 3, accuracy: 0.75 } });
    expect(r.err.join("\n")).toContain("MISS");
  });

  test("a Jev failure counts toward the 20% limit: with four stretches, one failure (25%) fails the target", async () => {
    const first = CASES[0]!.request;
    const fake = priced((request) => (request === first ? { model: "jev-latest", stopReason: "error", answers: {}, errorMessage: "boom" } : judged(request)));
    const r = run(["midrun", "--json"], fake.registry);
    expect(await r.code).toBe(1);
    expect(JSON.parse(r.out.at(-1)!).targets.midrun).toMatchObject({ pass: false, failures: 1, metrics: { inBand: 3 } });
  });
});
