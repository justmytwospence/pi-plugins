// Dialogs for exec mode: one question dialog, pi-ask-user-question's when it is loaded (through its
// service channel), Pi's own select/input otherwise. Shapes are copied structurally, not imported.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { holdBlocked } from "./herdr-blocked.js";
import type { PlanModeQuestion, PlanModeQuestionAnswer } from "./question-tool.js";

export const ASK_SERVICE_CHANNEL = "pi-plugins.ask-user-question.v1";
/** The key of a tool's `onUpdate` details that advertises the question about to be asked (Switchyard). */
export const ASK_DETAILS_KEY = "askUserQuestion";
export const PLANNER_QUESTION_LABEL = "Planner question";

export interface AskOption {
  label: string;
  description: string;
  preview?: string;
}
export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect?: boolean;
}
export interface AskAnswer {
  index: number;
  header: string;
  question: string;
  kind: "option" | "custom" | "multi" | "unanswered" | "skipped";
  answer: string | null;
  notes?: string;
}
export interface AskResult {
  cancelled: boolean;
  answers: AskAnswer[];
}

type AskService = (
  ctx: ExtensionContext,
  params: { questions: AskQuestion[] },
  options?: { signal?: AbortSignal; label?: string },
) => Promise<unknown>;

const OTHER = "Type something.";

function requestAsk(pi: ExtensionAPI): AskService | undefined {
  try {
    const request: { version: 1; ask?: unknown } = { version: 1 };
    pi.events.emit(ASK_SERVICE_CHANNEL, request);
    return typeof request.ask === "function" ? (request.ask as AskService) : undefined;
  } catch {
    return undefined;
  }
}

const isAnswer = (result: unknown): result is AskResult =>
  !!result &&
  typeof result === "object" &&
  !("error" in result) &&
  Array.isArray((result as { answers?: unknown }).answers);

/** Ask the user; undefined without a UI. A cancelled dialog resolves `{ cancelled: true, answers: [] }`. */
export async function askUser(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  questions: AskQuestion[],
  options: { label: string; signal?: AbortSignal },
): Promise<AskResult | undefined> {
  if (!ctx.hasUI) return undefined;
  const service = requestAsk(pi);
  if (service) {
    try {
      // The service holds herdr:blocked itself.
      const result = await service(ctx, { questions }, { label: options.label, signal: options.signal });
      if (isAnswer(result)) return result;
    } catch {
      // Fall through to Pi's own dialogs rather than lose the question.
    }
  }
  const release = holdBlocked(pi.events, options.label);
  try {
    const answers: AskAnswer[] = [];
    for (const [index, q] of questions.entries()) {
      const choice = await ctx.ui.select(q.question, [...q.options.map((o) => o.label), OTHER], {
        signal: options.signal,
      });
      if (choice === undefined) return { cancelled: true, answers: [] };
      if (choice === OTHER) {
        const text = (await ctx.ui.input(q.question, "", { signal: options.signal }))?.trim();
        if (!text) return { cancelled: true, answers: [] };
        answers.push({ index, header: q.header, question: q.question, kind: "custom", answer: text });
      } else {
        answers.push({ index, header: q.header, question: q.question, kind: "option", answer: choice });
      }
    }
    return { cancelled: false, answers };
  } catch {
    return { cancelled: true, answers: [] };
  } finally {
    release();
  }
}

/** A planner's questions as the ask dialog's. */
export function toAskQuestions(questions: PlanModeQuestion[]): AskQuestion[] {
  return questions.map((q) => ({
    question: q.question,
    header: q.header.slice(0, 12),
    options: q.options.map((o) => ({ label: o.label, description: o.description ?? "" })),
    multiSelect: false,
  }));
}

/** The dialog's answers as the planner's question tool reports them. */
export function toPlannerAnswers(questions: PlanModeQuestion[], result: AskResult): PlanModeQuestionAnswer[] {
  return questions.map((q, i) => {
    const base = { id: q.id, header: q.header, question: q.question };
    const found = result.answers.find((a) => a.index === i);
    const note = found?.notes ? { note: found.notes } : {};
    if (found?.kind === "option" && found.answer !== null) {
      return {
        ...base,
        answer: found.answer,
        wasCustom: false,
        optionIndex: q.options.findIndex((o) => o.label === found.answer) + 1,
        ...note,
      };
    }
    if (found?.kind === "custom" && found.answer !== null)
      return { ...base, answer: found.answer, wasCustom: true, ...note };
    return { ...base, answer: "No answer. Use your recommendation.", wasCustom: true };
  });
}
