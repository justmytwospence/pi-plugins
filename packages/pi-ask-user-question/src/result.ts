// What the model gets back: Claude Code's answer text ("question"="answer", with the selected
// preview and the user's notes), and the structured details the transcript renders from.
import { type ErrorCode, type Question, shownQuestions } from "./schema.ts";

/** `skipped`: a showIf follow-up whose condition was not met; left out of the answer text. */
export type AnswerKind = "option" | "custom" | "multi" | "unanswered" | "skipped";

export interface Answer {
  index: number;
  header: string;
  question: string;
  kind: AnswerKind;
  /** The chosen label, the typed text, or the selected items joined by ", "; null when unanswered or skipped. */
  answer: string | null;
  /** Multi-select: the selected labels, then the typed text if any. */
  selected?: string[];
  notes?: string;
  /** The chosen option's preview (single-select). */
  preview?: string;
}

/** An answer as the dialogs record it, before it is placed in its question. */
export type Choice =
  | { kind: "option"; label: string; preview?: string }
  | { kind: "custom"; text: string }
  | { kind: "multi"; selected: string[] };

export interface Details {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
  error?: ErrorCode;
  /** A note on the answers as a whole, added on Review. */
  note?: string;
  /** Paths of images pasted into the answers, in paste order. */
  images?: string[];
}

export type ImageBlock = { type: "image"; data: string; mimeType: string };

/** What a dialog returns: one answer per question when submitted, the answered ones when cancelled. */
export interface DialogResult {
  cancelled: boolean;
  answers: Answer[];
  /** A note on the answers as a whole, added on Review. */
  note?: string;
  /** Paths of images pasted into the answers, in paste order. */
  images?: string[];
}

/** Pasted image paths shown as `[image N]`. */
export function shortenImagePaths(text: string, images: readonly string[] | undefined): string {
  let out = text;
  images?.forEach((path, i) => {
    out = out.split(path).join(`[image ${i + 1}]`);
  });
  return out;
}

export const DECLINED = "User declined to answer questions";
const PREFIX = "User has answered your questions:";
const SUFFIX = "You can now continue with the user's answers in mind.";

export function makeAnswer(questions: readonly Question[], index: number, choice: Choice | undefined, notes?: string): Answer {
  const q = questions[index]!;
  const base = { index, header: q.header, question: q.question, ...(notes?.trim() ? { notes: notes.trim() } : {}) };
  if (!choice || (choice.kind === "multi" && choice.selected.length === 0) || (choice.kind === "custom" && !choice.text.trim())) {
    return { ...base, kind: "unanswered", answer: null };
  }
  if (choice.kind === "option") return { ...base, kind: "option", answer: choice.label, ...(choice.preview ? { preview: choice.preview } : {}) };
  if (choice.kind === "custom") return { ...base, kind: "custom", answer: choice.text.trim() };
  return { ...base, kind: "multi", answer: choice.selected.join(", "), selected: choice.selected };
}

/** A follow-up the user never saw, because the answer it depends on did not call for it. */
export function skippedAnswer(questions: readonly Question[], index: number): Answer {
  const q = questions[index]!;
  return { index, header: q.header, question: q.question, kind: "skipped", answer: null };
}

/** Which questions are shown, given the choices made so far (typed answers pick no option). */
export function shownFor(questions: readonly Question[], choices: ReadonlyArray<Choice | undefined>): boolean[] {
  return shownQuestions(
    questions,
    choices.map((c) => (c?.kind === "option" ? [c.label] : c?.kind === "multi" ? c.selected : undefined)),
  );
}

export function answerText(a: Answer): string {
  return a.kind === "unanswered" ? "Unanswered" : (a.answer ?? "");
}

function segment(a: Answer): string {
  const parts = [`"${a.question}"="${answerText(a)}"`];
  if (a.preview) parts.push(`selected preview: ${a.preview}`);
  if (a.notes) parts.push(`user notes: ${a.notes}`);
  return `${parts.join(". ")}.`;
}

export function envelope(details: Details, attached: readonly string[] = []): string {
  if (details.cancelled) return DECLINED;
  const note = details.note ? ` User notes on all answers: ${details.note}.` : "";
  const answers = details.answers.filter((a) => a.kind !== "skipped");
  let pasted = "";
  if (details.images?.length) {
    pasted = " The user pasted images, referenced by path in the answers.";
    if (attached.length) pasted += ` Attached below in this order: ${attached.join(", ")}.`;
    const rest = details.images.filter((p) => !attached.includes(p));
    if (rest.length) pasted += ` Not attached (view them with the read tool): ${rest.join(", ")}.`;
  }
  return `${PREFIX} ${answers.map(segment).join(" ")}${note}${pasted} ${SUFFIX}`;
}

export function toolResult(details: Details): { content: [{ type: "text"; text: string }]; details: Details };
export function toolResult(
  details: Details,
  images: ReadonlyArray<{ path: string; block: ImageBlock }>,
): { content: Array<{ type: "text"; text: string } | ImageBlock>; details: Details };
export function toolResult(details: Details, images: ReadonlyArray<{ path: string; block: ImageBlock }> = []) {
  return {
    content: [{ type: "text" as const, text: envelope(details, images.map((i) => i.path)) }, ...images.map((i) => i.block)],
    details,
  };
}

/** What the user told the agent, for pi-sticky-last-prompt's bar: the answers and notes, or undefined when declined. */
export function userWords(details: Details | undefined): string | undefined {
  if (!details || details.cancelled || !Array.isArray(details.answers)) return undefined;
  const parts = details.answers
    .filter((a) => a.kind !== "skipped" && a.kind !== "unanswered" && a.answer)
    .map((a) => (a.notes ? `${a.answer} (${a.notes})` : String(a.answer)));
  if (details.note) parts.push(details.note);
  return parts.length ? shortenImagePaths(parts.join(" · "), details.images) : undefined;
}

export function errorResult(questions: Question[], error: ErrorCode, message: string) {
  const details: Details = { questions, answers: [], cancelled: true, error };
  return { content: [{ type: "text" as const, text: message }], details };
}
