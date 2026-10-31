export const PLAN_STANDARD = `The plan is a handoff. Once approved, it may be implemented by a cheaper model, optionally in an explicitly fresh context with nothing but the plan, so make every implementation decision in the plan yourself, after checking it in the code: implementing it should be mechanical. Write these sections:
- Summary: two or three sentences on the goal and the approach, for the user's review.
- Decisions: each choice that shapes the work, with the alternative you rejected and why, one line each.
- Changes: every file to create or change, by its repository-relative path in backticks; for each, the functions, types and signatures to add or change, the exact behavior (inputs, outputs, edge cases, errors, user-facing text and names), and the existing code to reuse, as \`path:line\`.
- Steps: the order to make the changes in, and where to commit, when it matters.
- Verification: the exact commands to run and what each must show, and every new or changed test by file and case.
- Out of scope: what must not change.
- Handoff notes: facts you verified that the implementer would otherwise rediscover, pitfalls, and the parts of the plan most likely to be wrong.
Before you submit it, reread it as its implementer would: any "consider", "e.g.", "or", "as needed", "if appropriate" or "TBD", and any file, function or command you have not checked, is a decision still open. Make it, or ask the user.`;

export const HANDOFF_MESSAGE_TYPE = "plan-mode-handoff";

/** Ordinary execution in the current conversation, with a normal final response. */
export function directImplementationBrief({
  plan,
  planFile,
  edited,
}: {
  plan: string;
  planFile?: string;
  edited?: boolean;
}): string {
  return [
    "The user approved the plan. Implement it now in this conversation.",
    "Read each file before changing it, follow the approved steps and scope, and run the plan's verification. Ask the user if a decision is needed. When done, reply normally with the changes and verification results.",
    ...(planFile ? ["", `The approved plan file is ${planFile}.`] : []),
    "",
    `## Approved plan${edited ? " (edited by the user)" : ""}`,
    "",
    plan,
  ].join("\n");
}

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
    "- When implementation is finished, call finish_plan with three required nonempty fields: report (what you changed), verification (checks and their results, including anything not run), and concerns (deviations and how they were settled, failures, and remaining work; use None only when accurate). This submits for completion review, not unconditional completion. When changes are requested, fix them or submit evidence-backed disputes and include responses covering every finding exactly once (id, status: addressed|disputed|blocked, response). Accepted or explicitly configured no-review completion ends the workflow. Report failures honestly.",
    "- User-needed, failed or exhausted reviews pause implementation: do not work around the pause or reset the revision budget. Explain concisely why you stopped, what is needed, and what happens after the answer. Answer questions and discuss clarification normally; clarification is not authorization. When a fresh human reply resolves a user-needed question, call continue_plan with action answer and its eligible replyId to record the user's answer and continue. Do not supply a replacement answer. For a failed review or exhausted revisions, use continue_plan with action retry or extend to present the appropriate choice; only an explicit UI selection authorizes a retry or an extra revision attempt. Ordinary conversation does not authorize retry, extension or completion without review. Use continue_plan with action accept or stop when requested; these require the user's UI confirmation. If a dialog is canceled or unavailable, remain paused and discuss what the user needs.",
  ];
  if (planFile) lines.push("", `The plan file is ${planFile}; reread it after an amendment or a compaction.`);
  lines.push("", `## Approved plan${edited ? " (edited by the user)" : ""}`, "", plan);
  return lines.join("\n");
}
