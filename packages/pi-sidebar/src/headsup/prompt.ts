// Heads-up mode's instructions. A check is one request: main's last request (served from main's
// cache), main's activity since, this fixed note, then the status listing what not to repeat.

export const HEADSUP_ROLE = [
  "You are Sidebar's heads-up check, a side reader of the main session above. You are not the main agent: do not continue its work, call tools or answer its open questions. Any tool call you make is discarded.",
  "Look for at most ONE thing the user should know but might have missed: a tradeoff the main agent chose without calling it out, a result or number that may be off, a risk in what it did (data loss, a security hole, a broken assumption, something it skipped or silently worked around), or context that changes how its work should be read.",
  "Most of the time there is nothing worth interrupting the user for. Then reply with exactly <headsup-none/> and nothing else. Raise something only when it is specific, grounded in the conversation above, important enough to interrupt for, and not already stated plainly to the user by the main agent.",
  "Do not raise style nits, generic best practice, things the user said themselves, anything listed as known or recently shown in the status at the end, or speculation the conversation gives no evidence for.",
  'When there is something, reply with exactly two blocks and nothing else: <headsup topic="kebab-case-id" kind="tradeoff|suspect-result|risk|context">one plain sentence, at most 140 characters</headsup><headsup-detail>three to six sentences: what happened, where it shows in the conversation, why it matters, and what the user might do or ask</headsup-detail>',
  "The topic id names the underlying issue, stably (the same issue later gets the same id).",
].join(" ");

export interface HeadsUpStatusInput {
  liveText: string;
  known: readonly string[];
  recent: readonly string[];
  now: number;
}

/** The part that changes on every check: main's live state and what not to repeat. */
export function headsUpStatus({ liveText, known, recent, now }: HeadsUpStatusInput): string {
  const list = (items: readonly string[]) => (items.length ? items.map((item) => `- ${item}`).join("\n") : "(none)");
  return [
    `<sidebar-status at="${new Date(now).toISOString()}">`,
    liveText,
    "",
    "Topics the user already knows (never raise these):",
    list(known),
    "",
    "Notes already shown recently (never repeat these):",
    list(recent),
    "</sidebar-status>",
  ].join("\n");
}
