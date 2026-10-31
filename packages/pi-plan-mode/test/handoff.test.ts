import assert from "node:assert/strict";
import { test } from "vitest";
import { implementationBrief, PLAN_STANDARD } from "../src/handoff.js";
import { enterPlanText } from "../src/inline-plan.js";
import { writeMergedRequest } from "../src/planner/prompt.js";
import { buildPlanModePrompt } from "../src/prompt.js";

test("the self-contained plan standard is in every prompt that asks for a plan", () => {
  assert.match(PLAN_STANDARD, /optionally in an explicitly fresh context with nothing but the plan/u);
  assert.match(
    PLAN_STANDARD,
    /make every implementation decision in the plan yourself, after checking it in the code/u,
  );
  assert.ok(enterPlanText("/p/calm-river.md", false, false).includes(PLAN_STANDARD));
  const prompt = buildPlanModePrompt();
  assert.ok(prompt.includes(PLAN_STANDARD));
  assert.doesNotMatch(prompt, /behavior-level/u);
  const merged = writeMergedRequest(false);
  assert.ok(merged.startsWith("Write plan M: merge the planners' plans"));
  assert.ok(merged.includes(PLAN_STANDARD));
  assert.match(writeMergedRequest(true), /to the same standard as before\.$/u);
});

test("here and fresh handoffs differ only in the explicit fresh-context claim", () => {
  const options = { plan: "# P\n\n1. Implement it.", planFile: "/p/a.md", planner: "Claude Opus 5.5" };
  const here = implementationBrief({ ...options, context: "here" });
  const fresh = implementationBrief({ ...options, context: "fresh" });
  const freshClaim = "; this message is all you have of the planning";
  assert.ok(fresh.includes(freshClaim));
  assert.ok(!here.includes(freshClaim));
  assert.equal(fresh.replace(freshClaim, ""), here);
  for (const brief of [here, fresh]) {
    assert.match(brief, /read each file before you change it/u);
    assert.match(brief, /ask the planner with ask_planner/u);
    assert.match(brief, /Run its Verification as written/u);
    assert.match(brief, /call finish_plan/u);
    assert.ok(brief.endsWith(`## Approved plan\n\n${options.plan}`));
  }
});

test("the handoff describes conversational recovery without bypassing review safeguards", () => {
  const brief = implementationBrief({ plan: "# P", context: "here" });
  assert.match(brief, /why you stopped, what is needed, and what happens after the answer/u);
  assert.match(brief, /clarification is not authorization/u);
  assert.match(brief, /continue_plan with action answer and its eligible replyId/u);
  assert.match(brief, /only an explicit UI selection authorizes a retry or an extra revision attempt/u);
  assert.match(brief, /dialog is canceled or unavailable, remain paused/u);
  assert.match(brief, /do not work around the pause or reset the revision budget/u);
  assert.match(brief, /evidence-backed disputes/u);
  assert.doesNotMatch(brief, /\/plan-exec resume/u);
});

test("the implementation brief adapts to who wrote the plan and who answers questions", () => {
  const own = implementationBrief({ plan: "# P", planFile: "/p/a.md", context: "here", own: true });
  assert.ok(own.startsWith("The user approved your plan."));
  assert.match(own, /decide as you would have while planning/u);
  assert.match(own, /## Amendments/u);

  const planner = implementationBrief({ plan: "# P", context: "fresh", planner: "Claude Opus 5.5" });
  assert.match(planner, /this message is all you have of the planning/u);
  assert.match(planner, /Claude Opus 5.5 researched and decided it and is on call/u);
  assert.match(planner, /ask_planner/u);

  const plain = implementationBrief({ plan: "# P", context: "here" });
  assert.match(plain, /ask the user\./u);
  assert.doesNotMatch(plain, /Amendments|reread it/u);

  const filed = implementationBrief({ plan: "# P", planFile: "/p/a.md", context: "fresh" });
  assert.match(filed, /ask the user, and record the decision under a dated `## Amendments` heading/u);
  assert.match(filed, /The plan file is \/p\/a\.md; reread it after an amendment or a compaction\./u);
  assert.ok(filed.endsWith("## Approved plan\n\n# P"));
  assert.ok(
    implementationBrief({ plan: "# P", context: "here", edited: true }).includes(
      "## Approved plan (edited by the user)\n\n# P",
    ),
  );
});
