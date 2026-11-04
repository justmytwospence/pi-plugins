/**
 * Switchyard adapter for @justmytwospence/pi-plan-mode. Self-contained: the host loads this file with
 * Node's native type stripping, so it imports nothing and uses erasable TypeScript only. The
 * local types are structurally compatible with Switchyard's UINode and AdapterContext.
 *
 * The plan reaches the web through `exit_plan_mode`'s tool updates (`details.plan`). It is shown in
 * the approval card ("Implement this plan?"), in the finished tool card and in the `plan` panel.
 */

export type UINode =
  | { t: "text"; text: string; tone?: "default" | "muted" | "success" | "warning" | "danger" }
  | { t: "markdown"; text: string }
  | { t: "list"; items: UINode[]; ordered?: boolean }
  | { t: "table"; columns: string[]; rows: string[][] }
  | { t: "section"; title?: string; collapsible?: boolean; children: UINode[] }
  | { t: "progress"; label: string; value?: number; status?: "running" | "ok" | "error" }
  | { t: "actions"; actions: { id: string; label: string; tone?: "default" | "primary" | "danger" }[] };
type PanelOptions = { title?: string; mobileFallback?: string | null; state?: unknown };
export type AdapterContext = {
  readonly state: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    delete(key: string): void;
    keys(): string[];
  };
  setPanel(slot: string, node: UINode | null, opts?: PanelOptions): void;
};
export type PiUiRequest =
  | { id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { id: string; method: "editor"; title: string; prefill?: string };
export type PiUiResponse = { value: string } | { confirmed: boolean } | { cancelled: true };
export type InteractionResponse =
  | { kind: "form"; values: Record<string, unknown> }
  | { kind: "confirm"; confirmed: boolean }
  | { kind: "action"; actionId: string }
  | { kind: "cancel" };
export type Claim = {
  title: string;
  presentation: UINode;
  toPiResponse(resp: InteractionResponse): PiUiResponse;
  ownerToolCallId?: string;
};
export type ToolInfo = {
  toolCallId: string;
  name: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
  details?: unknown;
};
export type ToolUpdate = { toolCallId: string; name: string; args: unknown; partialResult: unknown; details?: unknown };

export class InteractionResponseError extends Error {
  readonly code = "invalid_request";
  constructor(message: string) {
    super(message);
    this.name = "InteractionResponseError";
  }
}

export const EXIT_TOOL = "exit_plan_mode";
export const APPROVAL_QUESTION = "Implement this plan?";
export const STATUS_KEYS = ["workflow-mode", "plan", "plan-exec"] as const;
const PLAN_KEY = "plan:";

type PendingPlan = { toolCallId: string; plan: string; changes?: string[]; at: number };

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
    ctx.setPanel("plan", { t: "markdown", text: d.plan }, { title: "Plan", mobileFallback: d.plan });
  },

  claimInteraction(req: PiUiRequest, ctx: AdapterContext): Claim | undefined {
    if (req.method !== "select" || !req.title.startsWith(APPROVAL_QUESTION)) return undefined;
    const pending = pendingPlans(ctx).at(-1);
    if (!pending) return undefined;
    const options = req.options;
    return {
      title: req.title.split("\n")[0] ?? APPROVAL_QUESTION,
      ownerToolCallId: pending.toolCallId,
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
        if (resp.kind === "cancel") return { cancelled: true };
        if (resp.kind === "action") {
          const value = options[Number(resp.actionId.replace("option-", ""))];
          if (value !== undefined) return { value };
        }
        throw new InteractionResponseError(`unknown approval option ${JSON.stringify(resp)}`);
      },
    };
  },

  toolCard(tool: ToolInfo, ctx: AdapterContext): UINode | undefined {
    if (tool.name !== EXIT_TOOL || tool.result === undefined) return undefined;
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
    const rows = STATUS_KEYS.filter((k) => statuses[k] !== undefined).map((k) => [k, statuses[k] as string]);
    ctx.setPanel("plan-status", rows.length ? { t: "table", columns: ["Key", "Status"], rows } : null, {
      title: "Plan mode",
    });
    return true;
  },
};
