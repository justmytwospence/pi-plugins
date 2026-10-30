export const PLAN_STANDARD = `The plan is a handoff. Once approved, it may be implemented by a cheaper model in a fresh context that has nothing but the plan, so make every implementation decision in the plan yourself, after checking it in the code: implementing it should be mechanical. Write these sections:
- Summary: two or three sentences on the goal and the approach, for the user's review.
- Decisions: each choice that shapes the work, with the alternative you rejected and why, one line each.
- Changes: every file to create or change, by its repository-relative path in backticks; for each, the functions, types and signatures to add or change, the exact behavior (inputs, outputs, edge cases, errors, user-facing text and names), and the existing code to reuse, as \`path:line\`.
- Steps: the order to make the changes in, and where to commit, when it matters.
- Verification: the exact commands to run and what each must show, and every new or changed test by file and case.
- Out of scope: what must not change.
- Handoff notes: facts you verified that the implementer would otherwise rediscover, pitfalls, and the parts of the plan most likely to be wrong.
Before you submit it, reread it as its implementer would: any "consider", "e.g.", "or", "as needed", "if appropriate" or "TBD", and any file, function or command you have not checked, is a decision still open. Make it, or ask the user.`;

/** The compaction summary a handoff leaves behind, before the brief. */
export const HANDOFF_SUMMARY =
  "Planning is over: the user approved the plan and handed it off for implementation. The planning conversation is not in this context; the next message has the approved plan and how to implement it.";
export const HANDOFF_MESSAGE_TYPE = "plan-mode-handoff";

export interface ImplementationBrief {
  plan: string;
  /** The plan file: the plan's current version, which amendments update. */
  planFile?: string;
  /** "here": the conversation that produced the plan goes on; "fresh": the implementer has only this message. */
  context: "here" | "fresh";
  /** The planner on call through ask_planner, e.g. "Claude Opus 5.5" (phase 2). */
  planner?: string;
  /** The implementing agent wrote the plan itself (plan mode, implemented here). */
  own?: boolean;
  edited?: boolean;
}

/** The execution contract for every way a plan gets implemented. The plan is always last. */
export function implementationBrief(brief: ImplementationBrief): string {
  const { plan, planFile, context, planner, own, edited } = brief;
  const fresh = context === "fresh";
  const amend = planFile
    ? ", and record the decision under a dated `## Amendments` heading at the end of the plan file"
    : "";
  const deviation = planner
    ? "ask the planner with ask_planner: say what you found and the options you see. Follow its answer; when it amends the plan, the plan file has the new version. If it says the decision is the user's, ask the user."
    : own
      ? `decide as you would have while planning, asking the user when the choice is theirs${planFile ? ", and record the change under a dated `## Amendments` heading at the end of the plan file" : ""}.`
      : `ask the user${amend}.`;
  const lines = [
    own
      ? "The user approved your plan. Implement it now."
      : `The user approved the plan below and handed it to you to implement${fresh ? "; this message is all you have of the planning" : ""}. ${planner ? `${planner} researched and decided it and is on call for your questions` : "It was researched and decided before it reached you"}: treat it as your spec, not a starting point.`,
    "",
    "## How to implement it",
    "- Carry it out as written. Do not re-investigate or re-decide what it states; read each file before you change it.",
    "- Work through its steps in order, tracking them in your todo list if you have one.",
    "- Change only what it lists, and nothing under Out of scope.",
    `- When the plan does not fit what you find (a step cannot be done as written, a fact it states is wrong, a change it does not list is needed, or it leaves a choice open), do not improvise: ${deviation}`,
    "- Run its Verification as written, and fix what fails within the plan.",
    "- When implementation is finished, call finish_plan with three required nonempty fields: report (what you changed), verification (checks and their results, including anything not run), and concerns (deviations and how they were settled, failures, and remaining work; use None only when accurate). Report failures honestly; the planner's completion assessment is informational, not user approval.",
  ];
  if (planFile) lines.push("", `The plan file is ${planFile}; reread it after an amendment or a compaction.`);
  lines.push("", `## Approved plan${edited ? " (edited by the user)" : ""}`, "", plan);
  return lines.join("\n");
}
