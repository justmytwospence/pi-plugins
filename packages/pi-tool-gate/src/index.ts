// pi-tool-gate: auto-approves tool calls. Fixed rules settle the clear cases (read-only calls run,
// a short list of dangerous ones is always held); Jev, through Pi's own classifier models, judges
// the gray zone. A held call is first blocked with Jev's explanation and suggested workaround; the
// agent works around it or makes its case and retries, and only that retry is put to you, with the
// case. Project rules in `.agents/tool-gate-rules.md` (or `.pi/`) are checked on every judged
// call. Without Jev the gate falls back to Pi's tool hints.
//
// Workflow and approvals are independent (see modes.ts): Shift+Tab cycles work/chat/plan;
// Alt+A toggles auto/yolo. The workflow decides what kind of call may run at all (chat: reads;
// plan: reads, its plan file and tools other than edits and shell commands); the approval setting
// alone decides whether a call that passes is judged, pushed back or put to you. Deny rules apply
// in every combination. Manual and accept-edits remain explicit legacy approval settings.
import path from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
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
import { isRecord } from "./config.ts";
import { delegatedPlanText, inScratch, planEditBlockReason, planShellBlockReason, repoWriteCandidates } from "./plan-scope.ts";
import { loadConfig, loadConfigReport, policyIssues, policyFiles } from "./policy-config.ts";
import { type ProjectContext, ProjectResolutionError, projectContextSync, projectFiles, projectSaveFile, resolveProject } from "./project.ts";
import {
  DEFAULT_DIRECTORIES,
  type DirectoriesConfig,
  type Policy,
  canWrite,
  canonicalPath,
  describePolicy,
  effectiveDirectories,
  grantKey,
  resolvePolicy,
  shown,
  under,
  violations,
} from "./dirs.ts";
import { Downloads, downloadedRunReasons, downloadsOf, type Script, scriptFor, trackCall } from "./downloads.ts";
import { grantsFile, legacyGrantErrors, loadGrants, removeGrant } from "./grants.ts";
import {
  absolutizeRule,
  allowing,
  allowsPath,
  blocking,
  type Call,
  describeOrigin,
  editUserRules,
  editRulesFile,
  editDirectoryGrant,
  ruleWarning,
  type IgnoredRule,
  loadFileRules,
  localGrants,
  migrateGrant,
  parseRule,
  type RuleList,
  type ScopedRule,
  type Scope,
  sessionRule,
  suggest,
  userRulesFile,
} from "./permissions.ts";
import { type DirGrant, rulesCommand, type RuleStore } from "./rules-command.ts";
import { whileBlocked } from "./herdr.ts";
import { type ClassifierUsage, type JevConfig, askJev, bool } from "./jev.ts";
import { installSystem1Notifications, provenanceOf, resolveSystem1Target, SYSTEM1_CHANGED, type System1FailureCode } from "./system1.js";
import {
  DEFAULT_THRESHOLDS,
  type JudgeInput,
  type Thresholds,
  WORKAROUNDS,
  judgeQuestions,
  judgeState,
  planScopeQuestion,
  readOnlyQuestion,
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
import { answerSubagentEnv, inheritedModes, SUBAGENT_ENV_CHANNEL, subagentEnv, subagentEnvHonored } from "./subagent-env.ts";
import { effectiveDenyInsteadOfPrompting, PROMPTING_CONTINUE, PROMPTING_DISABLED, PROMPTING_ENTRY, PROMPTING_STATUS_KEY, promptingDenied, restorePromptingOverride, type PromptingOverride } from "./prompting.ts";
import { loadRules } from "./rules.ts";
import { agentBeforeLatestUser, approvedPlanOf, callerText, clip, clipTail, recentTexts, recentUserMessages } from "./transcript.ts";
import { offerUserWords, resultText } from "./user-words.ts";
import { callView, describeCallPresentation } from "./view.ts";
import { registerWorkflowRenderer, sendWorkflowTransition } from "./workflow-ui.ts";
import { FOOTER_ACTIONS_CHANNEL, queryFooterActions, type FooterActionsRequest } from "./footer-actions.ts";
import { askReadOnlyCall } from "./read-only-call.ts";
import { settingsCycles, type SettingCycleTrigger } from "./settings-cycle.ts";

/** A declined call's result (Block). */
export const DECLINED = "The user declined this call. Do not retry it; continue without it, or ask the user how to proceed.";
/** A declined call's result, around the user's message to the agent (Block with a message). */
export const DECLINED_WITH_MESSAGE = "The user declined this call, with this message:\n\n";
export const DECLINED_WITH_MESSAGE_END = "\n\nDo not retry the call as it was; follow the user's message.";
/** Stable prefix for calls stopped because the classifier could not decide. */
export const CLASSIFIER_UNAVAILABLE = "Automatic approval could not determine this call's safety. The call did not run.";

/**
 * Who stopped a call, read from its result: the user (Block, Block with a message, or Esc), or
 * the gate on its own (a push-back, chat or plan mode, no user to ask). Undefined when it ran.
 */
export function blockedBy(result: { content?: unknown; isError?: boolean }): "user" | "gate" | undefined {
  if (!result.isError) return undefined;
  const text = resultText(result.content);
  if (text.startsWith(DECLINED) || text.startsWith(DECLINED_WITH_MESSAGE)) return "user";
  if (text.startsWith(CLASSIFIER_UNAVAILABLE)) return "gate";
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
  /** Deny calls needing permission instead of opening a tool approval dialog. */
  denyInsteadOfPrompting: boolean;
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
  persistence: { project: "local" | "shared"; userWritable: boolean };
  /** Plan workflow shell commands: `scoped` lets those that leave the repository unchanged through (then approvals); `read-only` allows only reads. */
  planShell: "scoped" | "read-only";
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
  denyInsteadOfPrompting: false,
  defaultMode: "auto",
  modes: ["default", "acceptEdits", "plan", "auto"],
  cycleShortcut: "shift+tab",
  approvalShortcut: "alt+a",
  directories: DEFAULT_DIRECTORIES,
  persistence: { project: "local", userWritable: true },
  planShell: "scoped",
};

/** The dialog's first and last rows. */
export const ALLOW_ONCE = "Allow once";
export const BLOCK = "Block";

/**
 * The rows that allow what is offered, short enough (at most 42 characters) that a phone client
 * reads them without wrapping: the rules or folders themselves are in the question.
 */
export function choiceLabels(kind: "rules" | "dirs", plural: boolean, userWritable = true): { session: string; project: string; everywhere?: string; edit?: string } {
  const noun = kind === "dirs" ? (plural ? "folders" : "folder") : plural ? "rules" : "rule";
  return {
    session: `Allow ${noun} for this session`,
    project: `Allow ${noun} in this project`,
    ...(userWritable ? { everywhere: `Allow ${noun} everywhere` } : {}),
    ...(kind === "rules" ? { edit: `Edit the ${noun}...` } : {}),
  };
}

const STATUS_KEY = "tool-gate";
/** Records whether the agent was last told chat mode is on, so it hears each change once. */
const CHAT_ENTRY = "tool-gate:chat-notice";
/** Records that a session whose parent is planning was told so. */
const DELEGATED_ENTRY = "tool-gate:delegated-plan-notice";

/** How a workflow block tells the agent to get a read through that one part of its command stopped. */
export const SPLIT_HINT =
  "If you meant only to read, a part of the command was not recognized as read-only: run simpler read-only commands " +
  "(rg, grep, find, cat, sed -n, git log/diff/show) or use the read tool. Expansions work when their commands only read; " +
  "put `--` before words from `$(...)` or xargs given to rg, sed or sort.";
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
  /** The tool owner's answer on the read-only-call contract; undefined when no owner answers. */
  readOnlyCall?: ReadOnlyCall;
  /** Whether a wildcard-named folder was granted (exact key `dir:read:/abs`); other grants are in `config.directories`. */
  granted?: (key: string) => boolean;
  /** Every permission rule in force (permissions.ts): session, project and user. */
  rules?: readonly ScopedRule[];
  /** The project's root, which relative path rules are relative to (default: the first of `projects`, else the working directory). */
  root?: string;
  /** pi-plan-mode's plan file, always writable. */
  planFile?: string;
  /** The plan workflow's scratch directory: writes under it are never held by the directory policy. */
  scratchDir?: string;
  /** The chat or plan workflow's System 1 read check judged this shell call read-only: approvals treat it as a parsed read. */
  judgedRead?: boolean;
  /** Subagent runs start children in chat (a chat or plan parent whose subagent provider honors subagent-env): they only read. */
  chatChildren?: boolean;
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
  return { kind: "ask", reasons, key: `rule:${hit.text}`, args, direct: true, ...(planned.kind === "ask" && planned.advice ? { advice: planned.advice } : {}) };
}

const scopesKey = (holds: ReadonlyArray<{ access: string; file: string }>) => holds.map((v) => `${v.access}:${v.file}`).join("|");

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
  // A derived path is never opened by a folder grant: only Allow once or Block.
  const scopes = [...new Map(holds.filter((v) => v.hint === undefined).map((v) => [grantKey(v), v])).values()];
  const offer = scopes.length ? dirsOffer(scopes.map((v) => [grantKey(v), `${v.access}s in ${shown(v.scope)}`] as const)) : undefined;
  const args = base.kind === "allow" || base.kind === "deny" ? clip(SHELL_TOOLS.has(tool) ? String(input.command ?? "") : JSON.stringify(input), 6_000) : base.args;
  if (base.kind === "ask") return { ...base, reasons: [...base.reasons, ...reasons], key: `${base.key}; dirs`, advice };
  return {
    kind: "ask",
    reasons,
    key: `dirs:${offer ? offer.items.join("|") : scopesKey(holds)}`,
    args,
    offer,
    advice,
  };
}

/**
 * Paths this call touches that the directory policy (folder grants included) does not cover, minus, for
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
  if ((tool === "edit" || tool === "write") && c.planFile && access.writes[0] !== undefined && canonicalPath(access.writes[0]) === c.planFile) return [];
  const rules = c.rules ?? [];
  const root = call.root ?? cwd;
  // The plan file and the plan's scratch directory are the workflow's own: never held, even when derived.
  const planOwn = (v: { access: string; file: string }) => {
    if (v.access !== "write") return false;
    const file = canonicalPath(v.file);
    return file === c.planFile || (c.scratchDir !== undefined && under(file, c.scratchDir));
  };
  const opened = (v: { file: string; hint?: string }) =>
    v.hint === undefined && rules.length > 0 && (tool === "edit" || tool === "write" || BUILTIN_READ.has(tool)) && allowsPath(rules, tool, v.file, root);
  return violations(policy, access).filter((v) => !planOwn(v) && !c.granted?.(grantKey(v)) && !opened(v));
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
    if (c.judgedRead) return { kind: "allow", why: "judged read" };
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
    if (file && isCredentialPath(expandHome(file)) && !allowing(rules, call, true)) {
      return { kind: "ask", reasons: [`reads credentials (${file})`], key: `read:${file}`, args: clip(JSON.stringify(input), 2_000) };
    }
    return { kind: "allow", why: "read-only tool" };
  }
  if (c.chatChildren && startsChatChild(tool, input)) return { kind: "allow", why: "chat subagent" };
  if (declaredRead(tool, input, c.annotations, c.readOnlyCall)) return { kind: "allow", why: "read-only hint" };
  if (allowing(rules, call)) return { kind: "allow", why: ALLOWED_BY_RULE };
  return { kind: "judge", args: clip(JSON.stringify(input), 6_000), key: `tool:${tool}`, offer: rulesOffer(suggest(call)) };
}

/** Whether a call reads by its tool's own declaration: its owner's answer for this input, else its static hint. */
export type ReadOnlyCall = (tool: string, input: Record<string, unknown>) => boolean | undefined;
function declaredRead(tool: string, input: Record<string, unknown>, annotations?: (tool: string) => Annotations | undefined, readOnlyCall?: ReadOnlyCall): boolean {
  return readOnlyCall?.(tool, input) ?? annotations?.(tool)?.readOnlyHint === true;
}

/**
 * Whether a call only reads, as chat and plan workflows count it: the allow list, Pi's reading
 * tools, read-only shell commands, calls whose tool's owner says they only read (herdr list,
 * subagent status; see read-only-call.ts), tools with a read-only hint, and subagent runs when
 * `chatChildren` (their children start in chat). Holds (credentials, the
 * directory policy) and rules do not change it; they belong to the approval setting.
 */
export function onlyReads(
  tool: string,
  input: Record<string, unknown>,
  config: Pick<GateConfig, "allowTools" | "readOnlyCommands">,
  annotations?: (tool: string) => Annotations | undefined,
  readOnlyCall?: ReadOnlyCall,
  chatChildren = false,
): boolean {
  if (config.allowTools.includes(tool) || BUILTIN_READ.has(tool)) return true;
  if (chatChildren && startsChatChild(tool, input)) return true;
  if (SHELL_TOOLS.has(tool)) {
    // Expansions whose commands only read count here; the approval checks after this still treat them as unparsed.
    const command = String(input.command ?? "");
    return isReadOnlyBash(command, config.readOnlyCommands) || isReadOnlyBash(command, config.readOnlyCommands, { expansions: true });
  }
  return declaredRead(tool, input, annotations, readOnlyCall);
}

/**
 * Whether a subagent call starts or resumes a child (not `worktree: true`, which creates
 * checkouts); it only reads when the child starts in chat, and a child of a planning session inherits plan
 * and its scratch directory (`chatChildren`, subagent-env.ts), so it counts as allowed there too.
 */
export function startsChatChild(tool: string, input: Record<string, unknown>): boolean {
  if (tool !== "subagent" || input.worktree === true) return false;
  return input.action === undefined || input.action === "run" || input.action === "resume";
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
    approvedPlan: approvedPlanOf(branch),
    ...call,
  });
}

export default function toolGate(pi: ExtensionAPI) {
  installSystem1Notifications(pi);
  const settings = settingsCycles(pi);
  registerWorkflowRenderer(pi);
  // A message on a declined call is the user's words: pi-sticky-last-prompt pins it like a prompt.
  // Any tool can be declined, and blocked calls never reach tool_result, so read the result text.
  offerUserWords(pi, "*", ({ result }) => declinedMessage(result));
  let config: GateConfig = DEFAULT_CONFIG;
  let workflow: BaseWorkflowMode = "work";
  let approval: ApprovalMode = "auto";
  let promptingOverride: PromptingOverride;
  const denyInsteadOfPrompting = () => effectiveDenyInsteadOfPrompting(promptingOverride, inheritedModes().denyInsteadOfPrompting, config.denyInsteadOfPrompting);
  const promptingState = () => `Permission prompts: ${denyInsteadOfPrompting() ? "off" : "on"} (source: ${promptingOverride !== undefined ? "session" : inheritedModes().denyInsteadOfPrompting !== undefined ? "inherited" : "config"}).`;
  let revision = 0;
  const effectiveWorkflow = (): WorkflowMode => workflow;
  // Mode and classifier changes cancel decisions, not usage of tools already running on this branch.
  const invalidate = () => { revision++; pushedBackThisTurn.clear(); classifierFailures.clear(); };
  const staleResult = () => ({ block: true, reason: "tool-gate blocked this call: modes changed or System 1 changed; the call must be reevaluated." });
  let system1Key = resolveSystem1Target(config.jev).key;
  const refreshSystem1Target = () => {
    const target = resolveSystem1Target(config.jev);
    if (target.key !== system1Key) {
      system1Key = target.key;
      invalidate();
    }
    return target;
  };
  // Read at interaction boundaries too: standalone components have no setting watcher.
  const decisionStale = (epoch: number) => {
    refreshSystem1Target();
    return epoch !== revision;
  };
  pi.events.on(SYSTEM1_CHANGED, () => { refreshSystem1Target(); });
  /** pi-plan-mode is installed and offers plan mode; the plan file it may write. */
  let planProvider = false;
  let planFile: string | undefined;
  /** Plan inherited from a planning parent (a subagent): its scratch directory, and whether it was told. */
  const delegated = () => inheritedModes().workflow === "plan";
  let scratchDir: string | undefined = inheritedModes().scratchDir;
  let delegatedTold = false;
  let hostCtx: ExtensionContext | undefined;
  let sessionGeneration = 0;
  let sessionReady = false;
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
  /** Folder grants whose name has a wildcard character match by exact key only (see `effectiveDirectories`). */
  const exactGrant = (key: string) => /[*?]/u.test(key) && (sessionDirs.has(key) || localDirs.has(key));
  /** The directory policy as granted: config, saved and session folder grants, and a worktree's main checkout (read). */
  const directoriesFor = async (cwd: string): Promise<DirectoriesConfig> => {
    const { root, main } = await contextFor(cwd);
    return effectiveDirectories(config.directories, [...sessionDirs, ...localDirs.keys()], main !== root ? main : undefined);
  };
  /** Files this session downloaded (downloads.ts), rebuilt from the branch on start and tree moves. */
  let downloads = new Downloads();
  const pendingUsage = new Map<string, ClassifierUsage>();
  let gitInfo: Promise<{ branch: string; dirty: boolean } | undefined> | undefined;
  let dialogs: Promise<unknown> = Promise.resolve();
  /** Unavailable decisions never grant a family or saved rule. */
  const classifierFailures = new Map<string, string>();
  let projectContext: ProjectContext | undefined;
  let projectLaunch: string | undefined;
  /** Why the last refresh kept the checkout resolved earlier (Git did not answer); unset once it answers. */
  let staleProject: string | undefined;
  let warnedStale = false;
  let policyLoadErrors: string[] = [];
  let erroredPolicyFiles: string[] = [];
  let policyDiagnostics: string[] = [];
  let warnedPolicy = false;
  let fileDirs: Array<DirGrant & { source: string; writable: boolean; shared: boolean }> = [];
  const MANAGED = "User rules are managed. Edit their source and deploy it; this command made no changes.";

  const annotations = (tool: string): Annotations | undefined => {
    const info = pi.getAllTools().find((t) => t.name === tool) as { annotations?: Annotations } | undefined;
    return info?.annotations;
  };
  const readOnlyCall: ReadOnlyCall = (tool, input) => askReadOnlyCall(pi.events, tool, input);
  /**
   * The chat and plan workflows' fallback for a shell command the parser could not prove read-only:
   * System 1's probability that it only reads, against `thresholds.readOnly`. Never reads when
   * System 1 is off or fails; `judged` says it answered.
   */
  const judgedReadOnly = async (
    ctx: ExtensionContext, tool: string, input: Record<string, unknown>, recordUsage: (usage: ClassifierUsage) => void,
  ): Promise<{ reads: boolean; judged: boolean; stale?: boolean }> => {
    const selectionKey = refreshSystem1Target().key;
    const script = scriptOfCall(tool, input, ctx.cwd, downloads);
    const state = {
      cwd: ctx.cwd,
      tool_call: { tool, arguments: clip(String(input.command ?? ""), 6_000) },
      ...(script ? { script: { path: script.path, content: script.content } } : {}),
    };
    const outcome = await askJev(ctx.modelRegistry, config.jev, state, readOnlyQuestion({ script: script !== undefined }), ctx.signal);
    if (outcome.usage) recordUsage(outcome.usage);
    if (!outcome.ok) {
      recordCheckFailure(tool, input, "only-reads", outcome);
      return { reads: false, judged: false };
    }
    if (outcome.selectionKey !== selectionKey) return { reads: false, judged: false, stale: true };
    const p = bool(outcome.answers, "only_reads");
    const reads = p !== undefined && p >= (config.thresholds.readOnly ?? DEFAULT_THRESHOLDS.readOnly);
    pi.appendEntry("tool-gate:decision", {
      tool,
      args: clip(String(input.command ?? ""), 500),
      check: "only-reads",
      scores: p === undefined ? {} : { only_reads: p },
      action: reads ? "allow" : "block",
      latencyMs: outcome.latencyMs,
      classifier: provenanceOf(outcome),
      ...(outcome.usage ? { usage: outcome.usage } : {}),
    });
    return { reads, judged: p !== undefined };
  };

  /** A workflow check that System 1 could not answer is a block: record it, as the answers are. */
  function recordCheckFailure(tool: string, input: Record<string, unknown>, check: string, outcome: { code?: unknown; usage?: ClassifierUsage }): void {
    pi.appendEntry("tool-gate:decision", {
      tool,
      args: clip(String(input.command ?? ""), 500),
      check,
      action: "block",
      errorClass: String(outcome.code ?? "ClassifierUnavailableError"),
      ...(outcome.usage ? { usage: outcome.usage } : {}),
    });
  }

  /**
   * The plan workflow's check for a shell command that does more than read: writes it names inside
   * the repository (git state always; other files unless git ignores them) block outright, and
   * otherwise System 1 must be sure it leaves the repository unchanged (`thresholds.planScope`).
   * Returns the block, "stale" when modes or System 1 changed meanwhile, or undefined to let the
   * call go on to approvals.
   */
  const scopedPlanShell = async (
    ctx: ExtensionContext, tool: string, input: Record<string, unknown>, recordUsage: (usage: ClassifierUsage) => void,
  ): Promise<{ block: true; reason: string } | "stale" | undefined> => {
    const context = await contextFor(ctx.cwd);
    const root = context.root;
    const command = String(input.command ?? "");
    const dir = shellDir(tool, input, context.cwd);
    const access = bashPathAccess(command, dir, config.readOnlyCommands, config.directories.exemptCommands, context.cwd);
    const { git, other } = repoWriteCandidates(access.writes, { root, planFile, scratchDir });
    const ignored = other.length ? await ignoredByGit(new Map([[root, other]])) : new Set<string>();
    const files = [...git, ...other.filter((file) => !ignored.has(file))];
    if (files.length) return { block: true, reason: planShellBlockReason(tool, { files }, scratchDir) };
    const selectionKey = refreshSystem1Target().key;
    const script = scriptOfCall(tool, input, ctx.cwd, downloads);
    const state = {
      cwd: ctx.cwd,
      repo_root: root,
      ...(scratchDir ? { scratch_dir: scratchDir } : {}),
      tool_call: { tool, arguments: clip(command, 6_000) },
      ...(script ? { script: { path: script.path, content: script.content } } : {}),
    };
    const outcome = await askJev(ctx.modelRegistry, config.jev, state, planScopeQuestion({ script: script !== undefined }), ctx.signal);
    if (outcome.usage) recordUsage(outcome.usage);
    if (!outcome.ok) {
      recordCheckFailure(tool, input, "plan-scope", outcome);
      return { block: true, reason: planShellBlockReason(tool, { unavailable: true }, scratchDir) };
    }
    if (outcome.selectionKey !== selectionKey) return "stale";
    const p = bool(outcome.answers, "leaves_repo_unchanged");
    const leaves = p !== undefined && p >= (config.thresholds.planScope ?? DEFAULT_THRESHOLDS.planScope);
    pi.appendEntry("tool-gate:decision", {
      tool,
      args: clip(command, 500),
      check: "plan-scope",
      scores: p === undefined ? {} : { leaves_repo_unchanged: p },
      action: leaves ? "allow" : "block",
      latencyMs: outcome.latencyMs,
      classifier: provenanceOf(outcome),
      ...(outcome.usage ? { usage: outcome.usage } : {}),
    });
    return leaves ? undefined : { block: true, reason: planShellBlockReason(tool, p === undefined ? { unavailable: true } : {}, scratchDir) };
  };

  const keyConfig = loadConfig("tool-gate", DEFAULT_CONFIG, projectContextSync(process.cwd()));
  const shortcut = (typeof keyConfig.workflowShortcut === "string" ? keyConfig.workflowShortcut
    : typeof keyConfig.cycleShortcut === "string" ? keyConfig.cycleShortcut : "shift+tab").trim();
  const approvalShortcut = (typeof keyConfig.approvalShortcut === "string" ? keyConfig.approvalShortcut : "alt+a").trim();
  const duplicateShortcut = !!shortcut && shortcut.toLowerCase() === approvalShortcut.toLowerCase();

  const status = (ctx: ExtensionContext | undefined) => {
    if (!ctx?.hasUI) return;
    try {
      ctx.ui.setStatus(WORKFLOW_STATUS_KEY, workflowStatus(effectiveWorkflow(), shortcut || undefined));
      ctx.ui.setStatus(MODE_STATUS_KEY, modeStatus(approval, duplicateShortcut ? undefined : approvalShortcut || undefined));
      ctx.ui.setStatus(PROMPTING_STATUS_KEY, `permission prompts: ${denyInsteadOfPrompting() ? "off" : "on"}`);
      // Jev's counts matter where Jev judges: auto approvals, whatever the workflow.
      ctx.ui.setStatus(
        STATUS_KEY,
        approval === "auto" ? `gate: ${auto} auto · ${pushedBack} pushed back · ${held} asked` : undefined,
      );
    } catch {
      // A stale context after a session switch.
    }
  };

  const cycle = () => workflowCycle(planProvider);
  const defaults = (config: GateConfig) => {
    const legacy = parseLegacyCombinedMode(config.defaultMode);
    // A subagent starts with what its parent passed down (subagent-env.ts), else the configured defaults.
    const inherited = inheritedModes();
    return {
      workflow: inherited.workflow ?? parseWorkflow(config.defaultWorkflow) ?? (legacy === "chat" || legacy === "plan" ? legacy : "work"),
      approval: inherited.approval ?? parseApproval(config.defaultApproval) ?? (!config.enabled ? "bypassPermissions" : parseApproval(legacy) ?? "auto"),
    } as const;
  };
  pi.events.on(SUBAGENT_ENV_CHANNEL, (data: unknown) => answerSubagentEnv(data, () => subagentEnv(approval, effectiveWorkflow(), denyInsteadOfPrompting(), scratchDir)));
  const emit = (name: string, data: unknown) => {
    try { pi.events.emit(name, data); } catch { /* A listener's failure is its own. */ }
  };
  const broadcastWorkflow = (source: WorkflowSource, previous?: WorkflowMode, announce = true) => {
    const mode = effectiveWorkflow();
    emit(WORKFLOW_CHANGED, {
      mode, ...(previous ? { previous } : {}), cycle: cycle(), ...(shortcut ? { key: shortcut } : {}), source,
      ...(delegated() && mode === "plan" ? { delegated: true } : {}),
    });
    if (announce && source === "transition" && previous && previous !== mode) sendWorkflowTransition(pi, previous, mode);
  };
  // Query destination state directly: neither the cached branch nor lifecycle listener order is authoritative.
  pi.events.on(WORKFLOW_QUERY, (data) => {
    const query = data as { entries?: unknown; cwd?: unknown; reply?: unknown } | undefined;
    if (!Array.isArray(query?.entries) || typeof query.cwd !== "string" || typeof query.reply !== "function") return;
    const restored = restoreBranchModes(query.entries, defaults(loadConfig("tool-gate", DEFAULT_CONFIG, projectContext && projectLaunch === path.resolve(query.cwd) ? projectContext : projectContextSync(query.cwd))));
    const snapshot: WorkflowSnapshot = {
      mode: restored.workflow,
      cycle: cycle(), ...(shortcut ? { key: shortcut } : {}), source: "restore",
      ...(delegated() && restored.workflow === "plan" ? { delegated: true as const } : {}),
    };
    query.reply(snapshot);
  });
  const broadcastApproval = (previous?: ApprovalMode) => emit(MODE_CHANGED, {
    mode: approval, ...(previous ? { previous } : {}), cycle: [...APPROVAL_CYCLE],
  });
  const persist = (entry: string, mode: string) => {
    try { pi.appendEntry(entry, { version: 1, mode }); } catch { /* No session yet. */ }
  };
  const changeWorkflow = (next: BaseWorkflowMode, ctx: ExtensionContext | undefined = hostCtx, announce = true, fromCycle = false): { ok: boolean; error?: string } => {
    if (!fromCycle) settings.cancel("Workflow selected explicitly.");
    if (next === "plan" && !planProvider) {
      const error = "Plan mode needs pi-plan-mode.";
      ctx?.ui.notify(error, "warning");
      return { ok: false, error };
    }
    if (next === workflow) return { ok: true };
    const previous = effectiveWorkflow();
    workflow = next;
    invalidate();
    persist(WORKFLOW_ENTRY, workflow);
    status(ctx);
    broadcastWorkflow("transition", previous, announce);
    tellChatNow(ctx);
    return { ok: true };
  };
  const setWorkflow = async (next: BaseWorkflowMode, ctx: ExtensionContext | undefined = hostCtx) =>
    changeWorkflow(next, ctx).ok;
  const setApproval = (next: ApprovalMode, ctx: ExtensionContext | undefined = hostCtx, fromCycle = false) => {
    if (!fromCycle) settings.cancel("Approvals selected explicitly.");
    if (approval === next) return;
    const previous = approval;
    approval = next;
    invalidate();
    persist(APPROVAL_ENTRY, approval);
    status(ctx);
    broadcastApproval(previous);
  };

  const setPromptingOverride = (next: PromptingOverride, ctx: ExtensionContext) => {
    if (promptingOverride === next) return;
    settings.cancel("Permission prompting selected explicitly.");
    promptingOverride = next;
    pi.appendEntry(PROMPTING_ENTRY, { version: 1, denyInsteadOfPrompting: next ?? null });
    invalidate();
    status(ctx);
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
  const workflowOwner = {};
  const approvalOwner = {};
  // Journal entries advance the leaf themselves; ownership follows ancestry, not leaf equality.
  const cycleCurrent = (ctx: ExtensionContext) => {
    const generation = sessionGeneration;
    const session = ctx.sessionManager.getSessionId?.();
    const anchor = ctx.sessionManager.getLeafId?.();
    return () => sessionReady && generation === sessionGeneration && ctx.sessionManager === hostCtx?.sessionManager
      && session === ctx.sessionManager.getSessionId?.()
      && (!anchor || ctx.sessionManager.getBranch().some(entry => entry.id === anchor));
  };
  const stageWorkflow = (ctx: ExtensionContext | undefined = hostCtx, trigger?: SettingCycleTrigger): Promise<boolean> => {
    if (!ctx || ctx.mode !== "tui" || !ctx.hasUI)
      return setWorkflow(nextWorkflow(workflow, planProvider) as BaseWorkflowMode, ctx);
    return settings.stage(ctx, {
      key: "workflow", owner: workflowOwner,
      read: () => workflow,
      next: value => nextWorkflow(value, planProvider) as BaseWorkflowMode,
      format: value => value,
      validate: () => undefined,
      apply: value => changeWorkflow(value, ctx, false, true).ok,
      current: cycleCurrent(ctx),
    }, trigger);
  };
  const stageApproval = (ctx: ExtensionContext | undefined = hostCtx, trigger?: SettingCycleTrigger): Promise<boolean> => {
    if (!ctx || ctx.mode !== "tui" || !ctx.hasUI) { setApproval(nextApproval(approval), ctx); return Promise.resolve(true); }
    return settings.stage(ctx, {
      key: "approvals", owner: approvalOwner,
      read: () => approval, next: nextApproval,
      format: value => MODE_NAMES[value], validate: () => undefined,
      apply: value => { setApproval(value, ctx, true); return true; },
      current: cycleCurrent(ctx),
    }, trigger);
  };
  pi.events.on(WORKFLOW_SET, (data) => {
    const request = data as { mode?: unknown; result?: Promise<boolean> } | undefined;
    const next = parseWorkflow(request?.mode);
    if (next && request) request.result = setWorkflow(next).catch(error => {
      hostCtx?.ui.notify(`Workflow transition failed: ${String(error)}`, "warning"); return false;
    });
  });
  pi.events.on(WORKFLOW_CYCLE, (data) => {
    const trigger = (data as { cycleTrigger?: SettingCycleTrigger } | undefined)?.cycleTrigger;
    const result = stageWorkflow(hostCtx, trigger).catch(error => { hostCtx?.ui.notify(`Workflow transition failed: ${String(error)}`, "warning"); return false; });
    if (data && typeof data === "object") (data as { result?: Promise<boolean> }).result = result;
  });
  pi.events.on(MODE_SET, (data) => {
    const next = parseApproval((data as { mode?: unknown } | undefined)?.mode);
    if (next) setApproval(next);
  });
  pi.events.on(MODE_CYCLE, data => {
    const result = stageApproval(hostCtx, (data as { cycleTrigger?: SettingCycleTrigger } | undefined)?.cycleTrigger);
    if (data && typeof data === "object") (data as { result?: Promise<boolean> }).result = result;
  });
  pi.events.on(PLAN_PROVIDER, (data) => {
    const announced = data as { planFile?: unknown; scratchDir?: unknown } | undefined;
    // A delegated session has no plan file of its own: its parent's scratch directory stays.
    if (!delegated()) {
      const file = announced?.planFile;
      const nextFile = typeof file === "string" && file ? canonicalPath(file) : undefined;
      const dir = announced?.scratchDir;
      const nextScratch = typeof dir === "string" && dir ? canonicalPath(dir) : undefined;
      if (nextFile !== planFile || nextScratch !== scratchDir) { planFile = nextFile; scratchDir = nextScratch; invalidate(); }
    }
    const available = planProvider;
    planProvider = true;
    if (!available) broadcastWorkflow("restore");
  });

  if (shortcut) {
    pi.registerShortcut(shortcut as never, {
      description: "Cycle workflow (work, chat, plan)",
      handler: async (ctx) => {
        void stageWorkflow(ctx);
      },
    });
  }
  if (approvalShortcut && !duplicateShortcut) {
    pi.registerShortcut(approvalShortcut as never, {
      description: "Toggle approvals (auto, yolo)",
      handler: async (ctx) => { void stageApproval(ctx); },
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

  const contextFor = async (cwd: string, refresh = false) => {
    const launch = path.resolve(cwd);
    if (!refresh && projectContext && projectLaunch === launch) return projectContext;
    let next: ProjectContext;
    try {
      next = await resolveProject(cwd, pi.exec.bind(pi));
    } catch (error) {
      // A lookup that never answered says nothing new about a checkout this session already resolved.
      if (projectContext && projectLaunch === launch && error instanceof ProjectResolutionError && error.transient) {
        staleProject = error.message;
        return projectContext;
      }
      // Anything else is evidence: stop trusting the cached checkout, so later lookups resolve again
      // and fail closed until Git answers. The old context stays only to detect a project change.
      projectLaunch = undefined;
      staleProject = undefined;
      throw error;
    }
    staleProject = undefined;
    if (projectContext && (projectContext.root !== next.root || projectContext.main !== next.main)) {
      invalidate();
      gitInfo = undefined;
      sessionRules = [];
      sessionDirs.clear();
    }
    projectContext = next;
    projectLaunch = path.resolve(cwd);
    return next;
  };
  // Main is only for local persistence and legacy keys, never active project access.
  const projectOf = async (cwd: string) => [(await contextFor(cwd)).root];
  const policyFor = async (cwd: string): Promise<Policy> => resolvePolicy(await directoriesFor(cwd), await projectOf(cwd));
  const projectKey = async (cwd: string) => (await contextFor(cwd)).main;
  const destination = async (cwd: string) => projectSaveFile(await contextFor(cwd), config.persistence.project);
  /** Reload what is saved (this project's grants, the config files) and merge it with the session's rules. */
  const refreshRules = async (cwd: string, resolve = true) => {
    let project: ProjectContext;
    try {
      project = await contextFor(cwd, resolve);
    } catch (error) {
      policyLoadErrors = [`Policy resolution error: ${error instanceof Error ? error.message : String(error)}`];
      erroredPolicyFiles = [];
      policyDiagnostics = [...policyLoadErrors];
      if (!warnedPolicy && hostCtx?.hasUI) {
        warnedPolicy = true;
        hostCtx.ui.notify(`tool-gate policy diagnostics:\n${policyDiagnostics.join("\n")}\nSee /gate.`, "warning");
      }
      return;
    }
    const previousPrompting = denyInsteadOfPrompting();
    const loaded = loadConfigReport("tool-gate", DEFAULT_CONFIG, project);
    config = loaded.config;
    if (previousPrompting !== denyInsteadOfPrompting()) invalidate();
    status(hostCtx);
    const local = localGrants(loadGrants(project.main), grantsFile());
    localRules = local.rules;
    localDirs = new Map(local.dirs.map((d) => [d.key, { key: d.key, access: d.access, dir: d.dir }]));
    const files = loadFileRules(project, config.persistence);
    const issues = policyIssues(project);
    const legacyErrors = legacyGrantErrors();
    policyLoadErrors = [...issues.map(issue => issue.message), ...legacyErrors];
    erroredPolicyFiles = [...issues.map(issue => issue.file), ...(legacyErrors.length ? [grantsFile()] : [])];
    fileDirs = [];
    const target = projectSaveFile(project, config.persistence.project);
    const userFile = userRulesFile();
    for (const file of policyFiles(project)) {
      try {
        const json: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (!isRecord(json) || !isRecord(json.directories)) continue;
        for (const access of ["read", "write"] as const) {
          const entries = json.directories[access];
          if (!Array.isArray(entries)) continue;
          for (const dir of entries) if (typeof dir === "string") {
            const absolute = path.resolve(project.root, expandHome(dir));
            const user = file === userFile || !projectFiles(project).includes(file);
            fileDirs.push({
              key: `dir:${access}:${absolute}`, access, dir, source: file,
              writable: user ? file === userFile && config.persistence.userWritable : file === target,
              shared: user || file !== path.join(project.main, ".pi", "tool-gate.local.json"),
            });
          }
        }
      } catch { /* policyErrors reports malformed files; missing files are normal. */ }
    }
    const stale = staleProject
      ? `Policy resolution warning: ${staleProject}; using the checkout resolved earlier this session (${shown(project.root)}).`
      : undefined;
    if (!stale) warnedStale = false;
    else if (!warnedStale && hostCtx?.hasUI) {
      warnedStale = true;
      hostCtx.ui.notify(`tool-gate: ${stale}\nSee /gate.`, "warning");
    }
    const fileDiagnostics = [
      ...policyLoadErrors,
      ...files.legacyFiles.map((file) => `${shown(file)}: path rules use the old syntax (a leading / meant absolute); they keep that meaning until the gate next saves a rule there, or add "pathSyntax": "claude-code" and write absolute paths as //path.`),
      ...loaded.ignored.map((i) => `${shown(i.file)}: \`${i.key}\` is ignored in project files (they may only tighten); set it in ${shown(userRulesFile())}.`),
      ...(loadGrants(project.main).length ? [`Legacy grants: ${shown(grantsFile())}; migrate explicitly before removing.`] : []),
      ...files.ignored.map((r) => `Invalid ${r.list} rule ${r.raw} in ${shown(r.origin.source)}: ${r.error}; it provides no protection.`),
      ...files.rules.flatMap((r) => { const warning = ruleWarning(r.list, r.rule); return warning ? [`${r.text} in ${shown(r.origin.source)}: ${warning}.`] : []; }),
    ];
    // The stale-checkout warning has its own notice above; /gate lists everything.
    if (fileDiagnostics.length && !warnedPolicy && hostCtx?.hasUI) {
      warnedPolicy = true;
      hostCtx.ui.notify(`tool-gate policy diagnostics:\n${fileDiagnostics.join("\n")}\nSee /gate.`, "warning");
    }
    policyDiagnostics = [...(stale ? [stale] : []), ...fileDiagnostics];
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
      await editRulesFile(await destination(cwd), "add", list, text);
    } else {
      if (!config.persistence.userWritable) throw new Error(MANAGED);
      // A user rule applies in every project: a path relative to this project must name it absolutely.
      await editUserRules("add", list, list === "allow" ? absolutizeRule(text, (await contextFor(cwd)).root) : text);
    }
    await refreshRules(cwd);
  };

  const removeRule = async (rule: ScopedRule, cwd: string) => {
    if (rule.origin.scope === "session") sessionRules = sessionRules.filter((r) => r !== rule);
    else if (rule.origin.scope === "user" && !config.persistence.userWritable) throw new Error(MANAGED);
    else if (rule.origin.scope === "project" && rule.key) removeGrant(await projectKey(cwd), rule.key);
    else if (rule.origin.writable) await editRulesFile(rule.origin.source, "remove", rule.list, rule.raw);
    else throw new Error(`${describeOrigin(rule.origin, shown)} is read-only here`);
    await refreshRules(cwd);
  };

  /** The gate's plan for a call (`planCall`), after looking up git, the project and grants. */
  const plan = async (
    tool: string, input: Record<string, unknown>, cwd: string, reads: { judgedRead?: boolean; chatChildren?: boolean } = {},
  ): Promise<Plan> => {
    const listed = config.allowTools.includes(tool);
    const shell = SHELL_TOOLS.has(tool) && !listed;
    const dir = shellDir(tool, input, cwd);
    const command = String(input.command ?? "");
    const checksPaths = !listed && config.directories.enabled !== false &&
      (SHELL_TOOLS.has(tool) || tool === "edit" || tool === "write" || BUILTIN_READ.has(tool));
    return planCall(tool, input, (await contextFor(cwd)).cwd, {
      config: checksPaths ? { ...config, directories: await directoriesFor(cwd) } : config,
      branch: shell ? (await git(dir))?.branch : undefined,
      ignored: shell ? await ignoredByGit(secretGitAdds(command, dir)) : undefined,
      projects: checksPaths ? await projectOf(cwd) : undefined,
      annotations,
      readOnlyCall,
      granted: exactGrant,
      rules: allRules,
      root: (await projectOf(cwd))[0],
      planFile,
      ...(workflow === "plan" && scratchDir ? { scratchDir } : {}),
      downloads,
      ...reads,
    });
  };

  const editorFactory = embeddedEditorFactory(pi);

  /** Ask the user, one dialog at a time. */
  const ask = (
    ctx: ExtensionContext,
    q: { tool: string; input: Record<string, unknown>; held?: string; agentCase?: string; note?: string; noUIReason: string; countHeadless?: boolean },
    offer: Offer | undefined,
  ): Promise<{ block?: boolean; reason?: string } | undefined> => {
    if (denyInsteadOfPrompting()) return Promise.resolve(promptingDenied(q.tool, q.held));
    // Classifier-unavailable's first refusal already accounts for a headless retry.
    if (ctx.hasUI || q.countHeadless !== false) {
      held++;
      status(ctx);
    }
    if (!ctx.hasUI) return Promise.resolve({ block: true, reason: q.noUIReason });
    const epoch = revision;
    const run = async () => {
      if (decisionStale(epoch)) return staleResult();
      if (denyInsteadOfPrompting()) return promptingDenied(q.tool, q.held);
      let items = offer ? [...offer.items] : [];
      /** An edit that was not a rule, to show again with what is wrong with it. */
      let draft: string | undefined;
      let problem: string | undefined;
      const view = await callView(q.tool, q.input, ctx.cwd);
      if (decisionStale(epoch)) return staleResult();
      // Held only while the dialog is open, so queued approvals do not report blocked early.
      const label = clip(`Allow? ${describeCall(q.tool, q.input)}`.replace(/\s+/gu, " "), 60);
      for (;;) {
        const labels = offer ? choiceLabels(offer.kind, items.length > 1, config.persistence.userWritable) : undefined;
        const canSaveFolder = offer?.kind !== "dirs" || !items.some((key) => /[*?]/u.test(key));
        const options = [
          ALLOW_ONCE,
          ...(labels ? [labels.session, ...(canSaveFolder ? [labels.project, ...(labels.everywhere ? [labels.everywhere] : [])] : []), ...(labels.edit ? [labels.edit] : [])] : []),
          BLOCK,
        ];
        const shownItems = offer ? items.map((item, i) => clip(offer.kind === "dirs" ? (offer.labels[i] ?? item) : item, 200)) : [];
        const noun = offer?.kind === "dirs" ? "Folder" : "Rule";
        // One flat line per rule or folder: an indented list under a header reads as a dialog Collie cannot read.
        const grant = shownItems.length ? [...shownItems.map((s) => `${noun}: ${s}`), ...(canSaveFolder ? [`Project saves: ${shown(await destination(ctx.cwd))} (${config.persistence.project})`] : [])] : undefined;
        const title = [
          "Allow this call?",
          `Action: ${describeCallPresentation(q.tool, q.input).action}`,
          `Target: ${describeCallPresentation(q.tool, q.input).target}`,
          ...(q.held !== undefined ? [`Held: ${q.held}`] : []),
          ...(q.held !== undefined || q.agentCase !== undefined
            ? [`Agent: ${q.agentCase ? clip(q.agentCase.replace(/\s+/gu, " "), 600) : "(gave no reason)"}`]
            : []),
          ...(q.note ? [`(${q.note})`] : []),
          ...(grant ?? []),
          ...(problem ? [problem] : []),
        ].join("\n");
        if (decisionStale(epoch)) return staleResult();
        if (denyInsteadOfPrompting()) return promptingDenied(q.tool, q.held);
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
        if (decisionStale(epoch)) return staleResult();
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
        if (offer && labels && (answer.choice === labels.session || (canSaveFolder && (answer.choice === labels.project || answer.choice === labels.everywhere)))) {
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
    if (scope === "user" && !config.persistence.userWritable) throw new Error(MANAGED);
    const file = scope === "user" ? userRulesFile() : await destination(cwd);
    for (const key of items) {
      const grant = migrateGrant(key);
      if (grant?.kind === "dir") await editDirectoryGrant(file, "add", grant.access, grant.dir);
    }
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
      selectionKey: string;
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
    if (decisionStale(h.revision)) return staleResult();
    const exact = `${h.tool}\0${JSON.stringify(h.input)}`;
    if (config.pushBack && !pushedBackThisTurn.has(exact) && !pushedBackThisTurn.has(h.family)) {
      pushedBackThisTurn.add(exact);
      pushedBackThisTurn.add(h.family);
      pushedBack++;
      status(ctx);
      let ideas: string[] = [];
      if (h.advice === undefined) {
        const suggestion = await askJev(ctx.modelRegistry, config.jev, { ...h.state, held_because: h.reason }, workaroundQuestion(), ctx.signal);
        if (decisionStale(h.revision) || (suggestion.ok && suggestion.selectionKey !== h.selectionKey)) return staleResult();
        ideas = suggestion.ok ? suggestions(suggestion.answers) : [];
        if (suggestion.usage) h.recordUsage(suggestion.usage);
        pi.appendEntry("tool-gate:workaround", {
          toolCallId: h.toolCallId,
          tool: h.tool,
          ...(suggestion.ok ? { classifier: provenanceOf(suggestion) } : { code: suggestion.code, attempts: suggestion.attempts }),
          ...(suggestion.usage ? { usage: suggestion.usage } : {}),
        });
      }
      const noWorkaround = ideas[0] === WORKAROUNDS.user_only;
      const advice = h.advice !== undefined ? h.advice : noWorkaround
        ? "No workaround is apparent: whether to do this is the user's decision."
        : ideas.length
          ? `A suggested workaround: ${ideas.join("; or ")}.`
          : "Look for a safer way: reversible, local, narrower, or previewed first.";
      if (denyInsteadOfPrompting()) return {
        block: true,
        reason: `${h.reason}\n${noWorkaround ? "There is no permitted automatic workaround." : advice}\n${PROMPTING_DISABLED}\n${PROMPTING_CONTINUE}`,
      };
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
    const agentCase = callerText(ctx.sessionManager.getBranch(), h.toolCallId);
    return ask(ctx, { tool: h.tool, input: h.input, held: h.summary, agentCase: clip(agentCase, 4_000), noUIReason: `${h.reason}\nBlocked: there is no user to approve it.` }, h.offer);
  };

  const describeCall = (tool: string, input: Record<string, unknown>) => describeCallPresentation(tool, input).description;

  /** Downloaded files as the branch stands: on a new, resumed or forked session, and after a tree move. */
  const rebuildDownloads = (ctx: ExtensionContext) => {
    try {
      downloads = downloadsOf(ctx.sessionManager.getBranch(), ctx.cwd);
    } catch {
      downloads = new Downloads();
    }
  };

  /** Sessions already told that Linked flows were removed, so a tree move does not repeat the notice. */
  const linkedNoticed = new Set<string>();
  const noticeRemovedLinked = (ctx: ExtensionContext, entries: readonly unknown[]) => {
    if (!ctx.hasUI) return;
    let linked = false;
    for (const raw of entries) {
      const entry = raw as { type?: unknown; customType?: unknown; data?: unknown } | null;
      if (entry?.type !== "custom" || entry.customType !== "tool-gate:flow") continue;
      linked = isRecord(entry.data) && entry.data.operatingMode === "linked";
    }
    const id = ctx.sessionManager.getSessionId?.() ?? "";
    if (!linked || linkedNoticed.has(id)) return;
    linkedNoticed.add(id);
    ctx.ui.notify("Linked flows were removed. For a planner and worker pair, select a plan model such as anthropic/opusplan with /model.", "warning");
  };

  const restore = async (ctx: ExtensionContext, newSession: boolean) => {
    const generation = ++sessionGeneration;
    sessionReady = false;
    invalidate();
    pendingUsage.clear();
    hostCtx = ctx;
    projectContext = undefined;
    projectLaunch = undefined;
    staleProject = undefined;
    warnedStale = false;
    config = structuredClone(DEFAULT_CONFIG);
    promptingOverride = restorePromptingOverride(ctx.sessionManager.getBranch());
    rebuildDownloads(ctx);
    // Session rules and folder grants last until the session ends: /tree moves within it.
    if (newSession) {
      sessionRules = [];
      sessionDirs.clear();
    }
    localDirs.clear();
    localRules = [];
    fileRules = [];
    allRules = [...sessionRules];
    ignoredRules = [];
    gitInfo = undefined;
    dialogs = Promise.resolve();
    if (newSession) { auto = 0; held = 0; pushedBack = 0; warnedPolicy = false; }
    await refreshRules(ctx.cwd);
    refreshSystem1Target();
    if (generation !== sessionGeneration) return;
    const entries = ctx.sessionManager.getBranch();
    const restored = restoreBranchModes(entries, defaults(config));
    promptingOverride = restorePromptingOverride(entries);
    workflow = restored.workflow;
    approval = restored.approval;
    const told = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === CHAT_ENTRY);
    chatTold = told?.type === "custom" && (told.data as { told?: unknown } | undefined)?.told === true;
    delegatedTold = entries.some((entry) => entry.type === "custom" && entry.customType === DELEGATED_ENTRY);
    sessionReady = true;
    noticeRemovedLinked(ctx, entries);
    if (duplicateShortcut) ctx.ui.notify("tool-gate: duplicate workflow and approval shortcut; registering workflow only.", "warning");
    status(ctx);
    broadcastWorkflow("restore");
    broadcastApproval();
  };
  pi.on("session_tree", (_event, ctx) => restore(ctx, false));
  pi.on("session_start", (_event, ctx) => restore(ctx, true));

  pi.on("session_shutdown", async () => {
    sessionGeneration++;
    sessionReady = false;
    invalidate();
    pendingUsage.clear();
    hostCtx = undefined;
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    hostCtx = ctx;
    await refreshRules(ctx.cwd);
    refreshSystem1Target();
    pushedBackThisTurn.clear();
    classifierFailures.clear();
    gitInfo = undefined;
    // A removed plan provider must not strand a restored session in planning.
    if (workflow === "plan" && !planProvider && !delegated()) await setWorkflow("work", ctx);
    if (delegated() && workflow === "plan" && !delegatedTold) {
      delegatedTold = true;
      try { pi.appendEntry(DELEGATED_ENTRY, { told: true }); } catch { /* No session yet. */ }
      return { message: { customType: DELEGATED_ENTRY, content: delegatedPlanText(scratchDir), display: false, details: { scratchDir } } };
    }
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
    return ask(ctx, {
      tool, input, ...(p.kind === "ask" ? { held: p.reasons.join("; ") } : {}),
      noUIReason: `${approval === "default" ? "manual" : approval === "acceptEdits" ? "accept edits" : MODE_NAMES[approval]} mode needs the user's approval for this ${tool} call, and there is no user to ask.`,
    }, p.offer);
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
    const why = p.reasons.join("; ");
    const agentCase = clip(callerText(ctx.sessionManager.getBranch(), toolCallId), 4_000);
    return { result: ask(ctx, { tool, input, held: why, agentCase, noUIReason: `tool-gate held this ${tool} call: it ${why}. There is no user to ask.` }, undefined) };
  };

  pi.on("tool_call", async (event, ctx) => {
    const selectionKey = refreshSystem1Target().key;
    const epoch = revision;
    const stale = () => decisionStale(epoch);
    let callUsage: ClassifierUsage | undefined;
    const recordUsage = (usage: ClassifierUsage) => { callUsage = addUsage(callUsage, usage); };
    const decide = async () => {
      const tool = event.toolName;
      const input = event.input as Record<string, unknown>;

      // The checkout was resolved at turn start; re-reading the policy files is enough per call.
      await refreshRules(ctx.cwd, false);
      if (stale()) return staleResult();
      if (policyLoadErrors.length) {
        // Only direct diagnosis of the broken file is safe. Never enter retry/approval handling.
        const where = projectContext?.cwd ?? ctx.cwd;
        const forbidden = blocking(allRules, { tool, input, cwd: where, root: projectContext?.root ?? ctx.cwd, readOnlyCommands: config.readOnlyCommands });
        if (forbidden?.list === "deny") return deniedBy(tool, forbidden);
        if (tool === "read" && typeof input.path === "string") {
          const file = path.resolve(where, expandHome(input.path));
          try {
            const canonical = realpathSync(file);
            const canonicalDeny = blocking(allRules, { tool, input: { ...input, path: canonical }, cwd: where, root: projectContext?.root ?? ctx.cwd, readOnlyCommands: config.readOnlyCommands });
            if (canonicalDeny?.list === "deny") return deniedBy(tool, canonicalDeny);
            if (!isCredentialPath(file) && !isCredentialPath(canonical) && erroredPolicyFiles.some(policy => {
              try { return realpathSync(policy) === canonical; } catch { return false; }
            })) return allow(ctx);
          } catch { /* A nonexistent path is not an errored policy file. */ }
        }
        return { block: true, reason: `tool-gate blocked this call: policy-load error. Correct the policy before requesting permission.\n${policyLoadErrors.join("\n")}` };
      }

      // Workflow first: what kind of call may run at all, whatever the approval setting. Its blocks
      // never ask; only deny rules are checked before them.
      const current = effectiveWorkflow();
      // What the workflow learned about reads, for approvals to reuse (work leaves both false).
      let judgedRead = false;
      let chatChildren = false;
      if (current === "chat" || current === "plan") {
        chatChildren = subagentEnvHonored(pi.events);
        const forbidden = blocking(allRules, { tool, input, cwd: (await contextFor(ctx.cwd)).cwd, root: (await projectOf(ctx.cwd))[0], readOnlyCommands: config.readOnlyCommands });
        if (stale()) return staleResult();
        if (forbidden?.list === "deny") return deniedBy(tool, forbidden);
        if (current === "plan" && (tool === "edit" || tool === "write")) {
          const file = canonicalPath(path.resolve((await contextFor(ctx.cwd)).cwd, expandHome(String(input.path ?? ""))));
          // The plan file and its scratch directory are the workflow's own: no approval applies to them.
          if (inScratch(file, { planFile, scratchDir })) return allow(ctx);
          return { block: true, reason: planEditBlockReason(planFile, scratchDir) };
        }
        // Chat lets only reads run (an allow rule does not make a command read-only); plan lets only
        // read-only shell commands run, and leaves other tools to the approval setting.
        let reads = onlyReads(tool, input, config, annotations, readOnlyCall, chatChildren);
        let judged = false;
        // Scoped plan: a command that does more than read runs when it leaves the repository unchanged.
        const scoped = current === "plan" && config.planShell !== "read-only";
        if (!reads && SHELL_TOOLS.has(tool)) {
          if (scoped) {
            const refused = await scopedPlanShell(ctx, tool, input, recordUsage);
            if (stale() || refused === "stale") return staleResult();
            if (refused) return refused;
          } else {
            // A command the parser cannot follow (a Python one-off, a heredoc) runs when System 1 is sure it only reads.
            const outcome = await judgedReadOnly(ctx, tool, input, recordUsage);
            if (stale() || outcome.stale) return staleResult();
            reads = outcome.reads;
            judgedRead = outcome.reads;
            judged = outcome.judged;
          }
        }
        const judgedNote = judged ? "System 1 judged that it may do more than read. " : "";
        if (current === "chat" && !reads) {
          return {
            block: true,
            reason:
              `Chat mode is on: only read-only tools run, and this ${tool} call is not one. ` + judgedNote +
              (SHELL_TOOLS.has(tool) ? `${SPLIT_HINT} ` : "") +
              `If it does more than read, do not retry it or work around it: answer from what you can read, or tell the user what you would do; they can switch modes (${shortcut || "/mode"}) to let you act.`,
          };
        }
        if (current === "plan" && !scoped && SHELL_TOOLS.has(tool) && !reads) {
          return {
            block: true,
            reason:
              `Plan mode is on: only read-only commands run until the user approves a plan, and this ${tool} call is not one. ` + judgedNote +
              `${SPLIT_HINT} If it does more than read, do not retry it or work around it: put this step in the plan.`,
          };
        }
      }

      // Then approvals, the same in every workflow.
      if (approval === "bypassPermissions") {
        // Everything runs, except what a deny rule forbids, and removing /, home, the project or a
        // parent of them (as Claude Code). Exhausted analysis cannot rule out such a removal.
        const call: Call = { tool, input, cwd: (await contextFor(ctx.cwd)).cwd, root: (await projectOf(ctx.cwd))[0], readOnlyCommands: config.readOnlyCommands };
        if (stale()) return staleResult();
        const forbidden = blocking(allRules, call);
        if (forbidden?.list === "deny") return deniedBy(tool, forbidden);
        if (!SHELL_TOOLS.has(tool)) return undefined;
        const command = String(input.command ?? "");
        const critical = alwaysAskBash(command, shellDir(tool, input, call.cwd), undefined, undefined, 0, call.cwd)
          .filter((reason) => reason.startsWith("deletes ") || reason === "shell analysis depth exhausted (opaque command)");
        if (!critical.length) return undefined;
        return ask(ctx, { tool, input, held: critical.join("; "), noUIReason: `tool-gate held this call: it ${critical.join("; ")}. There is no user to approve it.` }, undefined);
      }

      const p = await plan(tool, input, ctx.cwd, { judgedRead, chatChildren });
      if (stale()) return staleResult();

      const ruled = ruleOutcome(ctx, event.toolCallId, tool, input, p);
      if (ruled) return ruled.result;
      if (p.kind === "allow") return allow(ctx);
      if (p.kind === "deny") return deniedBy(tool, p.rule);

      if (approval === "default") return askUser(ctx, tool, input, p);
      if (approval === "acceptEdits") {
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
          selectionKey,
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

      const exactFailureKey = `${selectionKey}\0${tool}\0${JSON.stringify(input)}`;
      const previousFailure = classifierFailures.get(exactFailureKey);
      if (previousFailure) {
        return ask(ctx, { tool, input, held: previousFailure, agentCase: clip(callerText(ctx.sessionManager.getBranch(), event.toolCallId), 4_000), noUIReason: `${previousFailure}\nBlocked: there is no user to approve it.`, countHeadless: false }, undefined);
      }
      const unavailable = (errorClass: string, metadata: Record<string, unknown> = {}, exhausted = false) => {
        const reason = `${CLASSIFIER_UNAVAILABLE} (${errorClass})`;
        // Only a completed, unavailable chain earns the identical-call hold.
        if (exhausted) classifierFailures.set(exactFailureKey, reason);
        held++;
        status(ctx);
        pi.appendEntry("tool-gate:decision", { tool, args: clip(p.args, 500), action: "block", errorClass, ...metadata });
        return { block: true, reason };
      };
      const rules = loadRules(await contextFor(ctx.cwd));
      // A local script is judged by what it does: its content goes to the judge.
      const script = scriptOfCall(tool, input, ctx.cwd, downloads);
      const state = await judgeStateFor(ctx, tool, p.args, rules, script);
      if (stale()) return staleResult();
      const outcome = await askJev(ctx.modelRegistry, config.jev, state, judgeQuestions(rules, { script: script !== undefined }), ctx.signal);

      if (stale() || (outcome.ok && outcome.selectionKey !== selectionKey)) return staleResult();
      if (outcome.usage) recordUsage(outcome.usage);
      if (!outcome.ok) {
        // Typed terminal metadata, never an aggregated provider display sentence.
        const classes: Partial<Record<System1FailureCode, string>> = {
          timeout: "ClassifierTimeoutError",
          cancelled: "ClassifierCancelledError",
          selection_changed: "ClassifierCancelledError",
          missing_credentials: "ClassifierCredentialsError",
          invalid_credentials: "ClassifierCredentialsError",
          unavailable_model: "ClassifierModelUnavailableError",
          invalid_answers: "ClassifierInvalidAnswerError",
          invalid_input: "ClassifierInvalidInputError",
          refused: "ClassifierRefusedError",
          disabled: "ClassifierDisabledError",
        };
        return unavailable(classes[outcome.code] ?? "ClassifierUnavailableError", {
          code: outcome.code, attempts: outcome.attempts, usage: outcome.usage,
        }, outcome.code === "exhausted");
      }

      const v = verdict(outcome.answers, rules, config.thresholds);
      if (!v) return unavailable("ClassifierInvalidAnswerError", { classifier: provenanceOf(outcome), usage: outcome.usage });
      const action = v.allow ? "allow" : "hold";
      pi.appendEntry("tool-gate:decision", {
        tool,
        args: clip(p.args, 500),
        scores: v?.scores,
        failures: v?.failures,
        action,
        ...(script ? { script: script.path } : {}),
        latencyMs: outcome.latencyMs,
        inputTokens: outcome.usage?.input,
        classifier: provenanceOf(outcome),
        ...(outcome.usage ? { usage: outcome.usage } : {}),
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
        selectionKey,
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
    const context = await contextFor(cwd);
    const root = context.root;
    const real = context.cwd;
    if (tool === "edit" || tool === "write") {
      // Inside the project, or a directory it may write (the plan has already held any other).
      const file = path.resolve(real, expandHome(String(input.path ?? "")));
      return file.startsWith(`${root}${path.sep}`) || (config.directories.enabled !== false && canWrite(await policyFor(cwd), file));
    }
    if (!SHELL_TOOLS.has(tool)) return false;
    const dir = shellDir(tool, input, real);
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
  type ControlChoice = { label: string; run(): Promise<unknown> | void };
  const pickControl = async (ctx: ExtensionContext, title: string, choices: ControlChoice[]) => {
    // Retain canonical ids in closures. Never recover ids by parsing shortened UI labels.
    const labels = choices.map(choice => truncateToWidth(choice.label, 42));
    for (let i = 0; i < labels.length; i++) {
      if (labels.filter(label => label === labels[i]).length > 1) {
        const duplicate = labels[i];
        labels.forEach((label, index) => { if (label === duplicate) labels[index] = `${truncateToWidth(label, 35)} · ${index + 1}`; });
      }
    }
    const selected = await pick(ctx, title, labels);
    const choice = choices[labels.indexOf(selected ?? "")];
    await choice?.run();
  };
  const showModePicker = async (ctx: ExtensionContext) => {
    settings.cancel("Workflow picker opened.");
    if (!ctx.hasUI) {
      ctx.ui.notify(`Workflow: ${effectiveWorkflow()}. Usage: /mode [work|chat|plan].`, "info");
      return;
    }
    await pickControl(ctx, "Workflow", cycle().map(mode => ({
      label: `${mode[0]!.toUpperCase()}${mode.slice(1)}`,
      run: () => setWorkflow(mode, ctx),
    })));
  };
  const showApprovals = async (ctx: ExtensionContext) => {
    settings.cancel("Approvals picker opened.");
    if (!ctx.hasUI) { ctx.ui.notify(`Approvals: ${MODE_NAMES[approval]}. Usage: /approvals [auto|yolo].\n${promptingState()} Reset: /gate prompts default.`, "info"); return; }
    const toggle = `Turn permission prompts ${denyInsteadOfPrompting() ? "on" : "off"}`;
    const selected = await pick(ctx, `Approvals · Permission prompts: ${denyInsteadOfPrompting() ? "off" : "on"}\n/gate prompts default restores inherited/config policy.`, ["Auto", "Yolo", toggle]);
    if (selected === toggle) {
      setPromptingOverride(!denyInsteadOfPrompting(), ctx);
      ctx.ui.notify(promptingState(), "info");
    } else if (selected === "Auto" || selected === "Yolo") setApproval(selected === "Auto" ? "auto" : "bypassPermissions", ctx);
  };
  pi.registerCommand("mode", {
    description: "Workflow: work, chat or plan (no argument: pick one)",
    getArgumentCompletions: (prefix: string) => cycle().filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name })),
    handler: async (args, ctx) => {
      hostCtx = ctx;
      const arg = args.trim().toLowerCase();
      const legacyApproval = parseApproval(arg);
      if (legacyApproval) { setApproval(legacyApproval, ctx); return; }
      if (arg) {
        const next = parseWorkflow(arg);
        if (next) await setWorkflow(next, ctx);
        else ctx.ui.notify("Usage: /mode [work|chat|plan].", "warning");
        return;
      }
      await showModePicker(ctx);
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
      await showApprovals(ctx);
    },
  });
  pi.events.on(FOOTER_ACTIONS_CHANNEL, data => {
    const request = data as FooterActionsRequest | undefined;
    const ctx = hostCtx;
    if (request?.version !== 1 || !request.actions || !ctx || !sessionReady) return;
    const generation = sessionGeneration;
    const session = ctx.sessionManager.getSessionId?.();
    const guarded = (run: () => Promise<unknown>) => async () => {
      if (!sessionReady || generation !== sessionGeneration || ctx.sessionManager !== hostCtx?.sessionManager || session !== ctx.sessionManager.getSessionId?.()) return;
      await run();
    };
    request.actions["workflow.cycle"] = { label: "Cycle workflow", ...(shortcut ? { key: shortcut } : {}), run: guarded(async () => { void stageWorkflow(ctx); }) };
    request.actions["workflow.open"] = { label: "Workflow", run: guarded(() => showModePicker(ctx)) };
    request.actions["approvals.open"] = { label: "Approvals", ...(!duplicateShortcut && approvalShortcut ? { key: approvalShortcut } : {}), run: guarded(() => showApprovals(ctx)) };
  });

  /** The rules in force for a project, and the ways `/gate rules` may change them. */
  const ruleStore = async (cwd: string): Promise<RuleStore> => {
    const project = await projectKey(cwd);
    await refreshRules(cwd);
    return {
      project: shown((await contextFor(cwd)).root),
      projectPersistence: config.persistence.project,
      userWritable: config.persistence.userWritable,
      sources: () => policyFiles(projectContext ?? cwd).filter((file) => { try { readFileSync(file); return true; } catch { return false; } }),
      diagnostics: () => policyDiagnostics,
      rules: () => allRules,
      ignored: () => ignoredRules,
      dirs: () => [
        ...[...sessionDirs].flatMap((key) => {
          const d = migrateGrant(key);
          return d?.kind === "dir" ? [{ key, access: d.access, dir: d.dir, scope: "session" as const }] : [];
        }),
        ...[...localDirs.values()].map((d) => ({ ...d, scope: "project" as const, source: grantsFile(), writable: true })),
        ...fileDirs.map((d) => ({ ...d, scope: "project" as const })),
      ],
      add: (scope, list, text) => addRule(scope, list, text, cwd),
      remove: (rule) => removeRule(rule, cwd),
      removeDir: async (d) => {
        if (d.scope === "session") sessionDirs.delete(d.key);
        else {
          if (d.writable === false) throw new Error(`${d.source} is read-only here`);
          if (d.source && d.source !== grantsFile()) await editDirectoryGrant(d.source, "remove", d.access, d.dir);
          else removeGrant(project, d.key);
          await refreshRules(cwd);
        }
      },
    };
  };

  pi.registerCommand("gate", {
    description: "tool-gate: status; on (auto) or off (yolo); prompts [on|off|default] (off denies, never approves); rules (list, add, remove; grants is the same)",
    getArgumentCompletions: (prefix: string) =>
      ["status", "on", "off", "prompts", "prompts on", "prompts off", "prompts default", "rules", "rules list", "rules add", "rules remove", "grants"]
        .filter((o) => o.startsWith(prefix))
        .map((o) => ({ value: o, label: o })),
    handler: async (args, ctx) => {
      hostCtx = ctx;
      const arg = args.trim();
      if (/^prompts(\s|$)/u.test(arg)) {
        const [, value, ...extra] = arg.split(/\s+/u);
        if (extra.length || (value !== undefined && !["on", "off", "default"].includes(value))) {
          ctx.ui.notify("Usage: /gate prompts [on|off|default].", "warning");
          return;
        }
        await refreshRules(ctx.cwd);
        if (value !== undefined) setPromptingOverride(value === "default" ? undefined : value === "off", ctx);
        ctx.ui.notify(promptingState(), "info");
        return;
      }
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
      const rules = loadRules(await contextFor(ctx.cwd));
      const counts = (list: RuleList) => allRules.filter((r) => r.list === list).length;
      const target = refreshSystem1Target();
      const classifier = !config.jev.enabled ? "off"
        : target.ok ? `${target.backend} (${target.provider}/${target.model})` : `unavailable (${target.reason})`;
      ctx.ui.notify(
        [
          `Workflow: ${effectiveWorkflow()} (${shortcut || "no key"}). Approvals: ${MODE_NAMES[approval]} (${MODE_DESCRIPTIONS[approval]}) (${duplicateShortcut ? "no key" : approvalShortcut || "no key"}).`,
          promptingState(),
          `${auto} auto-approved, ${pushedBack} pushed back, ${held} asked this session.`,
          `System 1: ${classifier}; push-back ${config.pushBack ? "on" : "off"}.`,
          `${rules.length} project rule${rules.length === 1 ? "" : "s"} for System 1. Permission rules for ${shown(project)}: ` +
            `${counts("allow")} allow, ${counts("ask")} ask, ${counts("deny")} deny; ${sessionRules.length} from this session; ` +
            `${localDirs.size + sessionDirs.size} folder grant${localDirs.size + sessionDirs.size === 1 ? "" : "s"} (/gate rules; saved in ${shown(await destination(ctx.cwd))}).`,
          config.directories.enabled === false ? "Directory policy: off." : describePolicy(await policyFor(ctx.cwd)),
          ...policyDiagnostics,
        ].join("\n"),
        "info",
      );
    },
  });
}

export function chatEnterText(shortcut: string) {
  return `<system-reminder>
Chat mode is active. The user wants to talk: answer questions, explain, discuss and recommend. You MUST NOT make edits, run commands that change files or the system, commit, or otherwise make changes, even if asked to; this supersedes any other instructions. Everything that only reads runs: reading and searching files, shell commands and scripts that only read and print, web lookups, and subagents (they start in chat too). Try a read before saying you cannot do it; only calls that change something are blocked. If the user asks for a change, say what you would do, or hand them the command or prompt as an editable suggestion with tools that only offer text (offer_terminal, offer_prompt) when they are available; they can switch modes (${shortcut || "/mode"}) to let you act.
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
