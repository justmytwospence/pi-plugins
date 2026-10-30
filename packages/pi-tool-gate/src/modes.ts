// Independent workflow and approval state. Both providers are optional; no sibling imports.
// Event bus contract (shared with pi-plan-mode):
//   workflow-mode:set           any -> gate { mode: work|chat|plan } requests a base transition
//   workflow-mode:cycle         any -> gate {} requests the next base workflow
//   workflow-mode:changed       gate -> all { mode: work|chat|plan|exec, previous?, cycle: BaseWorkflowMode[], key?, source: transition|restore }
//     Restore/capability announcements are snapshots, never user transitions.
//   workflow-mode:plan-provider plan -> gate { planFile? } announces plan support and its file
//   workflow-mode:exec          plan -> gate { active: boolean, source: transition|restore } publishes the exec lifecycle
//     Gate ignores restore publications; its own lifecycle hook folds the destination branch.
//   workflow-mode:query         any -> gate { entries: readonly unknown[], cwd: string, reply(snapshot): void }
//     Synchronously replies with { mode, cycle, key?, source: restore } using destination entries/cwd defaults.
//     Registered at factory time; no mutations, persistence, notices, or further events.
//   permission-mode:set         any -> gate { mode } requests approvals only
//   permission-mode:cycle       any -> gate {} toggles auto/yolo
//   permission-mode:changed     gate -> all { mode, previous?, cycle } publishes approvals only

export type WorkflowMode = "work" | "chat" | "plan" | "exec";
export type BaseWorkflowMode = Exclude<WorkflowMode, "exec">;
export const APPROVAL_MODES = ["auto", "bypassPermissions", "default", "acceptEdits"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export type LegacyCombinedMode = ApprovalMode | "chat" | "plan";

export const MODE_CHANGED = "permission-mode:changed";
export const MODE_SET = "permission-mode:set";
export const MODE_CYCLE = "permission-mode:cycle";
export const WORKFLOW_CHANGED = "workflow-mode:changed";
export const WORKFLOW_SET = "workflow-mode:set";
export const WORKFLOW_QUERY = "workflow-mode:query";
export type WorkflowSource = "transition" | "restore";
export interface WorkflowSnapshot {
  mode: WorkflowMode;
  cycle: BaseWorkflowMode[];
  key?: string;
  source: WorkflowSource;
}
export const WORKFLOW_CYCLE = "workflow-mode:cycle";
export const PLAN_PROVIDER = "workflow-mode:plan-provider";
export const EXEC_CHANGED = "workflow-mode:exec";
export const MODE_STATUS_KEY = "permission-mode";
export const WORKFLOW_STATUS_KEY = "workflow-mode";
export const MODE_ENTRY = "tool-gate:mode"; // legacy migration only
export const WORKFLOW_ENTRY = "tool-gate:workflow";
export const APPROVAL_ENTRY = "tool-gate:approvals";
export const APPROVAL_CYCLE: ApprovalMode[] = ["auto", "bypassPermissions"];
export const EXEC_GUIDANCE = "Exec is active. Use /plan-exec for its status and recovery actions, or /plan-exec stop to leave exec.";

export const MODE_NAMES: Record<ApprovalMode, string> = {
  default: "manual (legacy)", acceptEdits: "accept edits (legacy)", auto: "auto", bypassPermissions: "yolo",
};
export const MODE_DESCRIPTIONS: Record<ApprovalMode, string> = {
  default: "Ask before every edit, write and command that does more than read.",
  acceptEdits: "Edits, writes and filesystem commands inside the project run; other commands ask.",
  auto: "The gate judges each call; you are asked only about risky ones the agent cannot work around.",
  bypassPermissions: "Everything runs, except removing / , home, the project or a parent of them.",
};
export const MODE_LABELS: Record<ApprovalMode, string> = {
  default: "⏸ manual (legacy) mode on", acceptEdits: "⏵⏵ accept edits (legacy) on",
  auto: "⏵⏵ auto mode on", bypassPermissions: "⏵⏵ yolo mode on",
};

/** Explicitly legacy: chat/plan here represent the old combined axis. */
export function parseLegacyCombinedMode(value: unknown): LegacyCombinedMode | undefined {
  if (typeof value !== "string") return undefined;
  const aliases: Record<string, LegacyCombinedMode> = {
    chat: "chat", ask: "chat", default: "default", manual: "default", acceptedits: "acceptEdits", edits: "acceptEdits",
    plan: "plan", auto: "auto", bypass: "bypassPermissions", bypasspermissions: "bypassPermissions", yolo: "bypassPermissions",
  };
  const key = value.trim().toLowerCase().replace(/[\s_-]/gu, "");
  return Object.hasOwn(aliases, key) ? aliases[key] : undefined;
}
export function parseApproval(value: unknown): ApprovalMode | undefined {
  const mode = parseLegacyCombinedMode(value);
  return mode === "chat" || mode === "plan" ? undefined : mode;
}
export function parseWorkflow(value: unknown): BaseWorkflowMode | undefined {
  return value === "work" || value === "chat" || value === "plan" ? value : undefined;
}
export function workflowCycle(planAvailable: boolean): BaseWorkflowMode[] {
  return planAvailable ? ["work", "chat", "plan"] : ["work", "chat"];
}
export function nextWorkflow(current: WorkflowMode, planAvailable: boolean): WorkflowMode {
  if (current === "exec") return current;
  const cycle = workflowCycle(planAvailable);
  return cycle[(cycle.indexOf(current) + 1) % cycle.length]!;
}
export function nextApproval(current: ApprovalMode): ApprovalMode {
  return current === "auto" ? "bypassPermissions" : "auto";
}
export function modeStatus(mode: ApprovalMode, shortcut: string | undefined): string {
  return `${MODE_LABELS[mode]}${shortcut ? ` (${shortcut} to cycle)` : ""}`;
}
export function workflowStatus(mode: WorkflowMode, shortcut: string | undefined): string {
  return `workflow: ${mode}${shortcut && mode !== "exec" ? ` (${shortcut} to cycle)` : ""}`;
}
export interface BranchModes { workflow: BaseWorkflowMode; approval: ApprovalMode; execActive: boolean }

/** Fold only the active branch, in chronological order. Invalid records never escalate permissions. */
export function restoreBranchModes(entries: readonly unknown[], defaults: BranchModes): BranchModes {
  const state = { ...defaults };
  for (const raw of entries) {
    const entry = raw as { type?: string; customType?: string; data?: Record<string, unknown> } | null;
    if (entry?.type !== "custom" || !entry.data || typeof entry.data !== "object") continue;
    const { customType, data } = entry;
    if (customType === MODE_ENTRY) {
      const mode = parseLegacyCombinedMode(data.mode);
      if (mode === "chat" || mode === "plan") state.workflow = mode;
      else if (mode) { state.approval = mode; state.workflow = "work"; }
    } else if (customType === WORKFLOW_ENTRY && data.version === 1) {
      const mode = parseWorkflow(data.mode);
      if (mode) state.workflow = mode;
    } else if (customType === APPROVAL_ENTRY && data.version === 1) {
      // New durable entries use internal values, not permissive interpretations of invalid input.
      if (APPROVAL_MODES.includes(data.mode as ApprovalMode)) state.approval = data.mode as ApprovalMode;
    } else if (customType === "plan-mode:inline" && typeof data.active === "boolean") {
      if (data.active) state.workflow = "plan";
      else if (state.workflow === "plan") state.workflow = "work";
    } else if (customType === "plan-mode:exec" && typeof data.active === "boolean") {
      if (state.execActive && !data.active) state.workflow = "work";
      state.execActive = data.active;
    }
  }
  return state;
}
