import { AsyncLocalStorage } from "node:async_hooks";
import * as hostSdk from "@earendil-works/pi-coding-agent";

const STATE = Symbol.for("pi-plugins.linked-model-guard.v1");
const DENIED = "Linked mode chooses the model for this workflow. Use /flow independent to choose a model.";
const UNAVAILABLE = "Linked model guard is unavailable in this Pi runtime.";

type Target = { provider: string; id: string };
type Policy = () => { linked: boolean; revision: number };

export interface ModelGuardLease {
  readonly available: boolean;
  readonly pauseAvailable: boolean;
  /** Bind at session_start, after the factory-installed capture saw the host session. */
  bind(manager: object): void;
  /** Signal abort synchronously; never await idle from inside a running hook. */
  pause(): boolean;
  apply<T>(target: Target, revision: number, run: () => Promise<T>): Promise<T>;
  dispose(): void;
}

type SetModel = hostSdk.AgentSession["setModel"];
type CycleModel = hostSdk.AgentSession["cycleModel"];
// Maintained private capture point: called with the real session on construction AND
// reload, after factories load and before session_start (SDK 1.2/1.4). No core/UI
// bindings are changed; the original receives its exact receiver and arguments.
type BindCore = (this: hostSdk.AgentSession, ...args: unknown[]) => unknown;
interface State {
  active: boolean;
  capturesSessions: true;
  acquire(manager: object | undefined, policy: Policy): ModelGuardLease;
}
type Prototype = { setModel: SetModel; cycleModel: CycleModel; _bindExtensionCore: BindCore; abort: hostSdk.AgentSession["abort"]; [STATE]?: State };
interface Permit {
  manager: object;
  owner: symbol;
  provider: string;
  id: string;
  revision: number;
  live: boolean;
  used: boolean;
}

function unavailable(): ModelGuardLease {
  return {
    available: false,
    pauseAvailable: false,
    bind() {},
    pause() { return false; },
    async apply() { throw new Error(UNAVAILABLE); },
    dispose() {},
  };
}

/**
 * Maintained adapter for setModel/cycleModel plus _bindExtensionCore capture and
 * the public abort API (tested through native TUI on SDK 1.2/1.4). Install in the
 * factory with no manager, then bind in session_start. Direct abort preserves
 * accepted custom queues; ctx.abort in TUI instead clears them into the editor.
 * Maintained coverage: test/model-guard.test.ts (lease/capture/cleanup) and
 * scripts/test-linked-flow.mjs (both SDK loaders, actual native TUI binding and
 * abort paths, multiple accepted custom queues, zero transport calls, recovery).
 * Missing capture refuses Linked activation; restored Linked remains blocked.
 * This is not a sandbox against arbitrary in-process state/prototype mutation.
 * The bare SDK import is intentional: Pi aliases it to the host, including in
 * bundled runtimes. Never resolve this package's development SDK here.
 * Initial construction/restoration and direct agent-state writes are outside
 * this boundary; the flow coordinator must reconcile those separately.
 */
export function installModelGuard(manager: object | undefined, policy: Policy): ModelGuardLease {
  const proto = hostSdk.AgentSession?.prototype as unknown as Prototype | undefined;
  if (!proto) return unavailable();
  const setter = Object.getOwnPropertyDescriptor(proto, "setModel");
  const cycler = Object.getOwnPropertyDescriptor(proto, "cycleModel");
  const binder = Object.getOwnPropertyDescriptor(proto, "_bindExtensionCore");
  const aborter = Object.getOwnPropertyDescriptor(proto, "abort");
  // Do not install half a guard or invoke an unknown accessor-based adapter.
  if (!setter?.writable || typeof setter.value !== "function" ||
      !cycler?.writable || typeof cycler.value !== "function" ||
      !binder?.writable || typeof binder.value !== "function" ||
      typeof aborter?.value !== "function") return unavailable();
  const state = proto[STATE];
  if (state?.active) return state.capturesSessions === true && typeof state.acquire === "function" ? state.acquire(manager, policy) : unavailable();
  if (!Object.isExtensible(proto) || Object.hasOwn(proto, STATE)) return unavailable();

  const originalSet: SetModel = setter.value;
  const originalCycle: CycleModel = cycler.value;
  const originalBind: BindCore = binder.value;
  const originalAbort: hostSdk.AgentSession["abort"] = aborter.value;
  const sessions = new WeakMap<object, WeakRef<hostSdk.AgentSession>>();
  // Only weak keys retain manager/policy pairs. The global owner set deliberately
  // holds tokens, not leases or callbacks that could keep dead sessions alive.
  const managers = new WeakMap<object, Map<symbol, Policy>>();
  const owners = new Set<symbol>();
  // Neither this storage nor a permit is exported or published on an event bus.
  // Keeping it inside shared state closures also works across module reloads.
  const permits = new AsyncLocalStorage<Permit>();

  function authorize(manager: object, target?: Target): void {
    const permit = permits.getStore();
    const unused = permit?.live && !permit.used;
    // Consume at entry, before calling a policy or the async SDK original. A
    // failed/mismatched attempt also cannot retry or lend the permit to a hook.
    if (permit) permit.used = true;
    const policies = managers.get(manager);
    if (!policies) return;
    const snapshots = new Map([...policies].map(([owner, read]) => [owner, read()]));
    if (![...snapshots.values()].some(snapshot => snapshot.linked)) return;
    if (!target || !unused || !permit || permit.manager !== manager ||
        !owners.has(permit.owner) || !snapshots.has(permit.owner) ||
        snapshots.get(permit.owner)!.revision !== permit.revision ||
        target.provider !== permit.provider || target.id !== permit.id) throw new Error(DENIED);
  }

  const wrappedSet: SetModel = async function (this: hostSdk.AgentSession, ...args) {
    if (shared.active) authorize(this.sessionManager, args[0]);
    return originalSet.apply(this, args);
  };
  const wrappedCycle: CycleModel = async function (this: hostSdk.AgentSession, ...args) {
    // Cycling is never an authorized flow application, even inside apply().
    if (shared.active) authorize(this.sessionManager);
    return originalCycle.apply(this, args);
  };

  const wrappedBind: BindCore = function (...args) {
    if (shared.active) sessions.set(this.sessionManager, new WeakRef(this));
    return originalBind.apply(this, args);
  };

  const shared: State = {
    active: true,
    capturesSessions: true,
    acquire(manager, policy) {
      const owner = Symbol();
      let boundManager: object | undefined;
      let session: WeakRef<hostSdk.AgentSession> | undefined;
      let policies: Map<symbol, Policy> | undefined;
      const bind = (next: object) => {
        if (!shared.active || !owners.has(owner)) return;
        policies?.delete(owner);
        if (boundManager && !policies?.size) managers.delete(boundManager);
        boundManager = next;
        policies = managers.get(next);
        if (!policies) managers.set(next, policies = new Map());
        policies.set(owner, policy);
        session = sessions.get(next);
      };
      owners.add(owner);
      if (manager) bind(manager);
      return {
        get available() { return shared.active && owners.has(owner); },
        get pauseAvailable() { return shared.active && owners.has(owner) && !!session?.deref(); },
        bind,
        pause() {
          const current = session?.deref();
          if (!shared.active || !owners.has(owner) || !current) return false;
          // abort signals before its first await. Awaiting it here deadlocks a hook
          // on its own run. No TUI binding, clearQueue, or editor path is invoked.
          void originalAbort.call(current).catch(() => {});
          return true;
        },
        async apply(target, revision, run) {
          if (!shared.active || !owners.has(owner) || !boundManager || policies?.get(owner)?.().revision !== revision) {
            throw new Error(DENIED);
          }
          const permit: Permit = { manager: boundManager, owner, provider: target.provider, id: target.id, revision, live: true, used: false };
          return permits.run(permit, async () => {
            try { return await run(); }
            finally { permit.live = false; }
          });
        },
        dispose() {
          if (!owners.delete(owner)) return;
          policies?.delete(owner);
          if (boundManager && !policies?.size) managers.delete(boundManager);
          session = undefined;
          if (owners.size) return;
          shared.active = false; // A third-party wrapper may retain our delegate.
          permits.disable();
          if (proto.setModel === wrappedSet) proto.setModel = originalSet;
          if (proto.cycleModel === wrappedCycle) proto.cycleModel = originalCycle;
          if (proto._bindExtensionCore === wrappedBind) proto._bindExtensionCore = originalBind;
          if (proto[STATE] === shared) delete proto[STATE];
        },
      };
    },
  };
  proto.setModel = wrappedSet;
  proto.cycleModel = wrappedCycle;
  proto._bindExtensionCore = wrappedBind;
  Object.defineProperty(proto, STATE, { value: shared, configurable: true });
  return shared.acquire(manager, policy);
}
