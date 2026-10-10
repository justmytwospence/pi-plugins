// Without a UI (print and JSON modes) there is nobody to ask, so the tool is taken out of the
// model's tool list; it comes back when a UI is present again. Only a removal made here is undone,
// so a tool list another extension narrowed on purpose is left alone.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOL_NAME } from "./schema.ts";

type ToolSet = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;

/** Returns whether the tool is now removed by this reconciler. */
export function reconcile(pi: ToolSet, hasUI: boolean, removed: boolean): boolean {
  const active = pi.getActiveTools();
  const present = active.includes(TOOL_NAME);
  if (!hasUI && present) {
    pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
    return true;
  }
  if (hasUI && removed && !present) {
    pi.setActiveTools([...active, TOOL_NAME]);
    return false;
  }
  return removed && !hasUI;
}
