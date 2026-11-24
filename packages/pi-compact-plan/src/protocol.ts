// The side conversation with the session model: the instructions it gets, and how its JSON reply
// is read. A reply that is not the expected JSON still yields a draft (its text), so a model that
// ignores the format never blocks compaction.

export const MAX_QUESTIONS = 3;
export const MAX_OPTIONS = 4;

export interface Option {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  /** A short chip label (12 characters or fewer), as ask_user_question's. */
  header: string;
  options: Option[];
}

export interface Plan {
  questions: Question[];
  draft: string;
}

export interface Answer {
  question: string;
  answer: string;
  /** A note the user added to the answer. */
  note?: string;
}

const TAG = "compact-plan";

/** The first request: the user's next prompt, and what to send back. */
export function draftPrompt(next: string): string {
  const stated = next.trim()
    ? `What the user will do right after compacting (their next prompt, sent unchanged once the summary is written): ${next.trim()}`
    : "The user did not say what comes next: keep what is needed to continue the current work.";
  return `<${TAG}>
The user is about to compact this session. Compaction replaces the conversation so far with a summary written by another request; you are helping write the focus instructions that steer that summary: what it keeps and what it drops. Do not plan the next task, do not call tools, and do not continue the work.

${stated}

Reply with only a JSON object, no code fence and no other text:
{"questions": [{"question": "...", "header": "...", "options": [{"label": "...", "description": "..."}]}], "draft": "..."}

questions: 0 to ${MAX_QUESTIONS}, asked only when the answer would change what the summary must keep (for example whether an abandoned approach still matters, or whether some side issue is in scope). Usually []. Each has a header of 12 characters or fewer, and 2 to ${MAX_OPTIONS} options with a short label (1-5 words) and a one-line description of what choosing it means for the summary. The user can also answer in their own words or add a note to an option, so never add an "Other" option.

draft: the focus instructions, a Markdown list in this shape:
- **Keep verbatim:** <exact paths, commands, identifiers, decisions with their reasons, open bugs, constraints the user stated>
- **Keep briefly:** <background that is still relevant>
- **Drop:** <dead ends, finished subtasks, noisy tool output>
Nested items are fine where a part has several points.
Be specific to this session, never generic. Under 250 words. If you ask questions, still write your best draft.
</${TAG}>`;
}

/** The system prompt of a request drafted from an outline (no session system prompt, no tools). */
export const OUTLINE_SYSTEM = "You help plan the compaction of a coding agent's session. Reply only in the format the user's message asks for.";

/** The outline as the first part of the first request, when the conversation itself is not sent. */
export function outlineContext(outline: string): string {
  return `<session-outline>
An outline of the session so far, instead of the full transcript: every user prompt and assistant reply, one line per tool call, and each tool result shortened to its first and last lines and any error or warning lines. The summary will be written from the full transcript, so when a detail you need is in an omitted part, name it in the draft (for example "the exact failing assertion from the last test run") rather than guessing it.

${outline}
</session-outline>`;
}

/** The follow-up request: the user's answers, and a revised draft. */
export function refinePrompt(answers: readonly Answer[]): string {
  const lines = answers.map((a) => `Q: ${a.question}\nA: ${a.answer}${a.note ? `\nNote: ${a.note}` : ""}`).join("\n\n");
  return `<${TAG}>
The user's answers:

${lines}

Revise the draft with these answers. Reply with only the JSON object, with "questions": [].
</${TAG}>`;
}

/** A revision the user asked for, against the draft as it stands now (it may have been edited). */
export function revisePrompt(draft: string, feedback: string): string {
  return `<${TAG}>
The current draft:

${draft}

The user wants this changed: ${feedback}

Revise the draft accordingly. Reply with only the JSON object, with "questions": [].
</${TAG}>`;
}

/** Where the summary stops: the start of the part compaction keeps verbatim. */
export interface KeptStart {
  role: string;
  /** The first words of that message, or a description of it (its tool calls). */
  excerpt: string;
  /** The cut falls inside a turn: the turn's request is before it and must be summarized. */
  splitTurn: boolean;
}

/**
 * The summary request, appended to the session's own conversation (so it is read from the prompt
 * cache). Its format follows Pi's compaction summary (core/compaction/compaction.ts), so the session
 * continues from it as from Pi's own.
 */
export function summaryPrompt(focus: string, kept: KeptStart): string {
  return `<${TAG}-summary>
This session is being compacted now: the conversation so far will be replaced by the summary you write. Do not call tools, do not continue the work, and do not answer anything in the conversation. Reply with only the summary.

The most recent part of the conversation is kept verbatim after your summary. It starts with the ${kept.role} message that begins: "${kept.excerpt}". Summarize everything before that message; do not restate the kept part.${kept.splitTurn ? " That message is in the middle of a turn: include the user's request that started the turn and the progress made before the kept part." : ""} If the conversation begins with the summary of an earlier compaction, carry over everything in it that is still relevant.

The user's focus for this summary (it decides what to keep and what to drop):

${focus}

Use this format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user, or "(none)"]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue, or "(none)"]

Keep each section concise. Preserve exact file paths, function names, and error messages.
</${TAG}-summary>`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const RESERVED = /^(other|type something|type your own answer)\.?$/iu;

function optionsOf(value: unknown): Option[] {
  if (!Array.isArray(value)) return [];
  const out: Option[] = [];
  for (const item of value) {
    const label = typeof item === "string" ? item : isObject(item) && typeof item.label === "string" ? item.label : "";
    const clean = label.replace(/\s+/gu, " ").trim();
    if (!clean || RESERVED.test(clean) || out.some((o) => o.label === clean)) continue;
    const description = isObject(item) && typeof item.description === "string" ? item.description.trim() : "";
    out.push({ label: clean, description });
    if (out.length === MAX_OPTIONS) break;
  }
  return out;
}

/** A header for the dialog's chip: the model's, else the question's first words. */
function headerOf(value: unknown, question: string): string {
  const given = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  if (given) return given.length > 12 ? `${given.slice(0, 11)}…` : given;
  const words = question.replace(/[?.!]+$/u, "").split(/\s+/u);
  let header = "";
  for (const word of words) {
    if ((header ? `${header} ${word}` : word).length > 12) break;
    header = header ? `${header} ${word}` : word;
  }
  return header || question.slice(0, 11);
}

function questionsOf(value: unknown): Question[] {
  if (!Array.isArray(value)) return [];
  const out: Question[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.question !== "string" || !item.question.trim()) continue;
    const question = item.question.trim();
    if (out.some((q) => q.question === question)) continue;
    out.push({ question, header: headerOf(item.header, question), options: optionsOf(item.options) });
    if (out.length === MAX_QUESTIONS) break;
  }
  return out;
}

/** Reads the model's reply: the JSON object if there is one, else the whole text as the draft. */
export function parsePlan(text: string): Plan | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const unfenced = trimmed.replace(/^```(?:json)?\s*\n?/iu, "").replace(/\n?```\s*$/u, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(unfenced.slice(start, end + 1));
      if (isObject(parsed) && typeof parsed.draft === "string" && parsed.draft.trim()) {
        return { questions: questionsOf(parsed.questions), draft: parsed.draft.trim() };
      }
    } catch {
      // Not JSON after all: fall through to the text.
    }
  }
  return { questions: [], draft: unfenced.trim() };
}

/** The text blocks of an assistant message. */
export function replyText(message: { content?: unknown } | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => isObject(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}
