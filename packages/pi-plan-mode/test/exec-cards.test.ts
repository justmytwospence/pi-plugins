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
  finishContext,
  finishTitle,
  finishTone,
  negotiationText,
  renderAsk,
  renderFinish,
} from "../src/exec-cards.js";
import { planDiff } from "../src/plan-diff.js";
import { type ReviewTone, reviewCard, reviewStatusLine } from "../src/review-card.js";

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
    assert.ok(short.includes("Consultation · Planner answered"));
    assert.ok(!short.includes(details.question));
    assert.ok(short.replace(/\s+/gu, " ").includes("ctrl+o for question and full response"));
    assert.ok(short.includes("Astra · $0.12"));
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

for (const width of [46, 120]) {
  test(`mounted recovered reviews stop waiting without mutating historical details at ${width}`, () => {
    let current = { executionId: "exec", exchangeId: "review1", phase: "paused" };
    const details: FinishDetails = {
      ...base,
      decision: { ...decision, outcome: "user_needed", question: "Does the human input test pass?" },
      report: Array.from({ length: 25 }, (_, i) => `Report line ${i}`).join("\n\n"),
      previousFindings: [finding],
      responses: [{ id: "F1", status: "addressed", response: "Added a readiness test." }],
    };
    const before = JSON.stringify(details);
    const mounted = renderFinish(details, options, theme, () => current);
    const waiting = plain(mounted.render(width));
    assert.ok(waiting.includes("Waiting for your answer"));
    assert.ok(!waiting.includes("Report line 24"));
    // Recovery changes phase before another exchange is submitted.
    current = { ...current, phase: "revising" };
    for (const exchangeId of ["review1", "review2"]) {
      current = { ...current, exchangeId };
      const lines = mounted.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      const old = plain(lines).replace(/\s+/gu, " ");
      assert.ok(old.includes("Previous review"));
      assert.ok(!old.includes("Waiting for your answer"));
      assert.ok(!old.includes("Reply here."));
      assert.ok(!old.includes("Report line 24"));
      assert.ok(!old.includes("Added a readiness test."));
      assert.ok(old.includes("ctrl+o to expand"));
      assert.ok(old.includes("Readiness handshake"));
      assert.ok(old.includes("Does the human input test pass?"));
      const expanded = plain(
        renderFinish(details, { ...options, expanded: true }, theme, () => current).render(width),
      ).replace(/\s+/gu, " ");
      assert.ok(expanded.includes("Report line 24"));
      assert.ok(expanded.includes("Added a readiness test."));
    }
    assert.equal(JSON.stringify(details), before);
  });

  for (const reason of ["failure", "interrupted", "user_needed", "exhausted", "changes_requested", "pending"]) {
    test(`${reason} review is compact and outcome-first, with full details on expansion at ${width}`, () => {
      const failed = reason === "failure" || reason === "interrupted";
      const question = `Can you verify the handshake? ${"Check the exact interactive behavior. ".repeat(12)}Report your result verbatim.`;
      const error = `Exact ${reason} review error.\n\n${"Diagnostic details. ".repeat(30)}Full error tail.`;
      const details: FinishDetails = {
        ...base,
        report: `Report start.\n\n${"Report detail. ".repeat(30)}\n\nReport final paragraph.`,
        verification: `Verification start. ${"Reported automated checks. ".repeat(30)}\n\nVerification final paragraph.`,
        concerns: "Concern start.\n\nConcern middle.\n\nConcern final paragraph.",
        previousFindings: [finding],
        responses: [{ id: "F1", status: "addressed", response: "Added a readiness test." }],
        decision:
          failed || reason === "pending"
            ? undefined
            : {
                ...decision,
                outcome: reason === "user_needed" ? "user_needed" : "changes_requested",
                question: reason === "user_needed" ? question : undefined,
                recommendation: reason === "user_needed" ? "Perform the manual test before accepting." : undefined,
              },
        error: failed ? error : undefined,
        pending: reason === "pending",
        activity: reason === "pending" ? "reading src/session.ts" : undefined,
        changes: { edited: ["src/changed.ts"], outside: ["extra.ts"], git: "2 files changed" },
        negotiation: {
          attempts: 12,
          reviewCostUsd: 0.3,
          phase: reason === "pending" ? "reviewing" : reason === "changes_requested" ? "revising" : "paused",
          history: Array.from({ length: 12 }, (_, i) => ({
            report: {
              report: `Historical report ${i}`,
              verification: `Historical verification ${i}`,
              concerns: `Historical concerns ${i}`,
            },
            decision,
            error: `Historical error ${i}`,
            responses: [{ id: "F1", status: "addressed", response: `Historical response ${i}` }],
          })),
          pause:
            reason === "pending" || reason === "changes_requested"
              ? undefined
              : {
                  reason,
                  action: "/plan-exec resume <answer> or /plan-exec retry; do not proceed automatically.",
                },
        },
      };
      const current = () => ({ ...details, phase: details.negotiation?.phase });
      const lines = renderFinish(details, options, theme, current).render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      const text = plain(lines).replace(/\s+/gu, " ");
      const outcome = failed
        ? `Exact ${reason} review error.`
        : reason === "pending"
          ? "Planner reviewing… reading src/session.ts"
          : decision.summary;
      assert.ok(text.includes(outcome), outcome);
      assert.ok(text.indexOf(outcome) < text.indexOf("Report start."));
      assert.ok(text.includes("Verification start."));
      assert.ok(text.includes("Concern start."));
      assert.equal(text.match(/ctrl\+o to expand/gu)?.length, 1);
      if (!failed && reason !== "pending") {
        assert.ok(text.includes("1 finding"));
        assert.ok(text.includes(finding.title));
      }
      if (reason === "user_needed") {
        assert.ok(text.includes(question));
        assert.ok(text.includes("Perform the manual test before accepting."));
        assert.ok(text.indexOf(question) < text.indexOf("Report start."));
        assert.ok(text.indexOf("/plan-exec resume <answer>") < text.indexOf("Report start."));
      } else if (failed) {
        assert.ok(text.includes("Review did not finish"));
        assert.ok(text.includes(error.replace(/\s+/gu, " ")));
      } else if (reason === "exhausted") {
        assert.ok(text.includes("Another revision needs your approval"));
      }
      const hidden = [
        "Report final paragraph.",
        "Verification final paragraph.",
        "Concern final paragraph.",
        "Review rounds",
        "Reviewed evidence",
        finding.detail,
        finding.requestedChange,
        "Inspected src/session.ts",
        "Human input has not been tested.",
        "Added a readiness test.",
        "Historical report 11",
        "Historical verification 11",
        "Historical concerns 11",
        "Historical error 11",
        "Historical response 11",
        "src/changed.ts",
        "extra.ts",
        "2 files changed",
      ];
      if (details.negotiation?.pause) {
        assert.ok(text.includes(details.negotiation.pause.action ?? ""));
        assert.ok(!text.includes("No retry has been authorized."));
        assert.ok(!text.includes("Allow one more attempt"));
        assert.ok(!text.includes("Reply here."));
      }
      for (const value of hidden) assert.ok(!text.includes(value), value);
      const expandedLines = renderFinish(details, { ...options, expanded: true }, theme, current).render(width);
      assert.ok(expandedLines.every((line) => visibleWidth(line) <= width));
      const expanded = plain(expandedLines).replace(/\s+/gu, " ");
      for (const value of hidden) assert.ok(expanded.includes(value), value);
      if (failed) assert.ok(expanded.includes(error.replace(/\s+/gu, " ")));
      assert.ok(!expanded.includes("ctrl+o to expand"));
    });
  }
}

function themeSpy() {
  const fg: { role: string; text: string }[] = [];
  const bg: { role: string; text: string }[] = [];
  return {
    fg,
    bg,
    theme: {
      fg: (role: string, text: string) => {
        fg.push({ role, text });
        return text;
      },
      bg: (role: string, text: string) => {
        bg.push({ role, text });
        return text;
      },
      bold: (text: string) => text,
    } as Parameters<typeof renderFinish>[2],
  };
}

for (const width of [46, 120]) {
  test(`Unicode multiline consultations retain full details without mutating history at ${width}`, () => {
    const details: AskDetails = {
      executionId: "exec",
      exchangeId: "ask1",
      question: "如何握手？ 🧭\nKeep the existing transport?",
      reply: "等待就绪 🧭 é.\nKeep this first paragraph line.\n\nFull response tail: 保留传输。",
      planner: "Astra",
      costUsd: 0.12,
      number: 9,
      changes: planDiff("# Old\n旧的", "# New\n新的 🧭"),
    };
    const before = JSON.stringify(details);
    for (const exchangeId of ["ask1", "ask2"]) {
      for (const expanded of [false, true]) {
        const lines = renderAsk(details, { ...options, expanded }, theme, () => ({
          executionId: "exec",
          exchangeId,
        })).render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        const text = plain(lines).replace(/\s+/gu, " ");
        assert.ok(text.includes("Consultation · Planner answered"));
        assert.ok(text.includes("等待就绪 🧭 é. Keep this first paragraph line."));
        assert.ok(text.includes("Astra · $0.12"));
        for (const value of [details.question, details.reply ?? ""]) {
          assert.equal(text.includes(value.replace(/\s+/gu, " ")), expanded);
        }
        assert.equal(text.includes("Plan amendment"), expanded);
        assert.equal(text.includes("新的 🧭"), expanded);
        assert.equal(text.includes("ctrl+o for question and full response"), !expanded);
      }
    }
    const pendingLines = renderAsk({ ...details, pending: true, activity: "读取文件 🧭" }, options, theme).render(
      width,
    );
    assert.ok(pendingLines.every((line) => visibleWidth(line) <= width));
    const pending = plain(pendingLines).replace(/\s+/gu, " ");
    assert.ok(pending.includes(details.question.replace(/\s+/gu, " ")));
    assert.ok(pending.includes("Planner thinking… 读取文件 🧭"));
    assert.ok(!pending.includes("ctrl+o"));
    for (const error of [undefined, "Unavailable: 网络错误\n\nFull diagnostic tail."]) {
      const failed = { ...details, reply: "", error };
      const lines = renderAsk(failed, options, theme).render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      const text = plain(lines).replace(/\s+/gu, " ");
      assert.ok(text.includes("Consultation · Unavailable"));
      assert.ok(text.includes((error ?? "The planner returned no decision.").replace(/\s+/gu, " ")));
      assert.ok(!text.includes("如何握手"));
      assert.ok(text.includes("Astra · $0.12"));
    }
    assert.equal(JSON.stringify(details), before);
  });

  test(`paused explicit actions win over helpers but historical cards stay safe at ${width}`, () => {
    for (const reason of ["user_needed", "failure", "interrupted", "exhausted"]) {
      for (const explicit of ["details", "pause", "default"] as const) {
        const details: FinishDetails = {
          ...base,
          decision: undefined,
          question: "继续执行？ 🧭\nCheck manually.",
          error: reason === "failure" ? "失败\n\nExact diagnostic tail." : undefined,
          action: explicit === "details" ? "Details recovery 🧭\n\nDo this exact step." : undefined,
          negotiation: {
            attempts: 1,
            reviewCostUsd: 0,
            phase: "paused",
            history: [],
            pause: {
              reason,
              action: explicit !== "default" ? "Pause recovery 🧭\n\nDo that exact step." : undefined,
            },
          },
        };
        const before = JSON.stringify(details);
        let current = { executionId: "exec", exchangeId: "review1", phase: "paused" };
        const mounted = renderFinish(details, options, theme, () => current);
        const lines = mounted.render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        const text = plain(lines).replace(/\s+/gu, " ");
        const expected =
          details.action ??
          details.negotiation?.pause?.action ??
          (reason === "user_needed"
            ? "Reply here."
            : reason === "exhausted"
              ? "Allow one more attempt"
              : "No retry has been authorized.");
        assert.ok(text.includes(expected.replace(/\s+/gu, " ")), expected);
        if (explicit !== "default") {
          for (const helper of ["Reply here.", "Allow one more attempt", "No retry has been authorized."])
            assert.ok(!text.includes(helper));
        }
        if (explicit === "details") assert.ok(!text.includes("Pause recovery"));
        current = { ...current, executionId: "other-exec" };
        const historical = plain(mounted.render(width)).replace(/\s+/gu, " ");
        assert.ok(historical.includes("Previous review"));
        assert.ok(!historical.includes(expected.replace(/\s+/gu, " ")));
        const expandedLines = renderFinish(details, { ...options, expanded: true }, theme, () => current).render(width);
        assert.ok(expandedLines.every((line) => visibleWidth(line) <= width));
        const expanded = plain(expandedLines).replace(/\s+/gu, " ");
        assert.ok(expanded.includes(expected.replace(/\s+/gu, " ")));
        if (details.negotiation?.pause?.action) assert.ok(expanded.includes("Pause recovery"));
        assert.equal(JSON.stringify(details), before);
      }
    }
  });

  for (const tone of ["pending", "error", "success", "warning", "neutral"] as const) {
    test(`${tone} uses semantic fg and one padded standalone shell at ${width}`, () => {
      const spy = themeSpy();
      const role = tone === "pending" || tone === "neutral" ? "muted" : tone;
      assert.equal(reviewStatusLine(spy.theme, { tone, text: "Status", context: "Context" }), "Status · Context");
      assert.deepEqual(spy.fg, [
        { role: "dim", text: " · Context" },
        { role, text: "Status" },
      ]);
      const details: FinishDetails = {
        ...base,
        completion: tone === "success" ? "accepted" : tone === "warning" ? "user_override" : undefined,
        pending: tone === "pending",
        decision: undefined,
        error: tone === "error" ? "Exact error" : undefined,
        report: "Changed 文件 🧭\n\nFull report tail.",
      };
      const body = renderFinish(details, { ...options, omitTitle: true }, spy.theme);
      const toolLines = body.render(width);
      assert.ok(toolLines.every((line) => visibleWidth(line) <= width));
      assert.equal(spy.bg.length, 0);
      const title = finishTitle(details);
      assert.ok(!plain(toolLines).includes(title));
      const shell = reviewCard(spy.theme, title, body, tone).render(width);
      assert.ok(shell.every((line) => visibleWidth(line) === width));
      assert.equal(plain(shell).replace(/\s+/gu, " ").split(title).length - 1, 1);
      // Box samples its background once to detect theme changes, besides painting each row.
      assert.equal(spy.bg.filter((call) => call.text !== "test").length, shell.length);
      const slot = tone === "pending" ? "toolPendingBg" : tone === "error" ? "toolErrorBg" : "toolSuccessBg";
      assert.ok(spy.bg.every((call) => call.role === slot));
      assert.equal(shell[0].trim(), "");
      assert.equal(shell.at(-1)?.trim(), "");
      assert.ok(shell[1].startsWith(` ${title.split(" ")[0]}`));
    });
  }
}

test("tool status lines use outcome colors without painting a background", () => {
  const cases: [FinishDetails, ReviewTone, string][] = [
    [{ ...base, pending: true }, "pending", "Reviewing"],
    [{ ...base, decision: undefined, error: "Failed" }, "error", "Review unavailable: Failed"],
    [{ ...base, completion: "accepted" }, "success", "Reviewed"],
    [{ ...base, completion: "no_review" }, "warning", "Review skipped"],
    [{ ...base, completion: "user_override", error: "Failed" }, "warning", "Review overridden"],
    [{ ...base, completion: "stopped" }, "warning", "Not completed"],
  ];
  for (const [details, tone, label] of cases) {
    const spy = themeSpy();
    renderFinish(details, options, spy.theme).render(120);
    assert.ok(spy.fg.some((call) => call.role === (tone === "pending" ? "muted" : tone) && call.text === label));
    assert.deepEqual(spy.bg, []);
  }
  for (const [extra, role, label] of [
    [{ pending: true }, "muted", "Planner thinking…"],
    [{ error: "Failed" }, "error", "Consultation unavailable"],
    [{}, "warning", "Planner answered"],
  ] as const) {
    const spy = themeSpy();
    renderAsk({ question: "Question", reply: "Reply", planner: "Astra", ...extra }, options, spy.theme).render(46);
    assert.ok(spy.fg.some((call) => call.role === role && call.text === label));
    assert.deepEqual(spy.bg, []);
  }
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
      const before = JSON.stringify(details);
      const compactLines = renderFinish(details, options, theme, () => details).render(width);
      assert.ok(compactLines.every((line) => visibleWidth(line) <= width));
      const compact = plain(compactLines).replace(/\s+/gu, " ");
      assert.ok(compact.includes("Implemented readiness checks."));
      assert.ok(compact.includes("Tests passed locally."));
      assert.ok(compact.includes("Human input remains untested."));
      for (const heading of ["Changed", "Verified", "Outstanding issues"]) assert.ok(compact.includes(heading));
      assert.ok(!compact.includes("implementer reported"));
      const title = `Implementation · ${
        {
          accepted: "Reviewed",
          no_review: "Review skipped",
          user_override: "Review overridden",
          stopped: "Not completed",
        }[completion]
      }`;
      assert.equal(finishTitle(details), title);
      assert.ok(compact.includes(title));
      assert.ok(compact.includes(finishContext(details)));
      assert.equal(compact.match(/ctrl\+o for full report/gu)?.length, 1);
      assert.equal(compact.match(/Implementation ·/gu)?.length, 1);
      for (const hidden of [
        "Full report tail",
        "Full verification tail",
        "Full concern tail",
        "Review rounds",
        "Reviewed evidence",
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
      assert.ok(!expanded.includes("ctrl+o"));
      assert.equal(JSON.stringify(details), before);
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
  for (const width of [46, 120]) {
    for (const expanded of [false, true]) {
      const lines = renderFinish({ ...details, returnedTo: "Astra" }, { ...options, expanded }, theme).render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      const text = plain(lines).replace(/\s+/gu, " ");
      assert.ok(text.includes("Terra → Astra"));
      assert.ok(text.includes("2 consultations · $0.10"));
      assert.ok(text.includes("3 reviews · $0.30"));
      assert.equal(text.includes("Review rounds"), expanded);
      assert.equal(text.includes("The readiness handshake is missing."), expanded);
    }
  }
});
