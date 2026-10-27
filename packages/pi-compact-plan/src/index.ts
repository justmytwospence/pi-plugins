// pi-compact-plan: /compact-plan [what you will do next]. A small plan for a compaction: you say
// what comes next, the session asks a question or two only if the answer changes what the summary
// must keep, then drafts the focus instructions and opens them in an editor. Submit to compact with
// them (after any tweaks); Esc cancels.
//
// The drafting is a side request to the session's model, outside the session: nothing is added to
// the transcript, and the session's extensions never see it. It reuses the session's last provider
// request byte for byte (splice.ts), so the conversation comes from the prompt cache; when that is
// not possible (another API, no request since /tree or a compaction) it sends the session's context
// as an ordinary request.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { type Answer, draftPrompt, parsePlan, type Plan, refinePrompt, replyText } from "./protocol.ts";
import { isConversationRequest, splicePayload } from "./splice.ts";

export const COMMAND = "compact-plan";
export const WIDGET = "compact-plan";
export const WRITE_OWN = "Answer in my own words";
export const SKIP = "Skip this question";
const TIMEOUT_MS = 180_000;
const FALLBACK_MAX_TOKENS = 4_000;

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

  const forget = () => {
    last = undefined;
  };
  pi.on("session_start", forget);
  pi.on("session_tree", forget);
  pi.on("session_compact", forget);
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (drafting || !model || !isConversationRequest(event.payload, model.id, ctx.getSystemPrompt())) return undefined;
    // A reference: handlers that run later may still edit it in place. It is copied when used.
    last = { api: model.api, provider: model.provider, model: model.id, leafId: ctx.sessionManager.getLeafId(), payload: event.payload };
    return undefined;
  });

  /** One drafting request: spliced onto the session's last request when possible, else plain. */
  async function ask(ctx: ExtensionContext, side: AgentMessage[], signal: AbortSignal): Promise<{ reply: Reply; usage: Usage }> {
    const registry = ctx.modelRegistry as any;
    const usageOf = (r: Reply): Usage => ({ input: r.usage?.input ?? 0, cacheRead: r.usage?.cacheRead ?? 0, cacheWrite: r.usage?.cacheWrite ?? 0 });
    const failed = (r: Reply) => r.stopReason === "error" || r.stopReason === "aborted";

    const request = last;
    const delta = request ? messagesSince(ctx.sessionManager.getBranch() as any[], request.leafId) : undefined;
    const model = request && delta ? registry.find(request.provider, request.model) : undefined;
    if (request && delta && model) {
      let spliceError: string | undefined;
      try {
        const reply: Reply = await registry.complete(
          model,
          { systemPrompt: "", messages: convertToLlm([...delta, ...side]), tools: [] },
          {
            signal,
            maxRetries: 1,
            onPayload: (payload: unknown) => {
              const result = splicePayload(request.api, request.payload, payload);
              if (result.ok) return result.payload;
              spliceError = result.reason;
              throw new Error(`not sent: ${result.reason}`);
            },
          },
        );
        if (!failed(reply) || signal.aborted) return { reply, usage: usageOf(reply) };
        if (!spliceError) throw new Error(reply.errorMessage ?? "the model request failed");
      } catch (error) {
        if (signal.aborted || !spliceError) throw error;
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
    if (failed(reply)) throw new Error(reply.errorMessage ?? "the model request failed");
    return { reply, usage: usageOf(reply) };
  }

  const status = (ctx: ExtensionContext, text: string | undefined) => {
    try {
      ctx.ui.setWidget(WIDGET, text ? [text] : undefined);
    } catch {
      // The runtime went stale.
    }
  };

  /** Asks the plan's questions; undefined when the user backs out. */
  async function askQuestions(ctx: ExtensionContext, plan: Plan): Promise<Answer[] | undefined> {
    const answers: Answer[] = [];
    for (const q of plan.questions) {
      const choice = await ctx.ui.select(q.question, [...q.options, WRITE_OWN, SKIP]);
      if (choice === undefined) return undefined;
      if (choice === SKIP) continue;
      if (choice === WRITE_OWN) {
        const own = await ctx.ui.input(q.question, "your answer");
        if (own === undefined) return undefined;
        if (own.trim()) answers.push({ question: q.question, answer: own.trim() });
        continue;
      }
      answers.push({ question: q.question, answer: choice });
    }
    return answers;
  }

  pi.registerCommand(COMMAND, {
    description: "Plan a compaction: say what comes next, answer any question, then review the focus it drafts",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      await ctx.waitForIdle();
      let goal = (args ?? "").trim();
      if (!goal) {
        const typed = await ctx.ui.input("What will you do after compacting?", "leave empty to let the session infer it");
        if (typed === undefined) return;
        goal = typed.trim();
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0 };
      const add = (u: Usage) => {
        usage.input += u.input;
        usage.cacheRead += u.cacheRead;
        usage.cacheWrite += u.cacheWrite;
      };
      let draft: string;
      drafting = true;
      try {
        status(ctx, "compact-plan: drafting the compaction focus…");
        const side = [userText(draftPrompt(goal))];
        const first = await ask(ctx, side, controller.signal);
        add(first.usage);
        let plan = parsePlan(replyText(first.reply));
        if (!plan) throw new Error("the model sent an empty reply");
        if (plan.questions.length) {
          status(ctx, undefined);
          const answers = await askQuestions(ctx, plan);
          if (answers === undefined) {
            ctx.ui.notify("Compaction cancelled", "info");
            return;
          }
          if (answers.length) {
            status(ctx, "compact-plan: revising the draft…");
            const second = await ask(ctx, [...side, first.reply as AgentMessage, userText(refinePrompt(answers))], controller.signal);
            add(second.usage);
            plan = parsePlan(replyText(second.reply)) ?? plan;
          }
        }
        draft = plan.draft;
      } catch (error) {
        const reason = controller.signal.aborted ? "timed out" : error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`compact-plan: drafting failed (${reason})`, "error");
        return;
      } finally {
        drafting = false;
        clearTimeout(timer);
        status(ctx, undefined);
      }

      const total = usage.input + usage.cacheRead + usage.cacheWrite;
      const cached = total ? Math.round((usage.cacheRead / total) * 100) : 0;
      const focus = await ctx.ui.editor("Compaction focus: submit to compact with it, Esc to cancel", draft);
      if (focus === undefined || !focus.trim()) {
        ctx.ui.notify("Compaction cancelled", "info");
        return;
      }
      ctx.compact({
        customInstructions: focus.trim(),
        onComplete: () => {
          ctx.ui.notify(`Compacted (drafting read ${total.toLocaleString()} tokens, ${cached}% from cache)`, "info");
          if (goal && !ctx.ui.getEditorText().trim()) ctx.ui.setEditorText(goal);
        },
        onError: (error) => ctx.ui.notify(`Compaction failed: ${error.message}`, "error"),
      });
    },
  });
}
