import { MODE_NAMES, type ApprovalMode, type WorkflowMode } from "./modes.ts";

export const MODE_GUIDANCE_TYPE = "tool-gate:mode-guidance";
export const MODE_SETTINGS_NOTICE_TYPE = "tool-gate:mode-settings-notice";

export interface ModeGuidanceState {
  workflow: WorkflowMode;
  approval: ApprovalMode;
  denyInsteadOfPrompting: boolean;
}

const WORKFLOW_GUIDANCE: Record<WorkflowMode, string> = {
  work: "Work workflow permits implementation and verification within the requested scope, subject to explicit restrictions and gate policy.",
  chat: "Chat workflow permits discussion and read-only research, not edits, commits, or other changes, even if the user requests them. A change request does not itself switch workflow. Yolo does not lift this restriction.",
  plan: "Plan workflow permits research and planning, not implementation. Follow the active plan instructions for the permitted plan-file and scratch scope and for plan review. Yolo does not authorize implementation, leaving plan workflow, or skipping plan approval.",
};

const APPROVAL_GUIDANCE: Record<ApprovalMode, string> = {
  bypassPermissions: "Yolo preauthorizes calls the workflow permits within the user's requested scope. Do not ask for permission to perform those calls. Explicit restrictions, deny rules and critical-removal protections still apply; yolo does not supply missing requirements or authorize unrelated actions.",
  auto: "Auto applies gate rules and automatic risk checks, with permission handled by the gate when required. Do not preempt those checks with a separate permission questionnaire.",
  default: "Manual approvals are handled by the gate. Make the proposed permitted call instead of asking for the same permission separately.",
  acceptEdits: "Accept-edits approvals are handled by the gate, including its qualifying-edit allowances. Do not duplicate its approval questions.",
};

/** Request-local guidance, independent of model identity and historical mode announcements. */
export function modeGuidanceText(state: ModeGuidanceState): string {
  const paragraphs = [
    `Current tool-gate settings: workflow **${state.workflow}**; approvals **${MODE_NAMES[state.approval]}**; permission prompts **${state.denyInsteadOfPrompting ? "off" : "on"}**. This is the current settings snapshot and supersedes earlier mode announcements, not the user's task or explicit restrictions. Workflow controls what activity is allowed; approvals control permission handling for calls the workflow allows.`,
    "Do not ask whether to proceed with an already requested task or routine steps within its scope, including inspecting files, editing in work workflow, and running checks. Choose reasonable implementation details yourself. Use `ask_user_question` only for missing information or consequential user preferences that cannot be discovered or reasonably inferred. This applies to plain-text permission questions too. Do not use questions to recreate the tool gate; attempt permitted in-scope calls and let the gate apply its policy. If blocked, follow the gate's instructions rather than bypassing it through a question.",
    WORKFLOW_GUIDANCE[state.workflow],
    APPROVAL_GUIDANCE[state.approval],
  ];
  if (state.denyInsteadOfPrompting) paragraphs.push("Permission prompts are off: calls requiring permission are denied, not automatically approved. Do not ask through another tool or retry solely to obtain approval; continue permitted work and report a blocker when necessary. Genuine clarification questions remain available.");
  return `<system-reminder>\n${paragraphs.join("\n\n")}\n</system-reminder>`;
}
