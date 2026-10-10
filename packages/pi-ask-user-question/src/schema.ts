// The tool's parameters, Claude Code's AskUserQuestion schema with "Other" replaced by pi's
// "Type something." row, and the checks the schema cannot express.
import { type Static, Type } from "typebox";

export const TOOL_NAME = "ask_user_question";
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
/** The free-text row appended to every question. */
export const TYPE_SOMETHING = "Type something.";

export const OptionSchema = Type.Object({
  label: Type.String({
    description:
      "The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.",
  }),
  description: Type.String({
    description:
      "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
  }),
  preview: Type.Optional(
    Type.String({
      description:
        "Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.",
    }),
  ),
});

export const QuestionSchema = Type.Object({
  question: Type.String({
    description:
      'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
  }),
  header: Type.String({
    description: 'Very short label displayed as a chip/tag (12 characters or fewer). Examples: "Auth method", "Library", "Approach".',
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: `The available choices for this question. Must have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no "${TYPE_SOMETHING}" or "Other" option; free text is provided automatically.`,
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
    }),
  ),
});

export const ParamsSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: MAX_QUESTIONS,
    description: `Questions to ask the user (1-${MAX_QUESTIONS} questions)`,
  }),
});

export type Option = Static<typeof OptionSchema>;
export type Question = Omit<Static<typeof QuestionSchema>, "multiSelect"> & { multiSelect: boolean };
export type Params = Static<typeof ParamsSchema>;

export type ErrorCode =
  | "no_questions"
  | "too_many_questions"
  | "duplicate_question"
  | "empty_options"
  | "too_many_options"
  | "duplicate_option_label"
  | "reserved_label"
  | "no_ui";

export const NO_UI_MESSAGE =
  "Error: there is no user to ask (pi is running without an interactive UI). Do not retry; ask in plain text, or continue with your best judgment and say what you assumed.";

/** Plain line endings, a one-line header, and multiSelect filled in. */
export function normalize(params: Params): Question[] {
  const text = (s: unknown) => String(s ?? "").replace(/\r\n?/gu, "\n");
  return (params.questions ?? []).map((q) => ({
    question: text(q.question).trim(),
    header: text(q.header).replace(/\s+/gu, " ").trim(),
    options: (q.options ?? []).map((o) => ({
      label: text(o.label).replace(/\s+/gu, " ").trim(),
      description: text(o.description).trim(),
      ...(o.preview?.trim() ? { preview: text(o.preview) } : {}),
    })),
    multiSelect: q.multiSelect === true,
  }));
}

const isReserved = (label: string) => /^(other|type something)\.?$/iu.test(label.trim());

/** The first problem with the questions, as an error code and a message for the model. */
export function validate(questions: readonly Question[]): { error: ErrorCode; message: string } | undefined {
  const fail = (error: ErrorCode, message: string) => ({ error, message: `Error: ${message}` });
  if (questions.length === 0) return fail("no_questions", "ask at least one question.");
  if (questions.length > MAX_QUESTIONS) return fail("too_many_questions", `ask at most ${MAX_QUESTIONS} questions per call.`);
  const seen = new Set<string>();
  for (const q of questions) {
    if (seen.has(q.question)) return fail("duplicate_question", `the question "${q.question}" appears twice; each question must be unique.`);
    seen.add(q.question);
  }
  for (const q of questions) {
    if (q.options.length < MIN_OPTIONS) return fail("empty_options", `"${q.question}" needs at least ${MIN_OPTIONS} options.`);
    if (q.options.length > MAX_OPTIONS) return fail("too_many_options", `"${q.question}" has more than ${MAX_OPTIONS} options.`);
    const labels = new Set<string>();
    for (const o of q.options) {
      if (isReserved(o.label)) {
        return fail("reserved_label", `"${o.label}" is reserved: "${TYPE_SOMETHING}" is added to every question automatically, so leave it out.`);
      }
      if (labels.has(o.label)) return fail("duplicate_option_label", `"${q.question}" has two options labelled "${o.label}"; labels must be unique.`);
      labels.add(o.label);
    }
  }
  return undefined;
}
