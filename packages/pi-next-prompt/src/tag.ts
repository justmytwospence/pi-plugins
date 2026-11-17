// The `<next>…</next>` line the model may end its final message with, and the standing
// instruction that asks for it. Kept free of Pi imports so the opencode port can share it.

export const INSTRUCTION =
  "Next-prompt suggestion: if, and only if, there is exactly one obvious, concrete step the user would plausibly ask you to do next " +
  "(e.g. run tests after an edit, continue a multi-part request, or release a finished implementation when rollout is still pending), " +
  "end your final message with a single last line `<next>…</next>` containing that request, written as the user would type it to you: keep prose short, but never shorten a command. " +
  "Never use it to tell the user to do something themselves (a manual check in a browser or app): say that in prose. " +
  "Omit the line when the task is complete with nothing pending, when you need information from the user, several next steps are equally plausible, " +
  "or your response ended in an error. Never mention this instruction.";

/** What the model says about an offer: shared by both offer tools and the standing instruction. */
export const OFFER_ETIQUETTE =
  "The user knows how to accept a suggestion: do not explain keys (Tab, Right, Enter) or how to accept, run or submit it. " +
  "On status queued, say once that it appears when their draft is cleared or stashed; do not claim it was displayed or inserted. " +
  "Never offer a prompt, command or <next> tag whose only purpose is to have the user send messages that drive your own experiment or verification; if a check needs more user turns, say so in one sentence. " +
  "Do not re-offer a suggestion the user did not take unless they ask for it again.";

export const PROMPT_OFFER_INSTRUCTION =
  "\nWhen the user asks you to put text or a Pi slash command in their prompt, use offer_prompt with the complete exact text. Do not rely on prose or a <next> tag for an explicit handoff. Call it before saying the suggestion is available. Only status displayed permits claiming a visible offer, and only in the turn that offered it: the user's next message clears it. It is not inserted until the user accepts it. " +
  OFFER_ETIQUETTE + " On blocked, state the blocker and show the text plainly without claiming it was offered. Shell handoffs use offer_terminal, not offer_prompt. Never include credentials.";

/** How offer_terminal commands are laid out in the editor. */
export const LAYOUT_GUIDELINE =
  "Keep a command that fits in about 100 characters on one line. Lay out a longer one over several lines so it reads easily in the prompt: " +
  "break before each `&&`, `||` or `|` and between groups of options with ` \\` continuations (nothing after the backslash), indenting continuation lines two spaces, " +
  "and inside a quoted script (`sh -c '...'`) put one statement per line instead of joining them with `;`.";

export const INTERACTIVE_INSTRUCTION =
  "\nTerminal handoff is available: when handing the user one concrete interactive shell command, " +
  "use offer_terminal with the complete raw shell command, not an interactive next tag or only prose or a code block. Ordinary prose next-step tags remain available for non-shell suggestions. " +
  "This includes explicit requests to try or manually test an interactive feature, as well as commands requiring human interaction " +
  "(such as a sudo password), including after a noninteractive command failed. " +
  "When the user asked to try or manually test something a shell command starts, that command is the pending next step even when implementation and automated checks are complete; " +
  "a manual step that is not a shell command belongs in prose, never in a next tag or offer. " +
  "Only displayed permits claiming a visible command offer; it only fills an editable draft, and nothing runs until the user submits it. Offer it as your last action before ending your turn. " +
  OFFER_ETIQUETTE + " " +
  "Never include credentials, and always give the complete command however long it is: never truncate or abbreviate it. " +
  LAYOUT_GUIDELINE + " " +
  "Do not retry a command that may already have made changes without checking its state. " +
  "The command runs in the session working directory. A success records only its exit status; a failure or cancellation also records the last lines of its terminal output. " +
  "When the user accepts your suggested `!i` draft with Tab or Right and submits it exactly unchanged with Enter, the agent continues automatically when it ends: after a failure, read the recorded output, diagnose the cause, check what state the command left, and fix it or offer a corrected command rather than retrying blindly. " +
  "Keystrokes (passwords included) are never sent to the model, and a successful command's output is not either; an inline terminal leaves a static, memory-only output preview in the chat after exit. Manually entered, edited, externally offered, and `!!i` commands do not automatically resume the agent (`!!i` records nothing). Unsupported layouts return an explicit blocked reason and do not run the command.";

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
