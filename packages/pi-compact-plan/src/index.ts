// pi-compact-plan: /compact-plan [what you will do next]. A small plan for a compaction: you say
// what comes next, the session asks a question or two only if the answer changes what the summary
// must keep, then drafts focus instructions. The draft is shown in the transcript like a plan
// waiting for approval, with Pi's select under it: compact with it, edit it (in the suite's editor,
// so pi-vim works), tell the session what to change, or cancel.
//
// The drafting is a side request to the session's model, outside the session: nothing is added to
// the model's context, and the session's extensions never see it. It reuses the session's last
// provider request byte for byte (splice.ts), so the conversation comes from the prompt cache; when
// that is not possible (another API, no request since /tree or a compaction) it sends the session's
// context as an ordinary request. Escape stops a request in flight.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { holdBlocked, holdWorking } from "./herdr-blocked.ts";
import { type Answer, draftPrompt, parsePlan, type Plan, refinePrompt, replyText, revisePrompt } from "./protocol.ts";
import { entryText, isConversationRequest, splicePayload } from "./splice.ts";
import { askText } from "./text-input.ts";
import { type DraftEntry, type DraftState, DraftView, ENTRY, OUTCOME_ENTRY, type OutcomeEntry } from "./view.ts";

export const COMMAND = "compact-plan";
export const WIDGET = "compact-plan";
export const WRITE_OWN = "Type your own answer";
export const SKIP = "Skip this question";
export const APPROVE = "Yes, compact with it";
export const EDIT = "Edit the focus";
export const CHANGE = "No, change it";
export const CANCEL = "Cancel";
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
  /** Drafts of this process and recorded outcomes, by entry id, for the transcript renderer. */
  const states = new Map<string, DraftState>();

  pi.registerEntryRenderer<DraftEntry>(ENTRY, (entry, _options, theme) => {
    const data = entry.data;
    if (!data?.id || typeof data.draft !== "string") return undefined;
    const fallback: DraftState = { goal: data.goal ?? "", draft: data.draft, status: "cancelled" };
    return new DraftView(() => states.get(data.id) ?? fallback, theme);
  });
  // The outcome is state for the draft's block, not a block of its own.
  pi.registerEntryRenderer(OUTCOME_ENTRY, () => undefined);

  pi.on("session_start", (_event, ctx) => {
    last = undefined;
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
  });
  pi.on("session_compact", () => {
    last = undefined;
  });
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (drafting || !model) return undefined;
    const leaf = ctx.sessionManager.getLeafEntry?.();
    if (!isConversationRequest(event.payload, model.id, entryText(leaf))) return undefined;
    // A reference: handlers that run later may still edit it in place. It is copied when used.
    last = { api: model.api, provider: model.provider, model: model.id, leafId: ctx.sessionManager.getLeafId(), payload: event.payload };
    return undefined;
  });

  /** One drafting request: spliced onto the session's last request when possible, else plain. */
  async function request(ctx: ExtensionContext, side: AgentMessage[], signal: AbortSignal): Promise<{ reply: Reply; usage: Usage }> {
    const registry = ctx.modelRegistry as any;
    const usageOf = (r: Reply): Usage => ({ input: r.usage?.input ?? 0, cacheRead: r.usage?.cacheRead ?? 0, cacheWrite: r.usage?.cacheWrite ?? 0 });
    const failed = (r: Reply) => r.stopReason === "error" || r.stopReason === "aborted";

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
        if (!failed(reply)) return { reply, usage: usageOf(reply) };
        if (!spliceError) throw new Error(reply.errorMessage ?? "the model request failed");
      } catch (error) {
        if (signal.aborted) throw new Cancelled();
        if (!spliceError) throw error;
      }
    }

    const fallbackModel = ctx.model;
    if (!fallbackModel) throw new Error("no model selected");
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
    const answers: Answer[] = [];
    for (const q of plan.questions) {
      const choice = await waiting(q.question, () => ctx.ui.select(q.question, [...q.options, WRITE_OWN, SKIP]));
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

  pi.registerCommand(COMMAND, {
    description: "Plan a compaction: say what comes next, answer any question, then approve the focus it drafts",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      await ctx.waitForIdle();
      let goal = (args ?? "").trim();
      if (!goal) {
        const typed = await waiting("What will you do after compacting?", () =>
          askText(pi, ctx, "What will you do after compacting?", {
            hint: "enter submit (empty: let the session infer it) · esc then esc (or :q) cancel",
            placeholder: "leave empty to let the session infer it",
          }),
        );
        if (typed === undefined) return;
        goal = typed.trim();
      }

      const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0 };
      const ask = async (side: AgentMessage[], label: string) => {
        const result = await working(ctx, label, (signal) => request(ctx, side, signal));
        usage.input += result.usage.input;
        usage.cacheRead += result.usage.cacheRead;
        usage.cacheWrite += result.usage.cacheWrite;
        return result.reply;
      };
      const failure = (error: unknown) => {
        if (error instanceof Cancelled) ctx.ui.notify(`compact-plan: ${error.message === "stopped" ? "stopped" : "drafting timed out"}`, "info");
        else ctx.ui.notify(`compact-plan: drafting failed (${error instanceof Error ? error.message : String(error)})`, "error");
      };

      // The side conversation so far; each revision continues it.
      const side: AgentMessage[] = [userText(draftPrompt(goal))];
      let plan: Plan;
      try {
        const first = await ask(side, "Drafting the compaction focus…");
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
            const second = await ask(side, "Revising the draft with your answers…");
            side.push(second as AgentMessage);
            plan = parsePlan(replyText(second)) ?? plan;
          }
        }
      } catch (error) {
        failure(error);
        return;
      }

      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const state: DraftState = { goal, draft: plan.draft, status: "pending" };
      states.set(id, state);
      pi.appendEntry<DraftEntry>(ENTRY, { id, goal, draft: plan.draft });
      const record = () => pi.appendEntry<OutcomeEntry>(OUTCOME_ENTRY, { id, ...state });

      for (;;) {
        state.status = "pending";
        const choice = await waiting("Compact with this focus?", () => ctx.ui.select("Compact with this focus?", [APPROVE, EDIT, CHANGE, CANCEL]));
        if (choice === APPROVE) break;
        if (choice === EDIT) {
          const edited = await waiting("Edit the compaction focus", () =>
            askText(pi, ctx, "Edit the compaction focus", { initial: state.draft, hint: "enter save · esc in normal mode (or :q) discard changes" }),
          );
          if (edited?.trim() && edited.trim() !== state.draft) {
            state.draft = edited.trim();
            state.edited = true;
          }
          continue;
        }
        if (choice === CHANGE) {
          const feedback = (await waiting("What should change?", () => askText(pi, ctx, "What should change?")))?.trim();
          if (!feedback) continue;
          state.status = "drafting";
          try {
            side.push(userText(revisePrompt(state.draft, feedback)));
            const revised = await ask(side, "Revising the draft…");
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
        state.status = "cancelled";
        record();
        ctx.ui.notify("Compaction cancelled", "info");
        return;
      }

      const total = usage.input + usage.cacheRead + usage.cacheWrite;
      state.tokens = total;
      state.cached = total ? Math.round((usage.cacheRead / total) * 100) : 0;
      state.status = "compacting";
      ctx.compact({
        customInstructions: state.draft,
        onComplete: () => {
          state.status = "compacted";
          record();
          if (goal && !ctx.ui.getEditorText().trim()) ctx.ui.setEditorText(goal);
        },
        onError: (error) => {
          state.status = "failed";
          state.error = error.message;
          // Pi reports the error itself; the draft's status line records it.
          record();
        },
      });
    },
  });
}
