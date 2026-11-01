import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askSystem1,
  getSystem1RoutingKey,
  getSystem1RuntimeSnapshot,
  installSystem1Notifications,
  readSystem1Setting,
  resetSystem1Runtime,
  resolveSystem1Route,
  subscribeSystem1Events,
  system1Path,
  type ClassifierConfig,
  type ClassifierRegistry,
  type ClassifierResult,
  type System1Backend,
  type System1Event,
  type System1FailureCode,
  type System1NotificationContext,
  type System1NotificationHost,
} from "../src/system1.ts";

const config: ClassifierConfig = { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 1_000 };
const questions = { q: { type: "bool" as const, instructions: "Supported?", criteria: { true: "yes", false: "no" } } };
const order: System1Backend[] = ["jev", "openai-decisions"];
const hardCooldown = 300_000;
const shortCooldown = 30_000;
const epoch = 1_800_000_000_000;
const nativeModel = {
  type: "classifier",
  id: "gpt-6-luna",
  provider: "system1-openai",
  api: "openai-decisions",
  baseUrl: "https://api.openai.com/v1",
};
const jevModel = { type: "classifier", id: "jev-latest", provider: "typesafe" };
const success = (probability = 0.8): ClassifierResult => ({
  model: "jev-wire-version",
  answers: { q: { type: "bool", probability } },
  stopReason: "stop",
});
const failure = (errorMessage: string): ClassifierResult => ({
  model: "",
  answers: {},
  stopReason: "error",
  errorMessage,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fake(run: ClassifierRegistry["classify"] = async () => success()) {
  const findOfType = vi.fn<ClassifierRegistry["findOfType"]>((_type, provider) =>
    provider === "system1-openai" ? nativeModel : jevModel,
  );
  const classify = vi.fn<ClassifierRegistry["classify"]>(run);
  const registry: ClassifierRegistry = { findOfType, classify };
  return { registry, findOfType, classify };
}
function isJev(model: unknown) {
  return model === jevModel;
}
function select(waterfall: System1Backend[] = order, extra: Record<string, unknown> = {}) {
  writeFileSync(system1Path(), JSON.stringify({ waterfall, backend: waterfall[0], ...extra }));
}
function request(registry: unknown, state: Record<string, unknown> = {}) {
  return askSystem1(registry, config, state, questions, undefined, { retryTimeout: false });
}
function candidate(registry: unknown, index = 0) {
  return getSystem1RuntimeSnapshot(registry, config).candidates[index];
}
function host() {
  type Handler = Parameters<System1NotificationHost["on"]>[1];
  type Event = Parameters<System1NotificationHost["on"]>[0];
  const handlers = new Map<Event, Handler[]>();
  const appendEntry = vi.fn();
  const pi: System1NotificationHost = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    appendEntry,
  };
  return {
    pi,
    appendEntry,
    async emit(event: Event, ctx: System1NotificationContext, payload: unknown = {}) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
}
function context(registry: unknown, session = "session-a") {
  const notify = vi.fn();
  return {
    mode: "tui",
    hasUI: true,
    modelRegistry: registry,
    ui: { notify },
    sessionManager: { getSessionId: () => session },
  };
}

let directory: string;
let previousDirectory: string | undefined;
const directories: string[] = [];
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
  previousDirectory = process.env.PI_CODING_AGENT_DIR;
  directory = mkdtempSync(path.join(tmpdir(), "system1-waterfall-"));
  directories.push(directory);
  process.env.PI_CODING_AGENT_DIR = directory;
  select();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDirectory;
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("waterfall circuit cooldowns", () => {
  it.each<[string, System1FailureCode, number]>([
    ["No API key found", "missing_credentials", hardCooldown],
    ["401 invalid credential", "invalid_credentials", hardCooldown],
    ["insufficient_quota", "quota_exhausted", hardCooldown],
    ["billing credits exhausted", "quota_exhausted", hardCooldown],
    ["404 unknown model", "unavailable_model", hardCooldown],
    ["429 rate limit", "rate_limited", shortCooldown],
    ["ECONNRESET connection lost", "provider_error", shortCooldown],
  ])("quarantines %s as %s for exactly %d ms", async (message, code, duration) => {
    let healthy = false;
    const f = fake(async (model) => (isJev(model) && !healthy ? failure(message) : success()));
    const first = await request(f.registry);
    expect(first).toMatchObject({
      ok: true,
      backend: "openai-decisions",
      fallback: true,
      attempts: [{ status: "failed", code, retryAt: epoch + duration }, { status: "succeeded" }],
    });
    expect(candidate(f.registry)).toMatchObject({
      cooldownUntil: epoch + duration,
      probing: false,
      lastFailure: { code, at: epoch },
    });
    expect(getSystem1RuntimeSnapshot(f.registry, config).nextRetryAt).toBe(epoch + duration);
    healthy = true;
    await vi.advanceTimersByTimeAsync(duration - 1);
    const skipped = await request(f.registry);
    expect(skipped).toMatchObject({
      ok: true,
      attempts: [{ status: "cooldown", sdkCalls: 0, retryAt: epoch + duration }, { status: "succeeded" }],
    });
    expect(f.findOfType.mock.calls.map((call) => call[1])).toEqual(["typesafe", "system1-openai", "system1-openai"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await request(f.registry)).toMatchObject({ ok: true, backend: "jev", fallback: false });
    expect(f.classify).toHaveBeenCalledTimes(4);
    expect(candidate(f.registry)).not.toHaveProperty("cooldownUntil");
    expect(candidate(f.registry)).not.toHaveProperty("lastFailure");
  });

  it("cools a missing model without classify and skips lookup until expiry", async () => {
    const f = fake();
    let available = false;
    f.findOfType.mockImplementation((_type, provider) =>
      provider === "system1-openai" ? nativeModel : available ? jevModel : undefined,
    );
    expect(await request(f.registry)).toMatchObject({
      ok: true,
      attempts: [{ code: "unavailable_model", sdkCalls: 0 }, { sdkCalls: 1 }],
    });
    available = true;
    expect(await request(f.registry)).toMatchObject({
      ok: true,
      attempts: [{ status: "cooldown", sdkCalls: 0 }, { status: "succeeded" }],
    });
    expect(f.findOfType.mock.calls.filter((call) => call[1] === "typesafe")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(hardCooldown);
    expect(await request(f.registry)).toMatchObject({ ok: true, backend: "jev" });
    expect(f.findOfType.mock.calls.filter((call) => call[1] === "typesafe")).toHaveLength(2);
  });

  it.each(["timeout", "invalid_answers"] as const)(
    "keeps %s request-specific instead of quarantining the next state",
    async (code) => {
      const f = fake(async (model, ctx) =>
        isJev(model) && ctx.state.id === "first"
          ? code === "timeout"
            ? failure("504 timed out")
            : success(NaN)
          : success(ctx.state.id === "second" ? 0.2 : 0.9),
      );
      expect(await request(f.registry, { id: "first" })).toMatchObject({
        ok: true,
        backend: "openai-decisions",
        attempts: [{ code }, { status: "succeeded" }],
      });
      expect(candidate(f.registry)).not.toHaveProperty("cooldownUntil");
      expect(await request(f.registry, { id: "second" })).toMatchObject({
        ok: true,
        backend: "jev",
        answers: { q: { probability: 0.2 } },
        attempts: [{ status: "succeeded" }],
      });
      expect(f.classify).toHaveBeenCalledTimes(3);
    },
  );

  it("a real request deadline abort is request-only and reserves time for the other rung", async () => {
    const f = fake(async (model, ctx) => (isJev(model) && ctx.state.hang ? new Promise(() => {}) : success()));
    const pending = request(f.registry, { hang: true });
    expect(f.classify).toHaveBeenCalledTimes(1);
    expect(f.classify.mock.calls[0][2]).toMatchObject({ timeoutMs: 500, retries: 0, maxRetries: 0 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({
      ok: true,
      backend: "openai-decisions",
      latencyMs: 500,
      attempts: [{ code: "timeout" }, { status: "succeeded" }],
    });
    expect(f.classify.mock.calls[0][2]?.signal?.aborted).toBe(true);
    expect(candidate(f.registry)).not.toHaveProperty("cooldownUntil");
    expect(await request(f.registry)).toMatchObject({ ok: true, backend: "jev" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keys cooldowns by configured physical target, not a returned model version", async () => {
    const f = fake(async (model) => (isJev(model) ? failure("insufficient_quota") : success()));
    await request(f.registry);
    const other = { ...config, model: "jev-other" };
    f.classify.mockResolvedValue(success());
    expect(await askSystem1(f.registry, other, {}, questions)).toMatchObject({
      ok: true,
      backend: "jev",
      model: "jev-wire-version",
    });
    expect(await request(f.registry)).toMatchObject({
      ok: true,
      backend: "openai-decisions",
      attempts: [{ status: "cooldown", model: "jev-latest" }, { status: "succeeded" }],
    });
  });

  it("returns bounded exhaustion while all targets cool, without any further model lookups", async () => {
    const f = fake(async () => failure("insufficient_quota"));
    await request(f.registry);
    for (let i = 0; i < 3; i++) {
      expect(await request(f.registry, { id: i })).toMatchObject({
        ok: false,
        code: "exhausted",
        latencyMs: 0,
        attempts: [
          { status: "cooldown", sdkCalls: 0 },
          { status: "cooldown", sdkCalls: 0 },
        ],
      });
    }
    expect(f.findOfType).toHaveBeenCalledTimes(2);
    expect(f.classify).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never starts background probes, including after cooldown expiry or snapshot reads", async () => {
    const f = fake(async () => failure("insufficient_quota"));
    expect(await request(f.registry)).toMatchObject({ ok: false, code: "exhausted" });
    expect(f.classify).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(hardCooldown * 10);
    for (let i = 0; i < 3; i++) {
      getSystem1RuntimeSnapshot(f.registry, config);
      getSystem1RoutingKey(f.registry, config);
    }
    expect(f.classify).toHaveBeenCalledTimes(2);
    expect(f.findOfType).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("half-open concurrency and recovery", () => {
  it("allows one half-open preferred request while concurrent states use the alternative rung", async () => {
    const probe = deferred<ClassifierResult>();
    let phase = "cool";
    const f = fake(async (model, ctx) =>
      isJev(model)
        ? phase === "cool"
          ? failure("insufficient_quota")
          : probe.promise
        : success(ctx.state.id === "concurrent" ? 0.1 : 0.9),
    );
    await request(f.registry, { id: "initial" });
    const fallbackKey = getSystem1RoutingKey(f.registry, config);
    await vi.advanceTimersByTimeAsync(hardCooldown);
    expect(getSystem1RoutingKey(f.registry, config)).not.toBe(fallbackKey);
    phase = "probe";
    const preferred = request(f.registry, { id: "probe-state" });
    expect(candidate(f.registry).probing).toBe(true);
    expect(getSystem1RoutingKey(f.registry, config)).toBe(fallbackKey);
    const concurrent = await request(f.registry, { id: "concurrent" });
    expect(concurrent).toMatchObject({
      ok: true,
      backend: "openai-decisions",
      answers: { q: { probability: 0.1 } },
      attempts: [{ status: "probing", sdkCalls: 0 }, { status: "succeeded" }],
    });
    expect(f.classify.mock.calls.filter((call) => isJev(call[0]))).toHaveLength(2);
    probe.resolve(success(0.7));
    expect(await preferred).toMatchObject({
      ok: true,
      backend: "jev",
      answers: { q: { probability: 0.7 } },
      attempts: [{ status: "succeeded" }],
    });
    expect(candidate(f.registry)).toMatchObject({ probing: false });
    expect(candidate(f.registry)).not.toHaveProperty("cooldownUntil");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns bounded exhaustion when every rung is probing, without borrowing another state's answers", async () => {
    const probe = deferred<ClassifierResult>();
    const f = fake(async () => failure("insufficient_quota"));
    await request(f.registry);
    await vi.advanceTimersByTimeAsync(hardCooldown);
    f.classify.mockImplementation(async () => probe.promise);
    const first = request(f.registry, { id: "first" });
    const second = request(f.registry, { id: "second" });
    expect(getSystem1RuntimeSnapshot(f.registry, config).candidates.map((c) => c.probing)).toEqual([true, true]);
    const third = await request(f.registry, { id: "third" });
    expect(third).toMatchObject({
      ok: false,
      code: "exhausted",
      latencyMs: 0,
      attempts: [
        { status: "probing", sdkCalls: 0 },
        { status: "probing", sdkCalls: 0 },
      ],
    });
    expect(third).not.toHaveProperty("answers");
    expect(f.classify).toHaveBeenCalledTimes(4);
    probe.resolve(success(0.6));
    expect(await first).toMatchObject({ ok: true, backend: "jev" });
    expect(await second).toMatchObject({ ok: true, backend: "openai-decisions" });
    expect(f.classify).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns immediately when the alternative is still cooling and the preferred target is probing", async () => {
    const probe = deferred<ClassifierResult>();
    const f = fake(async (model) => failure(isJev(model) ? "429 rate limit" : "insufficient_quota"));
    await request(f.registry);
    await vi.advanceTimersByTimeAsync(shortCooldown);
    f.classify.mockImplementation(async () => probe.promise);
    const active = request(f.registry, { id: "active" });
    expect(await request(f.registry, { id: "blocked" })).toMatchObject({
      ok: false,
      code: "exhausted",
      latencyMs: 0,
      attempts: [{ status: "probing" }, { status: "cooldown" }],
    });
    expect(f.classify).toHaveBeenCalledTimes(3);
    probe.resolve(success());
    expect(await active).toMatchObject({ ok: true, backend: "jev" });
  });

  it("releases a cancelled half-open slot without quarantine renewal or recovery notice", async () => {
    const f = fake(async (model) => (isJev(model) ? failure("429") : success()));
    await request(f.registry);
    await vi.advanceTimersByTimeAsync(shortCooldown);
    f.classify.mockImplementation(async () => new Promise(() => {}));
    const controller = new AbortController();
    const notices = vi.fn();
    const pending = askSystem1(f.registry, config, {}, questions, controller.signal, { onNotice: notices });
    expect(candidate(f.registry).probing).toBe(true);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, code: "cancelled" });
    expect(candidate(f.registry)).toMatchObject({ probing: false, cooldownUntil: epoch + shortCooldown });
    expect(notices).not.toHaveBeenCalled();
    expect(f.classify).toHaveBeenCalledTimes(3);
    f.classify.mockResolvedValue(success(0.4));
    expect(await request(f.registry)).toMatchObject({ ok: true, backend: "jev", answers: { q: { probability: 0.4 } } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not cache successful answers across distinct or repeated state objects", async () => {
    const first = deferred<ClassifierResult>();
    const second = deferred<ClassifierResult>();
    const f = fake(async (_model, ctx) => (ctx.state.id === "first" ? first.promise : second.promise));
    const a = request(f.registry, { id: "first" });
    const b = request(f.registry, { id: "second" });
    expect(f.classify).toHaveBeenCalledTimes(2);
    second.resolve(success(0.1));
    expect(await b).toMatchObject({ ok: true, answers: { q: { probability: 0.1 } } });
    first.resolve(success(0.9));
    expect(await a).toMatchObject({ ok: true, answers: { q: { probability: 0.9 } } });
    f.classify.mockResolvedValue(success(0.3));
    expect(await request(f.registry, { id: "first" })).toMatchObject({
      ok: true,
      answers: { q: { probability: 0.3 } },
    });
    expect(f.classify).toHaveBeenCalledTimes(3);
  });

  it("renews a failed half-open cooldown from probe completion, then recovers exactly once", async () => {
    const notices = vi.fn();
    const f = fake(async (model) => (isJev(model) ? failure("insufficient_quota") : success()));
    const judge = () => askSystem1(f.registry, config, {}, questions, undefined, { onNotice: notices });
    await judge();
    await vi.advanceTimersByTimeAsync(hardCooldown);
    const probe = deferred<ClassifierResult>();
    f.classify.mockImplementation(async (model) => (isJev(model) ? probe.promise : success()));
    const pending = judge();
    await vi.advanceTimersByTimeAsync(20);
    probe.resolve(failure("401 invalid key"));
    expect(await pending).toMatchObject({ ok: true, backend: "openai-decisions" });
    expect(candidate(f.registry)).toMatchObject({
      probing: false,
      cooldownUntil: epoch + 2 * hardCooldown + 20,
      lastFailure: { code: "invalid_credentials" },
    });
    expect(notices.mock.calls.some(([n]) => n.kind === "recovered")).toBe(false);
    await vi.advanceTimersByTimeAsync(hardCooldown);
    f.classify.mockResolvedValue(success());
    expect(await judge()).toMatchObject({ ok: true, backend: "jev", fallback: false });
    await judge();
    expect(notices.mock.calls.map(([n]) => n.kind)).toEqual(["provider_failed", "provider_failed", "recovered"]);
    expect(notices.mock.calls.at(-1)?.[0]).toMatchObject({ backend: "jev", preferred: true });
    expect(candidate(f.registry)).not.toHaveProperty("lastFailure");
    expect(getSystem1RuntimeSnapshot(f.registry, config)).not.toHaveProperty("nextRetryAt");
  });

  it("announces recovered nonpreferred providers without pretending preferred order is restored", async () => {
    const notices = vi.fn();
    const f = fake(async (model) => failure(isJev(model) ? "insufficient_quota" : "429"));
    await request(f.registry);
    await vi.advanceTimersByTimeAsync(shortCooldown);
    f.classify.mockResolvedValue(success());
    expect(await askSystem1(f.registry, config, {}, questions, undefined, { onNotice: notices })).toMatchObject({
      ok: true,
      backend: "openai-decisions",
      fallback: true,
    });
    expect(notices).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "recovered", backend: "openai-decisions", preferred: false }),
    );
    expect(candidate(f.registry).cooldownUntil).toBe(epoch + hardCooldown);
  });
});

describe("runtime scope and explicit invalidation", () => {
  it("isolates health by registry while allowing directory-wide and filtered observation", async () => {
    const a = fake(async (model) => (isJev(model) ? failure("insufficient_quota") : success()));
    const b = fake();
    const events: System1Event[] = [];
    const onlyA: System1Event[] = [];
    cleanups.push(
      subscribeSystem1Events((event) => events.push(event)),
      subscribeSystem1Events((event) => onlyA.push(event), a.registry),
    );
    await request(a.registry);
    expect(candidate(a.registry)).toHaveProperty("cooldownUntil");
    expect(candidate(b.registry)).not.toHaveProperty("cooldownUntil");
    expect(await request(b.registry)).toMatchObject({ ok: true, backend: "jev" });
    expect(events.filter((e) => e.type === "outcome").map((e) => e.registry)).toEqual([a.registry, b.registry]);
    expect(onlyA.every((e) => e.registry === a.registry)).toBe(true);
    expect(onlyA.filter((e) => e.type === "outcome")).toHaveLength(1);
  });

  it("manual reset invalidates all registries in this directory exactly once without a probe or policy rewrite", async () => {
    const a = fake(async () => failure("insufficient_quota"));
    const b = fake(async () => failure("insufficient_quota"));
    await request(a.registry);
    await request(b.registry);
    const policy = readSystem1Setting();
    const key = resolveSystem1Route(config).key;
    const generation = getSystem1RuntimeSnapshot(a.registry, config).resetGeneration;
    resetSystem1Runtime(a.registry);
    expect(readSystem1Setting()).toEqual(policy);
    expect(resolveSystem1Route(config).key).not.toBe(key);
    for (const f of [a, b]) {
      const snapshot = getSystem1RuntimeSnapshot(f.registry, config);
      expect(snapshot).toMatchObject({ resetGeneration: generation + 1, lastResetAt: epoch });
      expect(
        snapshot.candidates.every((c) => !c.probing && c.cooldownUntil === undefined && c.lastFailure === undefined),
      ).toBe(true);
      expect(snapshot).not.toHaveProperty("lastOutcome");
      expect(snapshot).not.toHaveProperty("lastUsed");
      expect(f.classify).toHaveBeenCalledTimes(2);
      f.classify.mockResolvedValue(success());
      expect(await request(f.registry)).toMatchObject({ ok: true, backend: "jev" });
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("manual reset rejects an old probe's answer without clearing a new generation's health", async () => {
    const probe = deferred<ClassifierResult>();
    const f = fake(async () => failure("insufficient_quota"));
    await request(f.registry);
    await vi.advanceTimersByTimeAsync(hardCooldown);
    f.classify.mockImplementation(async () => probe.promise);
    const pending = request(f.registry, { id: "old" });
    resetSystem1Runtime(f.registry);
    f.classify.mockImplementation(async (model) => (isJev(model) ? failure("429") : success(0.2)));
    const fresh = await request(f.registry, { id: "new" });
    expect(fresh).toMatchObject({ ok: true, backend: "openai-decisions" });
    probe.resolve(success(0.9));
    expect(await pending).toMatchObject({ ok: false, code: "selection_changed" });
    expect(getSystem1RuntimeSnapshot(f.registry, config).lastOutcome).toBe(fresh);
    expect(candidate(f.registry)).toMatchObject({
      cooldownUntil: epoch + hardCooldown + shortCooldown,
      lastFailure: { code: "rate_limited" },
    });
  });

  it("clears circuits and cached outcome on an effective chain change, not unrelated JSON edits", async () => {
    const f = fake(async (model) => (isJev(model) ? failure("insufficient_quota") : success()));
    const original = await request(f.registry);
    const key = resolveSystem1Route(config).key;
    select(order, { unrelated: true });
    expect(resolveSystem1Route(config).key).toBe(key);
    expect(getSystem1RuntimeSnapshot(f.registry, config).lastOutcome).toBe(original);
    expect(candidate(f.registry)).toHaveProperty("cooldownUntil");
    select(["openai-decisions", "jev"]);
    const changed = getSystem1RuntimeSnapshot(f.registry, config);
    expect(changed.candidates.every((c) => c.cooldownUntil === undefined)).toBe(true);
    expect(changed).not.toHaveProperty("lastOutcome");
    expect(changed).not.toHaveProperty("lastUsed");
    select();
    f.classify.mockResolvedValue(success());
    expect(await request(f.registry)).toMatchObject({ ok: true, backend: "jev" });
  });

  it("configuration replacement fences an in-flight probe instead of failing over or restoring stale health", async () => {
    const probe = deferred<ClassifierResult>();
    const f = fake(async (model) => (isJev(model) ? failure("429") : success()));
    await request(f.registry);
    await vi.advanceTimersByTimeAsync(shortCooldown);
    f.classify.mockImplementation(async () => probe.promise);
    const notices = vi.fn();
    const pending = askSystem1(f.registry, config, {}, questions, undefined, { onNotice: notices });
    select(["openai-decisions"]);
    probe.resolve(success());
    expect(await pending).toMatchObject({ ok: false, code: "selection_changed" });
    expect(notices).not.toHaveBeenCalled();
    expect(f.classify).toHaveBeenCalledTimes(3);
    expect(getSystem1RuntimeSnapshot(f.registry, config)).not.toHaveProperty("lastOutcome");
  });

  it("shares circuits, reset generation and observers across independently loaded helper instances", async () => {
    // Re-evaluation models separate Jiti/package-local copies without depending on a sibling's install.
    vi.resetModules();
    const copy = await import("../src/system1.ts");
    expect(copy.askSystem1).not.toBe(askSystem1);
    const events = vi.fn();
    cleanups.push(copy.subscribeSystem1Events(events));
    const f = fake(async (model) => (isJev(model) ? failure("insufficient_quota") : success()));
    await request(f.registry);
    expect(copy.getSystem1RuntimeSnapshot(f.registry, config).candidates[0].cooldownUntil).toBe(epoch + hardCooldown);
    expect(await copy.askSystem1(f.registry, config, {}, questions)).toMatchObject({
      ok: true,
      attempts: [{ status: "cooldown" }, { status: "succeeded" }],
    });
    expect(f.classify).toHaveBeenCalledTimes(3);
    expect(events.mock.calls.filter(([e]) => e.type === "outcome")).toHaveLength(2);
    copy.resetSystem1Runtime(f.registry);
    expect(getSystem1RuntimeSnapshot(f.registry, config).resetGeneration).toBe(1);
    expect(candidate(f.registry)).not.toHaveProperty("cooldownUntil");
    expect(copy.resolveSystem1Route(config).key).toBe(resolveSystem1Route(config).key);
  });

  it("shares half-open ownership across separately evaluated helpers without sharing request answers", async () => {
    vi.resetModules();
    const copy = await import("../src/system1.ts");
    const probe = deferred<ClassifierResult>();
    const f = fake(async (model) => (isJev(model) ? failure("429") : success()));
    await request(f.registry);
    await vi.advanceTimersByTimeAsync(shortCooldown);
    f.classify.mockImplementation(async (model) => (isJev(model) ? probe.promise : success(0.1)));
    const primary = request(f.registry, { origin: "canonical" });
    expect(copy.getSystem1RuntimeSnapshot(f.registry, config).candidates[0].probing).toBe(true);
    expect(await copy.askSystem1(f.registry, config, { origin: "copy" }, questions)).toMatchObject({
      ok: true,
      backend: "openai-decisions",
      answers: { q: { probability: 0.1 } },
      attempts: [{ status: "probing", sdkCalls: 0 }, { status: "succeeded" }],
    });
    probe.resolve(success(0.9));
    expect(await primary).toMatchObject({ ok: true, backend: "jev", answers: { q: { probability: 0.9 } } });
    expect(f.classify.mock.calls.filter((call) => isJev(call[0]))).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates circuits, resets and observers by resolved agent directory, even for the same registry", async () => {
    const f = fake(async (model) => (isJev(model) ? failure("insufficient_quota") : success()));
    const events = vi.fn();
    cleanups.push(subscribeSystem1Events(events));
    await request(f.registry);
    const aKey = resolveSystem1Route(config).key;
    const bDir = mkdtempSync(path.join(tmpdir(), "system1-other-agent-"));
    directories.push(bDir);
    process.env.PI_CODING_AGENT_DIR = bDir;
    select();
    expect(candidate(f.registry)).not.toHaveProperty("cooldownUntil");
    f.classify.mockResolvedValue(success());
    expect(await request(f.registry)).toMatchObject({ ok: true, backend: "jev" });
    resetSystem1Runtime(f.registry);
    expect(getSystem1RuntimeSnapshot(f.registry, config).resetGeneration).toBe(1);
    expect(events.mock.calls.filter(([e]) => e.type === "outcome")).toHaveLength(1);
    process.env.PI_CODING_AGENT_DIR = path.join(directory, ".");
    expect(resolveSystem1Route(config).key).toBe(aKey);
    expect(getSystem1RuntimeSnapshot(f.registry, config).resetGeneration).toBe(0);
    expect(candidate(f.registry)).toHaveProperty("cooldownUntil", epoch + hardCooldown);
  });
});

describe("notification binder runtime lifecycle", () => {
  it("clears circuits and last-route metadata on same-factory restart and rebinds only the current sink", async () => {
    const f = fake(async (model) => (isJev(model) ? failure("insufficient_quota") : success()));
    const h = host();
    installSystem1Notifications(h.pi);
    const oldContext = context(f.registry);
    await h.emit("session_start", oldContext);
    await request(f.registry);
    expect(oldContext.ui.notify).toHaveBeenCalledTimes(1);
    expect(getSystem1RuntimeSnapshot(f.registry, config)).toHaveProperty("lastUsed");
    await h.emit("session_shutdown", oldContext);
    const nextContext = context(f.registry, "session-b");
    await h.emit("session_start", nextContext);
    const cleared = getSystem1RuntimeSnapshot(f.registry, config);
    expect(cleared.candidates.every((c) => !c.probing && c.cooldownUntil === undefined)).toBe(true);
    expect(cleared).not.toHaveProperty("lastOutcome");
    expect(cleared).not.toHaveProperty("lastUsed");
    f.classify.mockResolvedValue(success());
    expect(await request(f.registry)).toMatchObject({ ok: true, backend: "jev" });
    expect(oldContext.ui.notify).toHaveBeenCalledTimes(1);
    expect(h.appendEntry).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await h.emit("session_shutdown", nextContext);
  });

  it("clears circuits for a different session tree and releases audit/notification sinks on shutdown", async () => {
    const f = fake(async (model) => (isJev(model) ? failure("insufficient_quota") : success()));
    const h = host();
    installSystem1Notifications(h.pi);
    const a = context(f.registry, "tree-a");
    const b = context(f.registry, "tree-b");
    await h.emit("session_start", a);
    await request(f.registry);
    await h.emit("session_tree", b);
    expect(candidate(f.registry)).not.toHaveProperty("cooldownUntil");
    expect(getSystem1RuntimeSnapshot(f.registry, config)).not.toHaveProperty("lastOutcome");
    resetSystem1Runtime(f.registry); // Allow an identical notice in the new tree.
    await request(f.registry);
    expect(a.ui.notify).toHaveBeenCalledTimes(1);
    expect(b.ui.notify).toHaveBeenCalledTimes(1);
    expect(h.appendEntry).toHaveBeenCalledTimes(2);
    await h.emit("session_shutdown", b);
    resetSystem1Runtime(f.registry);
    await request(f.registry);
    expect(a.ui.notify).toHaveBeenCalledTimes(1);
    expect(b.ui.notify).toHaveBeenCalledTimes(1);
    expect(h.appendEntry).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not clear another registry's circuits merely because one session starts", async () => {
    const a = fake(async () => failure("insufficient_quota"));
    const b = fake(async () => failure("insufficient_quota"));
    await request(a.registry);
    await request(b.registry);
    const h = host();
    installSystem1Notifications(h.pi);
    const ctx = context(a.registry);
    await h.emit("session_start", ctx);
    expect(candidate(a.registry)).not.toHaveProperty("cooldownUntil");
    expect(candidate(b.registry)).toHaveProperty("cooldownUntil");
    expect(a.classify).toHaveBeenCalledTimes(2);
    expect(b.classify).toHaveBeenCalledTimes(2);
    await h.emit("session_shutdown", ctx);
  });
});
