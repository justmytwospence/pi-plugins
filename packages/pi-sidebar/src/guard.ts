// Sidebar's one rule: use anything main can, change nothing. Every tool call passes this guard,
// in Sidebar and in the subagents it starts. Tools stay declared (removing them would change the
// request prefix and lose main's cache); calls are refused here instead.
//
// Known tools are decided by name; shell commands by the read-only shell policy; anything the
// policy or the names cannot clear (an unfamiliar command, an extension or MCP tool without hints)
// by one Jev judgment of whether the call changes anything. Without Jev those calls are refused.
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { findBlockedCommandSegment, findBlockedPowerShellCommandSegment, readCommand } from "./bash-policy.ts";
import { askJevBool } from "./jev.ts";

/** Tools that change files or shared state, or need a person Sidebar cannot reach. */
export const REFUSED_TOOLS = new Set([
  "edit",
  "write",
  "todo",
  "ask_user_question",
  "enter_plan_mode",
  "exit_plan_mode",
  "herdr",
  "herdr_child",
]);

/** Tools that only read or look things up. Nested codemode calls reach this guard one by one. */
export const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "fetch_content",
  "get_search_content",
  "source_check",
  "web_enable",
  "tool_search",
  "codemode",
  "bg_wait",
  "bg_logs",
  "bg_kill",
]);

/** Tools whose effect is the shell command they run. */
const COMMAND_TOOLS = new Set(["bash", "powershell", "bg_run"]);

/** Subagents run under this guard too (see SUBAGENT_ENV_CHANNEL), so starting one is allowed. */
export const SUBAGENT_TOOL = "subagent";

/** Refuse when Jev puts the chance that a call changes something at or above this. */
export const CHANGE_THRESHOLD = 0.5;

export type Verdict = { allowed: true; why?: string } | { allowed: false; reason: string };

export interface GuardHost {
  cwd: string;
  /** Pi's model registry (for Jev); undefined means no Jev. */
  registry: unknown;
  tool(name: string): Pick<ToolInfo, "name" | "description" | "annotations"> | undefined;
  /** Whether a subagent started now would run under this guard. */
  subagentsGuarded(): boolean;
  signal?: AbortSignal;
}

const PREFIX = "Sidebar is read-only";

const refuse = (reason: string): Verdict => ({ allowed: false, reason: `${PREFIX}: ${reason} If the user wants a change, tell them to ask the main session.` });

export async function judgeCall(toolName: string, input: unknown, host: GuardHost): Promise<Verdict> {
  if (REFUSED_TOOLS.has(toolName)) return refuse(`the ${toolName} tool changes files or shared state, so it was not run.`);
  const info = host.tool(toolName);
  if (info?.annotations?.destructiveHint === true) return refuse(`${toolName} is marked destructive, so it was not run.`);
  if (READ_ONLY_TOOLS.has(toolName)) return { allowed: true };
  if (info?.annotations?.readOnlyHint === true) return { allowed: true, why: "read-only hint" };
  if (toolName === SUBAGENT_TOOL) {
    return host.subagentsGuarded() ? { allowed: true } : refuse("subagents here would not run under Sidebar's guard (pi-subagents is too old), so none was started.");
  }
  if (COMMAND_TOOLS.has(toolName)) {
    const command = readCommand(input);
    const blocked = toolName === "powershell"
      ? findBlockedPowerShellCommandSegment(command, {}, host.cwd)
      : findBlockedCommandSegment(command, {}, host.cwd);
    if (blocked === undefined) return { allowed: true };
    return askJev(host, toolName, info?.description, { command }, `\`${blocked.trim().slice(0, 200)}\``);
  }
  return askJev(host, toolName, info?.description, input, `the ${toolName} call`);
}

/** The question Jev answers for a call the rules cannot settle. */
export const CHANGE_QUESTION = {
  instructions:
    "An agent that must not change anything wants to make this tool call. Would running it change anything: create, modify or delete files; change git state; start, stop or signal processes; install software; or change remote or shared state (sending messages, posting, writing to services)? Reading files, searching, listing, fetching web pages and printing output change nothing.",
  criteria: { true: "running it would change something", false: "it only reads or looks things up" },
};

/** What Jev is told about a call: the tool, its description, the arguments (as JSON, clipped) and the directory. */
export function changeState(tool: string, description: string | undefined, input: unknown, cwd: string): Record<string, unknown> {
  let args = "";
  try { args = JSON.stringify(input) ?? ""; } catch { args = String(input); }
  return {
    tool,
    ...(description ? { tool_description: description.slice(0, 1_000) } : {}),
    arguments: args.slice(0, 4_000),
    working_directory: cwd,
  };
}

async function askJev(host: GuardHost, tool: string, description: string | undefined, input: unknown, what: string): Promise<Verdict> {
  const answer = await askJevBool(host.registry, changeState(tool, description, input, host.cwd), CHANGE_QUESTION, host.signal);
  if (!answer.ok) return refuse(`${what} could not be confirmed to change nothing (${answer.reason}), so it was not run. Use reading tools or plainly read-only commands.`);
  if (answer.probability < CHANGE_THRESHOLD) return { allowed: true, why: `${Math.round(answer.probability * 100)}% chance of a change` };
  return refuse(`${what} may change something (${Math.round(answer.probability * 100)}% likely), so it was not run.`);
}

/**
 * Optional contract with pi-subagents: before it starts a subagent it asks this channel for extra
 * environment; Sidebar adds GUARD_ENV so the subagent's own pi-sidebar runs only this guard.
 * A probe (`{ version: 1, probe: true }`) tells Sidebar whether pi-subagents asks at all.
 */
export const SUBAGENT_ENV_CHANNEL = "pi-plugins.subagent-env.v1";
export const GUARD_ENV = "PI_SIDEBAR_GUARD";

export interface SubagentEnvRequest {
  version: 1;
  /** Filled by listeners: extra environment for the subagent. */
  env: Record<string, string>;
  /** Set by pi-subagents when it answers a probe. */
  supported?: boolean;
  probe?: boolean;
}
