/**
 * Switchyard adapter for @justmytwospence/pi-tool-gate. Self-contained: the host loads this file
 * with Node's native type stripping, so it uses erasable TypeScript only and imports nothing but
 * the types of its contract copy (`contract.ts`, erased on load).
 *
 * - Approvals: the plugin appends a `tool-gate:approval-request` entry (src/approval-entry.ts) just
 *   before it opens `select("Allow this call?\n...", options)`. The claim shows that entry's facts
 *   and command, matched by the dialog's exact title; a dialog without one (an older plugin) falls
 *   back to the title's field lines. The follow-up input/editor dialogs (block message, rule
 *   editing) are left to generic.
 * - Modes (contract v2 only): the gate's statuses become one Mode tracker and, away from the
 *   defaults, a session badge. Older hosts keep showing them in their generic Status panel.
 */

import type {
  AdapterContext as HostContext,
  AdapterFeature,
  Claim as HostClaim,
  InteractionResponse,
  PiUiRequest,
  SessionEntryInfo,
  UINode,
} from "./contract.ts";

/** What the adapter uses of its context; `setContribution` is missing on the oldest hosts. */
export type AdapterContext = Pick<HostContext, "state" | "features"> & Partial<Pick<HostContext, "setContribution">>;
export type Claim = Omit<HostClaim, "toPiResponse"> & {
  toPiResponse(resp: InteractionResponse): { value: string } | { cancelled: true };
};

/** Contract v2 feature guard: `ctx.features` is undefined on a host from before v2. */
const supports = (ctx: { readonly features?: readonly string[] }, feature: AdapterFeature): boolean =>
  ctx.features?.includes(feature) === true;

/** Client sent an answer the claim cannot map; the host keeps the interaction open. */
export class InteractionResponseError extends Error {
  readonly code = "invalid_request";
  constructor(message: string) {
    super(message);
    this.name = "InteractionResponseError";
  }
}

export const TITLE_PREFIX = "Allow this call?";
export const REQUEST_ENTRY = "tool-gate:approval-request";
const REQUESTS_KEY = "approval-requests";
/** Requests kept for matching: dialogs open one at a time, so a few suffice. */
const KEPT_REQUESTS = 8;
const FIELD_RE = /^\s*(Action|Target|Held|Agent|Rule|Folder|Project saves):\s*(.*)$/;

/** The plugin's approval request entry (src/approval-entry.ts). */
export interface ApprovalRequest {
  version: 1;
  title: string;
  tool: string;
  action: string;
  target: string;
  cwd: string;
  command?: string;
  held?: string;
  agent?: string;
  note?: string;
  offer?: { kind: "rules" | "dirs"; items: string[]; saves?: string };
  problem?: string;
}

const isStr = (x: unknown): x is string => typeof x === "string";

export function parseApprovalRequest(data: unknown): ApprovalRequest | undefined {
  const d = data as Partial<ApprovalRequest> | null | undefined;
  if (!d || typeof d !== "object" || d.version !== 1) return undefined;
  if (![d.title, d.tool, d.action, d.target, d.cwd].every(isStr)) return undefined;
  for (const k of ["command", "held", "agent", "note", "problem"] as const) {
    if (d[k] !== undefined && !isStr(d[k])) return undefined;
  }
  const o = d.offer;
  if (o !== undefined && (!o || (o.kind !== "rules" && o.kind !== "dirs") || !Array.isArray(o.items) || !o.items.every(isStr) || (o.saves !== undefined && !isStr(o.saves)))) {
    return undefined;
  }
  return d as ApprovalRequest;
}

export interface ParsedApproval {
  rows: [string, string][];
  note: string;
}

/** Legacy: the facts of a dialog from a plugin that publishes no request entry. */
export function parseApprovalTitle(title: string): ParsedApproval {
  const rows: [string, string][] = [];
  const note: string[] = [];
  for (const line of title.slice(TITLE_PREFIX.length).split("\n")) {
    const m = FIELD_RE.exec(line);
    if (m) rows.push([m[1]!, m[2]!.trim()]);
    else if (line.trim()) note.push(line.trim());
  }
  return { rows, note: note.join("\n") };
}

function tone(option: string): "primary" | "danger" | "default" {
  if (option === "Allow once") return "primary";
  if (option === "Block" || option === "Block with a message") return "danger";
  return "default";
}

export const optionActionId = (i: number) => `option:${i}`;

/** The facts of a structured request: what, where, why, and what an allow would save. */
export function requestFacts(r: ApprovalRequest): { label: string; value: string; mono?: boolean }[] {
  const facts: { label: string; value: string; mono?: boolean }[] = [
    { label: "Tool", value: r.tool, mono: true },
    { label: "Action", value: r.action },
    { label: "Target", value: r.target, mono: true },
    { label: "Directory", value: r.cwd, mono: true },
  ];
  if (r.held !== undefined) facts.push({ label: "Held", value: r.held });
  if (r.agent !== undefined) facts.push({ label: "Agent", value: r.agent });
  const noun = r.offer?.kind === "dirs" ? "Folder" : "Rule";
  for (const item of r.offer?.items ?? []) facts.push({ label: noun, value: item, mono: true });
  if (r.offer?.saves) facts.push({ label: "Saves to", value: r.offer.saves });
  return facts;
}

/** A short one-line command reads fine as the Target fact; anything longer gets a code block. */
export function commandNeedsBlock(r: ApprovalRequest): boolean {
  return !!r.command && (r.command.includes("\n") || r.command.length > 120 || r.command.trim() !== r.target);
}

/**
 * Contract v2: the request's facts, its command and the options. Before v2 (and without a
 * request entry) the field lines of the title, as a table on old hosts, exactly as before v2.
 */
function presentation(req: Extract<PiUiRequest, { method: "select" }>, r: ApprovalRequest | undefined, v2: boolean): UINode {
  const actions: UINode = {
    t: "actions",
    actions: req.options.map((o, i) => ({ id: optionActionId(i), label: o, tone: tone(o) })),
  };
  const children: UINode[] = [];
  if (r && v2) {
    children.push({ t: "facts", items: requestFacts(r) });
    if (r.command && commandNeedsBlock(r)) children.push({ t: "code", text: r.command, lang: "bash" });
    const note = [r.note ? `(${r.note})` : "", r.problem ?? ""].filter(Boolean).join("\n\n");
    if (note) children.push({ t: "markdown", text: note });
  } else {
    const { rows, note } = parseApprovalTitle(req.title);
    if (rows.length) {
      children.push(
        v2
          ? { t: "facts", items: rows.map(([label, value]) => ({ label, value })) }
          : { t: "table", columns: ["Field", "Value"], rows },
      );
    }
    if (note) children.push({ t: "markdown", text: note });
  }
  children.push(actions);
  return { t: "section", title: TITLE_PREFIX, children };
}

export function approvalClaim(req: Extract<PiUiRequest, { method: "select" }>, ctx?: AdapterContext): Claim {
  const request = ctx ? requests(ctx).findLast((r) => r.title === req.title) : undefined;
  const action = request?.action ?? parseApprovalTitle(req.title).rows.find(([k]) => k === "Action")?.[1];
  const title = action ? `${TITLE_PREFIX} ${action}` : TITLE_PREFIX;
  return {
    title: title.length > 200 ? `${title.slice(0, 197)}...` : title,
    // An approval keeps its tool row (the command being approved) and is never answered by a key.
    kind: "approval",
    presentation: presentation(req, request, !!ctx && supports(ctx, "ui.nodes.v2")),
    toPiResponse(resp) {
      if (resp.kind === "cancel") return { cancelled: true };
      if (resp.kind !== "action") {
        throw new InteractionResponseError(`expected an approval action, got ${resp.kind}`);
      }
      const m = /^option:(\d+)$/.exec(resp.actionId);
      const value = m ? req.options[Number(m[1])] : undefined;
      if (value === undefined) {
        throw new InteractionResponseError(`unknown approval action ${resp.actionId}`);
      }
      return { value };
    },
  };
}

const requests = (ctx: AdapterContext): ApprovalRequest[] => ctx.state.get<ApprovalRequest[]>(REQUESTS_KEY) ?? [];

// ---------------------------------------------------------------------------
// Modes

/** The gate's status keys (src/modes.ts, src/prompting.ts, src/index.ts). */
export const STATUS_KEYS = {
  workflow: "workflow-mode",
  approvals: "permission-mode",
  prompting: "permission-prompting",
  gate: "tool-gate",
} as const;
type StatusName = keyof typeof STATUS_KEYS;
const STATUS_NAMES = Object.keys(STATUS_KEYS) as StatusName[];

/** Approval modes by the label `modeStatus` shows (src/modes.ts MODE_LABELS). */
const APPROVAL_LABELS: [string, string][] = [
  ["yolo mode on", "yolo"],
  ["auto mode on", "auto"],
  ["accept edits (legacy) on", "accept edits"],
  ["manual (legacy) mode on", "manual"],
];

export interface Modes {
  workflow?: string;
  approvals?: string;
  prompts?: "on" | "off";
  gate?: string;
}

/** The modes the gate's own statuses show; a text it does not recognize leaves that mode unknown. */
export function modesOf(statuses: Partial<Record<StatusName, string>>): Modes {
  const workflow = /^workflow: (work|chat|plan)\b/.exec(statuses.workflow ?? "")?.[1];
  const approvals = APPROVAL_LABELS.find(([label]) => statuses.approvals?.includes(label))?.[1];
  const prompts = /^permission prompts: (on|off)$/.exec(statuses.prompting ?? "")?.[1] as Modes["prompts"];
  const gate = /^gate: (.+)$/.exec(statuses.gate ?? "")?.[1];
  return {
    ...(workflow ? { workflow } : {}),
    ...(approvals ? { approvals } : {}),
    ...(prompts ? { prompts } : {}),
    ...(gate ? { gate } : {}),
  };
}

const MODE_TRACKER = "mode";
const MODE_BADGE = "mode-badge";

/** Contract v2: the Mode tracker and, away from work and auto approvals, a badge. */
export function renderModes(ctx: AdapterContext): void {
  if (!ctx.setContribution || !supports(ctx, "adapter.trackers.v1")) return;
  const m = modesOf(ctx.state.get<Partial<Record<StatusName, string>>>("status") ?? {});
  const summary = [m.workflow, m.approvals].filter(Boolean).join(" · ");
  const facts = [
    ...(m.workflow ? [{ label: "Workflow", value: m.workflow }] : []),
    ...(m.approvals ? [{ label: "Approvals", value: m.approvals }] : []),
    ...(m.prompts ? [{ label: "Permission prompts", value: m.prompts }] : []),
    ...(m.gate ? [{ label: "Gate", value: m.gate }] : []),
  ];
  ctx.setContribution(
    MODE_TRACKER,
    summary
      ? {
          placement: "composer.tracker",
          title: "Mode",
          node: supports(ctx, "ui.nodes.v2")
            ? { t: "facts", items: facts }
            : { t: "table", columns: ["Mode", "Value"], rows: facts.map((f) => [f.label, f.value]) },
          mobileFallback: facts.map((f) => `${f.label}: ${f.value}`).join("\n"),
          tracker: {
            count: summary.slice(0, 24),
            // Yolo runs everything the workflow allows: worth a mark, never a spinner.
            ...(m.approvals === "yolo" ? { status: "attention" as const } : {}),
            ...(m.prompts === "off" ? { step: "prompts off" } : {}),
          },
          order: -10,
        }
      : null,
  );
  const unusual = [m.workflow && m.workflow !== "work" ? m.workflow : "", m.approvals && m.approvals !== "auto" ? m.approvals : ""]
    .filter(Boolean)
    .join(" · ");
  ctx.setContribution(
    MODE_BADGE,
    unusual
      ? {
          placement: "session.badge",
          title: "Mode",
          node: { t: "badge", text: unusual.slice(0, 24), tone: m.approvals === "yolo" ? "warning" : "muted" },
          mobileFallback: unusual,
        }
      : null,
  );
}

export default {
  onRestore: renderModes,

  onEntry(entry: SessionEntryInfo, ctx: AdapterContext): void {
    if (entry.customType !== REQUEST_ENTRY) return;
    const request = parseApprovalRequest(entry.data);
    if (request) ctx.state.set(REQUESTS_KEY, [...requests(ctx), request].slice(-KEPT_REQUESTS));
  },

  claimInteraction(req: PiUiRequest, ctx?: AdapterContext): Claim | undefined {
    if (req.method !== "select" || !req.title.startsWith(TITLE_PREFIX)) return undefined;
    return approvalClaim(req, ctx);
  },

  /** Contract v2 hosts get the gate's statuses as the Mode tracker; older ones keep them generic. */
  onStatus(key: string, text: string | undefined, ctx: AdapterContext): boolean {
    const name = STATUS_NAMES.find((n) => STATUS_KEYS[n] === key);
    if (!name || !ctx.setContribution || !supports(ctx, "adapter.trackers.v1")) return false;
    const statuses = { ...(ctx.state.get<Partial<Record<StatusName, string>>>("status") ?? {}) };
    if (text) statuses[name] = text;
    else delete statuses[name];
    ctx.state.set("status", statuses);
    renderModes(ctx);
    return true;
  },
};
