// Package-local System 1 transport. Keep all nine copies byte-identical; no sibling imports.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const SYSTEM1_CHANGED = "pi-plugins.system1-changed.v1";
export function agentDir(): string {
  return path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"));
}
export function system1Path(): string {
  return path.join(agentDir(), "system1.json");
}
export type System1Backend = "jev" | "openai-decisions";
export type System1Setting =
  | { ok: true; waterfall: System1Backend[]; key: string; legacy: boolean }
  | { ok: false; reason: string; key: string };
const unavailable = (reason: string): System1Setting => ({
  ok: false,
  reason,
  key: JSON.stringify(["unavailable", reason]),
});
function backend(value: unknown): value is System1Backend {
  return value === "jev" || value === "openai-decisions";
}
function validWaterfall(value: unknown): value is System1Backend[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 2 &&
    value.every(backend) &&
    new Set(value).size === value.length
  );
}
export function readSystem1Setting(): System1Setting {
  let raw: string;
  try {
    raw = readFileSync(system1Path(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: true, waterfall: ["jev"], key: JSON.stringify(["jev"]), legacy: false };
    return unavailable("System 1 configuration is unreadable");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return unavailable("System 1 configuration is malformed JSON");
  }
  if (!record(value)) return unavailable("System 1 configuration has an unsupported backend");
  if (Object.hasOwn(value, "waterfall")) {
    if (!validWaterfall(value.waterfall)) return unavailable("System 1 configuration has an invalid waterfall");
    return { ok: true, waterfall: value.waterfall, key: JSON.stringify(value.waterfall), legacy: false };
  }
  if (!backend(value.backend)) return unavailable("System 1 configuration has an unsupported backend");
  return { ok: true, waterfall: [value.backend], key: JSON.stringify([value.backend]), legacy: true };
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
/** Structural so standalone packages can load without importing a Pi SDK. */
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
export type System1Route =
  | { ok: true; waterfall: System1Backend[]; targets: ClassifierProvenance[]; key: string }
  | { ok: false; reason: string; key: string };
export type System1Target =
  | ({ ok: true; key: string } & ClassifierProvenance)
  | { ok: false; reason: string; key: string };
export type System1FailureCode =
  | "disabled"
  | "cancelled"
  | "selection_changed"
  | "invalid_input"
  | "refused"
  | "missing_credentials"
  | "invalid_credentials"
  | "quota_exhausted"
  | "rate_limited"
  | "unavailable_model"
  | "timeout"
  | "invalid_answers"
  | "provider_error"
  | "exhausted";
export interface System1Attempt extends ClassifierProvenance {
  targetKey: string;
  status: "failed" | "succeeded" | "cooldown" | "probing";
  code?: System1FailureCode;
  reason?: string;
  latencyMs: number;
  retryAt?: number;
  sdkCalls: number;
  usage?: ClassifierUsage;
}
export interface System1DecisionProvenance extends ClassifierProvenance {
  waterfall: System1Backend[];
  selectionKey: string;
  targetKey: string;
  fallback: boolean;
  attempts: System1Attempt[];
}
/** Persisted records from before the waterfall retain their three-field provenance. */
export type System1ProvenanceRecord = ClassifierProvenance &
  Partial<Omit<System1DecisionProvenance, keyof ClassifierProvenance>>;
export type System1Outcome =
  | (System1DecisionProvenance & {
      ok: true;
      answers: Record<string, ClassifierAnswer>;
      latencyMs: number;
      usage?: ClassifierUsage;
    })
  | {
      ok: false;
      code: System1FailureCode;
      reason: string;
      attempts: System1Attempt[];
      latencyMs: number;
      selectionKey?: string;
      usage?: ClassifierUsage;
    };
export function provenanceOf(outcome: Extract<System1Outcome, { ok: true }>): System1DecisionProvenance {
  const { backend, provider, model, waterfall, selectionKey, targetKey, fallback, attempts } = outcome;
  return { backend, provider, model, waterfall, selectionKey, targetKey, fallback, attempts };
}
export type System1Notice =
  | {
      version: 1;
      at: number;
      kind: "provider_failed";
      waterfall: System1Backend[];
      backend: System1Backend;
      code: System1FailureCode;
      next?: System1Backend;
      retryAt?: number;
    }
  | {
      version: 1;
      at: number;
      kind: "exhausted";
      waterfall: System1Backend[];
      failures: { backend: System1Backend; code: System1FailureCode }[];
    }
  | {
      version: 1;
      at: number;
      kind: "recovered";
      waterfall: System1Backend[];
      backend: System1Backend;
      preferred: boolean;
    };
export type System1Event =
  | { type: "outcome"; registry: unknown; policyKey: string; outcome: System1Outcome }
  | { type: "notice"; registry: unknown; policyKey: string; notice: System1Notice };
export interface System1RuntimeSnapshot {
  candidates: (ClassifierProvenance & {
    targetKey: string;
    cooldownUntil?: number;
    probing: boolean;
    lastFailure?: { code: System1FailureCode; reason: string; at: number };
  })[];
  lastOutcome?: System1Outcome;
  lastUsed?: ClassifierProvenance & { at: number; fallback: boolean };
  resetGeneration: number;
  lastResetAt: number;
  nextRetryAt?: number;
}
export interface System1NotificationContext {
  mode?: string;
  hasUI?: boolean;
  modelRegistry?: unknown;
  ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
  sessionManager?: { getSessionId?(): string; getSessionFile?(): string | undefined };
  /** Explicit CLI/eval sink; never implicitly write to stdout or model context. */
  stderr?: (message: string) => void;
}
export interface System1NotificationHost {
  on(
    event: "session_start" | "session_tree" | "session_shutdown",
    handler: (event: unknown, ctx: System1NotificationContext) => void | Promise<void>,
  ): unknown;
  appendEntry?(customType: string, data?: unknown): void;
}
interface Circuit {
  cooldownUntil?: number;
  recovering?: boolean;
  probing: boolean;
  lastFailure?: { code: System1FailureCode; reason: string; at: number };
}
interface Runtime {
  policy: string;
  generation: number;
  circuits: Map<string, Circuit>;
  lastOutcome?: System1Outcome;
  lastUsed?: System1RuntimeSnapshot["lastUsed"];
  session?: unknown;
  sessionEvent?: unknown;
  epoch: number;
}
interface Sink {
  ctx: System1NotificationContext;
  priority: number;
  registry: unknown;
  appendEntry?: System1NotificationHost["appendEntry"];
  onOutcome?: (event: System1Event, ctx: System1NotificationContext) => void;
}
interface Hub {
  registries: WeakMap<object, Runtime>;
  observers: Set<{ observer: (event: System1Event) => void; registry?: object }>;
  sinks: Set<Sink>;
  notices: Map<string, number>;
  generation: number;
  lastResetAt: number;
}
interface Shared {
  directories: Map<string, Hub>;
}
const HUB = Symbol.for("pi-plugins.system1-waterfall.v1");
function hub(): Hub {
  const global = globalThis as typeof globalThis & { [HUB]?: Shared };
  if (!global[HUB]) global[HUB] = { directories: new Map() };
  const shared = global[HUB];
  const directory = agentDir();
  let current = shared.directories.get(directory);
  if (!current) {
    current = {
      registries: new WeakMap(),
      observers: new Set(),
      sinks: new Set(),
      notices: new Map(),
      generation: 0,
      lastResetAt: 0,
    };
    shared.directories.set(directory, current);
  }
  return current;
}
function objectKey(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
function runtime(h: Hub, registry: unknown, policy: string): Runtime {
  let current = objectKey(registry) ? h.registries.get(registry) : undefined;
  if (!current) {
    current = { policy, generation: h.generation, circuits: new Map(), epoch: 0 };
    if (objectKey(registry)) h.registries.set(registry, current);
  }
  if (current.policy !== policy || current.generation !== h.generation) {
    current.policy = policy;
    current.generation = h.generation;
    current.epoch++;
    current.circuits.clear();
    delete current.lastOutcome;
    delete current.lastUsed;
  }
  return current;
}
export function system1TargetKey(target: ClassifierProvenance): string {
  return JSON.stringify([target.backend, target.provider, target.model]);
}
export function resolveSystem1Route(
  config: Pick<ClassifierConfig, "provider" | "model">,
  setting = readSystem1Setting(),
): System1Route {
  if (!setting.ok) return setting;
  const targets = setting.waterfall.map(
    (backend): ClassifierProvenance =>
      backend === "jev"
        ? { backend, provider: config.provider, model: config.model }
        : { backend, provider: "system1-openai", model: "gpt-6-luna" },
  );
  const generation = hub().generation;
  const key =
    targets.length === 1 && generation === 0
      ? system1TargetKey(targets[0])
      : JSON.stringify(["waterfall", targets.map((t) => [t.backend, t.provider, t.model]), generation]);
  return { ok: true, waterfall: [...setting.waterfall], targets, key };
}
export function resolveSystem1Target(
  config: Pick<ClassifierConfig, "provider" | "model">,
  setting = readSystem1Setting(),
): System1Target {
  const route = resolveSystem1Route(config, setting);
  return route.ok ? { ok: true, ...route.targets[0], key: route.key } : route;
}
export function getSystem1RoutingKey(registry: unknown, config: Pick<ClassifierConfig, "provider" | "model">): string {
  const setting = readSystem1Setting();
  const route = resolveSystem1Route(config, setting);
  if (!route.ok) return route.key;
  const current = runtime(hub(), registry, setting.key);
  const target = route.targets.find((t) => {
    const c = current.circuits.get(system1TargetKey(t));
    return !c?.probing && (!c?.cooldownUntil || c.cooldownUntil <= Date.now());
  });
  return JSON.stringify([route.key, target ? system1TargetKey(target) : null]);
}
export function getSystem1RuntimeSnapshot(registry: unknown, config: ClassifierConfig): System1RuntimeSnapshot {
  const h = hub();
  const setting = readSystem1Setting();
  const route = resolveSystem1Route(config, setting);
  const current = runtime(h, registry, setting.key);
  const candidates = route.ok
    ? route.targets.map((t) => {
        const c = current.circuits.get(system1TargetKey(t));
        return {
          ...t,
          targetKey: system1TargetKey(t),
          probing: c?.probing ?? false,
          ...(c?.cooldownUntil !== undefined ? { cooldownUntil: c.cooldownUntil } : {}),
          ...(c?.lastFailure ? { lastFailure: { ...c.lastFailure } } : {}),
        };
      })
    : [];
  const retryTimes = candidates.flatMap((c) =>
    c.cooldownUntil && c.cooldownUntil > Date.now() ? [c.cooldownUntil] : [],
  );
  return {
    candidates,
    ...(current.lastOutcome ? { lastOutcome: current.lastOutcome } : {}),
    ...(current.lastUsed ? { lastUsed: { ...current.lastUsed } } : {}),
    resetGeneration: h.generation,
    lastResetAt: h.lastResetAt,
    ...(retryTimes.length ? { nextRetryAt: Math.min(...retryTimes) } : {}),
  };
}
export function resetSystem1Runtime(_registry: unknown): void {
  const h = hub();
  h.generation++;
  h.lastResetAt = Date.now();
  h.notices.clear();
}
export function subscribeSystem1Events(observer: (event: System1Event) => void, registry?: object): () => void {
  const h = hub();
  const subscription = { observer, registry };
  h.observers.add(subscription);
  return () => {
    h.observers.delete(subscription);
  };
}
function safe(action: () => unknown): void {
  try {
    void Promise.resolve(action()).catch(() => {});
  } catch {
    /* Observation must never affect a judgment. */
  }
}
function selectedSink(h: Hub, registry: unknown): Sink | undefined {
  const sinks = [...h.sinks];
  const rank = (s: Sink) =>
    (s.ctx.mode === "tui" || (s.ctx.mode === undefined && s.ctx.hasUI)) && s.ctx.hasUI !== false && s.ctx.ui
      ? 3
      : s.ctx.mode === "rpc" && s.registry === registry && s.ctx.ui
        ? 2
        : s.ctx.stderr
          ? 1
          : 0;
  return sinks
    .filter((s) => rank(s) > 0)
    .sort((a, b) => rank(b) - rank(a) || b.priority - a.priority)
    .at(0);
}
function waterfallOfKey(key: string | undefined): System1Backend[] | undefined {
  try {
    const value: unknown = JSON.parse(key ?? "null");
    if (!Array.isArray(value)) return undefined;
    if (backend(value[0])) return [value[0]];
    if (value[0] !== "waterfall" || !Array.isArray(value[1])) return undefined;
    const order = value[1].map((target: unknown) => (Array.isArray(target) ? target[0] : undefined));
    return validWaterfall(order) ? order : undefined;
  } catch {
    return undefined;
  }
}
function publish(h: Hub, event: System1Event): void {
  for (const { observer, registry } of [...h.observers])
    if (registry === undefined || registry === event.registry) safe(() => observer(event));
  if (event.type !== "outcome") return;
  const sink = selectedSink(h, event.registry);
  if (!sink) return;
  safe(() => sink.onOutcome?.(event, sink.ctx));
  // Metadata entries, unlike custom messages, are never inserted into model context.
  safe(() =>
    sink.appendEntry?.(
      "system1:decision",
      event.outcome.ok
        ? { ...provenanceOf(event.outcome), latencyMs: event.outcome.latencyMs, usage: event.outcome.usage, ok: true }
        : {
            ok: false,
            selectionKey: event.outcome.selectionKey,
            waterfall: waterfallOfKey(event.outcome.selectionKey),
            code: event.outcome.code,
            reason: event.outcome.reason,
            attempts: event.outcome.attempts,
            latencyMs: event.outcome.latencyMs,
            usage: event.outcome.usage,
          },
    ),
  );
}
const LABELS: Record<System1Backend, string> = { jev: "Jev", "openai-decisions": "OpenAI Decisions" };
const REASONS: Record<System1FailureCode, string> = {
  disabled: "classifier disabled",
  cancelled: "cancelled",
  selection_changed: "System 1 changed while judging; retry the request",
  invalid_input: "invalid classifier input",
  refused: "safety refusal",
  missing_credentials: "credentials missing",
  invalid_credentials: "credentials invalid",
  quota_exhausted: "quota or credits exhausted",
  rate_limited: "rate limited",
  unavailable_model: "model unavailable",
  timeout: "timed out",
  invalid_answers: "invalid answers",
  provider_error: "request failed",
  exhausted: "no configured providers remain",
};
export function formatSystem1Notice(notice: System1Notice): string {
  if (notice.kind === "recovered")
    return `System 1: ${LABELS[notice.backend]} available again; ${notice.preferred ? "preferred order restored" : "available for configured failover"}.`;
  if (notice.kind === "exhausted") {
    if (!notice.failures.length)
      return "System 1: providers are currently being retried; no spare provider is available.";
    return `System 1: ${notice.failures.map((f) => `${LABELS[f.backend]} unavailable (${REASONS[f.code]})`).join("; ")}; no configured providers remain.`;
  }
  if (notice.code === "refused")
    return `System 1: ${LABELS[notice.backend]} refused this judgment; safety refusals do not fail over.`;
  return `System 1: ${LABELS[notice.backend]} unavailable (${REASONS[notice.code]}); ${notice.next ? `trying ${LABELS[notice.next]}` : "no configured providers remain"}.`;
}
const NOTICE_PREFIX = "pi-system1.notice.v1:";
const CODES = new Set<string>(Object.keys(REASONS));
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function keysOnly(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function validNotice(value: unknown): value is System1Notice {
  if (!record(value) || value.version !== 1 || !finite(value.at) || !validWaterfall(value.waterfall)) return false;
  if (value.kind === "provider_failed")
    return (
      keysOnly(value, ["version", "at", "kind", "waterfall", "backend", "code", "next", "retryAt"]) &&
      backend(value.backend) &&
      value.waterfall.includes(value.backend) &&
      typeof value.code === "string" &&
      CODES.has(value.code) &&
      (value.next === undefined ||
        (backend(value.next) && value.waterfall.includes(value.next) && value.next !== value.backend)) &&
      (value.retryAt === undefined || finite(value.retryAt))
    );
  if (value.kind === "recovered")
    return (
      keysOnly(value, ["version", "at", "kind", "waterfall", "backend", "preferred"]) &&
      backend(value.backend) &&
      value.waterfall.includes(value.backend) &&
      typeof value.preferred === "boolean"
    );
  const waterfall = value.waterfall;
  if (value.kind === "exhausted")
    return (
      keysOnly(value, ["version", "at", "kind", "waterfall", "failures"]) &&
      Array.isArray(value.failures) &&
      value.failures.length <= 2 &&
      value.failures.every(
        (f) =>
          record(f) &&
          keysOnly(f, ["backend", "code"]) &&
          backend(f.backend) &&
          waterfall.includes(f.backend) &&
          typeof f.code === "string" &&
          CODES.has(f.code),
      ) &&
      new Set(value.failures.map((f) => f.backend)).size === value.failures.length
    );
  return false;
}
export function encodeSystem1Notice(notice: System1Notice): string {
  if (!validNotice(notice)) throw new Error("Invalid System 1 notice");
  const payload = JSON.stringify(notice);
  if (payload.length > 4096) throw new Error("System 1 notice is too large");
  return NOTICE_PREFIX + payload;
}
export function parseSystem1Notice(message: string): System1Notice | undefined {
  if (typeof message !== "string" || !message.startsWith(NOTICE_PREFIX) || message.length - NOTICE_PREFIX.length > 4096)
    return undefined;
  try {
    const value: unknown = JSON.parse(message.slice(NOTICE_PREFIX.length));
    return validNotice(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
function noticeKey(notice: System1Notice, origin?: string): string {
  const { at: _at, ...identity } = notice;
  // Cooldown deadlines vary slightly between concurrent callers. They are
  // timing evidence, not a different failure for the user to acknowledge.
  if (identity.kind === "provider_failed") {
    const { retryAt: _retryAt, ...stable } = identity;
    return JSON.stringify([origin ?? "", stable]);
  }
  return JSON.stringify([origin ?? "", identity]);
}
function deliverNotice(
  h: Hub,
  ctx: System1NotificationContext,
  notice: System1Notice,
  origin?: string,
  suppressUntil = 0,
): void {
  const key = noticeKey(notice, origin);
  const now = Date.now();
  if ((h.notices.get(key) ?? 0) > now) return;
  h.notices.set(key, Math.max(now + 60_000, suppressUntil));
  for (const [old, until] of h.notices) if (until <= now) h.notices.delete(old);
  safe(() => {
    if (ctx.mode === "rpc")
      return ctx.ui?.notify(encodeSystem1Notice(notice), notice.kind === "recovered" ? "info" : "warning");
    if (ctx.mode === "tui" || (ctx.mode === undefined && ctx.hasUI))
      return ctx.ui?.notify(formatSystem1Notice(notice), notice.kind === "recovered" ? "info" : "warning");
    return ctx.stderr?.(formatSystem1Notice(notice));
  });
}
export function notifySystem1Notice(ctx: System1NotificationContext, notice: System1Notice, origin?: string): void {
  if (!validNotice(notice)) return;
  const h = hub();
  const setting = readSystem1Setting();
  if (
    !setting.ok ||
    JSON.stringify(setting.waterfall) !== JSON.stringify(notice.waterfall) ||
    notice.at < h.lastResetAt
  )
    return;
  deliverNotice(h, ctx, notice, origin, notice.kind === "provider_failed" ? notice.retryAt : undefined);
}
export function installSystem1Notifications(
  pi: System1NotificationHost,
  options: { priority?: number; onOutcome?: (event: System1Event, ctx: System1NotificationContext) => void } = {},
): void {
  let bound: { h: Hub; sink: Sink } | undefined;
  const release = () => {
    if (bound) bound.h.sinks.delete(bound.sink);
    bound = undefined;
  };
  const bind = (event: unknown, ctx: System1NotificationContext, start: boolean) => {
    release();
    const h = hub();
    const current = runtime(h, ctx.modelRegistry, readSystem1Setting().key);
    const session = ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager?.getSessionFile?.();
    if ((start && current.sessionEvent !== event) || (session && current.session !== session)) {
      current.circuits.clear();
      current.epoch++;
      delete current.lastOutcome;
      delete current.lastUsed;
    }
    if (start) current.sessionEvent = event;
    current.session = session;
    const sink: Sink = {
      ctx,
      priority: options.priority ?? 0,
      registry: ctx.modelRegistry,
      appendEntry: pi.appendEntry?.bind(pi),
      onOutcome: options.onOutcome,
    };
    h.sinks.add(sink);
    bound = { h, sink };
  };
  pi.on("session_start", (event, ctx) => bind(event, ctx, true));
  pi.on("session_tree", (event, ctx) => bind(event, ctx, false));
  pi.on("session_shutdown", () => release());
}

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
function failureCode(stopReason: string, message?: string): System1FailureCode {
  if (stopReason === "aborted") return "cancelled";
  const text = message ?? "";
  // Match the SDK control form, never arbitrary IDs containing 'refused'.
  if (
    /^(?:(?:OpenAI Decisions(?: API)?|Classifier) (?:provider )?error(?: \(\d{3}\))?:\s*)?OpenAI Decisions refused to answer \S/iu.test(
      text,
    )
  )
    return "refused";
  if (/no api key|no .*credentials|missing (?:.*key|credentials)|unconfigured|not configured/iu.test(text))
    return "missing_credentials";
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|invalid.*(?:key|credential)/iu.test(text)) return "invalid_credentials";
  if (/quota|credit|billing|insufficient_quota/iu.test(text)) return "quota_exhausted";
  if (/\b429\b|rate.?limit/iu.test(text)) return "rate_limited";
  if (/timed out|timeout|\b504\b/iu.test(text)) return "timeout";
  if (/\b404\b|not found|unknown model|unsupported.*(?:model|api)|unavailable/iu.test(text)) return "unavailable_model";
  if (/abort|cancel/iu.test(text)) return "cancelled";
  if (/invalid|malformed|unexpected response|did not return|probabilit|confidence/iu.test(text))
    return "invalid_answers";
  return "provider_error";
}
function cooldownMs(code: System1FailureCode): number {
  if (["quota_exhausted", "missing_credentials", "invalid_credentials", "unavailable_model"].includes(code))
    return 300_000;
  if (code === "rate_limited" || code === "provider_error") return 30_000;
  return 0;
}
type TargetResult =
  | { ok: true; answers: Record<string, ClassifierAnswer>; model: string; usage?: ClassifierUsage; sdkCalls: number }
  | { ok: false; code: System1FailureCode; usage?: ClassifierUsage; sdkCalls: number };
function stale(config: ClassifierConfig, key: string, signal?: AbortSignal): System1FailureCode | undefined {
  if (signal?.aborted) return "cancelled";
  return resolveSystem1Route(config).key !== key ? "selection_changed" : undefined;
}
async function askTarget(
  registry: unknown,
  target: ClassifierProvenance,
  state: Record<string, unknown>,
  questions: Record<string, ClassifierQuestion>,
  deadline: number,
  signal: AbortSignal | undefined,
  check: () => System1FailureCode | undefined,
  retry: boolean,
): Promise<TargetResult> {
  const reg = registry as Partial<ClassifierRegistry> | undefined;
  if (typeof reg?.findOfType !== "function" || typeof reg.classify !== "function")
    return { ok: false, code: "unavailable_model", sdkCalls: 0 };
  let model: unknown;
  try {
    model = reg.findOfType("classifier", target.provider, target.model);
  } catch {
    model = undefined;
  }
  const native = target.backend === "openai-decisions";
  if (
    !model ||
    (native &&
      (!record(model) ||
        model.api !== "openai-decisions" ||
        model.provider !== target.provider ||
        model.id !== target.model ||
        model.baseUrl !== "https://api.openai.com/v1"))
  )
    return { ok: false, code: "unavailable_model", sdkCalls: 0 };
  const entries = Object.entries(questions);
  const batches = native
    ? Array.from({ length: Math.ceil(entries.length / 400) }, (_, i) =>
        Object.fromEntries(entries.slice(i * 400, (i + 1) * 400)),
      )
    : [questions];
  const answers: Record<string, ClassifierAnswer> = {};
  let usage: ClassifierUsage | undefined;
  let reportedModel = target.model;
  let sdkCalls = 0;
  for (const batch of batches) {
    let remainingAttempts = retry ? 2 : 1;
    for (;;) {
      const stopped = check();
      if (stopped) return { ok: false, code: stopped, usage, sdkCalls };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, code: "timeout", usage, sdkCalls };
      const timeout = Math.max(1, Math.floor(remaining / remainingAttempts));
      const result = await callClassifier(reg as ClassifierRegistry, model, state, batch, timeout, signal);
      sdkCalls++;
      usage = addClassifierUsage(usage, result.usage);
      const stop = check();
      if (stop) return { ok: false, code: stop, usage, sdkCalls };
      if (!result.ok) {
        if (result.code === "timeout" && --remainingAttempts > 0 && Date.now() < deadline) continue;
        return { ok: false, code: result.code, usage, sdkCalls };
      }
      if (Date.now() > deadline) return { ok: false, code: "timeout", usage, sdkCalls };
      if (!validAnswers(batch, result.result.answers, native))
        return { ok: false, code: "invalid_answers", usage, sdkCalls };
      if (!native && typeof result.result.model === "string" && result.result.model)
        reportedModel = result.result.model;
      for (const id of Object.keys(batch))
        Object.defineProperty(answers, id, {
          value: result.result.answers[id],
          enumerable: true,
          writable: true,
          configurable: true,
        });
      break;
    }
  }
  return { ok: true, answers, model: reportedModel, usage, sdkCalls };
}
function reportedUsage(value: unknown): ClassifierUsage | undefined {
  if (!record(value) || !record(value.cost)) return undefined;
  const { input, output, cacheRead, cacheWrite, totalTokens } = value;
  const cost = value.cost;
  if (
    ![
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      cost.input,
      cost.output,
      cost.cacheRead,
      cost.cacheWrite,
      cost.total,
    ].every(finite)
  )
    return undefined;
  return {
    input: input as number,
    output: output as number,
    cacheRead: cacheRead as number,
    cacheWrite: cacheWrite as number,
    totalTokens: totalTokens as number,
    cost: {
      input: cost.input as number,
      output: cost.output as number,
      cacheRead: cost.cacheRead as number,
      cacheWrite: cost.cacheWrite as number,
      total: cost.total as number,
    },
  };
}
type CallResult =
  | { ok: true; result: ClassifierResult; usage?: ClassifierUsage }
  | { ok: false; code: System1FailureCode; usage?: ClassifierUsage };
async function callClassifier(
  reg: ClassifierRegistry,
  model: unknown,
  state: Record<string, unknown>,
  questions: Record<string, ClassifierQuestion>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CallResult> {
  if (signal?.aborted) return { ok: false, code: "cancelled" };
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: (() => void) | undefined;
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const aborted = new Promise<CallResult>((resolve) => {
      listener = () => resolve({ ok: false, code: timedOut ? "timeout" : "cancelled" });
      controller.signal.addEventListener("abort", listener, { once: true });
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    });
    const classification = (async (): Promise<CallResult> => {
      try {
        const result = await reg.classify(
          model as never,
          { state, questions },
          { timeoutMs, signal: controller.signal, retries: 0, maxRetries: 0 },
        );
        if (controller.signal.aborted)
          return { ok: false, code: timedOut ? "timeout" : "cancelled", usage: reportedUsage(result?.usage) };
        if (!record(result)) return { ok: false, code: "invalid_answers" };
        if (result.stopReason !== "stop")
          return {
            ok: false,
            code: failureCode(result.stopReason, result.errorMessage),
            usage: reportedUsage(result.usage),
          };
        return { ok: true, result, usage: reportedUsage(result.usage) };
      } catch (error) {
        return {
          ok: false,
          code: failureCode("error", error instanceof Error ? error.message : typeof error === "string" ? error : ""),
        };
      }
    })();
    return await Promise.race([classification, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    if (listener) controller.signal.removeEventListener("abort", listener);
  }
}

/** One logical judgment: operational failures advance, valid judgments and safety refusals do not. */
export async function askSystem1(
  registry: unknown,
  config: ClassifierConfig,
  state: Record<string, unknown>,
  questions: Record<string, ClassifierQuestion>,
  signal?: AbortSignal,
  options: { retryTimeout?: boolean; onNotice?: (notice: System1Notice) => void } = {},
): Promise<System1Outcome> {
  const started = Date.now();
  const attempts: System1Attempt[] = [];
  let usage: ClassifierUsage | undefined;
  let selectionKey: string | undefined;
  let current: Runtime | undefined;
  let requestEpoch: number | undefined;
  const h = hub();
  const finish = (outcome: System1Outcome): System1Outcome => {
    if (
      current &&
      current.epoch === requestEpoch &&
      current.generation === h.generation &&
      resolveSystem1Route(config).key === selectionKey
    ) {
      current.lastOutcome = outcome;
      if (outcome.ok)
        current.lastUsed = {
          backend: outcome.backend,
          provider: outcome.provider,
          model: outcome.model,
          at: Date.now(),
          fallback: outcome.fallback,
        };
    }
    publish(h, { type: "outcome", registry, policyKey: selectionKey ?? "", outcome });
    return outcome;
  };
  const fail = (code: System1FailureCode, reason = REASONS[code]): System1Outcome =>
    finish({
      ok: false,
      code,
      reason,
      attempts,
      latencyMs: Date.now() - started,
      ...(selectionKey ? { selectionKey } : {}),
      ...(usage ? { usage } : {}),
    });
  if (!config.enabled) return fail("disabled", "the classifier is off in settings");
  if (signal?.aborted) return fail("cancelled");
  if (
    !record(state) ||
    !record(questions) ||
    !Object.keys(questions).length ||
    !validQuestions(questions) ||
    !finite(config.timeoutMs) ||
    config.timeoutMs <= 0
  )
    return fail("invalid_input");
  const setting = readSystem1Setting();
  const route = resolveSystem1Route(config, setting);
  selectionKey = route.key;
  if (!route.ok) return fail("invalid_input", route.reason);
  current = runtime(h, registry, setting.key);
  const active = current;
  const deadline = started + config.timeoutMs;
  requestEpoch = current.epoch;
  const check = () =>
    stale(config, route.key, signal) ??
    (hub() !== h || active.epoch !== requestEpoch ? "selection_changed" : undefined);
  const emit = (notice: System1Notice) => {
    publish(h, { type: "notice", registry, policyKey: route.key, notice });
    safe(() => options.onNotice?.(notice));
    const sink = selectedSink(h, registry);
    const cooldowns = [...active.circuits.values()].flatMap((c) =>
      c.cooldownUntil && c.cooldownUntil > Date.now() ? [c.cooldownUntil] : [],
    );
    if (sink)
      deliverNotice(
        h,
        sink.ctx,
        notice,
        undefined,
        notice.kind !== "recovered" && cooldowns.length ? Math.max(...cooldowns) : 0,
      );
  };
  for (let index = 0; index < route.targets.length; index++) {
    const stopped = check();
    if (stopped) return fail(stopped);
    const target = route.targets[index];
    const targetKey = system1TargetKey(target);
    const circuit = current.circuits.get(targetKey) ?? { probing: false };
    current.circuits.set(targetKey, circuit);
    if (circuit.probing || (circuit.cooldownUntil !== undefined && circuit.cooldownUntil > Date.now())) {
      attempts.push({
        ...target,
        targetKey,
        status: circuit.probing ? "probing" : "cooldown",
        latencyMs: 0,
        sdkCalls: 0,
        ...(circuit.lastFailure ? { code: circuit.lastFailure.code, reason: circuit.lastFailure.reason } : {}),
        ...(circuit.cooldownUntil ? { retryAt: circuit.cooldownUntil } : {}),
      });
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (!attempts.length) return fail("timeout");
      break;
    }
    const runnable = route.targets.slice(index).filter((t) => {
      const c = active.circuits.get(system1TargetKey(t));
      return !c?.probing && (!c?.cooldownUntil || c.cooldownUntil <= Date.now());
    }).length;
    const budget = runnable === 1 ? remaining : Math.max(1, Math.floor(remaining / runnable));
    const recovering = circuit.recovering === true;
    if (recovering) circuit.probing = true;
    const rungStarted = Date.now();
    let result: TargetResult;
    try {
      result = await askTarget(
        registry,
        target,
        state,
        questions,
        Math.min(deadline, rungStarted + budget),
        signal,
        check,
        route.targets.length === 1 && target.backend === "jev" && options.retryTimeout !== false,
      );
    } finally {
      circuit.probing = false;
    }
    usage = addClassifierUsage(usage, result.usage);
    const stop = check();
    const code = stop ?? (!result.ok ? result.code : undefined);
    const attempt: System1Attempt = {
      ...target,
      targetKey,
      status: code ? "failed" : "succeeded",
      latencyMs: Date.now() - rungStarted,
      sdkCalls: result.sdkCalls,
      ...(result.usage ? { usage: result.usage } : {}),
    };
    attempts.push(attempt);
    if (code) {
      attempt.code = code;
      attempt.reason = REASONS[code];
      if (["cancelled", "selection_changed", "invalid_input", "disabled"].includes(code)) return fail(code);
      if (code === "refused") {
        emit({
          version: 1,
          at: Date.now(),
          kind: "provider_failed",
          waterfall: route.waterfall,
          backend: target.backend,
          code,
        });
        return fail(code);
      }
      const cooldown = cooldownMs(code);
      circuit.lastFailure = { code, reason: REASONS[code], at: Date.now() };
      if (cooldown) {
        circuit.cooldownUntil = Date.now() + cooldown;
        circuit.recovering = true;
      } else delete circuit.cooldownUntil;
      if (circuit.cooldownUntil) attempt.retryAt = circuit.cooldownUntil;
      const next = route.targets.slice(index + 1).find((t) => {
        const c = active.circuits.get(system1TargetKey(t));
        return !c?.probing && (!c?.cooldownUntil || c.cooldownUntil <= Date.now());
      });
      if (next)
        emit({
          version: 1,
          at: Date.now(),
          kind: "provider_failed",
          waterfall: route.waterfall,
          backend: target.backend,
          code,
          next: next.backend,
          ...(attempt.retryAt ? { retryAt: attempt.retryAt } : {}),
        });
      continue;
    }
    if (!result.ok) return fail(result.code);
    delete circuit.cooldownUntil;
    delete circuit.recovering;
    delete circuit.lastFailure;
    if (recovering)
      emit({
        version: 1,
        at: Date.now(),
        kind: "recovered",
        waterfall: route.waterfall,
        backend: target.backend,
        preferred: index === 0,
      });
    const finalStop = check();
    if (finalStop) return fail(finalStop);
    return finish({
      ok: true,
      ...target,
      model: result.model,
      answers: result.answers,
      waterfall: route.waterfall,
      selectionKey: route.key,
      targetKey,
      fallback: index > 0,
      attempts,
      latencyMs: Date.now() - started,
      ...(usage ? { usage } : {}),
    });
  }
  const stopped = check();
  if (stopped) return fail(stopped);
  const failures = attempts
    .flatMap((a) => (a.code && a.status !== "probing" ? [{ backend: a.backend, code: a.code }] : []))
    .slice(0, 2);
  emit({ version: 1, at: Date.now(), kind: "exhausted", waterfall: route.waterfall, failures });
  return fail(
    "exhausted",
    failures.length
      ? failures.map((f) => `${LABELS[f.backend]}: ${REASONS[f.code]}`).join("; ")
      : "providers are currently being retried; no spare provider is available",
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function probability(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1;
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
  native: boolean,
): boolean {
  if (!record(answers)) return false;
  return Object.entries(questions).every(([id, q]) => {
    const a = Object.hasOwn(answers, id) ? answers[id] : undefined;
    if (!a || a.type !== q.type) return false;
    if (a.type === "bool") return probability(a.probability);
    if (!probability(a.confidence)) return false;
    if (a.type === "score" && q.type === "score")
      return finite(a.score) && a.score >= 0 && a.score <= q.criteria.length - 1;
    if (
      a.type !== "choice" ||
      q.type !== "choice" ||
      typeof a.choice !== "string" ||
      !Object.hasOwn(q.criteria, a.choice)
    )
      return false;
    if (!native && a.probabilities === undefined) return true;
    if (!record(a.probabilities)) return false;
    if (!Object.entries(a.probabilities).every(([label, p]) => Object.hasOwn(q.criteria, label) && probability(p)))
      return false;
    if (!native) return true;
    const labels = Object.keys(q.criteria);
    return (
      Object.keys(a.probabilities).length === labels.length &&
      labels.every((label) => Object.hasOwn(a.probabilities, label)) &&
      Math.abs(labels.reduce((sum, label) => sum + a.probabilities[label], 0) - 1) <= 0.001
    );
  });
}
// Compatibility accessors intentionally retain downstream consumer validation behavior.
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
