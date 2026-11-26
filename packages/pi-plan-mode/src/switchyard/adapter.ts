/**
 * Switchyard adapter for @justmytwospence/pi-plan-mode. Self-contained: the host loads this file with
 * Node's native type stripping, so it uses erasable TypeScript only and imports nothing but the
 * types of its contract copy (`contract.ts`, erased on load).
 *
 * The plan reaches the web through `exit_plan_mode`'s tool updates (`details.plan`). It is shown in
 * the approval ("Implement this plan?", a plan dialog). On contract v2 hosts the plan tools get
 * one-line rows that open to the plan, and a Plan tracker stands for planning while it is live;
 * older hosts get the finished tool card and the `plan` panel and pill.
 */

import type {
  AdapterFeature,
  Claim as HostClaim,
  AdapterContext as HostContext,
  InteractionResponse,
  PiUiRequest,
  PiUiResponse,
  ToolInfo,
  ToolUpdateEvent,
  ToolViewData,
  UINode,
} from "./contract.ts";

/** What the adapter uses of its context; `setContribution` is missing on the oldest hosts. */
export type AdapterContext = Pick<HostContext, "state" | "setPanel" | "features"> &
  Partial<Pick<HostContext, "setContribution">>;
export type Claim = Omit<HostClaim, "toPiResponse"> & { toPiResponse(resp: InteractionResponse): PiUiResponse };
export type ToolUpdate = ToolUpdateEvent;

/** Contract v2 feature guard: `ctx.features` is undefined on a host from before v2. */
const supports = (ctx: { readonly features?: readonly string[] }, feature: AdapterFeature): boolean =>
  ctx.features?.includes(feature) === true;

export class InteractionResponseError extends Error {
  readonly code = "invalid_request";
  constructor(message: string) {
    super(message);
    this.name = "InteractionResponseError";
  }
}

export const EXIT_TOOL = "exit_plan_mode";
export const ENTER_TOOL = "enter_plan_mode";
/** How a finished exit_plan_mode row reads its outcome (src/inline-plan.ts ExitDetails). */
const OUTCOME_WORDS: Record<string, string> = {
  approved: "approved",
  handoff: "approved",
  fresh: "approved",
  kept: "revising",
  saved: "saved for later",
};
export const APPROVAL_QUESTION = "Implement this plan?";
export const STATUS_KEYS = ["workflow-mode", "plan", "plan-exec"] as const;
const PLAN_KEY = "plan:";

/** `outcome`: how its exit_plan_mode call ended (approved, kept, saved), once it has. */
type DisplayPlan = { plan: string; changes?: string[]; outcome?: string };
type PendingPlan = DisplayPlan & { toolCallId: string; at: number };

function planNode(plan: DisplayPlan): UINode {
  const markdown: UINode = { t: "markdown", text: plan.plan };
  return plan.changes?.length
    ? {
        t: "section",
        children: [
          markdown,
          {
            t: "section",
            title: "Changes since the last version",
            children: [{ t: "list", items: plan.changes.map((text) => ({ t: "text", text })) }],
          },
        ],
      }
    : markdown;
}

/** The plan's first heading, as a row's target. */
export function planTitle(plan: string): string {
  return /^\s*#{1,6}\s+(.+?)\s*$/m.exec(plan)?.[1]?.slice(0, 120) ?? "";
}

/** The plan for a row's detail or the tracker: changes in a section that starts closed. */
function planDetail(plan: DisplayPlan): UINode {
  const markdown: UINode = { t: "markdown", text: plan.plan };
  if (!plan.changes?.length) return markdown;
  return {
    t: "section",
    children: [
      markdown,
      {
        t: "section",
        title: "Changes since the last version",
        collapsible: true,
        open: false,
        children: [{ t: "list", items: plan.changes.map((text) => ({ t: "text", text })) }],
      },
    ],
  };
}

/** Plans whose call ended this way are finished business, not live planning. */
const FINAL_OUTCOMES = new Set(["approved", "saved", "handoff", "fresh"]);

/**
 * Contract v2: one Plan tracker while planning is live (the plan workflow, a planner run, or a
 * plan waiting for your answer), opening to the plan. The legacy panel and pill are cleared.
 */
function renderTracker(ctx: AdapterContext & Required<Pick<AdapterContext, "setContribution">>): void {
  ctx.setPanel("plan", null);
  ctx.setPanel("plan-status", null);
  ctx.setContribution("plan", null);
  ctx.setContribution("plan-pill", null);
  const stored = ctx.state.get<DisplayPlan>("display-plan");
  const plan = stored && !FINAL_OUTCOMES.has(stored.outcome ?? "") ? stored : undefined;
  const statuses = ctx.state.get<Record<string, string>>("status") ?? {};
  const workflow = /^workflow: (\w+)/.exec(statuses["workflow-mode"] ?? "")?.[1];
  const run = statuses.plan?.replace(/^plan:\s*/, "").replace(/\s*\(\/planners\)$/, "");
  const waiting = pendingPlans(ctx).length > 0;
  if (!waiting && workflow !== "plan" && !run) {
    ctx.setContribution("plan-tracker", null);
    return;
  }
  const step = waiting ? "waiting for your answer" : run || (plan ? "drafted" : "planning");
  ctx.setContribution("plan-tracker", {
    placement: "composer.tracker",
    title: "Plan",
    node: plan ? planDetail(plan) : { t: "text", text: run ? `Planners: ${run}` : "No plan yet.", tone: "muted" },
    mobileFallback: (plan?.plan ?? step).slice(0, 2000),
    tracker: { status: waiting ? "attention" : "running", step: step.slice(0, 120) },
    order: -5,
  });
}

/** Plan text is display evidence, never evidence of approval or execution. */
export function renderPlan(ctx: AdapterContext): void {
  if (ctx.setContribution && supports(ctx, "adapter.trackers.v1")) {
    renderTracker(ctx as AdapterContext & Required<Pick<AdapterContext, "setContribution">>);
    return;
  }
  const plan = ctx.state.get<DisplayPlan>("display-plan");
  const statuses = ctx.state.get<Record<string, string>>("status") ?? {};
  const rows = STATUS_KEYS.filter((k) => statuses[k] !== undefined).map((k) => [k, statuses[k] as string]);
  const statusNode: UINode | null = rows.length ? { t: "table", columns: ["Key", "Status"], rows } : null;
  if (ctx.setContribution) {
    ctx.setPanel("plan", null);
    ctx.setPanel("plan-status", null);
    const children: UINode[] = [...(plan ? [planNode(plan)] : []), ...(statusNode ? [statusNode] : [])];
    ctx.setContribution(
      "plan",
      children.length
        ? {
            placement: "session.panel",
            title: "Plan",
            node: children.length === 1 ? children[0]! : { t: "section", children },
            mobileFallback: [plan?.plan, ...rows.map(([key, text]) => `${key}: ${text}`)]
              .filter(Boolean)
              .join("\n")
              .slice(0, 2000),
          }
        : null,
    );
    const text = rows.map(([, value]) => value).join(" · ");
    ctx.setContribution(
      "plan-pill",
      text
        ? {
            placement: "composer.pill",
            title: "Plan",
            node: { t: "text", text },
            mobileFallback: text.slice(0, 2000),
          }
        : null,
    );
  } else {
    ctx.setPanel("plan", plan ? planNode(plan) : null, { title: "Plan", mobileFallback: plan?.plan ?? null });
    ctx.setPanel("plan-status", statusNode, { title: "Plan mode" });
  }
}

function pendingPlans(ctx: AdapterContext): PendingPlan[] {
  return ctx.state
    .keys()
    .filter((k) => k.startsWith(PLAN_KEY))
    .map((k) => ctx.state.get<PendingPlan>(k))
    .filter((p): p is PendingPlan => !!p && typeof p.plan === "string")
    .sort((a, b) => a.at - b.at);
}

function detailsOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export default {
  onRestore: renderPlan,

  onToolUpdate(e: ToolUpdate, ctx: AdapterContext): void {
    if (e.name !== EXIT_TOOL) return;
    const d = detailsOf(e.details);
    if (!d || typeof d.plan !== "string" || d.outcome !== "pending") return;
    const changes = Array.isArray(d.changes) ? d.changes.filter((c): c is string => typeof c === "string") : undefined;
    ctx.state.set(PLAN_KEY + e.toolCallId, {
      toolCallId: e.toolCallId,
      plan: d.plan,
      ...(changes?.length ? { changes } : {}),
      at: Date.now(),
    } satisfies PendingPlan);
    ctx.state.set("display-plan", { plan: d.plan, ...(changes?.length ? { changes } : {}) });
    renderPlan(ctx);
  },

  claimInteraction(req: PiUiRequest, ctx: AdapterContext): Claim | undefined {
    if (req.method !== "select" || !req.title.startsWith(APPROVAL_QUESTION)) return undefined;
    const pending = pendingPlans(ctx).at(-1);
    if (!pending) return undefined;
    const options = req.options;
    return {
      title: req.title.split("\n")[0] ?? APPROVAL_QUESTION,
      ownerToolCallId: pending.toolCallId,
      // A plan: read first, answered in the dock; its tool row stays.
      kind: "plan",
      presentation: {
        t: "section",
        children: [
          { t: "markdown", text: pending.plan },
          ...(pending.changes?.length
            ? [
                {
                  t: "section",
                  title: "Changes since the last version",
                  children: [{ t: "list", items: pending.changes.map((c) => ({ t: "text", text: c }) as UINode) }],
                } as UINode,
              ]
            : []),
          {
            t: "actions",
            actions: options.map((label, i) => ({
              id: `option-${i}`,
              label,
              tone: i === 0 ? ("primary" as const) : ("default" as const),
            })),
          },
        ],
      },
      toPiResponse(resp: InteractionResponse): PiUiResponse {
        if (resp.kind === "cancel") {
          ctx.state.delete(PLAN_KEY + pending.toolCallId);
          return { cancelled: true };
        }
        if (resp.kind === "action") {
          const value = options[Number(resp.actionId.replace("option-", ""))];
          if (value !== undefined) return { value };
        }
        throw new InteractionResponseError(`unknown approval option ${JSON.stringify(resp)}`);
      },
    };
  },

  onToolEnd(e: ToolInfo, ctx: AdapterContext): void {
    if (e.name !== EXIT_TOOL) return;
    const pending = ctx.state.get<PendingPlan>(PLAN_KEY + e.toolCallId);
    const d = detailsOf(e.details);
    if (typeof d?.plan === "string") {
      const changes = Array.isArray(d.changes)
        ? d.changes.filter((c): c is string => typeof c === "string")
        : pending?.changes;
      ctx.state.set("display-plan", {
        plan: d.plan,
        ...(changes?.length ? { changes } : {}),
        ...(typeof d.outcome === "string" ? { outcome: d.outcome } : {}),
      });
    }
    ctx.state.delete(PLAN_KEY + e.toolCallId);
    renderPlan(ctx);
  },

  /** Contract v2: the plan tools' rows; the plan opens from the exit_plan_mode row. */
  toolView(tool: ToolInfo, ctx: AdapterContext): ToolViewData | undefined {
    if (tool.name === ENTER_TOOL) {
      return { kind: "other", verb: "Entered plan mode", activeVerb: "Entering plan mode", target: "" };
    }
    if (tool.name !== EXIT_TOOL) return undefined;
    const d = detailsOf(tool.details);
    const kept = ctx.state.get<PendingPlan>(PLAN_KEY + tool.toolCallId);
    const text = typeof d?.plan === "string" ? d.plan : kept?.plan;
    const changes = Array.isArray(d?.changes)
      ? d.changes.filter((c): c is string => typeof c === "string")
      : kept?.changes;
    const outcome = typeof d?.outcome === "string" ? d.outcome : undefined;
    const meta =
      tool.result === undefined
        ? []
        : tool.isError
          ? ["failed"]
          : outcome && outcome !== "pending"
            ? [OUTCOME_WORDS[outcome] ?? outcome]
            : [];
    return {
      kind: "other",
      verb: "Proposed plan",
      activeVerb: "Proposing plan",
      target: text ? planTitle(text) : "",
      meta,
      ...(text ? { detail: planDetail({ plan: text, ...(changes?.length ? { changes } : {}) }) } : {}),
    };
  },

  toolCard(tool: ToolInfo, ctx: AdapterContext): UINode | undefined {
    if (tool.name !== EXIT_TOOL || tool.result === undefined) return undefined;
    // A row with a detail stands for the card where the host draws tool views.
    if (supports(ctx, "tool.views.v1")) return undefined;
    const d = detailsOf(tool.details);
    const kept = ctx.state.get<PendingPlan>(PLAN_KEY + tool.toolCallId);
    const plan = typeof d?.plan === "string" ? d.plan : kept?.plan;
    ctx.state.delete(PLAN_KEY + tool.toolCallId);
    return plan
      ? { t: "section", title: "Plan", collapsible: true, children: [{ t: "markdown", text: plan }] }
      : undefined;
  },

  onStatus(key: string, text: string | undefined, ctx: AdapterContext): boolean {
    if (!(STATUS_KEYS as readonly string[]).includes(key)) return false;
    const statuses = { ...(ctx.state.get<Record<string, string>>("status") ?? {}) };
    if (text === undefined || text === "") delete statuses[key];
    else statuses[key] = text;
    ctx.state.set("status", statuses);
    renderPlan(ctx);
    return true;
  },
};
