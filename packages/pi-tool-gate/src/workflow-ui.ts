import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Row, registerRowRun } from "./transcript-style.js";

export type WorkflowKind = "work" | "chat" | "plan";

export function isWorkflowKind(value: unknown): value is WorkflowKind {
  return value === "work" || value === "chat" || value === "plan";
}

export const WORKFLOW_ROLES = {
  work: "success",
  chat: "thinkingLow",
  plan: "customMessageLabel",
} as const satisfies Record<WorkflowKind, Parameters<Theme["fg"]>[0]>;

export const WORKFLOW_EXPLANATIONS: Record<WorkflowKind, string> = {
  work: "edits and actions",
  chat: "read-only discussion",
  plan: "research and plan only",
};

export function workflowBadge(theme: Pick<Theme, "fg" | "bold">, mode: WorkflowKind): string {
  return theme.bold(theme.fg(WORKFLOW_ROLES[mode], mode));
}

interface WorkflowRow {
  previous: WorkflowKind;
  mode: WorkflowKind;
}

const rowRuns = new WeakMap<ExtensionAPI, { append(ctx: ExtensionContext, data: WorkflowRow): void }>();

export function registerWorkflowRenderer(pi: ExtensionAPI): void {
  rowRuns.set(
    pi,
    registerRowRun<WorkflowRow>(pi, {
      anchorType: "workflow:row",
      stateType: "workflow:row-state",
      sameRun: () => true,
      merge: (a, b) => ({ previous: a.previous, mode: b.mode }),
      render: ({ data, time }, theme) => {
        if (!isWorkflowKind(data?.previous) || !isWorkflowKind(data?.mode) || data.previous === data.mode)
          return undefined;
        const mode = data.mode;
        return new Row(theme, () => ({
          tone: "info",
          title: mode,
          titleColor: WORKFLOW_ROLES[mode],
          detail: WORKFLOW_EXPLANATIONS[mode],
          time,
        }));
      },
    }),
  );
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
    const mode = details.mode;
    return new Row(theme, () => ({
      tone: "info",
      title: mode,
      titleColor: WORKFLOW_ROLES[mode],
      detail: WORKFLOW_EXPLANATIONS[mode],
      time: message.timestamp,
    }));
  });
}

export function sendWorkflowTransition(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  previous: WorkflowKind,
  mode: WorkflowKind,
): void {
  if (previous === mode) return;
  // Only the TUI draws the coalescing row; RPC and print keep the visible message as their feedback.
  const tui = ctx.mode === "tui" && ctx.hasUI;
  pi.sendMessage(
    {
      customType: "workflow:transition",
      content: `${mode} · ${WORKFLOW_EXPLANATIONS[mode]}`,
      display: !tui,
      details: { version: 1, previous, mode },
    },
    { triggerTurn: false },
  );
  if (tui) rowRuns.get(pi)?.append(ctx, { previous, mode });
}
