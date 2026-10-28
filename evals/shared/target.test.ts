import assert from "node:assert/strict";
import { test } from "node:test";
import { type EvalTarget, defineEval, needsSessions, shortPackage, validateTargets, withinFailureLimit } from "./target.ts";

const target = (id: string, over: Partial<EvalTarget> = {}): EvalTarget =>
  defineEval({ id, title: id, package: "pi-demo", kind: "cases", plan: () => ({ calls: 1, notes: "" }), run: async () => ({ metrics: {}, report: "", pass: true }), ...over });

test("defineEval is the identity", () => {
  const t = target("a");
  assert.equal(defineEval(t), t);
});

test("needsSessions defaults to replay and can be overridden", () => {
  assert.equal(needsSessions({ kind: "replay" }), true);
  assert.equal(needsSessions({ kind: "cases" }), false);
  assert.equal(needsSessions({ kind: "replay", needsSessions: false }), false);
});

test("withinFailureLimit is a strict 20% limit and passes with no calls", () => {
  assert.equal(withinFailureLimit(0, 0), true);
  assert.equal(withinFailureLimit(1, 6), true);
  assert.equal(withinFailureLimit(1, 5), false);
  assert.equal(withinFailureLimit(2, 5, 0.5), true);
});

test("shortPackage drops the pi- prefix", () => {
  assert.equal(shortPackage("pi-auto-effort"), "auto-effort");
  assert.equal(shortPackage("auto-effort"), "auto-effort");
});

test("validateTargets accepts a good list and rejects bad ids, repeats and package names", () => {
  validateTargets([target("a"), target("b-c")]);
  assert.throws(() => validateTargets([target("Bad_Id")]), /kebab-case/u);
  assert.throws(() => validateTargets([target("a"), target("a")]), /duplicate/u);
  assert.throws(() => validateTargets([target("demo")]), /package name/u);
  assert.throws(() => validateTargets([target("pi-demo")]), /package name/u);
  assert.throws(() => validateTargets([target("all")]), /reserved/u);
  assert.throws(() => validateTargets([target("a", { kind: "other" as never })]), /kind/u);
  assert.throws(() => validateTargets([target("a", { run: undefined as never })]), /plan\(\) and run\(\)/u);
});
