import { describe, expect, it } from "vitest";
import adapter from "../src/switchyard/adapter.ts";

const V2 = { features: ["tool.views.v1", "ui.nodes.v2", "adapter.trackers.v1", "interaction.kinds.v1"] };
const args = { state: {}, questions: { only_reads: {}, risky: {} } };

describe("system1 Switchyard tool views", () => {
  it("a judgment is one row naming its questions, opening to the answers", () => {
    expect(adapter.toolView({ toolCallId: "1", name: "system1_judge", args }, V2)).toEqual({
      kind: "other", verb: "Judged", activeVerb: "Judging", target: "only_reads, risky", meta: [],
    });
    const details = {
      ok: true, backend: "jev", provider: "typesafe", model: "jev-1", latencyMs: 812,
      answers: { only_reads: { type: "bool", probability: 0.973 }, risky: { type: "choice", choice: "no", probabilities: {}, confidence: 1 } },
    };
    expect(adapter.toolView({ toolCallId: "1", name: "system1_judge", args, result: {}, details }, V2)).toEqual({
      kind: "other", verb: "Judged", activeVerb: "Judging", target: "only_reads, risky", meta: ["jev", "0.8s"],
      detail: { t: "facts", items: [{ label: "only_reads", value: "0.97", mono: true }, { label: "risky", value: "no", mono: true }] },
    });
    expect(adapter.toolView({ toolCallId: "1", name: "system1_judge", args, result: {}, details }, {})).toMatchObject({
      detail: { t: "table", rows: [["only_reads", "0.97"], ["risky", "no"]] },
    });
  });

  it("a failure says so with its reason", () => {
    expect(adapter.toolView({ toolCallId: "1", name: "system1_judge", args, result: {}, details: { ok: false, code: "x", reason: "no key", latencyMs: 5 } }, V2)).toMatchObject({
      meta: ["failed", "0.0s"], detail: { t: "text", text: "no key", tone: "danger" },
    });
    expect(adapter.toolView({ toolCallId: "1", name: "read", args: {} }, V2)).toBeUndefined();
  });
});
