// The pane token `summary`: one line on what the agent just did, or what it waits on, for alerts
// (herdr-native-notify shows it as a notification's body instead of the session's title).
//
// A finished turn gets a line from a small model (Haiku) over a condensed transcript of the turn;
// a short one-line reply is used as is, and without a model (no credentials, an error, a timeout)
// the reply's first sentence stands in. A blocked dialog gets its question at once, with no model:
// an `ask_user_question` call's first question, else the dialog's `herdr:blocked` label.
import { stripNext } from "./core/text.ts";

/** Pane tokens hold at most 80 characters. */
export const SUMMARY_MAX = 80;
const TIMEOUT_MS = 4_000;
const MODELS = ["anthropic/claude-haiku-5-5", "anthropic/claude-haiku-4-5"];

const PROMPT = `You write the one-line text of a desktop notification about a coding agent's turn that just ended.
Say what the agent did (past tense), or, if it ended by asking the user something or needing an action, what the user must decide or do.
Hard limit: ${SUMMARY_MAX - 20} characters, so drop detail rather than run over. Plain text: no quotes, no markdown, no preamble, no trailing period.`;

interface Block {
  type?: string;
  text?: string;
  name?: string;
  arguments?: unknown;
  intent?: unknown;
}
interface Message {
  role?: string;
  content?: unknown;
  stopReason?: string;
}
interface Entry {
  type?: string;
  message?: Message;
}

/** Collapsed to one line, cut to `max` with an ellipsis. */
export function oneLine(text: string, max = SUMMARY_MAX): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const blocks = (m: Message | undefined): Block[] => (Array.isArray(m?.content) ? (m.content as Block[]) : []);
const textOf = (m: Message | undefined): string =>
  typeof m?.content === "string" ? m.content : blocks(m).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");

/** The messages since the last user prompt (the turn), oldest first, with that prompt. */
function turn(branch: readonly Entry[]): Message[] {
  const messages = branch.filter((e) => e?.type === "message" && e.message).map((e) => e.message as Message);
  let start = messages.length - 1;
  while (start > 0 && messages[start]?.role !== "user") start--;
  return messages.slice(Math.max(start, 0));
}

function lastAssistant(messages: readonly Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "assistant") return messages[i];
  return undefined;
}

function callLine(b: Block): string {
  const args = (typeof b.arguments === "object" && b.arguments) || {};
  const a = args as Record<string, unknown>;
  const about = [b.intent, a.description, a.command, a.path, a.file_path, a.pattern, a.query, a.task, a.label]
    .find((v): v is string => typeof v === "string" && !!v.trim());
  return `- ${b.name}${about ? `: ${oneLine(about, 120)}` : ""}`;
}

/** The turn, condensed for the summary model: the prompt, the tool calls, the final reply. */
export function turnTranscript(branch: readonly Entry[]): string | undefined {
  const messages = turn(branch);
  const final = lastAssistant(messages);
  const reply = stripNext(textOf(final)).trim();
  if (!reply) return undefined;
  const prompt = messages[0]?.role === "user" ? textOf(messages[0]).trim() : "";
  const calls = messages.flatMap((m) => (m.role === "assistant" ? blocks(m).filter((b) => b?.type === "toolCall").map(callLine) : []));
  const shownCalls = calls.length > 40 ? [...calls.slice(0, 15), `- … ${calls.length - 30} more …`, ...calls.slice(-15)] : calls;
  return [
    prompt && `User prompt:\n${prompt.length > 1_500 ? `${prompt.slice(0, 1_500)}…` : prompt}`,
    shownCalls.length && `Tool calls (${calls.length}):\n${shownCalls.join("\n")}`,
    `Final reply:\n${reply.length > 4_000 ? `…${reply.slice(-4_000)}` : reply}`,
  ].filter(Boolean).join("\n\n");
}

/** The reply's first sentence (markdown markers dropped), for when no model answers. */
export function fallbackSummary(branch: readonly Entry[]): string | undefined {
  const reply = stripNext(textOf(lastAssistant(turn(branch)))).trim();
  const line = reply.split("\n").map((l) => l.replace(/^[\s#>*\-|`]+/u, "").replace(/[*_`]/gu, "").trim()).find(Boolean);
  if (!line) return undefined;
  const sentence = /^(.+?[.!?])(\s|$)/u.exec(line)?.[1] ?? line;
  return oneLine(sentence);
}

/** A reply short enough to be its own summary: one line within the limit. */
function shortReply(branch: readonly Entry[]): string | undefined {
  const reply = stripNext(textOf(lastAssistant(turn(branch)))).trim();
  return reply && !reply.includes("\n") && reply.length <= SUMMARY_MAX ? reply : undefined;
}

/** The parts of pi's model registry the summary uses. */
export interface SummaryRegistry {
  find(provider: string, modelId: string): any;
  hasConfiguredAuth(model: any): boolean;
  complete(model: any, context: any, options?: any): Promise<{ content?: unknown; stopReason?: string }>;
}

/** `PI_HERDR_SUMMARY_MODEL` (provider/id), else the first Haiku with credentials. */
export function summaryModel(registry: SummaryRegistry, env = process.env): any {
  const configured = env.PI_HERDR_SUMMARY_MODEL?.trim();
  for (const spec of configured ? [configured] : MODELS) {
    const slash = spec.indexOf("/");
    if (slash <= 0) continue;
    const model = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
    if (model && registry.hasConfiguredAuth(model)) return model;
  }
  return undefined;
}

/** The summary of the turn that just ended, or undefined when it has no reply. Never rejects. */
export async function turnSummary(registry: SummaryRegistry | undefined, branch: readonly Entry[], env = process.env): Promise<string | undefined> {
  const messages = turn(branch);
  const final = lastAssistant(messages);
  if (!final) return undefined;
  const fallback = fallbackSummary(branch);
  const short = shortReply(branch);
  if (short) return oneLine(short);
  if (final.stopReason === "aborted" || final.stopReason === "error" || env.PI_HERDR_SUMMARY === "0" || !registry) return fallback;
  const transcript = turnTranscript(branch);
  if (!transcript) return fallback;
  let model: any;
  try {
    model = summaryModel(registry, env);
  } catch {
    return fallback;
  }
  if (!model) return fallback;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await registry.complete(
      model,
      { systemPrompt: PROMPT, messages: [{ role: "user", content: [{ type: "text", text: transcript }], timestamp: Date.now() }] },
      { maxTokens: 300, thinkingEnabled: false, signal: controller.signal, cacheRetention: "none" },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") return fallback;
    const text = textOf(response as Message).replace(/^["'`]+|["'`]+$/gu, "").trim();
    return text ? oneLine(text) : fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** What a blocked dialog waits on: a pending `ask_user_question`'s question, else the dialog's label. */
export function blockedSummary(label: string | undefined, branch: readonly Entry[]): string | undefined {
  const final = lastAssistant(turn(branch));
  const ask = blocks(final).find((b) => b?.type === "toolCall" && b.name === "ask_user_question");
  const questions = Array.isArray((ask?.arguments as { questions?: unknown })?.questions)
    ? ((ask!.arguments as { questions: Array<{ question?: unknown; header?: unknown }> }).questions)
    : [];
  const first = questions.map((q) => q?.question).find((q): q is string => typeof q === "string" && !!q.trim());
  // Only when this dialog is that question (its label starts with the first header or question),
  // not, say, a tool-gate approval for another call in the same message.
  const head = questions[0] && [questions[0].header, questions[0].question].find((v): v is string => typeof v === "string" && !!v.trim());
  const isAsk = !label?.trim() || (!!head && label.trim().startsWith(oneLine(head, 20).replace(/…$/u, "")));
  if (first && isAsk) {
    const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
    return `${oneLine(first, SUMMARY_MAX - more.length)}${more}`;
  }
  return label?.trim() ? oneLine(label) : undefined;
}
