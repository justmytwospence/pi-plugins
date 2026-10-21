// Inline plan mode, as Claude Code does it: in your own conversation, no extra screen. While it is
// on, your agent researches read-only and writes its plan to a plan file (the only file it may
// write), then calls exit_plan_mode, which shows you the plan and asks how to proceed: implement
// it here (in the permission mode you pick), implement it in a fresh session, edit it first, or
// keep planning. Shift+Tab (pi-tool-gate's mode cycle) or /plan enters it.
//
// With pi-tool-gate installed, the gate owns the mode (manual, accept edits, plan, auto, bypass):
// plan mode is one step of its Shift+Tab cycle, and it judges commands while planning (as Claude
// Code's classifier does). Without it, this extension enforces a read-only shell itself and its
// own shortcut (toggleShortcut) toggles plan mode. The contract is in pi-tool-gate's modes.ts:
//   permission-mode:changed        gate -> all    { mode, previous?, cycle, prePlanMode? }
//   permission-mode:set            any  -> gate   { mode }
//   permission-mode:cycle          any  -> gate   {}
//   permission-mode:plan-provider  plan -> gate   { planFile? }
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  getMarkdownTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { editInTerminal, externalEditorCommand } from "./external-editor.js";
import { holdBlocked } from "./herdr-blocked.js";
import { PlanMarkdown } from "./mermaid-art.js";
import { choosePlanApproval, EDIT_CHOICE } from "./plan-approval.js";
import { expandHome } from "./plan-hook.js";
import { findBlockedCommandSegment, readCommand, type SafeSubcommands } from "./tool-policy.js";

export const MODE_CHANGED = "permission-mode:changed";
export const MODE_SET = "permission-mode:set";
export const MODE_CYCLE = "permission-mode:cycle";
export const PLAN_PROVIDER = "permission-mode:plan-provider";
export const MODE_STATUS_KEY = "permission-mode";

/** Whether plan mode is on, its plan file, and what your agent was last told. */
export const INLINE_ENTRY = "plan-mode:inline";
/** The (hidden) messages that tell your agent it entered or left plan mode. */
export const NOTICE_TYPE = "plan-mode-notice";
export const ENTER_TOOL = "enter_plan_mode";
export const EXIT_TOOL = "exit_plan_mode";

interface InlineState {
  active: boolean;
  planFile?: string;
  /** Whether your agent was last told plan mode is on. */
  told: boolean;
}

export interface InlineHost {
  safeSubcommands(): SafeSubcommands | undefined;
  /** Where plan files go (default `~/.pi/agent/plans`). */
  plansDirectory(): string | undefined;
  /** Run the plan-complete hook for an approved plan. */
  approved(plan: string, ctx: ExtensionContext): void;
  /** Implement `plan` in a fresh session, once your agent's turn has ended. */
  implementFresh(plan: string): void;
  /** The key that toggles plan mode without pi-tool-gate, for the status line. */
  toggleKey(): string | undefined;
}

export interface InlinePlanMode {
  readonly active: boolean;
  readonly planFile: string | undefined;
  /** Enter plan mode (through the gate when it is there). */
  enter(ctx: ExtensionContext): void;
  /** Toggle (alone) or cycle (with the gate): what the shortcut does. */
  toggle(ctx: ExtensionContext): void;
}

const ADJECTIVES = [
  "amber",
  "bold",
  "brisk",
  "calm",
  "clear",
  "crisp",
  "deft",
  "eager",
  "fair",
  "gentle",
  "keen",
  "lively",
  "lucid",
  "mellow",
  "nimble",
  "quiet",
  "rapid",
  "steady",
  "sunny",
  "swift",
  "tidy",
  "vivid",
  "warm",
  "wise",
];
const NOUNS = [
  "anchor",
  "beacon",
  "brook",
  "canyon",
  "cedar",
  "comet",
  "delta",
  "ember",
  "falcon",
  "fern",
  "harbor",
  "heron",
  "lantern",
  "maple",
  "meadow",
  "orbit",
  "otter",
  "pine",
  "quarry",
  "river",
  "sparrow",
  "summit",
  "tide",
  "willow",
];

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)] as T;
}

/** A new plan file path with a memorable name, e.g. `~/.pi/agent/plans/calm-river.md`. */
export function newPlanFile(directory: string): string {
  for (let i = 0; i < 20; i++) {
    const candidate = join(directory, `${pick(ADJECTIVES)}-${pick(NOUNS)}.md`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(directory, `plan-${Date.now().toString(36)}.md`);
}

export function enterPlanText(planFile: string, existing: boolean, gate: boolean) {
  return `<system-reminder>
Plan mode is active. The user wants you to research and plan before anything changes. You MUST NOT make any edits (except to the plan file below), run commands that change files or the system, commit, or otherwise make changes, even if asked to; this supersedes any other instructions. ${gate ? "Commands are judged before they run; stick to ones that only read." : "Only read-only shell commands run."}

## Plan file
${existing ? `A plan file from earlier planning exists at ${planFile}. Read it first, then decide: if the request is a different task, overwrite it; if it continues the same task, revise it.` : `No plan file exists yet. Create it at ${planFile} with write.`}
It is the only file you may write. Build the plan there as you go, with write and edit.

## How to plan
1. Explore: read the relevant code with read-only tools (and read-only subagents for broad searches, if you have them). Reuse what exists; find the functions and utilities a change should build on.
2. Ask: when requirements, scope or a trade-off is unclear, ask the user (with your question tool, if you have one) rather than guessing. Do not ask what the code can tell you.
3. Write the plan: one line of context (why), the recommended approach (not every alternative), the files to change with their paths, existing code to reuse, and how to verify it end to end (tests, commands). Keep it short enough to scan.
4. Call ${EXIT_TOOL} when the plan is complete; it shows the plan to the user for approval. Do not ask "is this plan okay?" or "should I proceed?" any other way; that is what ${EXIT_TOOL} does.

End each turn by asking the user a question or by calling ${EXIT_TOOL}. If the user only asked a question that needs no code changes (research, an explanation), answer it and do not call ${EXIT_TOOL}.
</system-reminder>`;
}

export function exitPlanText(planFile: string | undefined, nextMode?: string) {
  // Chat mode (pi-tool-gate's) is read-only too; its own notice says what is allowed.
  const may = nextMode === "chat" ? "" : " You may now make edits, run tools, and take actions.";
  return `<system-reminder>
## Exited plan mode
You have left plan mode.${may}${planFile && existsSync(planFile) ? ` The plan file is at ${planFile} if you need it.` : ""}
</system-reminder>`;
}

export function approvedText(plan: string, planFile: string, edited: boolean) {
  return `User has approved your plan. You can now start coding. Start with updating your todo list if applicable.

Your plan has been saved to: ${planFile}
You can refer back to it if needed during implementation.

## Approved Plan${edited ? " (edited by user)" : ""}:
${plan}`;
}

export const ENTER_GUIDELINES = [
  `Call ${ENTER_TOOL} before starting a non-trivial implementation where planning first pays off: new features, changes across several files, architectural choices, several valid approaches, or unclear requirements. Do not use it for small fixes, single obvious changes, or pure research.`,
];

const APPROVE_AUTO = "Implement in auto mode";
const APPROVE_YOLO = "Implement in yolo mode";
const APPROVE_EDITS = "Implement accepting edits";
const APPROVE_MANUAL = "Implement approving each edit";
const APPROVE_HERE = "Implement it";
const APPROVE_FRESH = "Implement in a fresh session";
const EDIT = EDIT_CHOICE;
const KEEP = "Keep planning";

interface ExitDetails {
  plan?: string;
  planFile?: string;
  outcome?: "pending" | "approved" | "fresh" | "kept";
  mode?: string;
  edited?: boolean;
}

export function registerInlinePlanMode(pi: ExtensionAPI, host: InlineHost): InlinePlanMode {
  let state: InlineState = { active: false, told: false };
  /** pi-tool-gate owns the mode; its current mode and cycle. */
  let gate: { mode: string; cycle: string[] } | undefined;
  /** Restored this session's state (so the gate's early broadcast does not clobber it). */
  let restored = false;
  let hostCtx: ExtensionContext | undefined;

  const safely = (fn: () => void) => {
    try {
      fn();
    } catch {
      // A stale runtime after a session switch.
    }
  };

  const plansDir = () => resolve(expandHome(host.plansDirectory() ?? join(getAgentDir(), "plans")));

  const persist = () => safely(() => pi.appendEntry(INLINE_ENTRY, { ...state }));

  const announce = () =>
    safely(() => pi.events.emit(PLAN_PROVIDER, { ...(state.planFile ? { planFile: state.planFile } : {}) }));

  const updateStatus = () => {
    const ctx = hostCtx;
    if (!ctx?.hasUI || gate) return;
    const key = host.toggleKey();
    safely(() =>
      ctx.ui.setStatus(MODE_STATUS_KEY, state.active ? `⏸ plan mode on${key ? ` (${key} to cycle)` : ""}` : undefined),
    );
  };

  /** Tell your agent now when it is mid-turn; otherwise before_agent_start tells it with your next prompt. */
  const tellNow = (ctx: ExtensionContext | undefined) => {
    if (!ctx || state.told === state.active) return;
    let idle = true;
    try {
      idle = ctx.isIdle();
    } catch {
      return;
    }
    if (idle) return;
    safely(() =>
      pi.sendMessage(
        { customType: NOTICE_TYPE, content: noticeText(), display: false, details: { active: state.active } },
        { deliverAs: "steer" },
      ),
    );
    state.told = state.active;
  };

  const noticeText = () =>
    state.active
      ? enterPlanText(state.planFile as string, hasPlan(state.planFile), gate !== undefined)
      : exitPlanText(state.planFile, gate?.mode);

  const enterLocal = (ctx: ExtensionContext | undefined) => {
    if (state.active) return;
    // A plan file per session: re-entering continues it, as Claude Code does.
    state.planFile ??= newPlanFile(plansDir());
    safely(() => mkdirSync(dirname(state.planFile as string), { recursive: true }));
    state.active = true;
    announce();
    tellNow(ctx);
    persist();
    updateStatus();
  };

  const exitLocal = (ctx: ExtensionContext | undefined, told?: boolean) => {
    if (!state.active) return;
    state.active = false;
    if (told !== undefined) state.told = told;
    tellNow(ctx);
    persist();
    updateStatus();
  };

  const requestMode = (mode: string) => safely(() => pi.events.emit(MODE_SET, { mode }));

  const enter = (ctx: ExtensionContext) => {
    hostCtx = ctx;
    if (gate) {
      requestMode("plan");
      // The gate answers synchronously; if it did not take plan mode, enter on our own.
      if (!state.active) enterLocal(ctx);
    } else enterLocal(ctx);
  };

  pi.events.on(MODE_CHANGED, (data) => {
    const event = data as { mode?: unknown; cycle?: unknown } | undefined;
    if (typeof event?.mode !== "string") return;
    gate = { mode: event.mode, cycle: Array.isArray(event.cycle) ? event.cycle.map(String) : [] };
    if (!restored) return;
    if (event.mode === "plan") enterLocal(hostCtx);
    else exitLocal(hostCtx);
  });

  pi.on("session_start", (_event, ctx) => {
    hostCtx = ctx;
    const entries = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>;
    const latest = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === INLINE_ENTRY)
      ?.data as Partial<InlineState> | undefined;
    state = {
      active: latest?.active === true,
      told: latest?.told === true,
      ...(typeof latest?.planFile === "string" ? { planFile: latest.planFile } : {}),
    };
    restored = true;
    // The gate is the source of truth for the mode when it is there.
    if (gate) {
      if (gate.mode === "plan") {
        state.active = false;
        enterLocal(ctx);
      } else exitLocal(ctx);
    }
    announce();
    updateStatus();
  });

  pi.on("session_shutdown", () => {
    hostCtx = undefined;
    restored = false;
    gate = undefined;
  });

  pi.on("before_agent_start", (_event, ctx) => {
    hostCtx = ctx;
    if (state.told === state.active) return undefined;
    // Nothing to say on leaving if your agent never heard it was in plan mode.
    const content = noticeText();
    state.told = state.active;
    persist();
    return { message: { customType: NOTICE_TYPE, content, display: false, details: { active: state.active } } };
  });

  pi.on("tool_call", (event, ctx) => {
    if (!state.active) return undefined;
    const tool = event.toolName;
    const input = event.input as Record<string, unknown>;
    if (tool === "edit" || tool === "write") {
      const file = resolve(ctx.cwd, expandHome(String(input.path ?? "")));
      if (state.planFile && file === resolve(state.planFile)) return undefined;
      return {
        block: true,
        reason: `Plan mode is on: nothing may be edited until the user approves a plan. The only file you may write is the plan file, ${state.planFile}.`,
      };
    }
    // With the gate, commands are its to judge (as Claude Code's classifier does while planning).
    if (gate || tool !== "bash") return undefined;
    const blocked = findBlockedCommandSegment(readCommand(input), host.safeSubcommands() ?? {}, ctx.cwd);
    if (blocked === undefined) return undefined;
    return {
      block: true,
      reason: `Plan mode is on: only read-only commands run until the user approves a plan. Blocked: ${blocked}`,
    };
  });

  pi.registerTool({
    name: ENTER_TOOL,
    exposure: "model-only",
    label: "Enter plan mode",
    description:
      "Switch to plan mode to research and design an approach, with the user's approval, before writing code. In plan mode you can only read and write a plan file; exit_plan_mode then asks the user to approve the plan.",
    promptSnippet: "Enter plan mode before a non-trivial implementation",
    promptGuidelines: ENTER_GUIDELINES,
    parameters: { type: "object", additionalProperties: false, properties: {} } as never,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (state.active) return text("You are already in plan mode.");
      hostCtx = ctx;
      enter(ctx);
      if (!state.active) return text("Plan mode is not available right now.");
      // The tool result is the notice.
      state.told = true;
      persist();
      return text(`Entered plan mode.\n\n${noticeText()}`);
    },
  });

  pi.registerTool({
    name: EXIT_TOOL,
    // Nested codemode calls have no transcript row to render the plan being approved.
    exposure: "model-only",
    label: "Exit plan mode",
    description:
      "In plan mode, once your plan is written to the plan file and complete: show it to the user and ask for approval to start implementing. It takes no arguments; it reads the plan file. Do not use it for research questions, and do not ask for approval any other way.",
    promptSnippet: "Ask the user to approve the plan in the plan file (plan mode only)",
    parameters: { type: "object", additionalProperties: false, properties: {} } as never,
    renderCall: (_args, theme, context) =>
      new Text(theme.fg("toolTitle", theme.bold(context.isPartial ? "Plan review" : "Plan")), 0, 0),
    renderResult: (result, options, theme) => renderExit(result.details as ExitDetails | undefined, options, theme),
    async execute(_id, _params, signal, onUpdate, ctx) {
      hostCtx = ctx;
      if (!state.active || !state.planFile) {
        return text("You are not in plan mode. This tool only asks the user to approve a plan in plan mode.");
      }
      const planFile = state.planFile;
      let plan = readPlan(planFile);
      if (!plan) {
        return text(
          `The plan file ${planFile} is empty or missing. Write your plan there first, then call ${EXIT_TOOL} again.`,
        );
      }
      if (!ctx.hasUI) return text("There is no user to approve the plan. Stay in plan mode.");
      let edited = false;
      const choices = () => {
        const cycle = gate?.cycle ?? [];
        const here = gate
          ? [
              ...(cycle.includes("auto") ? [APPROVE_AUTO] : []),
              ...(cycle.includes("bypassPermissions") ? [APPROVE_YOLO] : []),
              ...(cycle.includes("acceptEdits") ? [APPROVE_EDITS] : []),
              // Manual approval when it is in the cycle, or when nothing else is.
              ...(cycle.includes("default") ||
              !(cycle.includes("auto") || cycle.includes("bypassPermissions") || cycle.includes("acceptEdits"))
                ? [APPROVE_MANUAL]
                : []),
            ]
          : [APPROVE_HERE];
        // RPC's select adds EDIT as a row before KEEP; the TUI reader has a key for it.
        return [...here, APPROVE_FRESH, KEEP];
      };
      const releaseBlocked = holdBlocked(pi.events, "Review the plan");
      try {
        for (;;) {
          onUpdate?.({
            content: [{ type: "text", text: plan }],
            details: { plan, planFile, outcome: "pending" } satisfies ExitDetails,
          } as never);
          const choice = await choosePlanApproval(
            ctx,
            plan,
            `Implement this plan? ${tildify(planFile)}`,
            choices(),
            KEEP,
            signal,
          );
          if (choice === EDIT) {
            // In your external editor when one is set (pi's externalEditor, or $VISUAL / $EDITOR),
            // else in pi's own.
            const command = externalEditorCommand(ctx.cwd);
            const revised = command
              ? await editInTerminal(ctx.ui as never, command, plan, "plan.md")
              : await ctx.ui.editor("Edit the plan", plan);
            if (command && revised === undefined)
              ctx.ui.notify(`${command.split(" ")[0]} did not save the plan.`, "warning");
            if (revised?.trim() && revised.trim() !== plan) {
              plan = revised.trim();
              edited = true;
              try {
                writeFileSync(planFile, `${plan}\n`);
              } catch (error: unknown) {
                ctx.ui.notify(`Could not save the plan file: ${String(error)}`, "error");
              }
            }
            continue;
          }
          if (choice === undefined || choice === KEEP) {
            const feedback =
              choice === KEEP ? (await ctx.ui.input("What should change? (Enter to say it in the chat)"))?.trim() : "";
            const details: ExitDetails = { plan, planFile, outcome: "kept" };
            if (feedback) {
              return {
                content: [
                  {
                    type: "text",
                    text: `The user wants to keep planning and did not approve the plan. Their feedback:\n\n${feedback}\n\nRevise the plan file, then call ${EXIT_TOOL} again.`,
                  },
                ],
                details,
              } as never;
            }
            return {
              content: [
                {
                  type: "text",
                  text: "The user wants to keep planning and did not approve the plan. Stop here and wait for them to say what to change.",
                },
              ],
              details,
              terminate: true,
            } as never;
          }
          host.approved(plan, ctx);
          if (choice === APPROVE_FRESH) {
            // The fresh session gets the plan; this one is done.
            exitLocal(ctx, false);
            if (gate) requestMode(gate.cycle.includes("auto") ? "auto" : "default");
            host.implementFresh(plan);
            return {
              content: [
                {
                  type: "text",
                  text: "The user approved the plan; it will be implemented in a fresh session. Stop here and do nothing else.",
                },
              ],
              details: { plan, planFile, outcome: "fresh", edited } satisfies ExitDetails,
              terminate: true,
            } as never;
          }
          const mode =
            choice === APPROVE_AUTO
              ? "auto"
              : choice === APPROVE_YOLO
                ? "bypassPermissions"
                : choice === APPROVE_EDITS
                  ? "acceptEdits"
                  : choice === APPROVE_MANUAL
                    ? "default"
                    : undefined;
          // This result tells your agent it left plan mode.
          exitLocal(ctx, false);
          if (mode) requestMode(mode);
          return {
            content: [{ type: "text", text: approvedText(plan, planFile, edited) }],
            details: { plan, planFile, outcome: "approved", edited, ...(mode ? { mode } : {}) } satisfies ExitDetails,
          } as never;
        }
      } finally {
        releaseBlocked();
      }
    },
  });

  return {
    get active() {
      return state.active;
    },
    get planFile() {
      return state.planFile;
    },
    enter,
    toggle(ctx) {
      hostCtx = ctx;
      if (gate) safely(() => pi.events.emit(MODE_CYCLE, {}));
      else if (state.active) exitLocal(ctx);
      else enterLocal(ctx);
    },
  };
}

function hasPlan(file: string | undefined) {
  return Boolean(file && readPlan(file));
}

function readPlan(file: string) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function tildify(file: string) {
  const home = process.env.HOME;
  return home && file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file;
}

const MODE_WORDS: Record<string, string> = {
  auto: "auto mode",
  bypassPermissions: "yolo mode",
  acceptEdits: "accepting edits",
  default: "approving edits manually",
};

const COLLAPSED_LINES = 12;

function renderExit(
  details: ExitDetails | undefined,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
) {
  const container = new Container();
  const plan = details?.plan;
  if (!plan) return container;
  const outcome = details?.outcome ?? "pending";
  const lines = plan.split("\n");
  // The plan in full while you decide; folded after, until expanded.
  const folded = outcome !== "pending" && !options.expanded && lines.length > COLLAPSED_LINES;
  container.addChild(
    new PlanMarkdown(folded ? lines.slice(0, COLLAPSED_LINES).join("\n") : plan, getMarkdownTheme(), theme),
  );
  if (folded) container.addChild(new Text(theme.fg("dim", `… ${lines.length - COLLAPSED_LINES} more lines`), 0, 0));
  // While you decide, the picker under the plan names the file: every row goes to the plan.
  if (outcome === "pending") return container;
  container.addChild(new Spacer(1));
  const where = details?.planFile ? theme.fg("dim", ` · ${tildify(details.planFile)}`) : "";
  const status =
    outcome === "approved"
      ? theme.fg(
          "success",
          `✓ Approved${details?.edited ? " (edited)" : ""}${details?.mode ? `, ${MODE_WORDS[details.mode] ?? details.mode}` : ""}`,
        )
      : outcome === "fresh"
        ? theme.fg("success", "✓ Approved, implementing in a fresh session")
        : theme.fg("warning", "Kept planning");
  container.addChild(new Text(`${status}${where}`, 0, 0));
  return container;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: undefined } as never;
}
