import type { AskQuestion } from "./exec-ask.js";
import { type NegotiationState, outstanding } from "./negotiation.js";

export interface PausePresentation {
  title: string;
  reason: string;
  next: string;
  question?: string;
}

function currentPause(n: NegotiationState) {
  if (n.phase !== "paused" || !n.pause) throw new Error("Execution is not paused.");
  return n.pause;
}

export function pausePresentation(n: NegotiationState): PausePresentation {
  const pause = currentPause(n);
  switch (pause.reason) {
    case "user_needed":
      return {
        title: "Waiting for your answer",
        reason: pause.action,
        question: pause.question,
        next: "Answer below, or press Esc and answer later from the footer or /plan-exec.",
      };
    case "failure":
    case "interrupted":
      return {
        title: "Review did not finish",
        reason: pause.action,
        next: "Retry the review, finish without it, or stop.",
      };
    case "exhausted":
      return {
        title: "Another revision needs your approval",
        reason: `Revisions used: ${n.revisionsUsed}. Outstanding findings: ${outstanding(n).length}.`,
        next: "Allow one more revision, finish without review, or stop.",
      };
  }
}

export type PauseAction = "answer" | "retry" | "extend" | "accept" | "stop" | "planner";

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const STOP = { label: "Stop implementation", description: "End without claiming completion" };
const FINISH_UNREVIEWED = { label: "Finish unreviewed", description: "Complete without planner acceptance" };

/**
 * The dialog for a pause. `actions` maps option labels to recovery actions; `Use recommendation`
 * (user_needed) is not in it: the caller answers with the reviewer's recommendation. Typed text
 * answers a user_needed question and is a message to the planner for every other pause.
 */
export function pauseQuestion(
  n: NegotiationState,
  pendingCompletion: boolean,
): { question: AskQuestion; actions: Record<string, Exclude<PauseAction, "answer" | "planner">> } {
  if (pendingCompletion) {
    return {
      question: {
        header: "Completion",
        question: "Work model unavailable. Retry completion or stop?",
        options: [{ label: "Retry completion", description: "Switch back to the work model and finish" }, STOP],
      },
      actions: { "Retry completion": "retry", [STOP.label]: "stop" },
    };
  }
  const pause = currentPause(n);
  switch (pause.reason) {
    case "user_needed":
      return {
        question: {
          header: "Reviewer",
          question: cut(pause.question ?? pause.action, 160),
          options: [
            {
              label: "Use recommendation",
              description: cut(n.history.at(-1)?.decision?.recommendation ?? "The reviewer's recommendation", 120),
            },
            FINISH_UNREVIEWED,
            STOP,
          ],
        },
        actions: { [FINISH_UNREVIEWED.label]: "accept", [STOP.label]: "stop" },
      };
    case "exhausted":
      return {
        question: {
          header: "Review",
          question: `Revisions used up (${n.revisionsUsed}). ${outstanding(n).length} findings remain.`,
          options: [
            { label: "Allow one more revision", description: "One more fix and review cycle" },
            FINISH_UNREVIEWED,
            STOP,
          ],
        },
        actions: { "Allow one more revision": "extend", [FINISH_UNREVIEWED.label]: "accept", [STOP.label]: "stop" },
      };
    default:
      return {
        question: {
          header: "Review",
          question: cut(`Review did not finish: ${pause.action}`, 160),
          options: [{ label: "Retry review", description: "Run the same review again" }, FINISH_UNREVIEWED, STOP],
        },
        actions: { "Retry review": "retry", [FINISH_UNREVIEWED.label]: "accept", [STOP.label]: "stop" },
      };
  }
}

const CONTINUE = { label: "Continue", description: "Keep implementing the plan" };
const SUBMIT = { label: "Submit for review", description: "Ask it to call finish_plan now" };
const REPLAN = { label: "Revisit plan", description: "Pause implementation and revise the plan" };

/** The implementer ended its turn before finishing. */
export function stalledQuestion(title: string, canReplan = false): AskQuestion {
  return {
    header: "Implementing",
    question: `The implementer stopped before finishing "${title}".`,
    options: canReplan ? [CONTINUE, SUBMIT, REPLAN, STOP] : [CONTINUE, SUBMIT, STOP],
  };
}

/** The menu behind the footer badge, `/plan-exec` and mode changes. */
export function statusQuestion(
  title: string,
  implementer: string,
  planner: string | undefined,
  busy: boolean,
  canReplan = false,
): AskQuestion {
  return {
    header: "Implementing",
    question: `Implementing "${title}" with ${implementer}${planner ? `; ${planner} on call` : ""}.`,
    options: busy
      ? [
          { label: "Keep going", description: "Close this" },
          { ...STOP, description: "Interrupt and end without claiming completion" },
        ]
      : canReplan
        ? [CONTINUE, SUBMIT, REPLAN, STOP]
        : [CONTINUE, SUBMIT, STOP],
  };
}

/** An unfinished task in Plan can only stay suspended or be stopped, never implicitly resumed. */
export function replanningQuestion(title: string): AskQuestion {
  return {
    header: "Replanning",
    question: `Implementation of "${title}" is paused while its plan is revised. Approve the revised plan to resume.`,
    options: [{ label: "Keep planning", description: "Leave implementation paused in Plan" }, STOP],
  };
}
