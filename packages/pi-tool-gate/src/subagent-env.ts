// Subagents start with the parent's approval setting. pi-subagents asks the optional
// `pi-plugins.subagent-env.v1` channel for extra environment before a child starts (no import
// either way); the child's gate reads it as its starting setting when its branch records none.
// A parent in chat or plan starts children in chat, so a subagent cannot do what the parent's
// workflow forbids.
import { APPROVAL_MODES, type ApprovalMode } from "./modes.ts";

export const SUBAGENT_ENV_CHANNEL = "pi-plugins.subagent-env.v1";
export const APPROVAL_ENV = "PI_TOOL_GATE_APPROVAL";
export const WORKFLOW_ENV = "PI_TOOL_GATE_WORKFLOW";

export interface SubagentEnvRequest {
  version: 1;
  env: Record<string, string>;
  probe?: boolean;
}

/** What a child about to start inherits from this session's modes. */
export function subagentEnv(approval: ApprovalMode, workflow: string): Record<string, string> {
  return { [APPROVAL_ENV]: approval, ...(workflow === "chat" || workflow === "plan" ? { [WORKFLOW_ENV]: "chat" } : {}) };
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
export function inheritedModes(env: NodeJS.ProcessEnv = process.env): { approval?: ApprovalMode; workflow?: "chat" } {
  if (!env.PI_SUBAGENT) return {};
  const approval = env[APPROVAL_ENV];
  return {
    ...(APPROVAL_MODES.includes(approval as ApprovalMode) ? { approval: approval as ApprovalMode } : {}),
    ...(env[WORKFLOW_ENV] === "chat" ? { workflow: "chat" as const } : {}),
  };
}
