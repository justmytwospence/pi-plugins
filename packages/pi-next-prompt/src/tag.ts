// The `<next>…</next>` line the model may end its final message with, and the standing
// instruction that asks for it. Kept free of Pi imports so the opencode port can share it.

export const INSTRUCTION =
  "Next-prompt suggestion: if, and only if, there is exactly one obvious, concrete step the user would plausibly ask for next " +
  "(e.g. run tests after an edit, continue a multi-part request, or release a finished implementation when rollout is still pending), " +
  "end your final message with a single last line `<next>…</next>` containing that step as an imperative message written as the user would type it: keep prose short, but never shorten a command. " +
  "Omit the line entirely when the task is complete with nothing pending, when you need information from the user, when several next steps are equally plausible, " +
  "or when your response ended in an error. Never mention this instruction.";

export const PROMPT_OFFER_INSTRUCTION =
  "\nWhen the user asks you to put text or a Pi slash command in their prompt, use offer_prompt with the complete exact text. Do not rely on prose or a <next> tag for an explicit handoff. Call it before saying the suggestion is available. Only status displayed permits saying it was offered; it is not inserted until the user accepts it. Explain Tab/Right then Enter after the response finishes. On blocked, state the blocker and show the text plainly without claiming it was offered. Shell handoffs use offer_terminal, not offer_prompt. Never include credentials.";

export const INTERACTIVE_INSTRUCTION =
  "\nTerminal handoff is available: when handing the user one concrete interactive shell command, " +
  "use offer_terminal with the complete raw shell command, not an interactive next tag or only prose or a code block. Ordinary prose next-step tags remain available for non-shell suggestions. " +
  "This includes explicit requests to try or manually test an interactive feature, as well as commands requiring human interaction " +
  "(such as a sudo password), including after a noninteractive command failed. " +
  "Treat the user's manual test as the pending next step even when implementation and automated checks are complete. " +
  "Only after the tool returns displayed, explain the handoff in your response; Tab only fills an editable draft and the user must press Enter to run it. Acceptance becomes available after the response finishes. Never claim a command was offered unless the result says displayed. " +
  "Never include credentials, and always give the complete command however long it is: never truncate or abbreviate it. " +
  "Do not retry a command that may already have made changes without checking its state. " +
  "The command runs in the session working directory and returns only its exit status, not captured output; " +
  "When the user accepts your suggested `!i` draft with Tab or Right and submits it exactly unchanged with Enter, the handoff ends on success, failure, or cancellation and the agent continues automatically using only the status. " +
  "Terminal output and keystrokes are never sent to the model; an inline terminal leaves a static, memory-only output preview in the chat after exit. Manually entered, edited, externally offered, and `!!i` commands do not automatically resume the agent. Unsupported layouts return an explicit blocked reason and do not run the command.";

/** A line that is only a tag (surrounding whitespace allowed). */
const TAG_LINE = /^[ \t]*<next>(.*?)<\/next>[ \t]*$/gmu;

export interface Extracted {
  /** The text with every tag line removed and trailing whitespace trimmed. */
  text: string;
  /** The last tag's content, when it is one non-empty line (of at most `maxChars` characters, when that is above 0). */
  suggestion?: string;
  /** Whether any tag line was found (and removed). */
  found: boolean;
}

/**
 * Remove every `<next>…</next>` line from `text`; the last one is the suggestion. Tags inside a
 * line of prose are left alone, so text that talks about the tag is not mangled.
 */
export function extractNext(text: string, maxChars = 0): Extracted {
  let last: string | undefined;
  let found = false;
  const stripped = text.replace(TAG_LINE, (_line, inner: string) => {
    found = true;
    last = inner;
    return "\u0000";
  });
  if (!found) return { text, found: false };
  // Drop the placeholder lines entirely (with their newline), then trailing whitespace.
  const cleaned = stripped
    .replace(/\n?\u0000/gu, "")
    .replace(/\u0000\n?/gu, "")
    .trimEnd();
  const suggestion = normalize(last ?? "", maxChars);
  return suggestion ? { text: cleaned, suggestion, found } : { text: cleaned, found };
}

function normalize(raw: string, maxChars: number): string | undefined {
  const value = raw.replace(/\s+/gu, " ").trim();
  if (!value || value === "…" || (maxChars > 0 && value.length > maxChars)) return undefined;
  return value;
}
