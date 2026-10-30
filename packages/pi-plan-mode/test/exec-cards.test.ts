import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
  type AskDetails,
  completionPreview,
  ExecCardRefresh,
  type FinishDetails,
  finishTone,
  negotiationText,
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

for (const width of [46, 120]) {
  test(`unresolved, failed and exhausted reviews keep actionable details at ${width}`, () => {
    for (const reason of ["failure", "interrupted", "user_needed", "exhausted"]) {
      const details: FinishDetails = {
        ...base,
        report: "Report start.\n\n" + "Report remains visible.\n".repeat(20) + "Report final paragraph.",
        decision:
          reason === "failure" || reason === "interrupted"
            ? undefined
            : {
                ...decision,
                outcome: "user_needed",
                question: "Can you verify the handshake?",
                recommendation: "Perform the manual test before accepting.",
              },
        error: reason === "failure" || reason === "interrupted" ? `Exact ${reason} review error` : undefined,
        negotiation: {
          attempts: 3,
          reviewCostUsd: 0.3,
          phase: "paused",
          history: [],
          pause: {
            reason,
            action: "/plan-exec resume <answer> or /plan-exec retry; do not proceed automatically.",
            question: "Is the manual check complete?",
          },
        },
      };
      const lines = renderFinish(details, options, theme, () => details).render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      const text = plain(lines).replace(/\s+/gu, " ");
      for (const value of [
        "Report final paragraph.",
        "/plan-exec resume <answer>",
        "/plan-exec retry",
        "do not proceed automatically.",
      ])
        assert.ok(text.includes(value), value);
      if (details.error) assert.ok(text.includes(details.error));
      else
        for (const value of [
          finding.detail,
          finding.requestedChange,
          "Can you verify the handshake?",
          "Perform the manual test before accepting.",
        ])
          assert.ok(text.includes(value), value);
      assert.ok(!text.includes("What changed"));
    }
  });
}

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

test("literal completion previews normalize paragraphs and clip without inventing prose", () => {
  assert.deepEqual(completionPreview("  First\n\n\nSecond\n\nThird  ", 3, 320), {
    text: "First\n\nSecond…",
    truncated: true,
  });
  assert.deepEqual(completionPreview("One two three four", 3, 12), { text: "One two…", truncated: true });
  assert.deepEqual(completionPreview("Unchanged paragraph.", 3, 320), {
    text: "Unchanged paragraph.",
    truncated: false,
  });
});

for (const width of [46, 120]) {
  for (const completion of ["accepted", "no_review", "user_override", "stopped"] as const) {
    test(`${completion} stays compact even live, and expands completely at ${width}`, () => {
      const report = `Implemented readiness checks. ${"Transport behavior is preserved. ".repeat(20)}\n\nFull report tail.`;
      const verification = `Tests passed locally. ${"Manual checks are not verified by the planner. ".repeat(15)}\n\nFull verification tail.`;
      const concerns = `Human input remains untested.\n\nA substantive outstanding concern.\n\nFull concern tail.`;
      const details: FinishDetails = {
        ...base,
        completion,
        report,
        verification,
        concerns,
        previousFindings: [finding],
        responses: [{ id: "F1", status: "disputed", response: "Evidence checked in detail." }],
        negotiation: {
          attempts: 2,
          reviewCostUsd: 0.25,
          phase: "reviewing",
          history: [
            {
              report: { report: "First report", verification: "First verification", concerns: "First concerns" },
              decision,
              costUsd: 0.1,
            },
            {
              report: "Original legacy report",
              error: "Original review error",
              responses: [{ id: "F1", status: "addressed", response: "Original response" }],
              costUsd: 0.15,
            },
          ],
        },
        changes: { edited: ["src/session.ts"], outside: ["extra.ts"], git: "2 files changed" },
      };
      const compactLines = renderFinish(details, options, theme, () => details).render(width);
      assert.ok(compactLines.every((line) => visibleWidth(line) <= width));
      const compact = plain(compactLines).replace(/\s+/gu, " ");
      assert.ok(compact.includes("Implemented readiness checks."));
      assert.ok(compact.includes("Tests passed locally."));
      assert.ok(compact.includes("Human input remains untested."));
      assert.ok(compact.includes("implementer reported"));
      assert.equal(compact.match(/ctrl\+o to expand/gu)?.length, 1);
      assert.equal(compact.match(/Implementation ·/gu)?.length, 1);
      for (const hidden of [
        "Full report tail",
        "Full verification tail",
        "Full concern tail",
        "Review rounds",
        "Reviewed evidence",
        "consultations",
        "$",
        "src/session.ts",
        "Original review error",
      ])
        assert.ok(!compact.includes(hidden), hidden);
      assert.ok(compact.includes("…"));
      if (completion !== "accepted") assert.ok(!compact.includes("· Accepted"));
      const expandedLines = renderFinish(details, { ...options, expanded: true }, theme).render(width);
      assert.ok(expandedLines.every((line) => visibleWidth(line) <= width));
      const expanded = plain(expandedLines).replace(/\s+/gu, " ");
      for (const full of [report, verification, concerns])
        assert.ok(expanded.includes(full.replace(/\s+/gu, " ").trim()));
      for (const value of [
        "Reviewed evidence",
        "Human input has not been tested.",
        "Readiness handshake",
        "Add the readiness handshake",
        "Evidence checked in detail.",
        "First report",
        "First verification",
        "First concerns",
        "Original legacy report",
        "Original review error",
        "Original response",
        "src/session.ts",
        "extra.ts",
        "2 files changed",
        "2 reviews",
      ])
        assert.ok(expanded.includes(value), value);
      assert.ok(!expanded.includes("ctrl+o to expand"));
    });
    test(`${completion} keeps final recovery instructions untruncated at ${width}`, () => {
      const action = [
        "Planning model restoration failed; select the model manually.",
        "Check the model provider and credentials before selecting the planning model. ".repeat(6),
        "Open /model and select the original planning model.",
        "Then confirm its thinking level before continuing.",
      ].join("\n\n");
      const details: FinishDetails = { ...base, completion, action };
      const lines = renderFinish(details, options, theme, () => details).render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      const text = plain(lines).replace(/\s+/gu, " ");
      assert.ok(text.includes("Next action"));
      assert.ok(text.includes(action.replace(/\s+/gu, " ")));
    });
    test(`${completion} missing values remain explicit at ${width}`, () => {
      const details = { report: "", planFile: "old.md", completion };
      const text = plain(renderFinish(details, options, theme).render(width)).replace(/\s+/gu, " ");
      assert.ok(text.includes("Not provided; verification is unknown."));
      assert.ok(text.includes("Not provided; outstanding issues are unknown."));
    });
  }
}

test("missing and legacy details remain readable without inferring finality", () => {
  assert.ok(plain(renderFinish(undefined, options, theme).render(46)).includes("Implementation review unavailable"));
  const legacy = {
    ...base,
    executionId: undefined,
    exchangeId: undefined,
    negotiation: undefined,
    decision: { ...decision, outcome: "accepted" as const },
  };
  const text = plain(renderFinish(legacy, options, theme).render(120));
  assert.ok(text.includes("Review 1"));
  assert.ok(!text.includes("What changed"));
  assert.ok(
    negotiationText({ history: [{ report: "Raw historical report" }, null], pause: { question: "Recover?" } }).includes(
      "Raw historical report",
    ),
  );
  assert.ok(negotiationText({ history: null }).includes("0 review rounds"));
});

test("final totals distinguish consultation and cumulative review costs", () => {
  const details: FinishDetails = {
    ...base,
    asks: 2,
    costUsd: 0.1,
    completion: "accepted",
    negotiation: { attempts: 3, reviewCostUsd: 0.3, phase: "reviewing", history: [{ decision, costUsd: 0.1 }] },
  };
  const text = plain(renderFinish(details, { ...options, expanded: true }, theme).render(120));
  assert.ok(text.includes("2 consultations"));
  assert.ok(text.includes("3 reviews"));
  assert.ok(text.includes("Review rounds"));
  assert.ok(text.includes("The readiness handshake is missing."));
});
