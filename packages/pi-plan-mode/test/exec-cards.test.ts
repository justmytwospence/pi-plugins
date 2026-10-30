import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
  type AskDetails,
  ExecCardRefresh,
  type FinishDetails,
  finishTone,
  renderAsk,
  renderFinish,
} from "../src/exec-cards.js";
import { planDiff } from "../src/plan-diff.js";

initTheme("dark");
const theme = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
} as never;
const options = { expanded: false, isPartial: false };
const finding = {
  id: "F1",
  title: "Readiness handshake",
  detail: "Wait for readiness before beginning the operation.",
  requestedChange: "Add the readiness handshake and test it.",
};
const decision = {
  outcome: "changes_requested" as const,
  summary: "The readiness handshake is missing.",
  evidence: ["Inspected src/session.ts"],
  limitations: ["Human input has not been tested."],
  findings: [finding],
};
const base: FinishDetails = {
  report: "Implemented the approved work.",
  verification: "npm test passed (implementer reported).",
  concerns: "Human input remains untested.",
  planFile: "/plans/calm-river.md",
  implementer: "Terra",
  executionId: "exec",
  exchangeId: "review1",
  round: 1,
  decision,
  asks: 0,
  costUsd: 0,
};
function plain(lines: string[]) {
  return stripVTControlCharacters(lines.join("\n"));
}

for (const width of [46, 120]) {
  test(`review and final states wrap at ${width} columns without a second shell`, () => {
    const states: FinishDetails[] = [
      { ...base, pending: true, activity: "reading files" },
      base,
      {
        ...base,
        decision: {
          ...decision,
          outcome: "user_needed",
          question: "Can you test human input?",
          recommendation: "Run the interactive test.",
        },
      },
      { ...base, decision: undefined, error: "Planner timed out", action: "/plan-exec retry" },
      {
        ...base,
        decision: { ...decision, outcome: "accepted", findings: [], summary: "The approved plan is satisfied." },
        completion: "accepted",
      },
      { ...base, decision: undefined, completion: "no_review" },
      { ...base, completion: "user_override" },
      { ...base, completion: "stopped" },
    ];
    for (const state of states) {
      const lines = renderFinish(state, options, theme, () => state).render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      const text = plain(lines);
      assert.ok(!text.includes("Finished"));
      assert.ok(!text.includes("─"));
      if (state.decision?.question) assert.ok(text.includes("Can you test human input?"));
      if (state.error) assert.ok(text.includes("Review unavailable"));
    }
  });
  test(`consultations show real decisions, errors and expanded amendments at ${width}`, () => {
    const details: AskDetails = {
      question: "How should the handshake work?",
      reply: "Wait for readiness.\n\nKeep the transport unchanged.",
      planner: "Astra",
      number: 2,
      changes: planDiff("# Old", "# New"),
      costUsd: 0.12,
    };
    const short = plain(renderAsk(details, options, theme).render(width));
    assert.ok(short.includes("Consultation 2"));
    assert.ok(short.includes("Wait for readiness."));
    assert.ok(!short.includes("Keep the transport unchanged."));
    assert.ok(!short.includes("Plan amendment"));
    const expanded = plain(renderAsk(details, { ...options, expanded: true }, theme).render(width));
    assert.ok(expanded.includes("Plan amendment"));
    assert.ok(expanded.includes("Keep the transport unchanged."));
    assert.ok(
      plain(renderAsk({ ...details, pending: true }, options, theme).render(width)).includes("Planner thinking…"),
    );
    assert.ok(
      plain(renderAsk({ ...details, reply: "", error: "Cancelled" }, options, theme).render(width)).includes(
        "Cancelled",
      ),
    );
  });
}

test("mounted exchanges fold at render time and never mutate historical details", () => {
  let current = { executionId: "exec", exchangeId: "review1" };
  const details: FinishDetails = {
    ...base,
    report: Array.from({ length: 25 }, (_, i) => `Report line ${i}`).join("\n\n"),
    previousFindings: [finding],
    responses: [{ id: "F1", status: "addressed", response: "Added a readiness test." }],
  };
  const before = JSON.stringify(details);
  const mounted = renderFinish(details, options, theme, () => current);
  assert.ok(plain(mounted.render(120)).includes("Report line 24"));
  current = { executionId: "exec", exchangeId: "review2" };
  const old = plain(mounted.render(120));
  assert.ok(!old.includes("Report line 24"));
  assert.ok(old.includes("ctrl+o to expand"));
  assert.ok(old.includes("Readiness handshake"));
  assert.ok(old.includes("Added a readiness test."));
  assert.equal(JSON.stringify(details), before);
  assert.ok(
    plain(renderFinish(details, { ...options, expanded: true }, theme, () => current).render(120)).includes(
      "Report line 24",
    ),
  );
});

test("latest unresolved review exposes the exact question and requested findings", () => {
  const details = {
    ...base,
    decision: {
      ...decision,
      outcome: "user_needed" as const,
      question: "Does the human input test pass?",
      recommendation: "Test with a real user.",
    },
  };
  const text = plain(renderFinish(details, options, theme, () => details).render(46));
  assert.ok(text.includes("Add the readiness handshake"));
  assert.ok(text.includes("Does the human input test pass?"));
});

test("confirmed override is amber even when the preceding review failed", () => {
  assert.equal(finishTone({ ...base, error: "Timed out", completion: "user_override" }), "warning");
  assert.equal(finishTone({ ...base, decision: undefined, error: "Timed out" }), "error");
  assert.equal(finishTone({ ...base, completion: "no_review" }), "warning");
  assert.equal(finishTone({ ...base, completion: "accepted" }), "success");
});

test("zero-row card refresh proxy requests frames and disposes on end", () => {
  let renders = 0;
  let removed = 0;
  const refresh = new ExecCardRefresh();
  refresh.begin({
    mode: "tui",
    ui: {
      setWidget: (_key: string, factory: unknown) => {
        if (!factory) {
          removed++;
          return;
        }
        const component = (factory as (tui: unknown) => { render(width: number): string[] })({
          requestRender: () => renders++,
        });
        assert.deepEqual(component.render(46), []);
      },
    },
  } as never);
  refresh.refresh();
  assert.equal(renders, 1);
  refresh.end();
  assert.equal(removed, 1);
  refresh.refresh();
  assert.equal(renders, 2);
});

test("final totals distinguish consultation and cumulative review costs", () => {
  const details: FinishDetails = {
    ...base,
    asks: 2,
    costUsd: 0.1,
    completion: "accepted",
    negotiation: { attempts: 3, reviewCostUsd: 0.3, phase: "reviewing", history: [{ decision, costUsd: 0.1 }] },
  };
  const text = plain(renderFinish(details, options, theme).render(120));
  assert.ok(text.includes("2 consultations"));
  assert.ok(text.includes("3 reviews"));
  assert.ok(text.includes("Review rounds"));
  assert.ok(text.includes("The readiness handshake is missing."));
});
