// Side conversations adapted from pi-btw 0.6.1 (MIT, Dan Bachelder).
// Persisted entry names and payloads are upstream-compatible. See ../UPSTREAM.json.
import {
  createAgentSession,
  getMarkdownTheme,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, type OverlayHandle, type OverlayOptions } from "@earendil-works/pi-tui";
import { requestEditorFactory } from "./contract.ts";
import { BTW_FOCUS_SHORTCUTS, BTW_FOCUS_SHORTCUTS_LABEL, BTW_WIDTH_TOGGLE_SHORTCUT } from "./focus-keys.ts";
import { BtwOverlayComponent, type BtwOverlayWidthMode } from "./overlay.ts";
import { createBtwModelRuntimeOptions, createBtwResourceLoader, hasUsableModelAuth } from "./session.ts";
import {
  BTW_ENTRY_TYPE, BTW_MESSAGE_TYPE, BTW_MODEL_OVERRIDE_TYPE, BTW_RESET_TYPE,
  BTW_SUMMARIZE_SYSTEM_PROMPT, BTW_THINKING_OVERRIDE_TYPE, BTW_TOOLS_BY_MODE,
  buildBtwMessageContent, buildBtwSeedState, extractAnswer, extractBtwHandoffThread,
  extractThinking, formatModelRef, formatThread, getLastAssistantMessage,
  isCustomEntry, isVisibleBtwMessage, parseBtwArgs, parseBtwModelArgs, parseBtwThinkingArgs,
  type BtwDetails, type BtwHandoffExchange, type BtwModelOverrideDetails, type BtwResetDetails,
  type BtwThinkingOverrideDetails, type BtwThreadMode, type ResolvedBtwSettings,
  type SaveState, type SessionModel, type SessionThinkingLevel,
} from "./thread.ts";
import {
  appendPersistedTranscriptTurn, applyTranscriptEvent, createEmptyTranscriptState,
  findLatestTranscriptEntry, finishTranscriptTurn, setTranscriptFailure,
} from "./transcript.ts";

type UiContext = ExtensionContext | ExtensionCommandContext;
export type BtwSessionRuntime = {
  session: AgentSession;
  mode: BtwThreadMode;
  generation: number;
  settings: ResolvedBtwSettings;
  subscriptions: Set<() => void>;
  sideThreadStartIndex: number;
  abortPromise?: Promise<void>;
  disposePromise?: Promise<void>;
};
type OverlayRuntime = {
  handle?: OverlayHandle;
  component?: BtwOverlayComponent;
  refresh?: () => void;
  close: () => void;
  closed: boolean;
};
class StaleBtwOperation extends Error {}

/** Names Pi gives to a command registered more than once: btw:1, btw:ask:2, ... */
export function duplicateBtwCommands(commands: ReadonlyArray<{ name: string; source?: string }>): string[] {
  return commands
    .filter((command) => (command.source === undefined || command.source === "extension") && /^(?:btw|side)(?::[a-z]+)?:\d+$/.test(command.name))
    .map((command) => command.name);
}

function notify(ctx: UiContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}
function canRenderBtwOverlay(ctx: UiContext): boolean {
  return ctx.hasUI && ctx.mode === "tui";
}

export default function (pi: ExtensionAPI) {
  let pendingThread: BtwDetails[] = [];
  let pendingMode: BtwThreadMode = "contextual";
  let btwModelOverride: SessionModel | null = null;
  let btwThinkingOverride: SessionThinkingLevel | null = null;
  let transcriptState = createEmptyTranscriptState();
  let overlayStatus: string | null = null;
  let overlayDraft = "";
  let overlayWidthMode: BtwOverlayWidthMode = "window";
  let overlayRuntime: OverlayRuntime | null = null;
  let lastUiContext: UiContext | null = null;
  let activeBtwSession: BtwSessionRuntime | null = null;
  let creatingBtwSession: { generation: number; promise: Promise<BtwSessionRuntime> } | null = null;
  const summarySessions = new Set<BtwSessionRuntime>();
  let btwLifecycleGeneration = 0;
  let btwSubmissionQueue = Promise.resolve();

  function checkCurrent(generation: number): void {
    if (generation !== btwLifecycleGeneration) throw new StaleBtwOperation();
  }
  function syncUi(ctx: UiContext | null = lastUiContext): void {
    if (ctx?.hasUI) {
      ctx.ui.setWidget("btw", undefined);
      overlayRuntime?.refresh?.();
    }
  }
  function setOverlayStatus(status: string | null, ctx?: UiContext): void {
    overlayStatus = status;
    syncUi(ctx);
  }
  function setOverlayDraft(value: string): void {
    overlayDraft = value;
    overlayRuntime?.component?.setDraft(value);
  }
  function dismissOverlay(): void {
    const runtime = overlayRuntime;
    if (runtime) runtime.close();
  }
  function toggleOverlayFocus(): void {
    const runtime = overlayRuntime;
    const handle = runtime?.handle;
    if (!handle) return;
    handle.setHidden(false);
    if (handle.isFocused()) handle.unfocus();
    else handle.focus();
    runtime.refresh?.();
  }
  function getOverlayOptions(): OverlayOptions {
    const base: OverlayOptions = { minWidth: 72, maxHeight: "78%", anchor: "top-center", nonCapturing: true };
    return overlayWidthMode === "full"
      ? { ...base, width: "100%", margin: { top: 1 } }
      : { ...base, width: "78%", margin: { top: 1, left: 2, right: 2 } };
  }
  function toggleOverlayWidth(ctx: UiContext): void {
    const wasFocused = overlayRuntime?.handle?.isFocused() ?? true;
    overlayWidthMode = overlayWidthMode === "window" ? "full" : "window";
    dismissOverlay();
    ensureOverlay(ctx, btwLifecycleGeneration, wasFocused);
    setOverlayStatus(overlayWidthMode === "full"
      ? "Full-width mode. Alt+w restores the window."
      : "Window mode. Alt+w switches to full-width for copy selection.", ctx);
  }

  function clearBtwSessionSubscriptions(runtime: BtwSessionRuntime): void {
    for (const unsubscribe of runtime.subscriptions) {
      runtime.subscriptions.delete(unsubscribe);
      try { unsubscribe(); } catch { /* Already unsubscribed. */ }
    }
  }
  function handleBtwSessionEvent(runtime: BtwSessionRuntime, event: AgentSessionEvent): void {
    if (activeBtwSession !== runtime || runtime.generation !== btwLifecycleGeneration) return;
    // Collect events even without a mounted overlay (RPC/SDK or a width remount).
    applyTranscriptEvent(transcriptState, event);
    if (event.type === "tool_execution_start") overlayStatus = `Running tool: ${event.toolName}`;
    else if (event.type === "tool_execution_end" || event.type === "turn_end") overlayStatus = "Streaming...";
    syncUi();
  }
  function requestBtwSessionAbort(runtime: BtwSessionRuntime): Promise<void> {
    runtime.abortPromise ??= Promise.resolve().then(() => runtime.session.abort()).catch(() => {});
    return runtime.abortPromise;
  }
  function disposeRuntime(runtime: BtwSessionRuntime): Promise<void> {
    runtime.disposePromise ??= (async () => {
      clearBtwSessionSubscriptions(runtime);
      try { await requestBtwSessionAbort(runtime); }
      finally {
        try { runtime.session.dispose(); } catch { /* Cleanup is idempotent even if a host hook failed. */ }
      }
    })();
    return runtime.disposePromise;
  }
  function disposeBtwSession(): Promise<void> {
    // Detach synchronously. Cleanup after await can only affect the captured child.
    const current = activeBtwSession;
    activeBtwSession = null;
    return current ? disposeRuntime(current) : Promise.resolve();
  }
  function invalidateBtwLifecycle(): number {
    ++btwLifecycleGeneration;
    // A cancelled slow factory/prompt must not block the new generation's queue.
    btwSubmissionQueue = Promise.resolve();
    creatingBtwSession = null;
    dismissOverlay();
    for (const runtime of summarySessions) void disposeRuntime(runtime).catch(() => {});
    return btwLifecycleGeneration;
  }
  async function dismissOrAbortOverlaySession(): Promise<void> {
    const generation = btwLifecycleGeneration;
    const runtime = activeBtwSession;
    const summary = [...summarySessions].find((item) => item.generation === generation);
    const running = runtime?.session.isStreaming ? runtime : summary;
    if (running && !running.abortPromise) {
      setOverlayStatus("Aborting. Press Esc again to dismiss the BTW overlay.");
      await requestBtwSessionAbort(running);
      if (generation === btwLifecycleGeneration && overlayRuntime) {
        setOverlayStatus("Aborted. Press Esc again to dismiss the BTW overlay.");
      }
      return;
    }
    invalidateBtwLifecycle();
    await disposeBtwSession();
  }

  // Serialize both prompts and handoffs. Clear/new/tree/overrides invalidate the queue
  // instead of waiting on it, and stale work never touches a newer generation.
  async function enqueueBtw(generation: number, action: () => Promise<void>): Promise<void> {
    const submission = btwSubmissionQueue.then(async () => {
      checkCurrent(generation);
      await action();
    });
    btwSubmissionQueue = submission.catch(() => {});
    await submission;
  }
  function runUiAction(ctx: UiContext, action: () => Promise<void>): void {
    const generation = btwLifecycleGeneration;
    void action().catch((error) => {
      if (!(error instanceof StaleBtwOperation) && generation === btwLifecycleGeneration) {
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    });
  }

  async function resolveBtwSettings(ctx: ExtensionCommandContext, generation: number, warn = false): Promise<ResolvedBtwSettings> {
    checkCurrent(generation);
    const configuredModelOverride = btwModelOverride;
    const thinkingLevel = btwThinkingOverride ?? pi.getThinkingLevel();
    const thinkingSource = btwThinkingOverride ? "override" : "main";
    if (configuredModelOverride) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(configuredModelOverride);
      checkCurrent(generation);
      if (hasUsableModelAuth(ctx, configuredModelOverride, auth)) {
        return { model: configuredModelOverride, modelSource: "override", configuredModelOverride, thinkingLevel, thinkingSource };
      }
      const fallbackReason = ctx.model
        ? `Configured BTW model ${formatModelRef(configuredModelOverride)} has no credentials. Falling back to main model ${formatModelRef(ctx.model)}.`
        : `Configured BTW model ${formatModelRef(configuredModelOverride)} has no credentials, and no main model is active.`;
      if (warn) notify(ctx, fallbackReason, "warning");
      return { model: ctx.model ?? null, modelSource: ctx.model ? "main" : "none", configuredModelOverride, thinkingLevel, thinkingSource, fallbackReason };
    }
    return { model: ctx.model ?? null, modelSource: ctx.model ? "main" : "none", configuredModelOverride: null, thinkingLevel, thinkingSource };
  }
  function describeResolvedModel(settings: ResolvedBtwSettings): string {
    if (!settings.model) return `BTW model unavailable. ${settings.fallbackReason ?? "No active model selected."}`;
    const source = settings.modelSource === "override" ? "override" : settings.configuredModelOverride ? "inherited fallback" : "inherits main thread";
    return `BTW model: ${formatModelRef(settings.model)} (${source}).${settings.fallbackReason ? ` ${settings.fallbackReason}` : ""}`;
  }
  function describeResolvedThinking(settings: ResolvedBtwSettings): string {
    return `BTW thinking: ${settings.thinkingLevel} (${settings.thinkingSource === "override" ? "override" : "inherits main thread"}).`;
  }
  async function setBtwModelOverride(ctx: ExtensionCommandContext, nextModel: SessionModel | null): Promise<void> {
    const generation = invalidateBtwLifecycle();
    btwModelOverride = nextModel;
    const details: BtwModelOverrideDetails = nextModel
      ? { action: "set", timestamp: Date.now(), provider: nextModel.provider, id: nextModel.id, api: nextModel.api }
      : { action: "clear", timestamp: Date.now() };
    pi.appendEntry(BTW_MODEL_OVERRIDE_TYPE, details);
    await disposeBtwSession();
    checkCurrent(generation);
    const settings = await resolveBtwSettings(ctx, generation);
    checkCurrent(generation);
    const message = nextModel ? `BTW model override set to ${formatModelRef(nextModel)}.` : "BTW model override cleared. BTW now inherits the main thread model.";
    setOverlayStatus(message, ctx);
    notify(ctx, `${message} ${describeResolvedModel(settings)}`, "info");
  }
  async function setBtwThinkingOverride(ctx: ExtensionCommandContext, next: SessionThinkingLevel | null): Promise<void> {
    const generation = invalidateBtwLifecycle();
    btwThinkingOverride = next;
    const details: BtwThinkingOverrideDetails = next
      ? { action: "set", timestamp: Date.now(), thinkingLevel: next }
      : { action: "clear", timestamp: Date.now() };
    pi.appendEntry(BTW_THINKING_OVERRIDE_TYPE, details);
    await disposeBtwSession();
    checkCurrent(generation);
    const settings = await resolveBtwSettings(ctx, generation);
    checkCurrent(generation);
    const message = next ? `BTW thinking override set to ${next}.` : "BTW thinking override cleared. BTW now inherits the main thread thinking level.";
    setOverlayStatus(message, ctx);
    notify(ctx, `${message} ${describeResolvedThinking(settings)}`, "info");
  }

  async function createBtwSubSession(ctx: ExtensionCommandContext, mode: BtwThreadMode, settings: ResolvedBtwSettings, generation: number): Promise<BtwSessionRuntime> {
    checkCurrent(generation);
    if (!settings.model) throw new Error(settings.fallbackReason || "No active model selected.");
    // Snapshot parent-owned data before any asynchronous factory work.
    const cwd = ctx.cwd;
    const resourceLoader = createBtwResourceLoader(ctx);
    const sessionManager = SessionManager.inMemory(cwd);
    const { messages, sideThreadStartIndex } = buildBtwSeedState(ctx, pendingThread, mode, settings.model);
    for (const message of messages) sessionManager.appendMessage(message);
    const options = await createBtwModelRuntimeOptions(ctx, settings.model, () => checkCurrent(generation));
    checkCurrent(generation);
    const { session } = await createAgentSession({
      cwd, sessionManager, model: settings.model, ...options,
      thinkingLevel: settings.thinkingLevel,
      tools: [...BTW_TOOLS_BY_MODE[mode]],
      resourceLoader,
    });
    const runtime: BtwSessionRuntime = { session, mode, generation, settings, subscriptions: new Set(), sideThreadStartIndex };
    if (generation !== btwLifecycleGeneration) {
      await disposeRuntime(runtime);
      throw new StaleBtwOperation();
    }
    return runtime;
  }
  async function ensureBtwSession(ctx: ExtensionCommandContext, mode: BtwThreadMode, generation: number, settings?: ResolvedBtwSettings): Promise<BtwSessionRuntime | null> {
    checkCurrent(generation);
    settings ??= await resolveBtwSettings(ctx, generation, true);
    checkCurrent(generation);
    if (!settings.model) return null;
    if (activeBtwSession?.mode === mode && activeBtwSession.generation === generation
      && formatModelRef(activeBtwSession.settings.model!) === formatModelRef(settings.model)
      && activeBtwSession.settings.thinkingLevel === settings.thinkingLevel) return activeBtwSession;
    if (!creatingBtwSession) {
      const cleanup = disposeBtwSession();
      const promise = (async () => {
        await cleanup;
        checkCurrent(generation);
        return createBtwSubSession(ctx, mode, settings, generation);
      })();
      creatingBtwSession = { generation, promise };
    }
    const creation = creatingBtwSession;
    let runtime: BtwSessionRuntime;
    try { runtime = await creation.promise; }
    finally { if (creatingBtwSession === creation) creatingBtwSession = null; }
    checkCurrent(generation);
    // A concurrent composer-open and prompt share the same construction.
    if (!activeBtwSession) {
      activeBtwSession = runtime;
      runtime.subscriptions.add(runtime.session.subscribe((event) => handleBtwSessionEvent(runtime, event)));
    }
    return activeBtwSession;
  }

  function ensureOverlay(ctx: UiContext, generation: number, focus = true): void {
    checkCurrent(generation);
    if (!canRenderBtwOverlay(ctx)) return;
    lastUiContext = ctx;
    if (overlayRuntime) {
      if (focus) { overlayRuntime.handle?.setHidden(false); overlayRuntime.handle?.focus(); }
      overlayRuntime.refresh?.();
      return;
    }
    let done: (() => void) | undefined;
    const runtime: OverlayRuntime = {
      closed: false,
      close: () => {
        if (runtime.closed) return;
        runtime.closed = true;
        if (overlayRuntime === runtime) {
          if (runtime.component) overlayDraft = runtime.component.getDraft();
          overlayRuntime = null;
        }
        // Pi's done() hides the top overlay. Never call it before this overlay mounted:
        // a deferred old factory must not close somebody else's newer interaction.
        if (runtime.handle) done?.();
        runtime.component?.dispose();
      },
    };
    overlayRuntime = runtime;
    const isMountedOwner = () => !runtime.closed && overlayRuntime === runtime && generation === btwLifecycleGeneration;
    try {
      void ctx.ui.custom<void>((tui, theme, keybindings, finish) => {
        done = () => finish();
        if (!isMountedOwner()) {
          runtime.closed = true;
          // onHandle closes this inert component after Pi mounts it, not an unrelated overlay.
          return new Text("", 0, 0);
        }
        const editor = requestEditorFactory(pi.events);
        const overlay = new BtwOverlayComponent({
          tui, theme, keybindings, getTheme: () => ctx.ui.theme,
          readTranscriptEntries: () => transcriptState.entries,
          getStatus: () => overlayStatus, getMode: () => pendingMode, getWidthMode: () => overlayWidthMode,
          focusShortcutsLabel: BTW_FOCUS_SHORTCUTS_LABEL,
          onSubmit: (value) => { if (isMountedOwner()) runUiAction(ctx, () => submitFromOverlay(ctx, value)); },
          onDismiss: () => { if (isMountedOwner()) runUiAction(ctx, dismissOrAbortOverlaySession); },
          onUnfocus: () => { if (isMountedOwner()) { runtime.handle?.unfocus(); runtime.refresh?.(); } },
          onToggleWidth: () => { if (isMountedOwner()) toggleOverlayWidth(ctx); },
          editorFactory: editor?.factory, editorProvider: editor?.provider,
          notify: (message, level) => { if (isMountedOwner()) notify(ctx, message, level); },
          initialDraft: overlayDraft,
        });
        runtime.component = overlay;
        runtime.refresh = () => {
          if (!isMountedOwner()) return;
          overlay.focused = runtime.handle?.isFocused() ?? focus;
          overlay.refresh();
        };
        overlay.focused = focus;
        return overlay;
      }, {
        overlay: true, overlayOptions: getOverlayOptions(),
        onHandle: (handle) => {
          runtime.handle = handle;
          if (!isMountedOwner()) {
            done?.();
            runtime.component?.dispose();
            return;
          }
          if (focus) handle.focus();
          else handle.unfocus();
          runtime.refresh?.();
        },
      }).then(() => runtime.close()).catch((error) => {
        const current = isMountedOwner();
        runtime.close();
        if (current) notify(ctx, error instanceof Error ? error.message : String(error), "error");
      });
    } catch (error) {
      runtime.close();
      throw error;
    }
  }

  async function resetThread(ctx: UiContext, persist = true, mode: BtwThreadMode = "contextual"): Promise<number> {
    const generation = invalidateBtwLifecycle();
    const cleanup = disposeBtwSession();
    // Reset and persist synchronously; a late abort cannot reset the next branch/thread.
    pendingThread = [];
    pendingMode = mode;
    transcriptState = createEmptyTranscriptState();
    overlayDraft = "";
    overlayStatus = null;
    if (persist) {
      const details: BtwResetDetails = { timestamp: Date.now(), mode };
      pi.appendEntry(BTW_RESET_TYPE, details);
    }
    syncUi(ctx);
    await cleanup;
    checkCurrent(generation);
    return generation;
  }
  async function restoreThread(ctx: ExtensionContext): Promise<boolean> {
    const generation = invalidateBtwLifecycle();
    const cleanup = disposeBtwSession();
    pendingThread = [];
    pendingMode = "contextual";
    btwModelOverride = null;
    btwThinkingOverride = null;
    transcriptState = createEmptyTranscriptState();
    overlayDraft = "";
    overlayStatus = null;
    lastUiContext = ctx;
    const branch = ctx.sessionManager.getBranch();
    let lastResetIndex = -1;
    for (let i = 0; i < branch.length; ++i) {
      const entry = branch[i];
      if (isCustomEntry(entry, BTW_MODEL_OVERRIDE_TYPE)) {
        const details = entry.data as BtwModelOverrideDetails | undefined;
        if (details?.action === "set") btwModelOverride = ctx.modelRegistry.find(details.provider, details.id) ?? null;
        else if (details?.action === "clear") btwModelOverride = null;
      }
      if (isCustomEntry(entry, BTW_THINKING_OVERRIDE_TYPE)) {
        const details = entry.data as BtwThinkingOverrideDetails | undefined;
        if (details?.action === "set") {
          const parsed = parseBtwThinkingArgs(details.thinkingLevel);
          if (parsed.action === "set") btwThinkingOverride = parsed.thinkingLevel;
        } else if (details?.action === "clear") btwThinkingOverride = null;
      }
      if (isCustomEntry(entry, BTW_RESET_TYPE)) {
        lastResetIndex = i;
        const mode = (entry.data as BtwResetDetails | undefined)?.mode;
        pendingMode = mode === "readonly" || mode === "tangent" ? mode : "contextual";
      }
    }
    for (const entry of branch.slice(lastResetIndex + 1)) {
      if (!isCustomEntry(entry, BTW_ENTRY_TYPE)) continue;
      const details = entry.data as BtwDetails | undefined;
      if (typeof details?.question !== "string" || !details.question || typeof details.answer !== "string" || !details.answer) continue;
      const normalized = { ...details, thinking: typeof details.thinking === "string" ? details.thinking : "", api: details.api || ctx.model?.api || "openai-responses" };
      pendingThread.push(normalized);
      appendPersistedTranscriptTurn(transcriptState, normalized);
    }
    syncUi(ctx);
    await cleanup;
    // No UI, entry or state mutation after cleanup; a later restore already owns them.
    return generation === btwLifecycleGeneration;
  }

  function saveVisibleBtwNote(ctx: ExtensionCommandContext, details: BtwDetails, requested: boolean): SaveState {
    if (!requested) return "not-saved";
    const message = { customType: BTW_MESSAGE_TYPE, content: buildBtwMessageContent(details.question, details.answer), display: true, details };
    // Check at delivery, not before the side call: main may have started or settled meanwhile.
    if (!ctx.isIdle()) { pi.sendMessage(message, { deliverAs: "followUp" }); return "queued"; }
    pi.sendMessage(message);
    return "saved";
  }
  async function executeBtw(ctx: ExtensionCommandContext, question: string, saveRequested: boolean, mode: BtwThreadMode, generation: number): Promise<void> {
    let runtime: BtwSessionRuntime | null = null;
    try {
      checkCurrent(generation);
      lastUiContext = ctx;
      const settings = await resolveBtwSettings(ctx, generation, true);
      checkCurrent(generation);
      const model = settings.model;
      if (!model) throw new Error(settings.fallbackReason || "No active model selected.");
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      checkCurrent(generation);
      if (!hasUsableModelAuth(ctx, model, auth)) throw new Error(auth.ok ? `No credentials available for ${model.provider}/${model.id}.` : auth.error);
      runtime = await ensureBtwSession(ctx, mode, generation, settings);
      checkCurrent(generation);
      if (!runtime) throw new Error("No active model selected.");
      if (runtime.abortPromise) {
        await runtime.abortPromise;
        checkCurrent(generation);
      }
      runtime.abortPromise = undefined;
      pendingMode = mode;
      setOverlayStatus("Streaming...", ctx);
      ensureOverlay(ctx, generation);
      const priorMessages = runtime.session.state.messages.length;
      await runtime.session.prompt(question, { source: "extension" });
      checkCurrent(generation);
      // A slash command can be handled without adding an assistant message. Do not save
      // the previous turn's answer as if it answered this new prompt.
      if (runtime.session.state.messages.length === priorMessages) {
        setOverlayStatus("BTW command handled.", ctx);
        return;
      }
      const response = getLastAssistantMessage(runtime.session);
      if (!response || !runtime.session.state.messages.slice(priorMessages).includes(response)) throw new Error("BTW request finished without a response.");
      if (response.stopReason === "aborted") {
        finishTranscriptTurn(transcriptState, transcriptState.currentTurnId ?? transcriptState.lastTurnId, "aborted");
        setOverlayStatus("Aborted. Press Esc again to dismiss the BTW overlay.", ctx);
        return;
      }
      if (response.stopReason === "error") throw new Error(response.errorMessage || "BTW request failed.");
      const turnId = transcriptState.lastTurnId ?? transcriptState.currentTurnId;
      const thinking = extractThinking(response) || (turnId === null ? "" : findLatestTranscriptEntry(transcriptState, turnId, "thinking")?.text) || "";
      const details: BtwDetails = {
        question, thinking, answer: extractAnswer(response), provider: model.provider, model: model.id,
        api: model.api, thinkingLevel: runtime.session.thinkingLevel,
        timestamp: Date.now(), usage: response.usage,
      };
      pendingThread.push(details);
      pi.appendEntry(BTW_ENTRY_TYPE, details);
      const overlayAvailable = canRenderBtwOverlay(ctx);
      const saved = saveVisibleBtwNote(ctx, details, saveRequested || !overlayAvailable);
      const status = saved === "queued" ? "BTW note queued after the current turn finishes."
        : saved === "saved" ? (overlayAvailable ? "Saved BTW note to the session." : "Displayed BTW response in the session.")
        : "Ready for a follow-up. Hidden BTW thread updated.";
      setOverlayStatus(status, ctx);
      if (saved !== "not-saved") notify(ctx, status, "info");
    } catch (error) {
      if (error instanceof StaleBtwOperation || generation !== btwLifecycleGeneration) return;
      setTranscriptFailure(transcriptState, error instanceof Error ? error.message : String(error));
      setOverlayStatus("Request failed. Thread preserved for retry or follow-up.", ctx);
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
      ensureOverlay(ctx, generation);
      if (runtime && activeBtwSession === runtime) await disposeBtwSession();
    } finally {
      if (generation === btwLifecycleGeneration) syncUi(ctx);
    }
  }

  function getBtwHandoffThread(): BtwHandoffExchange[] {
    const runtime = activeBtwSession;
    const extracted = runtime ? extractBtwHandoffThread(runtime.session.state.messages, runtime.sideThreadStartIndex) : [];
    const thread = extracted.length ? extracted : pendingThread.map((entry) => ({ user: entry.question, assistant: entry.answer }));
    if (!thread.length) throw new Error("No BTW thread available for handoff.");
    return thread;
  }
  async function summarizeThread(ctx: ExtensionCommandContext, thread: BtwHandoffExchange[], generation: number): Promise<string> {
    const settings = await resolveBtwSettings(ctx, generation, true);
    checkCurrent(generation);
    const model = settings.model;
    if (!model) throw new Error(settings.fallbackReason || "No active model selected.");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    checkCurrent(generation);
    if (!hasUsableModelAuth(ctx, model, auth)) throw new Error(auth.ok ? `No credentials available for ${model.provider}/${model.id}.` : auth.error);
    const cwd = ctx.cwd;
    const resourceLoader = createBtwResourceLoader(ctx, [BTW_SUMMARIZE_SYSTEM_PROMPT]);
    const options = await createBtwModelRuntimeOptions(ctx, model, () => checkCurrent(generation));
    checkCurrent(generation);
    const { session } = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd), model, ...options, thinkingLevel: "off", tools: [], resourceLoader });
    const runtime: BtwSessionRuntime = { session, generation, settings, mode: pendingMode, subscriptions: new Set(), sideThreadStartIndex: 0 };
    summarySessions.add(runtime);
    try {
      checkCurrent(generation);
      await session.prompt(formatThread(thread), { source: "extension" });
      checkCurrent(generation);
      const response = getLastAssistantMessage(session);
      if (!response) throw new Error("BTW summarize finished without a response.");
      if (response.stopReason === "error") throw new Error(response.errorMessage || "Failed to summarize BTW thread.");
      if (response.stopReason === "aborted") throw new Error("BTW summarize aborted.");
      return extractAnswer(response);
    } finally {
      try { await disposeRuntime(runtime); }
      finally { summarySessions.delete(runtime); }
    }
  }
  function sendThreadToMain(ctx: ExtensionCommandContext, content: string): void {
    if (ctx.isIdle()) pi.sendUserMessage(content);
    else pi.sendUserMessage(content, { deliverAs: "followUp" });
  }
  async function handoff(ctx: ExtensionCommandContext, instructions: string, summarize: boolean, generation: number): Promise<void> {
    await enqueueBtw(generation, async () => {
      if (!pendingThread.length) { notify(ctx, `No BTW thread to ${summarize ? "summarize" : "inject"}.`, "warning"); return; }
      setOverlayStatus(summarize ? "Summarizing..." : "Injecting into the main session...", ctx);
      ensureOverlay(ctx, generation);
      try {
        const thread = getBtwHandoffThread();
        const body = summarize ? await summarizeThread(ctx, thread, generation) : formatThread(thread);
        checkCurrent(generation);
        const content = summarize
          ? `Here is a summary of a side conversation I had.${instructions ? ` ${instructions}` : ":"}\n\n${body}`
          : instructions ? `Here is a side conversation I had. ${instructions}\n\n${body}`
            : `Here is a side conversation I had for additional context:\n\n${body}`;
        sendThreadToMain(ctx, content);
        const nextGeneration = await resetThread(ctx);
        checkCurrent(nextGeneration);
        notify(ctx, `Injected BTW ${summarize ? "summary" : "thread"} (${thread.length} exchange${thread.length === 1 ? "" : "s"}).`, "info");
      } catch (error) {
        if (error instanceof StaleBtwOperation || generation !== btwLifecycleGeneration) return;
        setOverlayStatus(summarize ? "Summarize failed. Thread preserved for retry or injection." : "Inject failed. Thread preserved for retry or summarize.", ctx);
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    });
  }

  async function dispatchBtwCommand(name: string, args: string, ctx: ExtensionCommandContext): Promise<void> {
    let generation = btwLifecycleGeneration;
    const trimmedArgs = args.trim();
    try {
      if (["btw", "btw:ask", "btw:tangent", "btw:new"].includes(name)) {
        const { question, save } = parseBtwArgs(trimmedArgs);
        if (!question && !canRenderBtwOverlay(ctx)) {
          notify(ctx, `/${name} cannot open its composer outside Pi's TUI. Pass the question inline instead.`, "warning");
          return;
        }
        const mode = name === "btw:ask" ? "readonly" : name === "btw:tangent" ? "tangent" : name === "btw" && !question ? pendingMode : "contextual";
        if (name === "btw:new" || pendingMode !== mode) generation = await resetThread(ctx, true, mode);
        checkCurrent(generation);
        if (question) await enqueueBtw(generation, () => executeBtw(ctx, question, save, mode, generation));
        else {
          await ensureBtwSession(ctx, mode, generation);
          checkCurrent(generation);
          ensureOverlay(ctx, generation);
          if (name === "btw:new") { setOverlayStatus("Started a fresh BTW thread.", ctx); notify(ctx, "Started a fresh BTW thread.", "info"); }
        }
        return;
      }
      if (name === "btw:clear") {
        generation = await resetThread(ctx);
        checkCurrent(generation);
        notify(ctx, "Cleared BTW thread.", "info");
        return;
      }
      if (name === "btw:model") {
        const parsed = parseBtwModelArgs(trimmedArgs);
        if (parsed.action === "invalid") { setOverlayStatus(parsed.message, ctx); notify(ctx, parsed.message, "error"); }
        else if (parsed.action === "show") {
          const settings = await resolveBtwSettings(ctx, generation);
          checkCurrent(generation);
          const message = describeResolvedModel(settings);
          setOverlayStatus(message, ctx); notify(ctx, message, settings.model ? "info" : "warning");
        } else if (parsed.action === "clear") await setBtwModelOverride(ctx, null);
        else {
          const model = ctx.modelRegistry.find(parsed.model.provider, parsed.model.id);
          if (!model || model.api !== parsed.model.api) {
            notify(ctx, `Unknown model ${formatModelRef(parsed.model)}. Use /login or /models to add it before setting it as the BTW override.`, "error");
          } else await setBtwModelOverride(ctx, model);
        }
        return;
      }
      if (name === "btw:thinking") {
        const parsed = parseBtwThinkingArgs(trimmedArgs);
        if (parsed.action === "invalid") { setOverlayStatus(parsed.message, ctx); notify(ctx, parsed.message, "error"); }
        else if (parsed.action === "show") {
          const settings = await resolveBtwSettings(ctx, generation);
          checkCurrent(generation);
          const message = describeResolvedThinking(settings);
          setOverlayStatus(message, ctx); notify(ctx, message, "info");
        } else await setBtwThinkingOverride(ctx, parsed.action === "clear" ? null : parsed.thinkingLevel);
        return;
      }
      if (name === "btw:inject" || name === "btw:summarize") await handoff(ctx, trimmedArgs, name === "btw:summarize", generation);
    } catch (error) {
      if (!(error instanceof StaleBtwOperation) && generation === btwLifecycleGeneration) {
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    }
  }
  async function submitFromOverlay(ctx: UiContext, value: string): Promise<void> {
    const question = value.trim();
    if (!question) { setOverlayStatus("Enter a BTW prompt before submitting.", ctx); return; }
    // BTW-owned commands need the command context supplied when the overlay opened.
    const cmdCtx = ctx as ExtensionCommandContext;
    const command = question.match(/^\/(btw:(?:new|ask|tangent|clear|inject|summarize|model|thinking))(?:\s+([\s\S]*))?$/);
    setOverlayDraft("");
    if (command) await dispatchBtwCommand(command[1], command[2] ?? "", cmdCtx);
    else {
      const generation = btwLifecycleGeneration;
      const mode = pendingMode;
      await enqueueBtw(generation, () => executeBtw(cmdCtx, question, false, mode, generation));
    }
  }

  pi.registerMessageRenderer(BTW_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details as BtwDetails | undefined;
    const content = details ? buildBtwMessageContent(details.question, details.answer)
      : typeof message.content === "string" ? message.content : "[non-text btw message]";
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", theme.bold("[BTW]")), 0, 0));
    box.addChild(new Markdown(content, 0, 0, getMarkdownTheme(), { color: (text: string) => theme.fg("customMessageText", text) }));
    if (expanded && details) {
      box.addChild(new Text(theme.fg("dim", `model: ${details.provider}/${details.model} (${details.api ?? "openai-responses"}) · thinking: ${details.thinkingLevel}`), 0, 0));
      if (details.usage) box.addChild(new Text(theme.fg("dim", `tokens: in ${details.usage.input} · out ${details.usage.output} · total ${details.usage.totalTokens}`), 0, 0));
    }
    return box;
  });
  pi.on("context", async (event) => ({ messages: event.messages.filter((message) => !isVisibleBtwMessage(message)) }));
  pi.on("session_start", async (_event, ctx) => {
    if (!(await restoreThread(ctx))) return;
    const duplicates = duplicateBtwCommands(pi.getCommands());
    if (duplicates.length) notify(ctx, `pi-btw: multiple copies loaded (${duplicates.join(", ")}). Enable only one copy.`, "warning");
  });
  pi.on("session_tree", async (_event, ctx) => { await restoreThread(ctx); });
  pi.on("session_shutdown", async () => {
    invalidateBtwLifecycle();
    lastUiContext = null;
    await Promise.all([disposeBtwSession(), ...[...summarySessions].map(disposeRuntime)]);
  });
  for (const shortcut of BTW_FOCUS_SHORTCUTS) pi.registerShortcut(shortcut, {
    description: "Toggle BTW overlay focus while leaving it open.", handler: async () => toggleOverlayFocus(),
  });
  pi.registerShortcut(BTW_WIDTH_TOGGLE_SHORTCUT, {
    description: "Toggle the BTW overlay between window and full-width layouts.",
    handler: async () => { if (overlayRuntime && lastUiContext) toggleOverlayWidth(lastUiContext); },
  });
  const commands: Record<string, string> = {
    btw: "Continue a side conversation in a focused BTW modal. Add --save to also persist a visible note.",
    side: "Alias for /btw: continue a side conversation in a focused BTW modal.",
    "btw:tangent": "Start or continue a contextless BTW tangent in the focused BTW modal.",
    "btw:ask": "Ask with main-session context and only Pi's read/grep/find/ls tools; no parent tools are inherited.",
    "btw:new": "Start a fresh BTW thread with main-session context. Optionally ask the first question immediately.",
    "btw:clear": "Dismiss the BTW modal/widget and clear the current thread.",
    "btw:inject": "Inject the full BTW thread into the main agent as a user message.",
    "btw:summarize": "Summarize the BTW thread, then inject the summary into the main agent.",
    "btw:model": "Show, set, or clear the BTW-only model override.",
    "btw:thinking": "Show, set, or clear the BTW-only thinking override.",
  };
  for (const [name, description] of Object.entries(commands)) pi.registerCommand(name, {
    description, handler: async (args, ctx) => dispatchBtwCommand(name === "side" ? "btw" : name, args, ctx),
  });
}
