import { expect, test } from "vitest";
import { modelAndEffort, modelSourceMark } from "../src/ui/format.ts";
import { fakeRun, plain } from "./ui-helpers.ts";

test("only an inherited parent model has a warning-colored compact provenance mark", () => {
  const warning = { ...plain, fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
  expect(modelSourceMark({ model: "default" }, warning)).toBe("<warning> (parent)</warning>");
  for (const source of [undefined, { model: "profile" }, { model: "tier" }, { model: "explicit" }, {}]) expect(modelSourceMark(source, warning)).toBe("");
});

test("model metadata shows parent marker after auto mark, without mislabeling deliberate Astra premium", () => {
  const common = { model: "openai/gpt-6-astra", thinking: "low", byJev: { agent: false, model: true, thinking: true } };
  const fallback = fakeRun({ ...common, source: { model: "default", thinking: "jev" }, byJev: { ...common.byJev, model: false } });
  expect(modelAndEffort(fallback, plain)).toBe("gpt-6-astra (parent) · low (auto)");
  expect(modelAndEffort(fallback, plain, true)).toBe("openai/gpt-6-astra (parent) · low (auto)");
  const deliberate = fakeRun({ ...common, source: { model: "tier", thinking: "jev" }, tier: "premium" });
  expect(modelAndEffort(deliberate, plain)).toBe("gpt-6-astra (auto) · low (auto)");
  for (const source of [undefined, { model: "profile", thinking: "profile" }, { model: "explicit", thinking: "explicit" }] as const) {
    expect(modelAndEffort(fakeRun({ ...common, source }), plain)).not.toContain("(parent)");
  }
});
