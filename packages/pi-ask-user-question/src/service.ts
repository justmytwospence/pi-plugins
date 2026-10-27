// The question dialog as a service for other extensions, so a suite component that asks the user
// something (pi-compact-plan's questions and review) looks and works like ask_user_question: the
// same dialog, "Type something." row, notes, previews, Review tab and herdr:blocked hold.
//
// Discovery is a synchronous request over `pi.events`, like the editor factory contract:
//
//   const request: AskServiceRequest = { version: 1 };
//   pi.events.emit(ASK_SERVICE_CHANNEL, request);
//   const result = request.ask ? await request.ask(ctx, { questions }) : await nativeFallback();
//
// The first provider sets `ask` and `provider`; later ones leave an answered request alone. When
// pi-ask-user-question is not loaded the request comes back unanswered. Consumers copy these
// shapes structurally; nothing imports across package directories.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DialogResult } from "./result.ts";
import type { Params } from "./schema.ts";

export const ASK_SERVICE_CHANNEL = "pi-plugins.ask-user-question.v1";

export interface AskServiceOptions {
  signal?: AbortSignal;
  /** herdr's blocked label; default the questions' headers. */
  label?: string;
}

/** The answers, or the first problem with the questions (ask_user_question's error codes). */
export type AskServiceResult = DialogResult | { error: string; message: string };

export type AskServiceFn = (ctx: ExtensionContext, params: Params, options?: AskServiceOptions) => Promise<AskServiceResult>;

export interface AskServiceRequest {
  version: 1;
  ask?: AskServiceFn;
  provider?: string;
}
