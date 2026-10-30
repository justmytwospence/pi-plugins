import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export type WorkflowKind = "work" | "chat" | "plan" | "exec";

export function isWorkflowKind(value: unknown): value is WorkflowKind {
  return value === "work" || value === "chat" || value === "plan" || value === "exec";
}

export const WORKFLOW_ROLES = {
  work: "success",
  chat: "thinkingLow",
  plan: "customMessageLabel",
  exec: "warning",
} as const satisfies Record<WorkflowKind, Parameters<Theme["fg"]>[0]>;

export const WORKFLOW_EXPLANATIONS: Record<WorkflowKind, string> = {
  work: "edits and actions",
  chat: "read-only discussion",
  plan: "research and plan only",
  exec: "implementing approved plan",
};

export function workflowBadge(theme: Pick<Theme, "fg" | "bold">, mode: WorkflowKind): string {
  return theme.bold(theme.fg(WORKFLOW_ROLES[mode], `[${mode.toUpperCase()}]`));
}

export function registerWorkflowRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("workflow:transition", (message, _options, theme) => {
    const details = message.details as { version?: unknown; previous?: unknown; mode?: unknown } | undefined;
    if (
      details?.version !== 1 ||
      !isWorkflowKind(details.previous) ||
      !isWorkflowKind(details.mode) ||
      details.previous === details.mode
    ) {
      return new Text(
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
        0,
        0,
      );
    }
    return new Text(
      `${workflowBadge(theme, details.mode)}${theme.fg("dim", " · ")}${theme.fg("muted", WORKFLOW_EXPLANATIONS[details.mode])}`,
      0,
      0,
    );
  });
}

export function sendWorkflowTransition(pi: ExtensionAPI, previous: WorkflowKind, mode: WorkflowKind): void {
  if (previous === mode) return;
  pi.sendMessage(
    {
      customType: "workflow:transition",
      content: `${mode.toUpperCase()} · ${WORKFLOW_EXPLANATIONS[mode]}`,
      display: true,
      details: { version: 1, previous, mode },
    },
    { triggerTurn: false },
  );
}
