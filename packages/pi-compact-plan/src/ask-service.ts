// pi-ask-user-question's question dialog, requested over the event bus (its src/service.ts, copied
// structurally: nothing imports across package directories). With it loaded, the questions and the
// review look and work like ask_user_question: the same dialog, "Type something." row, notes (n)
// and herdr:blocked hold. Without it, callers fall back to Pi's own selects.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const ASK_SERVICE_CHANNEL = "pi-plugins.ask-user-question.v1";

export interface ServiceOption {
  label: string;
  description: string;
}

export interface ServiceQuestion {
  question: string;
  header: string;
  options: ServiceOption[];
  multiSelect?: boolean;
}

export interface ServiceAnswer {
  index: number;
  question: string;
  kind: "option" | "custom" | "multi" | "unanswered" | "skipped";
  answer: string | null;
  notes?: string;
}

export interface ServiceResult {
  cancelled: boolean;
  answers: ServiceAnswer[];
  /** A note on the answers as a whole, from the Review tab. */
  note?: string;
}

export type AskFn = (
  ctx: ExtensionContext,
  params: { questions: ServiceQuestion[] },
  options?: { signal?: AbortSignal; label?: string },
) => Promise<ServiceResult | { error: string; message: string }>;

/** The dialog service, when pi-ask-user-question is loaded. Request it when asking, not at startup. */
export function requestAsk(events: { emit(channel: string, data: unknown): void } | undefined): AskFn | undefined {
  const request: { version: 1; ask?: AskFn } = { version: 1 };
  try {
    events?.emit(ASK_SERVICE_CHANNEL, request);
  } catch {
    return undefined;
  }
  return typeof request.ask === "function" ? request.ask : undefined;
}

/** A service result that is an answer (not an error about the questions). */
export function isAnswer(result: ServiceResult | { error: string } | undefined): result is ServiceResult {
  return !!result && !("error" in result) && Array.isArray((result as ServiceResult).answers);
}
