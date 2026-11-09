export const PLAN_STANDARD = `The plan is a handoff. Once approved, it may be implemented by a cheaper model (the worker of a plan model pair) that reads this conversation, so make every implementation decision in the plan yourself, after checking it in the code: implementing it should be mechanical. Write these sections:
- Summary: two or three sentences on the goal and the approach, for the user's review.
- Decisions: each choice that shapes the work, with the alternative you rejected and why, one line each.
- Changes: every file to create or change, by its repository-relative path in backticks; for each, the functions, types and signatures to add or change, the exact behavior (inputs, outputs, edge cases, errors, user-facing text and names), and the existing code to reuse, as \`path:line\`.
- Steps: the order to make the changes in, and where to commit, when it matters.
- Verification: the exact commands to run and what each must show, and every new or changed test by file and case.
- Out of scope: what must not change.
- Handoff notes: facts you verified that the implementer would otherwise rediscover, pitfalls, and the parts of the plan most likely to be wrong.
Before you submit it, reread it as its implementer would: any "consider", "e.g.", "or", "as needed", "if appropriate" or "TBD", and any file, function or command you have not checked, is a decision still open. Make it, or ask the user.`;

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
