import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  askSystem1,
  encodeSystem1Notice,
  formatSystem1Notice,
  installSystem1Notifications,
  notifySystem1Notice,
  parseSystem1Notice,
  resetSystem1Runtime,
  subscribeSystem1Events,
  system1Path,
  type ClassifierConfig,
  type ClassifierQuestion,
  type ClassifierRegistry,
  type ClassifierResult,
  type ClassifierUsage,
  type System1Backend,
  type System1Event,
  type System1FailureCode,
  type System1Notice,
  type System1NotificationContext,
  type System1NotificationHost,
} from "../src/system1.ts";

const NOW = Date.UTC(2026, 10, 1);
const PREFIX = "pi-system1.notice.v1:";
const ORDER: System1Backend[] = ["jev", "openai-decisions"];
const config: ClassifierConfig = { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 1_000 };
const questions: Record<string, ClassifierQuestion> = {
  q: {
    type: "bool",
    instructions: "Judge the supplied evidence",
    criteria: { true: "Supported", false: "Unsupported" },
  },
};
const usage: ClassifierUsage = {
  input: 10,
  output: 2,
  cacheRead: 1,
  cacheWrite: 0,
  totalTokens: 13,
  cost: { input: 0.1, output: 0.02, cacheRead: 0.01, cacheWrite: 0, total: 0.13 },
};
function success(): ClassifierResult {
  return { model: "reported-model", stopReason: "stop", answers: { q: { type: "bool", probability: 0.8 } }, usage };
}
function failure(message = "insufficient_quota PRIVATE_PROVIDER_BODY"): ClassifierResult {
  return { model: "reported-model", stopReason: "error", answers: {}, errorMessage: message, usage };
}
function fakeRegistry(run: ClassifierRegistry["classify"] = async () => success()) {
  const classify = vi.fn<ClassifierRegistry["classify"]>(run);
  const findOfType = vi.fn<ClassifierRegistry["findOfType"]>((_type, provider, id) => ({
    type: "classifier",
    provider,
    id,
    ...(provider === "system1-openai" ? { api: "openai-decisions", baseUrl: "https://api.openai.com/v1" } : {}),
  }));
  const registry: ClassifierRegistry = { findOfType, classify };
  return { registry, classify, findOfType };
}
function fallbackRegistry() {
  return fakeRegistry(async (model) =>
    (model as { provider: string }).provider === "typesafe" ? failure() : success(),
  );
}
function notice(overrides: Partial<Extract<System1Notice, { kind: "provider_failed" }>> = {}): System1Notice {
  return {
    version: 1,
    at: Date.now(),
    kind: "provider_failed",
    waterfall: [...ORDER],
    backend: "jev",
    code: "quota_exhausted",
    next: "openai-decisions",
    ...overrides,
  };
}
function context(registry: unknown, mode = "tui", session = "session-a") {
  return {
    mode,
    hasUI: mode === "tui",
    modelRegistry: registry,
    sessionManager: { getSessionId: () => session },
    ui: {
      notify: vi.fn<(message: string, type?: "info" | "warning" | "error") => void>(),
      select: vi.fn(),
      confirm: vi.fn(),
      setEditorText: vi.fn(),
      setWidget: vi.fn(),
    },
    stderr: vi.fn<(message: string) => void>(),
  };
}
type Lifecycle = Parameters<System1NotificationHost["on"]>[0];
type Handler = Parameters<System1NotificationHost["on"]>[1];
const releases: (() => void)[] = [];
function host(options: Parameters<typeof installSystem1Notifications>[1] = {}) {
  const handlers = new Map<Lifecycle, Handler[]>();
  const pi = {
    on: vi.fn<System1NotificationHost["on"]>((event, handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    appendEntry: vi.fn<(customType: string, data?: unknown) => void>(),
    // These APIs would inject model-context messages; none may be used by the binder.
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  };
  installSystem1Notifications(pi, options);
  releases.push(() => {
    for (const handler of handlers.get("session_shutdown") ?? []) void handler({}, {});
  });
  const emit = async (event: Lifecycle, ctx: System1NotificationContext, payload: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  return { pi, emit };
}
function select(waterfall: System1Backend[] = ORDER) {
  writeFileSync(system1Path(), JSON.stringify({ waterfall }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let directory: string;
let previousDirectory: string | undefined;
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  previousDirectory = process.env.PI_CODING_AGENT_DIR;
  directory = mkdtempSync(path.join(tmpdir(), "system1-notifications-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  network = vi.fn(() => {
    throw new Error("Notifications tests must never make HTTP requests");
  });
  vi.stubGlobal("fetch", network);
  select();
});
afterEach(() => {
  for (const release of releases.splice(0)) release();
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
});

describe("notification traversal and single-sink ownership", () => {
  it("warns observers, the requesting callback and the visible sink before looking up the next rung", async () => {
    const order: string[] = [];
    const fake = fakeRegistry(async (model) => {
      const provider = (model as { provider: string }).provider;
      order.push(`classify:${provider}`);
      return provider === "typesafe" ? failure() : success();
    });
    fake.findOfType.mockImplementation((_type, provider, id) => {
      order.push(`lookup:${provider}`);
      return { provider, id, api: "openai-decisions", baseUrl: "https://api.openai.com/v1" };
    });
    const ctx = context(fake.registry);
    ctx.ui.notify.mockImplementation(() => {
      order.push("visible-warning");
    });
    const sink = host();
    await sink.emit("session_start", ctx);
    releases.push(
      subscribeSystem1Events((event) => {
        if (event.type === "notice") order.push("observer");
      }),
    );
    const outcome = await askSystem1(fake.registry, config, {}, questions, undefined, {
      onNotice: () => {
        order.push("request-callback");
      },
    });
    expect(outcome).toMatchObject({ ok: true, backend: "openai-decisions", fallback: true });
    expect(order).toEqual([
      "lookup:typesafe",
      "classify:typesafe",
      "observer",
      "request-callback",
      "visible-warning",
      "lookup:system1-openai",
      "classify:system1-openai",
    ]);
    expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
      "System 1: Jev unavailable (quota or credits exhausted); trying OpenAI Decisions.",
      "warning",
    );
  });

  it.each([false, true])(
    "selects only priority 100 over priority 0 regardless of registration order (core first: %s)",
    async (coreFirst) => {
      const fake = fallbackRegistry();
      const standalone = host({ priority: 0 });
      const core = host({ priority: 100 });
      const standaloneContext = context(fake.registry);
      const coreContext = context(fake.registry);
      const event = {};
      for (const [sink, ctx] of coreFirst
        ? ([
            [core, coreContext],
            [standalone, standaloneContext],
          ] as const)
        : ([
            [standalone, standaloneContext],
            [core, coreContext],
          ] as const)) {
        await sink.emit("session_start", ctx, event);
      }
      expect((await askSystem1(fake.registry, config, {}, questions)).ok).toBe(true);
      expect(coreContext.ui.notify).toHaveBeenCalledTimes(1);
      expect(standaloneContext.ui.notify).not.toHaveBeenCalled();
      expect(core.pi.appendEntry).toHaveBeenCalledTimes(1);
      expect(standalone.pi.appendEntry).not.toHaveBeenCalled();
    },
  );

  it("prefers a visible TUI, then the requesting RPC (never a foreign RPC), then explicit stderr", async () => {
    const fake = fakeRegistry(async () => failure("malformed response PRIVATE_PROVIDER_BODY"));
    select(["jev"]);
    const tui = host({ priority: 0 });
    const rpc = host({ priority: 100 });
    const foreign = host({ priority: 1_000 });
    const cli = host({ priority: 10_000 });
    const tuiContext = context({}, "tui");
    const rpcContext = context(fake.registry, "rpc");
    const foreignContext = context({}, "rpc");
    const cliContext = context({}, "print");
    await cli.emit("session_start", cliContext);
    await foreign.emit("session_start", foreignContext);
    await rpc.emit("session_start", rpcContext);
    await tui.emit("session_start", tuiContext);
    await askSystem1(fake.registry, config, {}, questions);
    expect(tuiContext.ui.notify).toHaveBeenCalledTimes(1);
    expect(rpcContext.ui.notify).not.toHaveBeenCalled();
    expect(cliContext.stderr).not.toHaveBeenCalled();
    await tui.emit("session_shutdown", tuiContext);
    vi.setSystemTime(NOW + 60_000);
    await askSystem1(fake.registry, config, {}, questions);
    expect(rpcContext.ui.notify).toHaveBeenCalledTimes(1);
    const [packet, type] = rpcContext.ui.notify.mock.calls[0]!;
    expect(parseSystem1Notice(packet)).toMatchObject({
      kind: "exhausted",
      failures: [{ backend: "jev", code: "invalid_answers" }],
    });
    expect(type).toBe("warning");
    await rpc.emit("session_shutdown", rpcContext);
    vi.setSystemTime(NOW + 120_000);
    await askSystem1(fake.registry, config, {}, questions);
    expect(cliContext.stderr).toHaveBeenCalledExactlyOnceWith(
      "System 1: Jev unavailable (invalid answers); no configured providers remain.",
    );
    expect(foreignContext.ui.notify).not.toHaveBeenCalled();
    expect(cliContext.ui.notify).not.toHaveBeenCalled();
  });

  it("does not mistake a hidden TUI for a visible one", async () => {
    const fake = fallbackRegistry();
    const hidden = host({ priority: 100 });
    const rpc = host();
    const hiddenContext = { ...context({}, "tui"), hasUI: false, stderr: undefined };
    const rpcContext = context(fake.registry, "rpc");
    await hidden.emit("session_start", hiddenContext);
    await rpc.emit("session_start", rpcContext);
    await askSystem1(fake.registry, config, {}, questions);
    expect(hiddenContext.ui.notify).not.toHaveBeenCalled();
    expect(rpcContext.ui.notify).toHaveBeenCalledTimes(1);
  });

  it("recognizes a visible hasUI context without an explicit mode as TUI", async () => {
    const fake = fallbackRegistry();
    const tui = host();
    const rpc = host({ priority: 100 });
    const tuiContext = { ...context({}), mode: undefined, stderr: undefined };
    const rpcContext = context(fake.registry, "rpc");
    await tui.emit("session_start", tuiContext);
    await rpc.emit("session_start", rpcContext);
    await askSystem1(fake.registry, config, {}, questions);
    expect(tuiContext.ui.notify).toHaveBeenCalledTimes(1);
    expect(rpcContext.ui.notify).not.toHaveBeenCalled();
  });

  it("releases a high-priority owner so a standalone component can notify and audit once", async () => {
    select(["jev"]);
    const fake = fakeRegistry(async () => failure("malformed response"));
    const core = host({ priority: 100 });
    const standalone = host();
    const coreContext = context(fake.registry);
    const standaloneContext = context(fake.registry);
    const start = {};
    await core.emit("session_start", coreContext, start);
    await standalone.emit("session_start", standaloneContext, start);
    await askSystem1(fake.registry, config, {}, questions);
    await core.emit("session_shutdown", coreContext);
    vi.setSystemTime(NOW + 60_000);
    await askSystem1(fake.registry, config, {}, questions);
    expect(coreContext.ui.notify).toHaveBeenCalledTimes(1);
    expect(standaloneContext.ui.notify).toHaveBeenCalledTimes(1);
    expect(core.pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(standalone.pi.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("never writes implicitly when no usable notification sink was installed", async () => {
    const fake = fallbackRegistry();
    const unusable = host();
    const ctx = context(fake.registry, "print");
    await unusable.emit("session_start", { ...ctx, stderr: undefined });
    expect((await askSystem1(fake.registry, config, {}, questions)).ok).toBe(true);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(ctx.stderr).not.toHaveBeenCalled();
    expect(unusable.pi.appendEntry).not.toHaveBeenCalled();
  });

  it("uses one unavailable transition, not both a final-rung warning and an exhaustion toast", async () => {
    select(["openai-decisions"]);
    const fake = fakeRegistry(async () => failure("No API key found PRIVATE_PROVIDER_BODY"));
    const ctx = context(fake.registry);
    const sink = host();
    await sink.emit("session_start", ctx);
    expect(await askSystem1(fake.registry, config, {}, questions)).toMatchObject({ ok: false, code: "exhausted" });
    expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
      "System 1: OpenAI Decisions unavailable (credentials missing); no configured providers remain.",
      "warning",
    );
  });
});

describe("deduplication and recovery", () => {
  it("deduplicates for exactly 60 seconds using receipt time, not the remote event timestamp", () => {
    const ctx = context({});
    const remote = notice({ at: NOW + 86_400_000 });
    notifySystem1Notice(ctx, remote, "child-a");
    vi.setSystemTime(NOW + 59_999);
    notifySystem1Notice(ctx, { ...remote, at: NOW + 2 * 86_400_000 }, "child-a");
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 60_000);
    notifySystem1Notice(ctx, remote, "child-a");
    expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
  });

  it("does not treat cooldown timestamp jitter as a new relayed failure", () => {
    const ctx = context({});
    notifySystem1Notice(ctx, notice({ retryAt: NOW + 300_000 }), "child-a");
    vi.setSystemTime(NOW + 1);
    notifySystem1Notice(ctx, notice({ retryAt: NOW + 300_001 }), "child-a");
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  it("deduplicates the same account failure from separate registry instances", async () => {
    const ctx = context({});
    const sink = host();
    await sink.emit("session_start", ctx);
    const first = fallbackRegistry();
    const second = fallbackRegistry();
    const notices: System1Event[] = [];
    releases.push(subscribeSystem1Events(event => { if (event.type === "notice") notices.push(event); }));
    expect((await askSystem1(first.registry, config, {}, questions)).ok).toBe(true);
    vi.setSystemTime(NOW + 1);
    expect((await askSystem1(second.registry, config, {}, questions)).ok).toBe(true);
    expect(notices).toHaveLength(2); // observation/audit still sees both actual failures
    expect(sink.pi.appendEntry).toHaveBeenCalledTimes(2);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  it("keeps child origins and different typed failures distinct", () => {
    const ctx = context({});
    notifySystem1Notice(ctx, notice(), "child-a");
    notifySystem1Notice(ctx, notice(), "child-b");
    notifySystem1Notice(ctx, notice({ code: "invalid_credentials" }), "child-a");
    expect(ctx.ui.notify).toHaveBeenCalledTimes(3);
  });

  it("suppresses a relayed failure until its cooldown expires, even beyond 60 seconds", () => {
    const ctx = context({});
    const packet = notice({ retryAt: NOW + 300_000 });
    notifySystem1Notice(ctx, packet);
    vi.setSystemTime(NOW + 60_000);
    notifySystem1Notice(ctx, { ...packet, at: Date.now() });
    vi.setSystemTime(NOW + 299_999);
    notifySystem1Notice(ctx, { ...packet, at: Date.now() });
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 300_000);
    notifySystem1Notice(ctx, { ...packet, at: Date.now() });
    expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
  });

  it("does not repeat exhaustion while cooling down and announces recovery only after an actual success", async () => {
    select(["jev"]);
    let recovered = false;
    const fake = fakeRegistry(async () => (recovered ? success() : failure()));
    const ctx = context(fake.registry);
    const sink = host();
    await sink.emit("session_start", ctx);
    await askSystem1(fake.registry, config, {}, questions);
    vi.setSystemTime(NOW + 60_001);
    await askSystem1(fake.registry, config, {}, questions);
    vi.setSystemTime(NOW + 299_999);
    await askSystem1(fake.registry, config, {}, questions);
    expect(fake.classify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    recovered = true;
    vi.setSystemTime(NOW + 300_000);
    expect((await askSystem1(fake.registry, config, {}, questions)).ok).toBe(true);
    expect(ctx.ui.notify.mock.calls).toEqual([
      ["System 1: Jev unavailable (quota or credits exhausted); no configured providers remain.", "warning"],
      ["System 1: Jev available again; preferred order restored.", "info"],
    ]);
    await askSystem1(fake.registry, config, {}, questions);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
    expect(fake.classify).toHaveBeenCalledTimes(3);
  });

  it("warns about all-probing exhaustion without launching another request or reusing answers", async () => {
    const first = deferred<ClassifierResult>();
    const second = deferred<ClassifierResult>();
    let probing = false;
    const fake = fakeRegistry(async (model) =>
      !probing ? failure() : (model as { provider: string }).provider === "typesafe" ? first.promise : second.promise,
    );
    const ctx = context(fake.registry);
    const sink = host();
    await sink.emit("session_start", ctx);
    await askSystem1(fake.registry, config, {}, questions);
    vi.setSystemTime(NOW + 300_000);
    probing = true;
    const primary = askSystem1(fake.registry, config, { request: "primary" }, questions);
    const fallback = askSystem1(fake.registry, config, { request: "fallback" }, questions);
    try {
      const outcome = await askSystem1(fake.registry, config, { request: "third" }, questions);
      expect(outcome).toMatchObject({
        ok: false,
        code: "exhausted",
        attempts: [{ status: "probing" }, { status: "probing" }],
      });
      expect(outcome).not.toHaveProperty("answers");
      expect(fake.classify).toHaveBeenCalledTimes(4);
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(
        "System 1: providers are currently being retried; no spare provider is available.",
        "warning",
      );
    } finally {
      first.resolve(success());
      second.resolve(success());
      await Promise.all([primary, fallback]);
    }
  });
});

describe("harmless observers and privacy-preserving audit", () => {
  it.each([
    "observer",
    "request callback",
    "notification sink",
    "RPC sink",
    "stderr sink",
    "outcome callback",
    "audit sink",
  ])("ignores an exception from the %s without changing a successful fallback", async (broken) => {
    const fake = fallbackRegistry();
    const ctx = context(fake.registry, broken === "stderr sink" ? "print" : broken === "RPC sink" ? "rpc" : "tui");
    const throwError = () => {
      throw new Error("PRIVATE_OBSERVER_ERROR");
    };
    const seen = vi.fn<(event: System1Event) => void>();
    releases.push(subscribeSystem1Events(broken === "observer" ? throwError : () => {}));
    releases.push(subscribeSystem1Events(seen));
    const sink = host({ onOutcome: broken === "outcome callback" ? throwError : undefined });
    if (broken === "notification sink" || broken === "RPC sink") ctx.ui.notify.mockImplementation(throwError);
    if (broken === "stderr sink") ctx.stderr.mockImplementation(throwError);
    if (broken === "audit sink") sink.pi.appendEntry.mockImplementation(throwError);
    await sink.emit("session_start", ctx);
    const outcome = await askSystem1(fake.registry, config, {}, questions, undefined, {
      onNotice: broken === "request callback" ? throwError : undefined,
    });
    expect(outcome).toMatchObject({ ok: true, backend: "openai-decisions", answers: success().answers });
    expect(fake.classify).toHaveBeenCalledTimes(2);
    expect(seen.mock.calls.map(([event]) => event.type)).toEqual(["notice", "outcome"]);
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_OBSERVER_ERROR");
  });

  it.each(["observer", "request callback", "TUI sink", "RPC sink", "stderr sink", "outcome callback", "audit sink"])(
    "handles an asynchronous rejection from the %s without an unhandled rejection or a changed result",
    async (broken) => {
      const fake = fallbackRegistry();
      const ctx = context(fake.registry, broken === "stderr sink" ? "print" : broken === "RPC sink" ? "rpc" : "tui");
      const reject = vi.fn(async () => {
        await Promise.resolve();
        throw new Error("PRIVATE_ASYNC_CALLBACK_ERROR");
      });
      const seen = vi.fn<(event: System1Event) => void>();
      releases.push(subscribeSystem1Events(broken === "observer" ? reject : () => {}));
      releases.push(subscribeSystem1Events(seen));
      const sink = host({ onOutcome: broken === "outcome callback" ? reject : undefined });
      if (broken === "TUI sink" || broken === "RPC sink") ctx.ui.notify.mockImplementation(reject);
      if (broken === "stderr sink") ctx.stderr.mockImplementation(reject);
      if (broken === "audit sink") sink.pi.appendEntry.mockImplementation(reject);
      await sink.emit("session_start", ctx);
      const outcome = await askSystem1(fake.registry, config, {}, questions, undefined, {
        onNotice: broken === "request callback" ? reject : undefined,
      });
      // Flush the rejected callbacks as well as their handlers. Vitest also fails on unhandled rejections.
      await vi.runAllTimersAsync();
      expect(reject).toHaveBeenCalled();
      expect(outcome).toMatchObject({ ok: true, backend: "openai-decisions", answers: success().answers });
      expect(fake.classify).toHaveBeenCalledTimes(2);
      expect(seen.mock.calls.map(([event]) => event.type)).toEqual(["notice", "outcome"]);
      expect(sink.pi.appendEntry).toHaveBeenCalledTimes(1);
      expect(JSON.stringify({ outcome, audit: sink.pi.appendEntry.mock.calls })).not.toContain(
        "PRIVATE_ASYNC_CALLBACK_ERROR",
      );
    },
  );

  it.each(["success", "failure", "fallback"])(
    "strips extra reported usage fields and clones known counters before the %s audit",
    async (scenario) => {
      if (scenario !== "fallback") select(["jev"]);
      const reported = {
        ...usage,
        state: "PRIVATE_USAGE_INPUT",
        answers: "PRIVATE_USAGE_ANSWER",
        apiKey: "PRIVATE_USAGE_KEY",
        cost: { ...usage.cost, rawBody: "PRIVATE_USAGE_BODY", account: "PRIVATE_USAGE_ACCOUNT" },
      };
      const fake = fakeRegistry(async (model) => ({
        ...(scenario === "failure" ||
        (scenario === "fallback" && (model as { provider: string }).provider === "typesafe")
          ? failure()
          : success()),
        usage: reported,
      }));
      const sink = host();
      const ctx = context(fake.registry);
      await sink.emit("session_start", ctx);
      const outcome = await askSystem1(fake.registry, config, {}, questions);
      expect(outcome.ok).toBe(scenario !== "failure");
      expect(sink.pi.appendEntry).toHaveBeenCalledTimes(1);
      const [, audit] = sink.pi.appendEntry.mock.calls[0]!;
      const count = scenario === "fallback" ? 2 : 1;
      const expected = {
        input: usage.input * count,
        output: usage.output * count,
        cacheRead: usage.cacheRead * count,
        cacheWrite: usage.cacheWrite * count,
        totalTokens: usage.totalTokens * count,
        cost: {
          input: usage.cost.input * count,
          output: usage.cost.output * count,
          cacheRead: usage.cost.cacheRead * count,
          cacheWrite: usage.cost.cacheWrite * count,
          total: usage.cost.total * count,
        },
      };
      expect(outcome.usage).toEqual(expected);
      expect(audit).toMatchObject({ usage: expected, attempts: Array.from({ length: count }, () => ({ usage })) });
      expect(outcome.usage).not.toBe(reported);
      for (const attempt of outcome.attempts) {
        expect(attempt.usage).toEqual(usage);
        expect(attempt.usage).not.toBe(reported);
        expect(attempt.usage?.cost).not.toBe(reported.cost);
      }
      reported.input = 999;
      reported.cost.total = 999;
      expect(outcome.usage).toEqual(expected);
      expect(audit).toMatchObject({ usage: expected, attempts: Array.from({ length: count }, () => ({ usage })) });
      expect(JSON.stringify({ outcome, audit })).not.toMatch(/PRIVATE_USAGE_|rawBody|apiKey|account/);
    },
  );

  it.each([NaN, Infinity, -Infinity, "PRIVATE_USAGE_BODY"])(
    "omits invalid reported usage instead of copying the nonnumeric or nonfinite counter %s into audit",
    async (input) => {
      select(["jev"]);
      const fake = fakeRegistry(async () => ({
        ...success(),
        usage: { ...usage, input } as unknown as ClassifierUsage,
      }));
      const sink = host();
      await sink.emit("session_start", context(fake.registry));
      const outcome = await askSystem1(fake.registry, config, {}, questions);
      expect(outcome.ok).toBe(true);
      expect(outcome.usage).toBeUndefined();
      expect(outcome.attempts[0]?.usage).toBeUndefined();
      expect(sink.pi.appendEntry).toHaveBeenCalledTimes(1);
      expect(sink.pi.appendEntry.mock.calls[0]?.[1]).toMatchObject({ ok: true, usage: undefined });
      expect(JSON.stringify(sink.pi.appendEntry.mock.calls)).not.toContain("PRIVATE_USAGE_BODY");
    },
  );

  it("transports only typed metadata through RPC, including recovery info, never raw bodies or answers", async () => {
    select(["jev"]);
    let healthy = false;
    const fake = fakeRegistry(async () => (healthy ? success() : failure("401 PRIVATE_API_KEY PRIVATE_RAW_BODY")));
    const ctx = context(fake.registry, "rpc");
    const sink = host();
    await sink.emit("session_start", ctx);
    await askSystem1(fake.registry, config, { evidence: "PRIVATE_INPUT" }, questions);
    healthy = true;
    vi.setSystemTime(NOW + 300_000);
    await askSystem1(fake.registry, config, { evidence: "PRIVATE_INPUT" }, questions);
    expect(ctx.ui.notify.mock.calls.map(([message, type]) => [parseSystem1Notice(message), type])).toEqual([
      [
        {
          version: 1,
          at: NOW,
          kind: "exhausted",
          waterfall: ["jev"],
          failures: [{ backend: "jev", code: "invalid_credentials" }],
        },
        "warning",
      ],
      [
        { version: 1, at: NOW + 300_000, kind: "recovered", waterfall: ["jev"], backend: "jev", preferred: true },
        "info",
      ],
    ]);
    expect(JSON.stringify(ctx.ui.notify.mock.calls)).not.toMatch(/PRIVATE_|answers|state|registry|apiKey|errorMessage/);
    expect(ctx.stderr).not.toHaveBeenCalled();
    expect(sink.pi.sendMessage).not.toHaveBeenCalled();
    expect(sink.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("isolates registry-filtered subscriptions and releases them idempotently", async () => {
    const main = fakeRegistry();
    const child = fakeRegistry();
    const all = vi.fn();
    const onlyMain = vi.fn();
    releases.push(subscribeSystem1Events(all));
    const unsubscribe = subscribeSystem1Events(onlyMain, main.registry);
    releases.push(unsubscribe);
    await askSystem1(child.registry, config, {}, questions);
    expect(onlyMain).not.toHaveBeenCalled();
    await askSystem1(main.registry, config, {}, questions);
    expect(onlyMain).toHaveBeenCalledTimes(1);
    unsubscribe();
    unsubscribe();
    await askSystem1(main.registry, config, {}, questions);
    expect(onlyMain).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(3);
  });

  it("appends exactly one metadata-only decision with actual provenance, attempts and aggregate usage", async () => {
    const fake = fakeRegistry(async (model) =>
      (model as { provider: string }).provider === "typesafe"
        ? failure('401 PRIVATE_API_KEY PRIVATE_RAW_BODY {"input":"PRIVATE_INPUT"}')
        : {
            ...success(),
            answers: {
              sensitive: {
                type: "choice",
                choice: "PRIVATE_ANSWER",
                confidence: 0.9,
                probabilities: { PRIVATE_ANSWER: 1 },
              },
            },
          },
    );
    const ctx = context(fake.registry);
    const standalone = host();
    const core = host({ priority: 100 });
    const start = {};
    await standalone.emit("session_start", ctx, start);
    await core.emit("session_start", ctx, start);
    const outcome = await askSystem1(
      fake.registry,
      config,
      { secret: "PRIVATE_INPUT" },
      {
        sensitive: {
          type: "choice",
          instructions: "PRIVATE_INSTRUCTIONS",
          criteria: { PRIVATE_ANSWER: "PRIVATE_CRITERIA" },
        },
      },
    );
    expect(outcome.ok).toBe(true);
    expect(core.pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(standalone.pi.appendEntry).not.toHaveBeenCalled();
    const [type, data] = core.pi.appendEntry.mock.calls[0]!;
    expect(type).toBe("system1:decision");
    expect(data).toMatchObject({
      ok: true,
      waterfall: ORDER,
      backend: "openai-decisions",
      provider: "system1-openai",
      model: "gpt-6-luna",
      selectionKey: expect.any(String),
      targetKey: JSON.stringify(["openai-decisions", "system1-openai", "gpt-6-luna"]),
      fallback: true,
      latencyMs: expect.any(Number),
      usage: { totalTokens: usage.totalTokens * 2 },
      attempts: [
        {
          backend: "jev",
          status: "failed",
          code: "invalid_credentials",
          reason: "credentials invalid",
          sdkCalls: 1,
          usage,
        },
        { backend: "openai-decisions", status: "succeeded", sdkCalls: 1, usage },
      ],
    });
    const serialized = JSON.stringify({ data, notifications: ctx.ui.notify.mock.calls });
    for (const forbidden of [
      "PRIVATE_INPUT",
      "PRIVATE_ANSWER",
      "PRIVATE_INSTRUCTIONS",
      "PRIVATE_CRITERIA",
      "PRIVATE_API_KEY",
      "PRIVATE_RAW_BODY",
      '"answers"',
      '"state"',
      '"registry"',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    for (const pi of [standalone.pi, core.pi]) {
      expect(pi.sendMessage).not.toHaveBeenCalled();
      expect(pi.sendUserMessage).not.toHaveBeenCalled();
    }
    for (const forbidden of [ctx.ui.select, ctx.ui.confirm, ctx.ui.setEditorText, ctx.ui.setWidget])
      expect(forbidden).not.toHaveBeenCalled();
  });

  it("audits failed logical outcomes once with safe terminal reasons and no raw provider bodies", async () => {
    const fake = fakeRegistry(async () => failure("No API key found PRIVATE_RAW_BODY"));
    const sink = host();
    const ctx = context(fake.registry);
    await sink.emit("session_start", ctx);
    expect(await askSystem1(fake.registry, config, { secret: "PRIVATE_INPUT" }, questions)).toMatchObject({
      ok: false,
      code: "exhausted",
    });
    expect(sink.pi.appendEntry).toHaveBeenCalledTimes(1);
    const [type, data] = sink.pi.appendEntry.mock.calls[0]!;
    expect(type).toBe("system1:decision");
    expect(data).toMatchObject({
      ok: false,
      code: "exhausted",
      waterfall: ORDER,
      selectionKey: expect.any(String),
      attempts: [
        { backend: "jev", code: "missing_credentials" },
        { backend: "openai-decisions", code: "missing_credentials" },
      ],
      usage: { totalTokens: 26 },
    });
    expect(data).not.toHaveProperty("answers");
    expect(JSON.stringify(data)).not.toMatch(/PRIVATE_RAW_BODY|PRIVATE_INPUT/);
    expect(sink.pi.sendMessage).not.toHaveBeenCalled();
    expect(sink.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it.each(["success", "disabled", "invalid input", "empty questions", "aborted", "changed selection"])(
    "emits no failure warning for %s",
    async (scenario) => {
      const fake = fakeRegistry(async () => {
        if (scenario === "changed selection") select(["openai-decisions"]);
        return success();
      });
      const ctx = context(fake.registry);
      const sink = host();
      await sink.emit("session_start", ctx);
      const notices = vi.fn();
      const controller = new AbortController();
      if (scenario === "aborted") controller.abort();
      await askSystem1(
        fake.registry,
        { ...config, enabled: scenario !== "disabled" },
        {},
        scenario === "empty questions"
          ? {}
          : scenario === "invalid input"
            ? { q: { type: "invalid" } as unknown as ClassifierQuestion }
            : questions,
        controller.signal,
        { onNotice: notices },
      );
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(notices).not.toHaveBeenCalled();
      if (["disabled", "invalid input", "empty questions", "aborted"].includes(scenario))
        expect(fake.classify).not.toHaveBeenCalled();
    },
  );

  it("does not warn or traverse when an in-flight request is cancelled", async () => {
    const pending = deferred<ClassifierResult>();
    const fake = fakeRegistry(async () => pending.promise);
    const ctx = context(fake.registry);
    const sink = host();
    await sink.emit("session_start", ctx);
    const controller = new AbortController();
    const notices = vi.fn();
    const outcome = askSystem1(fake.registry, config, {}, questions, controller.signal, { onNotice: notices });
    controller.abort();
    pending.resolve(success());
    expect(await outcome).toMatchObject({ ok: false, code: "cancelled" });
    expect(fake.classify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(notices).not.toHaveBeenCalled();
    expect(sink.pi.sendMessage).not.toHaveBeenCalled();
    expect(sink.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("emits the terminal refusal template and never traverses to another provider", async () => {
    select(["openai-decisions", "jev"]);
    const fake = fakeRegistry(async () =>
      failure("Classifier provider error: OpenAI Decisions refused to answer PRIVATE_QUESTION"),
    );
    const ctx = context(fake.registry);
    const sink = host();
    await sink.emit("session_start", ctx);
    expect(await askSystem1(fake.registry, config, {}, questions)).toMatchObject({ ok: false, code: "refused" });
    expect(fake.classify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
      "System 1: OpenAI Decisions refused this judgment; safety refusals do not fail over.",
      "warning",
    );
    expect(JSON.stringify(sink.pi.appendEntry.mock.calls)).not.toContain("PRIVATE_QUESTION");
  });
});

describe("notification lifecycle and relayed stale contexts", () => {
  it("binds without inference, replaces the old tree context, releases on shutdown and rebinds the same factory", async () => {
    select(["jev"]);
    const fake = fakeRegistry(async () => failure("malformed response"));
    const sink = host();
    const old = context(fake.registry);
    const tree = context(fake.registry, "tui", "session-b");
    const restarted = context(fake.registry, "tui", "session-c");
    await sink.emit("session_start", old);
    expect(fake.findOfType).not.toHaveBeenCalled();
    expect(fake.classify).not.toHaveBeenCalled();
    await askSystem1(fake.registry, config, {}, questions);
    await sink.emit("session_tree", tree);
    vi.setSystemTime(NOW + 60_000);
    await askSystem1(fake.registry, config, {}, questions);
    expect(old.ui.notify).toHaveBeenCalledTimes(1);
    expect(tree.ui.notify).toHaveBeenCalledTimes(1);
    await sink.emit("session_shutdown", tree);
    vi.setSystemTime(NOW + 120_000);
    await askSystem1(fake.registry, config, {}, questions);
    expect(tree.ui.notify).toHaveBeenCalledTimes(1);
    expect(sink.pi.appendEntry).toHaveBeenCalledTimes(2);
    await sink.emit("session_start", restarted);
    await askSystem1(fake.registry, config, {}, questions);
    expect(restarted.ui.notify).toHaveBeenCalledTimes(1);
    expect(sink.pi.appendEntry).toHaveBeenCalledTimes(3);
    expect(sink.pi.on.mock.calls.map(([event]) => event)).toEqual([
      "session_start",
      "session_tree",
      "session_shutdown",
    ]);
  });

  it("restarting the same factory releases the old sink and clears its registry's session cooldown", async () => {
    select(["jev"]);
    const fake = fakeRegistry(async () => failure());
    const sink = host();
    const old = context(fake.registry);
    await sink.emit("session_start", old);
    await askSystem1(fake.registry, config, {}, questions);
    await sink.emit("session_shutdown", old);
    const restarted = context(fake.registry, "tui", "session-restarted");
    await sink.emit("session_start", restarted);
    expect(fake.classify).toHaveBeenCalledTimes(1);
    await askSystem1(fake.registry, config, {}, questions);
    expect(fake.classify).toHaveBeenCalledTimes(2);
    expect(sink.pi.appendEntry).toHaveBeenCalledTimes(2);
    expect(old.ui.notify).toHaveBeenCalledTimes(1);
    // The new request still falls inside the identical notice's 60-second dedup window.
    expect(restarted.ui.notify).not.toHaveBeenCalled();
  });

  it("does not notify or audit a detached context when a pending classifier finishes after shutdown", async () => {
    const pending = deferred<ClassifierResult>();
    const fake = fakeRegistry(async (model) =>
      (model as { provider: string }).provider === "typesafe" ? pending.promise : success(),
    );
    const sink = host();
    const ctx = context(fake.registry);
    await sink.emit("session_start", ctx);
    const outcome = askSystem1(fake.registry, config, {}, questions);
    await sink.emit("session_shutdown", ctx);
    pending.resolve(failure());
    expect((await outcome).ok).toBe(true);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(sink.pi.appendEntry).not.toHaveBeenCalled();
  });

  it("does not leak sinks across agent directories and releases the original hub after a directory change", async () => {
    const fake = fallbackRegistry();
    const sink = host();
    const ctx = context(fake.registry);
    await sink.emit("session_start", ctx);
    const nested = path.join(directory, "other-agent");
    // A missing configuration in the other directory is an independent Jev-only policy.
    process.env.PI_CODING_AGENT_DIR = nested;
    await askSystem1(fake.registry, config, {}, questions);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(sink.pi.appendEntry).not.toHaveBeenCalled();
    await sink.emit("session_shutdown", ctx);
    process.env.PI_CODING_AGENT_DIR = directory;
    await askSystem1(fake.registry, config, {}, questions);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(sink.pi.appendEntry).not.toHaveBeenCalled();
  });

  it("drops relayed notices for a replaced order, malformed packets or timestamps before manual reset", () => {
    const ctx = context({});
    const old = notice();
    select(["openai-decisions", "jev"]);
    notifySystem1Notice(ctx, old, "child");
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    select();
    vi.setSystemTime(NOW + 1);
    resetSystem1Runtime({});
    notifySystem1Notice(ctx, old, "child");
    notifySystem1Notice(ctx, { ...notice(), secret: "PRIVATE_INPUT" } as unknown as System1Notice, "child");
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    notifySystem1Notice(ctx, notice(), "child");
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    writeFileSync(system1Path(), "malformed");
    notifySystem1Notice(ctx, notice({ code: "timeout" }), "other-child");
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  });
});

const reasonCases: [System1FailureCode, string][] = [
  ["disabled", "classifier disabled"],
  ["cancelled", "cancelled"],
  ["selection_changed", "System 1 changed while judging; retry the request"],
  ["invalid_input", "invalid classifier input"],
  ["missing_credentials", "credentials missing"],
  ["invalid_credentials", "credentials invalid"],
  ["quota_exhausted", "quota or credits exhausted"],
  ["rate_limited", "rate limited"],
  ["unavailable_model", "model unavailable"],
  ["timeout", "timed out"],
  ["invalid_answers", "invalid answers"],
  ["provider_error", "request failed"],
  ["exhausted", "no configured providers remain"],
];
describe("fixed human templates", () => {
  it.each(reasonCases)("formats only the safe typed reason for %s", (code, reason) => {
    expect(formatSystem1Notice(notice({ code }))).toBe(
      `System 1: Jev unavailable (${reason}); trying OpenAI Decisions.`,
    );
  });
  it("formats refusal, both recovery roles, exhaustion and all-probing without arbitrary provider text", () => {
    expect(formatSystem1Notice(notice({ code: "refused" }))).toBe(
      "System 1: Jev refused this judgment; safety refusals do not fail over.",
    );
    expect(
      formatSystem1Notice({
        version: 1,
        at: NOW,
        kind: "recovered",
        waterfall: ORDER,
        backend: "jev",
        preferred: true,
      }),
    ).toBe("System 1: Jev available again; preferred order restored.");
    expect(
      formatSystem1Notice({
        version: 1,
        at: NOW,
        kind: "recovered",
        waterfall: ORDER,
        backend: "openai-decisions",
        preferred: false,
      }),
    ).toBe("System 1: OpenAI Decisions available again; available for configured failover.");
    expect(
      formatSystem1Notice({
        version: 1,
        at: NOW,
        kind: "exhausted",
        waterfall: ORDER,
        failures: [
          { backend: "jev", code: "quota_exhausted" },
          { backend: "openai-decisions", code: "missing_credentials" },
        ],
      }),
    ).toBe(
      "System 1: Jev unavailable (quota or credits exhausted); OpenAI Decisions unavailable (credentials missing); no configured providers remain.",
    );
    expect(formatSystem1Notice({ version: 1, at: NOW, kind: "exhausted", waterfall: ORDER, failures: [] })).toBe(
      "System 1: providers are currently being retried; no spare provider is available.",
    );
  });
});

describe("bounded, strictly metadata-only RPC codec", () => {
  const valid: System1Notice[] = [
    {
      version: 1,
      at: NOW,
      kind: "provider_failed",
      waterfall: ORDER,
      backend: "jev",
      code: "quota_exhausted",
      next: "openai-decisions",
      retryAt: NOW + 300_000,
    },
    { version: 1, at: NOW, kind: "provider_failed", waterfall: ["jev"], backend: "jev", code: "refused" },
    { version: 1, at: NOW, kind: "recovered", waterfall: ORDER, backend: "jev", preferred: true },
    { version: 1, at: NOW, kind: "recovered", waterfall: ORDER, backend: "openai-decisions", preferred: false },
    { version: 1, at: NOW, kind: "exhausted", waterfall: ORDER, failures: [] },
    {
      version: 1,
      at: NOW,
      kind: "exhausted",
      waterfall: ORDER,
      failures: [
        { backend: "jev", code: "timeout" },
        { backend: "openai-decisions", code: "missing_credentials" },
      ],
    },
  ];
  it.each(valid)("round-trips the branded $kind contract", (value) => {
    const encoded = encodeSystem1Notice(value);
    expect(encoded.startsWith(PREFIX)).toBe(true);
    expect(encoded.length - PREFIX.length).toBeLessThanOrEqual(4096);
    expect(parseSystem1Notice(encoded)).toEqual(value);
    expect(parseSystem1Notice(JSON.stringify(value))).toBeUndefined();
  });

  it.each([
    "",
    "System 1: Jev unavailable",
    "{}",
    `${PREFIX}{`,
    `${PREFIX}null`,
    `${PREFIX}[]`,
    `${PREFIX}{}`,
    `pi-system1.notice.v2:${JSON.stringify(valid[0])}`,
  ])("ignores malformed or unbranded input %s", (message) => {
    expect(parseSystem1Notice(message)).toBeUndefined();
  });

  const base = valid[0]!;
  const invalid: [string, unknown][] = [
    ["wrong version", { ...base, version: 2 }],
    ["missing version", { ...base, version: undefined }],
    ["unknown kind", { ...base, kind: "provider_message" }],
    ["missing timestamp", { ...base, at: undefined }],
    ["string timestamp", { ...base, at: "123" }],
    ["null timestamp", { ...base, at: null }],
    ["empty order", { ...base, waterfall: [] }],
    ["duplicate order", { ...base, waterfall: ["jev", "jev"] }],
    ["unknown order", { ...base, waterfall: ["jev", "chat"] }],
    ["nonarray order", { ...base, waterfall: "jev" }],
    ["too many rungs", { ...base, waterfall: ["jev", "openai-decisions", "jev"] }],
    ["unknown backend", { ...base, backend: "chat" }],
    ["backend outside order", { ...base, waterfall: ["openai-decisions"], next: undefined }],
    ["unknown next", { ...base, next: "chat" }],
    ["self next", { ...base, next: "jev" }],
    ["next outside order", { ...base, waterfall: ["jev"] }],
    ["unknown code", { ...base, code: "raw_error" }],
    ["missing code", { ...base, code: undefined }],
    ["string retry", { ...base, retryAt: "soon" }],
    ["null retry", { ...base, retryAt: null }],
    ["recovery missing preferred", { version: 1, at: NOW, kind: "recovered", waterfall: ORDER, backend: "jev" }],
    ["recovery nonboolean preferred", { ...valid[2], preferred: "true" }],
    ["recovery unknown backend", { ...valid[2], backend: "chat" }],
    ["exhaustion missing failures", { version: 1, at: NOW, kind: "exhausted", waterfall: ORDER }],
    ["exhaustion nonarray failures", { ...valid[4], failures: {} }],
    ["exhaustion invalid element", { ...valid[4], failures: [null] }],
    ["exhaustion unknown backend", { ...valid[4], failures: [{ backend: "chat", code: "timeout" }] }],
    ["exhaustion unknown code", { ...valid[4], failures: [{ backend: "jev", code: "raw_error" }] }],
    [
      "exhaustion outside order",
      { ...valid[4], waterfall: ["jev"], failures: [{ backend: "openai-decisions", code: "timeout" }] },
    ],
    [
      "exhaustion duplicate failures",
      {
        ...valid[4],
        failures: [
          { backend: "jev", code: "timeout" },
          { backend: "jev", code: "quota_exhausted" },
        ],
      },
    ],
    [
      "exhaustion too many failures",
      { ...valid[4], failures: Array.from({ length: 3 }, () => ({ backend: "jev", code: "timeout" })) },
    ],
    ["nested raw body", { ...valid[4], failures: [{ backend: "jev", code: "timeout", message: "PRIVATE_RAW_BODY" }] }],
    ...["message", "state", "answers", "apiKey", "account", "registry", "model"].map((key): [string, unknown] => [
      `forbidden ${key}`,
      { ...base, [key]: "PRIVATE_WIRE_DATA" },
    ]),
    ["recovery raw body", { ...valid[2], message: "PRIVATE_RAW_BODY" }],
    ["exhaustion raw body", { ...valid[4], message: "PRIVATE_RAW_BODY" }],
  ];
  it.each(invalid)("rejects %s in both encoder and decoder", (_name, value) => {
    expect(() => encodeSystem1Notice(value as System1Notice)).toThrow();
    expect(parseSystem1Notice(PREFIX + JSON.stringify(value))).toBeUndefined();
  });

  it.each([NaN, Infinity, -Infinity])("rejects nonfinite timestamps and retry timestamps: %s", (value) => {
    expect(() => encodeSystem1Notice({ ...base, at: value } as System1Notice)).toThrow();
    expect(() => encodeSystem1Notice({ ...base, retryAt: value } as System1Notice)).toThrow();
    expect(parseSystem1Notice(PREFIX + JSON.stringify({ ...base, at: value }))).toBeUndefined();
    expect(parseSystem1Notice(PREFIX + JSON.stringify({ ...base, retryAt: value }))).toBeUndefined();
  });

  it("rejects JSON numeric overflow rather than accepting parsed infinities", () => {
    for (const field of ["at", "retryAt"]) {
      const wire = JSON.stringify({ ...base, [field]: "OVERFLOW" }).replace('"OVERFLOW"', "1e309");
      expect(parseSystem1Notice(PREFIX + wire)).toBeUndefined();
    }
  });

  it("accepts a 4096-character payload but rejects anything larger before parsing", () => {
    const json = JSON.stringify(base);
    const boundary = json + " ".repeat(4096 - json.length);
    expect(parseSystem1Notice(PREFIX + boundary)).toEqual(base);
    expect(parseSystem1Notice(PREFIX + boundary + " ")).toBeUndefined();
    expect(parseSystem1Notice(PREFIX + "x".repeat(4097))).toBeUndefined();
    expect(() => encodeSystem1Notice({ ...base, message: "x".repeat(4097) } as unknown as System1Notice)).toThrow();
  });
});
