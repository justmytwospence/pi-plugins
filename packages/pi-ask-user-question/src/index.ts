// pi-ask-user-question: the `ask_user_question` tool. The model asks up to four multiple-choice
// questions with Claude Code's schema and gets Claude Code's answer text back. In pi's terminal UI
// they are shown in a dialog at the bottom (see dialog.ts); RPC hosts get native select/input
// dialogs (rpc.ts); without a UI the tool is withdrawn (reconcile.ts). While the user is being
// asked, the tool holds `herdr:blocked`, so herdr shows the pane as blocked.
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { QuestionDialog } from "./dialog.ts";
import { embeddedEditorFactory } from "./editor.ts";
import { whileBlocked } from "./herdr.ts";
import { DESCRIPTION, PROMPT_GUIDELINES, PROMPT_SNIPPET } from "./prompt.ts";
import { reconcile } from "./reconcile.ts";
import { type Answer, type DialogResult, type Details, errorResult, toolResult, userWords } from "./result.ts";
import { askWithDialogs } from "./rpc.ts";
import { NO_UI_MESSAGE, normalize, type Params, ParamsSchema, type Question, TOOL_NAME, validate } from "./schema.ts";
import { offerUserWords } from "./user-words.ts";
import { ASK_SERVICE_CHANNEL, type AskServiceFn, type AskServiceRequest } from "./service.ts";

const LABEL_WIDTH = 60;

export default function askUserQuestion(pi: ExtensionAPI) {
  let removed = false;

  // The same dialog for other extensions' questions (service.ts).
  const service: AskServiceFn = async (ctx, params, options = {}) => {
    const questions = normalize(params);
    if (!ctx.hasUI) return { error: "no_ui", message: NO_UI_MESSAGE };
    const invalid = validate(questions);
    if (invalid) return invalid;
    if (options.signal?.aborted) return { cancelled: true, answers: [] };
    return whileBlocked(pi.events, options.label ?? blockedLabel(questions), () => ask(pi, ctx, questions, options.signal));
  };
  pi.events.on(ASK_SERVICE_CHANNEL, (data) => {
    const request = data as AskServiceRequest | undefined;
    if (!request || request.version !== 1 || request.ask) return;
    request.ask = service;
    request.provider = "pi-ask-user-question";
  });

  // The answers are the user's words: pi-sticky-last-prompt pins them like a prompt.
  offerUserWords(pi, TOOL_NAME, ({ result }) => userWords(result.details as Details | undefined));

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
      const result = await whileBlocked(pi.events, blockedLabel(questions), () => ask(pi, ctx, questions, signal));
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
      return resultView(details, result.content, theme);
    },
  });
}

/** The dialog in the terminal UI; native dialogs elsewhere, or if the terminal dialog cannot show. */
async function ask(pi: ExtensionAPI, ctx: ExtensionContext, questions: Question[], signal: AbortSignal | undefined): Promise<DialogResult> {
  if (ctx.mode === "tui") {
    try {
      const result = await ctx.ui.custom<DialogResult | undefined>(
        (tui, theme, keybindings, done) => new QuestionDialog(tui, theme, keybindings, questions, done, signal, embeddedEditorFactory(pi)),
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

/**
 * The transcript row under the tool header: the answers in one prompt-style block (the
 * background pi gives the user's own messages), then any unanswered questions in a warning line.
 * A decline or an error is a single status line.
 */
export function resultView(details: Details, content: readonly { type: string; text?: string }[], theme: Theme): Container {
  const view = new Container();
  if (details.error) {
    const first = content[0];
    view.addChild(new Text(theme.fg("error", first?.type === "text" ? (first.text ?? details.error) : details.error), 0, 0));
    return view;
  }
  if (details.cancelled) {
    view.addChild(new Text(theme.fg("warning", "Declined"), 0, 0));
    return view;
  }
  const answered = answeredLines(details, theme);
  if (answered.length) view.addChild(new Text(answered.join("\n"), 1, 0, (line) => theme.bg("userMessageBg", line)));
  const unanswered = unansweredLines(details, theme);
  if (unanswered.length) view.addChild(new Text(unanswered.join("\n"), 0, 0));
  return view;
}

/** One `Header: answer` line per answered question, in question order, then the overall note. */
export function answeredLines(details: Details, theme: Theme): string[] {
  const lines = details.answers.filter((a) => a.kind !== "skipped" && a.kind !== "unanswered").map((a) => answerLine(a, theme));
  if (details.note) lines.push(theme.fg("dim", `note: ${details.note.replace(/\s+/gu, " ")}`));
  return lines;
}

/** Questions the user left unanswered (skipped follow-ups stay hidden). */
export function unansweredLines(details: Details, theme: Theme): string[] {
  return details.answers
    .filter((a) => a.kind === "unanswered")
    .map((a) => `${theme.fg("warning", "- ")}${theme.fg("accent", a.header || a.question)}: ${theme.fg("warning", "Unanswered")}${noteSuffix(a, theme)}`);
}

function noteSuffix(a: Answer, theme: Theme): string {
  return a.notes ? theme.fg("dim", ` · note: ${a.notes.replace(/\s+/gu, " ")}`) : "";
}

function answerLine(a: Answer, theme: Theme): string {
  const header = theme.fg("accent", a.header || a.question);
  const value = (a.answer ?? "").replace(/\s*\n\s*/gu, " ");
  const wrote = a.kind === "custom" ? theme.fg("muted", "(wrote) ") : "";
  return `${header}: ${wrote}${value}${noteSuffix(a, theme)}`;
}
