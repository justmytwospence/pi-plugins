// pi-ask-user-question: the `ask_user_question` tool. The model asks up to four multiple-choice
// questions with Claude Code's schema and gets Claude Code's answer text back. In pi's terminal UI
// they are shown in a dialog at the bottom (see dialog.ts); RPC hosts get native select/input
// dialogs (rpc.ts); without a UI the tool is withdrawn (reconcile.ts). While the user is being
// asked, the tool holds `herdr:blocked`, so herdr shows the pane as blocked.
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { QuestionDialog } from "./dialog.ts";
import { whileBlocked } from "./herdr.ts";
import { DESCRIPTION, PROMPT_GUIDELINES, PROMPT_SNIPPET } from "./prompt.ts";
import { reconcile } from "./reconcile.ts";
import { type Answer, type DialogResult, type Details, errorResult, toolResult } from "./result.ts";
import { askWithDialogs } from "./rpc.ts";
import { NO_UI_MESSAGE, normalize, type Params, ParamsSchema, type Question, TOOL_NAME, validate } from "./schema.ts";

const LABEL_WIDTH = 60;

export default function askUserQuestion(pi: ExtensionAPI) {
  let removed = false;

  pi.on("before_agent_start", (_event, ctx) => {
    removed = reconcile(pi, ctx.hasUI, removed);
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Ask user",
    description: DESCRIPTION,
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: ParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questions = normalize(params as Params);
      if (!ctx.hasUI) return errorResult(questions, "no_ui", NO_UI_MESSAGE);
      const invalid = validate(questions);
      if (invalid) return errorResult(questions, invalid.error, invalid.message);
      if (signal?.aborted) return toolResult({ questions, answers: [], cancelled: true });
      const result = await whileBlocked(pi.events, blockedLabel(questions), () => ask(ctx, questions, signal));
      return toolResult({ questions, ...result });
    },

    renderCall(args, theme) {
      const headers = (Array.isArray(args?.questions) ? args.questions : [])
        .map((q) => (typeof q?.header === "string" ? q.header.trim() : ""))
        .filter(Boolean);
      const title = theme.fg("toolTitle", theme.bold(TOOL_NAME));
      return new Text(headers.length ? `${title} ${theme.fg("muted", headers.join(" · "))}` : title, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as Details | undefined;
      if (!details?.questions) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      return new Text(resultLines(details, result.content, theme).join("\n"), 0, 0);
    },
  });
}

/** The dialog in the terminal UI; native dialogs elsewhere, or if the terminal dialog cannot show. */
async function ask(ctx: ExtensionContext, questions: Question[], signal: AbortSignal | undefined): Promise<DialogResult> {
  if (ctx.mode === "tui") {
    try {
      const result = await ctx.ui.custom<DialogResult | undefined>(
        (tui, theme, keybindings, done) => new QuestionDialog(tui, theme, keybindings, questions, done, signal),
      );
      if (result) return result;
    } catch {
      // Fall through to the native dialogs rather than lose the questions.
    }
  }
  return askWithDialogs(ctx.ui, questions, signal);
}

/** What herdr shows while the dialog is open: the headers, cut to 60 characters. */
export function blockedLabel(questions: readonly Question[]): string {
  const label = questions.map((q) => q.header || q.question).join(" · ");
  return label.length > LABEL_WIDTH ? `${label.slice(0, LABEL_WIDTH - 1)}…` : label;
}

export function resultLines(details: Details, content: readonly { type: string; text?: string }[], theme: Theme): string[] {
  if (details.error) {
    const first = content[0];
    return [theme.fg("error", first?.type === "text" ? (first.text ?? details.error) : details.error)];
  }
  if (details.cancelled) return [theme.fg("warning", "Declined")];
  return details.answers.map((a) => answerLine(a, theme));
}

function answerLine(a: Answer, theme: Theme): string {
  const header = theme.fg("accent", a.header || a.question);
  const note = a.notes ? theme.fg("dim", ` · note: ${a.notes.replace(/\s+/gu, " ")}`) : "";
  if (a.kind === "unanswered") return `${theme.fg("warning", "- ")}${header}: ${theme.fg("warning", "Unanswered")}${note}`;
  const value = (a.answer ?? "").replace(/\s*\n\s*/gu, " ");
  const wrote = a.kind === "custom" ? theme.fg("muted", "(wrote) ") : "";
  return `${theme.fg("success", "✓ ")}${header}: ${wrote}${value}${note}`;
}
