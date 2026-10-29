import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Turn `names` on or off among the session's active tools (others stay as they are). */
export function setToolsActive(pi: ExtensionAPI, names: readonly string[], active: boolean) {
  let current: string[];
  try {
    current = pi.getActiveTools();
  } catch {
    return;
  }
  const others = current.filter((name) => !names.includes(name));
  const next = active ? [...others, ...names] : others;
  if (next.length === current.length && next.every((name) => current.includes(name))) return;
  try {
    pi.setActiveTools(next);
  } catch {
    // A session without tool control keeps what it has.
  }
}
