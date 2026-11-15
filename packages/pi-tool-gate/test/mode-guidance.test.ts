import { describe, expect, test } from "vitest";
import { MODE_GUIDANCE_TYPE, MODE_SETTINGS_NOTICE_TYPE, modeGuidanceText } from "../src/mode-guidance.ts";
import { APPROVAL_MODES, MODE_NAMES, type WorkflowMode } from "../src/modes.ts";

const workflows: WorkflowMode[] = ["work", "chat", "plan"];
const workflowText = {
  work: "Work workflow permits implementation and verification within the requested scope, subject to explicit restrictions and gate policy.",
  chat: "Chat workflow permits discussion and read-only research, not edits, commits, or other changes, even if the user requests them. A change request does not itself switch workflow. Yolo does not lift this restriction.",
  plan: "Plan workflow permits research and planning, not implementation. Follow the active plan instructions for the permitted plan-file and scratch scope and for plan review. Yolo does not authorize implementation, leaving plan workflow, or skipping plan approval.",
};
const approvalText = {
  bypassPermissions: "Yolo preauthorizes calls the workflow permits within the user's requested scope. Do not ask for permission to perform those calls. Explicit restrictions, deny rules and critical-removal protections still apply; yolo does not supply missing requirements or authorize unrelated actions.",
  auto: "Auto applies gate rules and automatic risk checks, with permission handled by the gate when required. Do not preempt those checks with a separate permission questionnaire.",
  default: "Manual approvals are handled by the gate. Make the proposed permitted call instead of asking for the same permission separately.",
  acceptEdits: "Accept-edits approvals are handled by the gate, including its qualifying-edit allowances. Do not duplicate its approval questions.",
};
const promptingOff = "Permission prompts are off: calls requiring permission are denied, not automatically approved. Do not ask through another tool or retry solely to obtain approval; continue permitted work and report a blocker when necessary. Genuine clarification questions remain available.";

const cases = workflows.flatMap(workflow => APPROVAL_MODES.flatMap(approval =>
  [false, true].map(denyInsteadOfPrompting => ({ workflow, approval, denyInsteadOfPrompting }))));

test("guidance and busy notices have distinct stable custom types", () => {
  expect(MODE_GUIDANCE_TYPE).toBe("tool-gate:mode-guidance");
  expect(MODE_SETTINGS_NOTICE_TYPE).toBe("tool-gate:mode-settings-notice");
});

describe("shared current-mode guidance", () => {
  test.each(cases)("$workflow / $approval / denyInsteadOfPrompting=$denyInsteadOfPrompting", state => {
    const text = modeGuidanceText(state);
    expect(text).toBe(modeGuidanceText({ ...state }));
    expect(text).toMatch(/^<system-reminder>\n/u);
    expect(text).toMatch(/\n<\/system-reminder>$/u);
    expect(text).toContain(`Current tool-gate settings: workflow **${state.workflow}**; approvals **${MODE_NAMES[state.approval]}**; permission prompts **${state.denyInsteadOfPrompting ? "off" : "on"}**.`);
    expect(text).toContain("supersedes earlier mode announcements, not the user's task or explicit restrictions");
    expect(text).toContain("Workflow controls what activity is allowed; approvals control permission handling for calls the workflow allows.");
    expect(text).toContain("Do not ask whether to proceed with an already requested task or routine steps within its scope, including inspecting files, editing in work workflow, and running checks.");
    expect(text).toContain("Choose reasonable implementation details yourself.");
    expect(text).toContain("Use `ask_user_question` only for missing information or consequential user preferences that cannot be discovered or reasonably inferred.");
    expect(text).toContain("This applies to plain-text permission questions too.");
    expect(text).toContain("Do not use questions to recreate the tool gate; attempt permitted in-scope calls and let the gate apply its policy.");
    expect(text).toContain("If blocked, follow the gate's instructions rather than bypassing it through a question.");
    for (const workflow of workflows) {
      if (workflow === state.workflow) expect(text).toContain(workflowText[workflow]);
      else expect(text).not.toContain(workflowText[workflow]);
    }
    for (const approval of APPROVAL_MODES) {
      if (approval === state.approval) expect(text).toContain(approvalText[approval]);
      else expect(text).not.toContain(approvalText[approval]);
    }
    if (state.denyInsteadOfPrompting) expect(text).toContain(promptingOff);
    else expect(text).not.toContain(promptingOff);
    expect(text.split("\n\n")).toHaveLength(state.denyInsteadOfPrompting ? 5 : 4);
    expect(text).not.toMatch(/astra|anthropic|claude|model.family/iu);
  });
});
