import { describeGrants, type ResolvedGrant } from "../command-grants.js";
import { PLAN_STANDARD } from "../handoff.js";
import { MCP_GATEWAY_TOOL } from "../mcp-tools.js";
import { describedTools, mcpToolsNote } from "../planners.js";
import { buildPlanModePrompt } from "../prompt.js";

/** The planner's role, appended to its system prompt. */
export function plannerSystemPrompt() {
  return [
    buildPlanModePrompt(),
    "",
    "## Planning screen",
    "",
    "You are a planner in a dedicated planning session. The conversation above it is the user's own session, copied here so you start with their context; you cannot change their files or their session. The user watches your work live and can talk to you at any time: their messages arrive as ordinary user messages, sometimes while you are working.",
    "Ask with plan_mode_question when a product decision, preference, or tradeoff needs the user (they answer on the planning screen). Submit with plan_mode_complete; resubmit the complete revised plan whenever the plan changes.",
  ].join("\n");
}

export interface PlannerTaskInput {
  task: string;
  /** How many planners work on this task (1 or 2). */
  planners: number;
  scoutLabel?: string;
  tools: readonly string[];
  mcpAllow?: readonly string[];
  grants: readonly ResolvedGrant[];
}

/** The first message a planner gets: the task, and what it may use. */
export function plannerTaskPrompt(input: PlannerTaskInput) {
  return [
    ...(input.planners > 1
      ? [
          "Another model is planning the same task in parallel without seeing your work; the user will compare the plans, combine them, or pick one.",
        ]
      : []),
    ...plannerToolNotes(input),
    "",
    "## Task",
    "",
    input.task.trim() || "Plan the task discussed in the conversation so far.",
  ].join("\n");
}

/** What a planner (or the planner on call) may use beyond reading files, one line each. */
export function plannerToolNotes(input: Omit<PlannerTaskInput, "task" | "planners">): string[] {
  const research = describedTools(input.tools);
  return [
    ...(research.length > 0
      ? [
          `Research beyond the repository whenever outside knowledge matters (library and API docs, versions, known issues, prior art) with ${research.join(", ")}.`,
        ]
      : []),
    ...(input.tools.includes(MCP_GATEWAY_TOOL) && input.mcpAllow
      ? [mcpToolsNote(input.mcpAllow, "you may call only these MCP tools")]
      : []),
    ...(input.grants.length > 0
      ? [
          `Besides read-only commands, bash may run these granted commands (one command per call; a quoted heredoc may feed it input): ${describeGrants(input.grants)}. Use them to inspect, not to change anything; any skill that explains them is loaded.`,
        ]
      : []),
    ...(input.scoutLabel
      ? [
          `For broad or independent investigations, delegate to read-only subagents with plan_subagents (they run on ${input.scoutLabel}; give each a self-contained task and run independent ones in one call). Verify anything decisive yourself, and write the plan yourself.`,
        ]
      : []),
  ];
}

/**
 * Sent when a run is restored (after `/reload`, a restart, or resuming the session) to a planner
 * whose turn was cut off, or had failed, so it carries on without you typing "continue".
 */
export function resumeMessage(reason: "interrupted" | "failed") {
  const why =
    reason === "interrupted"
      ? "Your previous turn was cut off because the user's pi session restarted (a reload or a restart); whatever the interrupted step was doing did not reach you."
      : "Your previous turn failed with an error (often a provider or credentials problem, which may be fixed now).";
  return `${why} Carry on from where you left off. If your plan was already complete, resubmit it with plan_mode_complete.`;
}

// --- Your main conversation --------------------------------------------------------------------
// Your main session is where you talk the plans over: each plan (and each revision) lands there in
// full, and your main agent can question a planner or record a merged plan with two tools.

/** One planner's new plan, as it lands in your main conversation. */
export interface PlanDelivery {
  id: string;
  /** e.g. `Claude Fable 5.1 xhigh` */
  model: string;
  revision: number;
  plan: string;
  task: string;
  /** What the user and the planner said since its previous delivery (no tool output). */
  conversation?: string;
  /** One line per other planner, e.g. "Planner B is still planning." */
  others: string[];
}

export function planDeliveryText(delivery: PlanDelivery) {
  const version = delivery.revision > 1 ? ` v${delivery.revision}` : "";
  const task = delivery.task.trim().split("\n")[0] || "the task discussed above";
  return [
    `Planner ${delivery.id} (${delivery.model}) submitted plan ${delivery.id}${version} for: ${task}`,
    ...(delivery.conversation?.trim()
      ? [
          "",
          `What the user and planner ${delivery.id} said since ${delivery.revision > 1 ? "its previous version" : "it started"} (tool output left out):`,
          `<conversation planner="${delivery.id}">`,
          delivery.conversation.trim(),
          "</conversation>",
        ]
      : []),
    "",
    `<plan id="${delivery.id}" version="${delivery.revision}">`,
    delivery.plan.trim(),
    "</plan>",
    ...(delivery.others.length ? ["", ...delivery.others] : []),
  ].join("\n");
}

/** A planner failed: your main agent hears it too, so it does not wait for that plan. */
export function planFailureText(id: string, model: string, error: string) {
  return `Planner ${id} (${model}) failed: ${error}. The user can retry it from /planners (talk to it, or reload once the cause is fixed).`;
}

/** How a question reaches a planner: from your main agent, or from the agent implementing its plan. */
export function consultMessage(message: string, from: "main" | "implementer" = "main") {
  if (from === "implementer") {
    return `[From the implementing agent, which is carrying out your approved plan. Answer it directly; amend the plan file only if your answer changes the plan.]\n\n${message.trim()}`;
  }
  return `[From the user's main agent, which is talking the plans over with the user. Answer it directly; resubmit your plan with plan_mode_complete only if your answer changes it.]\n\n${message.trim()}`;
}

/** The planner on call's role, appended to its system prompt. */
export function consultantSystemPrompt(planFile: string, toolNotes: readonly string[] = []) {
  return [
    "## Planner on call",
    "",
    `The conversation above is where you planned this task. The user approved your plan, which is in the plan file ${planFile}, and handed it to another model, which is implementing it in a separate session in the same working directory. It asks you when the plan does not fit what it finds; its messages start with "[From the implementing agent".`,
    "- Check the current files before you answer: they include the implementer's changes. You can read files and run read-only commands; the only file you may write is the plan file.",
    "- Decide. Answer with what to do, where and why, as concretely as the plan itself; do not hand the decision back.",
    "- When your answer changes the plan, edit the plan file first: change the affected sections in place, and add a dated line under a `## Amendments` heading at its end saying what changed and why.",
    "- When the question is a product decision only the user can make, say so, and give the exact question the implementer should ask the user, with your recommendation.",
    "- Keep answers short: the implementer has the plan.",
    ...(toolNotes.length > 0 ? ["", ...toolNotes] : []),
  ].join("\n");
}

/** Steers the planner on call when its time is almost up. */
export const CONSULT_WRAP_UP =
  "Time is almost up. Stop investigating and answer now with your best decision; amend the plan file first if your answer changes the plan.";

/** A targeted, informational review by the existing planner on call, not a user approval gate. */
export function reviewRequest(
  report: string,
  context?: { verification: string; concerns: string; planFile: string; changes: string },
) {
  return [
    "[From the implementing agent, which reports your plan as done. Give a targeted completion assessment, not user approval.]",
    "",
    "Review the implementation against the current plan. Inspect relevant tracked files and commit history as well as git status and the working-tree diff: work may already be committed, so git diff HEAD alone is not sufficient. Give a concise assessment of what met the plan, evidence you actually inspected, deviations, and remaining risks. Explicitly distinguish implementer-reported checks from independently observed evidence, and state limitations where evidence cannot establish a claim. Do not modify any files (including the plan) or run tests, even if your tools or grants permit it. Identify changes still needed with the file and what to do. This is informational: do not start further implementation. End with exactly `Verdict: done` when nothing needs to change, or `Verdict: changes needed`.",
    ...(context ? ["", `Plan file: ${context.planFile}`, "", "Change summary:", context.changes] : []),
    "",
    "The implementer's report (what changed):",
    "",
    report.trim(),
    ...(context
      ? ["", "Implementer-reported verification:", context.verification, "", "Outstanding issues:", context.concerns]
      : []),
  ].join("\n");
}

/** Only an unambiguous final verdict is an assessment; absent or malformed verdicts are unclear. */
export function reviewVerdict(reply: string): "done" | "changes" | "unclear" {
  const parse = (line: string) => {
    const text = line.trim();
    const bare = text.startsWith("`") && text.endsWith("`") ? text.slice(1, -1) : text;
    return /^verdict:\s*(done|changes needed)$/iu.exec(bare)?.[1]?.toLowerCase();
  };
  const lines = reply.trim().split("\n");
  const final = parse(lines.at(-1) ?? "");
  if (!final) return "unclear";
  if (
    lines.some((line) => {
      const verdict = parse(line);
      return verdict !== undefined && verdict !== final;
    })
  )
    return "unclear";
  return final === "done" ? "done" : "changes";
}

/** What Write plan M (or Revise plan M, once there is one) asks your main agent to do. */
export function writeMergedRequest(revise: boolean) {
  return revise
    ? "Revise plan M: fold in what we have discussed since you recorded it, and record the complete revised plan with plan_submit_merged, to the same standard as before."
    : `Write plan M: merge the planners' plans and what we have decided here into one complete implementation plan. Where they disagree, pick one approach and say why. Write it to this standard:\n\n${PLAN_STANDARD}\n\nRecord it with plan_submit_merged.`;
}

/** Guidance for your main agent while a planning run is active (its tools' guidelines). */
export const MAIN_AGENT_GUIDELINES = [
  "Planners (A and B) are writing implementation plans in the background, read-only. Each plan and each revision arrives in this conversation as a message with the plan in full; the user may also talk to the planners directly in /planners.",
  "While planning is underway, do not edit files or run anything that changes state unless the user explicitly asks; talk the plans over with the user instead.",
  "To find out more about a plan or what a planner learned, ask it with plan_ask_planner rather than re-investigating from scratch.",
  "Call plan_submit_merged only when the user asks for the merged (or adjusted) plan, with the complete plan as Markdown, not a diff. It becomes plan M, which the user implements or exports from /planners, or asks you to implement here.",
];
