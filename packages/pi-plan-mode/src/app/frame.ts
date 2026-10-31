import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { FamilyService } from "../family-contract.js";

export type PlanningViewFactory = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: () => void,
  viewport: () => { width: number; height: number },
) => Component;

/** The hosted path never adds or removes a fullscreen overlay. */
export async function openPlanningView(
  ctx: ExtensionContext,
  family: FamilyService | undefined,
  factory: PlanningViewFactory,
) {
  if (family) {
    await family.view({
      factory: (tui, theme, keybindings, done, viewport) =>
        factory(tui, theme as Theme, keybindings as KeybindingsManager, done, viewport),
    });
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      factory(tui, theme, keybindings, done, () => ({ width: tui.terminal.columns, height: tui.terminal.rows })),
    FULL_SCREEN as never,
  );
}

import { rule, titleLine, type WorkflowStep } from "../ui-kit.js";

/** Every page starts the same way: a rule, then the title with the steps at the top right. */
export function pageHeader(theme: Theme, width: number, title: string, context: string, step: WorkflowStep) {
  return [rule(theme, width, "borderAccent"), titleLine(theme, width, title, context, step), rule(theme, width)];
}

/** Full-screen overlay options: the plan app covers the whole terminal. */
export const FULL_SCREEN = {
  overlay: true,
  overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
} as const;
