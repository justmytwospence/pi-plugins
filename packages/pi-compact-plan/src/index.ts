// pi-compact-plan: /compact-plan [next prompt]. Work out the focus of a compaction with the session
// (what the summary keeps verbatim, keeps briefly and drops), then compact and either stop or
// continue with the next prompt. The session asks a question or two only when an answer changes
// what the summary must keep. The focus is shown in the transcript on the review card pi-plan-mode
// draws plans with, with the review under it: compact and stop, compact and continue, edit it (in
// the suite's editor, so pi-vim works), tell the session what to change, or cancel.
//
// The drafting is a side request to the session's model, outside the session: nothing is added to
// the model's context, and the session's extensions never see it. It reuses the session's last
// provider request byte for byte (splice.ts), so the conversation comes from the prompt cache; when
// that is not possible (another API, no request since /tree or a compaction) it sends the session's
// context as an ordinary request. Only when the conversation is large and not (or probably not) in
// the prompt cache does it ask what to draft from: an outline of the session (outline.ts, a few
// percent of the tokens) or the full conversation (one uncached read that refills the cache).
//
// The summary: when the drafting read the conversation from the prompt cache and it is still warm,
// this extension writes it the same way, on the session's last request (session_before_compact),
// so it costs a cache read instead of Pi's uncached summarization request. Otherwise Pi's own
// summarizer writes it with the focus as its instructions. Escape stops a request in flight.
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compact, convertToLlm, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { isAnswer, requestAsk, type ServiceQuestion } from "./ask-service.ts";
import { holdBlocked, holdWorking } from "./herdr-blocked.ts";
import { payloadModel, routedModel } from "./routed-model.ts";
import { outlineOf, outlineTokens } from "./outline.ts";
import { type Answer, draftPrompt, type KeptStart, OUTLINE_SYSTEM, outlineContext, parsePlan, type Plan, refinePrompt, replyText, revisePrompt, summaryPrompt } from "./protocol.ts";
import { entryText, isConversationRequest, SUPPORTED_APIS, splicePayload } from "./splice.ts";
import { askText } from "./text-input.ts";
import { type DraftEntry, type DraftState, DraftView, ENTRY, OUTCOME_ENTRY, type OutcomeEntry, type Source } from "./view.ts";

export const COMMAND = "compact-plan";
export const WIDGET = "compact-plan";
export const WRITE_OWN = "Type your own answer";
export const SKIP = "Skip this question";
export const STOP = "Compact and stop";
export const CONTINUE = "Compact and continue";
/** Sent after compacting when the user chose to continue without a next prompt. */
export const CONTINUE_PROMPT = "Continue with the current work.";

/**
 * The message sent after compacting. The note says compaction already ran, so the model does not
 * mistake a prompt that mentions compacting for a request to compact (or think the command failed).
 */
export function continuation(prompt: string): string {
  return `[/${COMMAND} compacted this session; the summary above is the result. Do not compact again. Continue with the following.]\n\n${prompt}`;
}
export const EDIT = "Edit the focus";
export const CHANGE = "No, change it";
export const CANCEL = "Cancel";
export const REVIEW_QUESTION = "Compact with this focus?";
export const SOURCE_QUESTION = "Draft the focus from?";
export const SOURCE_OUTLINE = "An outline of the session";
export const SOURCE_FULL = "The full conversation";
/** pi-cache-guard's event (optional): `{ cold: boolean, tokens?: number, model?: string }`. */
export const CACHE_STATE = "cache:state";
/** Below this many context tokens, an outline saves too little to be worth a question. */
export const OUTLINE_MIN_TOKENS = 50_000;
/**
 * The instructions of a compaction whose summary this extension writes: a marker, so other
 * extensions that customize compaction (pi-cache-guard) leave it alone. Followed by a UUID.
 */
export const DIRECT_PREFIX = "compact-plan-direct:";
/** How long after a cached request the summary still counts on the cache (Anthropic keeps it 5 minutes). */
export const SUMMARY_WARM_MS = 4 * 60_000;

type Review =
  | { action: "stop" | "continue" | "edit"; note?: string }
  | { action: "change"; feedback: string }
  | { action: "cancel" | "none" };

/** A compaction whose summary this extension writes; the hook fills in what happened. */
interface SummaryJob {
  focus: string;
  usage?: Usage;
  error?: string;
}
const TIMEOUT_MS = 180_000;
const FALLBACK_MAX_TOKENS = 4_000;
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

interface LastRequest {
  api: string;
  provider: string;
  model: string;
  leafId: string | null;
  payload: unknown;
}

interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

interface Reply {
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  usage?: Partial<Usage>;
}

class Cancelled extends Error {}

/** Pi's read and modified file lists (core/compaction/utils.ts, which the package does not export). */
function fileLists(ops: { read: Set<string>; written: Set<string>; edited: Set<string> } | undefined): { readFiles: string[]; modifiedFiles: string[] } {
  if (!ops) return { readFiles: [], modifiedFiles: [] };
  const modified = new Set([...ops.edited, ...ops.written]);
  return { readFiles: [...ops.read].filter((f) => !modified.has(f)).sort(), modifiedFiles: [...modified].sort() };
}

function formatFiles(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  return sections.length ? `\n\n${sections.join("\n\n")}` : "";
}

/** Where compaction's kept part starts, described so the summary can stop there. */
export function keptStart(branch: readonly any[], firstKeptEntryId: string, splitTurn: boolean): KeptStart | undefined {
  const entry = branch.find((e) => e?.id === firstKeptEntryId);
  if (!entry) return undefined;
  const role = typeof entry.message?.role === "string" ? entry.message.role : String(entry.type ?? "message");
  let excerpt = entryText(entry).replace(/\s+/gu, " ").trim();
  if (!excerpt && Array.isArray(entry.message?.content)) {
    const calls = entry.message.content.filter((b: any) => b?.type === "toolCall").map((b: any) => String(b.name ?? "tool"));
    if (calls.length) excerpt = `[tool calls: ${calls.join(", ")}]`;
  }
  if (!excerpt) return undefined;
  return { role, excerpt: excerpt.length > 160 ? `${excerpt.slice(0, 159)}…` : excerpt, splitTurn };
}

const userText = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }) as AgentMessage;

/** The session's messages after its last request: normally the final reply. Undefined when they cannot be told apart. */
export function messagesSince(branch: readonly any[], leafId: string | null): AgentMessage[] | undefined {
  const start = leafId === null ? -1 : branch.findIndex((e) => e?.id === leafId);
  if (leafId !== null && start < 0) return undefined;
  const after = branch.slice(start + 1);
  if (after.some((e) => e?.type === "compaction" || e?.type === "branch_summary")) return undefined;
  return after.flatMap((e) => sessionEntryToContextMessages(e) as AgentMessage[]);
}

export default function piCompactPlan(pi: ExtensionAPI) {
  let last: LastRequest | undefined;
  let drafting = false;
  /** The last drafting request spliced onto the session's: when, and whether the cache served or stored it. */
  let lastSplice: { at: number; cached: boolean } | undefined;
  /** Compactions whose summary this extension writes, by their marker instructions. */
  const summaries = new Map<string, SummaryJob>();
  /** pi-cache-guard's latest view of the prompt cache, when it is loaded. */
  let cacheState: { cold: boolean; tokens?: number } | undefined;
  /** Drafts of this process and recorded outcomes, by entry id, for the transcript renderer. */
  const states = new Map<string, DraftState>();

  pi.registerEntryRenderer<DraftEntry>(ENTRY, (entry, options, theme) => {
    const data = entry.data;
    if (!data?.id || typeof data.draft !== "string") return undefined;
    const fallback: DraftState = { goal: data.goal ?? "", draft: data.draft, status: "cancelled" };
    return new DraftView(() => states.get(data.id) ?? fallback, theme, () => options.expanded);
  });
  // The outcome is state for the draft's block, not a block of its own.
  pi.registerEntryRenderer(OUTCOME_ENTRY, () => undefined);

  try {
    pi.events?.on?.(CACHE_STATE, (data: unknown) => {
      const d = data as { cold?: unknown; tokens?: unknown } | undefined;
      if (typeof d?.cold === "boolean") cacheState = { cold: d.cold, ...(typeof d.tokens === "number" ? { tokens: d.tokens } : {}) };
    });
  } catch {
    // No event bus: the cache is guessed from the session alone.
  }

  pi.on("session_start", (_event, ctx) => {
    last = undefined;
    lastSplice = undefined;
    try {
      for (const e of ctx.sessionManager.getEntries() as any[]) {
        if (e?.type !== "custom" || e.customType !== OUTCOME_ENTRY || !e.data?.id) continue;
        const { id, ...state } = e.data as OutcomeEntry;
        states.set(id, state);
      }
    } catch {
      // No entries to read.
    }
  });
  pi.on("session_tree", () => {
    last = undefined;
    lastSplice = undefined;
  });
  pi.on("session_compact", () => {
    last = undefined;
    lastSplice = undefined;
  });
  pi.on("before_provider_request", (event, ctx) => {
    // Under a virtual selection (a plan model pair) the payload names the physical model.
    const model = payloadModel(ctx as never, (event.payload as { model?: unknown } | undefined)?.model);
    if (drafting || !model) return undefined;
    const leaf = ctx.sessionManager.getLeafEntry?.();
    if (!isConversationRequest(event.payload, model.id, entryText(leaf))) return undefined;
    // A reference: handlers that run later may still edit it in place. It is copied when used.
    last = { api: model.api, provider: model.provider, model: model.id, leafId: ctx.sessionManager.getLeafId(), payload: event.payload };
    return undefined;
  });

  /** The model a plain request goes to: the selection, or under a virtual one (a plan model pair) the model behind it. */
  function physicalModel(ctx: ExtensionContext) {
    if (!ctx.model) throw new Error("no model selected");
    const model = routedModel(ctx as never);
    if (!model) throw new Error(`${ctx.model.provider}/${ctx.model.id} has not answered yet in this session, so the model behind it is unknown`);
    return model;
  }

  /** One drafting request: spliced onto the session's last request when possible, else plain (unless `spliceOnly`). */
  async function request(ctx: ExtensionContext, side: AgentMessage[], signal: AbortSignal, source: Source = "full", spliceOnly = false): Promise<{ reply: Reply; usage: Usage }> {
    const registry = ctx.modelRegistry as any;
    const usageOf = (r: Reply): Usage => ({ input: r.usage?.input ?? 0, cacheRead: r.usage?.cacheRead ?? 0, cacheWrite: r.usage?.cacheWrite ?? 0 });
    const failed = (r: Reply) => r.stopReason === "error" || r.stopReason === "aborted";

    if (source === "outline") {
      // The outline is the whole context: an ordinary request on the session's model, no tools.
      const outlineModel = physicalModel(ctx);
      const reply: Reply = await registry.complete(
        outlineModel,
        { systemPrompt: OUTLINE_SYSTEM, messages: convertToLlm(side), tools: [] },
        { signal, maxTokens: FALLBACK_MAX_TOKENS, maxRetries: 1 },
      );
      if (signal.aborted) throw new Cancelled();
      if (failed(reply)) throw new Error(reply.errorMessage ?? "the model request failed");
      return { reply, usage: usageOf(reply) };
    }

    const previous = last;
    const delta = previous ? messagesSince(ctx.sessionManager.getBranch() as any[], previous.leafId) : undefined;
    const model = previous && delta ? registry.find(previous.provider, previous.model) : undefined;
    if (previous && delta && model) {
      let sessionId: string | undefined;
      try {
        sessionId = ctx.sessionManager.getSessionId();
      } catch {
        // No id: the request goes without one.
      }
      let spliceError: string | undefined;
      try {
        const reply: Reply = await registry.complete(
          model,
          { systemPrompt: "", messages: convertToLlm([...delta, ...side]), tools: [] },
          {
            signal,
            maxRetries: 1,
            // The session's id, as its own requests carry it (Codex routes its prompt cache by it).
            ...(sessionId ? { sessionId } : {}),
            onPayload: (payload: unknown) => {
              const result = splicePayload(previous.api, previous.payload, payload);
              if (result.ok) return result.payload;
              spliceError = result.reason;
              throw new Error(`not sent: ${result.reason}`);
            },
          },
        );
        if (signal.aborted) throw new Cancelled();
        if (!failed(reply)) {
          const usage = usageOf(reply);
          const total = usage.input + usage.cacheRead + usage.cacheWrite;
          // Cached when the provider read or stored most of it (a provider without caching stays uncached).
          lastSplice = { at: Date.now(), cached: total > 0 && (usage.cacheRead + usage.cacheWrite) * 2 >= total };
          return { reply, usage };
        }
        if (!spliceError) throw new Error(reply.errorMessage ?? "the model request failed");
      } catch (error) {
        if (signal.aborted) throw new Cancelled();
        if (!spliceError) throw error;
      }
    }

    if (spliceOnly) throw new Error("the session's last request cannot be reused");
    const fallbackModel = physicalModel(ctx);
    const context = ctx.sessionManager.buildSessionProjection().messages as AgentMessage[];
    const reply: Reply = await registry.complete(
      fallbackModel,
      { systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm([...context, ...side]), tools: [] },
      { signal, maxTokens: FALLBACK_MAX_TOKENS, maxRetries: 1 },
    );
    if (signal.aborted) throw new Cancelled();
    if (failed(reply)) throw new Error(reply.errorMessage ?? "the model request failed");
    return { reply, usage: usageOf(reply) };
  }

  /** Whether a drafting request could reuse the session's last request (so the cache may be warm). */
  function spliceable(ctx: ExtensionContext): boolean {
    try {
      const previous = last;
      if (!previous || !SUPPORTED_APIS.has(previous.api)) return false;
      if (messagesSince(ctx.sessionManager.getBranch() as any[], previous.leafId) === undefined) return false;
      return !!(ctx.modelRegistry as any).find(previous.provider, previous.model);
    } catch {
      return false;
    }
  }

  /** Our guess whether the conversation is in the prompt cache, and how to say so. */
  function cacheGuess(ctx: ExtensionContext): { cold: boolean; why: string } {
    if (!spliceable(ctx)) return { cold: true, why: "not in the prompt cache" };
    if (cacheState?.cold) return { cold: true, why: "probably no longer in the prompt cache" };
    return { cold: false, why: "in the prompt cache" };
  }

  /** Whether the summary can be written from the prompt cache: a recent drafting request was served or stored by it. */
  function summaryWarm(ctx: ExtensionContext): boolean {
    const s = lastSplice;
    return !!s && s.cached && Date.now() - s.at < SUMMARY_WARM_MS && spliceable(ctx);
  }

  function contextTokens(ctx: ExtensionContext): number | undefined {
    try {
      const tokens = ctx.getContextUsage?.()?.tokens;
      if (typeof tokens === "number") return tokens;
    } catch {
      // Fall through to cache-guard's count.
    }
    return cacheState?.tokens;
  }

  const fmtTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

  /**
   * What to draft from. The full conversation unless it is large and not (or probably not) in the
   * prompt cache and its outline is much smaller: then the user picks. Undefined: cancelled.
   */
  async function chooseSource(ctx: ExtensionContext): Promise<{ source: Source; outline?: string } | undefined> {
    const tokens = contextTokens(ctx);
    if (tokens === undefined || tokens < OUTLINE_MIN_TOKENS) return { source: "full" };
    const guess = cacheGuess(ctx);
    if (!guess.cold) return { source: "full" };
    let outline: string;
    try {
      outline = outlineOf(convertToLlm(ctx.sessionManager.buildSessionProjection().messages as AgentMessage[]));
    } catch {
      return { source: "full" };
    }
    const small = outlineTokens(outline);
    if (!outline || small * 4 > tokens) return { source: "full" };

    const question = `The conversation (${fmtTokens(tokens)} tokens) is ${guess.why}. ${SOURCE_QUESTION}`;
    const descriptions: Record<string, string> = {
      [SOURCE_OUTLINE]: `~${fmtTokens(small)} tokens: prompts, replies, tool calls and error lines. Pi's summarizer still reads everything.`,
      [SOURCE_FULL]: spliceable(ctx)
        ? `Re-reads all ${fmtTokens(tokens)} tokens once and refills the cache, so revisions and the summary read it cheaply.`
        : `Re-reads all ${fmtTokens(tokens)} tokens uncached; the most thorough draft.`,
    };
    const labels = [SOURCE_OUTLINE, SOURCE_FULL];
    const pick = (label: string | null | undefined) => ({ source: (label ?? labels[0]) === SOURCE_OUTLINE ? ("outline" as const) : ("full" as const), outline });
    const service = requestAsk(pi.events);
    if (service) {
      const result = await service(
        ctx,
        { questions: [{ question, header: "Draft from", options: labels.map((label) => ({ label, description: descriptions[label] as string })) }] },
        { label: "Compaction focus" },
      ).catch(() => undefined);
      if (isAnswer(result)) {
        const a = result.answers[0];
        if (result.cancelled || !a) return undefined;
        return pick(a.kind === "option" ? a.answer : undefined);
      }
    }
    const choice = await waiting(SOURCE_QUESTION, () => ctx.ui.select(question, labels));
    return choice === undefined ? undefined : pick(choice);
  }

  /** The working row above the editor while a request runs. */
  const showWorking = (ctx: ExtensionContext, label: string | undefined) => {
    try {
      if (!label) {
        ctx.ui.setWidget(WIDGET, undefined);
        return;
      }
      ctx.ui.setWidget(WIDGET, (tui, theme) => {
        const timer = setInterval(() => tui.requestRender(), 120);
        timer.unref?.();
        return {
          invalidate() {},
          dispose: () => clearInterval(timer),
          render: () => {
            const frame = SPINNER[Math.floor(Date.now() / 120) % SPINNER.length];
            return [` ${theme.fg("accent", frame ?? "⠋")} ${theme.fg("muted", label)}  ${theme.fg("dim", "esc stop")}`];
          },
        };
      });
    } catch {
      // The runtime went stale.
    }
  };

  /** Runs one request with the working row, herdr's working hold, and Escape to stop it. */
  async function working<T>(ctx: ExtensionContext, label: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const release = holdWorking(pi.events, label);
    let stopped = false;
    const unsubscribe = ctx.ui.onTerminalInput?.((data) => {
      if (!matchesKey(data, "escape")) return undefined;
      stopped = true;
      controller.abort();
      return { consume: true };
    });
    drafting = true;
    showWorking(ctx, label);
    try {
      return await run(controller.signal);
    } catch (error) {
      if (stopped || error instanceof Cancelled) throw new Cancelled(stopped ? "stopped" : "timed out");
      throw error;
    } finally {
      drafting = false;
      clearTimeout(timer);
      unsubscribe?.();
      release();
      showWorking(ctx, undefined);
    }
  }

  /** A dialog that waits on the user, holding herdr's blocked state while it is open. */
  async function waiting<T>(label: string, run: () => Promise<T>): Promise<T> {
    const release = holdBlocked(pi.events, label);
    try {
      return await run();
    } finally {
      release();
    }
  }

  /** Asks the plan's questions; undefined when the user backs out. */
  async function askQuestions(ctx: ExtensionContext, plan: Plan): Promise<Answer[] | undefined> {
    // pi-ask-user-question's dialog when it is loaded: typed answers, notes and a Review tab.
    const service = requestAsk(pi.events);
    if (service) {
      const questions: ServiceQuestion[] = plan.questions.map((q) => ({ question: q.question, header: q.header, options: q.options, multiSelect: false }));
      const result = await service(ctx, { questions }, { label: "Compaction focus" }).catch(() => undefined);
      if (isAnswer(result)) {
        if (result.cancelled) return undefined;
        const answers: Answer[] = [];
        for (const a of result.answers) {
          const note = a.notes?.trim();
          if ((a.kind === "option" || a.kind === "custom") && a.answer) answers.push({ question: a.question, answer: a.answer, ...(note ? { note } : {}) });
          else if (note) answers.push({ question: a.question, answer: "(no choice)", note });
        }
        if (result.note?.trim()) answers.push({ question: "All of the above", answer: "(a note on the answers as a whole)", note: result.note.trim() });
        return answers;
      }
      // Questions the dialog refuses (fewer than 2 options, say) are asked with Pi's selects.
    }
    const answers: Answer[] = [];
    for (const q of plan.questions) {
      const choice = await waiting(q.question, () => ctx.ui.select(q.question, [...q.options.map((o) => o.label), WRITE_OWN, SKIP]));
      if (choice === undefined) return undefined;
      if (choice === SKIP) continue;
      if (choice === WRITE_OWN) {
        const own = await waiting(q.question, () => askText(pi, ctx, q.question));
        if (own === undefined) return undefined;
        if (own.trim()) answers.push({ question: q.question, answer: own.trim() });
        continue;
      }
      answers.push({ question: q.question, answer: choice });
    }
    return answers;
  }

  /** What to do with the draft: in pi-ask-user-question's dialog when loaded, else Pi's select. */
  async function reviewChoice(ctx: ExtensionContext, hasPrompt: boolean): Promise<Review> {
    const service = requestAsk(pi.events);
    if (service) {
      const question: ServiceQuestion = {
        question: `${REVIEW_QUESTION} Or type what should change.`,
        header: "Compaction",
        options: [
          { label: STOP, description: hasPrompt ? "Compact; your next prompt waits in the editor." : "Compact, then wait for you." },
          { label: CONTINUE, description: hasPrompt ? "Compact, then send your next prompt." : "Compact, then continue the current work." },
          { label: EDIT, description: "Open the focus in the editor." },
          { label: CANCEL, description: "Leave the session as it is." },
        ],
      };
      const result = await service(ctx, { questions: [question] }, { label: REVIEW_QUESTION }).catch(() => undefined);
      if (isAnswer(result)) {
        const a = result.answers[0];
        if (result.cancelled || !a) return { action: "cancel" };
        const note = a.notes?.trim() || undefined;
        if (a.kind === "custom" && a.answer) return { action: "change", feedback: note ? `${a.answer}\n${note}` : a.answer };
        if (a.answer === STOP) return { action: "stop", note };
        if (a.answer === CONTINUE) return { action: "continue", note };
        if (a.answer === EDIT) return { action: "edit", note };
        if (a.kind === "unanswered" && note) return { action: "change", feedback: note };
        return { action: "cancel" };
      }
    }
    const choice = await waiting(REVIEW_QUESTION, () => ctx.ui.select(REVIEW_QUESTION, [STOP, CONTINUE, EDIT, CHANGE, CANCEL]));
    if (choice === STOP) return { action: "stop" };
    if (choice === CONTINUE) return { action: "continue" };
    if (choice === EDIT) return { action: "edit" };
    if (choice === CHANGE) {
      const feedback = (await waiting("What should change?", () => askText(pi, ctx, "What should change?")))?.trim();
      return feedback ? { action: "change", feedback } : { action: "none" };
    }
    return { action: "cancel" };
  }

  /** The summary, written on the session's last request so the conversation is read from the prompt cache. */
  async function cachedSummary(ctx: ExtensionContext, event: { preparation: any; branchEntries: readonly any[]; signal: AbortSignal }, focus: string): Promise<{ result: CompactionResult; usage: Usage }> {
    const prep = event.preparation;
    const kept = keptStart(event.branchEntries, prep.firstKeptEntryId, prep.isSplitTurn === true);
    if (!kept) throw new Error("the kept part of the conversation was not found");
    drafting = true;
    try {
      const { reply, usage } = await request(ctx, [userText(summaryPrompt(focus, kept))], event.signal, "full", true);
      if (Array.isArray(reply.content) && reply.content.some((b: any) => b?.type === "toolCall")) throw new Error("the model called a tool instead");
      if (reply.stopReason === "length") throw new Error("the summary hit the token cap");
      const text = replyText(reply as { content?: unknown }).trim();
      if (!text) throw new Error("the model sent an empty summary");
      const { readFiles, modifiedFiles } = fileLists(prep.fileOps);
      return {
        result: {
          summary: text + formatFiles(readFiles, modifiedFiles),
          firstKeptEntryId: prep.firstKeptEntryId,
          tokensBefore: prep.tokensBefore,
          ...(reply.usage ? { usage: reply.usage as never } : {}),
          details: { readFiles, modifiedFiles },
        },
        usage,
      };
    } finally {
      drafting = false;
    }
  }

  /** Pi's own summarizer with the focus, as `/compact <focus>` runs it. */
  async function defaultSummary(ctx: ExtensionContext, event: { preparation: any; signal: AbortSignal }, focus: string): Promise<CompactionResult> {
    const model = physicalModel(ctx);
    const auth = (await (ctx.modelRegistry as any).getApiKeyAndHeaders(model)) as { ok: boolean; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string>; error?: string };
    if (!auth?.ok) throw new Error(auth?.error ?? `no credentials for ${model.provider}`);
    return compact(event.preparation, model as never, auth.apiKey, auth.headers, focus, event.signal, undefined, undefined, auth.env);
  }

  pi.on("session_before_compact", async (event, ctx) => {
    const job = event.customInstructions ? summaries.get(event.customInstructions) : undefined;
    if (!job) return undefined;
    try {
      const { result, usage } = await cachedSummary(ctx, event, job.focus);
      job.usage = usage;
      return { compaction: result };
    } catch {
      if (event.signal.aborted) return { cancel: true };
    }
    // The cache could not serve it: Pi's summarizer, with the focus rather than the marker.
    try {
      return { compaction: await defaultSummary(ctx, event, job.focus) };
    } catch (error) {
      job.error = event.signal.aborted ? undefined : error instanceof Error ? error.message : String(error);
      return { cancel: true };
    }
  });

  async function handle(args: string, ctx: ExtensionCommandContext) {
    if (!ctx.hasUI) return;
    const goal = (args ?? "").trim();
    await ctx.waitForIdle();

    const chosen = await chooseSource(ctx);
    if (!chosen) {
      ctx.ui.notify("Compaction cancelled", "info");
      return;
    }
    const source: Source = chosen.source;

    const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0 };
    const addUsage = (u: Usage) => {
      usage.input += u.input;
      usage.cacheRead += u.cacheRead;
      usage.cacheWrite += u.cacheWrite;
    };
    const ask = async (side: AgentMessage[], label: string) => {
      const result = await working(ctx, label, (signal) => request(ctx, side, signal, source));
      addUsage(result.usage);
      return result.reply;
    };
    const failure = (error: unknown) => {
      if (error instanceof Cancelled) ctx.ui.notify(`${COMMAND}: ${error.message === "stopped" ? "stopped" : "drafting timed out"}`, "info");
      else ctx.ui.notify(`${COMMAND}: drafting failed (${error instanceof Error ? error.message : String(error)})`, "error");
    };

    // The side conversation so far; each revision continues it.
    const firstPrompt = draftPrompt(goal);
    const side: AgentMessage[] = [userText(source === "outline" ? `${outlineContext(chosen.outline ?? "")}\n\n${firstPrompt}` : firstPrompt)];
    let plan: Plan;
    try {
      const first = await ask(side, source === "outline" ? "Drafting the compaction focus from an outline…" : "Drafting the compaction focus…");
      side.push(first as AgentMessage);
      const parsed = parsePlan(replyText(first));
      if (!parsed) throw new Error("the model sent an empty reply");
      plan = parsed;
      if (plan.questions.length) {
        const answers = await askQuestions(ctx, plan);
        if (answers === undefined) {
          ctx.ui.notify("Compaction cancelled", "info");
          return;
        }
        if (answers.length) {
          side.push(userText(refinePrompt(answers)));
          const second = await ask(side, "Revising the focus with your answers…");
          side.push(second as AgentMessage);
          plan = parsePlan(replyText(second)) ?? plan;
        }
      }
    } catch (error) {
      failure(error);
      return;
    }

    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const state: DraftState = { goal, draft: plan.draft, status: "pending", ...(source === "outline" ? { source } : {}) };
    states.set(id, state);
    pi.appendEntry<DraftEntry>(ENTRY, { id, goal, draft: plan.draft });
    const record = () => pi.appendEntry<OutcomeEntry>(OUTCOME_ENTRY, { id, ...state });

    for (;;) {
      state.status = "pending";
      const review = await reviewChoice(ctx, !!goal);
      if (review.action === "none") continue;
      if ((review.action === "stop" || review.action === "continue" || review.action === "edit") && review.note) {
        state.draft = `${state.draft}\n- **Also:** ${review.note.replace(/\s*\n\s*/gu, " ")}`;
        state.edited = true;
      }
      if (review.action === "stop") break;
      if (review.action === "continue") {
        state.continued = true;
        break;
      }
      if (review.action === "edit") {
        const edited = await waiting("Edit the compaction focus", () =>
          askText(pi, ctx, "Edit the compaction focus", { initial: state.draft, hint: "enter save · esc in normal mode (or :q) discard changes" }),
        );
        if (edited?.trim() && edited.trim() !== state.draft) {
          state.draft = edited.trim();
          state.edited = true;
        }
        continue;
      }
      if (review.action === "change") {
        const feedback = review.feedback;
        state.status = "drafting";
        try {
          side.push(userText(revisePrompt(state.draft, feedback)));
          const revised = await ask(side, "Revising the focus…");
          side.push(revised as AgentMessage);
          const next = parsePlan(replyText(revised));
          if (!next) throw new Error("the model sent an empty reply");
          state.draft = next.draft;
          state.edited = false;
        } catch (error) {
          // Keep the conversation well formed: drop the unanswered request (and an empty reply).
          while (side.length > 1 && side.at(-1)?.role !== "user") side.pop();
          if (side.length > 1) side.pop();
          failure(error);
        }
        continue;
      }
      // The card's status line says so; no notification on top.
      state.status = "cancelled";
      record();
      return;
    }

    // From the prompt cache when the drafting just read it from there; else Pi's summarizer.
    const job: SummaryJob = { focus: state.draft };
    const marker = summaryWarm(ctx) ? `${DIRECT_PREFIX}${randomUUID()}` : undefined;
    if (marker) summaries.set(marker, job);
    state.status = "compacting";
    const settle = () => {
      if (marker) summaries.delete(marker);
      if (job.usage) {
        addUsage(job.usage);
        state.summary = "cache";
      }
      const total = usage.input + usage.cacheRead + usage.cacheWrite;
      state.tokens = total;
      state.cached = total ? Math.round((usage.cacheRead / total) * 100) : 0;
    };
    ctx.compact({
      customInstructions: marker ?? state.draft,
      onComplete: () => {
        if (state.status !== "compacting") return;
        settle();
        state.status = "compacted";
        record();
        if (state.continued) pi.sendUserMessage(continuation(goal || CONTINUE_PROMPT));
        else if (goal && !ctx.ui.getEditorText().trim()) ctx.ui.setEditorText(goal);
      },
      onError: (error) => {
        if (state.status !== "compacting") return;
        settle();
        if (!job.error && /^compaction cancelled$/iu.test(error.message)) {
          state.status = "cancelled";
        } else {
          state.status = "failed";
          state.error = job.error ?? error.message;
        }
        // Pi reports the error itself; the draft's status line records it.
        record();
      },
    });
  }

  pi.registerCommand(COMMAND, {
    description: "Work out a compaction focus with the session, then compact and stop, or continue with [next prompt]",
    handler: (args, ctx) => handle(args, ctx),
  });
}
