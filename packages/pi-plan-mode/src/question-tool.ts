import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const PLAN_MODE_QUESTION_TOOL_NAME = "plan_mode_question";
export const MAX_PLAN_MODE_RESPONSE_LENGTH = 4_000;

export type PlanModeQuestionOption = {
  label: string;
  description?: string;
};

export type PlanModeQuestion = {
  id: string;
  header: string;
  question: string;
  options: PlanModeQuestionOption[];
};

export type PlanModeQuestionAnswer = {
  id: string;
  header: string;
  question: string;
  answer: string;
  wasCustom: boolean;
  optionIndex?: number;
  note?: string;
};

type PlanModeQuestionReason = "cancelled" | "ui_unavailable" | "plan_mode_inactive" | "invalid_input";

type PlanModeQuestionDetails = {
  cancelled: boolean;
  reason?: PlanModeQuestionReason;
  questions: PlanModeQuestion[];
  answers?: PlanModeQuestionAnswer[];
};

export const PLAN_MODE_QUESTION_PARAMS = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      description: "Questions to show the user. Prefer 1 and do not exceed 3.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "header", "question", "options"],
        properties: {
          id: {
            type: "string",
            description: "Stable identifier for mapping answers (snake_case).",
          },
          header: {
            type: "string",
            description: "Short header label shown in the UI (12 or fewer chars).",
          },
          question: { type: "string", description: "Single-sentence prompt shown to the user." },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            description:
              "Provide 2-4 mutually exclusive choices. Put the recommended option first when there is a clear default.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "description"],
              properties: {
                label: { type: "string", description: "User-facing label (1-5 words)." },
                description: {
                  type: "string",
                  description: "One short sentence explaining impact/tradeoff if selected.",
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

type NormalizePlanModeQuestionParamsResult = { ok: true; questions: PlanModeQuestion[] } | { ok: false; error: string };

export function normalizePlanModeQuestionParams(input: unknown): NormalizePlanModeQuestionParamsResult {
  if (!isRecord(input) || !Array.isArray(input.questions)) {
    return { ok: false, error: "questions must be an array" };
  }
  if (input.questions.length < 1 || input.questions.length > 3) {
    return { ok: false, error: "questions must contain 1-3 items" };
  }

  const questions: PlanModeQuestion[] = [];
  for (const [questionIndex, rawQuestion] of input.questions.entries()) {
    if (!isRecord(rawQuestion)) {
      return { ok: false, error: `question ${questionIndex + 1} must be an object` };
    }
    const id = stringField(rawQuestion.id);
    const header = stringField(rawQuestion.header);
    const question = stringField(rawQuestion.question);
    if (!id || !header || !question) {
      return {
        ok: false,
        error: `question ${questionIndex + 1} requires non-empty id, header, and question`,
      };
    }
    if (!Array.isArray(rawQuestion.options)) {
      return { ok: false, error: `question ${questionIndex + 1} options must be an array` };
    }
    if (rawQuestion.options.length < 2 || rawQuestion.options.length > 4) {
      return { ok: false, error: `question ${questionIndex + 1} options must contain 2-4 items` };
    }
    const options: PlanModeQuestionOption[] = [];
    for (const [optionIndex, rawOption] of rawQuestion.options.entries()) {
      if (!isRecord(rawOption)) {
        return {
          ok: false,
          error: `question ${questionIndex + 1} option ${optionIndex + 1} must be an object`,
        };
      }
      const label = stringField(rawOption.label);
      if (!label) {
        return {
          ok: false,
          error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a label`,
        };
      }
      const description = stringField(rawOption.description);
      if (!description) {
        return {
          ok: false,
          error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a description`,
        };
      }
      options.push({ label, description });
    }
    questions.push({ id, header, question, options });
  }
  return { ok: true, questions };
}

export function planModeQuestionAnswered(questions: PlanModeQuestion[], answers: PlanModeQuestionAnswer[]) {
  return {
    content: [{ type: "text" as const, text: formatPlanModeQuestionPayload({ cancelled: false, answers }) }],
    details: { cancelled: false, questions, answers } satisfies PlanModeQuestionDetails,
  };
}

export function planModeQuestionCancelled(
  questions: PlanModeQuestion[],
  reason: PlanModeQuestionReason,
  message: string,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: formatPlanModeQuestionPayload({ cancelled: true, reason, message }),
      },
    ],
    details: { cancelled: true, reason, questions } satisfies PlanModeQuestionDetails,
  };
}

export const planModeQuestionRenderer = {
  ccstyleOwnCall: true,
  ccstyleOwnResult: true,
  renderCall: (args, _theme, context) => new Text(formatPlanModeQuestionCall(args, context.expanded), 0, 0),
  renderResult: (result, options, _theme, context) =>
    new Text(formatPlanModeQuestionResult(result, { ...options, isError: context.isError }), 0, 0),
} satisfies Pick<ToolDefinition, "renderCall" | "renderResult"> & { ccstyleOwnCall: true; ccstyleOwnResult: true };

/** Display only: tolerate streamed arguments without normalizing or changing the tool input. */
export function formatPlanModeQuestionCall(input: unknown, expanded = false): string {
  const questions = isRecord(input) && Array.isArray(input.questions) ? input.questions : [];
  const lines = ["Plan question"];
  for (const raw of questions.slice(0, 3)) {
    if (!isRecord(raw)) continue;
    const header = typeof raw.header === "string" ? raw.header : "Question";
    const question = typeof raw.question === "string" ? raw.question : "Preparing question…";
    lines.push(expanded ? `${header}: ${question}` : preview(`${header}: ${question}`));
    if (expanded && Array.isArray(raw.options)) {
      for (const [index, option] of raw.options.entries()) {
        if (!isRecord(option)) continue;
        lines.push(`  ${index + 1}. ${typeof option.label === "string" ? option.label : ""}`);
        if (typeof option.description === "string") lines.push(`     ${option.description}`);
      }
    }
  }
  if (lines.length === 1) lines.push("Preparing questions…");
  return lines.join("\n");
}

/** This tool's JSON is a machine payload; only its known cancellation message needs recovery. */
export function formatPlanModeQuestionResult(
  result: { content?: unknown; details?: unknown },
  options: { expanded?: boolean; isPartial?: boolean; isError?: boolean } = {},
): string {
  const details = isRecord(result.details) ? result.details : undefined;
  const content = questionResultText(result.content);
  if (options.isError) return `Question failed${content ? `: ${options.expanded ? content : preview(content)}` : "."}`;
  if (options.isPartial) return "Waiting for answers…";
  if (details?.cancelled === true) {
    let message = typeof details.message === "string" ? details.message : undefined;
    if (message === undefined) {
      try {
        const payload: unknown = JSON.parse(content);
        if (isRecord(payload) && payload.cancelled === true && typeof payload.message === "string") {
          message = payload.message;
        }
      } catch {
        // Old or interrupted results may not contain this tool's JSON payload.
      }
    }
    const reason = details.reason;
    const title =
      reason === "invalid_input"
        ? "Invalid question"
        : reason === "ui_unavailable"
          ? "Question UI unavailable"
          : reason === "plan_mode_inactive"
            ? "Plan mode inactive"
            : "Questions cancelled";
    return `${title}${message ? `\n${options.expanded ? message : preview(message)}` : ""}`;
  }
  if (Array.isArray(details?.answers)) {
    const lines = ["Answered"];
    for (const answer of details.answers.slice(0, 3)) {
      if (!isRecord(answer)) continue;
      const header = typeof answer.header === "string" ? answer.header : "Question";
      const value = typeof answer.answer === "string" ? answer.answer : "(no answer)";
      const label = `${header}${answer.wasCustom === true ? " (custom)" : " (selected)"}`;
      if (options.expanded && typeof answer.question === "string") lines.push(`${header}: ${answer.question}`);
      lines.push(options.expanded ? `${label}: ${value}` : preview(`${label}: ${value}`));
      if (typeof answer.note === "string") {
        lines.push(`Note: ${options.expanded ? answer.note : preview(answer.note)}`);
      }
    }
    return lines.length === 1 ? "No answers recorded." : lines.join("\n");
  }
  return content ? (options.expanded ? content : preview(content)) : "No answers recorded.";
}

function questionResultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n");
}

function preview(value: string): string {
  const single = value.replace(/\s+/gu, " ").trim();
  const chars = Array.from(single);
  return chars.length > 200 ? `${chars.slice(0, 199).join("")}…` : single;
}

function formatPlanModeQuestionPayload(payload: {
  cancelled: boolean;
  reason?: PlanModeQuestionReason;
  message?: string;
  answers?: PlanModeQuestionAnswer[];
}) {
  return JSON.stringify(payload, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : undefined;
}
