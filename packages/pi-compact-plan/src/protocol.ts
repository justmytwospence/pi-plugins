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

/** The first request: the user's goal, and what to send back. */
export function draftPrompt(goal: string, automatic = false): string {
  const stated = goal.trim() || "(not stated: infer the most likely next step from the conversation, and say in the draft that you inferred it)";
  return `<${TAG}>
The user is about to run /compact on this session. Compaction replaces the conversation so far with a summary written by another request; you are helping write the focus instructions that steer that summary. Do not call tools and do not continue the work.

What the user will do after compacting: ${stated}

Reply with only a JSON object, no code fence and no other text:
${automatic ? '{"questions": [], "draft": "..."}' : '{"questions": [{"question": "...", "header": "...", "options": [{"label": "...", "description": "..."}]}], "draft": "..."}'}

${automatic ? 'questions: must be []. No questions will be asked. Do not ask for clarification; make reasonable assumptions from the session context.' : `questions: 0 to ${MAX_QUESTIONS}, asked only when the answer would change what the summary must keep (for example whether an abandoned approach still matters, or whether some side issue is in scope). Usually []. Each has a header of 12 characters or fewer, and 2 to ${MAX_OPTIONS} options with a short label (1-5 words) and a one-line description of what choosing it means for the summary. The user can also answer in their own words or add a note to an option, so never add an "Other" option.`}

draft: the focus instructions, a Markdown list in this shape:
- **Next task:** <the goal, sharpened with specifics from this session>
- **Preserve verbatim:** <exact paths, commands, identifiers, decisions with their reasons, open bugs, constraints the user stated>
- **Preserve briefly:** <background that is still relevant>
- **Drop:** <dead ends, finished subtasks, noisy tool output>
Nested items are fine where a part has several points.
Be specific to this session, never generic. Under 250 words.${automatic ? "" : " If you ask questions, still write your best draft."}
</${TAG}>`;
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
