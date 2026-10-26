// What the model reads: Claude Code's AskUserQuestion prompt and its preview guidance, adapted to
// this dialog (free text through "Type something.", notes, Esc to decline).
import { MAX_OPTIONS, MAX_QUESTIONS, MAX_TOTAL_QUESTIONS, MIN_OPTIONS, TOOL_NAME, TYPE_SOMETHING } from "./schema.ts";

export const DESCRIPTION = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to pick "${TYPE_SOMETHING}" to answer in their own words; it is added to every question automatically, so do not author an "Other" or "${TYPE_SOMETHING}" option.
- Use multiSelect: true to allow multiple answers to be selected for a question.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.
- To ask a question only for certain answers to an earlier one, give it \`showIf\` with that question's header and the option labels that call for it, e.g. \`"showIf": {"header": "Auth", "answers": ["OAuth"]}\`. The user sees it only after picking one of those options (for multiSelect, any of them); otherwise it is never shown and is left out of the answers. Follow-ups let one call hold up to ${MAX_TOTAL_QUESTIONS} questions, at most ${MAX_QUESTIONS} of them without showIf.
- Users can add a note to any answer or, when there are several questions, to the answers as a whole, and can press Esc to decline the whole questionnaire. If they decline, do not ask the same questions again; continue with your best judgment or ask in plain text.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a box beside the options (below them in narrow terminals) and follows the highlighted option. Multi-line text with newlines is supported. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`;

export const PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} multiple-choice questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each, free text always allowed) when a decision is theirs to make`;

export const PROMPT_GUIDELINES = [
  `Use ${TOOL_NAME} when the request leaves a decision open that is the user's to make (preferences, trade-offs, scope) and guessing would be costly; do not ask about things you can find out yourself.`,
  `Group every open question into one ${TOOL_NAME} call (up to ${MAX_QUESTIONS}) instead of several back-to-back calls; when a question only matters for some answers to another, make it a showIf follow-up in the same call rather than asking it afterwards.`,
  `In ${TOOL_NAME}, give each option a short label and a description of what it means or costs, put a recommended option first with "(Recommended)" at the end of its label, and never author "Other" or "${TYPE_SOMETHING}" options.`,
];
