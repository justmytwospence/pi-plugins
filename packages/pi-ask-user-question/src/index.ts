// pi-ask-user-question: the `ask_user_question` tool. The model asks up to four multiple-choice
// questions with Claude Code's schema and gets Claude Code's answer text back. In pi's terminal UI
// they are shown in a dialog at the bottom (see dialog.ts); RPC hosts get native select/input
// dialogs (rpc.ts); without a UI the tool is withdrawn (reconcile.ts). While the user is being
// asked, the tool holds `herdr:blocked`, so herdr shows the pane as blocked.
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Block, expandHint, glyph, Row, toneOfTool } from "./transcript-style.ts";
import { QuestionDialog } from "./dialog.ts";
import { embeddedEditorFactory } from "./editor.ts";
import { whileBlocked } from "./herdr.ts";
import { DESCRIPTION, PROMPT_GUIDELINES, PROMPT_SNIPPET } from "./prompt.ts";
import { reconcile } from "./reconcile.ts";
import { type Answer, type DialogResult, type Details, errorResult, toolResult, userWords } from "./result.ts";
import { askWithDialogs } from "./rpc.ts";
import { NO_UI_MESSAGE, normalize, type Params, ParamsSchema, type Question, TOOL_NAME, validate } from "./schema.ts";
import { offerUserWords } from "./user-words.ts";
import { raceRemote, remoteUi } from "./switchyard-remote.ts";
import { ASK_SERVICE_CHANNEL, type AskServiceFn, type AskServiceRequest } from "./service.ts";

const LABEL_WIDTH = 60;

/** Pi 1.5's `blocked` option for inline `ctx.ui.custom()` (OSC 7501 program status). The 1.2.0 types here lack it, hence the cast; older Pi ignores it. */
const blockedOn = (kind: "question" | "permission" | "auth", message: string) => ({ blocked: { kind, message } }) as never;

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
    renderShell: "self",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questions = normalize(params as Params);
      if (!ctx.hasUI) return errorResult(questions, "no_ui", NO_UI_MESSAGE);
      const invalid = validate(questions);
      if (invalid) return errorResult(questions, invalid.error, invalid.message);
      if (signal?.aborted) return toolResult({ questions, answers: [], cancelled: true });
      const result = await whileBlocked(pi.events, blockedLabel(questions), () => ask(pi, ctx, questions, signal));
      return toolResult({ questions, ...result });
    },

    renderCall(args, theme, context) {
      const headers = (Array.isArray(args?.questions) ? args.questions : [])
        .map((q) => (typeof q?.header === "string" ? q.header.trim() : ""))
        .filter(Boolean);
      return new Row(theme, () => ({
        tone: toneOfTool(context ?? {}, context?.lastComponent !== undefined),
        title: "Question",
        detail: headers.length ? headers.join(" · ") : undefined,
      }));
    },

    renderResult(result, options, theme, context) {
      const details = result.details as Details | undefined;
      const tone = toneOfTool(context ?? {}, true);
      const lines = details?.questions
        ? resultLines(details, result.content, theme)
        : [theme.fg(tone === "failed" ? "error" : "dim", firstText(result.content))];
      if (options?.expanded && lines.length > 1) {
        return new Block(theme, () => ({ tone, title: "Question", body: new Text(lines.join("\n"), 0, 0), expanded: true }));
      }
      const summary = details?.questions ? resultSummary(details, result.content) : firstText(result.content);
      const text = theme.fg("dim", `   ↳ ${summary}`) + (lines.length > 1 ? expandHint(theme) : "");
      return new Text(text, 0, 0);
    },
  });
}

function firstText(content: readonly { type: string; text?: string }[]): string {
  const first = content[0];
  return first?.type === "text" ? (first.text ?? "").split("\n")[0]! : "";
}

/** The one-line answer summary for the collapsed result: `header: value` per answered question. */
function resultSummary(details: Details, content: readonly { type: string; text?: string }[]): string {
  if (details.error) return firstText(content) || details.error;
  if (details.cancelled) return "Declined";
  const parts = details.answers
    .filter((a) => a.kind !== "skipped")
    .map((a) => `${a.header || a.question}: ${a.kind === "unanswered" ? "Unanswered" : (a.answer ?? "").replace(/\s*\n\s*/gu, " ")}`);
  return parts.join(" · ") || "no answers";
}

/** The dialog in the terminal UI; native dialogs elsewhere, or if the terminal dialog cannot show. */
async function ask(pi: ExtensionAPI, ctx: ExtensionContext, questions: Question[], signal: AbortSignal | undefined): Promise<DialogResult> {
  if (ctx.mode === "tui") {
    try {
      const dialog = (sig: AbortSignal | undefined) =>
        ctx.ui.custom<DialogResult | undefined>(
          (tui, theme, keybindings, done) => new QuestionDialog(tui, theme, keybindings, questions, done, sig, embeddedEditorFactory(pi)),
          blockedOn("question", blockedLabel(questions)),
        );
      const remote = remoteUi(pi);
      const result = remote
        ? (await raceRemote<DialogResult>((sig) => dialog(sig), (sig) => askWithDialogs(remote, questions, sig), signal)).value
        : await dialog(signal);
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
  const lines = details.answers.filter((a) => a.kind !== "skipped").map((a) => answerLine(a, theme));
  if (details.note) lines.push(theme.fg("dim", `note: ${details.note.replace(/\s+/gu, " ")}`));
  return lines;
}

function answerLine(a: Answer, theme: Theme): string {
  const header = theme.fg("accent", a.header || a.question);
  const note = a.notes ? theme.fg("dim", ` · note: ${a.notes.replace(/\s+/gu, " ")}`) : "";
  if (a.kind === "unanswered") return `${theme.fg("warning", "- ")}${header}: ${theme.fg("warning", "Unanswered")}${note}`;
  const value = (a.answer ?? "").replace(/\s*\n\s*/gu, " ");
  const wrote = a.kind === "custom" ? theme.fg("muted", "(wrote) ") : "";
  return `${glyph(theme, "done")} ${header}: ${wrote}${value}${note}`;
}
