// Keeping the context lean with Jev, through Pi's own classifier models:
//
// 1. Trims large tool output as it arrives (`tool_result`), before it enters the context, so the
//    prompt cache is never disturbed: Jev picks the blocks the agent needs for its current step;
//    the rest becomes `[… N lines omitted …]` markers and the full output is saved to a file the
//    agent can read.
// 2. Compaction (`session_before_compact`): Jev sorts every message and tool call into verbatim,
//    summarize or drop. A Jev compaction (the cold-cache menu, `/cache-guard compact`, overflow
//    recovery) writes the summary in code, with no LLM; `/compact` and threshold compaction run
//    Pi's own summarizer on the filtered conversation and append the verbatim items.
//
// Without an available System 1 rung (or when off), Pi compacts as it always does.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compact } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { agentDir, loadSettings } from "./config.ts";
import { isVirtual, routedModel } from "./routed-model.ts";
import { DEFAULT_SETTINGS, type Settings } from "./core.ts";
import { type ClassifierUsage, type JevState, addUsage, askJev, resolveJev } from "./jev.ts";
import {
  type Keep,
  type TrimLimits,
  type Unit,
  batches,
  blocksFor,
  codeSummary,
  keepAnswers,
  keepCounts,
  keepQuestions,
  keepState,
  trimQuestions,
  trimState,
  trimVerdict,
  verbatimSection,
} from "./lean.ts";
import { extractUnits, filterMessages, lastUserMessages, recentTexts } from "./units.ts";
import { SYSTEM1_CHANGED, provenanceOf, resolveSystem1Target, type System1Attempt, type System1DecisionProvenance, type System1FailureCode } from "./system1.ts";

/** Session entries recording each Jev decision (never sent to the model). */
export const DECISION_TYPE = "cache-guard:jev";
/** pi-status-footer folds `lean: …` under this key into its context row. */
export const TRIM_STATUS_KEY = "lean-context";
/** A missing Jev is looked for again at most this often (after a `/login`, say). */
const RECHECK_MS = 60_000;

type Content = { type: string; text?: string; [key: string]: unknown };

/** One logical batch, ordered by input rather than asynchronous completion. */
interface BatchDecision {
  batch: number;
  units: string[];
  classifier?: System1DecisionProvenance;
  code?: System1FailureCode;
  reason?: string;
  attempts: System1Attempt[];
  selectionKey?: string;
  latencyMs: number;
  usage?: ClassifierUsage;
}

export interface JevCompaction {
  /** What the compacted conversation continues toward; default: the instructions or the last requests. */
  goal?: string;
  /** Cancel instead of falling back to Pi's summary when Jev fails, so nothing is spent. */
  strict: boolean;
}

export interface Lean {
  /** Jev as last found; looked for again when it was missing (a login since) and `ctx` is given. */
  jev(ctx?: ExtensionContext): Promise<JevState>;
  /** Look for Jev again: after a login or a settings change. */
  refresh(ctx: ExtensionContext): Promise<JevState>;
  /** Make the next compaction Jev's, written in code. */
  armJevCompaction(options: JevCompaction): void;
  disarm(): void;
  /** Why the last Jev compaction did not happen, if it did not. */
  lastFailure(): string | undefined;
  /** Characters trimmed from tool output this session. */
  savedChars(): number;
}

/** Which tools' output may be trimmed, and from what size. */
export function trimFloor(tool: string, limits: TrimLimits): number | undefined {
  if (tool === "edit" || tool === "write") return undefined;
  if (tool === "read") return limits.readMinChars;
  if (["bash", "grep", "find", "ls", "codemode"].includes(tool) || tool.startsWith("mcp__")) return limits.minChars;
  if (/web|fetch|search|content/iu.test(tool)) return limits.minChars;
  return undefined;
}

export function trimStatus(savedChars: number): string | undefined {
  return savedChars > 0 ? `lean: −${Math.round(savedChars / 4_000)}k tok` : undefined;
}

export function leanContext(pi: ExtensionAPI): Lean {
  let settings: Settings = DEFAULT_SETTINGS;
  let jevKey = "";
  let jevState: Promise<JevState> = Promise.resolve({ kind: "missing", reason: "not checked yet" });
  let current: JevState | undefined;
  let checkedAt = 0;
  let armed: JevCompaction | undefined;
  let failure: string | undefined;
  let saved = 0;
  const trimmedThisTurn = new Set<string>();
  const pending = new Set<AbortController>();
  let generation = 0;
  let lastContext: ExtensionContext | undefined;
  const changed = "System 1 changed while judging; retry the request";
  const invalidate = () => {
    generation++;
    for (const controller of pending) controller.abort();
    pending.clear();
    current = undefined;
    jevKey = "";
    jevState = Promise.resolve({ kind: "missing", reason: "not checked yet" });
  };
  const keyOf = (s: Settings) => JSON.stringify([s.enabled, s.jev, resolveSystem1Target(s.jev).key]);
  const operation = (ctx: ExtensionContext, target: { provider: string; model: string }, signal?: AbortSignal) => {
    const controller = new AbortController();
    const owner = generation;
    const key = keyOf(settings);
    const selectionKey = resolveSystem1Target(target).key;
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    pending.add(controller);
    return {
      signal: controller.signal,
      valid: () => owner === generation && !controller.signal.aborted && keyOf(loadSettings(ctx.cwd)) === key && resolveSystem1Target(target).key === selectionKey,
      selectionKey,
      dispose: () => {
        pending.delete(controller);
        signal?.removeEventListener("abort", abort);
      },
    };
  };
  const refresh = (ctx: ExtensionContext) => {
    lastContext = ctx;
    const nextKey = keyOf(settings);
    if (jevKey && jevKey !== nextKey) invalidate();
    jevKey = nextKey;
    checkedAt = Date.now();
    const next = resolveJev(ctx.modelRegistry, { ...settings.jev, enabled: settings.enabled && settings.jev.enabled });
    jevState = next;
    void next.then((state) => {
      if (jevState === next) current = state;
    });
    return next;
  };
  /** New settings, or a Jev that was missing a minute ago (credentials may have arrived): look again. */
  const reload = (ctx: ExtensionContext) => {
    lastContext = ctx;
    settings = loadSettings(ctx.cwd);
    if (keyOf(settings) !== jevKey || (current?.kind === "missing" && Date.now() - checkedAt >= RECHECK_MS)) void refresh(ctx);
  };

  pi.events?.on(SYSTEM1_CHANGED, () => {
    invalidate();
    if (lastContext) {
      settings = loadSettings(lastContext.cwd);
      void refresh(lastContext);
    }
  });
  pi.on("session_shutdown", () => {
    invalidate();
    lastContext = undefined;
  });
  pi.on("session_start", (_event, ctx) => {
    invalidate();
    settings = loadSettings(ctx.cwd);
    current = undefined;
    saved = 0;
    armed = undefined;
    trimmedThisTurn.clear();
    void refresh(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    reload(ctx);
    trimmedThisTurn.clear();
  });

  pi.on("tool_result", async (event, ctx) => {
    reload(ctx);
    if (!settings.enabled || !settings.trim.enabled) return undefined;
    // Nested calls return to a script (codemode), not to the context.
    if ((event as { parentToolCallId?: string }).parentToolCallId) return undefined;
    const floor = trimFloor(event.toolName, settings.trim);
    if (floor === undefined) return undefined;
    const content = event.content as Content[];
    const text = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    if (text.length <= floor) return undefined;
    // The agent asked again for something already trimmed this turn: give it everything.
    const key = `${event.toolName}:${JSON.stringify(event.input)}`;
    if (trimmedThisTurn.has(key)) return undefined;
    const availabilityKey = jevKey;
    const jev = await jevState;
    if (jev.kind !== "ready" || keyOf(loadSettings(ctx.cwd)) !== availabilityKey || jevKey !== availabilityKey) return undefined;
    const op = operation(ctx, jev.jevTarget, ctx.signal);
    try {
      const { lines, blocks } = blocksFor(text, settings.trim);
      const texts = recentTexts(ctx.sessionManager.getBranch());
      const state = trimState({ user_request: texts.user, agent_said: texts.assistant, tool: event.toolName, arguments: JSON.stringify(event.input) }, blocks);
      if (!op.valid()) return undefined;
      const outcome = await askJev(ctx.modelRegistry, jev.jevTarget, settings.jev.timeoutMs, state, trimQuestions(blocks), op.signal);
      const usage = addUsage(event.usage as ClassifierUsage | undefined, outcome.usage);
      const passUsage = usage ? { usage: usage as never } : undefined;
      if (!outcome.ok || !op.valid() || outcome.selectionKey !== op.selectionKey) return passUsage;
      const fullPath = savePath(ctx, event.toolCallId);
      const verdict = trimVerdict(lines, blocks, outcome.answers, settings.trim, fullPath);
      pi.appendEntry(DECISION_TYPE, {
        kind: "trim",
        tool: event.toolName,
        lines: verdict.totalLines,
        kept: verdict.trim ? verdict.keptLines : verdict.totalLines,
        needsAll: verdict.needsAll,
        blocks: blocks.length,
        latencyMs: outcome.latencyMs,
        inputTokens: outcome.usage?.input,
        usage: outcome.usage,
        classifier: provenanceOf(outcome),
      });
      if (!verdict.trim) return passUsage;
      try {
        mkdirSync(path.dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, text);
      } catch {
        return passUsage;
      }
      trimmedThisTurn.add(key);
      saved += text.length - verdict.text.length;
      if (ctx.hasUI) ctx.ui.setStatus(TRIM_STATUS_KEY, trimStatus(saved));
      return {
        content: [...content.filter((b) => b.type !== "text"), { type: "text", text: verdict.text }] as never,
        ...(passUsage ?? {}),
      };
    } finally {
      op.dispose();
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    // Plan-mode owns this deterministic compaction; preserve quick-compaction state too.
    if (/^plan-mode-direct:[\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12}(?![\s\S])/u.test(event.customInstructions ?? "")) return undefined;
    reload(ctx);
    const request = armed;
    armed = undefined;
    failure = undefined;
    const jevOnly = request !== undefined || event.reason === "overflow";
    const fail = (reason: string) => {
      failure = reason;
      if (request?.strict) return { cancel: true };
      if (jevOnly && ctx.hasUI) ctx.ui.notify(`Quick compaction: ${reason}; using Pi's compaction.`, "warning");
      return undefined;
    };
    if (!settings.enabled) return request?.strict ? fail("cache-guard is off") : undefined;
    if (!jevOnly && !settings.compact.filter) return undefined;
    const availabilityKey = jevKey;
    const jev = await jevState;
    if (keyOf(loadSettings(ctx.cwd)) !== availabilityKey || jevKey !== availabilityKey) return fail(changed);
    if (jev.kind !== "ready") return jevOnly ? fail(jev.kind === "off" ? "System 1 is off for cache-guard" : `System 1 is unavailable (${jev.reason})`) : undefined;
    const prep = event.preparation;
    const main = extractUnits(prep.messagesToSummarize, "U");
    const prefix = extractUnits(prep.turnPrefixMessages, "P");
    const units = [...main, ...prefix];
    if (!units.length) return jevOnly ? fail("nothing to judge") : undefined;

    const goal = request?.goal?.trim() || event.customInstructions?.trim() || lastUserMessages(event.branchEntries, 2);
    const op = operation(ctx, jev.jevTarget, event.signal);
    const classifiers: BatchDecision[] = [];
    try {
      const recordFailure = (reason: string, usage?: ClassifierUsage) => {
        // A cancelled/failed compaction has no usage-bearing compaction entry. Retain all
        // attempted classifier usage in the decision audit entry, including failed batches.
        if (usage || classifiers.length) pi.appendEntry(DECISION_TYPE, { kind: "compact", failed: true, reason, usage, classifiers });
        return fail(reason);
      };
      const judged = await judgeUnits(ctx, jev.jevTarget, units, goal, op, classifiers);
      if (!judged.ok) return recordFailure(judged.reason, judged.usage);
      if (!op.valid()) return recordFailure(event.signal.aborted ? "cancelled" : changed, judged.usage);
      const { keep, usage } = judged;
      const counts = keepCounts(keep);
      const recordSuccess = () => pi.appendEntry(DECISION_TYPE, {
        kind: "compact", jevOnly, units: units.length, ...counts, latencyMs: judged.latencyMs, usage,
        classifier: classifiers.length === 1 ? classifiers[0]?.classifier : undefined,
        classifiers,
      });

      if (jevOnly) {
        recordSuccess();
        const summary = codeSummary({ units, keep, previousSummary: prep.previousSummary, fileOps: prep.fileOps, instructions: event.customInstructions });
        return {
          compaction: {
            summary,
            firstKeptEntryId: prep.firstKeptEntryId,
            tokensBefore: prep.tokensBefore,
            details: { cacheGuard: { mode: "jev", ...counts } },
            ...(usage ? { usage: usage as never } : {}),
          },
        };
      }

      // A virtual selection (a plan model pair) cannot summarize directly: use the model behind it.
      const model = isVirtual(ctx.model) ? routedModel(ctx as never) : ctx.model;
      if (!model) return recordFailure("no summary model", usage);
      try {
        const auth = (await ctx.modelRegistry.getApiKeyAndHeaders(model)) as { ok: boolean; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> };
        if (!auth.ok) return recordFailure("summary credentials unavailable", usage);
        if (!op.valid()) return recordFailure(event.signal.aborted ? "cancelled" : changed, usage);
        const filtered = {
          ...prep,
          messagesToSummarize: filterMessages(prep.messagesToSummarize, main, keep),
          turnPrefixMessages: filterMessages(prep.turnPrefixMessages, prefix, keep),
        } as typeof prep;
        const result = await compact(filtered, model, auth.apiKey, auth.headers, event.customInstructions, op.signal, undefined, undefined, auth.env);
        const resultUsage = (result as { usage?: ClassifierUsage }).usage;
        const total = addUsage(resultUsage, usage);
        if (!op.valid()) return recordFailure(event.signal.aborted ? "cancelled" : changed, total);
        const verbatim = verbatimSection(units, keep);
        recordSuccess();
        return {
          compaction: {
            ...result,
            summary: verbatim ? `${result.summary}\n\n${verbatim}` : result.summary,
            details: { ...(isRecord(result.details) ? result.details : {}), cacheGuard: { mode: "filtered", ...counts } },
            ...(total ? { usage: total as never } : {}),
          },
        };
      } catch {
        return recordFailure(op.signal.aborted ? "cancelled or System 1 changed" : "Pi's compaction failed", usage);
      }
    } finally {
      op.dispose();
    }
  });

  async function judgeUnits(ctx: ExtensionContext, target: { provider: string; model: string }, units: Unit[], goal: string, op: ReturnType<typeof operation>, classifiers: BatchDecision[]) {
    const started = Date.now();
    const keep = new Map<string, Keep>();
    let usage: ClassifierUsage | undefined;
    const queue = batches(units).map((units, batch) => ({ units, batch }));
    let reason: string | undefined;
    const timeoutMs = settings.compact.timeoutMs;
    const concurrency = settings.compact.concurrency;
    const worker = async () => {
      for (let item = queue.shift(); item && !reason; item = queue.shift()) {
        const batch = item.units;
        // One captured order owns every batch. Winners may differ, but never start a
        // later batch under a replacement order, even without a change event.
        if (!op.valid()) {
          reason ??= op.signal.aborted ? "cancelled or System 1 changed" : changed;
          return;
        }
        const outcome = await askJev(ctx.modelRegistry, target, timeoutMs, keepState(goal, batch), keepQuestions(batch), op.signal);
        usage = addUsage(usage, outcome.usage);
        classifiers.push({
          batch: item.batch,
          units: batch.map((unit) => unit.id),
          ...(outcome.ok ? { classifier: provenanceOf(outcome) } : { code: outcome.code, reason: outcome.reason }),
          attempts: outcome.attempts,
          selectionKey: outcome.selectionKey,
          latencyMs: outcome.latencyMs,
          usage: outcome.usage,
        });
        if (!op.valid() || (outcome.ok && outcome.selectionKey !== op.selectionKey)) {
          reason ??= "cancelled or System 1 changed";
          return;
        }
        if (!outcome.ok) {
          reason ??= outcome.reason;
          return;
        }
        keepAnswers(batch, outcome.answers, keep);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    classifiers.sort((a, b) => a.batch - b.batch);
    if (reason) return { ok: false as const, reason: `classification failed (${reason})`, usage };
    return { ok: true as const, keep, usage, latencyMs: Date.now() - started };
  }

  return {
    jev: (ctx) => {
      if (ctx) reload(ctx);
      return jevState;
    },
    refresh: (ctx) => {
      settings = loadSettings(ctx.cwd);
      return refresh(ctx);
    },
    armJevCompaction: (options) => {
      armed = options;
    },
    disarm: () => {
      armed = undefined;
    },
    lastFailure: () => failure,
    savedChars: () => saved,
  };
}

function savePath(ctx: ExtensionContext, toolCallId: string) {
  const session = ctx.sessionManager.getSessionId?.() ?? "session";
  return path.join(agentDir(), "cache-guard", "tool-output", session.replace(/[^\w.-]/gu, "_"), `${toolCallId.replace(/[^\w.-]/gu, "_")}.txt`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
