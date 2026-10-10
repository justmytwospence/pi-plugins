// What the pane says about a pi session: its title (the session name, else the first prompt) and
// the displayed agent name (pi plus model and effort), so Goto and the Agents panel tell apart
// several agents working in one repo.
import { shortModel } from "./core/text.ts";

export { shortModel, titleFromPrompt } from "./core/text.ts";

export function displayAgent(modelId: string | undefined, thinking: string | undefined): string {
  const model = shortModel(modelId);
  if (!model) return "pi";
  return thinking && thinking !== "off" ? `pi ${model}:${thinking}` : `pi ${model}`;
}

interface EntryLike {
  type: string;
  message?: { role?: string; content?: unknown };
}

/** The text of the session's first user message, if any. */
export function firstUserText(entries: readonly EntryLike[]): string | undefined {
  for (const e of entries) {
    if (e.type !== "message" || e.message?.role !== "user") continue;
    const c = e.message.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const text = c
        .filter((p): p is { type: string; text: string } => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n");
      if (text) return text;
    }
  }
  return undefined;
}
