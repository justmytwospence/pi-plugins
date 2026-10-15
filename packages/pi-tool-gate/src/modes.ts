// Permission modes, after Claude Code's: what runs without asking you. The gate owns the mode,
// the cycle key (Shift+Tab by default) and the status line; plan mode itself is pi-plan-mode's,
// which joins the cycle over Pi's event bus when it is installed.
//
// Event bus contract (shared with pi-plan-mode; both sides are optional):
//   permission-mode:changed        gate -> all    { mode, previous?, cycle }  on every change, and at session start
//   permission-mode:set            any  -> gate   { mode }                   request a mode
//   permission-mode:cycle          any  -> gate   {}                         advance the cycle (a shortcut of another extension)
//   permission-mode:plan-provider  plan -> gate   { planFile? }              plan mode is available; the file it may write

export const MODES = ["chat", "default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const;
export type PermissionMode = (typeof MODES)[number];

export const MODE_CHANGED = "permission-mode:changed";
export const MODE_SET = "permission-mode:set";
export const MODE_CYCLE = "permission-mode:cycle";
export const PLAN_PROVIDER = "permission-mode:plan-provider";

/** The status key every mode publisher uses, so a footer shows one indicator. */
export const MODE_STATUS_KEY = "permission-mode";
/** The session entry that records the mode, so a resumed session comes back in it. */
export const MODE_ENTRY = "tool-gate:mode";

/** Claude Code's status-bar labels (chat is the gate's own). */
export const MODE_LABELS: Record<PermissionMode, string> = {
  chat: "⏸ chat mode on",
  default: "⏸ manual mode on",
  acceptEdits: "⏵⏵ accept edits on",
  plan: "⏸ plan mode on",
  auto: "⏵⏵ auto mode on",
  bypassPermissions: "⏵⏵ bypass permissions on",
};

/** Short names for `/mode` and descriptions. */
export const MODE_NAMES: Record<PermissionMode, string> = {
  chat: "chat",
  default: "manual",
  acceptEdits: "accept-edits",
  plan: "plan",
  auto: "auto",
  bypassPermissions: "bypass",
};

export const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  chat: "Talk and ask questions: read-only tools run, nothing else does.",
  default: "Ask before every edit, write and command that does more than read.",
  acceptEdits: "Edits, writes and filesystem commands inside the project run; other commands ask.",
  plan: "Read-only research and a plan to approve before anything changes (pi-plan-mode).",
  auto: "Jev judges each call; you are asked only about risky ones the agent cannot work around.",
  bypassPermissions: "Everything runs, except removing / , home, the project or a parent of them.",
};

/** Accepts config values, Claude Code's names, and the short `/mode` names. */
export function parseMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase().replace(/[\s_-]/gu, "");
  const aliases: Record<string, PermissionMode> = {
    chat: "chat",
    ask: "chat",
    default: "default",
    manual: "default",
    acceptedits: "acceptEdits",
    edits: "acceptEdits",
    plan: "plan",
    auto: "auto",
    bypass: "bypassPermissions",
    bypasspermissions: "bypassPermissions",
    yolo: "bypassPermissions",
  };
  return aliases[key];
}

/**
 * The modes Shift+Tab steps through, in Claude Code's order (manual, accept edits, plan, then
 * bypass and auto) after chat, the most restrictive, keeping only those configured and available.
 */
export function cycleOf(configured: readonly PermissionMode[], available: { plan: boolean }): PermissionMode[] {
  return MODES.filter((mode) => configured.includes(mode) && (mode !== "plan" || available.plan)).sort(
    (a, b) => ORDER.indexOf(a) - ORDER.indexOf(b),
  );
}
const ORDER: PermissionMode[] = ["chat", "default", "acceptEdits", "plan", "bypassPermissions", "auto"];

/** The next mode in the cycle; a mode outside it goes to the cycle's first. */
export function nextMode(current: PermissionMode, cycle: readonly PermissionMode[]): PermissionMode {
  if (cycle.length === 0) return current;
  const index = cycle.indexOf(current);
  return cycle[(index + 1) % cycle.length] ?? current;
}

export function modeStatus(mode: PermissionMode, shortcut: string | undefined): string {
  return `${MODE_LABELS[mode]}${shortcut ? ` (${shortcut} to cycle)` : ""}`;
}
