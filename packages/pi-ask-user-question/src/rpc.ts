// Hosts that cannot show custom terminal components (RPC clients such as Paseo, and subagent
// children whose dialogs pi-subagents forwards) get the questions one native dialog at a time:
// a select per single-select question, a text input for typed answers and for multi-select
// (comma-separated numbers, or words for an answer of your own). Previews are folded into the
// title; notes need the terminal dialog. Dismissing any dialog declines the questionnaire.
import { type Answer, type DialogResult, makeAnswer } from "./result.ts";
import { type Question, TYPE_SOMETHING } from "./schema.ts";

export interface DialogUI {
  select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}

const MAX_PREVIEW_CHARS = 600;
export const MULTI_INSTRUCTIONS = "Enter the numbers of all that apply, comma-separated (e.g. 1,3), or type an answer of your own.";

export async function askWithDialogs(ui: DialogUI, questions: Question[], signal?: AbortSignal): Promise<DialogResult> {
  const answers: Answer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const answer = questions[i]!.multiSelect ? await multi(ui, questions, i, signal) : await single(ui, questions, i, signal);
    if (!answer) return { cancelled: true, answers: answers.filter((a) => a.kind !== "unanswered") };
    answers.push(answer);
  }
  return { cancelled: false, answers };
}

function title(q: Question): string {
  return q.header ? `[${q.header}] ${q.question}` : q.question;
}

function optionLine(q: Question, i: number): string {
  const o = q.options[i]!;
  return `${i + 1}. ${o.label}${o.description ? ` - ${o.description}` : ""}`;
}

function previews(q: Question): string {
  const blocks = q.options.flatMap((o, i) => {
    if (!o.preview) return [];
    const text = o.preview.length > MAX_PREVIEW_CHARS ? `${o.preview.slice(0, MAX_PREVIEW_CHARS - 1)}…` : o.preview;
    return [`--- ${i + 1}. ${o.label} ---\n${text}`];
  });
  return blocks.length ? `\n\n${blocks.join("\n\n")}` : "";
}

async function single(ui: DialogUI, questions: Question[], index: number, signal?: AbortSignal): Promise<Answer | undefined> {
  const q = questions[index]!;
  const options = [...q.options.map((_, i) => optionLine(q, i)), `${q.options.length + 1}. ${TYPE_SOMETHING}`];
  const chosen = await ui.select(`${title(q)}${previews(q)}`, options, { signal });
  if (chosen === undefined) return undefined;
  let i = options.indexOf(chosen);
  if (i < 0) i = Number.parseInt(chosen, 10) - 1;
  if (!(i >= 0 && i < options.length)) return undefined;
  if (i < q.options.length) {
    const o = q.options[i]!;
    return makeAnswer(questions, index, { kind: "option", label: o.label, ...(o.preview ? { preview: o.preview } : {}) });
  }
  const typed = await ui.input(`${title(q)}\n\nType your answer:`, "", { signal });
  if (typed === undefined) return undefined;
  return makeAnswer(questions, index, { kind: "custom", text: typed });
}

async function multi(ui: DialogUI, questions: Question[], index: number, signal?: AbortSignal): Promise<Answer | undefined> {
  const q = questions[index]!;
  const list = q.options.map((_, i) => optionLine(q, i)).join("\n");
  const value = await ui.input(`${title(q)}\n\n${list}\n\n${MULTI_INSTRUCTIONS}`, "1,3", { signal });
  if (value === undefined) return undefined;
  return makeAnswer(questions, index, parseMulti(q, value));
}

/** "1,3" or "1 3" selects options; anything else is the user's own answer. */
export function parseMulti(q: Question, value: string): { kind: "multi"; selected: string[] } | { kind: "custom"; text: string } {
  const text = value.trim();
  const tokens = text.split(/[,\s]+/u).filter(Boolean);
  const indices = tokens.map((token) => (/^\d+\.?$/u.test(token) ? Number.parseInt(token, 10) - 1 : -1));
  if (indices.every((i) => i >= 0 && i < q.options.length)) {
    const selected = q.options.filter((_, i) => indices.includes(i)).map((o) => o.label);
    return { kind: "multi", selected };
  }
  return { kind: "custom", text };
}
