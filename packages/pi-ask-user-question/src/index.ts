// pi-ask-user-question: the `ask_user_question` tool. The model asks up to four multiple-choice
// questions with Claude Code's schema and gets Claude Code's answer text back. In pi's terminal UI
// they are shown in a dialog at the bottom (see dialog.ts); RPC hosts get native select/input
// dialogs (rpc.ts); without a UI the tool is withdrawn (reconcile.ts). While the user is being
// asked, the tool holds `herdr:blocked`, so herdr shows the pane as blocked.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { AnswerCard, cardDetail, cardTitle } from "./answer-card.ts";
import { Block, Row, toneOfTool } from "./transcript-style.ts";
import { QuestionDialog } from "./dialog.ts";
import { embeddedEditorFactory } from "./editor.ts";
import { whileBlocked } from "./herdr.ts";
import { DESCRIPTION, PROMPT_GUIDELINES, PROMPT_SNIPPET } from "./prompt.ts";
import { reconcile } from "./reconcile.ts";
import { imageBlocks } from "./images.ts";
import { type DialogResult, type Details, errorResult, toolResult, userWords } from "./result.ts";
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
      return toolResult({ questions, ...result }, await imageBlocks(result.images ?? [], ctx.model));
    },

    renderCall(args, theme, context) {
      const headers = (Array.isArray(args?.questions) ? args.questions : [])
        .map((q) => (typeof q?.header === "string" ? q.header.trim() : ""))
        .filter(Boolean);
      const row = new Row(theme, () => ({
        tone: toneOfTool(context ?? {}, context?.lastComponent !== undefined),
        title: "Question",
        detail: headers.length ? headers.join(" · ") : undefined,
      }));
      // Once the result card is shown it carries the title, so the call row steps aside.
      const state = context?.state as { answered?: boolean } | undefined;
      return { invalidate() {}, render: (w: number) => (state?.answered ? [] : row.render(w)) };
    },

    renderResult(result, options, theme, context) {
      const details = result.details as Details | undefined;
      const state = context?.state as { answered?: boolean } | undefined;
      const expanded = options?.expanded === true;
      let component: Component;
      if (details?.error) {
        component = new Row(theme, () => ({ tone: "failed", title: "Question", detail: firstText(result.content) || details.error }));
      } else if (details?.cancelled) {
        component = new Row(theme, () => ({ tone: "stopped", title: "Question", detail: "Declined" }));
      } else if (details?.questions) {
        component = new Block(theme, () => ({
          tone: toneOfTool(context ?? {}, true),
          title: cardTitle(details),
          detail: cardDetail(details),
          body: new AnswerCard(theme, details, expanded),
          fold: 16,
          expanded,
        }));
      } else {
        component = new Row(theme, () => ({ tone: toneOfTool(context ?? {}, true), title: "Question", detail: firstText(result.content) || undefined }));
      }
      if (state) state.answered = true;
      return component;
    },
  });
}

function firstText(content: readonly { type: string; text?: string }[]): string {
  const first = content[0];
  return first?.type === "text" ? (first.text ?? "").split("\n")[0]! : "";
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
