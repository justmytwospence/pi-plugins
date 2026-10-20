// Sidebar's tool policy: deny by default. Tools stay declared (removing them would change the
// request prefix and lose main's cache); calls are blocked here instead.
import { findBlockedCommandSegment, findBlockedPowerShellCommandSegment, readCommand } from "./bash-policy.ts";

/** Tools that only read. Nested codemode calls reach this gate one by one, so codemode is safe. */
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
]);

export type Verdict = { allowed: true } | { allowed: false; reason: string };

const PREFIX = "Sidebar is read-only";

export function judgeToolCall(toolName: string, input: unknown, cwd?: string): Verdict {
  if (READ_ONLY_TOOLS.has(toolName)) return { allowed: true };
  if (toolName === "bash" || toolName === "powershell") {
    const command = readCommand(input);
    const blocked = toolName === "bash"
      ? findBlockedCommandSegment(command, {}, cwd)
      : findBlockedPowerShellCommandSegment(command, {}, cwd);
    if (blocked === undefined) return { allowed: true };
    return {
      allowed: false,
      reason: `${PREFIX}: \`${blocked.trim().slice(0, 200)}\` may change something, so it was not run. Use read-only commands (ls, cat, rg, git log/diff/show, ...) or the read/grep/find tools. If the user wants a change, tell them to ask the main session.`,
    };
  }
  return {
    allowed: false,
    reason: `${PREFIX}: the ${toolName} tool is not available here. Only reading tools and read-only shell commands run in Sidebar. If the user wants a change, tell them to ask the main session.`,
  };
}
