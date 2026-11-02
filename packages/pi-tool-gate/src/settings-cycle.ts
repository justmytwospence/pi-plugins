import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  createSettingsCycleInput,
  type SettingCycleTrigger,
  type SettingsCycleInputPorts,
  type SettingsCycleInputStatus,
} from "./settings-cycle-input.js";

export type { SettingCycleTrigger, SettingsCycleInputPorts, SettingsCycleInputStatus } from "./settings-cycle-input.js";
export const SETTINGS_CYCLE_IDLE_MS = 1000;
export interface SettingsCycleOptions {
  inputPorts?: Partial<SettingsCycleInputPorts>;
}

export type SettingKey = "workflow" | "reasoning" | "auto-effort" | "approvals";
export type SettingValue = string | boolean;
export const SETTINGS_CYCLE_CHANNEL = "pi-plugins.settings-cycle.v1";
export const SETTINGS_REASONING_COMMITTED = "pi-plugins.settings-reasoning-committed.v1";
export type SettingCyclePhase =
  | "pending"
  | "applying"
  | "applied"
  | "unchanged"
  | "cancelled"
  | "failed"
  | "partial"
  | "interrupted";
export interface SettingCycleSnapshot {
  id: string;
  phase: SettingCyclePhase;
  settings: Array<{
    key: SettingKey;
    baseline: SettingValue;
    target: SettingValue;
    actual: SettingValue;
    label: string;
  }>;
  reason?: string;
}
export interface SettingCycleChange<T extends SettingValue> {
  key: SettingKey;
  owner: unknown;
  read(): T;
  next(value: T): T;
  format(value: T): string;
  validate(): string | undefined;
  apply(value: T, targets: Readonly<Partial<Record<SettingKey, SettingValue>>>): boolean | Promise<boolean>;
  current(): boolean;
}
export interface SettingCycles {
  stage<T extends SettingValue>(
    ctx: ExtensionContext,
    change: SettingCycleChange<T>,
    trigger?: SettingCycleTrigger,
  ): Promise<boolean>;
  captureTrigger(): SettingCycleTrigger | undefined;
  withTrigger<T>(trigger: SettingCycleTrigger, run: () => T): T;
  inputStatus(): SettingsCycleInputStatus;
  snapshot(): SettingCycleSnapshot | undefined;
  flush(): Promise<boolean>;
  cancel(reason: string): void;
  isCommitting(key: SettingKey): boolean;
  addGuard(check: () => string | undefined): () => void;
}

const order: SettingKey[] = ["workflow", "auto-effort", "reasoning", "approvals"];
const display: SettingKey[] = ["workflow", "reasoning", "auto-effort", "approvals"];
const names: Record<SettingKey, string> = {
  workflow: "Workflow",
  reasoning: "Effort",
  "auto-effort": "Auto",
  approvals: "Approvals",
};
type Change = SettingCycleChange<any>;
type Item = { change: Change; baseline: SettingValue; target: SettingValue; actual: SettingValue };
type LiveRow = {
  rowId: string;
  anchor: string | null;
  epoch: number;
  session: string;
  checkpoint: string | null;
  reusable: boolean;
  owners: Map<SettingKey, Change>;
};
type Burst = {
  token: object;
  rowId: string;
  row: LiveRow;
  checkpoint: string | null;
  ownEntries: Set<string>;
  committing: boolean;
  launched: boolean;
  inputStarted: boolean;
  activations: number;
  activatedAt: number;
  ctx: ExtensionContext;
  session: string;
  anchor: string | null;
  items: Partial<Record<SettingKey, Item>>;
  phase: SettingCyclePhase;
  model: string;
  promise: Promise<boolean>;
  resolve: (value: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
  settled: boolean;
  active?: SettingKey;
};

function copySnapshot(snapshot: SettingCycleSnapshot): SettingCycleSnapshot {
  return { ...snapshot, settings: snapshot.settings.map((item) => ({ ...item })) };
}

function validSnapshot(value: unknown): value is SettingCycleSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as SettingCycleSnapshot;
  if (
    typeof v.id !== "string" ||
    !v.id ||
    !["pending", "applying", "applied", "unchanged", "cancelled", "failed", "partial", "interrupted"].includes(
      v.phase,
    ) ||
    !Array.isArray(v.settings) ||
    (v.reason !== undefined && typeof v.reason !== "string")
  )
    return false;
  const entries = v.settings;
  return (
    entries.length > 0 &&
    new Set(entries.map((item) => item?.key)).size === entries.length &&
    entries.every(
      (item) =>
        item &&
        typeof item === "object" &&
        display.includes(item.key) &&
        [item.baseline, item.target, item.actual].every((x) => typeof x === "string" || typeof x === "boolean") &&
        typeof item.label === "string",
    )
  );
}

export function settingsCycles(pi: ExtensionAPI, options: SettingsCycleOptions = {}): SettingCycles {
  const request: { type: string; coordinator?: SettingCycles } = { type: "discover" };
  pi.events.emit(SETTINGS_CYCLE_CHANNEL, request);
  if (request.coordinator) return request.coordinator;
  const journal = new Map<string, SettingCycleSnapshot>();
  const guards = new Set<() => string | undefined>();
  let burst: Burst | undefined;
  let liveRow: LiveRow | undefined;
  let epoch = 0;
  let alive = true;
  let latest: SettingCycleSnapshot | undefined;
  let inFlight = false;
  let running: { burst: Burst; done: Promise<void> } | undefined;
  const modelIdentity = (ctx: ExtensionContext) => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");
  const leaf = (ctx: ExtensionContext) =>
    ctx.sessionManager.getLeafId?.() ?? ctx.sessionManager.getBranch().at(-1)?.id ?? null;
  const seal = () => {
    if (liveRow) liveRow.reusable = false;
  };
  const settingRecords = new Set([
    "tool-gate:workflow",
    "tool-gate:approvals",
    "tool-gate:flow",
    "tool-gate:chat-notice",
    "plan-mode:inline",
    "auto-effort:state",
    "auto-effort:manual-level",
  ]);
  // Check every append, not just the final leaf: a setter may persist its own
  // settings, but it must not hide unrelated output below the editable row.
  const checkpoint = (b: Burst) => {
    try {
      const branch = b.ctx.sessionManager.getBranch();
      const start = b.checkpoint === null ? -1 : branch.findIndex((entry) => entry.id === b.checkpoint);
      if (b.checkpoint !== null && start < 0) b.row.reusable = false;
      for (const entry of branch.slice(start + 1)) {
        if (b.ownEntries.has(entry.id)) continue;
        if (b.committing && entry.type === "custom" && settingRecords.has(entry.customType)) continue;
        if (b.active && (entry.type === "model_change" || entry.type === "thinking_level_change")) continue;
        b.row.reusable = false;
      }
      b.checkpoint = leaf(b.ctx);
    } catch {
      // Retiring session managers must not strand settlement or make a row reusable.
      b.row.reusable = false;
    }
  };
  const reconcileDeadline = (b: Burst) => {
    if (b.timer) clearTimeout(b.timer);
    b.timer = undefined;
    if (burst !== b || b.stopped || b.launched || b.phase !== "pending") return;
    if (input.status().mode === "modifier-release") return;
    b.timer = setTimeout(() => launch(b), Math.max(0, b.activatedAt + SETTINGS_CYCLE_IDLE_MS - Date.now()));
  };
  const input = createSettingsCycleInput(options.inputPorts ?? {}, {
    release: () => {
      if (burst) launch(burst);
    },
    mode: () => {
      if (burst) reconcileDeadline(burst);
    },
    cancel: (reason) => cancel(reason),
  });

  const inBranch = (b: Burst) =>
    alive &&
    b.row.epoch === epoch &&
    b.ctx.sessionManager.getSessionId() === b.session &&
    (b.anchor === null || b.ctx.sessionManager.getBranch().some((e) => e.id === b.anchor)) &&
    (b.row.anchor === null || b.ctx.sessionManager.getBranch().some((e) => e.id === b.row.anchor));
  const owned = (b: Burst) =>
    !b.stopped && inBranch(b) && Object.values(b.items).every((item) => item.change.current());
  const makeSnapshot = (b: Burst, phase: SettingCyclePhase, reason?: string): SettingCycleSnapshot => {
    const settings: SettingCycleSnapshot["settings"] = [];
    for (const key of order) {
      const item = b.items[key];
      if (!item) continue;
      let actual = item.actual;
      try {
        actual = item.change.read();
        item.actual = actual;
      } catch {
        /* Retain the last known effective value. */
      }
      let label: string;
      try {
        label = item.change.format(phase === "pending" || phase === "applying" ? item.target : actual);
      } catch {
        label = String(actual);
      }
      settings.push({ key, baseline: item.baseline, target: item.target, actual, label });
    }
    return { id: b.rowId, phase, settings, ...(reason ? { reason } : {}) };
  };
  const publish = (b: Burst, phase: SettingCyclePhase, reason?: string, anchor = false) => {
    const snapshot = makeSnapshot(b, phase, reason);
    b.phase = phase;
    if (!burst || burst === b) latest = snapshot;
    journal.set(b.rowId, snapshot);
    checkpoint(b);
    const before = b.checkpoint;
    const customType = anchor ? "settings:cycle" : "settings:cycle-state";
    pi.appendEntry(customType, { version: 1, ...copySnapshot(snapshot) });
    const branch = b.ctx.sessionManager.getBranch();
    const start = before === null ? -1 : branch.findIndex((entry) => entry.id === before);
    const entry = branch[start + 1];
    if (
      entry?.type === "custom" &&
      entry.customType === customType &&
      (entry.data as SettingCycleSnapshot | undefined)?.id === b.rowId
    ) {
      b.ownEntries.add(entry.id);
      if (anchor) b.row.anchor = entry.id;
    } else b.row.reusable = false;
    checkpoint(b);
    pi.events.emit(SETTINGS_CYCLE_CHANNEL, { type: "changed", snapshot: copySnapshot(snapshot) });
  };
  const settle = (b: Burst, value: boolean) => {
    if (b.timer) clearTimeout(b.timer);
    b.timer = undefined;
    if (!value || (b.phase !== "applied" && b.phase !== "unchanged")) b.row.reusable = false;
    checkpoint(b);
    if (value && b.row.reusable && inBranch(b)) b.row.checkpoint = b.checkpoint;
    if (burst === b) {
      burst = undefined;
      input.close();
    }
    if (!b.settled) {
      b.settled = true;
      b.resolve(value);
    }
  };
  const cancel = (reason: string) => {
    seal();
    const b = burst;
    if (b) b.stopped = true;
    input.close();
    if (!b) return;
    const canWrite = inBranch(b);
    try {
      if (canWrite) publish(b, b.phase === "applying" ? "interrupted" : "cancelled", reason);
    } catch {
      // A retiring or failed journal must not strand callers or a live timer.
    } finally {
      settle(b, false);
    }
  };
  const commit = async (b: Burst): Promise<void> => {
    if (b.timer) clearTimeout(b.timer);
    b.timer = undefined;
    if (b.phase !== "pending" || b.stopped) return;
    let applied = false;
    b.committing = true;
    inFlight = true;
    try {
      if (!owned(b)) {
        cancel("session changed");
        return;
      }
      for (const key of order) {
        const item = b.items[key];
        if (!item) continue;
        item.actual = item.change.read();
        if (item.actual !== item.baseline) {
          cancel("settings changed");
          return;
        }
        const reason = item.change.validate();
        if (!owned(b)) {
          if (burst === b) cancel("session changed");
          return;
        }
        if (reason) {
          publish(b, "failed", reason);
          settle(b, false);
          return;
        }
      }
      for (const guard of guards) {
        const reason = guard();
        if (!owned(b)) {
          if (burst === b) cancel("session changed");
          return;
        }
        if (reason) {
          publish(b, "failed", reason);
          settle(b, false);
          return;
        }
      }
      const changed = order.filter((key) => b.items[key] && b.items[key]!.baseline !== b.items[key]!.target);
      if (!changed.length) {
        publish(b, "unchanged");
        settle(b, true);
        return;
      }
      const targets: Partial<Record<SettingKey, SettingValue>> = {};
      for (const key of changed) targets[key] = b.items[key]!.target;
      publish(b, "applying");
      for (const key of changed) {
        if (!owned(b)) {
          if (burst === b) cancel("session changed");
          return;
        }
        const item = b.items[key]!;
        b.active = key;
        const ok = await item.change.apply(item.target, targets);
        checkpoint(b);
        b.active = undefined;
        if (!owned(b)) {
          if (burst === b) cancel("session changed");
          return;
        }
        item.actual = item.change.read();
        if (!ok) {
          publish(b, applied || item.actual !== item.baseline ? "partial" : "failed", `${names[key]} change failed`);
          settle(b, false);
          return;
        }
        applied = true;
      }
      publish(b, "applied");
      settle(b, true);
    } catch (error) {
      checkpoint(b);
      b.active = undefined;
      if (owned(b)) {
        const changed = Object.values(b.items).some((item) => {
          try {
            return item.change.read() !== item.baseline;
          } catch {
            return false;
          }
        });
        publish(b, applied || changed ? "partial" : "failed", error instanceof Error ? error.message : String(error));
      }
      settle(b, false);
    } finally {
      b.committing = false;
      inFlight = false;
    }
  };
  const launch = (b: Burst) => {
    if (burst !== b || b.phase !== "pending" || b.stopped || b.launched || b.settled) return;
    b.launched = true;
    input.close();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    running = { burst: b, done };
    void commit(b)
      .catch(() => settle(b, false))
      .finally(() => {
        if (running?.burst === b) running = undefined;
        finish();
      });
  };
  const service: SettingCycles = {
    stage<T extends SettingValue>(
      ctx: ExtensionContext,
      change: SettingCycleChange<T>,
      trigger?: SettingCycleTrigger,
    ): Promise<boolean> {
      if (inFlight || burst?.phase === "applying") {
        ctx.ui.notify("Wait for the current settings change to finish.", "warning");
        return Promise.resolve(false);
      }
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        seal();
        return (async () => {
          try {
            const reason = change.validate();
            if (reason || !change.current()) return false;
            const value = change.next(change.read());
            return await change.apply(value, { [change.key]: value });
          } catch {
            return false;
          }
        })();
      }
      if (burst && burst.items[change.key] && burst.items[change.key]!.change.owner !== change.owner)
        cancel("control changed");
      try {
        const reason = change.validate();
        if (reason || !change.current()) {
          if (reason) ctx.ui.notify(reason, "warning");
          return Promise.resolve(false);
        }
        if (!burst) {
          let resolve!: (value: boolean) => void;
          const promise = new Promise<boolean>((r) => {
            resolve = r;
          });
          const session = ctx.sessionManager.getSessionId();
          const branch = ctx.sessionManager.getBranch();
          const owner = liveRow?.owners.get(change.key);
          if (
            liveRow &&
            (!liveRow.reusable ||
              liveRow.epoch !== epoch ||
              liveRow.session !== session ||
              liveRow.anchor === null ||
              !branch.some((entry) => entry.id === liveRow?.anchor) ||
              leaf(ctx) !== liveRow.checkpoint ||
              (owner && owner.owner !== change.owner))
          )
            seal();
          if (!liveRow?.reusable)
            liveRow = {
              rowId: randomUUID(),
              anchor: null,
              epoch,
              session,
              checkpoint: leaf(ctx),
              reusable: true,
              owners: new Map(),
            };
          burst = {
            token: {},
            rowId: liveRow.rowId,
            row: liveRow,
            checkpoint: leaf(ctx),
            ownEntries: new Set(),
            committing: false,
            launched: false,
            inputStarted: false,
            activations: 0,
            activatedAt: Date.now(),
            ctx,
            session,
            anchor: leaf(ctx),
            items: {},
            phase: "pending",
            model: modelIdentity(ctx),
            promise,
            resolve,
            stopped: false,
            settled: false,
          };
        }
        const b = burst;
        if (!owned(b)) {
          cancel("session changed");
          return Promise.resolve(false);
        }
        const previous = b.items[change.key];
        const baseline = previous?.baseline ?? change.read();
        const target = change.next((previous?.target ?? baseline) as T);
        b.items[change.key] = { change, baseline, target, actual: previous?.actual ?? baseline };
        b.row.owners.set(change.key, change);
        b.activatedAt = Date.now();
        const activationVersion = ++b.activations;
        const activation = trigger ?? input.captureTrigger() ?? { kind: "programmatic" as const };
        const first = !journal.has(b.rowId);
        publish(b, "pending", undefined, first);
        if (first && !b.stopped && burst === b) publish(b, "pending");
        if (b.stopped || burst !== b) return b.promise;
        // A synchronous publication listener may have accepted a newer stage.
        if (b.activations === activationVersion) {
          if (!b.inputStarted) {
            b.inputStarted = true;
            input.begin(b.token, activation);
          } else input.touch(activation);
          reconcileDeadline(b);
        }
        return b.promise;
      } catch {
        if (burst) cancel("settings change failed");
        return Promise.resolve(false);
      }
    },
    captureTrigger: () => input.captureTrigger(),
    withTrigger: (trigger, run) => input.withTrigger(trigger, run),
    inputStatus: () => input.status(),
    snapshot: () => (latest ? copySnapshot(latest) : undefined),
    flush: () => {
      const b = burst;
      if (!b) return running ? running.done.then(() => false) : Promise.resolve(true);
      if (b.phase === "pending") launch(b);
      return b.promise;
    },
    cancel,
    isCommitting: (key) => burst?.phase === "applying" && burst.active === key,
    addGuard: (check) => {
      guards.add(check);
      return () => guards.delete(check);
    },
  };
  pi.events.on(SETTINGS_CYCLE_CHANNEL, (data) => {
    const r = data as typeof request;
    if (r?.type === "discover" && !r.coordinator) r.coordinator = service;
  });
  pi.registerEntryRenderer("settings:cycle", (entry, _options, theme) => {
    const initial = entry.data as unknown;
    if (!validSnapshot(initial) || (initial as SettingCycleSnapshot & { version?: number }).version !== 1)
      return undefined;
    return {
      invalidate() {},
      render(width: number) {
        const s = journal.get(initial.id) ?? initial;
        const prefix: Record<SettingCyclePhase, string> = {
          pending: "Settings pending",
          applying: "Settings applying",
          applied: "Settings",
          unchanged: "Settings unchanged",
          cancelled: "Settings cancelled",
          failed: "Settings not applied",
          partial: "Settings partially applied",
          interrupted: "Settings interrupted",
        };
        const parts = [prefix[s.phase]];
        if (
          s.phase !== "unchanged" &&
          s.phase !== "interrupted" &&
          !(s.phase === "cancelled" && s.reason === "interrupted")
        )
          for (const key of display) {
            const item = s.settings.find((value) => value.key === key);
            if (item) parts.push(`${names[key]} ${item.label}`);
          }
        if (s.reason) parts.push(s.reason);
        const line = stripVTControlCharacters(parts.join(" · ")).replace(/[\r\n\t]/gu, " ");
        return [truncateToWidth(theme.fg("dim", line), Math.max(0, width))];
      },
    };
  });
  const reconstruct = (ctx: ExtensionContext) => {
    liveRow = undefined;
    epoch++;
    journal.clear();
    latest = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type !== "custom" ||
        (entry.customType !== "settings:cycle" && entry.customType !== "settings:cycle-state")
      )
        continue;
      const data = entry.data as (SettingCycleSnapshot & { version?: number }) | undefined;
      if (!data || data.version !== 1 || !validSnapshot(data)) continue;
      if (entry.customType === "settings:cycle") {
        if (!journal.has(data.id)) journal.set(data.id, data);
      } else if (journal.has(data.id)) journal.set(data.id, data);
    }
    for (const [id, data] of journal) {
      if (data.phase === "pending")
        journal.set(id, {
          ...data,
          settings: data.settings.map((item) => ({ ...item, label: String(item.actual) })),
          phase: "cancelled",
          reason: "interrupted",
        });
      else if (data.phase === "applying")
        journal.set(id, {
          ...data,
          settings: data.settings.map((item) => ({ ...item, label: String(item.actual) })),
          phase: "interrupted",
          reason: "check current settings",
        });
    }
  };
  pi.on("session_start", (_event, ctx) => {
    cancel("session changed");
    alive = true;
    reconstruct(ctx);
    input.bind(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    cancel("session changed");
    reconstruct(ctx);
  });
  pi.on("session_before_switch", () => {
    cancel("session changed");
  });
  pi.on("session_before_fork", () => {
    cancel("session changed");
  });
  pi.on("session_before_tree", () => {
    cancel("session changed");
  });
  pi.on("session_before_compact", () => {
    cancel("compaction");
  });
  pi.on("ui_prompt_start", () => {
    cancel("dialog opened");
  });
  pi.on("session_shutdown", () => {
    seal();
    input.dispose();
    alive = false;
    if (burst) {
      burst.stopped = true;
      settle(burst, false);
    }
    guards.clear();
    journal.clear();
    latest = undefined;
  });
  pi.on("before_agent_start", () => {
    seal();
    if (burst?.phase === "pending") cancel("run started");
  });
  pi.on("message_start", () => {
    seal();
  });
  pi.on("model_select", (_event, ctx) => {
    // Shortcut contexts snapshot their model. Event contexts report the live one.
    if (!burst) seal();
    if (burst?.phase === "pending" && modelIdentity(ctx) !== burst.model) cancel("model changed");
  });
  pi.on("thinking_level_select", () => {
    if (!burst) seal();
    const item = burst?.items.reasoning;
    if (burst?.phase === "pending" && item && item.change.read() !== item.baseline) cancel("reasoning changed");
  });
  pi.on("input", async (event) => {
    seal();
    const b = burst ?? running?.burst;
    if (!b) return;
    const success = await service.flush();
    if (running?.burst === b) await running.done;
    if (success) return;
    if (inBranch(b) && journal.has(b.rowId)) {
      const previous = journal.get(b.rowId)!;
      const reason = [
        previous.reason,
        "message not sent",
        event.source === "interactive" ? "recover it from prompt history" : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      try {
        publish(b, previous.phase, reason);
      } catch {
        // Failure to record the diagnostic must not let the rejected input run.
      }
    }
    return { action: "handled" as const };
  });
  return service;
}
