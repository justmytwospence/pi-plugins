// Subagents start with the parent's approval setting. pi-subagents asks the optional
// `pi-plugins.subagent-env.v1` channel for extra environment before a child starts (no import
// either way); the child's gate reads it as its starting setting when its branch records none.
// A parent in chat starts children in chat, and a parent in plan starts them in plan with the
// parent's scratch directory (no plan file: they cannot enter or exit plan mode), so a subagent
// cannot do what the parent's workflow forbids.
import path from "node:path";
import { APPROVAL_MODES, type ApprovalMode } from "./modes.ts";

export const SUBAGENT_ENV_CHANNEL = "pi-plugins.subagent-env.v1";
export const APPROVAL_ENV = "PI_TOOL_GATE_APPROVAL";
export const WORKFLOW_ENV = "PI_TOOL_GATE_WORKFLOW";
/** The directory a planning parent lets its children write scratch files under. */
export const SCRATCH_ENV = "PI_TOOL_GATE_SCRATCH";
export const PROMPTING_ENV = "PI_TOOL_GATE_DENY_INSTEAD_OF_PROMPTING";

export interface SubagentEnvRequest {
  version: 1;
  env: Record<string, string>;
  probe?: boolean;
  /** Set by a subagent provider (pi-subagents) answering a probe. */
  supported?: boolean;
}

/** What a child about to start inherits from this session's modes. */
export function subagentEnv(approval: ApprovalMode, workflow: string, denyInsteadOfPrompting: boolean, scratchDir?: string): Record<string, string> {
  return {
    [APPROVAL_ENV]: approval,
    [PROMPTING_ENV]: String(denyInsteadOfPrompting),
    ...(workflow === "chat" ? { [WORKFLOW_ENV]: "chat" } : {}),
    ...(workflow === "plan" ? { [WORKFLOW_ENV]: "plan", ...(scratchDir ? { [SCRATCH_ENV]: scratchDir } : {}) } : {}),
  };
}

/**
 * Whether a subagent provider (pi-subagents) will ask this channel for a child's environment, so a
 * chat or plan parent's children start under the parent's workflow. Probes the channel; false when nothing answers.
 */
export function subagentEnvHonored(events: { emit(channel: string, data: unknown): void } | undefined): boolean {
  if (!events) return false;
  const request: SubagentEnvRequest = { version: 1, env: {}, probe: true };
  try {
    events.emit(SUBAGENT_ENV_CHANNEL, request);
  } catch {
    return false;
  }
  return request.supported === true;
}

/** Fill a subagent-env request; ignores probes and anything malformed. */
export function answerSubagentEnv(data: unknown, env: () => Record<string, string>): void {
  const request = data as Partial<SubagentEnvRequest> | undefined;
  if (request?.version !== 1 || request.probe || !request.env || typeof request.env !== "object") return;
  Object.assign(request.env, env());
}

/**
 * The starting modes this process inherited as a subagent; nothing outside one (`PI_SUBAGENT`), so
 * a stray variable in an ordinary session changes nothing.
 */
export function inheritedModes(env: NodeJS.ProcessEnv = process.env): { approval?: ApprovalMode; workflow?: "chat" | "plan"; scratchDir?: string; denyInsteadOfPrompting?: boolean } {
  if (!env.PI_SUBAGENT) return {};
  const approval = env[APPROVAL_ENV];
  const scratch = env[SCRATCH_ENV];
  return {
    ...(APPROVAL_MODES.includes(approval as ApprovalMode) ? { approval: approval as ApprovalMode } : {}),
    ...(env[WORKFLOW_ENV] === "chat" ? { workflow: "chat" as const } : {}),
    ...(env[WORKFLOW_ENV] === "plan" ? { workflow: "plan" as const, ...(scratch && path.isAbsolute(scratch) ? { scratchDir: scratch } : {}) } : {}),
    ...(env[PROMPTING_ENV] === "true" || env[PROMPTING_ENV] === "false" ? { denyInsteadOfPrompting: env[PROMPTING_ENV] === "true" } : {}),
  };
}
