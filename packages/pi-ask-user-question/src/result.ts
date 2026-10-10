// What the model gets back: Claude Code's answer text ("question"="answer", with the selected
// preview and the user's notes), and the structured details the transcript renders from.
import type { ErrorCode, Question } from "./schema.ts";

export type AnswerKind = "option" | "custom" | "multi" | "unanswered";

export interface Answer {
  index: number;
  header: string;
  question: string;
  kind: AnswerKind;
  /** The chosen label, the typed text, or the selected items joined by ", "; null when unanswered. */
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
}

/** What a dialog returns: one answer per question when submitted, the answered ones when cancelled. */
export interface DialogResult {
  cancelled: boolean;
  answers: Answer[];
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

export function answerText(a: Answer): string {
  return a.kind === "unanswered" ? "Unanswered" : (a.answer ?? "");
}

function segment(a: Answer): string {
  const parts = [`"${a.question}"="${answerText(a)}"`];
  if (a.preview) parts.push(`selected preview: ${a.preview}`);
  if (a.notes) parts.push(`user notes: ${a.notes}`);
  return `${parts.join(". ")}.`;
}

export function envelope(details: Details): string {
  if (details.cancelled) return DECLINED;
  return `${PREFIX} ${details.answers.map(segment).join(" ")} ${SUFFIX}`;
}

export function toolResult(details: Details) {
  return { content: [{ type: "text" as const, text: envelope(details) }], details };
}

export function errorResult(questions: Question[], error: ErrorCode, message: string) {
  const details: Details = { questions, answers: [], cancelled: true, error };
  return { content: [{ type: "text" as const, text: message }], details };
}
