// What an approval dialog asks about, as data. Remote hosts (Switchyard's adapter) get only the
// dialog's title text; this session entry, appended just before the dialog opens, lets them show the
// same facts without parsing that text. Never read back by the gate: decisions do not depend on it.

export const APPROVAL_REQUEST_ENTRY = "tool-gate:approval-request";

export interface ApprovalRequest {
  version: 1;
  /** The dialog's exact title, which a remote host matches the dialog by. */
  title: string;
  tool: string;
  action: string;
  target: string;
  cwd: string;
  /** A shell tool's command. */
  command?: string;
  /** Why the gate held the call. */
  held?: string;
  /** The agent's case for the call, as the dialog shows it. */
  agent?: string;
  note?: string;
  /** What an allow choice would save: rules or folders, and where project saves go. */
  offer?: { kind: "rules" | "dirs"; items: string[]; saves?: string };
  /** What was wrong with the last edited rule. */
  problem?: string;
}

const COMMAND_LIMIT = 4_000;

export function approvalRequest(r: Omit<ApprovalRequest, "version">): ApprovalRequest {
  const command = r.command && r.command.length > COMMAND_LIMIT ? `${r.command.slice(0, COMMAND_LIMIT - 1)}…` : r.command;
  return {
    version: 1,
    title: r.title,
    tool: r.tool,
    action: r.action,
    target: r.target,
    cwd: r.cwd,
    ...(command ? { command } : {}),
    ...(r.held !== undefined ? { held: r.held } : {}),
    ...(r.agent !== undefined ? { agent: r.agent } : {}),
    ...(r.note ? { note: r.note } : {}),
    ...(r.offer && r.offer.items.length ? { offer: r.offer } : {}),
    ...(r.problem ? { problem: r.problem } : {}),
  };
}
