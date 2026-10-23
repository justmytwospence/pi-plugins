// The recap line: one line on where the session stands after a turn. It is also the text of the
// turn's notification (pi-herdr's `$summary` pane token), so it keeps that token's 80-character cap.
//
// Started from pi-herdr's summary.ts, which stays as pi-herdr's own fallback when this component is
// not loaded. Differences: the transcript also lists the session's earlier prompts, so a short
// turn ("yes, do it") still gets a recap that says what was being worked on, and the prompt asks
// for what now waits on the user.
//
// A small model (Haiku) writes the line from a condensed transcript; a short one-line reply is used
// as is, and without a model (no credentials, an error, a timeout, an interrupted turn) the reply's
// first sentence stands in.

/** Pane tokens hold at most 80 characters, and the recap is the same text. */
export const RECAP_MAX = 80;
const TIMEOUT_MS = 4_000;
const MODELS = ["anthropic/claude-haiku-5-5", "anthropic/claude-haiku-4-5"];
const EARLIER_PROMPTS = 5;

const PROMPT = `You write a one-line recap of a coding agent session for a user returning to it; the same line is the text of a desktop notification that the agent's turn just ended.
Say what the agent got done (past tense) and, if the turn ended asking the user something or needing an action, what the user must decide or do. Earlier prompts are context only: recap the latest turn.
Hard limit: ${RECAP_MAX - 20} characters, so drop detail rather than run over. Plain text: no quotes, no markdown, no preamble, no trailing period.`;

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
export function oneLine(text: string, max = RECAP_MAX): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Drops a trailing next-prompt suggestion (`<next>…</next>`, pi-next-prompt). */
export function stripNext(text: string): string {
  return text.replace(/\n?\s*<next>[\s\S]*?<\/next>\s*$/u, "").trimEnd();
}

const blocks = (m: Message | undefined): Block[] => (Array.isArray(m?.content) ? (m.content as Block[]) : []);
const textOf = (m: Message | undefined): string =>
  typeof m?.content === "string" ? m.content : blocks(m).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");

const messagesOf = (branch: readonly Entry[]): Message[] =>
  branch.filter((e) => e?.type === "message" && e.message).map((e) => e.message as Message);

/** Index of the last user prompt (the turn's start). */
function turnStart(messages: readonly Message[]): number {
  let start = messages.length - 1;
  while (start > 0 && messages[start]?.role !== "user") start--;
  return Math.max(start, 0);
}

function lastAssistant(messages: readonly Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "assistant") return messages[i];
  return undefined;
}

function callLine(b: Block): string {
  const a = ((typeof b.arguments === "object" && b.arguments) || {}) as Record<string, unknown>;
  const about = [b.intent, a.description, a.command, a.path, a.file_path, a.pattern, a.query, a.task, a.label]
    .find((v): v is string => typeof v === "string" && !!v.trim());
  return `- ${b.name}${about ? `: ${oneLine(about, 120)}` : ""}`;
}

/** The session, condensed for the recap model: earlier prompts, then the turn's prompt, calls and reply. */
export function recapTranscript(branch: readonly Entry[]): string | undefined {
  const messages = messagesOf(branch);
  const start = turnStart(messages);
  const turn = messages.slice(start);
  const reply = stripNext(textOf(lastAssistant(turn))).trim();
  if (!reply) return undefined;
  const earlier = messages
    .slice(0, start)
    .filter((m) => m.role === "user")
    .map((m) => oneLine(textOf(m), 200))
    .filter(Boolean)
    .slice(-EARLIER_PROMPTS);
  const prompt = turn[0]?.role === "user" ? textOf(turn[0]).trim() : "";
  const calls = turn.flatMap((m) => (m.role === "assistant" ? blocks(m).filter((b) => b?.type === "toolCall").map(callLine) : []));
  const shownCalls = calls.length > 40 ? [...calls.slice(0, 15), `- … ${calls.length - 30} more …`, ...calls.slice(-15)] : calls;
  return [
    earlier.length && `Earlier prompts in this session (oldest first):\n${earlier.map((p) => `- ${p}`).join("\n")}`,
    prompt && `Latest user prompt:\n${prompt.length > 1_500 ? `${prompt.slice(0, 1_500)}…` : prompt}`,
    shownCalls.length && `Tool calls (${calls.length}):\n${shownCalls.join("\n")}`,
    `Final reply:\n${reply.length > 4_000 ? `…${reply.slice(-4_000)}` : reply}`,
  ].filter(Boolean).join("\n\n");
}

/** The reply's first sentence (markdown markers dropped), for when no model answers. */
export function fallbackRecap(branch: readonly Entry[]): string | undefined {
  const messages = messagesOf(branch);
  const reply = stripNext(textOf(lastAssistant(messages.slice(turnStart(messages))))).trim();
  const line = reply.split("\n").map((l) => l.replace(/^[\s#>*\-|`]+/u, "").replace(/[*_`]/gu, "").trim()).find(Boolean);
  if (!line) return undefined;
  const sentence = /^(.+?[.!?])(\s|$)/u.exec(line)?.[1] ?? line;
  return oneLine(sentence);
}

/** The parts of pi's model registry the recap uses. */
export interface RecapRegistry {
  find(provider: string, modelId: string): any;
  hasConfiguredAuth(model: any): boolean;
  complete(model: any, context: any, options?: any): Promise<{ content?: unknown; stopReason?: string }>;
}

/** `PI_RECAP_MODEL`, else `PI_HERDR_SUMMARY_MODEL` (provider/id), else the first Haiku with credentials. */
export function recapModel(registry: RecapRegistry, env: NodeJS.ProcessEnv = process.env): any {
  const configured = (env.PI_RECAP_MODEL ?? env.PI_HERDR_SUMMARY_MODEL)?.trim();
  for (const spec of configured ? [configured] : MODELS) {
    const slash = spec.indexOf("/");
    if (slash <= 0) continue;
    const model = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
    if (model && registry.hasConfiguredAuth(model)) return model;
  }
  return undefined;
}

/** Where a recap came from: the reply itself (already on screen), the model, or the fallback sentence. */
export type RecapSource = "reply" | "model" | "fallback";
export interface Recap {
  text: string;
  source: RecapSource;
}

/** The recap of the branch's latest turn, or undefined when it has no reply. Never rejects. */
export async function recap(registry: RecapRegistry | undefined, branch: readonly Entry[], env: NodeJS.ProcessEnv = process.env): Promise<Recap | undefined> {
  const messages = messagesOf(branch);
  const final = lastAssistant(messages.slice(turnStart(messages)));
  if (!final) return undefined;
  const reply = stripNext(textOf(final)).trim();
  if (reply && !reply.includes("\n") && reply.length <= RECAP_MAX) return { text: oneLine(reply), source: "reply" };
  const fallbackText = fallbackRecap(branch);
  const fallback = fallbackText ? { text: fallbackText, source: "fallback" as const } : undefined;
  if (final.stopReason === "aborted" || final.stopReason === "error" || env.PI_HERDR_SUMMARY === "0" || !registry) return fallback;
  const transcript = recapTranscript(branch);
  if (!transcript) return fallback;
  let model: any;
  try {
    model = recapModel(registry, env);
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
    return text ? { text: oneLine(text), source: "model" } : fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
