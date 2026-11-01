// Package-local System 1 transport. Keep all nine copies byte-identical; no sibling imports.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const SYSTEM1_CHANGED = "pi-plugins.system1-changed.v1";
export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
}
export function system1Path(): string {
  return path.join(agentDir(), "system1.json");
}
export type System1Backend = "jev" | "openai-decisions";
export type System1Setting =
  | { ok: true; backend: System1Backend; key: string }
  | { ok: false; reason: string; key: string };
const unavailable = (reason: string): System1Setting => ({
  ok: false,
  reason,
  key: JSON.stringify(["unavailable", reason]),
});
export function readSystem1Setting(): System1Setting {
  let raw: string;
  try {
    raw = readFileSync(system1Path(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: true, backend: "jev", key: JSON.stringify(["jev"]) };
    return unavailable("System 1 configuration is unreadable");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return unavailable("System 1 configuration is malformed JSON");
  }
  if (!record(value) || (value.backend !== "jev" && value.backend !== "openai-decisions")) {
    return unavailable("System 1 configuration has an unsupported backend");
  }
  return { ok: true, backend: value.backend, key: JSON.stringify([value.backend]) };
}

export interface ClassifierBoolQuestion {
  type: "bool";
  instructions: string;
  criteria: { true: string; false: string };
}
export interface ClassifierChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface ClassifierScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}
export type ClassifierQuestion = ClassifierBoolQuestion | ClassifierChoiceQuestion | ClassifierScoreQuestion;
export type ClassifierAnswer =
  | { type: "bool"; probability: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number };
export interface ClassifierUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export interface ClassifierResult {
  model: string;
  answers: Record<string, ClassifierAnswer>;
  usage?: ClassifierUsage;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
}
/** Structural so standalone Jev packages can still load on older Pi hosts. */
export interface ClassifierRegistry {
  findOfType(type: "classifier", provider: string, modelId: string): unknown;
  classify(
    model: never,
    context: { state: Record<string, unknown>; questions: Record<string, ClassifierQuestion> },
    options?: { signal?: AbortSignal; timeoutMs?: number; retries?: number; maxRetries?: number },
  ): Promise<ClassifierResult>;
}
export type ClassifierConfig = { enabled: boolean; provider: string; model: string; timeoutMs: number };
export type ClassifierProvenance = { backend: System1Backend; provider: string; model: string };
export type System1Target =
  | ({ ok: true; key: string } & ClassifierProvenance)
  | { ok: false; reason: string; key: string };
export function resolveSystem1Target(
  config: Pick<ClassifierConfig, "provider" | "model">,
  setting = readSystem1Setting(),
): System1Target {
  if (!setting.ok) return setting;
  const provider = setting.backend === "jev" ? config.provider : "system1-openai";
  const model = setting.backend === "jev" ? config.model : "gpt-6-luna";
  return {
    ok: true,
    backend: setting.backend,
    provider,
    model,
    key: JSON.stringify([setting.backend, provider, model]),
  };
}
export type System1Outcome =
  | ({
      ok: true;
      answers: Record<string, ClassifierAnswer>;
      usage?: ClassifierUsage;
      latencyMs: number;
      selectionKey: string;
    } & ClassifierProvenance)
  | { ok: false; reason: string; usage?: ClassifierUsage };

/** Add only usage actually reported by the host, including failed attempts. */
export function addClassifierUsage(
  a: ClassifierUsage | undefined,
  b: ClassifierUsage | undefined,
): ClassifierUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}
const DECISIONS_UNAVAILABLE = "OpenAI Decisions is unavailable; enable pi-system1 and configure /login system1-openai";

/** One logical judgment; failure is data, never a fallback to another backend. */
export async function askSystem1(
  registry: unknown,
  config: ClassifierConfig,
  state: Record<string, unknown>,
  questions: Record<string, ClassifierQuestion>,
  signal?: AbortSignal,
  options: { retryTimeout?: boolean } = {},
): Promise<System1Outcome> {
  if (!config.enabled) return { ok: false, reason: "the classifier is off in settings" };
  if (!Object.keys(questions).length) return { ok: false, reason: "no questions to judge" };
  const started = Date.now();
  const target = resolveSystem1Target(config);
  if (!target.ok) return { ok: false, reason: target.reason };
  const native = target.backend === "openai-decisions";
  if (native && !validQuestions(questions)) return { ok: false, reason: "unsupported OpenAI Decisions question" };
  const reg = registry as Partial<ClassifierRegistry> | undefined;
  if (typeof reg?.findOfType !== "function" || typeof reg.classify !== "function") {
    return {
      ok: false,
      reason: native ? DECISIONS_UNAVAILABLE : "this Pi has no classifier models (needs Pi 0.99 or newer)",
    };
  }
  let model: unknown;
  try {
    model = reg.findOfType("classifier", target.provider, target.model);
  } catch {
    model = undefined;
  }
  if (!model)
    return {
      ok: false,
      reason: native ? DECISIONS_UNAVAILABLE : `no classifier model ${target.provider}/${target.model}`,
    };
  if (
    native &&
    (!record(model) ||
      model.api !== "openai-decisions" ||
      model.provider !== target.provider ||
      model.id !== target.model ||
      model.baseUrl !== "https://api.openai.com/v1")
  ) {
    return { ok: false, reason: "OpenAI Decisions API requires the native model and official API endpoint" };
  }
  const deadline = started + config.timeoutMs;
  const entries = Object.entries(questions);
  const batches = native
    ? Array.from({ length: Math.ceil(entries.length / 400) }, (_, i) =>
        Object.fromEntries(entries.slice(i * 400, (i + 1) * 400)),
      )
    : [questions];
  const answers: Record<string, ClassifierAnswer> = {};
  let usage: ClassifierUsage | undefined;
  let reportedModel = target.model;
  for (const batch of batches) {
    const timeoutMs = native ? Math.max(0, deadline - Date.now()) : config.timeoutMs;
    let outcome = await attempt(reg as ClassifierRegistry, model, state, batch, timeoutMs, signal, native);
    usage = addClassifierUsage(usage, outcome.ok ? outcome.result.usage : outcome.usage);
    if (
      !native &&
      !outcome.ok &&
      outcome.reason === "timed out" &&
      !signal?.aborted &&
      options.retryTimeout !== false
    ) {
      outcome = await attempt(reg as ClassifierRegistry, model, state, batch, config.timeoutMs, signal, false);
      usage = addClassifierUsage(usage, outcome.ok ? outcome.result.usage : outcome.usage);
    }
    if (!outcome.ok) return { ok: false, reason: outcome.reason, ...(usage ? { usage } : {}) };
    if (native && !validAnswers(batch, outcome.result.answers))
      return { ok: false, reason: "OpenAI Decisions API returned invalid answers", ...(usage ? { usage } : {}) };
    // Jev can resolve aliases to a concrete server model. Freshness still uses the target key.
    if (!native && typeof outcome.result.model === "string" && outcome.result.model)
      reportedModel = outcome.result.model;
    // Native answers are restricted to requested IDs; never expose unsolicited judgments.
    for (const id of Object.keys(batch))
      if (Object.hasOwn(outcome.result.answers, id)) {
        Object.defineProperty(answers, id, {
          value: outcome.result.answers[id],
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
  }
  if (signal?.aborted) return { ok: false, reason: "cancelled", ...(usage ? { usage } : {}) };
  if (native && Date.now() > deadline) return { ok: false, reason: "timed out", ...(usage ? { usage } : {}) };
  if (resolveSystem1Target(config).key !== target.key)
    return { ok: false, reason: "System 1 changed while judging; retry the request", ...(usage ? { usage } : {}) };
  return {
    ok: true,
    backend: target.backend,
    provider: target.provider,
    model: reportedModel,
    selectionKey: target.key,
    answers,
    latencyMs: Date.now() - started,
    ...(usage ? { usage } : {}),
  };
}

type Attempt = { ok: true; result: ClassifierResult } | { ok: false; reason: string; usage?: ClassifierUsage };
async function attempt(
  reg: ClassifierRegistry,
  model: unknown,
  state: Record<string, unknown>,
  questions: Record<string, ClassifierQuestion>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  native: boolean,
): Promise<Attempt> {
  if (signal?.aborted) return { ok: false, reason: "cancelled" };
  if (timeoutMs <= 0) return { ok: false, reason: "timed out" };
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  let abortListener: (() => void) | undefined;
  try {
    // A race enforces the caller's deadline even if an old/custom host ignores its signal.
    const aborted = new Promise<Attempt>((resolve) => {
      abortListener = () => resolve({ ok: false, reason: timedOut ? "timed out" : "cancelled" });
      controller.signal.addEventListener("abort", abortListener, { once: true });
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    });
    const classification = (async (): Promise<Attempt> => {
      try {
        const result = await reg.classify(
          model as never,
          { state, questions },
          { timeoutMs, signal: controller.signal, retries: 0, maxRetries: 0 },
        );
        if (controller.signal.aborted)
          return { ok: false, reason: timedOut ? "timed out" : "cancelled", usage: result.usage };
        if (result.stopReason !== "stop")
          return { ok: false, reason: describe(result.stopReason, result.errorMessage, native), usage: result.usage };
        return { ok: true, result };
      } catch (error) {
        return { ok: false, reason: describe("error", error instanceof Error ? error.message : String(error), native) };
      }
    })();
    return await Promise.race([classification, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
  }
}
function describe(stopReason: string, message: string | undefined, native: boolean): string {
  if (stopReason === "aborted") return "cancelled";
  const text = message ?? "";
  const api = native ? "OpenAI Decisions API" : "classifier";
  if (/no api key|no .*credentials|missing .*key|unconfigured|not configured/iu.test(text))
    return native ? `${api} credentials missing; configure /login system1-openai` : "no classifier credentials";
  if (/\b401\b|unauthori[sz]ed|invalid.*(?:key|credential)/iu.test(text))
    return native ? `${api} credentials invalid` : "invalid API key";
  if (/quota|credit|billing|insufficient_quota/iu.test(text)) return `${api} quota or credits exhausted`;
  if (/\b429\b|rate.?limit/iu.test(text)) return `${api} rate limited`;
  if (/timed out|timeout|\b504\b/iu.test(text)) return "timed out";
  if (/refus|invalid|malformed|unexpected response|did not return|probabilit|confidence/iu.test(text))
    return `${api} returned invalid answers`;
  if (/\b404\b|not found|unknown model|unsupported.*(?:model|api)|unavailable/iu.test(text))
    return `${api} model unavailable`;
  if (/abort|cancel/iu.test(text)) return "cancelled";
  return `${api} request failed`;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function validQuestions(questions: Record<string, ClassifierQuestion>): boolean {
  return Object.values(questions).every((q) => {
    if (!record(q) || typeof q.instructions !== "string") return false;
    if (q.type === "bool")
      return record(q.criteria) && typeof q.criteria.true === "string" && typeof q.criteria.false === "string";
    if (q.type === "choice")
      return (
        record(q.criteria) &&
        Object.keys(q.criteria).length > 0 &&
        Object.values(q.criteria).every((v) => typeof v === "string")
      );
    if (q.type === "score")
      return Array.isArray(q.criteria) && q.criteria.length > 0 && q.criteria.every((v) => typeof v === "string");
    return false;
  });
}
function validAnswers(
  questions: Record<string, ClassifierQuestion>,
  answers: Record<string, ClassifierAnswer>,
): boolean {
  if (!record(answers)) return false;
  return Object.entries(questions).every(([id, q]) => {
    const a = Object.hasOwn(answers, id) ? answers[id] : undefined;
    if (!a || a.type !== q.type) return false;
    if (a.type === "bool") return probability(a.probability);
    if (!probability(a.confidence)) return false;
    if (a.type === "score" && q.type === "score")
      return Number.isFinite(a.score) && a.score >= 0 && a.score <= q.criteria.length - 1;
    if (a.type !== "choice" || q.type !== "choice" || !Object.hasOwn(q.criteria, a.choice) || !record(a.probabilities))
      return false;
    const labels = Object.keys(q.criteria);
    return (
      Object.keys(a.probabilities).length === labels.length &&
      labels.every((label) => Object.hasOwn(a.probabilities, label) && probability(a.probabilities[label])) &&
      Math.abs(labels.reduce((sum, label) => sum + a.probabilities[label], 0) - 1) <= 0.001
    );
  });
}

// Compatibility accessors intentionally retain Jev consumer validation behavior.
export function bool(answers: Record<string, ClassifierAnswer>, id: string): number | undefined {
  const answer = answers[id];
  return answer?.type === "bool" && Number.isFinite(answer.probability) ? answer.probability : undefined;
}
export function score(
  answers: Record<string, ClassifierAnswer>,
  id: string,
): { score: number; confidence: number } | undefined {
  const answer = answers[id];
  return answer?.type === "score" && Number.isFinite(answer.score)
    ? { score: answer.score, confidence: answer.confidence }
    : undefined;
}
export function choice(answers: Record<string, ClassifierAnswer>, id: string) {
  const answer = answers[id];
  return answer?.type === "choice" ? answer : undefined;
}
