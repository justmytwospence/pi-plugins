import { watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { FOOTER_ACTIONS_CHANNEL, type FooterActionsRequest } from "./footer-actions.ts";
import { HERDR_BLOCKED } from "./herdr.ts";
import { createDecisionsProvider } from "./provider.ts";
import { SYSTEM1_STATE_CHANNEL, type System1StateRequest, type System1Status } from "./system1-contract.ts";
import { SYSTEM1_CHANGED, agentDir, askSystem1, readSystem1Setting, resolveSystem1Target, system1Path } from "./system1.ts";
import { DEFAULT_CLASSIFIER, inspectSystem1Status, openSystem1Picker, selectSystem1Backend } from "./ui.ts";

const record = () => Type.Record(Type.String(), Type.Unknown());
const criteria = Type.Record(Type.String(), Type.String());
const question = Type.Union([
  Type.Object({ type: Type.Literal("bool"), instructions: Type.String(), criteria: Type.Object({ true: Type.String(), false: Type.String() }) }),
  Type.Object({ type: Type.Literal("choice"), instructions: Type.String(), criteria }),
  Type.Object({ type: Type.Literal("score"), instructions: Type.String(), criteria: Type.Array(Type.String()) }),
]);
const answer = Type.Union([
  Type.Object({ type: Type.Literal("bool"), probability: Type.Number() }),
  Type.Object({ type: Type.Literal("choice"), choice: Type.String(), probabilities: Type.Record(Type.String(), Type.Number()), confidence: Type.Number() }),
  Type.Object({ type: Type.Literal("score"), score: Type.Number(), confidence: Type.Number() }),
]);
const usage = Type.Object({
  input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), totalTokens: Type.Number(),
  cost: Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), total: Type.Number() }),
});
const outputSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true), answers: Type.Record(Type.String(), answer), backend: Type.Union([Type.Literal("jev"), Type.Literal("openai-decisions")]),
    provider: Type.String(), model: Type.String(), selectionKey: Type.String(), latencyMs: Type.Number(), usage: Type.Optional(usage),
  }),
  Type.Object({ ok: Type.Literal(false), reason: Type.String(), latencyMs: Type.Number(), usage: Type.Optional(usage) }),
]);
const SUBCOMMANDS = ["status", "jev", "openai"];

export default async function system1Extension(pi: ExtensionAPI): Promise<void> {
  const provider = await createDecisionsProvider();
  if (provider) pi.registerProvider(provider);

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
  let promptDepth = 0;

  const guard = (ctx: ExtensionContext) => {
    const mine = generation;
    const manager = ctx.sessionManager;
    const id = manager.getSessionId();
    return () => {
      try { return mine === generation && !!active && active.ctx.sessionManager === manager && active.id === id && manager.getSessionId() === id; }
      catch { return false; }
    };
  };

  const refresh = async (ctx: ExtensionContext) => {
    const current = guard(ctx);
    const mine = ++revision;
    const setting = readSystem1Setting();
    settingKey = setting.key;
    const target = resolveSystem1Target(DEFAULT_CLASSIFIER, setting);
    state = target.ok
      ? { backend: target.backend, label: target.backend === "jev" ? "Jev" : "Decisions", provider: target.provider, model: target.model, availability: "unknown" }
      : { backend: "jev", label: "Jev", provider: "typesafe", model: "jev-latest", availability: "unavailable", reason: target.reason };
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
    if (debounce) clearTimeout(debounce);
    debounce = undefined;
    watcher?.close();
    watcher = undefined;
    dialogOpen = false;
    blockedDepth = 0;
    promptDepth = 0;
  };

  const open = async (ctx: ExtensionContext, backend?: "jev" | "openai-decisions") => {
    const current = guard(ctx);
    if (!current() || dialogOpen || blockedDepth || promptDepth || !ctx.isIdle()) return;
    dialogOpen = true;
    try {
      // Our whileBlocked hold accounts for one; any additional hold or native prompt
      // belongs to another dialog. Native select releases its prompt before resolving.
      const canApply = () => current() && ctx.isIdle() && blockedDepth <= 1 && promptDepth === 0;
      if (backend) await selectSystem1Backend(pi, ctx, backend, canApply);
      else await openSystem1Picker(pi, ctx, canApply);
      if (current()) await refresh(ctx);
    } finally {
      if (current()) dialogOpen = false;
    }
  };

  pi.events.on(SYSTEM1_STATE_CHANNEL, (data: unknown) => {
    const request = data as Partial<System1StateRequest> | undefined;
    // Synchronous discovery reads only this published snapshot: no filesystem or auth access.
    if (request?.version === 1 && state) request.state = { ...state };
  });
  pi.events.on(SYSTEM1_CHANGED, () => { if (active) void refresh(active.ctx); });
  pi.events.on(HERDR_BLOCKED, (data: unknown) => {
    if (!active || !data || typeof data !== "object") return;
    const held = (data as { active?: unknown }).active;
    if (held === true) blockedDepth++;
    else if (held === false) blockedDepth = Math.max(0, blockedDepth - 1);
  });
  pi.on("ui_prompt_start", () => { if (active) promptDepth++; });
  pi.on("ui_prompt_end", () => { if (active) promptDepth = Math.max(0, promptDepth - 1); });

  pi.events.on(FOOTER_ACTIONS_CHANNEL, (data: unknown) => {
    const request = data as Partial<FooterActionsRequest> | undefined;
    const ctx = active?.ctx;
    if (!ctx?.hasUI || ctx.mode !== "tui" || !request || request.version !== 1 || !request.actions || typeof request.actions !== "object" || Array.isArray(request.actions)) return;
    if (dialogOpen || blockedDepth || promptDepth || !ctx.isIdle()) return;
    const current = guard(ctx);
    request.actions["system1.open"] = {
      label: "System 1 backend", key: "/system1",
      run: async () => { if (current()) await open(ctx); },
    };
  });

  pi.registerCommand("system1", {
    description: "System 1 backend: picker, status, jev, openai",
    getArgumentCompletions: (prefix) => SUBCOMMANDS.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (!arg) return open(ctx);
      if (arg === "jev") return open(ctx, "jev");
      if (arg === "openai") return open(ctx, "openai-decisions");
      if (arg !== "status") {
        ctx.ui.notify("Use /system1, /system1 status, /system1 jev, or /system1 openai.", "warning");
        return;
      }
      const current = guard(ctx);
      const setting = readSystem1Setting();
      const status = await inspectSystem1Status(ctx.modelRegistry);
      if (!current() || readSystem1Setting().key !== setting.key) return;
      ctx.ui.notify([
        `System 1 backend: ${setting.ok ? setting.backend : "unavailable"}`,
        `Physical target: ${setting.ok ? `${status.provider}/${status.model}` : "unavailable"}`,
        `Configuration: ${system1Path()}`,
        `Local capability/auth: ${status.availability}${status.reason ? ` — ${status.reason}` : ""}`,
        "Disabled individual features stay disabled.",
        "Pro API credits: billing source not verified by Pi",
      ].join("\n"), status.availability === "unavailable" ? "warning" : "info");
    },
  });

  pi.registerTool({
    name: "system1_judge", label: "System 1 judgment",
    description: "Judge supplied evidence using the selected System 1 classifier. Accepts native bool, choice, and score questions; returns typed judgments and actual classifier provenance. Does not execute suggested actions. No provider fallback.",
    parameters: Type.Object({ state: record(), questions: Type.Record(Type.String(), question) }),
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
    async execute(_id, input, signal, _onUpdate, ctx) {
      const started = Date.now();
      const outcome = await askSystem1(ctx.modelRegistry, DEFAULT_CLASSIFIER, input.state, input.questions, signal);
      const data = outcome.ok ? outcome : { ...outcome, latencyMs: Date.now() - started };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data,
        // ClassifierUsage is structurally JSON data but its interface has no index signature.
        structuredContent: data as unknown as JsonValue,
        ...(!outcome.ok ? { isError: true } : {}),
        ...(outcome.usage ? { usage: outcome.usage } : {}),
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    stop();
    active = { ctx, id: ctx.sessionManager.getSessionId() };
    const manager = ctx.sessionManager;
    const id = manager.getSessionId();
    const owner = sessionGeneration;
    const current = () => owner === sessionGeneration && !!active && active.ctx.sessionManager === manager && active.id === id && manager.getSessionId() === id;
    // Watch the directory, not the inode: atomic setting writes replace the file.
    try {
      const owned = watch(agentDir(), (_event, filename) => {
        if (!current() || filename !== null && filename.toString() !== basename(system1Path())) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = undefined;
          if (!current()) return;
          const setting = readSystem1Setting();
          if (setting.key !== settingKey) pi.events.emit(SYSTEM1_CHANGED, { external: true });
        }, 50);
      });
      watcher = owned;
      owned.on("error", () => { owned.close(); if (watcher === owned) watcher = undefined; });
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
    if (active) { active = { ctx, id: ctx.sessionManager.getSessionId() }; await refresh(ctx); }
  });
  pi.on("agent_settled", async (_event, ctx) => { if (active) await refresh(ctx); });
  pi.on("session_shutdown", stop);
}
