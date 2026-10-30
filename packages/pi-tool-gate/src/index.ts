// pi-tool-gate: auto-approves tool calls. Fixed rules settle the clear cases (read-only calls run,
// a short list of dangerous ones is always held); Jev, through Pi's own classifier models, judges
// the gray zone. A held call is first blocked with Jev's explanation and suggested workaround; the
// agent works around it or makes its case and retries, and only that retry is put to you, with the
// case. Project rules in `.agents/tool-gate-rules.md` (or `.pi/`) are checked on every judged
// call. Without Jev the gate falls back to Pi's tool hints.
//
// Workflow and approvals are independent (see modes.ts): Shift+Tab cycles work/chat/plan;
// Alt+A toggles auto/yolo. Chat's read-only guard and plan's existing edit/command policy apply
// under either approval setting. Plan commands still use the existing judge, not a shell sandbox.
// Manual and accept-edits remain explicit legacy approval settings.
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  alwaysAskBash,
  alwaysAskPath,
  bashKeys,
  bashPathAccess,
  expandHome,
  isAcceptEditsBash,
  isCredentialPath,
  isReadOnlyBash,
  SHELL_TOOLS,
  secretGitAdds,
  shellDir,
} from "./bash.ts";
import { loadConfig } from "./config.ts";
import {
  DEFAULT_DIRECTORIES,
  type DirectoriesConfig,
  type Policy,
  canWrite,
  describePolicy,
  grantKey,
  resolvePolicy,
  shown,
  violations,
} from "./dirs.ts";
import { Downloads, downloadedRunReasons, downloadsOf, type Script, scriptFor, trackCall } from "./downloads.ts";
import { addGrants, grantsFile, loadGrants, removeGrant } from "./grants.ts";
import {
  allowing,
  allowsPath,
  blocking,
  type Call,
  describeOrigin,
  editUserRules,
  type IgnoredRule,
  loadFileRules,
  localGrants,
  migrateGrant,
  parseRule,
  type RuleList,
  ruleKey,
  type ScopedRule,
  type Scope,
  sessionRule,
  suggest,
} from "./permissions.ts";
import { type DirGrant, rulesCommand, type RuleStore } from "./rules-command.ts";
import { whileBlocked } from "./herdr.ts";
import { type ClassifierUsage, type JevConfig, askJev } from "./jev.ts";
import {
  DEFAULT_THRESHOLDS,
  type JudgeInput,
  type Thresholds,
  WORKAROUNDS,
  judgeQuestions,
  judgeState,
  steerReason,
  suggestions,
  verdict,
  workaroundQuestion,
} from "./judge.ts";
import { embeddedEditorFactory } from "./editor.ts";
import { askApproval } from "./prompt.ts";
import {
  APPROVAL_CYCLE,
  APPROVAL_ENTRY,
  EXEC_CHANGED,
  EXEC_GUIDANCE,
  WORKFLOW_CHANGED,
  WORKFLOW_CYCLE,
  WORKFLOW_ENTRY,
  WORKFLOW_SET,
  WORKFLOW_QUERY,
  type WorkflowSource,
  type WorkflowSnapshot,
  WORKFLOW_STATUS_KEY,
  workflowCycle,
  workflowStatus,
  restoreBranchModes,
  parseApproval,
  parseWorkflow,
  parseLegacyCombinedMode,
  nextWorkflow,
  nextApproval,
  type ApprovalMode,
  type BaseWorkflowMode,
  type WorkflowMode,
  MODE_CHANGED,
  MODE_CYCLE,
  MODE_DESCRIPTIONS,
  MODE_NAMES,
  MODE_SET,
  MODE_STATUS_KEY,
  modeStatus,
  PLAN_PROVIDER,
} from "./modes.ts";
import { loadRules } from "./rules.ts";
import { agentBeforeLatestUser, callerText, clip, clipTail, recentTexts, recentUserMessages } from "./transcript.ts";
import { offerUserWords, resultText } from "./user-words.ts";
import { callView } from "./view.ts";

/** A declined call's result (Block). */
export const DECLINED = "The user declined this call. Do not retry it; continue without it, or ask the user how to proceed.";
/** A declined call's result, around the user's message to the agent (Block with a message). */
export const DECLINED_WITH_MESSAGE = "The user declined this call, with this message:\n\n";
export const DECLINED_WITH_MESSAGE_END = "\n\nDo not retry the call as it was; follow the user's message.";

/**
 * Who stopped a call, read from its result: the user (Block, Block with a message, or Esc), or
 * the gate on its own (a push-back, chat or plan mode, no user to ask). Undefined when it ran.
 */
export function blockedBy(result: { content?: unknown; isError?: boolean }): "user" | "gate" | undefined {
  if (!result.isError) return undefined;
  const text = resultText(result.content);
  if (text.startsWith(DECLINED) || text.startsWith(DECLINED_WITH_MESSAGE)) return "user";
  if (/^(?:tool-gate held this |tool-gate blocked this |Chat mode is on: |Plan mode is on: |[a-z ]+ mode needs the user's approval for this )/u.test(text)) return "gate";
  return undefined;
}

/** The user's message in a call they declined with one, for pi-sticky-last-prompt's bar. */
export function declinedMessage(result: { content?: unknown; isError?: boolean }): string | undefined {
  if (!result.isError) return undefined;
  const text = resultText(result.content);
  if (!text.startsWith(DECLINED_WITH_MESSAGE) || !text.endsWith(DECLINED_WITH_MESSAGE_END)) return undefined;
  return text.slice(DECLINED_WITH_MESSAGE.length, text.length - DECLINED_WITH_MESSAGE_END.length).trim() || undefined;
}

export interface GateConfig extends Record<string, unknown> {
  enabled: boolean;
  jev: JevConfig;
  thresholds: Thresholds;
  /** Tools that never need a decision (they change nothing, or gate their own nested calls). */
  allowTools: string[];
  /** Extra programs treated as read-only in bash. */
  readOnlyCommands: string[];
  /** Block a held call once with a reason for the agent before asking you; a retry asks you. */
  pushBack: boolean;
  /** The mode a new session starts in: chat, manual, accept-edits, plan, auto or yolo. */
  defaultMode: string;
  /** Deprecated: ignored; workflow and approvals have independent fixed cycles. */
  modes: string[];
  /** Legacy fallback for workflowShortcut; "" disables. */
  cycleShortcut: string;
  defaultWorkflow?: string;
  defaultApproval?: string;
  /** Explicit workflow key takes precedence over cycleShortcut; "" disables. */
  workflowShortcut?: string;
  approvalShortcut: string;
  /** Which directories this project reads and writes without asking (dirs.ts). */
  directories: DirectoriesConfig;
}

export const DEFAULT_CONFIG: GateConfig = {
  enabled: true,
  jev: { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 8_000 },
  thresholds: DEFAULT_THRESHOLDS,
  allowTools: [
    "codemode", "tool_search", "todo", "ask_user_question", "plan_mode_question", "plan_mode_complete",
    "enter_plan_mode", "exit_plan_mode",
    "web_search", "fetch_content", "get_search_content", "code_search", "radius_web_search", "web_enable",
    "bg_status", "bg_logs", "bg_result", "bg_wait", "bg_kill", "subagents_enable",
  ],
  readOnlyCommands: [],
  pushBack: true,
  defaultMode: "auto",
  modes: ["default", "acceptEdits", "plan", "auto"],
  cycleShortcut: "shift+tab",
  approvalShortcut: "alt+a",
  directories: DEFAULT_DIRECTORIES,
};

/** The dialog's first and last rows. */
export const ALLOW_ONCE = "Allow once";
export const BLOCK = "Block";

/**
 * The rows that allow what is offered, short enough (at most 42 characters) that a phone client
 * reads them without wrapping: the rules or folders themselves are in the question.
 */
export function choiceLabels(kind: "rules" | "dirs", plural: boolean): { session: string; project: string; everywhere?: string; edit?: string } {
  const noun = kind === "dirs" ? (plural ? "folders" : "folder") : plural ? "rules" : "rule";
  return {
    session: `Allow ${noun} for this session`,
    project: `Allow ${noun} in this project`,
    ...(kind === "rules" ? { everywhere: `Allow ${noun} everywhere`, edit: `Edit the ${noun}...` } : {}),
  };
}

const STATUS_KEY = "tool-gate";
/** Records whether the agent was last told chat mode is on, so it hears each change once. */
const CHAT_ENTRY = "tool-gate:chat-notice";
const BUILTIN_READ = new Set(["read", "grep", "find", "ls"]);

/** Why a plan allowed a call: an allow rule (never what chat mode means by read-only). */
export const ALLOWED_BY_RULE = "allow rule";

/** What the gate does with a call before any judgment: allow it, deny it, hold it, or ask the judge. */
export type Plan =
  | { kind: "allow"; why: string }
  | { kind: "deny"; rule: ScopedRule; args: string }
  | {
      kind: "ask";
      reasons: string[];
      key: string;
      args: string;
      /** What the dialog's allow choices add: the folders of a directory-policy hold. */
      offer?: Offer;
      /** Held only by the directory policy; otherwise the call only reads. */
      readOnly?: boolean;
      /** Configured advice for the agent (a derived path's hint), used instead of asking Jev for a workaround. */
      advice?: string;
      /** An ask rule: it asks you at once, in every mode, with no push-back and no judgment. */
      direct?: boolean;
    }
  | { kind: "judge"; args: string; key: string; offer?: Offer };

/** What the dialog's allow choices add, for the session, the project or everywhere. */
export interface Offer {
  /** Rules, or folder grants (directory-policy holds, which have no everywhere). */
  kind: "rules" | "dirs";
  /** Rule texts, or folder grant keys (`dir:read:/abs`). */
  items: string[];
  /** How each shows in the question: the rule, or `reads in ~/Downloads`. */
  labels: string[];
}

function rulesOffer(rules: readonly string[]): Offer | undefined {
  return rules.length ? { kind: "rules", items: [...rules], labels: [...rules] } : undefined;
}

function dirsOffer(items: ReadonlyArray<readonly [key: string, label: string]>): Offer {
  return { kind: "dirs", items: items.map(([key]) => key), labels: items.map(([, label]) => label) };
}

export interface Annotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

/** What the gate looked up about a call's surroundings, so that planning it is pure. */
export interface PlanContext {
  config: GateConfig;
  /** The current git branch, for force-pushes without a refspec. */
  branch?: string;
  /** Secret files named in unforced `git add`s that git ignores (see `secretGitAdds`). */
  ignored?: ReadonlySet<string>;
  /** The project's checkouts, for the directory policy (default: the working directory). */
  projects?: readonly string[];
  /** A tool's annotations, for its read-only hint. */
  annotations?: (tool: string) => Annotations | undefined;
  /** Whether a folder grant (`dir:read:/abs`) was made for the session or the project. */
  granted?: (key: string) => boolean;
  /** Every permission rule in force (permissions.ts): session, project and user. */
  rules?: readonly ScopedRule[];
  /** The project's root, which relative path rules are relative to (default: the first of `projects`, else the working directory). */
  root?: string;
  /** pi-plan-mode's plan file, always writable. */
  planFile?: string;
  /** Files this session downloaded: running one is always held. */
  downloads?: Downloads;
}

/**
 * What the gate does with a call before any judgment. A deny rule stops it; an ask rule asks you
 * (whatever else is true); read-only calls and calls an allow rule covers are allowed, always-held
 * calls (fixed rules, downloaded code) and calls outside the project's directories are held, and
 * the rest go to the judge. Pure: the caller looks up git, the project, rules and grants first.
 */
export function planCall(tool: string, input: Record<string, unknown>, cwd: string, c: PlanContext): Plan {
  const call: Call = { tool, input, cwd, root: c.root ?? c.projects?.[0] ?? cwd, readOnlyCommands: c.config.readOnlyCommands };
  const hit = c.rules?.length ? blocking(c.rules, call) : undefined;
  const args = clip(SHELL_TOOLS.has(tool) ? String(input.command ?? "") : JSON.stringify(input), 6_000);
  if (hit?.list === "deny") return { kind: "deny", rule: hit, args };
  const planned = planWithHolds(tool, input, cwd, c, call);
  if (!hit) return planned;
  const reasons = [`matches the ask rule ${hit.text} (${describeOrigin(hit.origin, shown)})`, ...(planned.kind === "ask" ? planned.reasons : [])];
  // Chat mode lets a call ask only when it reads.
  const readOnly = planned.kind === "allow" ? planned.why !== ALLOWED_BY_RULE : planned.kind === "ask" && planned.readOnly === true;
  return { kind: "ask", reasons, key: `rule:${hit.text}`, args, direct: true, readOnly, ...(planned.kind === "ask" && planned.advice ? { advice: planned.advice } : {}) };
}

function planWithHolds(tool: string, input: Record<string, unknown>, cwd: string, c: PlanContext, call: Call): Plan {
  const base = basePlan(tool, input, cwd, c, call);
  const holds = base.kind === "allow" && base.why === "allow list" ? [] : directoryHolds(tool, input, cwd, c, call);
  if (!holds.length) return base;
  const reasons = [...new Set(holds.map((v) =>
    v.hint !== undefined
      ? `writes ${shown(v.file)}, a derived path (generated from a source elsewhere)`
      : `${v.access === "write" ? "writes" : "reads"} ${shown(v.file)}, outside this project's directories`))];
  const hints = [...new Set(holds.flatMap((v) => (v.hint !== undefined ? [v.hint || "Edit its source instead."] : [])))];
  const advice = hints.length ? hints.join(" ") : undefined;
  const scopes = [...new Map(holds.map((v) => [grantKey(v), v])).values()];
  const offer = dirsOffer(scopes.map((v) => [grantKey(v), `${v.access}s in ${shown(v.scope)}`] as const));
  const args = base.kind === "allow" || base.kind === "deny" ? clip(SHELL_TOOLS.has(tool) ? String(input.command ?? "") : JSON.stringify(input), 6_000) : base.args;
  if (base.kind === "ask") return { ...base, reasons: [...base.reasons, ...reasons], key: `${base.key}; dirs`, advice };
  return {
    kind: "ask",
    reasons,
    key: `dirs:${offer.items.join("|")}`,
    args,
    offer,
    // A rule that allows a command does not make it read-only: chat mode lets only reads ask.
    readOnly: base.kind === "allow" && base.why !== ALLOWED_BY_RULE,
    advice,
  };
}

/**
 * Paths this call touches that the directory policy does not cover, minus granted folders and, for
 * `edit`, `write` and the reading tools, files an allow rule for the tool names.
 */
function directoryHolds(tool: string, input: Record<string, unknown>, cwd: string, c: PlanContext, call: Call) {
  const { config } = c;
  if (config.directories.enabled === false) return [];
  let access: { reads: string[]; writes: string[] };
  if (SHELL_TOOLS.has(tool)) {
    access = bashPathAccess(String(input.command ?? ""), shellDir(tool, input, cwd), config.readOnlyCommands, config.directories.exemptCommands, cwd);
  } else if (tool === "edit" || tool === "write") {
    access = { reads: [], writes: [path.resolve(cwd, expandHome(String(input.path ?? "")))] };
  } else if (BUILTIN_READ.has(tool)) {
    access = { reads: [path.resolve(cwd, expandHome(String(input.path ?? ".") || "."))], writes: [] };
  } else return [];
  const policy = resolvePolicy(config.directories, c.projects ?? [path.resolve(cwd)]);
  // The plan file pi-plan-mode hands out is always writable.
  if ((tool === "edit" || tool === "write") && c.planFile && access.writes[0] === c.planFile) return [];
  const rules = c.rules ?? [];
  const root = call.root ?? cwd;
  const opened = (v: { file: string; hint?: string }) =>
    v.hint === undefined && rules.length > 0 && (tool === "edit" || tool === "write" || BUILTIN_READ.has(tool)) && allowsPath(rules, tool, v.file, root);
  return violations(policy, access).filter((v) => !c.granted?.(grantKey(v)) && !opened(v));
}

function basePlan(tool: string, input: Record<string, unknown>, cwd: string, c: PlanContext, call: Call): Plan {
  const { config } = c;
  const rules = c.rules ?? [];
  if (config.allowTools.includes(tool)) return { kind: "allow", why: "allow list" };
  if (SHELL_TOOLS.has(tool)) {
    const command = String(input.command ?? "");
    const dir = shellDir(tool, input, cwd);
    const downloaded = c.downloads ? downloadedRunReasons(command, dir, c.downloads) : [];
    const reasons = [...alwaysAskBash(command, dir, c.branch, c.ignored ?? new Set()), ...downloaded];
    // Always-held calls are opened by no prefix rule: only a rule naming the exact command does, and
    // never for downloaded code, which is allow-once only.
    if (reasons.length) {
      if (downloaded.length || !allowing(rules, call, true)) {
        return { kind: "ask", reasons, key: `fixed:${reasons.join("; ")}`, args: clip(command, 6_000) };
      }
      return { kind: "allow", why: ALLOWED_BY_RULE };
    }
    if (isReadOnlyBash(command, config.readOnlyCommands)) return { kind: "allow", why: "read-only command" };
    if (allowing(rules, call)) return { kind: "allow", why: ALLOWED_BY_RULE };
    const keys = bashKeys(command, config.readOnlyCommands);
    return { kind: "judge", args: clip(command, 6_000), key: `bash:${keys.join("|")}`, offer: rulesOffer(suggest(call)) };
  }
  if (tool === "edit" || tool === "write") {
    const file = String(input.path ?? "");
    const reasons = alwaysAskPath(file);
    if (reasons.length) {
      if (!allowing(rules, call, true)) return { kind: "ask", reasons, key: `fixed:${reasons.join("; ")}`, args: clip(JSON.stringify(input), 6_000) };
      return { kind: "allow", why: ALLOWED_BY_RULE };
    }
    if (allowing(rules, call)) return { kind: "allow", why: ALLOWED_BY_RULE };
    const dir = path.dirname(path.resolve(cwd, expandHome(file)));
    return { kind: "judge", args: clip(JSON.stringify(input), 6_000), key: `${tool}:${dir}`, offer: rulesOffer(suggest(call)) };
  }
  if (BUILTIN_READ.has(tool)) {
    const file = String(input.path ?? "");
    if (tool === "read" && file && isCredentialPath(expandHome(file)) && !allowing(rules, call, true)) {
      return { kind: "ask", reasons: [`reads credentials (${file})`], key: `read:${file}`, args: clip(JSON.stringify(input), 2_000) };
    }
    return { kind: "allow", why: "read-only tool" };
  }
  if (c.annotations?.(tool)?.readOnlyHint === true) return { kind: "allow", why: "read-only hint" };
  if (allowing(rules, call)) return { kind: "allow", why: ALLOWED_BY_RULE };
  return { kind: "judge", args: clip(JSON.stringify(input), 6_000), key: `tool:${tool}`, offer: rulesOffer(suggest(call)) };
}

/** The local script a shell call runs, for the judge to read (see `scriptFor`); undefined for other tools. */
export function scriptOfCall(tool: string, input: Record<string, unknown>, cwd: string, downloads?: Downloads): Script | undefined {
  return SHELL_TOOLS.has(tool) ? scriptFor(String(input.command ?? ""), shellDir(tool, input, cwd), downloads) : undefined;
}

/**
 * The state the judge sees for a call, from the branch as it stands when the call is made: the
 * user's last five messages, the agent message the newest one replies to, and the agent's recent text.
 */
export function judgeStateOf(branch: readonly unknown[], call: Omit<JudgeInput, "userRequest" | "agentBefore" | "recentIntent">): Record<string, unknown> {
  return judgeState({
    userRequest: recentUserMessages(branch, 5).map((text, i, all) => clip(text, i === all.length - 1 ? 3_000 : 1_000)),
    agentBefore: clipTail(agentBeforeLatestUser(branch), 1_500),
    recentIntent: clipTail(recentTexts(branch).assistant, 2_000),
    ...call,
  });
}

export default function toolGate(pi: ExtensionAPI) {
  // A message on a declined call is the user's words: pi-sticky-last-prompt pins it like a prompt.
  // Any tool can be declined, and blocked calls never reach tool_result, so read the result text.
  offerUserWords(pi, "*", ({ result }) => declinedMessage(result));
  let config: GateConfig = DEFAULT_CONFIG;
  let workflow: BaseWorkflowMode = "work";
  let approval: ApprovalMode = "auto";
  let execActive = false;
  let revision = 0;
  const effectiveWorkflow = (): WorkflowMode => execActive ? "exec" : workflow;
  // A mode change cancels decisions, not the usage of tools already running on this branch.
  const invalidate = () => { revision++; pushedBackThisTurn.clear(); };
  const staleResult = () => ({ block: true, reason: "tool-gate blocked this call: modes changed; the call must be reevaluated." });
  /** pi-plan-mode is installed and offers plan mode; the plan file it may write. */
  let planProvider = false;
  let planFile: string | undefined;
  let hostCtx: ExtensionContext | undefined;
  /** The agent was last told that chat mode is on. */
  let chatTold = false;
  let auto = 0;
  let held = 0;
  let pushedBack = 0;
  /** Calls (and families of calls) pushed back this user turn; a retry goes to the user. */
  const pushedBackThisTurn = new Set<string>();
  /** Rules allowed for this session, and the folders (`dir:read:/abs`): held in memory, never saved. */
  let sessionRules: ScopedRule[] = [];
  const sessionDirs = new Set<string>();
  /** This project's saved folder grants and rules, from grants.ts, and the rules in the config files. */
  let localDirs = new Map<string, DirGrant>();
  let localRules: ScopedRule[] = [];
  let fileRules: ScopedRule[] = [];
  let ignoredRules: IgnoredRule[] = [];
  /** Every rule in force, as of the last `refreshRules`. */
  let allRules: readonly ScopedRule[] = [];
  const granted = (key: string) => sessionDirs.has(key) || localDirs.has(key);
  /** Files this session downloaded (downloads.ts), rebuilt from the branch on start and tree moves. */
  let downloads = new Downloads();
  const pendingUsage = new Map<string, ClassifierUsage>();
  let gitInfo: Promise<{ branch: string; dirty: boolean } | undefined> | undefined;
  let dialogs: Promise<unknown> = Promise.resolve();
  let warnedUnavailable = false;

  const annotations = (tool: string): Annotations | undefined => {
    const info = pi.getAllTools().find((t) => t.name === tool) as { annotations?: Annotations } | undefined;
    return info?.annotations;
  };

  const keyConfig = loadConfig("tool-gate", DEFAULT_CONFIG, process.cwd());
  const shortcut = (typeof keyConfig.workflowShortcut === "string" ? keyConfig.workflowShortcut
    : typeof keyConfig.cycleShortcut === "string" ? keyConfig.cycleShortcut : "shift+tab").trim();
  const approvalShortcut = (typeof keyConfig.approvalShortcut === "string" ? keyConfig.approvalShortcut : "alt+a").trim();
  const duplicateShortcut = !!shortcut && shortcut.toLowerCase() === approvalShortcut.toLowerCase();

  const status = (ctx: ExtensionContext | undefined) => {
    if (!ctx?.hasUI) return;
    try {
      ctx.ui.setStatus(WORKFLOW_STATUS_KEY, workflowStatus(effectiveWorkflow(), shortcut || undefined));
      ctx.ui.setStatus(MODE_STATUS_KEY, modeStatus(approval, duplicateShortcut ? undefined : approvalShortcut || undefined));
      // Jev's counts matter where Jev judges: auto mode, and commands while planning.
      ctx.ui.setStatus(
        STATUS_KEY,
        approval === "auto" || effectiveWorkflow() === "plan" ? `gate: ${auto} auto · ${pushedBack} pushed back · ${held} asked` : undefined,
      );
    } catch {
      // A stale context after a session switch.
    }
  };

  const cycle = () => workflowCycle(planProvider);
  const defaults = (config: GateConfig) => {
    const legacy = parseLegacyCombinedMode(config.defaultMode);
    return {
      workflow: parseWorkflow(config.defaultWorkflow) ?? (legacy === "chat" || legacy === "plan" ? legacy : "work"),
      approval: parseApproval(config.defaultApproval) ?? (!config.enabled ? "bypassPermissions" : parseApproval(legacy) ?? "auto"),
      execActive: false,
    } as const;
  };
  const emit = (name: string, data: unknown) => {
    try { pi.events.emit(name, data); } catch { /* A listener's failure is its own. */ }
  };
  const broadcastWorkflow = (source: WorkflowSource, previous?: WorkflowMode) => emit(WORKFLOW_CHANGED, {
    mode: effectiveWorkflow(), ...(previous ? { previous } : {}), cycle: cycle(), ...(shortcut ? { key: shortcut } : {}), source,
  });
  // Query destination state directly: neither the cached branch nor lifecycle listener order is authoritative.
  pi.events.on(WORKFLOW_QUERY, (data) => {
    const query = data as { entries?: unknown; cwd?: unknown; reply?: unknown } | undefined;
    if (!Array.isArray(query?.entries) || typeof query.cwd !== "string" || typeof query.reply !== "function") return;
    const restored = restoreBranchModes(query.entries, defaults(loadConfig("tool-gate", DEFAULT_CONFIG, query.cwd)));
    const snapshot: WorkflowSnapshot = {
      mode: restored.execActive ? "exec" : restored.workflow,
      cycle: cycle(), ...(shortcut ? { key: shortcut } : {}), source: "restore",
    };
    query.reply(snapshot);
  });
  const broadcastApproval = (previous?: ApprovalMode) => emit(MODE_CHANGED, {
    mode: approval, ...(previous ? { previous } : {}), cycle: [...APPROVAL_CYCLE],
  });
  const persist = (entry: string, mode: string) => {
    try { pi.appendEntry(entry, { version: 1, mode }); } catch { /* No session yet. */ }
  };
  const setWorkflow = (next: BaseWorkflowMode, ctx: ExtensionContext | undefined = hostCtx): boolean => {
    if (execActive) { ctx?.ui.notify(EXEC_GUIDANCE, "warning"); return false; }
    if (next === "plan" && !planProvider) { ctx?.ui.notify("Plan mode needs pi-plan-mode.", "warning"); return false; }
    const previous = effectiveWorkflow();
    if (next === workflow) return true;
    workflow = next;
    invalidate();
    persist(WORKFLOW_ENTRY, workflow);
    status(ctx);
    broadcastWorkflow("transition", previous);
    tellChatNow(ctx);
    return true;
  };
  const setApproval = (next: ApprovalMode, ctx: ExtensionContext | undefined = hostCtx) => {
    if (approval === next) return;
    const previous = approval;
    approval = next;
    invalidate();
    persist(APPROVAL_ENTRY, approval);
    status(ctx);
    broadcastApproval(previous);
  };

  const chatNotice = () => (effectiveWorkflow() === "chat" ? chatEnterText(shortcut) : chatExitText(effectiveWorkflow()));
  const markChatTold = () => {
    chatTold = effectiveWorkflow() === "chat";
    try { pi.appendEntry(CHAT_ENTRY, { told: chatTold }); } catch { /* No session yet. */ }
  };
  /** Mid-turn, tell the agent about a workflow change now; otherwise with the next message. */
  const tellChatNow = (ctx: ExtensionContext | undefined) => {
    if (!ctx || (effectiveWorkflow() === "chat") === chatTold) return;
    try {
      if (ctx.isIdle()) return;
      pi.sendMessage(
        { customType: CHAT_ENTRY, content: chatNotice(), display: false, details: { active: effectiveWorkflow() === "chat" } },
        { deliverAs: "steer" },
      );
    } catch { return; }
    markChatTold();
  };
  const cycleWorkflow = (ctx: ExtensionContext | undefined = hostCtx) => {
    if (execActive) { ctx?.ui.notify(EXEC_GUIDANCE, "warning"); return; }
    setWorkflow(nextWorkflow(workflow, planProvider) as BaseWorkflowMode, ctx);
  };
  pi.events.on(WORKFLOW_SET, (data) => {
    const next = parseWorkflow((data as { mode?: unknown } | undefined)?.mode);
    if (next) setWorkflow(next);
  });
  pi.events.on(WORKFLOW_CYCLE, () => cycleWorkflow());
  pi.events.on(MODE_SET, (data) => {
    const next = parseApproval((data as { mode?: unknown } | undefined)?.mode);
    if (next) setApproval(next);
  });
  pi.events.on(MODE_CYCLE, () => setApproval(nextApproval(approval)));
  pi.events.on(EXEC_CHANGED, (data) => {
    const event = data as { active?: unknown; source?: unknown } | undefined;
    // Reconstruction is only a snapshot. Our lifecycle hook owns destination branch restoration.
    if (event?.source !== "transition") return;
    const active = event.active;
    if (typeof active !== "boolean" || active === execActive) return;
    const previous = effectiveWorkflow();
    execActive = active;
    if (!active) { workflow = "work"; persist(WORKFLOW_ENTRY, workflow); }
    invalidate();
    status(hostCtx);
    broadcastWorkflow("transition", previous);
    tellChatNow(hostCtx);
  });
  pi.events.on(PLAN_PROVIDER, (data) => {
    const file = (data as { planFile?: unknown } | undefined)?.planFile;
    const nextFile = typeof file === "string" && file ? path.resolve(file) : undefined;
    if (nextFile !== planFile) { planFile = nextFile; invalidate(); }
    const available = planProvider;
    planProvider = true;
    if (!available) broadcastWorkflow("restore");
  });

  if (shortcut) {
    pi.registerShortcut(shortcut as never, {
      description: "Cycle workflow (work, chat, plan)",
      handler: async (ctx) => { cycleWorkflow(ctx); },
    });
  }
  if (approvalShortcut && !duplicateShortcut) {
    pi.registerShortcut(approvalShortcut as never, {
      description: "Toggle approvals (auto, yolo)",
      handler: async (ctx) => { setApproval(nextApproval(approval), ctx); },
    });
  }

  const git = (cwd: string) => {
    gitInfo ??= (async () => {
      try {
        const branch = await pi.exec("git", ["-C", cwd, "branch", "--show-current"], { timeout: 2_000 });
        if (branch.code !== 0) return undefined;
        const dirty = await pi.exec("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=no"], { timeout: 2_000 });
        return { branch: branch.stdout.trim() || "(detached)", dirty: dirty.stdout.trim().length > 0 };
      } catch {
        return undefined;
      }
    })();
    return gitInfo;
  };

  /** Which of these paths git ignores, asked in the directory each `git add` runs in. */
  const ignoredByGit = async (byDir: Map<string, string[]>): Promise<Set<string>> => {
    const ignored = new Set<string>();
    for (const [dir, files] of byDir) {
      try {
        const out = await pi.exec("git", ["-C", dir, "check-ignore", "--", ...files], { timeout: 2_000 });
        for (const line of out.stdout.split("\n")) if (line.trim()) ignored.add(path.resolve(dir, line.trim()));
      } catch {
        // Unknown means not ignored: the call is held.
      }
    }
    return ignored;
  };

  /** The project's checkouts: the git checkout `cwd` is in and, for a worktree, its main checkout. */
  const projects = new Map<string, Promise<string[]>>();
  const projectOf = (cwd: string) => {
    let found = projects.get(cwd);
    if (!found) {
      found = (async () => {
        try {
          const out = await pi.exec("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { timeout: 2_000 });
          const [top, common] = out.stdout.split("\n").map((l) => l.trim());
          if (out.code !== 0 || !top) return [path.resolve(cwd)];
          const main = common && path.basename(common) === ".git" ? path.dirname(common) : undefined;
          return main && main !== top ? [top, main] : [top];
        } catch {
          return [path.resolve(cwd)];
        }
      })();
      projects.set(cwd, found);
    }
    return found;
  };
  const policyFor = async (cwd: string): Promise<Policy> => resolvePolicy(config.directories, await projectOf(cwd));
  /** Where project grants are kept: the main checkout, so a project's worktrees share them. */
  const projectKey = async (cwd: string) => {
    const checkouts = await projectOf(cwd);
    return checkouts[checkouts.length - 1] ?? path.resolve(cwd);
  };
  /** Reload what is saved (this project's grants, the config files) and merge it with the session's rules. */
  const refreshRules = async (cwd: string) => {
    const epoch = revision;
    const local = localGrants(loadGrants(await projectKey(cwd)), grantsFile());
    if (epoch !== revision) return allRules;
    localRules = local.rules;
    localDirs = new Map(local.dirs.map((d) => [d.key, { key: d.key, access: d.access, dir: d.dir }]));
    const files = loadFileRules(cwd);
    fileRules = files.rules;
    ignoredRules = [...local.ignored, ...files.ignored];
    allRules = [...sessionRules, ...localRules, ...fileRules];
    return allRules;
  };

  /** Add a rule the user chose, in a scope; throws when it cannot be saved. */
  const addRule = async (scope: Scope, list: RuleList, text: string, cwd: string) => {
    if (scope === "session") {
      const rule = sessionRule(list, text);
      if (rule && !sessionRules.some((r) => r.list === list && r.raw === text)) sessionRules = [...sessionRules, rule];
    } else if (scope === "project") {
      addGrants(await projectKey(cwd), [{ key: ruleKey(list, text), label: text }]);
    } else editUserRules("add", list, text);
    await refreshRules(cwd);
  };

  const removeRule = async (rule: ScopedRule, cwd: string) => {
    if (rule.origin.scope === "session") sessionRules = sessionRules.filter((r) => r !== rule);
    else if (rule.origin.scope === "project" && !rule.origin.shared) removeGrant(await projectKey(cwd), rule.key ?? ruleKey(rule.list, rule.raw));
    else if (rule.origin.scope === "user" && rule.origin.writable) editUserRules("remove", rule.list, rule.raw);
    else throw new Error(`${describeOrigin(rule.origin, shown)} is read-only here`);
    await refreshRules(cwd);
  };

  /** The gate's plan for a call (`planCall`), after looking up git, the project and grants. */
  const plan = async (tool: string, input: Record<string, unknown>, cwd: string): Promise<Plan> => {
    const listed = config.allowTools.includes(tool);
    const shell = SHELL_TOOLS.has(tool) && !listed;
    const dir = shellDir(tool, input, cwd);
    const command = String(input.command ?? "");
    const checksPaths = !listed && config.directories.enabled !== false &&
      (SHELL_TOOLS.has(tool) || tool === "edit" || tool === "write" || BUILTIN_READ.has(tool));
    return planCall(tool, input, cwd, {
      config,
      branch: shell ? (await git(dir))?.branch : undefined,
      ignored: shell ? await ignoredByGit(secretGitAdds(command, dir)) : undefined,
      projects: checksPaths ? await projectOf(cwd) : undefined,
      annotations,
      granted,
      rules: allRules,
      root: (await projectOf(cwd))[0],
      planFile,
      downloads,
    });
  };

  const editorFactory = embeddedEditorFactory(pi);

  /** Ask the user, one dialog at a time. */
  const ask = (
    ctx: ExtensionContext,
    q: { tool: string; input: Record<string, unknown>; held?: string; agentCase?: string; note?: string },
    offer: Offer | undefined,
  ): Promise<{ block?: boolean; reason?: string } | undefined> => {
    const epoch = revision;
    const run = async () => {
      if (epoch !== revision) return staleResult();
      let items = offer ? [...offer.items] : [];
      /** An edit that was not a rule, to show again with what is wrong with it. */
      let draft: string | undefined;
      let problem: string | undefined;
      const view = await callView(q.tool, q.input, ctx.cwd);
      if (epoch !== revision) return staleResult();
      // Held only while the dialog is open, so queued approvals do not report blocked early.
      const label = clip(`Allow? ${describeCall(q.tool, q.input)}`.replace(/\s+/gu, " "), 60);
      for (;;) {
        const labels = offer ? choiceLabels(offer.kind, items.length > 1) : undefined;
        const options = [
          ALLOW_ONCE,
          ...(labels ? [labels.session, labels.project, ...(labels.everywhere ? [labels.everywhere] : []), ...(labels.edit ? [labels.edit] : [])] : []),
          BLOCK,
        ];
        const shownItems = offer ? items.map((item, i) => clip(offer.kind === "dirs" ? (offer.labels[i] ?? item) : item, 200)) : [];
        const noun = offer?.kind === "dirs" ? "Folder" : "Rule";
        // One flat line per rule or folder: an indented list under a header reads as a dialog Collie cannot read.
        const grant = shownItems.length ? shownItems.map((s) => `${noun}: ${s}`) : undefined;
        const title = [
          `Allow? ${describeCall(q.tool, q.input)}`,
          ...(q.held !== undefined ? [`Held: ${q.held}`] : []),
          ...(q.held !== undefined || q.agentCase !== undefined
            ? [`Agent: ${q.agentCase ? clip(q.agentCase.replace(/\s+/gu, " "), 600) : "(gave no reason)"}`]
            : []),
          ...(q.note ? [`(${q.note})`] : []),
          ...(grant ?? []),
          ...(problem ? [problem] : []),
        ].join("\n");
        const answer = await whileBlocked(pi.events, label, () =>
          askApproval(
            ctx,
            {
              view,
              held: q.held,
              agentCase: q.agentCase,
              note: q.note,
              options,
              ...(grant ? { grant } : {}),
              ...(labels?.edit ? { editRow: labels.edit, editText: draft ?? items.join("\n"), ...(problem ? { editError: problem } : {}) } : {}),
            },
            title,
            editorFactory,
          ),
        );
        if (epoch !== revision) return staleResult();
        problem = undefined;
        if (!answer) return { block: true, reason: DECLINED };
        if (answer.choice === ALLOW_ONCE) return undefined;
        if (offer && labels && answer.choice === labels.edit) {
          // Rules typed by the user, one per line (one rule may span lines when it is the only one).
          if (answer.edited === undefined) {
            draft = undefined;
            continue;
          }
          const typed = items.length === 1 ? [answer.edited.trim()] : answer.edited.split("\n").map((t) => t.trim()).filter(Boolean);
          const parsed = typed.map((t) => ({ t, p: parseRule(t) }));
          const bad = parsed.find((x) => !x.p.ok);
          if (!typed.length || typed.some((t) => !t) || bad) {
            draft = answer.edited;
            const why = bad && !bad.p.ok ? bad.p.error : "Type at least one rule.";
            problem = `Not a rule: ${why}`;
            continue;
          }
          items = [...new Set(parsed.map((x) => (x.p.ok ? x.p.rule.text : x.t)))];
          draft = undefined;
          continue;
        }
        if (offer && labels && (answer.choice === labels.session || answer.choice === labels.project || answer.choice === labels.everywhere)) {
          const scope: Scope = answer.choice === labels.session ? "session" : answer.choice === labels.project ? "project" : "user";
          try {
            await grantOffer(offer, items, scope, ctx.cwd);
          } catch (error) {
            ctx.ui.notify(`tool-gate: could not save it (${(error as Error).message}); allowed for this session only.`, "warning");
            await grantOffer(offer, items, "session", ctx.cwd);
          }
          return undefined;
        }
        if (answer.message) {
          return {
            block: true,
            reason: `${DECLINED_WITH_MESSAGE}${answer.message}${DECLINED_WITH_MESSAGE_END}`,
          };
        }
        return { block: true, reason: DECLINED };
      }
    };
    const next = dialogs.then(run, run);
    dialogs = next.catch(() => undefined);
    return next;
  };

  /** What a choice in the dialog adds: rules to the allow list, or folder grants, in a scope. */
  const grantOffer = async (offer: Offer, items: readonly string[], scope: Scope, cwd: string) => {
    if (offer.kind === "rules") {
      for (const text of items) await addRule(scope, "allow", text, cwd);
      return;
    }
    if (scope === "session") {
      for (const key of items) sessionDirs.add(key);
      return;
    }
    addGrants(await projectKey(cwd), items.map((key) => ({ key, label: offer.labels[offer.items.indexOf(key)] ?? key })));
    await refreshRules(cwd);
  };

  /** The state Jev judges a call in. */
  const judgeStateFor = async (ctx: ExtensionContext, tool: string, args: string, rules: readonly string[], script?: Script) =>
    judgeStateOf(ctx.sessionManager.getBranch(), { cwd: ctx.cwd, git: await git(ctx.cwd), tool, args, rules, script });

  /**
   * A held call. The first time in a user turn it is blocked with Jev's explanation and suggested
   * workaround, and the agent either works around it or makes its case and retries the identical
   * call. That retry (or another held call of the same family) goes to the user with the agent's
   * case, or is blocked without a user.
   */
  const hold = async (
    ctx: ExtensionContext,
    h: {
      toolCallId: string;
      revision: number;
      recordUsage: (usage: ClassifierUsage) => void;
      tool: string;
      input: Record<string, unknown>;
      family: string;
      /** Why it was held, for the agent. */
      reason: string;
      /** Why it was held, one line for the user. */
      summary: string;
      offer: Offer | undefined;
      state: Record<string, unknown>;
      /** Configured advice, used instead of asking Jev for a workaround. */
      advice?: string;
    },
  ) => {
    if (h.revision !== revision) return staleResult();
    const exact = `${h.tool}\0${JSON.stringify(h.input)}`;
    if (config.pushBack && !pushedBackThisTurn.has(exact) && !pushedBackThisTurn.has(h.family)) {
      pushedBackThisTurn.add(exact);
      pushedBackThisTurn.add(h.family);
      pushedBack++;
      status(ctx);
      let ideas: string[] = [];
      if (h.advice === undefined) {
        const suggestion = await askJev(ctx.modelRegistry, config.jev, { ...h.state, held_because: h.reason }, workaroundQuestion(), ctx.signal);
        if (h.revision !== revision) return staleResult();
        ideas = suggestion.ok ? suggestions(suggestion.answers) : [];
        if (suggestion.ok && suggestion.usage) h.recordUsage(suggestion.usage);
      }
      const noWorkaround = ideas[0] === WORKAROUNDS.user_only;
      const advice = h.advice !== undefined ? h.advice : noWorkaround
        ? "No workaround is apparent: whether to do this is the user's decision."
        : ideas.length
          ? `A suggested workaround: ${ideas.join("; or ")}.`
          : "Look for a safer way: reversible, local, narrower, or previewed first.";
      return {
        block: true,
        reason:
          `${h.reason}\n${advice}\nThe user has not been asked. ` +
          (noWorkaround ? "If the call still seems worth it, " : "Get the job done another way if you can. If no workaround is good enough, ") +
          "make your case: in a short visible message to the user (not only in your thinking), say why this exact call is needed" +
          (noWorkaround ? "" : " and why the workarounds fall short") +
          ", then make the identical call in that same message. tool-gate will show your case to the user and ask them to approve it. " +
          "If it is not worth raising, carry on without it.",
      };
    }
    held++;
    status(ctx);
    if (!ctx.hasUI) return { block: true, reason: `${h.reason}\nBlocked: there is no user to approve it.` };
    const agentCase = callerText(ctx.sessionManager.getBranch(), h.toolCallId);
    return ask(ctx, { tool: h.tool, input: h.input, held: h.summary, agentCase: clip(agentCase, 4_000) }, h.offer);
  };

  const describeCall = (tool: string, input: Record<string, unknown>) => {
    if (SHELL_TOOLS.has(tool)) return `${tool}: ${clip(String(input.command ?? ""), 200)}`;
    if (tool === "edit" || tool === "write") return `${tool}: ${String(input.path ?? "")}`;
    return `${tool}: ${clip(JSON.stringify(input), 200)}`;
  };

  /** Downloaded files as the branch stands: on a new, resumed or forked session, and after a tree move. */
  const rebuildDownloads = (ctx: ExtensionContext) => {
    try {
      downloads = downloadsOf(ctx.sessionManager.getBranch(), ctx.cwd);
    } catch {
      downloads = new Downloads();
    }
  };

  const restore = (ctx: ExtensionContext, newSession: boolean) => {
    invalidate();
    pendingUsage.clear();
    hostCtx = ctx;
    config = loadConfig("tool-gate", DEFAULT_CONFIG, ctx.cwd);
    rebuildDownloads(ctx);
    sessionRules = [];
    sessionDirs.clear();
    localDirs.clear();
    localRules = [];
    fileRules = [];
    allRules = [];
    ignoredRules = [];
    gitInfo = undefined;
    dialogs = Promise.resolve();
    if (newSession) { auto = 0; held = 0; pushedBack = 0; warnedUnavailable = false; }
    const entries = ctx.sessionManager.getBranch();
    const restored = restoreBranchModes(entries, defaults(config));
    workflow = restored.workflow;
    approval = restored.approval;
    execActive = restored.execActive;
    const told = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === CHAT_ENTRY);
    chatTold = told?.type === "custom" && (told.data as { told?: unknown } | undefined)?.told === true;
    if (duplicateShortcut) ctx.ui.notify("tool-gate: duplicate workflow and approval shortcut; registering workflow only.", "warning");
    status(ctx);
    broadcastWorkflow("restore");
    broadcastApproval();
  };
  pi.on("session_tree", (_event, ctx) => restore(ctx, false));
  pi.on("session_start", (_event, ctx) => restore(ctx, true));

  pi.on("session_shutdown", () => {
    invalidate();
    pendingUsage.clear();
    hostCtx = undefined;
  });

  pi.on("before_agent_start", (_event, ctx) => {
    config = loadConfig("tool-gate", DEFAULT_CONFIG, ctx.cwd);
    pushedBackThisTurn.clear();
    gitInfo = undefined;
    // A removed plan provider must not strand a restored session in planning.
    if (workflow === "plan" && !planProvider && !execActive) setWorkflow("work", ctx);
    if ((effectiveWorkflow() === "chat") === chatTold) return undefined;
    const content = chatNotice();
    markChatTold();
    return { message: { customType: CHAT_ENTRY, content, display: false, details: { active: effectiveWorkflow() === "chat" } } };
  });

  const allow = (ctx: ExtensionContext) => {
    auto++;
    status(ctx);
    return undefined;
  };

  /** Manual and accept-edits modes: you decide, with rules to allow for the session, the project or everywhere. */
  const askUser = (
    ctx: ExtensionContext,
    tool: string,
    input: Record<string, unknown>,
    p: Exclude<Plan, { kind: "allow" | "deny" }>,
  ) => {
    held++;
    status(ctx);
    if (!ctx.hasUI) {
      return { block: true, reason: `${approval === "default" ? "manual" : approval === "acceptEdits" ? "accept edits" : MODE_NAMES[approval]} mode needs the user's approval for this ${tool} call, and there is no user to ask.` };
    }
    return ask(ctx, { tool, input, ...(p.kind === "ask" ? { held: p.reasons.join("; ") } : {}) }, p.offer);
  };

  /** A deny rule's refusal, which tells the agent who decided and not to look for a way around it. */
  const deniedBy = (tool: string, rule: ScopedRule) => ({
    block: true as const,
    reason:
      `tool-gate blocked this ${tool} call: it matches the deny rule ${rule.text} (${describeOrigin(rule.origin, shown)}). ` +
      "The user forbade calls like this. Do not retry it or look for a way around it; if it matters, tell the user what you needed and let them decide.",
  });

  /**
   * Deny rules stop a call and ask rules ask you at once, in every mode: no judgment, no push-back.
   * Undefined when neither applies.
   */
  const ruleOutcome = (ctx: ExtensionContext, toolCallId: string, tool: string, input: Record<string, unknown>, p: Plan) => {
    if (p.kind === "deny") return { result: deniedBy(tool, p.rule) };
    if (p.kind !== "ask" || !p.direct) return undefined;
    held++;
    status(ctx);
    const why = p.reasons.join("; ");
    if (!ctx.hasUI) return { result: { block: true, reason: `tool-gate held this ${tool} call: it ${why}. There is no user to ask.` } };
    const agentCase = clip(callerText(ctx.sessionManager.getBranch(), toolCallId), 4_000);
    return { result: ask(ctx, { tool, input, held: why, agentCase }, undefined) };
  };

  pi.on("tool_call", async (event, ctx) => {
    const epoch = revision;
    const stale = () => epoch !== revision;
    let callUsage: ClassifierUsage | undefined;
    const recordUsage = (usage: ClassifierUsage) => { callUsage = addUsage(callUsage, usage); };
    const decide = async () => {
      const tool = event.toolName;
      const input = event.input as Record<string, unknown>;

      await refreshRules(ctx.cwd);
      if (stale()) return staleResult();

      if (effectiveWorkflow() === "chat") {
        // Talking, not acting: what the gate counts as read-only runs, nothing else does (an allow rule
        // does not make a command read-only).
        const p = await plan(tool, input, ctx.cwd);
        if (stale()) return staleResult();
        if (p.kind === "deny") return deniedBy(tool, p.rule);
        if (p.kind === "allow" && p.why !== ALLOWED_BY_RULE) return allow(ctx);
        // A read outside the project's directories: yours to allow, as in manual mode.
        if (p.kind === "ask" && p.readOnly) return askUser(ctx, tool, input, p);
        return {
          block: true,
          reason:
            `Chat mode is on: only read-only tools run, and this ${tool} call is not one. Do not retry it or work around it. ` +
            `Answer from what you can read, or tell the user what you would do; they can switch modes (${shortcut || "/mode"}) to let you act.`,
        };
      }

      if (effectiveWorkflow() === "plan" && (tool === "edit" || tool === "write")) {
        const forbidden = blocking(allRules, { tool, input, cwd: ctx.cwd, root: (await projectOf(ctx.cwd))[0], readOnlyCommands: config.readOnlyCommands });
        if (stale()) return staleResult();
        if (forbidden?.list === "deny") return deniedBy(tool, forbidden);
        const file = path.resolve(ctx.cwd, expandHome(String(input.path ?? "")));
        if (planFile && file === planFile) return allow(ctx);
        return {
          block: true,
          reason: `Plan mode is on: nothing may be edited until the user approves a plan.${planFile ? ` The only file you may write is the plan file, ${planFile}.` : ""}`,
        };
      }

      if (approval === "bypassPermissions" && effectiveWorkflow() !== "plan") {
        // Everything runs, except what a deny rule forbids, and removing /, home, the project or a
        // parent of them (as Claude Code).
        const call: Call = { tool, input, cwd: ctx.cwd, root: (await projectOf(ctx.cwd))[0], readOnlyCommands: config.readOnlyCommands };
        if (stale()) return staleResult();
        const forbidden = blocking(allRules, call);
        if (forbidden?.list === "deny") return deniedBy(tool, forbidden);
        if (!SHELL_TOOLS.has(tool)) return undefined;
        const command = String(input.command ?? "");
        const critical = alwaysAskBash(command, ctx.cwd).filter((reason) => reason.startsWith("deletes "));
        if (!critical.length) return undefined;
        held++;
        if (!ctx.hasUI) return { block: true, reason: `tool-gate held this call: it ${critical.join("; ")}. There is no user to approve it.` };
        return ask(ctx, { tool, input, held: critical.join("; ") }, undefined);
      }

      const p = await plan(tool, input, ctx.cwd);
      if (stale()) return staleResult();

      const ruled = ruleOutcome(ctx, event.toolCallId, tool, input, p);
      if (ruled) return ruled.result;
      if (p.kind === "allow") return allow(ctx);
      if (p.kind === "deny") return undefined;

      if (effectiveWorkflow() !== "plan" && approval === "default") return askUser(ctx, tool, input, p);
      if (effectiveWorkflow() !== "plan" && approval === "acceptEdits") {
        const accepted = p.kind === "judge" && (await acceptsEdit(tool, input, ctx.cwd));
        if (stale()) return staleResult();
        if (accepted) return allow(ctx);
        return askUser(ctx, tool, input, p);
      }

      if (p.kind === "ask") {
        const why = p.reasons.join("; ");
        if (stale()) return staleResult();
        return hold(ctx, {
          toolCallId: event.toolCallId,
          revision: epoch,
          recordUsage,
          tool,
          input,
          family: p.key,
          reason: `tool-gate held this ${tool} call: it ${why}. Calls like this are always held, whatever the judge says.`,
          summary: why,
          offer: p.offer,
          state: await judgeStateFor(ctx, tool, p.args, []),
          advice: p.advice,
        });
      }

      const rules = loadRules(ctx.cwd);
      // A local script is judged by what it does: its content goes to the judge.
      const script = scriptOfCall(tool, input, ctx.cwd, downloads);
      const state = await judgeStateFor(ctx, tool, p.args, rules, script);
      if (stale()) return staleResult();
      const outcome = await askJev(ctx.modelRegistry, config.jev, state, judgeQuestions(rules, { script: script !== undefined }), ctx.signal);

      if (stale()) return staleResult();
      if (!outcome.ok) {
        if (!warnedUnavailable && ctx.hasUI && !/off in settings/u.test(outcome.reason)) {
          warnedUnavailable = true;
          ctx.ui.notify(`tool-gate: judge unavailable (${outcome.reason}); asking for calls Pi's tool hints flag.`, "warning");
        }
        const hints = annotations(tool);
        const flagged =
          hints?.destructiveHint === true ||
          (!hints?.readOnlyHint && ((hints?.destructiveHint ?? true) || (hints?.openWorldHint ?? true)));
        if (!flagged || !ctx.hasUI) {
          auto++;
          status(ctx);
          return undefined;
        }
        held++;
        status(ctx);
        return ask(ctx, { tool, input, note: `Judge unavailable: ${outcome.reason}` }, p.offer);
      }

      if (outcome.usage) recordUsage(outcome.usage);
      const v = verdict(outcome.answers, rules, config.thresholds);
      const action = !v || v.allow ? "allow" : "hold";
      pi.appendEntry("tool-gate:decision", {
        tool,
        args: clip(p.args, 500),
        scores: v?.scores,
        failures: v?.failures,
        action,
        ...(script ? { script: script.path } : {}),
        latencyMs: outcome.latencyMs,
        inputTokens: outcome.usage?.input,
      });

      if (action === "allow") {
        auto++;
        status(ctx);
        return undefined;
      }
      const rules_ = v!.brokenRules.length ? ` (${v!.brokenRules.map((r) => `"${clip(r, 120)}"`).join(", ")})` : "";
      return hold(ctx, {
        toolCallId: event.toolCallId,
        revision: epoch,
        recordUsage,
        tool,
        input,
        family: p.key,
        reason: steerReason(tool, v!),
        summary: `${v!.failures.join("; ")}${rules_}`,
        offer: p.offer,
        state,
      });
    };
    const result = await decide();
    if (stale()) return staleResult();
    // Publish usage only after authorization, so stale or blocked decisions cannot leave it behind.
    if (!result?.block && callUsage) pendingUsage.set(event.toolCallId, callUsage);
    return result;
  });

  pi.on("tool_result", (event, ctx) => {
    // What a finished shell call downloaded, copied, moved or removed.
    if (!event.isError && SHELL_TOOLS.has(event.toolName)) {
      try {
        trackCall(downloads, event.toolName, (event.input ?? {}) as Record<string, unknown>, ctx.cwd);
      } catch {
        // A command this cannot follow changes nothing.
      }
    }
    const usage = pendingUsage.get(event.toolCallId);
    if (!usage) return undefined;
    pendingUsage.delete(event.toolCallId);
    return { usage: addUsage(event.usage as ClassifierUsage | undefined, usage) as never };
  });

  /** Accept-edits mode: edits and filesystem commands inside the project. */
  const acceptsEdit = async (tool: string, input: Record<string, unknown>, cwd: string) => {
    const root = path.resolve(cwd);
    if (tool === "edit" || tool === "write") {
      // Inside the project, or a directory it may write (the plan has already held any other).
      const file = path.resolve(cwd, expandHome(String(input.path ?? "")));
      return file.startsWith(`${root}${path.sep}`) || (config.directories.enabled !== false && canWrite(await policyFor(cwd), file));
    }
    if (!SHELL_TOOLS.has(tool)) return false;
    const dir = shellDir(tool, input, cwd);
    // bg_run in another directory still counts only for files inside the project.
    return isAcceptEditsBash(String(input.command ?? ""), dir, config.readOnlyCommands) &&
      (dir === root || dir.startsWith(`${root}${path.sep}`));
  };

  /** Pickers share the approval queue and blocked signal, including RPC's native select. */
  const pick = async (ctx: ExtensionContext, title: string, choices: string[]) => {
    const epoch = revision;
    const run = async () => {
      if (epoch !== revision) return undefined;
      const result = await whileBlocked(pi.events, title, () => ctx.ui.select(title, choices));
      return epoch === revision ? result : undefined;
    };
    const next = dialogs.then(run, run);
    dialogs = next.catch(() => undefined);
    return next;
  };
  pi.registerCommand("mode", {
    description: "Workflow: work, chat or plan (no argument: pick one)",
    getArgumentCompletions: (prefix: string) => cycle().filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name })),
    handler: async (args, ctx) => {
      hostCtx = ctx;
      const arg = args.trim().toLowerCase();
      if (arg === "exec") { ctx.ui.notify("Approving a distinct-model plan handoff enters exec. " + EXEC_GUIDANCE, "info"); return; }
      const legacyApproval = parseApproval(arg);
      if (legacyApproval) { setApproval(legacyApproval, ctx); return; }
      if (arg) {
        const next = parseWorkflow(arg);
        if (next) setWorkflow(next, ctx);
        else ctx.ui.notify("Usage: /mode [work|chat|plan].", "warning");
        return;
      }
      if (execActive) { ctx.ui.notify(EXEC_GUIDANCE, "info"); return; }
      if (!ctx.hasUI) { ctx.ui.notify(`Workflow: ${effectiveWorkflow()}. Usage: /mode [work|chat|plan].`, "info"); return; }
      const choices = cycle();
      const labels = choices.map((name) => name[0]!.toUpperCase() + name.slice(1));
      const selected = await pick(ctx, "Workflow", labels);
      const next = choices[labels.indexOf(selected ?? "")];
      if (next) setWorkflow(next, ctx);
    },
  });
  pi.registerCommand("approvals", {
    description: "Approvals: auto or yolo (no argument: pick one)",
    getArgumentCompletions: (prefix: string) => ["auto", "yolo"].filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name })),
    handler: async (args, ctx) => {
      hostCtx = ctx;
      const arg = args.trim();
      if (arg) {
        const next = parseApproval(arg);
        if (next) setApproval(next, ctx);
        else ctx.ui.notify("Usage: /approvals [auto|yolo].", "warning");
        return;
      }
      if (!ctx.hasUI) { ctx.ui.notify(`Approvals: ${MODE_NAMES[approval]}. Usage: /approvals [auto|yolo].`, "info"); return; }
      const selected = await pick(ctx, "Approvals", ["Auto", "Yolo"]);
      if (selected) setApproval(selected === "Auto" ? "auto" : "bypassPermissions", ctx);
    },
  });

  /** The rules in force for a project, and the ways `/gate rules` may change them. */
  const ruleStore = async (cwd: string): Promise<RuleStore> => {
    const project = await projectKey(cwd);
    await refreshRules(cwd);
    return {
      project: shown(project),
      rules: () => allRules,
      ignored: () => ignoredRules,
      dirs: () => [
        ...[...sessionDirs].flatMap((key) => {
          const d = migrateGrant(key);
          return d?.kind === "dir" ? [{ key, access: d.access, dir: d.dir, scope: "session" as const }] : [];
        }),
        ...[...localDirs.values()].map((d) => ({ ...d, scope: "project" as const })),
      ],
      add: (scope, list, text) => addRule(scope, list, text, cwd),
      remove: (rule) => removeRule(rule, cwd),
      removeDir: async (d) => {
        if (d.scope === "session") sessionDirs.delete(d.key);
        else {
          removeGrant(project, d.key);
          await refreshRules(cwd);
        }
      },
    };
  };

  pi.registerCommand("gate", {
    description: "tool-gate: status; on (auto mode) or off (yolo mode); rules (list, add and remove permission rules; grants is the same)",
    getArgumentCompletions: (prefix: string) =>
      ["status", "on", "off", "rules", "rules list", "rules add", "rules remove", "grants"]
        .filter((o) => o.startsWith(prefix))
        .map((o) => ({ value: o, label: o })),
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "on" || arg === "off") {
        setApproval(arg === "on" ? "auto" : "bypassPermissions", ctx);
        ctx.ui.notify(arg === "on" ? "Auto mode on" : "Yolo approvals on; workflow guards remain active", "info");
        return;
      }
      if (/^(rules|grants)(\s|$)/u.test(arg)) {
        await rulesCommand(arg.replace(/^(rules|grants)\s*/u, ""), ctx, await ruleStore(ctx.cwd));
        return;
      }
      const project = await projectKey(ctx.cwd);
      await refreshRules(ctx.cwd);
      const rules = loadRules(ctx.cwd);
      const counts = (list: RuleList) => allRules.filter((r) => r.list === list).length;
      ctx.ui.notify(
        [
          `Workflow: ${effectiveWorkflow()} (${shortcut || "no key"}). Approvals: ${MODE_NAMES[approval]} (${MODE_DESCRIPTIONS[approval]}) (${duplicateShortcut ? "no key" : approvalShortcut || "no key"}).`,
          `${auto} auto-approved, ${pushedBack} pushed back, ${held} asked this session.`,
          `Jev: ${config.jev.enabled ? `${config.jev.provider}/${config.jev.model}` : "off"}; push-back ${config.pushBack ? "on" : "off"}.`,
          `${rules.length} project rule${rules.length === 1 ? "" : "s"} for Jev. Permission rules for ${shown(project)}: ` +
            `${counts("allow")} allow, ${counts("ask")} ask, ${counts("deny")} deny; ${sessionRules.length} from this session; ` +
            `${localDirs.size + sessionDirs.size} folder grant${localDirs.size + sessionDirs.size === 1 ? "" : "s"} (/gate rules; saved in ${shown(grantsFile())}).`,
          config.directories.enabled === false ? "Directory policy: off." : describePolicy(await policyFor(ctx.cwd)),
        ].join("\n"),
        "info",
      );
    },
  });
}

export function chatEnterText(shortcut: string) {
  return `<system-reminder>
Chat mode is active. The user wants to talk: answer questions, explain, discuss and recommend. You MUST NOT make edits, run commands that change files or the system, commit, or otherwise make changes, even if asked to; this supersedes any other instructions. Read-only tools (reading and searching files, read-only commands, web lookups) run; anything else is blocked. If the user asks for a change, say what you would do; they can switch modes (${shortcut || "/mode"}) to let you act.
</system-reminder>`;
}

export function chatExitText(mode: WorkflowMode) {
  return `<system-reminder>
## Exited chat mode
You have left chat mode; the user switched to ${mode} workflow.${mode === "plan" ? "" : " You may now make edits, run tools, and take actions the user asks for."}
</system-reminder>`;
}

export function addUsage(a: ClassifierUsage | undefined, b: ClassifierUsage): ClassifierUsage {
  if (!a) return b;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}
