import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const sdk = vi.hoisted(() => {
  class AgentSession {
    model = { provider: "local", id: "a" };
    thinking = "high";
    records: unknown[] = ["initial"];
    defaults = { provider: "local", id: "a" };
    scope = ["local/a"];
    setCalls: unknown[][] = [];
    cycleCalls: unknown[][] = [];
    beforeSet?: () => Promise<void>;
    bindCalls: unknown[][] = [];
    abortCalls = 0;
    waitForAbort?: Promise<void>;
    _bindExtensionCore(...args: unknown[]) { this.bindCalls.push(args); return args[0]; }
    async abort() { this.abortCalls++; await this.waitForAbort; }
    constructor(readonly sessionManager: object) {}
    async setModel(model: { provider: string; id: string }, options?: { persist?: boolean }) {
      this.setCalls.push([model, options]);
      await this.beforeSet?.();
      this.model = model;
      this.thinking = "low";
      this.records.push(model);
      if (options?.persist) {
        this.defaults = model;
        this.scope.push(`${model.provider}/${model.id}`);
      }
    }
    async cycleModel(direction?: string, options?: { persist?: boolean }) {
      this.cycleCalls.push([direction, options]);
      this.model = { provider: "local", id: direction === "backward" ? "previous" : "next" };
      this.thinking = "off";
      this.records.push(this.model);
      if (options?.persist) this.defaults = this.model;
      return { model: this.model, thinkingLevel: this.thinking, isScoped: true };
    }
  }
  return { AgentSession };
});
vi.mock("@earendil-works/pi-coding-agent", () => sdk);

import { installModelGuard, type ModelGuardLease } from "../src/model-guard.ts";

const DENIED = "Linked mode chooses the model for this workflow. Use /flow independent to choose a model.";
const STATE = Symbol.for("pi-plugins.linked-model-guard.v1");
const Session = sdk.AgentSession;
const proto = Session.prototype;
const originalSet = Object.getOwnPropertyDescriptor(proto, "setModel")!;
const originalCycle = Object.getOwnPropertyDescriptor(proto, "cycleModel")!;
const originalBind = Object.getOwnPropertyDescriptor(proto, "_bindExtensionCore")!;
const originalAbort = Object.getOwnPropertyDescriptor(proto, "abort")!;
const leases: ModelGuardLease[] = [];
const target = { provider: "local", id: "b" };
let session: InstanceType<typeof sdk.AgentSession>;
let policy: { linked: boolean; revision: number };
function install(manager = session.sessionManager, read = () => policy) {
  const lease = installModelGuard(manager, read);
  leases.push(lease);
  return lease;
}
function snapshot(s = session) {
  return structuredClone({ model: s.model, thinking: s.thinking, records: s.records, defaults: s.defaults, scope: s.scope });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function denied(run: () => Promise<unknown>) {
  await expect(run()).rejects.toEqual(new Error(DENIED));
}

beforeEach(() => {
  session = new sdk.AgentSession({});
  policy = { linked: true, revision: 1 };
});
afterEach(() => {
  sdk.AgentSession = Session;
  for (const lease of leases.splice(0)) lease.dispose();
  Object.defineProperty(proto, "setModel", originalSet);
  Object.defineProperty(proto, "cycleModel", originalCycle);
  Object.defineProperty(proto, "_bindExtensionCore", originalBind);
  Object.defineProperty(proto, "abort", originalAbort);
  Reflect.deleteProperty(proto, STATE);
});

describe("strict model boundary", () => {
  test("rejects setters (including the same model) and both cycle directions before originals", async () => {
    install();
    const before = snapshot();
    for (const model of [target, session.model]) {
      for (const persist of [false, true]) await denied(() => session.setModel(model, { persist }));
    }
    for (const direction of [undefined, "forward", "backward"]) {
      for (const persist of [false, true]) await denied(() => session.cycleModel(direction, { persist }));
    }
    expect(snapshot()).toEqual(before);
    expect(session.setCalls).toEqual([]);
    expect(session.cycleCalls).toEqual([]);
  });

  test("Independent forwards receiver, exact arguments, effects and cycle result unchanged", async () => {
    policy.linked = false;
    install();
    const options = { persist: true };
    await expect(session.setModel(target, options)).resolves.toBeUndefined();
    expect(session.setCalls[0][0]).toBe(target);
    expect(session.setCalls[0][1]).toBe(options);
    expect(session.defaults).toBe(target);
    expect(session.scope).toContain("local/b");
    await expect(session.cycleModel("backward", options)).resolves.toEqual({
      model: { provider: "local", id: "previous" }, thinkingLevel: "off", isScoped: true,
    });
    expect(session.cycleCalls[0][1]).toBe(options);
    policy.linked = true;
    await denied(() => session.setModel(target));
    policy.linked = false;
    await session.setModel(target);
  });

  test("unregistered and independent managers remain independent of linked managers", async () => {
    install();
    const other = new sdk.AgentSession({});
    await other.setModel(target);
    const otherPolicy = { linked: false, revision: 7 };
    install(other.sessionManager, () => otherPolicy);
    await other.cycleModel();
    otherPolicy.linked = true;
    await denied(() => other.setModel(target));
    await denied(() => session.cycleModel());
  });

  test("preserves original rejection rather than reporting a successful application", async () => {
    const lease = install();
    const error = new Error("No API key");
    session.beforeSet = async () => { throw error; };
    const before = snapshot();
    await expect(lease.apply(target, 1, () => session.setModel(target))).rejects.toBe(error);
    expect(snapshot()).toEqual(before);
    await denied(() => session.setModel(target));
  });
});

describe("private request-local permit", () => {
  test("permits one exact target and preserves the callback result across awaits", async () => {
    const lease = install();
    const result = {};
    await expect(lease.apply(target, 1, async () => {
      await Promise.resolve();
      await session.setModel({ ...target });
      await denied(() => session.setModel(target));
      return result;
    })).resolves.toBe(result);
    expect(session.setCalls).toHaveLength(1);
    await denied(() => session.setModel(target));
  });

  test.each([
    { provider: "different", id: "b" },
    { provider: "local", id: "different" },
  ])("rejects a mismatched target and consumes that attempt: %j", async wrong => {
    const lease = install();
    await lease.apply(target, 1, async () => {
      await denied(() => session.setModel(wrong));
      await denied(() => session.setModel(target));
    });
    expect(session.setCalls).toEqual([]);
  });

  test("snapshots the target instead of allowing the caller to retarget a permit", async () => {
    const lease = install();
    const mutable = { ...target };
    await lease.apply(mutable, 1, async () => {
      mutable.id = "changed";
      await denied(() => session.setModel(mutable));
    });
    expect(session.setCalls).toEqual([]);
  });

  test("rejects stale revisions before the callback and rechecks at setter entry", async () => {
    const lease = install();
    const run = vi.fn(async () => {});
    await denied(() => lease.apply(target, 0, run));
    expect(run).not.toHaveBeenCalled();
    await lease.apply(target, 1, async () => {
      policy.revision++;
      await denied(() => session.setModel(target));
    });
    expect(session.setCalls).toEqual([]);
  });

  test("cannot borrow authorization from a different manager or lease", async () => {
    const lease = install();
    const other = new sdk.AgentSession({});
    install(other.sessionManager);
    await lease.apply(target, 1, () => denied(() => other.setModel(target)));
    const newer = install();
    await lease.apply(target, 1, async () => {
      lease.dispose();
      await denied(() => session.setModel(target));
    });
    await newer.apply(target, 1, () => session.setModel(target));
    expect(other.setCalls).toEqual([]);
    expect(session.setCalls).toHaveLength(1);
  });

  test("cycle is denied even with a live exact permit", async () => {
    const lease = install();
    await lease.apply(target, 1, async () => {
      await denied(() => session.cycleModel());
      await denied(() => session.setModel(target));
    });
    expect(session.setCalls).toEqual([]);
    expect(session.cycleCalls).toEqual([]);
  });

  test("concurrent outside attempts and nested original callbacks cannot borrow authorization", async () => {
    const lease = install();
    const entered = deferred();
    const release = deferred();
    session.beforeSet = async () => {
      entered.resolve();
      await denied(() => session.setModel(target));
      await denied(() => session.cycleModel());
      await release.promise;
    };
    const applying = lease.apply(target, 1, () => session.setModel(target));
    await entered.promise;
    await denied(() => session.setModel(target));
    await denied(() => session.cycleModel());
    release.resolve();
    await applying;
    expect(session.setCalls).toHaveLength(1);
  });

  test("concurrent attempts inside one callback consume only one permit before the first await", async () => {
    const lease = install();
    await lease.apply(target, 1, async () => {
      const results = await Promise.allSettled([session.setModel(target), session.setModel(target)]);
      expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
      expect(results[1]).toMatchObject({ reason: new Error(DENIED) });
    });
    expect(session.setCalls).toHaveLength(1);
  });

  test.each([false, true])("unconsumed descendant work is invalid after apply settles (failure=%s)", async fail => {
    const lease = install();
    const later = deferred();
    let descendant!: Promise<unknown>;
    const applying = lease.apply(target, 1, async () => {
      descendant = later.promise.then(() => denied(() => session.setModel(target)));
      if (fail) throw new Error("callback failed");
    });
    if (fail) await expect(applying).rejects.toThrow("callback failed");
    else await applying;
    later.resolve();
    await descendant;
    expect(session.setCalls).toEqual([]);
  });

  test("a permit used while Independent cannot later authorize a Linked call", async () => {
    const lease = install();
    policy.linked = false;
    await lease.apply(target, 1, async () => {
      await session.setModel(target);
      policy.linked = true;
      await denied(() => session.setModel(target));
    });
  });
});

describe("shared ownership and shutdown", () => {
  test("last release restores both methods; earlier and repeated releases cannot remove a newer owner", async () => {
    const old = install();
    const wrappedSet = proto.setModel;
    const current = install();
    expect(proto.setModel).toBe(wrappedSet);
    old.dispose();
    old.dispose();
    expect(old.available).toBe(false);
    expect(current.available).toBe(true);
    await denied(() => old.apply(target, 1, () => session.setModel(target)));
    await denied(() => session.setModel(target));
    current.dispose();
    expect(proto.setModel).toBe(originalSet.value);
    expect(proto.cycleModel).toBe(originalCycle.value);
    expect(Object.hasOwn(proto, STATE)).toBe(false);
    const next = install();
    old.dispose();
    current.dispose();
    await denied(() => session.cycleModel());
    await next.apply(target, 1, () => session.setModel(target));
  });

  test("retains other managers' guards and removes only the disposed owner's policy", async () => {
    const linked = install();
    const independent = install(session.sessionManager, () => ({ linked: false, revision: 8 }));
    const other = new sdk.AgentSession({});
    install(other.sessionManager);
    await denied(() => session.setModel(target));
    linked.dispose();
    await session.setModel(target);
    await denied(() => other.setModel(target));
    independent.dispose();
    await session.cycleModel();
    await denied(() => other.cycleModel());
  });

  test("an awaiting old callback cannot spend its permit after shutdown and a fresh install", async () => {
    const old = install();
    const resume = deferred();
    const applying = old.apply(target, 1, async () => {
      await resume.promise;
      await denied(() => session.setModel(target));
    });
    old.dispose();
    const current = install();
    resume.resolve();
    await applying;
    await current.apply(target, 1, () => session.setModel(target));
    expect(session.setCalls).toHaveLength(1);
  });

  test("reloads share the same guard and private permit storage across module evaluations", async () => {
    const old = install();
    const wrapped = proto.setModel;
    vi.resetModules();
    const reloaded = await import("../src/model-guard.ts");
    const current = reloaded.installModelGuard(session.sessionManager, () => policy);
    leases.push(current);
    expect(proto.setModel).toBe(wrapped);
    old.dispose();
    await current.apply(target, 1, () => session.setModel(target));
    await denied(() => session.setModel(target));
  });

  test("preserves third-party wrappers and makes retained delegates inert, including after reinstall", async () => {
    const old = install();
    const delegatedSet = proto.setModel;
    const delegatedCycle = proto.cycleModel;
    const set = vi.fn(function (this: typeof session, ...args: Parameters<typeof delegatedSet>) {
      return delegatedSet.apply(this, args);
    });
    const cycle = vi.fn(function (this: typeof session, ...args: Parameters<typeof delegatedCycle>) {
      return delegatedCycle.apply(this, args);
    });
    proto.setModel = set;
    proto.cycleModel = cycle;
    await denied(() => session.setModel(target));
    old.dispose();
    expect(proto.setModel).toBe(set);
    expect(proto.cycleModel).toBe(cycle);
    await session.setModel(target);
    await session.cycleModel();
    const current = install();
    old.dispose();
    await denied(() => session.setModel(target));
    await current.apply(target, 1, () => session.setModel(target));
    current.dispose();
    expect(proto.setModel).toBe(set);
    expect(proto.cycleModel).toBe(cycle);
    await session.setModel(target);
    expect(set).toHaveBeenCalledTimes(4);
    expect(cycle).toHaveBeenCalledOnce();
  });
});

describe("queue-preserving session pause", () => {
  test("factory capture forwards core binding unchanged and aborts directly without awaiting its own run", async () => {
    const lease = installModelGuard(undefined, () => policy);
    leases.push(lease);
    expect(lease.pauseAvailable).toBe(false);
    expect(lease.pause()).toBe(false);
    const bindings = {};
    expect(session._bindExtensionCore(bindings, 7)).toBe(bindings);
    expect(session.bindCalls).toEqual([[bindings, 7]]);
    lease.bind(session.sessionManager);
    expect(lease.pauseAvailable).toBe(true);
    const finished = deferred();
    session.waitForAbort = finished.promise;
    expect(lease.pause()).toBe(true);
    expect(session.abortCalls).toBe(1);
    finished.resolve();
    lease.dispose();
    expect(lease.pause()).toBe(false);
    expect(lease.pauseAvailable).toBe(false);
    expect(proto._bindExtensionCore).toBe(originalBind.value);
  });

  test("captures same-manager runtime replacements without lending an old lease the new session", () => {
    const old = install();
    session._bindExtensionCore({});
    old.bind(session.sessionManager);
    const replacement = new Session(session.sessionManager);
    replacement._bindExtensionCore({});
    const current = install();
    expect(old.pause()).toBe(true);
    expect(session.abortCalls).toBe(1);
    expect(replacement.abortCalls).toBe(0);
    old.dispose();
    expect(current.pause()).toBe(true);
    expect(replacement.abortCalls).toBe(1);
    expect(old.pause()).toBe(false);
  });

  test("capture is inert after disposal and preserves a third-party binding wrapper", () => {
    const lease = install();
    const delegate = proto._bindExtensionCore;
    const wrapper = vi.fn(function (this: typeof session, ...args: unknown[]) { return delegate.apply(this, args); });
    proto._bindExtensionCore = wrapper;
    lease.dispose();
    expect(proto._bindExtensionCore).toBe(wrapper);
    const args = {};
    expect(session._bindExtensionCore(args)).toBe(args);
    expect(lease.pause()).toBe(false);
    const fresh = install();
    session._bindExtensionCore(args);
    fresh.bind(session.sessionManager);
    expect(fresh.pause()).toBe(true);
    fresh.dispose();
    expect(proto._bindExtensionCore).toBe(wrapper);
  });
});

describe("unsupported adapter", () => {
  test("an absent host AgentSession export leaves the adapter unavailable", () => {
    sdk.AgentSession = undefined as unknown as typeof Session;
    expect(install().available).toBe(false);
    expect(proto.setModel).toBe(originalSet.value);
    expect(proto.cycleModel).toBe(originalCycle.value);
  });

  test("a non-extensible host prototype is not partially patched", () => {
    const unsupported = Object.preventExtensions(Object.create(null, Object.getOwnPropertyDescriptors(proto)));
    sdk.AgentSession = { prototype: unsupported } as typeof Session;
    expect(install().available).toBe(false);
    expect(unsupported.setModel).toBe(originalSet.value);
    expect(unsupported.cycleModel).toBe(originalCycle.value);
    expect(Object.hasOwn(unsupported, STATE)).toBe(false);
  });

  test.each(["setModel", "cycleModel", "_bindExtensionCore", "abort"] as const)("missing %s leaves the prototype untouched and apply unavailable", async method => {
    Reflect.deleteProperty(proto, method);
    const before = Object.getOwnPropertyDescriptors(proto);
    const lease = install();
    expect(lease.available).toBe(false);
    const run = vi.fn(async () => {});
    await expect(lease.apply(target, 1, run)).rejects.toThrow("Linked model guard is unavailable in this Pi runtime.");
    expect(run).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptors(proto)).toEqual(before);
  });

  test.each(["setModel", "cycleModel", "_bindExtensionCore"] as const)("read-only %s cannot cause a partial patch", method => {
    Object.defineProperty(proto, method, { writable: false });
    expect(install().available).toBe(false);
    expect(proto.setModel).toBe(originalSet.value);
    expect(proto.cycleModel).toBe(originalCycle.value);
    expect(Object.hasOwn(proto, STATE)).toBe(false);
  });

  test("does not invoke an unknown accessor or overwrite a foreign state marker", () => {
    const get = vi.fn(() => originalSet.value);
    Object.defineProperty(proto, "setModel", { get, configurable: true });
    expect(install().available).toBe(false);
    expect(get).not.toHaveBeenCalled();
    Object.defineProperty(proto, "setModel", originalSet);
    for (const marker of [{}, { active: true }]) {
      Object.defineProperty(proto, STATE, { value: marker, configurable: true });
      expect(install().available).toBe(false);
      expect(proto.setModel).toBe(originalSet.value);
    }
  });
});
