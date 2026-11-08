// /plan turns on plan mode in your conversation (inline-plan.ts). /planners is a full-screen
// planning app: Settings → Tools → Planning → Review → Implement, with two planners. Each planner is an in-process Pi session (planner/agent.ts) seeded with your
// conversation. M, the pane below the lanes, is your main agent: each plan lands in your main
// conversation in full, and there your agent can question a planner or record the merged plan
// (main-chat.ts).

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  CustomEditor,
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  LoginDialogComponent,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { readSelectionPressure } from "@justmytwospence/pi-subscription-usage";
import { ACTIVITY_CHANGED, ACTIVITY_GONE, ACTIVITY_HOST, ACTIVITY_SECTION } from "./activity.js";
import { openPlanningView } from "./app/frame.js";
import { type LaneAction, type LaneInput, type LaneInputHooks, LanesPage } from "./app/lanes-page.js";
import { type OptionRow, OptionsPage, type TextArea } from "./app/options-page.js";
import { RenderedPlans, renderedPlansUnavailable } from "./app/plan-embed.js";
import { embedColors, planHtml, styleKey } from "./app/plan-html.js";
import {
  EDITOR_MODE,
  EDITOR_SURFACE,
  INPUT_CONTEXT,
  markEmbedded,
  readEditorMode,
  readInputContext,
  requestEditorFactory,
} from "./editor-contract.js";
import { effortOrigin, withEffortOrigin } from "./effort-origin.js";
import { EXEC_ENTRY, type ExecState, registerExec } from "./exec.js";
import { editExternally, externalEditorCommand, prepareEditor } from "./external-editor.js";
import { discoverFamily, FAMILY_ENTRY, type FamilyMembership } from "./family-contract.js";
import {
  FLOW_CHANNEL,
  FLOW_ENTRY,
  type FlowRequest,
  type FlowState,
  queryFlow,
  requestExecution,
} from "./flow-contract.js";
import { discoverFreshHandoff } from "./fresh-handoff.js";
import { directImplementationBrief, HANDOFF_MESSAGE_TYPE, implementationBrief } from "./handoff.js";
import { HERDR_BLOCKED_CHANNEL, holdBlocked, holdWorking, isOwnEmit } from "./herdr-blocked.js";
import {
  type EffortSource,
  type ImplementationEffortPick,
  type ImplementationEffortRequest,
  pickImplementationEffort,
} from "./implementation-effort.js";
import {
  formatModelKey,
  formatModelSpec,
  type ImplementationContextChoice,
  implementationChoices,
  linkedImplementationChoice,
  MODEL_SPEC_THINKING_LEVELS,
  type ModelSpec,
  parseModelSpec,
  sameModel,
  subagentRoleModel,
} from "./implementation-models.js";
import {
  type Approval,
  EXEC_GUIDANCE,
  enterPlanText,
  type HandoffTarget,
  registerInlinePlanMode,
} from "./inline-plan.js";
import { DEFAULT_JEV_MODEL, DEFAULT_JEV_PROVIDER, pickToolsWithJev } from "./jev-tool-picker.js";
import { runLaneCommand } from "./lane-commands.js";
import { isAuthError, loginInDialog, providerName } from "./login.js";
import {
  MainAgentView,
  type MergedPlan,
  PLAN_MESSAGE_TYPE,
  type PlanMessageDetails,
  registerMainChat,
  renderCollapsedMarkdown,
  setMainToolsActive,
} from "./main-chat.js";
import { buildMcpCatalog, readConfiguredMcpServers } from "./mcp-tools.js";
import { modelCatalog, normalizeEffort } from "./model-catalog.js";
import { outstanding } from "./negotiation.js";
import { exportPlanToFile } from "./plan-export.js";
import { plansDirectoryPath, planTitle, readPlan, writePlanFile } from "./plan-file.js";
import { expandHome, runPlanCompleteHook } from "./plan-hook.js";
import { consultantAccess, type OtherTool, otherTools, otherToolsNode, resolveAccess } from "./planner/access.js";
import { type PlannerAccessConfig, PlannerAgent } from "./planner/agent.js";
import {
  planDeliveryText,
  planFailureText,
  plannerSystemPrompt,
  plannerTaskPrompt,
  resumeMessage,
  writeMergedRequest,
} from "./planner/prompt.js";
import {
  inheritProviders,
  type PlannerSessionFactory,
  plannerSessionDir,
  readSessionMessages,
  writeSeededSession,
} from "./planner/session.js";
import { PlannerActivity } from "./planner-activity.js";
import { buildPlannerTranscript } from "./planners.js";
import { extensionsForProvider, resolveProviderExtensions } from "./provider-extensions.js";
import {
  configuredAlwaysOffer,
  configuredCompletionMaxRevisions,
  configuredImplementationContext,
  configuredPlanExportPath,
  configuredPlanModeToggleShortcut,
  configuredPlanners,
  configuredPlannerTimeoutSeconds,
  type PlanModeSettings,
  readPlanModeSettings,
  updatePlanModeSettings,
} from "./settings.js";
import { SETTINGS_REASONING_COMMITTED, settingsCycles } from "./settings-cycle.js";
import { resolveSystem1Route, resolveSystem1Target, SYSTEM1_CHANGED } from "./system1.js";
import { recommendTaskEffort, type TaskEffortJudgment } from "./task-effort.js";
import { applyAlwaysOffer, applyJevPick, buildToolTree, leafCapabilities, type ToolNode } from "./tool-tree.js";
import { type ToolPreselection, ToolTreeView } from "./tool-tree-view.js";
import { transcriptCheckpoint } from "./transcript-contract.js";
import { effortText } from "./ui-kit.js";

const EXTENSION_ENTRY_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));
const RUN_ENTRY = "plan-run";
const RUNTIME_ENTRY = "plan-implementation-runtime";
const RUNTIME_CONSUMED_ENTRY = "plan-implementation-runtime-consumed";
const STATUS_KEY = "plan";
const IDS = ["A", "B"] as const;
/** The merged plan your main agent records. */
const MERGED_ID = "M";
/** The effort a subagent model starts at until you change it. */
const SUBAGENT_EFFORT = "medium";
const TIME_LIMITS = [15, 30, 45, 60, 90, 120, 180] as const;
type ConsultantSeed = { spec: string; name: string; messages: Parameters<typeof writeSeededSession>[2] };

export interface PlanDependencies {
  readSettings?(): Promise<PlanModeSettings>;
  createSession?: PlannerSessionFactory;
  pickTools?: typeof pickToolsWithJev;
  pickImplementationEffort?: typeof pickImplementationEffort;
  /** Log in to a provider again, showing the login dialog through `show`; rejects if it fails. */
  login?(providerId: string, show: (dialog: Component) => void): Promise<void>;
}

/** What a planner may use, stored so a restored planner gets the same tools. */
interface StoredAccess {
  tools: string[];
  extensions: string[];
  skills: string[];
  mcpAllow?: string[];
  grantPrefixes: string[];
  scouts?: { spec: string; extensions: string[]; tools: string[]; mcpAllow?: string[] };
}

interface StoredPlanner {
  id: string;
  spec: string;
  name: string;
  access?: StoredAccess;
  sessionFile?: string;
  plan?: string;
  revision?: number;
  /** Its turn was in progress (or had failed) when last saved: restoring the run resumes it. */
  turn?: TurnState;
  /** The plan version last delivered to your main conversation, and where its conversation stood. */
  delivered?: Delivered;
}

interface Delivered {
  revision: number;
  /** Planner session entries already covered, so the next delivery adds only what is new. */
  mark: number;
}

type TurnState = "interrupted" | "failed";

interface StoredRun {
  id: string;
  createdAt: number;
  task: string;
  state: "active" | "discarded" | "implemented";
  planners: StoredPlanner[];
  merged?: StoredMerged;
}

/** Plan M, with the model that wrote it (your session's), for implementation defaults. */
interface StoredMerged extends MergedPlan {
  spec?: string;
}

/** One planning run: the task, its planners, and the plan your main agent merged, if any. */
interface PlanRun {
  id: string;
  createdAt: number;
  task: string;
  agents: PlannerAgent[];
  merged?: StoredMerged;
  /** What each planner has delivered to your main conversation. */
  delivered: Map<string, Delivered>;
  /** Failures already reported to your main conversation. */
  failuresReported: Set<string>;
  /**
   * M's pane is on the screen: both plans are in (or one is, and the other planner failed), or M
   * has a plan. Once shown it stays, even if a planner is retried after a failure.
   */
  mergerShown: boolean;
  /** How to start another planner with the same tools. */
  launch?: { roots: ToolNode[]; others: OtherTool[]; seed: readonly unknown[] };
}

interface Draft {
  task: string;
  planners: [ModelSpec, ModelSpec];
  scouts: Record<string, ModelSpec | undefined>;
  timeLimit: number;
}

type ThinkingLevel = NonNullable<ModelSpec["thinkingLevel"]>;

/**
 * Registers everything synchronously, then loads the settings and registers the toggle shortcut
 * (its key comes from the settings). Pi awaits the factory, so the shortcut exists before Pi binds
 * the extensions' shortcuts; the returned promise resolves once that is done.
 */
export default async function plan(pi: ExtensionAPI, dependencies: PlanDependencies = {}): Promise<void> {
  let settings: PlanModeSettings = { thinkingLevel: "inherit" };
  let run: PlanRun | undefined;
  let app: { close(): void; render(): void; hosted: boolean } | undefined;
  /**
   * Planners a restart cut off (or that had failed) when the run was restored: nothing resumes them
   * by itself; the planning screen offers to, and the status line says so.
   */
  const pendingResume = new Map<string, TurnState>();
  let releaseWorking: (() => void) | undefined;
  let releaseBlocked: (() => void) | undefined;
  let hostCtx: ExtensionContext | undefined;
  let branchEpoch = 0;
  let system1Epoch = 0;
  let effortEpoch = 0;
  const effortRequests = new Map<string, ImplementationEffortRequest>();
  const disposeEffortRequests = () => {
    for (const request of effortRequests.values()) request.dispose();
    effortRequests.clear();
  };
  const invalidateEffort = () => {
    effortEpoch++;
    disposeEffortRequests();
  };
  pi.on("thinking_level_select", () => {
    if (!effortOrigin()) invalidateEffort();
  });
  pi.on("model_select", () => {
    if (!effortOrigin()) invalidateEffort();
  });
  pi.events.on(SETTINGS_REASONING_COMMITTED, (data: unknown) => {
    if (
      !effortOrigin() &&
      hostCtx &&
      runtimeActive &&
      settingsCycles(pi).isCommitting("reasoning") &&
      data &&
      typeof data === "object" &&
      "level" in data &&
      (MODEL_SPEC_THINKING_LEVELS as readonly unknown[]).includes(data.level) &&
      data.level === pi.getThinkingLevel()
    )
      invalidateEffort();
  });
  pi.events.on(SYSTEM1_CHANGED, () => {
    system1Epoch++;
    disposeEffortRequests();
  });
  let sessionReady: Promise<void> = Promise.resolve();
  let runtimeActive = true;
  /** Where you dragged the divider above M (a share of the space), for the rest of this process. */
  let mergerShare: number | undefined;
  /** Plan versions and question sets you have been told about (or saw on screen). */
  const notifiedPlans = new Map<string, number>();
  const notifiedQuestions = new WeakSet<object>();

  const loadSettings = async () => {
    if (dependencies.readSettings) {
      settings = await dependencies.readSettings();
      return;
    }
    const loaded = await readPlanModeSettings();
    settings = loaded.kind === "loaded" ? loaded.settings : { thinkingLevel: "inherit" };
  };

  const saveSettings = (patch: Parameters<typeof updatePlanModeSettings>[0]) => {
    if (dependencies.readSettings) return;
    void updatePlanModeSettings(patch)
      .then((saved) => {
        settings = saved;
      })
      .catch(() => undefined);
  };

  // --- Run state -------------------------------------------------------------------------------

  const persistRun = (state: StoredRun["state"] = "active") => {
    if (!run) return;
    const current = run;
    const stored: StoredRun = {
      id: current.id,
      createdAt: current.createdAt,
      task: current.task,
      state,
      planners: current.agents.map((agent) =>
        storePlanner(agent, current.delivered.get(agent.id), pendingResume.get(agent.id)),
      ),
      ...(current.merged ? { merged: current.merged } : {}),
    };
    pi.appendEntry(RUN_ENTRY, stored);
  };

  /** What each planner last saved: its plan version, session file, and whether a turn was underway. */
  const saved = new Map<string, string>();
  /** Whether M has something to do: every planner has had its say and at least one plan is in. */
  const mergerDue = (current: PlanRun) =>
    current.merged !== undefined ||
    (current.agents.length > 1 &&
      current.agents.every((agent) => agent.plan !== undefined || agent.status === "failed") &&
      current.agents.some((agent) => agent.plan !== undefined));

  const onAgentChange = () => {
    if (!run) return;
    // Save a run whenever a session file, a plan, or a turn starts or ends, so a reload can restore
    // it and resume the turns it cut off.
    let changed = deliver();
    if (!run.mergerShown && mergerDue(run)) {
      run.mergerShown = true;
      mainAgent.note("Both plans are in. Talk them over with M here, or choose Write plan M in the actions.");
      if (!app) hostCtx?.ui.notify("Both plans are in. /planners to review them with M.", "info");
    }
    for (const agent of run.agents) {
      // Once a cut-off planner works again (you resumed it, or said something), it is no longer cut off.
      if (agent.working && pendingResume.delete(agent.id)) changed = true;
      const signature = savedSignature(agent, pendingResume.get(agent.id));
      if (saved.get(agent.id) === signature) continue;
      saved.set(agent.id, signature);
      changed = true;
    }
    if (changed) persistRun();
    activity.refresh();
    const working = run.agents.some((agent) => agent.working);
    if (working && !releaseWorking) releaseWorking = holdWorking(pi.events, "Planning");
    if (!working && releaseWorking) {
      releaseWorking();
      releaseWorking = undefined;
    }
    // A planner waiting for your answers shows in herdr as blocked, over the working hold.
    const asking = run.agents.some((agent) => agent.status === "asking");
    if (asking && !releaseBlocked) releaseBlocked = holdBlocked(pi.events, "Planner question");
    if (!asking && releaseBlocked) {
      releaseBlocked();
      releaseBlocked = undefined;
    }
    updateStatus();
    app?.render();
  };

  /**
   * Deliver new plans (and revisions), in full, to your main conversation, with what you and the
   * planner said since its last delivery; report failures there too. Returns whether anything was
   * delivered (so the run is saved).
   */
  const deliver = () => {
    const current = run;
    if (!current) return false;
    let delivered = false;
    for (const agent of current.agents) {
      const last = current.delivered.get(agent.id);
      const model = `${agent.name}${agent.spec.thinkingLevel ? ` ${agent.spec.thinkingLevel}` : ""}`;
      if (agent.plan && last?.revision !== agent.revision && !agent.working) {
        const conversation = agent.conversation(last?.mark ?? 0);
        const others = current.agents.filter((other) => other !== agent).map(otherPlannerLine);
        sendToMain(
          planDeliveryText({
            id: agent.id,
            model,
            revision: agent.revision,
            plan: agent.plan,
            task: current.task,
            conversation: conversation.text,
            others,
          }),
          { kind: "plan", id: agent.id, model, revision: agent.revision, lines: agent.plan.split("\n").length },
        );
        current.delivered.set(agent.id, { revision: agent.revision, mark: conversation.mark });
        mainAgent.note(`Plan ${agent.id}${agent.revision > 1 ? ` v${agent.revision}` : ""} delivered to your agent.`);
        delivered = true;
      }
      if (agent.status === "failed" && agent.error) {
        const key = `${agent.id}:${agent.stats.startedAt}:${agent.error}`;
        if (!current.failuresReported.has(key)) {
          current.failuresReported.add(key);
          sendToMain(planFailureText(agent.id, model, agent.error), { kind: "failure", id: agent.id, model });
          mainAgent.note(`Planner ${agent.id} failed; your agent was told.`, "warning");
        }
      }
    }
    return delivered;
  };

  /** A message in your main conversation: shown, and read by your agent on its next turn. */
  const sendToMain = (content: string, details: PlanMessageDetails) => {
    try {
      pi.sendMessage<PlanMessageDetails>(
        transcriptCheckpoint(
          { customType: PLAN_MESSAGE_TYPE, content, display: true, details },
          { id: randomUUID(), kind: details.kind === "plan" ? "plan" : "report" },
        ),
        {
          triggerTurn: false,
        },
      );
    } catch {
      // A session that cannot take messages just misses the delivery; /planners still has the plan.
    }
  };

  const updateStatus = () => {
    const ctx = hostCtx;
    if (!ctx?.hasUI) return;
    if (!run || app) ctx.ui.setStatus(STATUS_KEY, undefined);
    else {
      const parts = run.agents.map(
        (agent) =>
          `${agent.id} ${
            agent.status === "asking"
              ? "asking you"
              : agent.working
                ? "working"
                : pendingResume.has(agent.id)
                  ? "cut off (resume in /planners)"
                  : agent.plan
                    ? "ready"
                    : agent.status === "failed"
                      ? "failed"
                      : "waiting"
          }`,
      );
      ctx.ui.setStatus(STATUS_KEY, `plan: ${parts.join(" · ")} (/planners)`);
    }
    if (!run) return;
    // Tell you once per new question and once per new plan version; what you already see on the
    // planning screen counts as told.
    for (const agent of run.agents) {
      if (agent.status === "asking" && agent.pending && !notifiedQuestions.has(agent.pending)) {
        notifiedQuestions.add(agent.pending);
        if (!app) ctx.ui.notify(`Planner ${agent.id} is asking you something. /planners to answer.`, "info");
      } else if (agent.plan && !agent.working && notifiedPlans.get(agent.id) !== agent.revision) {
        notifiedPlans.set(agent.id, agent.revision);
        if (!app) {
          const version = agent.revision > 1 ? ` v${agent.revision}` : "";
          ctx.ui.notify(
            `Plan ${agent.id}${version} is ready, and in this conversation. /planners to review it.`,
            "info",
          );
        }
      }
    }
  };

  /** Plan M from your main agent: recorded in the run, implemented or exported from /plan. */
  const submitMerged = (plan: string, ctx: ExtensionContext): MergedPlan | undefined => {
    if (!run) return undefined;
    const model = ctx.model;
    run.merged = {
      plan,
      revision: (run.merged?.revision ?? 0) + 1,
      name: model?.name || model?.id || "your main agent",
      ...(model ? { spec: `${model.provider}/${model.id}` } : {}),
    };
    persistRun();
    updateStatus();
    app?.render();
    return run.merged;
  };

  const disposeRun = (state: StoredRun["state"]) => {
    if (!run) return;
    persistRun(state);
    for (const agent of run.agents) agent.dispose();
    releaseWorking?.();
    releaseWorking = undefined;
    releaseBlocked?.();
    releaseBlocked = undefined;
    run = undefined;
    saved.clear();
    notifiedPlans.clear();
    pendingResume.clear();
    setMainToolsActive(pi, false);
    updateStatus();
    activity.refresh();
  };

  const restoreRun = (ctx: ExtensionContext) => {
    const entries = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>;
    const latest = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === RUN_ENTRY)
      ?.data as StoredRun | undefined;
    if (latest?.state !== "active" || !Array.isArray(latest.planners)) return;
    const epoch = branchEpoch;
    const agents = latest.planners.flatMap((stored) => {
      const spec = parseModelSpec(stored.spec);
      if (!spec) return [];
      return [
        new PlannerAgent({
          id: stored.id,
          family: discoverFamily(pi.events),
          familyOperationId: `plan:${latest.id}:${stored.id}`,
          restored: true,
          spec,
          name: stored.name,
          cwd: ctx.cwd,
          access: restoreAccess(stored.access, settings),
          timeoutMs: configuredPlannerTimeoutSeconds(settings) * 1000,
          sessionDir: plannerSessionDir(),
          seed: [],
          ...(stored.sessionFile ? { sessionFile: stored.sessionFile } : {}),
          ...(stored.plan ? { plan: stored.plan, revision: stored.revision ?? 1 } : {}),
          onChange: () => {
            if (epoch === branchEpoch) onAgentChange();
          },
          ...(dependencies.createSession ? { createSession: dependencies.createSession } : {}),
        }),
      ];
    });
    if (agents.length === 0) return;
    run = {
      id: latest.id,
      createdAt: latest.createdAt,
      task: latest.task,
      agents,
      ...(latest.merged ? { merged: latest.merged } : {}),
      delivered: new Map(
        latest.planners.flatMap((stored) => (stored.delivered ? [[stored.id, stored.delivered] as const] : [])),
      ),
      failuresReported: new Set(),
      mergerShown: false,
    };
    run.mergerShown = mergerDue(run);
    for (const agent of agents) {
      if (discoverFamily(pi.events)) void agent.observe(ctx);
    }
    for (const agent of run.agents) {
      saved.set(agent.id, savedSignature(agent));
      if (agent.plan) notifiedPlans.set(agent.id, agent.revision);
    }
    setMainToolsActive(pi, true);
    // Turns a reload or restart cut off (or that had failed) do not carry on by themselves: a
    // restored session must not start model calls on its own. They are marked, and /planners offers to
    // resume each (the status line says which).
    for (const agent of run.agents) {
      const turn = latest.planners.find((candidate) => candidate.id === agent.id)?.turn;
      if (!turn || !agent.sessionFile) continue;
      pendingResume.set(agent.id, turn);
      agent.note(
        turn === "interrupted"
          ? "Cut off: the session restarted mid-turn. Resume it from the actions, or say something."
          : "Failed last time. Try again from the actions, or say something.",
        "warning",
      );
    }
    // Record pending turns before delivery can save this run.
    if (deliver()) persistRun();
  };

  /** Resume a planner a restart cut off (or that had failed): the one thing a restored run starts on request. */
  const resumePlanner = (agent: PlannerAgent, ctx: ExtensionContext) => {
    const turn = pendingResume.get(agent.id);
    if (!turn) return;
    pendingResume.delete(agent.id);
    void agent.say(
      resumeMessage(turn),
      ctx,
      turn === "interrupted"
        ? "continue (resumed: the session restarted mid-turn)"
        : "try again (resumed after an error)",
    );
  };

  // --- Events ------------------------------------------------------------------------------------

  // Main owns these definitions; retain their renderers for its embedded mirror.
  const mainToolDefinition = registerMainChat(pi, {
    planners: () => run?.agents,
    submitMerged,
  });
  // M: your main agent, as the pane below the lanes shows it.
  const mainAgent = new MainAgentView({
    model: () => {
      const model = hostCtx?.model;
      const level = pi.getThinkingLevel();
      const spec: ModelSpec = {
        provider: model?.provider ?? "",
        modelId: model?.id ?? "",
        ...(level && level !== "off" ? { thinkingLevel: level as ThinkingLevel } : {}),
      };
      return { name: model?.name || model?.id || "your agent", spec };
    },
    merged: () => run?.merged,
    onChange: () => app?.render(),
    cwd: () => hostCtx?.cwd ?? process.cwd(),
    toolDefinition: mainToolDefinition,
  });
  for (const event of [
    "agent_start",
    "agent_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
  ] as const) {
    pi.on(event as "agent_start", (payload) => {
      mainAgent.apply(payload as unknown as Record<string, unknown>);
    });
  }

  // The planners and their scouts as a source for the suite's activity views (pi-bg's /tasks,
  // pi-subagents' list under the prompt).
  const safely = (fn: () => void) => {
    try {
      fn();
    } catch {
      // The runtime may be stale (after session_shutdown every pi.* call throws).
    }
  };
  const activity = new PlannerActivity({
    agents: () => run?.agents ?? [],
    runId: () => run?.id,
    task: () => run?.task ?? "",
    open: async (ui) => {
      const ctx = hostCtx;
      const epoch = branchEpoch;
      if (ctx?.mode !== "tui") return;
      await loadSettings();
      if (epoch !== branchEpoch || hostCtx !== ctx) return;
      // The host's context with the caller's UI: the screen opens where the list is.
      await openApp({ ...ctx, ui: ui as ExtensionContext["ui"] } as ExtensionCommandContext, "");
    },
    stop: (agent) => agent.stop(),
    changed: () => safely(() => pi.events.emit(ACTIVITY_CHANGED, { id: activity.section.id })),
  });
  const offerActivity = () => {
    if (activity.available && hostCtx?.mode === "tui")
      safely(() => pi.events.emit(ACTIVITY_SECTION, { section: activity.section }));
  };
  pi.events.on(ACTIVITY_HOST, () => offerActivity());

  // Another extension's dialog that waits on you (your main agent's ask_user_question, a tool-gate
  // approval, a cache-guard prompt) holds herdr:blocked. Pi draws it under the planning screen,
  // which is a full-screen overlay, so it would wait unseen: step aside for it.
  let foreignBlocked = 0;
  pi.events.on(HERDR_BLOCKED_CHANNEL, (data) => {
    if (isOwnEmit()) return;
    const active = (data as { active?: unknown } | undefined)?.active === true;
    foreignBlocked = Math.max(0, foreignBlocked + (active ? 1 : -1));
    if (!active || !app || app.hosted) return;
    app.close();
    hostCtx?.ui.notify("Your session is asking you something. /planners brings the planning screen back.", "info");
  });
  pi.on("input", (event) => {
    if ((event as { source?: string }).source === "interactive") activity.seen();
  });

  /** Operations owned by this runtime and branch, consumed exactly once. */
  let pendingOperation:
    | { kind: "replan"; epoch: number; run(): Promise<boolean>; signal?: AbortSignal }
    | { kind: "compact-here"; approval: Approval; epoch: number; workflowRevision: number; flow?: FlowState }
    | {
        kind: "handoff";
        /** Survives settle consumption, but never a new review/approval or destination. */
        freshCurrent?: () => boolean;
        approval: Approval;
        who: HandoffTarget | undefined;
        epoch: number;
        workflowRevision: number;
        flow?: FlowState;
      }
    | undefined;
  let freshApproval: Approval | undefined;
  let pendingCompaction:
    | { marker: string; epoch: number; planFile: string; brief: string; overridden: boolean; isCurrent?: () => boolean }
    | undefined;

  /** The session's model with its current effort, including off. */
  const sessionSpecOf = (ctx: ExtensionContext): ModelSpec | undefined => {
    if (!ctx.model) return undefined;
    const level = pi.getThinkingLevel();
    return {
      provider: ctx.model.provider,
      modelId: ctx.model.id,
      ...(level ? { thinkingLevel: level as ThinkingLevel } : {}),
    };
  };

  /** A one-shot UI default, fenced independently of the eventual execution transition. */
  const implementationEffortRequest = (
    ctx: ExtensionContext,
    planText: string,
    conversation: string,
  ): ImplementationEffortRequest => {
    const config = {
      provider: settings.jevProvider?.trim() || DEFAULT_JEV_PROVIDER,
      model: settings.jevModel?.trim() || DEFAULT_JEV_MODEL,
    };
    const selection = resolveSystem1Target(config);
    const selectionEpoch = system1Epoch;
    const explicitEpoch = effortEpoch;
    const epoch = branchEpoch;
    const session = ctx.sessionManager.getSessionId?.();
    const anchor = ctx.sessionManager.getLeafId?.();
    const model = JSON.stringify(sessionSpecOf(ctx));
    const flow = queryFlow(pi.events);
    const isCurrent = () =>
      runtimeActive &&
      epoch === branchEpoch &&
      selectionEpoch === system1Epoch &&
      explicitEpoch === effortEpoch &&
      resolveSystem1Target({
        provider: settings.jevProvider?.trim() || DEFAULT_JEV_PROVIDER,
        model: settings.jevModel?.trim() || DEFAULT_JEV_MODEL,
      }).key === selection.key &&
      ctx.sessionManager.getSessionId?.() === session &&
      (!session || !anchor || ctx.sessionManager.getBranch().some((entry) => entry.id === anchor)) &&
      JSON.stringify(sessionSpecOf(ctx)) === model &&
      queryFlow(pi.events)?.revision === flow?.revision &&
      queryFlow(pi.events)?.operatingMode === flow?.operatingMode;
    const key = JSON.stringify([
      planText,
      conversation,
      config,
      selection.key,
      selectionEpoch,
      explicitEpoch,
      epoch,
      session,
      model,
      flow?.revision,
    ]);
    const existing = effortRequests.get(key);
    if (existing?.isCurrent()) return existing;
    existing?.dispose();
    const lifetime = new AbortController();
    let judgment: Promise<TaskEffortJudgment> | undefined;
    const recommendations = new Map<string, Promise<ImplementationEffortPick>>();
    const cancelled = (): ImplementationEffortPick => ({ kind: "fallback", reason: "cancelled" });
    const wait = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> =>
      new Promise((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener("abort", abort);
          resolve(undefined);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        promise.then(
          (value) => {
            signal.removeEventListener("abort", abort);
            resolve(value);
          },
          (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          },
        );
      });
    const request: ImplementationEffortRequest = {
      key,
      isCurrent,
      dispose: () => {
        lifetime.abort();
        recommendations.clear();
        if (effortRequests.get(key) === request) effortRequests.delete(key);
      },
      pick: async (target, targetSignal) => {
        const signal = targetSignal ? AbortSignal.any([lifetime.signal, targetSignal]) : lifetime.signal;
        if (signal.aborted || !request.isCurrent()) return cancelled();
        const targetKey = formatModelKey(target);
        const cached = recommendations.get(targetKey);
        if (cached) {
          const result = await wait(cached, signal);
          return !signal.aborted && request.isCurrent() && result ? result : cancelled();
        }
        try {
          judgment ??= (dependencies.pickImplementationEffort ?? pickImplementationEffort)({
            plan: planText,
            conversation,
            cwd: ctx.cwd,
            registry: ctx.modelRegistry,
            ...config,
            signal: lifetime.signal,
          }).then(
            (result) => {
              if (result.kind === "fallback") judgment = undefined;
              return result;
            },
            () => {
              judgment = undefined;
              return { kind: "fallback", reason: "implementation effort is unavailable" } as const;
            },
          );
        } catch {
          return { kind: "fallback", reason: "implementation effort is unavailable" };
        }
        const pendingJudgment = judgment;
        const pending = (async (): Promise<ImplementationEffortPick> => {
          try {
            const result = await wait(pendingJudgment, signal);
            if (!result || signal.aborted || !request.isCurrent()) return cancelled();
            if (result.kind === "fallback") return result;
            const pressure = await wait(
              readSelectionPressure(ctx, { provider: target.provider, id: target.modelId }, { cwd: ctx.cwd, signal }),
              signal,
            );
            if (!pressure || signal.aborted || !request.isCurrent()) return cancelled();
            return recommendTaskEffort(result, pressure);
          } catch {
            return { kind: "fallback", reason: "implementation effort is unavailable" };
          }
        })();
        recommendations.set(targetKey, pending);
        const forget = () => {
          if (recommendations.get(targetKey) === pending) recommendations.delete(targetKey);
        };
        signal.addEventListener("abort", forget, { once: true });
        const result = await pending;
        signal.removeEventListener("abort", forget);
        if (result.kind === "fallback") forget();
        return result;
      },
    };
    effortRequests.set(key, request);
    return request;
  };

  /** Stop old work without saving into the newly selected branch. */
  const clearBranch = () => {
    disposeEffortRequests();
    freshApproval = undefined;
    pendingOperation = undefined;
    pendingCompaction = undefined;
    branchEpoch++;
    const hadUI = hostCtx?.mode === "tui";
    hostCtx = undefined;
    activity.dispose();
    app?.close();
    for (const agent of run?.agents ?? []) agent.dispose();
    run = undefined;
    saved.clear();
    notifiedPlans.clear();
    pendingResume.clear();
    releaseWorking?.();
    releaseWorking = undefined;
    releaseBlocked?.();
    releaseBlocked = undefined;
    if (hadUI) safely(() => pi.events.emit(ACTIVITY_GONE, { id: activity.section.id }));
  };

  const rebuildBranch = async (ctx: ExtensionContext) => {
    clearBranch();
    hostCtx = ctx;
    const epoch = branchEpoch;
    setMainToolsActive(pi, false);
    mainAgent.reset(ctx.sessionManager.getBranch());
    await loadSettings();
    if (epoch !== branchEpoch) return;
    restoreRun(ctx);
    updateStatus();
    activity.reset();
    offerActivity();
  };
  // Pi emits session_start for startup, reload, new/resume (switch) and fork.
  const initializeSession = (ctx: ExtensionContext) => {
    runtimeActive = true;
    sessionReady = rebuildBranch(ctx);
    return sessionReady;
  };
  pi.on("session_start", (_event, ctx) => initializeSession(ctx));
  // Every provider's session_start (including gate, role defaults, Exec and inline
  // restoration) must finish before consuming a fresh child's one-shot bootstrap.
  // Discovery is awaited by the host before withSession can send its first prompt.
  pi.on("resources_discover", async (_event, ctx) => {
    const epoch = branchEpoch;
    await sessionReady;
    if (!runtimeActive || epoch !== branchEpoch) return;
    await applyPendingRuntime(ctx);
  });
  pi.on("session_tree", (_event, ctx) => initializeSession(ctx));
  pi.on("session_shutdown", () => {
    runtimeActive = false;
    clearBranch();
  });

  // Exec mode: following an approved plan, with the planner on call and finish_plan.
  const exec = registerExec(pi, {
    completionReview: () => settings.completionReview !== false,
    completionMaxRevisions: () => configuredCompletionMaxRevisions(settings),
    // As capable as a /planners planner given every tool: toolsets (web, MCP), grants, subagents.
    consultantAccess: (ctx, planFile, spec) => {
      const toolsets = settings.plannerToolsets ?? {};
      const scout = settings.scoutModelMap?.[formatModelKey(spec)] ?? subagentRoleModel(pi.events, "explorer", spec);
      return consultantAccess({
        planFile,
        toolsets,
        grants: settings.commandGrants ?? {},
        mcpCatalog: Object.values(toolsets).some((toolset) => toolset.mcp)
          ? buildMcpCatalog(safeAllTools(pi), readConfiguredMcpServers(ctx.cwd, getAgentDir()))
          : [],
        scout,
        ...(settings.safeSubcommands ? { safeSubcommands: settings.safeSubcommands } : {}),
        guardExtensionPath: EXTENSION_ENTRY_PATH,
        expandPath: expandHome,
        scoutProviderExtensions: extensionsForProvider(
          resolveProviderExtensions(safeCommands(pi), settings.providerExtensions, expandHome),
          scout?.provider,
        ),
      });
    },
    ...(dependencies.createSession ? { createSession: dependencies.createSession } : {}),
    restoreModel: (ctx, spec) => applyRuntime(ctx, spec),
    replan: (ctx) => requestLinkedReplan(ctx, "command"),
    finishLinked: async (ctx, completion, commitEnd) => {
      const epoch = branchEpoch;
      const execution = exec.state;
      const linked = execution?.linkedFlow;
      const flow = queryFlow(pi.events);
      if (
        !linked ||
        !flow ||
        flow.operatingMode !== "linked" ||
        JSON.stringify(linked.selectedFlow) !== JSON.stringify(flow.selectedFlow)
      )
        return false;
      const result = await requestExecution(pi.events, {
        phase: completion.completion === "stopped" ? "stop" : "finish",
        expectedRevision: flow.revision,
        expectedExecutionId: execution?.negotiation?.executionId,
        expectedPlanRevision: execution?.negotiation?.planRevision ?? 1,
        planFile: execution?.planFile ?? completion.planFile ?? "",
        commit: () => {
          if (
            !runtimeActive ||
            epoch !== branchEpoch ||
            ctx.signal?.aborted ||
            exec.state?.negotiation?.executionId !== execution?.negotiation?.executionId
          )
            throw new Error("Execution completion expired.");
          commitEnd();
          if (exec.active) throw new Error("Execution completion expired.");
        },
      });
      return result?.ok === true;
    },
  });

  // Inline plan mode in your own conversation (Claude Code's): /plan, Shift+Tab, enter_plan_mode.
  const inline = registerInlinePlanMode(pi, {
    safeSubcommands: () => settings.safeSubcommands,
    plansDirectory: () => settings.plansDirectory,
    approved: (plan, ctx) => hook(ctx, { id: "plan", name: "plan", revision: 1, plan, spec: undefined }),
    implementationEffort: (ctx, approvedPlan) =>
      implementationEffortRequest(
        ctx,
        approvedPlan.plan,
        buildPlannerTranscript(ctx.sessionManager.getBranch(), 4_000),
      ),
    implementationChoices: (ctx, approvedPlan) => {
      const planning = sessionSpecOf(ctx);
      if (!planning) return undefined;
      const catalog = modelCatalog(ctx, "available");
      const flow = queryFlow(pi.events);
      if (flow?.operatingMode === "linked") {
        const worker = linkedImplementationChoice(flow, catalog.available);
        return {
          planning,
          planningName: catalog.name(planning),
          intent: "linked-execution" as const,
          flow: structuredClone(flow),
          defaultThinkingLevel: settings.defaultImplementationThinkingLevel,
          ...(exec.replanning
            ? {
                contextNote: `Revising an unfinished implementation. Fresh conversation is unavailable.${exec.state?.negotiation?.phase === "paused" ? ` Existing review recovery remains required: ${exec.state.negotiation.pause?.action ?? "paused"}.` : " Review findings and limits are retained."}`,
              }
            : {}),
          ...(worker &&
          !exec.replanning &&
          discoverFreshHandoff(pi.events, {
            sessionManager: ctx.sessionManager,
            approvedPlan,
            // Discovery is observational, not an approval or retained scheduler.
            isCurrent: () => false,
          })
            ? {
                freshTarget: {
                  target: normalizedSpec(
                    ctx,
                    worker.spec,
                    worker.spec.thinkingLevel ?? settings.defaultImplementationThinkingLevel ?? "medium",
                  ),
                  targetName: catalog.name(worker.spec),
                },
              }
            : {}),
          targets: worker
            ? [
                {
                  target: normalizedSpec(
                    ctx,
                    worker.spec,
                    worker.thinkingPinned ? worker.spec.thinkingLevel : sessionSpecOf(ctx)?.thinkingLevel,
                  ),
                  targetName: catalog.name(worker.spec),
                  ...(worker.thinkingPinned ? { thinkingPinned: true as const } : {}),
                },
              ]
            : [],
        };
      }
      return {
        planning,
        planningName: catalog.name(planning),
        defaultThinkingLevel: settings.defaultImplementationThinkingLevel,
        targets: implementationChoices({
          planModel: planning,
          map: settings.implementationModelMap,
          available: catalog.available,
        }).map(({ spec, thinkingPinned }) => ({
          target: spec,
          targetName: catalog.name(spec),
          ...(thinkingPinned ? { thinkingPinned } : {}),
        })),
      };
    },
    handoff: (approval, who, ctx) => {
      const approved = { ...approval };
      const target = who ? structuredClone(who) : undefined;
      const epoch = branchEpoch;
      const workflowRevision = inline.revision;
      const manager = ctx.sessionManager;
      const sessionId = manager.getSessionId?.();
      const anchor = manager.getLeafId?.();
      // SDK ctx.signal is lazy: retain the approving run's signal, not a later turn's.
      const approvingSignal = ctx.signal;
      freshApproval = target?.context === "clear" ? approved : undefined;
      pendingOperation = {
        kind: "handoff",
        approval: approved,
        who: target,
        epoch,
        workflowRevision,
        flow: queryFlow(pi.events),
        ...(target?.context === "clear"
          ? {
              freshCurrent: () =>
                freshApproval === approved &&
                runtimeActive &&
                epoch === branchEpoch &&
                workflowRevision === inline.revision &&
                inline.active &&
                inline.planFile === approved.planFile &&
                flowCurrent(target.flow) &&
                readPlan(approved.planFile) === approved.plan &&
                ctx.sessionManager === manager &&
                manager.getSessionId() === sessionId &&
                (!anchor || manager.getBranch().some((entry) => entry.id === anchor)) &&
                !approvingSignal?.aborted,
            }
          : {}),
      };
    },
    compactHere: (approval) => {
      freshApproval = undefined;
      pendingOperation = {
        kind: "compact-here",
        approval,
        epoch: branchEpoch,
        workflowRevision: inline.revision,
        flow: queryFlow(pi.events),
      };
    },
    implementHere: (ctx, approval) => {
      applyDirectEffort(ctx, approval.thinkingLevel);
      return directImplementationBrief(approval);
    },
    executing: () => exec.active,
    replanning: () => exec.replanning,
    requestReplan: (ctx, origin) => requestLinkedReplan(ctx, origin),
    approvalRefusal: () =>
      exec.replanning && queryFlow(pi.events)?.operatingMode !== "linked"
        ? "This suspended Linked task is now Independent. Stop implementation before approving another plan."
        : undefined,
    executionMenu: (ctx) => exec.menu(ctx),
    toggleKey: () => configuredPlanModeToggleShortcut(settings),
  });

  async function requestLinkedReplan(ctx: ExtensionContext, origin: "command" | "tool"): Promise<boolean> {
    if (exec.replanning) return true;
    const execution = exec.state;
    const flow = queryFlow(pi.events);
    const notify = (message: string) => {
      ctx.ui.notify(message, "warning");
      return false;
    };
    if (
      !execution?.active ||
      !execution.negotiation ||
      flow?.operatingMode !== "linked" ||
      JSON.stringify(execution.linkedFlow?.selectedFlow) !== JSON.stringify(flow.selectedFlow)
    )
      return notify("Revisiting this plan is unavailable; no workflow changed.");
    if (origin === "command" && !ctx.isIdle())
      return notify("Implementation is running. Interrupt it, then revisit the plan.");
    if (pendingOperation?.kind === "replan") return true;
    if (flow.transitioning || flow.blocked) return notify(flow.blocked ?? "A linked flow transition is in progress.");
    const refusal = exec.replanRefusal();
    if (refusal) return notify(refusal);
    const epoch = branchEpoch;
    const revision = inline.revision;
    const manager = ctx.sessionManager;
    const session = manager.getSessionId?.();
    const anchor = manager.getLeafId?.();
    const signal = ctx.signal;
    const negotiation = execution.negotiation;
    const id = negotiation.executionId;
    const planRevision = negotiation.planRevision ?? 1;
    const live = () =>
      runtimeActive &&
      epoch === branchEpoch &&
      revision === inline.revision &&
      ctx.sessionManager === manager &&
      manager.getSessionId?.() === session &&
      (!anchor || manager.getBranch().some((entry) => entry.id === anchor)) &&
      !signal?.aborted &&
      flowCurrent(flow) &&
      exec.active &&
      !exec.replanning &&
      exec.state?.negotiation?.executionId === id &&
      (exec.state?.negotiation?.planRevision ?? 1) === planRevision &&
      (origin === "tool" || ctx.isIdle());
    const run = async () => {
      let committed = false;
      try {
        if (!live()) return false;
        const approved = readPlan(execution.planFile);
        if (!approved) return notify("The approved plan is missing; no workflow changed.");
        const findings = outstanding(negotiation)
          .map((finding) => `- ${finding.id}: ${finding.title}\n  ${finding.requestedChange}`)
          .join("\n");
        const questions = execution.pendingQuestion?.questions.map((question) => `- ${question.question}`).join("\n");
        const draftFile = writePlanFile(
          plansDirectoryPath(settings.plansDirectory),
          `${approved}\n\n## Replanning context\n\nKeep existing implementation changes and conversation history. This is the same unfinished task; review findings and limits are retained.\n${findings ? `\nOutstanding findings:\n${findings}\n` : ""}${questions ? `\nUnanswered planner question:\n${questions}\n` : ""}`,
        );
        if (!live()) return false;
        const result = await requestExecution(pi.events, {
          phase: "replan",
          expectedRevision: flow.revision,
          expectedExecutionId: id,
          expectedPlanRevision: planRevision,
          planFile: execution.planFile,
          commit: () => {
            if (!live()) throw new Error("Plan revision expired.");
            exec.suspendForReplan(ctx, draftFile);
            inline.commitReplan(ctx, draftFile);
            committed = true;
          },
        });
        if (!result?.ok && runtimeActive && epoch === branchEpoch)
          notify(result?.error ?? "Revisiting this plan is unavailable; no workflow changed.");
        return result?.ok === true && committed;
      } catch (error) {
        if (runtimeActive && epoch === branchEpoch) notify(`Could not revisit the plan: ${errorText(error)}`);
        return false;
      } finally {
        exec.cancelReplan();
      }
    };
    exec.prepareReplan();
    if (origin === "tool") {
      pendingOperation = { kind: "replan", epoch, run, signal };
      return true;
    }
    return run();
  }

  pi.events.on(FLOW_CHANNEL, (data) => {
    const request = data as FlowRequest | undefined;
    if (request?.kind !== "replan" || !hostCtx || !runtimeActive) return;
    const ctx = hostCtx;
    const flow = queryFlow(pi.events);
    if (!flow) return;
    request.result = requestLinkedReplan(ctx, "command").then((ok) => ({
      ok,
      snapshot: queryFlow(pi.events) ?? flow,
      ...(ok ? {} : { error: "Revisiting this plan did not change the workflow." }),
    }));
  });
  pi.on("agent_settled", (event) => {
    if (event.aborted && pendingOperation?.kind === "replan") {
      pendingOperation = undefined;
      exec.cancelReplan();
    }
  });

  // An approved plan handed off: once the turn that approved it ends, preserve its history,
  // switch the model and continue with the implementation brief.
  pi.on("agent_before_settle", async (event, ctx) => {
    const operation = pendingOperation;
    pendingOperation = undefined;
    if (operation?.kind === "replan") {
      if (event.outcome !== "completed" || operation.signal?.aborted || operation.epoch !== branchEpoch) {
        exec.cancelReplan();
        return undefined;
      }
      if (!(await operation.run())) return undefined;
      const draftFile = inline.planFile;
      if (!draftFile) return undefined;
      return {
        entries: [
          ...(event.entries ?? []),
          {
            type: "custom_message" as const,
            customType: "plan-mode-replanning",
            content: enterPlanText(draftFile, true),
            display: false,
          },
        ],
        continue: true,
      };
    }
    const flow = queryFlow(pi.events);
    if (
      !operation ||
      operation.epoch !== branchEpoch ||
      !runtimeActive ||
      operation.workflowRevision !== inline.revision ||
      operation.flow?.revision !== flow?.revision ||
      operation.flow?.operatingMode !== flow?.operatingMode
    )
      return undefined;
    const recover = async () => {
      if (runtimeActive && operation.epoch === branchEpoch && operation.workflowRevision === inline.revision)
        await inline.enter(ctx, operation.approval.planFile);
    };
    if (event.outcome !== "completed" || ctx.signal?.aborted) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "The handoff did not happen: the turn did not complete. Run /plan and approve the plan again.",
          "warning",
        );
      }
      await recover();
      return undefined;
    }
    const { approval } = operation;
    if (operation.kind === "compact-here") {
      applyDirectEffort(ctx, approval.thinkingLevel);
      return {
        entries: [
          {
            type: "compaction" as const,
            summary: "The approved implementation plan follows.",
            firstKeptEntryId: null,
            details: { planMode: { direct: approval.planFile } },
          },
          transcriptCheckpoint(
            {
              type: "custom_message" as const,
              customType: "plan-mode-implementation",
              content: directImplementationBrief(approval),
              display: true,
              details: { planFile: approval.planFile, lines: approval.plan.split("\n").length },
            },
            { id: randomUUID(), kind: "plan" },
          ),
        ],
        continue: true,
      };
    }
    const { who } = operation;
    if (!who || (who.intent !== "linked-execution" && sameModel(who.planning, who.target))) {
      ctx.ui.notify("The handoff needs a distinct model. Run /plan and approve the plan again.", "warning");
      await recover();
      return undefined;
    }
    const resumed = exec.replanning ? exec.state : undefined;
    const target =
      who.intent === "linked-execution"
        ? {
            provider: who.target.provider,
            modelId: who.target.modelId,
            ...(approval.thinkingLevel ? { thinkingLevel: approval.thinkingLevel } : {}),
          }
        : normalizedSpec(
            ctx,
            who.target,
            approval.thinkingLevel ??
              who.target.thinkingLevel ??
              settings.defaultImplementationThinkingLevel ??
              "medium",
          );
    const live = () =>
      runtimeActive &&
      operation.epoch === branchEpoch &&
      operation.workflowRevision === inline.revision &&
      flowCurrent(who.flow) &&
      readPlan(approval.planFile) === approval.plan &&
      !ctx.signal?.aborted;
    if (!live()) return undefined;
    if (who.intent !== "linked-execution" && (!(await applyRuntime(ctx, target, live)) || !live())) {
      if (live()) await recover();
      return undefined;
    }
    let sessionFile: string | undefined;
    try {
      if (who.context !== "clear")
        sessionFile = writeSeededSession(
          ctx.cwd,
          plannerSessionDir(),
          ctx.sessionManager.buildSessionProjection().messages,
        );
    } catch (error: unknown) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          resumed
            ? `The planner could not be refreshed (${errorText(error)}); implementation remains paused in Plan.`
            : `The planner could not be put on call (${errorText(error)}); the handoff goes ahead without it.`,
          "warning",
        );
      }
    }
    if (resumed && !sessionFile) {
      ctx.ui.notify("The planner could not be refreshed; implementation remains paused in Plan.", "warning");
      return undefined;
    }
    const implementer = who.targetName;
    const planner =
      sessionFile && who ? { spec: formatModelSpec(who.planning), name: who.planningName, sessionFile } : undefined;
    const execState: ExecState = {
      active: true,
      planFile: approval.planFile,
      implementer,
      implementerModel: formatModelKey(target),
      ...(planner ? { planner } : {}),
      restore: formatModelSpec(who.planning),
      restoreName: who.planningName,
      ...(who.intent === "linked-execution" && who.flow ? { linkedFlow: structuredClone(who.flow) } : {}),
      asks: 0,
      costUsd: 0,
    };
    if (who.context === "clear") {
      const current = operation.freshCurrent;
      if (who.intent !== "linked-execution" || !current?.()) return undefined;
      const schedule = discoverFreshHandoff(pi.events, {
        sessionManager: ctx.sessionManager,
        approvedPlan: { planFile: approval.planFile, plan: approval.plan },
        isCurrent: current,
      });
      // Acceptance is synchronous. Never await waitForIdle from this awaited settle hook.
      if (
        !schedule?.(async (replace) => {
          if (!current()) return;
          const consultant: ConsultantSeed = {
            spec: formatModelSpec(who.planning),
            name: who.planningName,
            messages: ctx.sessionManager.buildSessionProjection().messages,
          };
          const brief = implementationBrief({
            plan: approval.plan,
            planFile: approval.planFile,
            context: "fresh",
            planner: consultant.name,
            edited: approval.edited,
          });
          await implementFresh(
            { sessionManager: ctx.sessionManager, ui: ctx.ui, waitForIdle: async () => {}, newSession: replace },
            target,
            execState,
            brief,
            consultant,
            current,
            approval.effortSource ?? "fallback",
          );
          if (freshApproval === approval) freshApproval = undefined;
        }) &&
        current()
      ) {
        freshApproval = undefined;
        ctx.ui.notify(
          "Fresh handoff unavailable. Stay in Plan; use /planners to approve a fresh conversation.",
          "warning",
        );
      }
      return undefined;
    }
    if (who.intent === "linked-execution") {
      if (
        !who.flow ||
        !(await applyRuntime(ctx, target, live, {
          flow: who.flow,
          planFile: approval.planFile,
          effort: { ...target, source: approval.effortSource ?? "fallback" },
          ...(resumed
            ? {
                phase: "resume" as const,
                expectedExecutionId: resumed.negotiation?.executionId,
                expectedPlanRevision: resumed.negotiation?.planRevision ?? 1,
              }
            : {}),
          commit: () => {
            inline.commitExecution(ctx);
            if (resumed)
              exec.resumeReplan(
                ctx,
                {
                  planFile: execState.planFile,
                  implementer: execState.implementer,
                  implementerModel: execState.implementerModel,
                  planner,
                  linkedFlow: execState.linkedFlow,
                },
                { record: false },
              );
            else exec.begin(ctx, execState, { record: false });
          },
        }))
      )
        return undefined;
    } else exec.begin(ctx, execState, { record: false });
    return {
      entries: [
        ...(who.context === "compact"
          ? [
              {
                type: "compaction" as const,
                summary: "The approved implementation plan follows.",
                firstKeptEntryId: null,
                details: { planMode: { direct: approval.planFile } },
              },
            ]
          : []),
        { type: "custom" as const, customType: EXEC_ENTRY, data: resumed ? exec.state : execState },
        transcriptCheckpoint(
          {
            type: "custom_message" as const,
            customType: HANDOFF_MESSAGE_TYPE,
            content:
              implementationBrief({
                plan: approval.plan,
                planFile: approval.planFile,
                context: "here",
                ...(planner ? { planner: planner.name } : {}),
                edited: approval.edited,
              }) +
              (resumed?.negotiation?.phase === "paused" || resumed?.pendingQuestion
                ? "\n\nExisting review recovery or the unanswered planner question remains required. Do not implement until it is resolved through the execution dialog; reapproval did not authorize a retry or another review cycle."
                : ""),
            display: true,
            details: {
              planFile: approval.planFile,
              implementer,
              ...(planner ? { planner: planner.name } : {}),
              lines: approval.plan.split("\n").length,
            },
          },
          { id: randomUUID(), kind: "plan" },
        ),
      ],
      continue: true,
    };
  });

  pi.registerMessageRenderer<{ planFile?: string; lines?: number }>(
    "plan-mode-implementation",
    (message, options, theme) =>
      renderCollapsedMarkdown(
        "Implementing approved plan",
        typeof message.content === "string" ? message.content : "",
        options.expanded,
        theme,
        message.details?.lines,
      ),
  );

  pi.on("session_before_compact", (event, ctx) => {
    const pending = pendingCompaction;
    if (!pending || event.customInstructions !== pending.marker) return;
    if (
      !runtimeActive ||
      pending.epoch !== branchEpoch ||
      event.signal.aborted ||
      pending.overridden ||
      pending.isCurrent?.() === false
    ) {
      pendingCompaction = undefined;
      if (runtimeActive && pending.epoch === branchEpoch)
        ctx.ui.notify("Plan compaction was cancelled; implementation did not start.", "warning");
      return { cancel: true };
    }
    pending.overridden = true;
    return {
      compaction: {
        summary: pending.brief,
        // Pi's projection accepts the same discard-all sentinel as settle compactions.
        firstKeptEntryId: null as unknown as string,
        tokensBefore: event.preparation.tokensBefore,
        details: { planMode: { direct: pending.planFile } },
      },
    };
  });

  pi.registerMessageRenderer<{ planFile?: string; implementer?: string; planner?: string; lines?: number }>(
    HANDOFF_MESSAGE_TYPE,
    (message, options, theme) => {
      const details = message.details;
      const body = typeof message.content === "string" ? message.content : "";
      const head = `▸ Implementing ${details?.planFile ? `"${planTitle(details.planFile)}"` : "the plan"} · ${details?.implementer ?? "the implementer"}${details?.planner ? ` · ${details.planner} on call` : ""}`;
      return renderCollapsedMarkdown(head, body, options.expanded, theme, details?.lines);
    },
  );

  pi.registerCommand("plan", {
    description: "Plan mode: research read-only and write a plan to approve before anything changes",
    handler: async (args, ctx) => {
      const epoch = branchEpoch;
      await sessionReady;
      if (!runtimeActive || epoch !== branchEpoch) return;
      hostCtx = ctx;
      if (exec.active && !exec.replanning) {
        if (queryFlow(pi.events)?.operatingMode === "linked") {
          if (!(await requestLinkedReplan(ctx, "command"))) return;
        } else if (!ctx.hasUI || (await exec.menu(ctx)) !== "stopped" || exec.active) {
          if (!ctx.hasUI) ctx.ui.notify(EXEC_GUIDANCE, "warning");
          return;
        }
      }
      const task = args.trim();
      if (!inline.active) await inline.enter(ctx);
      else if (!task && ctx.hasUI) {
        ctx.ui.notify(`Plan mode is on. The plan file is ${inline.planFile ?? "not chosen yet"}.`, "info");
      }
      if (task && inline.active) pi.sendUserMessage(task, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    },
  });

  pi.registerCommand("planners", {
    description: "Plan with two models in parallel in a full-screen planner, merge, then implement",
    handler: async (args, ctx) => {
      const epoch = branchEpoch;
      await sessionReady;
      if (!runtimeActive || epoch !== branchEpoch) return;
      hostCtx = ctx;
      if (exec.active) {
        if (!ctx.hasUI || (await exec.menu(ctx)) !== "stopped" || exec.active) {
          if (!ctx.hasUI) ctx.ui.notify(EXEC_GUIDANCE, "warning");
          return;
        }
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/planners needs the interactive terminal UI.", "warning");
        return;
      }
      await loadSettings();
      if (!runtimeActive || epoch !== branchEpoch || hostCtx !== ctx || exec.active) return;
      await openApp(ctx, args.trim());
    },
  });

  // The shortcut toggles plan mode (with pi-tool-gate: cycles its modes, as its own key does). Its
  // key is in the settings, so the factory waits for them: Pi binds extension shortcuts once,
  // after every factory has returned, and a shortcut registered later would never fire.
  const initialized = (async () => {
    try {
      await loadSettings();
    } catch {
      // Defaults.
    }
  })();
  await initialized;
  const shortcut = configuredPlanModeToggleShortcut(settings);
  if (shortcut) {
    pi.registerShortcut(shortcut, {
      description: "Toggle plan mode",
      handler: async (ctx) => {
        const epoch = branchEpoch;
        const trigger = settingsCycles(pi).captureTrigger();
        await initialized;
        await sessionReady;
        if (!runtimeActive || epoch !== branchEpoch) return;
        await inline.toggle(ctx, trigger);
      },
    });
  }

  // --- The app -----------------------------------------------------------------------------------

  async function openApp(ctx: ExtensionCommandContext, task: string) {
    if (app) return;
    if (foreignBlocked > 0) {
      ctx.ui.notify("Answer the open question first; then /planners.", "warning");
      return;
    }
    const epoch = branchEpoch;
    const family = discoverFamily(pi.events);
    await openPlanningView(ctx, family, (tui, theme, keybindings, done, viewport) => {
      const rows = () => Math.max(1, viewport().height);
      let refreshImplementation: (() => void) | undefined;
      const render = () => {
        refreshImplementation?.();
        tui.requestRender();
      };
      let page: Component & { typing?: boolean; focused?: boolean } = undefined as never;
      let focused = true;
      const ticker = setInterval(() => {
        if (run?.agents.some((agent) => agent.working)) render();
      }, 250);
      ticker.unref?.();
      let closed = false;
      // Rendered plans (the Settings row): why they cannot work here, checked once per screen.
      const renderBlock = renderedPlansUnavailable();
      const renders = new RenderedPlans({
        enabled: () => renderBlock === undefined && settings.renderedPlans !== false,
        html: (plan, id) => planHtml(plan, theme, `Plan ${id}`),
        colors: () => embedColors(theme),
        // The theme's resolved colours are a new object whenever the theme or the terminal's colours
        // change, so the key is worked out once per change.
        styleKey: () => {
          const colors = theme.colors;
          if (styleCache?.colors !== colors) styleCache = { colors, key: styleKey(theme) };
          return styleCache.key;
        },
        onChange: render,
        // The pages' pictures go out through Pi's terminal, in order with its own output.
        write: (data) => tui.terminal.write(data),
      });
      let styleCache: { colors: object; key: string } | undefined;
      // A light/dark switch (macOS appearance): Pi re-queries the terminal's colours and re-themes a
      // moment later. Redraw then, so the pages are rebuilt in the new colours even while idle.
      const schemeTimers: NodeJS.Timeout[] = [];
      const unsubscribeScheme = (
        tui as unknown as { onTerminalColorSchemeChange?(listener: () => void): () => void }
      ).onTerminalColorSchemeChange?.(() => {
        for (const ms of [300, 1000, 2500]) {
          const timer = setTimeout(render, ms);
          timer.unref?.();
          schemeTimers.push(timer);
        }
      });
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribeScheme?.();
        for (const timer of schemeTimers) clearTimeout(timer);
        clearInterval(ticker);
        (page as { dispose?(): void } | undefined)?.dispose?.();
        renders.dispose();
        app = undefined;
        family?.focus(undefined);
        updateStatus();
        done();
      };
      app = { close, render, hosted: family !== undefined };
      updateStatus();

      /**
       * The task editor: an optional embedded provider, else Pi's native editor.
       * It wraps and scrolls inside its borders.
       */
      const createTextArea = (): TextArea => {
        const editorTheme: EditorTheme = {
          borderColor: (text) => theme.fg("borderAccent", text),
          selectList: {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("dim", text),
          },
        };
        // The suite's editor (pi-vim's embedded surface) when a provider is loaded: Enter or :w
        // submits, :q or Escape in Normal mode leaves the box.
        const suite = requestEditorFactory(pi.events);
        if (suite) {
          try {
            const editor = suite.factory({
              surface: "embedded",
              tui,
              theme: editorTheme,
              keybindings,
              onSubmit: (text) => (editor as unknown as TextArea).onSubmit?.(text),
              onCancel: () => (editor as unknown as TextArea).onEscape?.(),
              notify: (message, type) => ctx.ui.notify(message, type),
              paddingX: 1,
            });
            return editor as unknown as TextArea;
          } catch {
            // A provider's bug must not take the task box away: pi's editor follows.
          }
        }
        // A main-editor factory may dispatch commands or quit Pi; never embed that surface.
        const editor = markEmbedded(new CustomEditor(tui, editorTheme, keybindings, { paddingX: 1 }));
        return editor as unknown as TextArea;
      };

      /** A lane's input: the suite's editor when a provider is loaded (Enter or :w sends), else pi's one-line input. */
      const createLaneInput = (id: string, hooks: LaneInputHooks): LaneInput | undefined => {
        const suite = requestEditorFactory(pi.events);
        if (!suite) return undefined;
        const editor = suite.factory({
          surface: "embedded",
          tui,
          theme: {
            borderColor: (text: string) => theme.fg("borderMuted", text),
            selectList: {
              selectedPrefix: (text: string) => theme.fg("accent", text),
              selectedText: (text: string) => theme.fg("accent", text),
              description: (text: string) => theme.fg("muted", text),
              scrollInfo: (text: string) => theme.fg("dim", text),
              noMatch: (text: string) => theme.fg("dim", text),
            },
          } satisfies EditorTheme,
          keybindings,
          onSubmit: (text) => hooks.submit(text),
          onCancel: () => hooks.cancel(),
          scrollViewport: (direction) => hooks.scroll(direction),
          notify: (message, type) => ctx.ui.notify(`${id}: ${message}`, type),
          initialMode: "insert",
        });
        return {
          get focused() {
            return editor.focused;
          },
          set focused(value: boolean) {
            editor.focused = value;
          },
          getValue: () => editor.getText(),
          setValue: (text) => editor.setText(text),
          handleInput: (data) => editor.handleInput(data),
          // Pi's editor frames its text with a border line above and below; the lane draws its
          // own rule, so only the text lines are shown.
          render: (width) => {
            const lines = editor.render(width);
            return lines.length > 2 ? lines.slice(1, -1) : lines;
          },
          ownsEnter: true,
          [EDITOR_MODE]: () => readEditorMode(editor),
          dispose: () => editor.dispose(),
        };
      };
      const show = (next: Component) => {
        if (closed || epoch !== branchEpoch) {
          (next as { dispose?(): void }).dispose?.();
          return;
        }
        (page as { dispose?(): void } | undefined)?.dispose?.();
        page = next;
        page.focused = focused;
        render();
      };

      /** The planning screen; `onActions` opens it on the actions bar (back from a page it led to). */
      const lanes = (onActions = false): LanesPage => {
        const lanesPage: LanesPage = new LanesPage(theme, {
          title: "Planners",
          task: () => run?.task ?? "",
          createInput: createLaneInput,
          agents: () => run?.agents ?? [],
          // M is your main agent; its pane joins the screen once both plans are in.
          merger: () => (run?.mergerShown ? mainAgent : undefined),
          actions: () => laneActions(),
          onAction: (id) => onLaneAction(id),
          say: (agent, text) => {
            const planner = run?.agents.find((candidate) => candidate.id === agent.id);
            if (!planner) return;
            // A slash command acts on the planner's session; `//text` sends "/text" as a message.
            void runLaneCommand(text, planner, laneCommandHost)
              .then((handled) => {
                if (!handled && !closed && epoch === branchEpoch)
                  return planner.say(text.startsWith("//") ? text.slice(1) : text, ctx);
              })
              .catch((error: unknown) => {
                if (!closed && epoch === branchEpoch) planner.note(errorText(error), "error");
              });
          },
          mergerShare: {
            get: () => mergerShare,
            set: (share) => {
              mergerShare = share;
            },
          },
          sayToMerger: (text) => {
            // M is your main session: its commands are Pi's own, so a command goes to your editor.
            if (text.startsWith("/") && !text.startsWith("//")) {
              close();
              ctx.ui.setEditorText(text);
              ctx.ui.notify(
                "Press Enter to run it in your session; /planners brings the planning screen back.",
                "info",
              );
              return;
            }
            // Like typing in your main editor: a new turn, or a steer while your agent is working.
            const message = text.startsWith("//") ? text.slice(1) : text;
            pi.sendUserMessage(message, ctx.isIdle() ? undefined : { deliverAs: "steer" });
          },
          hide: close,
          stopAll: () => {
            for (const agent of run?.agents ?? []) void agent.stop().catch(() => undefined);
            if (mainAgent.working) ctx.abort();
          },
          rowsAvailable: rows,
          requestRender: render,
          renders,
          externalEditor: {
            matches: (data) => keybindings.matches(data, "app.editor.external"),
            edit: async (text) => {
              const command = externalEditorCommand(ctx.cwd);
              if (!command) {
                ctx.ui.notify("No external editor: set externalEditor in settings, or $VISUAL / $EDITOR.", "warning");
                return undefined;
              }
              prepareEditor(command, theme);
              tui.stop();
              try {
                return await editExternally(command, text);
              } finally {
                tui.start();
                tui.requestRender(true);
              }
            },
          },
        });
        if (onActions) lanesPage.focusActions();
        return lanesPage;
      };

      /** Every plan you can implement or export: plan M (your main agent's) first, then A and B. */
      const sources = (): PlanSource[] => {
        if (!run) return [];
        const merged = run.merged;
        return [
          ...(merged
            ? [
                {
                  id: MERGED_ID,
                  name: merged.name,
                  revision: merged.revision,
                  plan: merged.plan,
                  spec: merged.spec ? parseModelSpec(merged.spec) : undefined,
                },
              ]
            : []),
          ...run.agents.flatMap((agent) =>
            agent.plan
              ? [{ id: agent.id, name: agent.name, revision: agent.revision, plan: agent.plan, spec: agent.spec }]
              : [],
          ),
        ];
      };

      const laneActions = (): LaneAction[] => {
        const agents = run?.agents ?? [];
        // The merged plan comes first: once there is one, it is usually the one to build.
        const ready = sources();
        const actions: LaneAction[] = [];
        // With two plans in, M can merge them: first in line until it has, then right after Implement M.
        const merged = run?.merged;
        const mergeable = agents.length > 1 && agents.filter((agent) => agent.plan).length > 1 && !mainAgent.working;
        const merge: LaneAction = {
          id: "merge",
          label: merged ? "Revise plan M" : "Write plan M",
          description: merged
            ? "Ask M to fold what you have discussed since into plan M, as a new version."
            : "Ask M to merge both plans and what you have discussed into plan M, which you can then implement or export.",
          toMerger: writeMergedRequest(merged !== undefined),
        };
        // A planner a restart cut off (or that had failed): resume it, on request only.
        for (const agent of agents) {
          const turn = pendingResume.get(agent.id);
          if (!turn || agent.working) continue;
          actions.push({
            id: `resume:${agent.id}`,
            label: `Resume ${agent.id}`,
            description:
              turn === "interrupted"
                ? `${agent.id}'s turn was cut off when the session restarted. Ask it to carry on from where it left off.`
                : `${agent.id}'s last turn failed. Ask it to try again.`,
          });
        }
        // A planner its provider turned away for its credentials: log in again, here, and it retries.
        for (const agent of agents) {
          if (agent.status !== "failed" || !isAuthError(agent.error)) continue;
          actions.push({
            id: `login:${agent.id}`,
            label: `Log in to ${agent.spec.provider}…`,
            description: `${agent.id} was refused: ${agent.error}. Log in to ${agent.spec.provider} again (as /login does) and ${agent.id} tries again.`,
          });
        }
        if (mergeable && !merged) actions.push(merge);
        const first = ready[0];
        const plans =
          ready.length > 1 ? `a plan (${ready.map((source) => source.id).join(", ")})` : `plan ${first?.id}`;
        if (first) {
          actions.push({
            id: "implement",
            label: "Implement…",
            description: `Implement ${plans}: choose the plan, the model, effort, and context next.`,
          });
        }
        // Once M has a plan, Implement comes first and Revise plan M right after it.
        if (mergeable && merged) actions.push(merge);
        if (first) {
          actions.push({
            id: "export",
            label: "Export…",
            description: `Write ${plans} to a Markdown file: choose the plan and the path next.`,
          });
        }
        if (agents.length > 0) {
          actions.push({
            id: "discard",
            label: "Discard",
            description: "Stop the planners and throw these plans away. (Esc hides the screen and keeps them.)",
          });
        }
        return actions;
      };

      /** Log in to a provider in Pi's login dialog; a planner that had failed then tries again. */
      const loginAndRetry = async (agent: PlannerAgent, providerId = agent.spec.provider) => {
        const back = lanes();
        try {
          await (dependencies.login ?? loginWithDialog)(providerId, (dialog) => show(dialog));
          if (closed || epoch !== branchEpoch) return back.dispose();
          show(back);
          if (agent.status !== "failed") {
            agent.note(`Logged in to ${providerId}.`);
            return;
          }
          ctx.ui.notify(`Logged in to ${providerId}. Planner ${agent.id} is trying again.`, "info");
          void agent.say(resumeMessage("failed"), ctx, "try again (after logging in)");
        } catch (error: unknown) {
          if (closed || epoch !== branchEpoch) return back.dispose();
          show(back);
          const message = errorText(error);
          if (message !== "Login cancelled") ctx.ui.notify(`Login to ${providerId} failed: ${message}`, "error");
        }
      };

      /** What a planner's lane commands use from here. */
      const laneCommandHost = {
        models: () => models.map((spec) => ({ spec, name: catalog.name(spec) })),
        efforts: (spec: ModelSpec) =>
          catalog.efforts(spec).filter((level): level is ThinkingLevel => level !== undefined),
        login: (agent: { id: string }, provider: string) => {
          const planner = run?.agents.find((candidate) => candidate.id === agent.id);
          if (planner) void loginAndRetry(planner, provider);
        },
        copy: (text: string) => copyToClipboard(text),
      };

      const loginWithDialog = async (providerId: string, showDialog: (dialog: Component) => void) => {
        const runtime = await ModelRuntime.create();
        inheritProviders(ctx, runtime);
        const dialog = new LoginDialogComponent(tui, providerId, () => undefined, providerName(runtime, providerId));
        dialog.focused = true;
        showDialog(dialog);
        await loginInDialog(runtime, providerId, dialog, () =>
          SettingsManager.create(ctx.cwd, getAgentDir()).getOrCreateDeviceId(),
        );
      };

      const onLaneAction = (id: string) => {
        const [kind, sourceId] = id.split(":");
        // The merged plan comes first: once there is one, it is usually the one to build.
        const first = sources()[0];
        if (kind === "implement" && first) return show(implementPage(first));
        if (kind === "export" && first) return show(exportPage(first));
        if (kind === "login") {
          const agent = run?.agents.find((candidate) => candidate.id === sourceId);
          if (agent) void loginAndRetry(agent);
          return;
        }
        if (kind === "resume") {
          const agent = run?.agents.find((candidate) => candidate.id === sourceId);
          if (agent) resumePlanner(agent, ctx);
          return;
        }
        if (kind === "discard") {
          disposeRun("discarded");
          return close();
        }
      };

      // --- Settings ----------------------------------------------------------------------------

      const catalog = modelCatalog(ctx);
      const implementationCatalog = modelCatalog(ctx, "available");
      const models = availableModels(ctx);
      const sessionLevel = pi.getThinkingLevel() as ThinkingLevel;
      const effortsOf = (spec: ModelSpec): ThinkingLevel[] =>
        catalog.efforts(spec).filter((level): level is ThinkingLevel => level !== undefined);
      const withEffort = (spec: ModelSpec, level?: ThinkingLevel): ModelSpec => {
        const levels = effortsOf(spec);
        if (levels.length === 0) return { provider: spec.provider, modelId: spec.modelId };
        const wanted = level ?? spec.thinkingLevel ?? sessionLevel;
        const chosen = levels.includes(wanted)
          ? wanted
          : levels.includes(sessionLevel)
            ? sessionLevel
            : levels[levels.length - 1];
        return { provider: spec.provider, modelId: spec.modelId, ...(chosen ? { thinkingLevel: chosen } : {}) };
      };
      const configured = configuredPlanners(settings);
      const sessionSpec: ModelSpec | undefined = ctx.model
        ? { provider: ctx.model.provider, modelId: ctx.model.id }
        : undefined;
      const firstPlanner = configured[0] ?? sessionSpec ?? models[0];
      if (!firstPlanner) {
        ctx.ui.notify("No models are available to plan with.", "error");
        close();
        return { render: () => [], invalidate() {}, handleInput() {} };
      }
      const draft: Draft = {
        task,
        planners: [
          withEffort(firstPlanner),
          withEffort(configured[1] ?? models.find((model) => !sameModel(model, firstPlanner)) ?? firstPlanner),
        ],
        scouts: Object.fromEntries(
          Object.entries(settings.scoutModelMap ?? {}).map(([key, spec]) => [
            key,
            withEffort(spec, spec.thinkingLevel ?? SUBAGENT_EFFORT),
          ]),
        ),
        timeLimit: Math.round(configuredPlannerTimeoutSeconds(settings) / 60),
      };
      const describe = (spec: ModelSpec | undefined) => (spec ? catalog.name(spec) : theme.fg("dim", "none"));
      const cycleModel = (current: ModelSpec | undefined, direction: 1 | -1, allowNone: boolean) => {
        const options: Array<ModelSpec | undefined> = [...(allowNone ? [undefined] : []), ...models];
        const index = options.findIndex((option) =>
          option && current ? sameModel(option, current) : option === current,
        );
        const next = options[(index + direction + options.length) % options.length];
        return next ? withEffort(next, current?.thinkingLevel) : undefined;
      };
      const cycleEffort = (spec: ModelSpec, direction: 1 | -1) => {
        const levels = effortsOf(spec);
        if (levels.length === 0) return spec;
        const index = Math.max(0, levels.indexOf(spec.thinkingLevel ?? sessionLevel));
        return { ...spec, thinkingLevel: levels[(index + direction + levels.length) % levels.length] };
      };
      const scoutFor = (spec: ModelSpec | undefined) => (spec ? draft.scouts[formatModelKey(spec)] : undefined);
      const setScout = (spec: ModelSpec | undefined, direction: 1 | -1) => {
        if (!spec) return;
        const current = scoutFor(spec);
        const options: Array<ModelSpec | undefined> = [undefined, ...models];
        const index = options.findIndex((option) =>
          option && current ? sameModel(option, current) : option === current,
        );
        const next = options[(index + direction + options.length) % options.length];
        draft.scouts[formatModelKey(spec)] = next
          ? withEffort(next, current?.thinkingLevel ?? SUBAGENT_EFFORT)
          : undefined;
      };
      const setScoutEffort = (spec: ModelSpec | undefined, direction: 1 | -1) => {
        const scout = scoutFor(spec);
        if (spec && scout) draft.scouts[formatModelKey(spec)] = cycleEffort(scout, direction);
      };
      const plannerRows = (index: 0 | 1): OptionRow[] => {
        const id = IDS[index];
        const get = () => draft.planners[index];
        return [
          {
            id: `planner-${id}`,
            label: `Planner ${id}`,
            ...(index === 0 ? { section: "Planners" } : {}),
            value: () => describe(get()),
            cycle: (direction) => {
              draft.planners[index] = cycleModel(get(), direction, false) ?? draft.planners[index];
            },
            description:
              index === 0
                ? `One of the two models that plan the same task in parallel. ${get() ? catalog.details(get() as ModelSpec) : ""}`
                : `The other model, planning the same task in parallel, to compare or merge. For one plan, use /plan in your conversation instead. ${get() ? catalog.details(get() as ModelSpec) : ""}`,
          },
          {
            id: `effort-${id}`,
            label: `  effort`,
            value: () => {
              const spec = get();
              return spec
                ? effortsOf(spec).length
                  ? effortText(theme, spec.thinkingLevel)
                  : theme.fg("dim", "n/a")
                : "";
            },
            cycle: (direction) => {
              const spec = get();
              if (spec) draft.planners[index] = cycleEffort(spec, direction);
            },
            description: `How hard planner ${id} thinks (its thinking level).`,
            hidden: () => !get(),
          },
          {
            id: `scouts-${id}`,
            label: `  subagents`,
            value: () => describe(scoutFor(get())),
            cycle: (direction) => setScout(get(), direction),
            description: `Read-only helpers planner ${id} can fan out for broad investigations (plan_subagents), on this model. "none" turns them off.`,
            hidden: () => !get(),
          },
          {
            id: `scouts-effort-${id}`,
            label: `    effort`,
            value: () => {
              const scout = scoutFor(get());
              if (!scout) return "";
              return effortsOf(scout).length ? effortText(theme, scout.thinkingLevel) : theme.fg("dim", "n/a");
            },
            cycle: (direction) => setScoutEffort(get(), direction),
            description: `How hard planner ${id}'s subagents think (their thinking level).`,
            hidden: () => !scoutFor(get()),
          },
        ];
      };

      const settingsPage = () => {
        const optionRows: OptionRow[] = [
          {
            id: "task",
            label: "Task",
            value: () => (draft.task ? (draft.task.split("\n")[0] ?? "") : theme.fg("dim", "(from the conversation)")),
            text: {
              get: () => draft.task,
              set: (value) => (draft.task = value),
              placeholder: "(from the conversation) tab to write what to plan",
              multiline: true,
            },
            description:
              "What to plan. Tab moves in and out of it; shift+⏎ starts a new line. Leave it empty to plan what the conversation so far is about.",
          },
          ...plannerRows(0),
          ...plannerRows(1),
          {
            id: "time",
            label: "Time limit",
            value: () => `${draft.timeLimit} min`,
            cycle: (direction) => {
              const index = Math.max(0, TIME_LIMITS.indexOf(draft.timeLimit as never));
              draft.timeLimit =
                TIME_LIMITS[Math.min(TIME_LIMITS.length - 1, Math.max(0, index + direction))] ?? draft.timeLimit;
            },
            description:
              "How long a planner may work on one turn. At 80% it is asked to wrap up; at the limit it is stopped.",
          },
          {
            id: "jev",
            label: "System 1 tool picks",
            section: "Preferences",
            value: () => (settings.jevToolSelection === false ? "off" : "on"),
            cycle: () => {
              const next = settings.jevToolSelection === false;
              settings = { ...settings, jevToolSelection: next };
              saveSettings({ jevToolSelection: next });
            },
            description: "Preselect the planners' tools from the task using the classifier selected in /system1.",
          },
          {
            id: "rendered",
            label: "Rendered plans",
            value: () =>
              renderBlock ? theme.fg("dim", "unavailable") : settings.renderedPlans === false ? "off" : "on",
            ...(renderBlock
              ? {}
              : {
                  cycle: () => {
                    const next = settings.renderedPlans === false;
                    settings = { ...settings, renderedPlans: next };
                    saveSettings({ renderedPlans: next });
                  },
                }),
            description: renderBlock
              ? `Show each finished plan as a styled page in its lane (drawn by terminal-browser). Unavailable here: ${renderBlock}.`
              : "Once a plan is in, its lane shows it as a styled page rendered by terminal-browser (diagrams included) instead of terminal text. \u2191/\u2193, PgUp/PgDn, Home/End and the wheel scroll it; \u2190/\u2192 still switch to the chat.",
          },
          {
            id: "completion-review",
            label: "Completion review",
            value: () => (settings.completionReview === false ? "off" : "on"),
            cycle: () => {
              const next = settings.completionReview === false;
              settings = { ...settings, completionReview: next };
              saveSettings({ completionReview: next });
            },
            description:
              "Require planner acceptance to complete handed-off work (extra model turns, cost shown separately). It inspects evidence without running tests. An unavailable planner pauses execution.",
          },
          {
            id: "completion-max-revisions",
            label: "Review revisions",
            value: () => String(configuredCompletionMaxRevisions(settings)),
            cycle: (direction) => {
              const next = (configuredCompletionMaxRevisions(settings) + direction + 6) % 6;
              settings = { ...settings, completionMaxRevisions: next };
              saveSettings({ completionMaxRevisions: next });
            },
            description:
              "Automatic fix cycles permitted after the initial completion review (0–5). Zero still reviews once; exhausted cycles pause for the user.",
          },
          {
            id: "context",
            label: "Implement in",
            value: () =>
              configuredImplementationContext(settings) === "clear" ? "a fresh session" : "this conversation",
            cycle: () => {
              const next: ImplementationContextChoice =
                configuredImplementationContext(settings) === "clear" ? "keep" : "clear";
              settings = { ...settings, defaultImplementationContext: next };
              saveSettings({ defaultImplementationContext: next });
            },
            description:
              "Where implementation starts by default: this conversation with the plan, or a fresh session with only the plan.",
          },
          {
            id: "export",
            label: "Export to",
            value: () => configuredPlanExportPath(settings),
            text: {
              get: () => configuredPlanExportPath(settings),
              set: (value) => {
                settings = { ...settings, defaultPlanExportPath: value || undefined };
                saveSettings({ defaultPlanExportPath: value || null });
              },
              placeholder: "PLAN.md",
            },
            description: "Default file for Export (relative to the project).",
          },
        ];
        const optionsPage = new OptionsPage(theme, {
          title: "Planners",
          context: () => "settings",
          step: "Settings",
          rows: optionRows,
          next: { label: "next: tools", run: () => show(toolsPage()) },
          back: { label: "close", run: close },
          rowsAvailable: rows,
          requestRender: render,
          createTextArea,
          onChange: (row) => {
            if (row.id.startsWith("planner") || row.id.startsWith("effort")) {
              const planners = draft.planners.filter((spec): spec is ModelSpec => spec !== undefined);
              saveSettings({ planners });
            }
            if (row.id.startsWith("scouts")) {
              const map = Object.fromEntries(
                Object.entries(draft.scouts).filter((entry): entry is [string, ModelSpec] => entry[1] !== undefined),
              );
              settings = { ...settings, scoutModelMap: map };
              saveSettings({ scoutModelMap: map });
            }
            if (row.id === "time") saveSettings({ plannerTimeoutSeconds: draft.timeLimit * 60 });
          },
        });
        return optionsPage;
      };

      // --- Tools -------------------------------------------------------------------------------

      let tree:
        | { roots: ToolNode[]; others: OtherTool[]; touched: boolean; preselection?: ToolPreselection }
        | undefined;
      const toolsPage = () => {
        if (!tree) {
          const toolsets = settings.plannerToolsets ?? {};
          const catalogMcp = Object.values(toolsets).some((toolset) => toolset.mcp)
            ? buildMcpCatalog(safeAllTools(pi), readConfiguredMcpServers(ctx.cwd, getAgentDir()))
            : [];
          const scoutTargets = Object.values(draft.scouts)
            .filter(Boolean)
            .map((spec) => formatModelSpec(spec as ModelSpec));
          const roots = buildToolTree({
            toolsets,
            mcpCatalog: catalogMcp,
            scoutTargets,
            grants: settings.commandGrants ?? {},
          });
          const covered = new Set(Object.values(toolsets).flatMap((toolset) => toolset.tools));
          const others = otherTools(safeAllTools(pi), covered, EXTENSION_ENTRY_PATH);
          const otherNode = otherToolsNode(others);
          if (otherNode) roots.push(otherNode);
          applyAlwaysOffer(roots, configuredAlwaysOffer(settings));
          tree = { roots, others, touched: false };
          if (settings.jevToolSelection !== false) {
            const config = {
              provider: settings.jevProvider?.trim() || DEFAULT_JEV_PROVIDER,
              model: settings.jevModel?.trim() || DEFAULT_JEV_MODEL,
            };
            const target = resolveSystem1Route(config);
            const selectionEpoch = system1Epoch;
            const selectionCurrent = () =>
              !closed &&
              runtimeActive &&
              epoch === branchEpoch &&
              selectionEpoch === system1Epoch &&
              resolveSystem1Target(config).key === target.key;
            tree.preselection = {
              label: target.ok
                ? target.targets.map((candidate) => (candidate.backend === "jev" ? "Jev" : "Decisions")).join(" → ")
                : "unavailable",
              pending: (dependencies.pickTools ?? pickToolsWithJev)({
                task: draft.task,
                conversation: buildPlannerTranscript(ctx.sessionManager.getBranch()),
                cwd: ctx.cwd,
                capabilities: leafCapabilities(roots),
                registry: ctx.modelRegistry,
                ...(settings.jevThreshold !== undefined ? { threshold: settings.jevThreshold } : {}),
                ...config,
              }).then((result) => {
                const isCurrent = () =>
                  selectionCurrent() && (result.kind !== "jev" || result.selectionKey === target.key);
                return {
                  message:
                    result.kind === "jev"
                      ? `${result.backend === "jev" ? "Jev" : "Decisions"}${result.fallback ? " (fallback)" : ""} picked ${Object.values(result.selected).filter(Boolean).length} tools for this task.`
                      : `Not used (${result.reason}); the defaults from settings apply.`,
                  isCurrent,
                  apply: (keep: boolean) => {
                    if (isCurrent()) applyJevPick(roots, result, keep);
                  },
                };
              }),
            };
          }
        }
        const current = tree;
        const preselection = current.preselection;
        current.preselection = undefined;
        const count = draft.planners.filter(Boolean).length;
        return new ToolTreeView(theme, {
          title: "Planners",
          ...(draft.task ? { task: draft.task.split("\n")[0] } : {}),
          notes: [],
          roots: current.roots,
          startLabel: `Start planning with ${count} planner${count === 1 ? "" : "s"}`,
          ...(preselection ? { preselection } : {}),
          rows,
          requestRender: render,
          onDone: (result) => {
            if (result.kind === "back" || result.kind === "cancel") return show(settingsPage());
            void startRun(ctx);
          },
        });
      };

      // --- Implement ---------------------------------------------------------------------------

      const implementPage = (first: PlanSource) => {
        let author = first;
        const ready = sources;
        const flow = queryFlow(pi.events);
        const linked = flow?.operatingMode === "linked";
        const linkedFlow = linked ? structuredClone(flow) : undefined;
        const worker = linkedImplementationChoice(flow, implementationCatalog.available);
        let mode: "here" | "handoff" = linked ? "handoff" : "here";
        let context: ImplementationContextChoice | "compact" = configuredImplementationContext(settings);
        const efforts = new Map<string, ModelSpec>();
        let recommendation: ThinkingLevel | undefined;
        let recommendationSource: EffortSource = "fallback";
        let effortPending = false;
        let effortController: AbortController | undefined;
        let effortRequest: ImplementationEffortRequest | undefined;
        let effortRevision = 0;
        let alive = true;
        const choices = () =>
          linked
            ? worker
              ? [worker.spec]
              : []
            : implementationChoices({
                planModel: author.spec ?? sessionSpec,
                map: settings.implementationModelMap,
                available: implementationCatalog.available,
              })
                .map(({ spec }) => spec)
                .filter((spec) => !sessionSpec || !sameModel(spec, sessionSpec));
        const pinnedEffort = (spec: ModelSpec, direct = false): ThinkingLevel | undefined =>
          direct
            ? undefined
            : linked
              ? worker?.thinkingPinned
                ? spec.thinkingLevel
                : undefined
              : (spec.thinkingLevel ?? settings.defaultImplementationThinkingLevel);
        const remembered = (spec: ModelSpec, direct = false) =>
          efforts.get(formatModelKey(spec)) ??
          normalizedSpec(
            ctx,
            spec,
            pinnedEffort(spec, direct) ??
              recommendation ??
              (direct || (linked && context !== "clear") ? sessionLevel : (spec.thinkingLevel ?? "medium")),
          );
        const here = sessionSpec ?? firstPlanner;
        let target = remembered(worker?.spec ?? here, !linked);
        const rawTarget = () =>
          mode === "here"
            ? here
            : linked
              ? (worker?.spec ?? here)
              : (choices().find((spec) => sameModel(spec, target)) ?? target);
        const refreshEffort = () => {
          target = remembered(rawTarget(), mode === "here");
        };
        const defaultPending = () =>
          effortPending &&
          !efforts.has(formatModelKey(target)) &&
          pinnedEffort(rawTarget(), mode === "here") === undefined &&
          implementationCatalog.efforts(target).some((level) => level !== undefined);
        const authorCurrent = () =>
          ready().some(
            (source) => source.id === author.id && source.revision === author.revision && source.plan === author.plan,
          );
        const chooseEffort = () => {
          effortController?.abort();
          const controller = new AbortController();
          effortController = controller;
          const revision = ++effortRevision;
          recommendation = undefined;
          recommendationSource = "fallback";
          effortPending = false;
          refreshEffort();
          const request = implementationEffortRequest(
            ctx,
            author.plan,
            [run?.task, buildPlannerTranscript(ctx.sessionManager.getBranch(), 4_000)].filter(Boolean).join("\n\n"),
          );
          if (effortRequest !== request) {
            effortRequest?.dispose();
            effortRequest = request;
          }
          if (
            efforts.has(formatModelKey(target)) ||
            pinnedEffort(rawTarget(), mode === "here") !== undefined ||
            !implementationCatalog.efforts(target).some((level) => level !== undefined)
          )
            return;
          const pending = request.pick(target, controller.signal);
          effortPending = true;
          void pending.then((result) => {
            if (!alive || revision !== effortRevision) return;
            effortPending = false;
            if (!controller.signal.aborted && request.isCurrent() && authorCurrent()) {
              recommendation = result.kind === "system1" ? result.thinkingLevel : undefined;
              recommendationSource = result.kind === "system1" ? "system1" : "fallback";
              refreshEffort();
            }
            if (!closed && epoch === branchEpoch) render();
          });
        };
        const resetTarget = () => {
          const offered = choices();
          if (!offered.length && linked) return;
          if (!offered.length) mode = "here";
          target = remembered(mode === "here" ? here : (offered[0] as ModelSpec), mode === "here");
        };
        const optionRows: OptionRow[] = [
          {
            id: "plan",
            label: "Plan",
            value: () =>
              `${author.id}${author.id === MERGED_ID ? " (merged)" : ""} · ${author.name}${author.revision > 1 ? ` v${author.revision}` : ""}`,
            cycle: (direction) => {
              const list = ready();
              const index = list.findIndex((source) => source.id === author.id);
              author = list[(index + direction + list.length) % list.length] ?? author;
              resetTarget();
              chooseEffort();
            },
            description: "Which plan to implement.",
            hidden: () => ready().length < 2,
          },
          {
            id: "mode",
            label: "Mode",
            value: () => (mode === "here" ? "Here" : "Handoff"),
            cycle: () => {
              mode = mode === "here" ? "handoff" : "here";
              resetTarget();
              chooseEffort();
            },
            hidden: () => linked || choices().length === 0,
            description: "Implement normally in this conversation, or hand off to a configured model.",
          },
          {
            id: "model",
            label: "Model",
            value: () => (linked && !worker ? "unavailable" : implementationCatalog.name(target)),
            cycle: (direction) => {
              if (linked || mode === "here") return;
              const offered = choices();
              const index = offered.findIndex((spec) => sameModel(spec, target));
              const next = offered[(index + direction + offered.length) % offered.length];
              if (next) {
                target = remembered(next);
                chooseEffort();
              }
            },
            description: linked
              ? "Execute with linked worker. Use /flow independent before choosing a different implementation model."
              : "The model that implements; handoffs use only the plan author's configured targets.",
          },
          {
            id: "effort",
            label: "Effort",
            value: () =>
              implementationCatalog.efforts(target).some(Boolean)
                ? defaultPending()
                  ? theme.fg("dim", "choosing...")
                  : effortText(theme, target.thinkingLevel)
                : theme.fg("dim", "n/a"),
            cycle: (direction) => {
              const levels = implementationCatalog
                .efforts(target)
                .filter((level): level is ThinkingLevel => level !== undefined);
              if (levels.length) {
                const index = Math.max(0, levels.indexOf(target.thinkingLevel ?? sessionLevel));
                target = { ...target, thinkingLevel: levels[(index + direction + levels.length) % levels.length] };
                efforts.set(formatModelKey(target), target);
              }
            },
            description: "System 1 picks the default from the plan. Left/Right overrides it for this approval.",
          },
          {
            id: "context",
            label: "Context",
            value: () =>
              context === "compact"
                ? "compact to plan (same session)"
                : mode === "here"
                  ? context === "clear"
                    ? "compact to plan (same session)"
                    : "keep conversation"
                  : context === "clear"
                    ? "fresh session with only the plan"
                    : "this conversation, plus the plan",
            cycle: () => {
              context = linked
                ? context === "keep"
                  ? "compact"
                  : context === "compact"
                    ? "clear"
                    : "keep"
                : context === "clear"
                  ? "keep"
                  : "clear";
              refreshEffort();
            },
            description: linked
              ? "Retain this conversation, compact to the approved plan, or start a fresh child with only the plan."
              : "Here keeps the same session. Handoff can instead start a fresh child with only the plan.",
          },
        ];
        const implementationPage = new OptionsPage(theme, {
          title: "Implement",
          context: () => `plan ${author.id}`,
          step: "Implement",
          rows: optionRows,
          intro: () =>
            linked
              ? [
                  worker
                    ? `Execute with linked worker: ${implementationCatalog.name(worker.spec)}`
                    : "Linked worker unavailable. Use /flow status or /flow independent.",
                ]
              : [],
          next: {
            label: linked ? "Execute with linked worker" : "implement",
            run: () => {
              if ((linked && !worker) || defaultPending()) return;
              if (!authorCurrent() || !effortRequest?.isCurrent()) {
                ctx.ui.notify("Implementation choice expired; reopen Implement to approve it again.", "warning");
                return;
              }
              close();
              void implement(
                ctx,
                author,
                target,
                context,
                mode,
                linkedFlow,
                efforts.has(formatModelKey(target))
                  ? "manual"
                  : pinnedEffort(rawTarget(), mode === "here") !== undefined
                    ? "configured"
                    : recommendationSource,
              );
            },
          },
          back: { label: "back to the plans", run: () => show(lanes(true)) },
          rowsAvailable: rows,
          requestRender: render,
        });
        // Planner updates arrive through app.render(), before the next screen paint.
        // Refresh here rather than initiating classifier work inside component.render().
        const refresh = () => {
          if (!alive) return;
          const latest = ready().find((source) => source.id === author.id);
          if (!latest || (latest.revision === author.revision && latest.plan === author.plan)) return;
          author = latest;
          resetTarget();
          chooseEffort();
        };
        refreshImplementation = refresh;
        const dispose = implementationPage.dispose.bind(implementationPage);
        implementationPage.dispose = () => {
          alive = false;
          if (refreshImplementation === refresh) refreshImplementation = undefined;
          effortController?.abort();
          effortRequest?.dispose();
          dispose();
        };
        chooseEffort();
        return implementationPage;
      };

      // --- Export ------------------------------------------------------------------------------

      /** Write a plan to a Markdown file: which plan, and where (the path from the settings). */
      const exportPage = (first: PlanSource) => {
        let source = first;
        let path = configuredPlanExportPath(settings);
        const optionRows: OptionRow[] = [
          {
            id: "plan",
            label: "Plan",
            value: () =>
              `${source.id}${source.id === MERGED_ID ? " (merged)" : ""} · ${source.name}${source.revision > 1 ? ` v${source.revision}` : ""}`,
            cycle: (direction) => {
              const list = sources();
              const index = list.findIndex((candidate) => candidate.id === source.id);
              source = list[(index + direction + list.length) % list.length] ?? source;
            },
            description: "Which plan to export.",
            hidden: () => sources().length < 2,
          },
          {
            id: "path",
            label: "Path",
            value: () => path,
            text: { get: () => path, set: (value) => (path = value), placeholder: "PLAN.md" },
            description: "The file to write, relative to the project (⏎ edits it).",
          },
        ];
        return new OptionsPage(theme, {
          title: "Export",
          context: () => `plan ${source.id}`,
          step: "Review",
          rows: optionRows,
          intro: () => [],
          next: {
            label: "export",
            run: () => {
              const chosen = source;
              show(lanes(true));
              void exportPlanToFile(
                chosen.plan,
                path.trim() || undefined,
                ctx.cwd,
                undefined,
                () => true,
                configuredPlanExportPath(settings),
              )
                .then((result) => {
                  ctx.ui.notify(`Plan ${chosen.id} exported to ${result.path}.`, "info");
                  hook(ctx, chosen);
                })
                .catch((error: unknown) => ctx.ui.notify(`Export failed: ${errorText(error)}`, "error"));
            },
          },
          back: { label: "back to the plans", run: () => show(lanes(true)) },
          rowsAvailable: rows,
          requestRender: render,
        });
      };

      // --- Starting planners --------------------------------------------------------

      const startRun = async (context: ExtensionCommandContext) => {
        const current = tree;
        if (!current) return;
        const seed = context.sessionManager.buildSessionProjection().messages;
        const runId = randomUUID();
        run = {
          id: runId,
          createdAt: Date.now(),
          task: draft.task,
          agents: [],
          delivered: new Map(),
          failuresReported: new Set(),
          mergerShown: false,
          launch: { roots: current.roots, others: current.others, seed },
        };
        activity.reset();
        offerActivity();
        setMainToolsActive(pi, true);
        const specs = draft.planners.filter((spec): spec is ModelSpec => spec !== undefined);
        const lanesPage = lanes();
        show(lanesPage);
        for (const [index, spec] of specs.entries()) launchPlanner(context, IDS[index] ?? "A", spec, specs.length);
        persistRun();
      };

      const launchPlanner = (context: ExtensionCommandContext, id: string, spec: ModelSpec, count: number) => {
        if (!run?.launch) return;
        const scout = scoutFor(spec);
        const access = resolveAccess({
          roots: run.launch.roots,
          toolsets: settings.plannerToolsets ?? {},
          grants: settings.commandGrants ?? {},
          others: run.launch.others,
          scout,
          ...(settings.safeSubcommands ? { safeSubcommands: settings.safeSubcommands } : {}),
          guardExtensionPath: EXTENSION_ENTRY_PATH,
          expandPath: expandHome,
          scoutProviderExtensions: extensionsForProvider(
            resolveProviderExtensions(safeCommands(pi), settings.providerExtensions, expandHome),
            scout?.provider,
          ),
        });
        const epoch = branchEpoch;
        const agent = new PlannerAgent({
          id,
          family: discoverFamily(pi.events),
          familyOperationId: `plan:${run.id}:${id}`,
          spec,
          name: catalog.name(spec),
          cwd: context.cwd,
          access: access.config,
          timeoutMs: draft.timeLimit * 60_000,
          sessionDir: plannerSessionDir(),
          seed: run.launch.seed,
          onChange: () => {
            if (epoch === branchEpoch) onAgentChange();
          },
          ...(dependencies.createSession ? { createSession: dependencies.createSession } : {}),
        });
        run.agents.push(agent);
        const prompt = plannerTaskPrompt({
          task: run.task,
          planners: count,
          ...(access.scoutLabel ? { scoutLabel: access.scoutLabel } : {}),
          tools: access.extraTools,
          ...(access.mcpAllow ? { mcpAllow: access.mcpAllow } : {}),
          grants: access.grants,
        });
        void agent.start(prompt, context);
      };

      // Open where you left off: the plans, or a new plan's settings.
      page = run ? lanes() : settingsPage();
      const component: Component & {
        dispose(): void;
        [EDITOR_SURFACE]: string;
        [INPUT_CONTEXT](): string;
        [EDITOR_MODE](): unknown;
        focused: boolean;
      } = {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          if (page) page.focused = value;
        },
        render: (width) => {
          if (closed || epoch !== branchEpoch) return [];
          publishFocus();
          return page.render(width).slice(0, rows());
        },
        invalidate: () => {
          if (!closed && epoch === branchEpoch) page.invalidate?.();
        },
        handleInput: (data) => {
          if (!closed && epoch === branchEpoch) {
            page.handleInput?.(data);
            publishFocus();
          }
        },
        dispose: close,
        [EDITOR_SURFACE]: "embedded",
        [INPUT_CONTEXT]: () => readInputContext(page) ?? "list",
        [EDITOR_MODE]: () => readEditorMode(page),
      };
      const publishFocus = () => {
        if (page instanceof LanesPage) family?.focus(page.viewedAgentId());
      };
      (component as { handleMouse?: unknown }).handleMouse = (event: unknown) => {
        if (!closed && epoch === branchEpoch) {
          const result = (page as { handleMouse?(event: unknown): unknown }).handleMouse?.(event);
          publishFocus();
          return result;
        }
      };
      return component;
    });
  }

  // --- Talking and implementing --------------------------------------------------------------

  function hook(ctx: ExtensionContext, source: PlanSource) {
    if (!settings.planCompleteCommand) return;
    const spec = source.spec ?? (ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined);
    void runPlanCompleteHook({
      command: settings.planCompleteCommand,
      plan: source.plan,
      cwd: ctx.cwd,
      ...(spec ? { model: { provider: spec.provider, modelId: spec.modelId } } : {}),
    } as Parameters<typeof runPlanCompleteHook>[0]);
  }

  async function implement(
    ctx: ExtensionCommandContext,
    source: PlanSource,
    target: ModelSpec,
    context: ImplementationContextChoice | "compact",
    mode: "here" | "handoff",
    linkedFlow?: FlowState,
    effortSource: EffortSource = "fallback",
  ) {
    if (!flowCurrent(linkedFlow)) {
      ctx.ui.notify("Implementation selection expired because the flow changed. Approve the plan again.", "warning");
      return;
    }
    const epoch = branchEpoch;
    const plan = source.plan;
    hook(ctx, source);
    const authorFile = run?.agents.find((agent) => agent.id === source.id)?.sessionFile;
    const before = sessionSpecOf(ctx);
    const catalog = modelCatalog(ctx, "available");
    const planFile = writePlanFile(plansDirectoryPath(settings.plansDirectory), plan);
    if (!linkedFlow && (mode === "here" || (before && sameModel(before, target)))) {
      if (!(await inline.work(ctx))) return;
      disposeRun("implemented");
      applyDirectEffort(ctx, target.thinkingLevel);
      const brief = directImplementationBrief({ plan, planFile });
      if (context === "clear") compactDirect(ctx, planFile, brief);
      else pi.sendUserMessage(brief);
      return;
    }
    // Linked handoffs retain Plan guards until the coordinator commits worker + Exec.
    if (linkedFlow) {
      await inline.enter(ctx, planFile);
      if (!inline.active || !flowCurrent(linkedFlow)) return;
    }
    // A failed switch must never silently turn a handoff into ordinary execution.
    const workflowRevision = inline.revision;
    const live = () =>
      runtimeActive &&
      epoch === branchEpoch &&
      workflowRevision === inline.revision &&
      flowCurrent(linkedFlow) &&
      !ctx.signal?.aborted;
    if (!live()) return;
    if (!linkedFlow && context !== "clear" && (!(await applyRuntime(ctx, target, live)) || !live())) {
      if (live()) await inline.enter(ctx, planFile);
      return;
    }
    if (!linkedFlow) disposeRun("implemented");
    let planner: ExecState["planner"];
    let consultant: ConsultantSeed | undefined;
    try {
      if (source.id !== MERGED_ID && authorFile && source.spec) {
        consultant = {
          spec: formatModelSpec(source.spec),
          name: source.name,
          messages: readSessionMessages(authorFile, ctx.cwd),
        };
      } else if (source.id === MERGED_ID) {
        const spec = source.spec ?? before;
        if (spec)
          consultant = {
            spec: formatModelSpec(spec),
            name: catalog.name(spec),
            messages: ctx.sessionManager.buildSessionProjection().messages,
          };
      }
      if (consultant && context !== "clear") {
        const file = writeSeededSession(ctx.cwd, plannerSessionDir(), consultant.messages);
        if (file) planner = { spec: consultant.spec, name: consultant.name, sessionFile: file };
      }
    } catch (error: unknown) {
      ctx.ui.notify(`The planner could not be put on call (${errorText(error)}); implementing without it.`, "warning");
    }
    const state: ExecState = {
      active: true,
      planFile,
      implementer: catalog.name(target),
      implementerModel: formatModelKey(target),
      ...(linkedFlow ? { linkedFlow: structuredClone(linkedFlow) } : {}),
      ...(planner ? { planner } : {}),
      ...(before && !sameModel(before, target)
        ? { restore: formatModelSpec(before), restoreName: catalog.name(before) }
        : {}),
      asks: 0,
      costUsd: 0,
    };
    const brief = implementationBrief({
      plan,
      planFile,
      context: context === "clear" ? "fresh" : "here",
      ...(planner || consultant ? { planner: planner?.name ?? consultant?.name } : {}),
    });
    if (context === "clear") return implementFresh(ctx, target, state, brief, consultant, undefined, effortSource);
    if (linkedFlow) {
      const start = async () => {
        if (
          !(await applyRuntime(ctx, target, live, {
            flow: linkedFlow,
            planFile,
            effort: { ...target, source: effortSource },
            commit: () => {
              inline.commitExecution(ctx);
              exec.begin(ctx, state, { record: true });
              disposeRun("implemented");
            },
          }))
        )
          return;
        pi.sendUserMessage(brief);
      };
      if (context === "compact") compactDirect(ctx, planFile, brief, start, live);
      else await start();
      return;
    }
    exec.begin(ctx, state, { record: true });
    pi.sendUserMessage(brief);
  }

  function normalizedSpec(ctx: ExtensionContext, spec: ModelSpec, level: ModelSpec["thinkingLevel"]): ModelSpec {
    const thinkingLevel = normalizeEffort(level, modelCatalog(ctx, "available").efforts(spec));
    return { provider: spec.provider, modelId: spec.modelId, ...(thinkingLevel ? { thinkingLevel } : {}) };
  }

  function applyDirectEffort(ctx: ExtensionContext, level: ModelSpec["thinkingLevel"]) {
    const current = sessionSpecOf(ctx);
    if (!current) return;
    const normalized = normalizedSpec(ctx, current, level ?? current.thinkingLevel);
    if (normalized.thinkingLevel)
      withEffortOrigin("plan-mode", () => pi.setThinkingLevel(normalized.thinkingLevel as never));
  }

  /** Replace only this explicitly requested compaction; never intercept ordinary compaction. */
  function compactDirect(
    ctx: ExtensionCommandContext,
    planFile: string,
    brief: string,
    after?: () => Promise<void>,
    isCurrent: () => boolean = () => true,
  ) {
    const pending = {
      marker: `plan-mode-direct:${randomUUID()}`,
      epoch: branchEpoch,
      planFile,
      brief,
      overridden: false,
      isCurrent,
    };
    pendingCompaction = pending;
    const valid = () => pendingCompaction === pending && pending.epoch === branchEpoch && runtimeActive && isCurrent();
    const fail = (error: Error) => {
      if (!valid()) return;
      pendingCompaction = undefined;
      ctx.ui.notify(`Plan compaction failed; implementation did not start: ${errorText(error)}`, "warning");
    };
    try {
      ctx.compact({
        customInstructions: pending.marker,
        onComplete: (result) => {
          if (!valid()) return;
          pendingCompaction = undefined;
          if (!pending.overridden) {
            ctx.ui.notify("Plan compaction was cancelled; implementation did not start.", "warning");
            return;
          }
          const details = result.details as { planMode?: { direct?: unknown } } | undefined;
          if (
            result.summary !== pending.brief ||
            result.firstKeptEntryId !== null ||
            details?.planMode?.direct !== pending.planFile
          ) {
            ctx.ui.notify(
              "Plan compaction was replaced; implementation did not start. The plan file was retained.",
              "warning",
            );
            return;
          }
          if (after) void after();
          else pi.sendUserMessage(brief);
        },
        onError: fail,
      });
    } catch (error: unknown) {
      fail(error instanceof Error ? error : new Error(errorText(error)));
    }
  }

  /** A fresh session (a child of this one) that gets only the plan, on `target`. */
  async function implementFresh(
    ctx: Pick<ExtensionCommandContext, "sessionManager" | "ui" | "waitForIdle" | "newSession">,
    target: ModelSpec,
    state: ExecState,
    brief: string,
    consultant?: ConsultantSeed,
    isCurrent: () => boolean = () => true,
    effortSource: EffortSource = "fallback",
  ) {
    const epoch = branchEpoch;
    const workflowRevision = inline.revision;
    const live = () =>
      runtimeActive &&
      epoch === branchEpoch &&
      workflowRevision === inline.revision &&
      flowCurrent(state.linkedFlow) &&
      isCurrent();
    const recover = async () => {
      // Inline fresh handoffs retain Plan throughout; command handoffs may need recovery.
      if (live() && !inline.active && hostCtx) await inline.enter(hostCtx, state.planFile);
    };
    const parentSession = ctx.sessionManager.getSessionFile();
    const planFile = state.planFile;
    const implementerModel = state.implementerModel;
    let sent = false;
    let membership: FamilyMembership | undefined;
    try {
      await ctx.waitForIdle();
      if (!live()) return;
      membership = await discoverFamily(pi.events)?.prepareHandoff();
      if (!live()) {
        membership?.cancel?.();
        return;
      }
      const result = await ctx.newSession({
        ...(parentSession ? { parentSession } : {}),
        setup: async (sessionManager) => {
          if (membership)
            sessionManager.appendCustomEntry(FAMILY_ENTRY, {
              ...membership,
              sessionId: sessionManager.getSessionId(),
            });
          // Seed both records before session_start, so either extension load order
          // reconciles the worker as Exec rather than substituting Work's model.
          if (state.linkedFlow) {
            sessionManager.appendCustomEntry(FLOW_ENTRY, structuredClone(state.linkedFlow));
            sessionManager.appendCustomEntry(EXEC_ENTRY, structuredClone(state));
          }
          sessionManager.appendCustomEntry(RUNTIME_ENTRY, {
            model: formatModelSpec(target),
            effort: { ...target, source: effortSource },
            exec: state,
            ...(consultant ? { consultant } : {}),
          });
        },
        withSession: async (fresh) => {
          if (sent || !fresh.model || !sameModel({ provider: fresh.model.provider, modelId: fresh.model.id }, target))
            return;
          const latest = [...fresh.sessionManager.getBranch()]
            .reverse()
            .find((entry) => entry.type === "custom" && entry.customType === EXEC_ENTRY);
          const active = latest?.type === "custom" ? (latest.data as Partial<ExecState> | undefined) : undefined;
          if (active?.active !== true || active.planFile !== planFile || active.implementerModel !== implementerModel)
            return;
          if (
            state.linkedFlow &&
            (!active.negotiation?.executionId ||
              JSON.stringify(active.linkedFlow?.selectedFlow) !== JSON.stringify(state.linkedFlow.selectedFlow))
          )
            return;
          sent = true;
          try {
            await fresh.sendUserMessage(brief);
          } catch (error: unknown) {
            fresh.ui.notify(
              `Could not send the implementation brief: ${errorText(error)}. Exec remains active.`,
              "error",
            );
          }
        },
      });
      if (result.cancelled) {
        membership?.cancel?.();
        await recover();
      }
    } catch (error: unknown) {
      membership?.cancel?.();
      if (live()) {
        ctx.ui.notify(`Could not start a fresh session: ${errorText(error)}`, "error");
        await recover();
      }
    }
  }

  function flowCurrent(expected: FlowState | undefined): boolean {
    if (!expected) return queryFlow(pi.events)?.operatingMode !== "linked";
    const current = queryFlow(pi.events);
    return (
      current?.operatingMode === "linked" &&
      current.revision === expected.revision &&
      JSON.stringify(current.selectedFlow) === JSON.stringify(expected.selectedFlow)
    );
  }

  /** Switch only through the coordinator while Linked; lifecycle commit stays synchronous. */
  async function applyRuntime(
    ctx: ExtensionContext,
    target: ModelSpec,
    isCurrent: () => boolean = () => true,
    linked?: {
      flow: FlowState;
      planFile: string;
      phase?: "begin" | "resume";
      expectedExecutionId?: string;
      expectedPlanRevision?: number;
      effort?: ModelSpec & { source: EffortSource };
      commit(): void;
    },
  ): Promise<boolean> {
    const epoch = branchEpoch;
    if (linked || queryFlow(pi.events)?.operatingMode === "linked") {
      if (!linked || !flowCurrent(linked.flow) || !isCurrent()) return false;
      const worker = linked.flow.selectedFlow?.roles.exec;
      if (!worker || !sameModel(worker, target)) return false;
      let committed = false;
      try {
        const result = await requestExecution(pi.events, {
          phase: linked.phase ?? "begin",
          expectedRevision: linked.flow.revision,
          expectedExecutionId: linked.expectedExecutionId,
          expectedPlanRevision: linked.expectedPlanRevision,
          planFile: linked.planFile,
          ...(linked.effort ? { effort: linked.effort } : {}),
          commit: () => {
            if (
              committed ||
              epoch !== branchEpoch ||
              !runtimeActive ||
              ctx.signal?.aborted ||
              !isCurrent() ||
              !flowCurrent(linked.flow)
            )
              throw new Error("Approved plan handoff expired.");
            linked.commit();
            committed = true;
          },
        });
        if (!result?.ok && runtimeActive && epoch === branchEpoch)
          ctx.ui.notify(
            result?.error ?? "Linked flow coordinator unavailable. Implementation did not start.",
            "warning",
          );
        return result?.ok === true && committed && epoch === branchEpoch && runtimeActive;
      } catch (error: unknown) {
        if (runtimeActive && epoch === branchEpoch)
          ctx.ui.notify(`Linked execution failed: ${errorText(error)}`, "warning");
        return false;
      }
    }
    const current = ctx.model;
    let onTarget = true;
    if (!current || current.provider !== target.provider || current.id !== target.modelId) {
      const model = ctx.modelRegistry.find(target.provider, target.modelId);
      let switched = false;
      try {
        switched = Boolean(model && (await withEffortOrigin("plan-mode", () => pi.setModel(model))));
      } catch {
        // Rejected switches fail closed just like an unsuccessful switch.
      }
      if (epoch !== branchEpoch || !runtimeActive || ctx.signal?.aborted || !isCurrent()) return false;
      onTarget = Boolean(switched);
      if (!switched) {
        ctx.ui.notify(
          `Could not switch to ${formatModelSpec(target)}. Implementation did not start; approve the plan again to choose another model.`,
          "warning",
        );
      }
    }
    if (
      onTarget &&
      runtimeActive &&
      epoch === branchEpoch &&
      !ctx.signal?.aborted &&
      isCurrent() &&
      target.thinkingLevel
    )
      withEffortOrigin("plan-mode", () => pi.setThinkingLevel(target.thinkingLevel as never));
    return onTarget && runtimeActive && epoch === branchEpoch && !ctx.signal?.aborted && isCurrent();
  }

  /** A fresh implementation session applies the model and effort chosen for it, once. */
  async function applyPendingRuntime(ctx: ExtensionContext) {
    const entries = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>;
    const pending = [...entries]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === RUNTIME_ENTRY);
    if (!pending) return;
    if (entries.some((entry) => entry.type === "custom" && entry.customType === RUNTIME_CONSUMED_ENTRY)) return;
    const epoch = branchEpoch;
    const workflowRevision = inline.revision;
    const live = () => runtimeActive && epoch === branchEpoch && workflowRevision === inline.revision;
    const {
      exec: savedState,
      consultant,
      model,
      effort,
    } = (pending.data ?? {}) as {
      exec?: ExecState;
      consultant?: ConsultantSeed;
      model?: unknown;
      effort?: unknown;
    };
    const spec = parseModelSpec(model);
    // A supplied approved tuple is authoritative, never a hint to reconstruct.
    // Reject malformed/mismatched seeds before either physical or lifecycle mutation.
    let approvedEffort: (ModelSpec & { source: EffortSource }) | undefined;
    if (pending.data && typeof pending.data === "object" && Object.hasOwn(pending.data, "effort")) {
      if (
        !spec ||
        !effort ||
        typeof effort !== "object" ||
        !("provider" in effort) ||
        effort.provider !== spec.provider ||
        !("modelId" in effort) ||
        effort.modelId !== spec.modelId ||
        !("source" in effort) ||
        !["manual", "configured", "system1", "fallback"].includes(effort.source as string) ||
        ("thinkingLevel" in effort &&
          effort.thinkingLevel !== undefined &&
          !(MODEL_SPEC_THINKING_LEVELS as readonly unknown[]).includes(effort.thinkingLevel)) ||
        ("thinkingLevel" in effort ? effort.thinkingLevel : undefined) !== spec.thinkingLevel
      ) {
        pi.appendEntry(RUNTIME_CONSUMED_ENTRY, {});
        if (live() && !savedState?.linkedFlow && typeof savedState?.planFile === "string" && savedState.planFile)
          await inline.enter(ctx, savedState.planFile);
        ctx.ui.notify("Implementation did not start: invalid approved effort. Approve the plan again.", "warning");
        return;
      }
      approvedEffort = effort as ModelSpec & { source: EffortSource };
    }
    // Linked bootstraps must never fall through to an unprivileged physical setter,
    // including when the coordinator has not initialized yet.
    if (savedState?.linkedFlow) {
      pi.appendEntry(RUNTIME_CONSUMED_ENTRY, {});
      if (
        !spec ||
        savedState.active !== true ||
        !savedState.planFile ||
        savedState.implementerModel !== formatModelKey(spec)
      )
        return;
      const state = structuredClone(savedState);
      const flow = queryFlow(pi.events);
      if (
        flow?.operatingMode === "linked" &&
        JSON.stringify(flow.selectedFlow) === JSON.stringify(state.linkedFlow?.selectedFlow)
      )
        state.linkedFlow = structuredClone(flow);
      if (consultant) {
        try {
          const sessionFile = writeSeededSession(ctx.cwd, plannerSessionDir(), consultant.messages);
          if (sessionFile) state.planner = { spec: consultant.spec, name: consultant.name, sessionFile };
        } catch (error: unknown) {
          ctx.ui.notify(
            `The planner could not be put on call (${errorText(error)}); implementing without it.`,
            "warning",
          );
        }
      }
      if (!live()) return;
      const activated = await applyRuntime(ctx, spec, live, {
        flow: state.linkedFlow as FlowState,
        planFile: state.planFile,
        ...(approvedEffort ? { effort: approvedEffort } : {}),
        commit: () => {
          exec.begin(ctx, state, { record: true });
        },
      });
      if (!activated && live())
        ctx.ui.notify(
          "Linked implementation did not start. Use /flow status or /flow independent to recover.",
          "warning",
        );
      return;
    }
    pi.appendEntry(RUNTIME_CONSUMED_ENTRY, {});
    let activated = false;
    try {
      activated = Boolean(
        spec &&
          savedState?.active === true &&
          typeof savedState.planFile === "string" &&
          savedState.planFile &&
          savedState.implementerModel === formatModelKey(spec) &&
          (await applyRuntime(ctx, spec, live)),
      );
    } catch {
      // Invalid targets and thrown activation failures recover in this replacement runtime too.
    }
    if (!live()) return;
    if (!activated || ctx.signal?.aborted) {
      if (typeof savedState?.planFile === "string" && savedState.planFile) await inline.enter(ctx, savedState.planFile);
      ctx.ui.notify(
        "Implementation did not start. Approve the plan again to choose an implementation model.",
        "warning",
      );
      return;
    }
    if (savedState) {
      const state = structuredClone(savedState);
      if (consultant) {
        try {
          const sessionFile = writeSeededSession(ctx.cwd, plannerSessionDir(), consultant.messages);
          if (sessionFile) state.planner = { spec: consultant.spec, name: consultant.name, sessionFile };
        } catch (error: unknown) {
          ctx.ui.notify(
            `The planner could not be put on call (${errorText(error)}); implementing without it.`,
            "warning",
          );
        }
      }
      if (!live()) return;
      exec.begin(ctx, state, { record: true });
    }
  }
}

function storeAccess(access: PlannerAccessConfig): StoredAccess {
  const scouts = access.policy.scouts;
  return {
    tools: access.tools,
    extensions: access.extensions,
    skills: access.skills,
    ...(access.policy.mcpAllow ? { mcpAllow: [...access.policy.mcpAllow] } : {}),
    grantPrefixes: [...access.policy.grantPrefixes],
    ...(scouts
      ? {
          scouts: {
            spec: formatModelSpec(scouts.spec),
            extensions: [...scouts.extensions],
            tools: [...scouts.tools],
            ...(scouts.mcpAllow ? { mcpAllow: [...scouts.mcpAllow] } : {}),
          },
        }
      : {}),
  };
}

/** A working turn is saved as interrupted: if the process dies, that is what it was. */
function turnState(agent: PlannerAgent): TurnState | undefined {
  if (agent.working) return "interrupted";
  return agent.status === "failed" ? "failed" : undefined;
}

function savedSignature(agent: PlannerAgent, pending?: TurnState) {
  return `${agent.revision}|${agent.sessionFile ?? ""}|${turnState(agent) ?? pending ?? ""}|${agent.label}`;
}

/** A plan you can implement or export: a planner's, or M, the one your main agent merged. */
interface PlanSource {
  id: string;
  name: string;
  revision: number;
  plan: string;
  /** The model that wrote it; for M, your session's model when it was recorded. */
  spec: ModelSpec | undefined;
}

/** How another planner stands, for a delivery message. */
function otherPlannerLine(agent: PlannerAgent) {
  if (agent.status === "asking") return `Planner ${agent.id} is waiting for the user's answers to its questions.`;
  if (agent.working) return `Planner ${agent.id} is still planning.`;
  if (agent.status === "failed") return `Planner ${agent.id} failed${agent.error ? `: ${agent.error}` : ""}.`;
  if (agent.plan)
    return `Planner ${agent.id}'s plan${agent.revision > 1 ? ` v${agent.revision}` : ""} is earlier in this conversation.`;
  return `Planner ${agent.id} has no plan yet.`;
}

/** `pending`: a cut-off turn not resumed yet, kept so a later restore still offers to resume it. */
function storePlanner(agent: PlannerAgent, delivered: Delivered | undefined, pending?: TurnState): StoredPlanner {
  const turn = turnState(agent) ?? pending;
  return {
    id: agent.id,
    spec: agent.label,
    name: agent.name,
    access: storeAccess(agent.access),
    ...(agent.sessionFile ? { sessionFile: agent.sessionFile } : {}),
    ...(agent.plan ? { plan: agent.plan, revision: agent.revision } : {}),
    ...(turn ? { turn } : {}),
    ...(delivered ? { delivered } : {}),
  };
}

/** A restored planner's tools; without a record (older runs), it may read, search and run safe commands. */
function restoreAccess(stored: StoredAccess | undefined, settings: PlanModeSettings): PlannerAccessConfig {
  const tools = stored?.tools ?? ["read", "grep", "find", "ls", "bash", "plan_mode_question", "plan_mode_complete"];
  const scoutSpec = stored?.scouts ? parseModelSpec(stored.scouts.spec) : undefined;
  return {
    tools,
    extensions: stored?.extensions ?? [],
    skills: stored?.skills ?? [],
    systemPrompt: [plannerSystemPrompt()],
    policy: {
      tools: new Set(tools),
      ...(stored?.mcpAllow ? { mcpAllow: stored.mcpAllow } : {}),
      grantPrefixes: stored?.grantPrefixes ?? [],
      ...(settings.safeSubcommands ? { safeSubcommands: settings.safeSubcommands } : {}),
      ...(stored?.scouts && scoutSpec
        ? {
            scouts: {
              spec: scoutSpec,
              extensions: stored.scouts.extensions,
              tools: stored.scouts.tools,
              ...(stored.scouts.mcpAllow ? { mcpAllow: stored.scouts.mcpAllow } : {}),
            },
          }
        : {}),
      guardExtensionPath: EXTENSION_ENTRY_PATH,
    },
  };
}

function availableModels(ctx: ExtensionContext): ModelSpec[] {
  const scoped = (ctx.scopedModels ?? []).map((entry) => ({ provider: entry.model.provider, modelId: entry.model.id }));
  if (scoped.length > 0) return scoped;
  try {
    return ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, modelId: model.id }));
  } catch {
    return [];
  }
}

function safeCommands(pi: ExtensionAPI) {
  try {
    return pi.getCommands();
  } catch {
    return [];
  }
}

function safeAllTools(pi: ExtensionAPI) {
  try {
    return pi.getAllTools();
  } catch {
    return [];
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export type { TUI };
