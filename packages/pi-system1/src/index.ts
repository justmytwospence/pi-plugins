import { watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { FOOTER_ACTIONS_CHANNEL, type FooterActionsRequest } from "./footer-actions.ts";
import { HERDR_BLOCKED } from "./herdr.ts";
import { createDecisionsProvider } from "./provider.ts";
import { SYSTEM1_STATE_CHANNEL, type System1StateRequest, type System1Status } from "./system1-contract.ts";
import {
  SYSTEM1_CHANGED,
  agentDir,
  askSystem1,
  getSystem1RuntimeSnapshot,
  installSystem1Notifications,
  readSystem1Setting,
  resetSystem1Runtime,
  resolveSystem1Route,
  subscribeSystem1Events,
  system1Path,
  type System1Backend,
} from "./system1.ts";
import {
  DEFAULT_CLASSIFIER,
  inspectSystem1Status,
  openSystem1Picker,
  selectSystem1Waterfall,
  system1Label,
  system1OrderLabel,
} from "./ui.ts";

const record = () => Type.Record(Type.String(), Type.Unknown());
const criteria = Type.Record(Type.String(), Type.String());
const question = Type.Union([
  Type.Object({
    type: Type.Literal("bool"),
    instructions: Type.String(),
    criteria: Type.Object({ true: Type.String(), false: Type.String() }),
  }),
  Type.Object({ type: Type.Literal("choice"), instructions: Type.String(), criteria }),
  Type.Object({ type: Type.Literal("score"), instructions: Type.String(), criteria: Type.Array(Type.String()) }),
]);
const answer = Type.Union([
  Type.Object({ type: Type.Literal("bool"), probability: Type.Number() }),
  Type.Object({
    type: Type.Literal("choice"),
    choice: Type.String(),
    probabilities: Type.Optional(Type.Record(Type.String(), Type.Number())),
    confidence: Type.Number(),
  }),
  Type.Object({ type: Type.Literal("score"), score: Type.Number(), confidence: Type.Number() }),
]);
const usage = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  totalTokens: Type.Number(),
  cost: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    total: Type.Number(),
  }),
});
const backendSchema = Type.Union([Type.Literal("jev"), Type.Literal("openai-decisions")]);
const failureCode = Type.Union(
  [
    "disabled",
    "cancelled",
    "selection_changed",
    "invalid_input",
    "refused",
    "missing_credentials",
    "invalid_credentials",
    "quota_exhausted",
    "rate_limited",
    "unavailable_model",
    "timeout",
    "invalid_answers",
    "provider_error",
    "exhausted",
  ].map((value) => Type.Literal(value)),
);
const attempt = Type.Object({
  backend: backendSchema,
  provider: Type.String(),
  model: Type.String(),
  targetKey: Type.String(),
  status: Type.Union(["failed", "succeeded", "cooldown", "probing"].map((value) => Type.Literal(value))),
  code: Type.Optional(failureCode),
  reason: Type.Optional(Type.String()),
  latencyMs: Type.Number(),
  retryAt: Type.Optional(Type.Number()),
  sdkCalls: Type.Number(),
  usage: Type.Optional(usage),
});
const outputSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    answers: Type.Record(Type.String(), answer),
    backend: backendSchema,
    provider: Type.String(),
    model: Type.String(),
    waterfall: Type.Array(backendSchema),
    selectionKey: Type.String(),
    targetKey: Type.String(),
    fallback: Type.Boolean(),
    attempts: Type.Array(attempt),
    latencyMs: Type.Number(),
    usage: Type.Optional(usage),
  }),
  Type.Object({
    ok: Type.Literal(false),
    code: failureCode,
    reason: Type.String(),
    attempts: Type.Array(attempt),
    latencyMs: Type.Number(),
    usage: Type.Optional(usage),
  }),
]);
const SUBCOMMANDS = ["status", "jev", "openai", "order", "retry"];
const USAGE =
  "Use /system1, /system1 status, /system1 jev, /system1 openai, /system1 order jev openai, or /system1 retry.";

export default async function system1Extension(pi: ExtensionAPI): Promise<void> {
  const provider = await createDecisionsProvider();
  if (provider) pi.registerProvider(provider);
  installSystem1Notifications(pi, { priority: 100 });

  let unsubscribeRuntime: (() => void) | undefined;
  let active: { ctx: ExtensionContext; id: string } | undefined;
  let generation = 0;
  let sessionGeneration = 0;
  let revision = 0;
  let state: System1Status | undefined;
  let settingKey: string | undefined;
  let watcher: FSWatcher | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let dialogOpen = false;
  let blockedDepth = 0;
  // Counts foreign prompts only. Pi delivers native prompt-end events asynchronously,
  // so our own select may have resolved before its end event reaches this extension.
  let promptDepth = 0;
  const ownedPromptTitles = new Set<string>();
  const ownsPrompt = (event: { kind?: string; title?: string }) =>
    event.kind === "select" && typeof event.title === "string" && ownedPromptTitles.has(event.title);

  const guard = (ctx: ExtensionContext) => {
    const mine = generation;
    const manager = ctx.sessionManager;
    const id = manager.getSessionId();
    return () => {
      try {
        return (
          mine === generation &&
          !!active &&
          active.ctx.sessionManager === manager &&
          active.id === id &&
          manager.getSessionId() === id
        );
      } catch {
        return false;
      }
    };
  };

  const refresh = async (ctx: ExtensionContext) => {
    const current = guard(ctx);
    if (!current()) return;
    const mine = ++revision;
    const setting = readSystem1Setting();
    settingKey = setting.key;
    const route = resolveSystem1Route(DEFAULT_CLASSIFIER, setting);
    state = route.ok
      ? {
          waterfall: [...route.waterfall],
          candidates: route.targets.map((target) => ({ ...target, local: "unknown" as const })),
          status: "unknown",
        }
      : { waterfall: [], candidates: [], status: "unavailable" };
    const inspected = await inspectSystem1Status(ctx.modelRegistry);
    if (current() && revision === mine && readSystem1Setting().key === setting.key) state = inspected;
  };

  const stop = () => {
    generation++;
    sessionGeneration++;
    revision++;
    active = undefined;
    state = undefined;
    settingKey = undefined;
    unsubscribeRuntime?.();
    unsubscribeRuntime = undefined;
    if (debounce) clearTimeout(debounce);
    debounce = undefined;
    watcher?.close();
    watcher = undefined;
    dialogOpen = false;
    blockedDepth = 0;
    promptDepth = 0;
    ownedPromptTitles.clear();
  };

  const open = async (ctx: ExtensionContext, action?: readonly System1Backend[] | "retry") => {
    const current = guard(ctx);
    if (!current()) return;
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the current turn to finish before changing System 1 or resetting cooldowns.", "warning");
      return;
    }
    if (dialogOpen || blockedDepth || promptDepth) return;
    if (action === "retry") {
      resetSystem1Runtime(ctx.modelRegistry);
      pi.events.emit(SYSTEM1_CHANGED, { reset: true });
      ctx.ui.notify("System 1 cooldowns reset; the next judgment retries the configured order.", "info");
      await refresh(ctx);
      return;
    }
    dialogOpen = true;
    const ui = ctx.ui;
    const pickerCtx: ExtensionContext = Object.create(ctx);
    Object.defineProperty(pickerCtx, "ui", {
      value: {
        ...ui,
        select: (...args: Parameters<typeof ui.select>) => {
          // Record ownership before Pi queues ui_prompt_start. Retain these bounded
          // picker/confirmation titles until shutdown so late end events stay owned.
          ownedPromptTitles.add(args[0]);
          return ui.select(...args);
        },
      },
    });
    try {
      // Our whileBlocked hold accounts for one; foreign holds/prompts still cancel.
      const canApply = () => current() && ctx.isIdle() && blockedDepth <= 1 && promptDepth === 0;
      if (action) await selectSystem1Waterfall(pi, pickerCtx, action, canApply);
      else await openSystem1Picker(pi, pickerCtx, canApply);
      if (current()) await refresh(ctx);
    } finally {
      if (current()) dialogOpen = false;
    }
  };

  pi.events.on(SYSTEM1_STATE_CHANNEL, (data: unknown) => {
    const request = data as Partial<System1StateRequest> | undefined;
    // Synchronous discovery reads only this published snapshot: no filesystem or auth access.
    if (request?.version === 1 && state) request.state = structuredClone(state);
  });
  pi.events.on(SYSTEM1_CHANGED, () => {
    if (active) void refresh(active.ctx);
  });
  pi.events.on(HERDR_BLOCKED, (data: unknown) => {
    if (!active || !data || typeof data !== "object") return;
    const held = (data as { active?: unknown }).active;
    if (held === true) blockedDepth++;
    else if (held === false) blockedDepth = Math.max(0, blockedDepth - 1);
  });
  pi.on("ui_prompt_start", (event) => {
    if (active && !ownsPrompt(event)) promptDepth++;
  });
  pi.on("ui_prompt_end", (event) => {
    if (active && !ownsPrompt(event)) promptDepth = Math.max(0, promptDepth - 1);
  });

  pi.events.on(FOOTER_ACTIONS_CHANNEL, (data: unknown) => {
    const request = data as Partial<FooterActionsRequest> | undefined;
    const ctx = active?.ctx;
    if (
      !ctx?.hasUI ||
      ctx.mode !== "tui" ||
      !request ||
      request.version !== 1 ||
      !request.actions ||
      typeof request.actions !== "object" ||
      Array.isArray(request.actions)
    )
      return;
    if (dialogOpen || blockedDepth || promptDepth || !ctx.isIdle()) return;
    const current = guard(ctx);
    request.actions["system1.open"] = {
      label: "System 1 order",
      key: "/system1",
      run: async () => {
        if (current()) await open(ctx);
      },
    };
  });

  pi.registerCommand("system1", {
    description: "System 1 order: picker, status, jev, openai, order, retry",
    getArgumentCompletions: (prefix) =>
      SUBCOMMANDS.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (!arg) return open(ctx);
      if (arg === "jev") return open(ctx, ["jev"]);
      if (arg === "openai") return open(ctx, ["openai-decisions"]);
      if (arg === "retry") return open(ctx, "retry");
      const words = arg.split(/\s+/u);
      if (words[0] === "order") {
        const waterfall = words.slice(1).map((value) => (value === "openai" ? "openai-decisions" : value));
        if (
          waterfall.length > 0 &&
          waterfall.every((value) => value === "jev" || value === "openai-decisions") &&
          new Set(waterfall).size === waterfall.length
        ) {
          return open(ctx, waterfall as System1Backend[]);
        }
      }
      if (arg !== "status") {
        ctx.ui.notify(USAGE, "warning");
        return;
      }
      const current = guard(ctx);
      const setting = readSystem1Setting();
      const status = await inspectSystem1Status(ctx.modelRegistry);
      if (!current() || readSystem1Setting().key !== setting.key) return;
      const runtime = getSystem1RuntimeSnapshot(ctx.modelRegistry, DEFAULT_CLASSIFIER);
      const now = Date.now();
      ctx.ui.notify(
        [
          `System 1 order: ${setting.ok ? system1OrderLabel(setting.waterfall) : "unavailable"}`,
          ...(setting.ok ? [] : [setting.reason]),
          `Configuration: ${system1Path()}`,
          ...status.candidates.map(
            (candidate) =>
              `${system1Label(candidate.backend)}: ${candidate.provider}/${candidate.model}; local: ${candidate.local}${candidate.cooldownUntil && candidate.cooldownUntil > now ? `; cooldown: ${Math.ceil((candidate.cooldownUntil - now) / 1000)}s remaining` : ""}${candidate.lastFailure ? `; last failure: ${candidate.lastFailure.code}` : ""}`,
          ),
          status.lastUsed
            ? `Last main-registry route: ${system1Label(status.lastUsed.backend)}${status.lastUsed.fallback ? "* (fallback)" : ""} — ${status.lastUsed.provider}/${status.lastUsed.model}`
            : "Last main-registry route: unknown",
          ...(runtime.lastOutcome?.attempts
            .filter((attempt) => attempt.status !== "succeeded")
            .map(
              (attempt) =>
                `Attempt ${system1Label(attempt.backend)}: ${attempt.status}; ${attempt.code ?? "pending"}${attempt.reason ? ` — ${attempt.reason}` : ""}`,
            ) ?? []),
          ...(status.nextRetryAt === undefined
            ? []
            : [`Next retry eligible: ${new Date(status.nextRetryAt).toISOString()}`]),
          "Retry scope: this Pi process and its in-process views only; no background probes.",
          "Disabled individual features stay disabled.",
          "Pro API credits: billing source not verified by Pi",
        ].join("\n"),
        status.status === "unavailable" ? "warning" : "info",
      );
    },
  });

  pi.registerTool({
    name: "system1_judge",
    label: "System 1 judgment",
    description:
      "Judge supplied evidence using the configured native System 1 waterfall. Operational failures may advance to the next configured backend; valid judgments and safety refusals do not. Accepts native bool, choice, and score questions and returns actual winner, fallback, attempts and reported usage. Does not execute suggested actions.",
    parameters: Type.Object({ state: record(), questions: Type.Record(Type.String(), question) }),
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
    async execute(_id, input, signal, _onUpdate, ctx) {
      const data = await askSystem1(ctx.modelRegistry, DEFAULT_CLASSIFIER, input.state, input.questions, signal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        details: data,
        // ClassifierUsage is structurally JSON data but its interface has no index signature.
        structuredContent: data as unknown as JsonValue,
        ...(!data.ok ? { isError: true } : {}),
        ...(data.usage ? { usage: data.usage } : {}),
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    stop();
    active = { ctx, id: ctx.sessionManager.getSessionId() };
    unsubscribeRuntime = subscribeSystem1Events(() => {
      if (active?.ctx.modelRegistry === ctx.modelRegistry) void refresh(active.ctx);
    }, ctx.modelRegistry);
    const manager = ctx.sessionManager;
    const id = manager.getSessionId();
    const owner = sessionGeneration;
    const current = () =>
      owner === sessionGeneration &&
      !!active &&
      active.ctx.sessionManager === manager &&
      active.id === id &&
      manager.getSessionId() === id;
    // Watch the directory, not the inode: atomic setting writes replace the file.
    try {
      const owned = watch(agentDir(), (_event, filename) => {
        if (!current() || (filename !== null && filename.toString() !== basename(system1Path()))) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = undefined;
          if (!current()) return;
          const setting = readSystem1Setting();
          if (setting.key !== settingKey) pi.events.emit(SYSTEM1_CHANGED, { external: true });
        }, 50);
      });
      watcher = owned;
      owned.on("error", () => {
        owned.close();
        if (watcher === owned) watcher = undefined;
      });
      owned.unref();
    } catch {
      // Read-per-request remains authoritative if the directory cannot be watched.
    }
    await refresh(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    generation++;
    dialogOpen = false;
    // The directory watch belongs to the session, not its selected tree branch.
    if (active) {
      active = { ctx, id: ctx.sessionManager.getSessionId() };
      unsubscribeRuntime?.();
      unsubscribeRuntime = subscribeSystem1Events(() => {
        if (active?.ctx.modelRegistry === ctx.modelRegistry) void refresh(active.ctx);
      }, ctx.modelRegistry);
      await refresh(ctx);
    }
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (active) await refresh(ctx);
  });
  pi.on("session_shutdown", stop);
}
