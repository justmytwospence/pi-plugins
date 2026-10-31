// Planning and Review: one lane per planner, side by side. Each lane shows its planner's chat,
// drawn by Pi's own components (or its plan, once it has one; ←/→ switch), the questions it is
// asking you, and a line to talk to it; you can talk to both at once. Once both plans are in, a
// full-width pane below the lanes is M, your main agent, which sees both plans and helps you merge
// them. The focused pane gets the room: M grows while you talk to it and shrinks to a few lines
// otherwise. Below everything, the actions for the plans. ctrl+n/ctrl+p walk a lane through its
// planner's subagents, showing each one's task and chat in place of the planner's.
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  decodeKittyPrintable,
  getKeybindings,
  Input,
  type KeyId,
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { PlannerAgent } from "../planner/agent.js";
import type { SubagentView } from "../subagent-progress.js";
import type { PlanRenders } from "./plan-embed.js";

/** What a lane shows of an agent: a planner, or M, your main agent seen through the same lens. */
export type LaneAgent = Pick<
  PlannerAgent,
  | "id"
  | "name"
  | "spec"
  | "trace"
  | "chat"
  | "subagents"
  | "status"
  | "working"
  | "stats"
  | "plan"
  | "revision"
  | "pending"
  | "error"
  | "answer"
> & { familyAgentId?: string };

import {
  EDITOR_INSERT,
  EDITOR_MODE,
  EDITOR_SURFACE,
  type EditorModeContext,
  INPUT_CONTEXT,
  idleNormal,
  readEditorMode,
} from "../editor-contract.js";
import { matchingCommands } from "../lane-commands.js";
import { formatCost, formatDuration, formatTokens } from "../planners.js";
import type { PlanModeQuestionAnswer } from "../question-tool.js";
import {
  effortText,
  type Hint,
  hintLine,
  labeledRule,
  padLines,
  padVisible,
  placeholderStyle,
  renderTable,
  rule,
  ScrollState,
  selectedRow,
  spinner,
  type WorkflowStep,
} from "../ui-kit.js";
import { pageHeader } from "./frame.js";
import { type PiChat, setPiChatTheme } from "./pi-chat.js";
import { TraceRenderer, wrap } from "./trace-lines.js";

export interface LaneAction {
  id: string;
  label: string;
  description: string;
  /** Actions that are a message to M: sent to it, with its pane focused on the chat. */
  toMerger?: string;
}

/**
 * A lane's input: pi's one-line Input, or the suite's embedded editor (pi-vim's) when a provider is
 * loaded (editor-contract.ts). Navigation is available only outside an active edit; the editor
 * owns Insert, Visual, EX, pending keys and autocomplete. With `ownsEnter`, Enter is the editor's (it calls the `submit` hook: Enter outside
 * autocomplete, `:w`); otherwise the page submits on Enter.
 */
export interface LaneInput {
  focused: boolean;
  getValue(): string;
  setValue(text: string): void;
  handleInput(data: string): void;
  /** Its lines: one for pi's input; a suite editor may wrap. */
  render(width: number): string[];
  ownsEnter: boolean;
  [EDITOR_MODE]?(): EditorModeContext | undefined;
  /** A suite editor: go to Insert mode (an answer is being typed). */
  [EDITOR_INSERT]?(): void;
  dispose?(): void;
}

export interface LaneInputHooks {
  /** Enter (or `:w`): send what was typed, or answer the question. */
  submit(text?: string): void;
  /** `:q` or Escape in Normal mode: nothing to leave here; the page redraws. */
  cancel(): void;
  /** Ctrl+U/D from the editor: scroll the lane by half a page. */
  scroll(direction: -1 | 1): void;
}

/** pi's one-line input as a lane input. */
export function nativeLaneInput(input: Input): LaneInput {
  return {
    get focused() {
      return input.focused;
    },
    set focused(value: boolean) {
      input.focused = value;
    },
    getValue: () => input.getValue(),
    setValue: (text) => input.setValue(text),
    handleInput: (data) => input.handleInput(data),
    render: (width) => [input.render(width)[0] ?? ""],
    ownsEnter: false,
  };
}

/** The most lines a lane's input takes (a suite editor's draft scrolls inside them). */
const MAX_INPUT_LINES = 4;
/** Home and End: further than any lane or page is long. */
const LANE_END = 1_000_000;

export interface LanesPageOptions {
  title: string;
  task: () => string;
  /** Makes a lane's input (the suite's editor when a provider is loaded); undefined for pi's input. */
  createInput?(id: string, hooks: LaneInputHooks): LaneInput | undefined;
  agents(): readonly LaneAgent[];
  /** M, your main agent, in the pane below the lanes; undefined until both plans are in. */
  merger?(): LaneAgent | undefined;
  actions(): LaneAction[];
  onAction(id: string): void;
  say(agent: LaneAgent, text: string): void;
  /** Talk to M (your main session). */
  sayToMerger?(text: string): void;
  /** Esc: hide the screen (planners keep going), or stop every working planner. */
  hide(): void;
  stopAll(): void;
  rowsAvailable(): number;
  /**
   * The share of the space below the header you dragged the M pane to (0-1), kept by the caller so
   * it outlives this page; undefined sizes it automatically (small, or a third while focused).
   */
  mergerShare?: { get(): number | undefined; set(share: number | undefined): void };
  requestRender(): void;
  /** Ctrl+G (pi's app.editor.external): edit the focused input's text in an external editor. */
  externalEditor?: { matches(data: string): boolean; edit(text: string): Promise<string | undefined> };
  /** Finished plans as rendered pages in their lanes (the Rendered plans setting); kept by the caller. */
  renders?: PlanRenders;
}

interface QuestionCursor {
  /** The question set this cursor belongs to; a new set starts a new cursor. */
  of: LaneAgent["pending"];
  question: number;
  option: number;
  /** Answers by question index; going back and answering again replaces one. */
  answers: Array<PlanModeQuestionAnswer | undefined>;
  /** An answer in your own words is being typed on the lane's input. */
  composing: boolean;
}

/** A row of a question: one of its options, Type something., Skip, or your earlier own answer. */
type QuestionRow =
  | { kind: "option"; index: number; label: string; description: string | undefined }
  | { kind: "type"; label: string; description: undefined }
  | { kind: "skip"; label: string; description: undefined }
  | { kind: "earlier"; label: string; description: undefined };

const TYPE_SOMETHING = "Type something.";

type Modal = { kind: "escape"; choice: number };

/** What Tab moves between: the lanes, M's pane, and the actions bar. */
type Target = { kind: "lane"; agent: LaneAgent } | { kind: "merger"; agent: LaneAgent } | { kind: "actions" };

const MAX_SUBAGENT_LINES = 3;
/** The most lines the task gets under the header (fewer on short screens). */
const MAX_TASK_LINES = 6;
const MERGER_ID = "M";
/** Rows of the merger pane while you are elsewhere: its title, a few lines, and its input. */
const MERGER_COLLAPSED_ROWS = 6;
/** Share of the space below the header the merger pane takes while you talk to it. */
const MERGER_FOCUSED_SHARE = 1 / 3;
const MIN_LANE_ROWS = 6;
/** The merger pane's smallest useful size: its title, a line, its rule, and its input. */
const MERGER_MIN_ROWS = 5;

export class LanesPage {
  /** Index into the Tab targets: the lanes, then the merger pane (if any), then the actions bar. */
  focus = 0;
  focused = true;
  private actionIndex = 0;
  private lastViewedAgentId: string | undefined;

  /** Actions keep the last conversation subject; M maps to the family's anchor. */
  viewedAgentId(): string | undefined {
    const target = this.focusedTarget();
    if (target.kind !== "actions")
      this.lastViewedAgentId = this.selectedSub(target.agent)?.familyAgentId ?? target.agent.familyAgentId;
    return this.lastViewedAgentId;
  }
  private modal: Modal | undefined;
  private readonly inputs = new Map<string, LaneInput>();
  private readonly showTrace = new Set<string>();
  /** The subagent each lane shows instead of its planner, by agent id. */
  private readonly subFocus = new Map<string, string>();
  private readonly questions = new Map<string, QuestionCursor>();
  private readonly scroll = new ScrollState();
  private readonly renderer: TraceRenderer;
  private readonly chats = new Map<string, { chat: PiChat; version: number; width: number; lines: string[] }>();
  private readonly lineCounts = new Map<string, number>();
  /** The plan revision each lane last showed: a new one is shown from its top. */
  private readonly seenRevision = new Map<string, number>();
  private readonly laneHeights = new Map<string, number>();
  private laneTop = 0;
  private laneLayout: Array<{ x: number; width: number; agent: LaneAgent }> = [];
  private mergerTop = 0;
  private actionsTop = 0;
  /** The last layout: rows below the header, and the M pane's rows (for resizing it). */
  private lastAvailable = 0;
  private lastMergerRows = 0;
  private draggingDivider = false;
  private editorScrolling = false;
  /** The stats table fit on the last render; when it did not, the lane titles carry the status. */
  private statsShown = true;

  constructor(
    private readonly theme: Theme,
    private readonly options: LanesPageOptions,
  ) {
    this.renderer = new TraceRenderer(theme);
    setPiChatTheme(theme);
  }

  /** An agent's chat, drawn by Pi's own components; re-rendered only when it changed. */
  private chatLines(agent: LaneAgent, width: number): string[] {
    const cached = this.chats.get(agent.id);
    if (cached && cached.chat === agent.chat && cached.version === agent.chat.version && cached.width === width) {
      return cached.lines;
    }
    const lines = agent.chat.render(width);
    // Pi pads its components with blank lines; a pane does not need the leading ones.
    while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
    this.chats.set(agent.id, { chat: agent.chat, version: agent.chat.version, width, lines });
    return lines;
  }

  /** The step the page stands for: Planning while a planner works, Review once plans are in. */
  step(): WorkflowStep {
    const agents = this.options.agents();
    if (agents.some((agent) => agent.working)) return "Planning";
    return agents.some((agent) => agent.plan) ? "Review" : "Planning";
  }

  /** Go to the actions bar (e.g. when every plan is in). */
  focusActions() {
    this.focus = this.targets().length - 1;
  }

  readonly [EDITOR_SURFACE] = "embedded";

  [INPUT_CONTEXT]() {
    const target = this.focusedTarget();
    if (this.modal || target.kind === "actions" || this.picking(target.agent)) return "list";
    return "editor";
  }

  [EDITOR_MODE]() {
    const target = this.focusedTarget();
    if (this.modal || target.kind === "actions" || this.picking(target.agent)) return undefined;
    return readEditorMode(this.inputFor(target.agent.id));
  }

  get typing() {
    const target = this.focusedTarget();
    return !this.modal && target.kind !== "actions" && !this.picking(target.agent);
  }

  /** A question of this agent is on screen (not a subagent), as a list of answers to pick from. */
  private asking(agent: LaneAgent) {
    return agent.pending !== undefined && !this.selectedSub(agent);
  }

  /** Asking, and not typing an answer: the keys are the list's, not the input's. */
  private picking(agent: LaneAgent) {
    return this.asking(agent) && !this.questionCursor(agent).composing;
  }

  /** M, once both plans are in. */
  private merger() {
    return this.options.merger?.();
  }

  private targets(): Target[] {
    const merger = this.merger();
    return [
      ...this.options.agents().map((agent): Target => ({ kind: "lane", agent })),
      ...(merger ? [{ kind: "merger", agent: merger } as Target] : []),
      { kind: "actions" },
    ];
  }

  private focusedTarget(): Target {
    const targets = this.targets();
    if (this.focus >= targets.length) this.focus = targets.length - 1;
    return targets[this.focus] ?? { kind: "actions" };
  }

  /** Every agent on the page: the planners, and M once it is there. */
  private everyone() {
    const merger = this.merger();
    return [...this.options.agents(), ...(merger ? [merger] : [])];
  }

  private input(agent: LaneAgent) {
    return this.inputFor(agent.id);
  }

  private inputFor(id: string): LaneInput {
    let input = this.inputs.get(id);
    if (!input) {
      const hooks: LaneInputHooks = {
        submit: (text) => {
          // Pi's submit path clears the editor before calling onSubmit.
          if (text !== undefined) this.inputFor(id).setValue(text);
          this.submitFor(id);
          this.options.requestRender();
        },
        cancel: () => {
          const agent = this.agentFor(id);
          if (agent && this.asking(agent) && this.questionCursor(agent).composing) {
            // Back to the options; the draft stays on the line for next time.
            this.questionCursor(agent).composing = false;
          } else if (agent && this.selectedSub(agent)) this.subFocus.delete(agent.id);
          else this.modal = { kind: "escape", choice: 0 };
          this.options.requestRender();
        },
        scroll: (direction) => {
          // The mode at dispatch owns the key, even if an editor cancels EX/pending first.
          if (!this.editorScrolling) return;
          const agent = this.agentFor(id);
          if (agent)
            this.scrollLane(agent, direction * Math.max(1, Math.floor((this.laneHeights.get(agent.id) ?? 10) / 2)));
          this.options.requestRender();
        },
      };
      let created: LaneInput | undefined;
      try {
        created = this.options.createInput?.(id, hooks);
      } catch {
        // A provider's bug must not take the lane's input away: pi's follows.
      }
      input =
        created ??
        nativeLaneInput(
          new Input({
            prompt: "",
            placeholder: `talk to ${id}… (/ for commands)`,
            placeholderStyle: placeholderStyle(this.theme),
          }),
        );
      this.inputs.set(id, input);
    }
    return input;
  }

  /** The agent a lane input talks to: a planner, or M. */
  private agentFor(id: string): LaneAgent | undefined {
    return this.everyone().find((agent) => agent.id === id);
  }

  private edit(input: LaneInput, data: string) {
    this.editorScrolling = idleNormal(input);
    try {
      input.handleInput(data);
    } finally {
      this.editorScrolling = false;
    }
  }

  /** Enter from an input that owns it (a suite editor): the same as the page's Enter there. */
  private submitFor(id: string) {
    if (this.modal) return;
    const agent = this.agentFor(id);
    if (agent) this.submit(agent, id === MERGER_ID);
  }

  /** A lane's input as lines: focused, the editor itself (several lines for a suite editor); else its first line, dim. */
  private inputLines(input: LaneInput, focused: boolean, width: number, idle: string, max = MAX_INPUT_LINES): string[] {
    const theme = this.theme;
    if (!focused) return [theme.fg("dim", `› ${input.getValue().split("\n")[0] || idle}`)];
    const lines = input.render(Math.max(4, width - 2));
    const limit = Math.max(1, max);
    // Past the limit, keep the cursor's line in view rather than cutting the end off.
    let start = 0;
    if (lines.length > limit) {
      const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
      const anchor = cursor >= 0 ? cursor : lines.length - 1;
      start = Math.min(lines.length - limit, Math.max(0, anchor - limit + 2));
    }
    const shown = lines.length ? lines.slice(start, start + limit) : [""];
    return shown.map((line, index) => `${index === 0 ? theme.fg("accent", "›") : " "} ${line}`);
  }

  /** Let the inputs go (a suite editor must be disposed when its screen closes). */
  dispose() {
    this.options.renders?.hideAll();
    for (const input of this.inputs.values()) {
      try {
        input.dispose?.();
      } catch {
        // Already gone.
      }
    }
    this.inputs.clear();
  }

  private viewKey(agent: LaneAgent) {
    const sub = this.selectedSub(agent);
    if (sub) return `${agent.id}:sub:${sub.id}`;
    return `${agent.id}:${this.showsPlan(agent) ? "plan" : "chat"}`;
  }

  /** The subagent a lane shows, if you moved to one. */
  private selectedSub(agent: LaneAgent): SubagentView | undefined {
    const id = this.subFocus.get(agent.id);
    return id === undefined ? undefined : agent.subagents.agents.find((sub) => sub.id === id);
  }

  /** ctrl+n/ctrl+p: the next or previous subagent, and past either end back to the planner. */
  private stepSub(agent: LaneAgent, step: 1 | -1) {
    const subs = agent.subagents.agents;
    if (subs.length === 0) return;
    const current = this.selectedSub(agent);
    const index = current ? subs.indexOf(current) : step === 1 ? -1 : subs.length;
    const next = subs[index + step];
    if (next) this.subFocus.set(agent.id, next.id);
    else this.subFocus.delete(agent.id);
  }

  private showsPlan(agent: LaneAgent) {
    return agent.plan !== undefined && !this.showTrace.has(agent.id);
  }

  /** ←/→ on an empty line: the lane's other view, plan or chat (and out of a subagent). */
  private toggleView(agent: LaneAgent) {
    this.subFocus.delete(agent.id);
    if (agent.plan === undefined) return;
    if (this.showTrace.has(agent.id)) this.showTrace.delete(agent.id);
    else this.showTrace.add(agent.id);
  }

  invalidate() {}

  handleInput(data: string) {
    const is = (...keys: KeyId[]) => keys.some((key) => matchesKey(data, key));
    const targets = this.targets();
    if (this.focus >= targets.length) this.focus = targets.length - 1;
    if (this.modal?.kind === "escape") return this.handleEscapeModal(data, is);
    const focused = targets[this.focus];
    const laneAgent = focused?.kind === "lane" || focused?.kind === "merger" ? focused.agent : undefined;
    const input = laneAgent ? this.inputFor(laneAgent.id) : undefined;
    // A question's list owns the keys (nothing reaches the input) until you type an answer.
    if (laneAgent && this.picking(laneAgent) && !is("tab", "shift+tab")) {
      this.handleQuestion(laneAgent, data, is);
      return this.options.requestRender();
    }
    if (input && this.options.externalEditor?.matches(data)) {
      const target = input;
      void this.options.externalEditor
        .edit(target.getValue())
        .then((text) => {
          if (text !== undefined) target.setValue(text);
        })
        .catch(() => undefined)
        .finally(() => this.options.requestRender());
      return;
    }
    const mode = readEditorMode(input);
    const modalEdit = mode && !idleNormal(input);
    // Tab is an explicit pane switch, unless a popup or unfinished modal command owns it.
    const switchPane =
      is("tab", "shift+tab") && (!mode || (!mode.autocomplete && (mode.state === "normal" || mode.state === "insert")));
    const draftEdit =
      input &&
      input.getValue() !== "" &&
      !is("escape", "enter") &&
      (!mode || !is("ctrl+u", "ctrl+d", "pageUp", "pageDown"));
    if (input && !switchPane && (modalEdit || draftEdit)) {
      this.edit(input, data);
      return this.options.requestRender();
    }
    if (input?.ownsEnter && is("escape", "ctrl+u", "ctrl+d", "enter")) {
      this.edit(input, data);
      return this.options.requestRender();
    }
    if (laneAgent && this.asking(laneAgent) && is("escape")) {
      // Typing an answer on pi's input: Esc goes back to the options, keeping the draft.
      this.questionCursor(laneAgent).composing = false;
      return this.options.requestRender();
    }
    if (laneAgent && is("ctrl+n", "ctrl+p")) {
      this.stepSub(laneAgent, is("ctrl+n") ? 1 : -1);
      return this.options.requestRender();
    }
    if (is("escape")) {
      // Out of a subagent first, back to its planner; then the leave menu.
      if (laneAgent && this.selectedSub(laneAgent)) this.subFocus.delete(laneAgent.id);
      else this.modal = { kind: "escape", choice: 0 };
      return this.options.requestRender();
    }
    if (this.merger() && is("shift+up", "shift+down")) {
      // Move the divider between the lanes and M by a row.
      this.resizeMerger(this.lastMergerRows + (is("shift+up") ? 1 : -1));
      return this.options.requestRender();
    }
    if (is("tab") || is("shift+tab")) {
      const step = is("tab") ? 1 : -1;
      this.focus = (this.focus + step + targets.length) % targets.length;
      if (targets[this.focus]?.kind === "actions") this.actionIndex = 0;
      return this.options.requestRender();
    }
    const target = targets[this.focus];
    if (!target || target.kind === "actions") return this.handleActions(is);
    const agent = target.agent;
    const half = Math.max(1, Math.floor((this.laneHeights.get(agent.id) ?? 10) / 2));
    // Pi's own bindings too (keybindings.json): a list's up/down (ctrl+k/ctrl+j for some), and the
    // transcript's top, bottom and page keys (ctrl+g, say).
    const bound = (...ids: Parameters<ReturnType<typeof getKeybindings>["matches"]>[1][]) =>
      ids.some((id) => getKeybindings().matches(data, id));
    const editing = this.input(agent).getValue() !== "";
    if (is("ctrl+u")) this.scrollLane(agent, -half);
    else if (is("ctrl+d")) this.scrollLane(agent, half);
    else if (is("pageUp") || bound("tui.altScreen.pageUp"))
      this.scrollLane(agent, -(this.laneHeights.get(agent.id) ?? 10));
    else if (is("pageDown") || bound("tui.altScreen.pageDown"))
      this.scrollLane(agent, this.laneHeights.get(agent.id) ?? 10);
    else if (!editing && bound("tui.select.up")) this.scrollLane(agent, -1);
    else if (!editing && bound("tui.select.down")) this.scrollLane(agent, 1);
    else if (!editing && bound("tui.altScreen.top")) this.scrollLane(agent, -LANE_END);
    else if (!editing && bound("tui.altScreen.bottom")) this.scrollLane(agent, LANE_END);
    else if (is("ctrl+o")) {
      // Expand or collapse tool output, as in pi.
      agent.chat.setExpanded(!agent.chat.isExpanded);
    } else if (is("ctrl+t")) {
      // Show or hide thinking, as in pi.
      agent.chat.setThinkingHidden(!agent.chat.thinkingHidden);
    } else if (is("up")) this.scrollLane(agent, -1);
    else if (is("down")) this.scrollLane(agent, 1);
    else if (is("home") && this.input(agent).getValue() === "") this.scrollLane(agent, -LANE_END);
    else if (is("end") && this.input(agent).getValue() === "") this.scrollLane(agent, LANE_END);
    else if (is("left", "right") && this.input(agent).getValue() === "") this.toggleView(agent);
    else if (is("enter") && !this.input(agent).ownsEnter) this.submit(agent, target.kind === "merger");
    else this.edit(this.input(agent), data);
    this.options.requestRender();
  }

  /** An action that talks to M: send it, and move to M's pane to watch the reply. */
  private sendToMerger(text: string) {
    const index = this.targets().findIndex((target) => target.kind === "merger");
    if (index === -1) return;
    this.focus = index;
    this.scroll.follow(`${MERGER_ID}:chat`);
    this.showTrace.add(MERGER_ID);
    this.options.sayToMerger?.(text);
  }

  private handleEscapeModal(_data: string, is: (...keys: KeyId[]) => boolean) {
    const modal = this.modal as Extract<Modal, { kind: "escape" }>;
    const choices = this.escapeChoices();
    if (is("escape")) this.modal = undefined;
    else if (is("left", "ctrl+h", "up")) modal.choice = (modal.choice - 1 + choices.length) % choices.length;
    else if (is("right", "ctrl+l", "down", "tab")) modal.choice = (modal.choice + 1) % choices.length;
    else if (is("enter")) {
      this.modal = undefined;
      const choice = choices[modal.choice];
      if (choice?.id === "hide") return this.options.hide();
      if (choice?.id === "stop") this.options.stopAll();
    }
    this.options.requestRender();
  }

  private escapeChoices() {
    const working = this.everyone().some((agent) => agent.working);
    return [
      { id: "hide", label: working ? "Hide (keep planning)" : "Hide (keep the plans)" },
      ...(working ? [{ id: "stop", label: "Stop planning" }] : []),
      { id: "back", label: "Back" },
    ];
  }

  private handleActions(is: (...keys: KeyId[]) => boolean) {
    const actions = this.options.actions();
    if (actions.length === 0) return;
    if (this.actionIndex >= actions.length) this.actionIndex = 0;
    if (is("left", "ctrl+h", "h", "up")) this.actionIndex = (this.actionIndex - 1 + actions.length) % actions.length;
    else if (is("right", "ctrl+l", "l", "down")) this.actionIndex = (this.actionIndex + 1) % actions.length;
    else if (is("enter")) {
      const action = actions[this.actionIndex];
      if (!action) return;
      if (action.toMerger !== undefined) this.sendToMerger(action.toMerger);
      else this.options.onAction(action.id);
    } else return;
    this.options.requestRender();
  }

  private questionCursor(agent: LaneAgent): QuestionCursor {
    let cursor = this.questions.get(agent.id);
    if (!cursor || !agent.pending || cursor.of !== agent.pending) {
      cursor = { of: agent.pending, question: 0, option: 0, answers: [], composing: false };
      this.questions.set(agent.id, cursor);
    }
    return cursor;
  }

  /**
   * Show another question with its earlier answer selected: an option, or your own words as a row
   * of their own (so the line stays empty and ←/→ keep moving between questions).
   */
  private moveToQuestion(agent: LaneAgent, cursor: QuestionCursor, index: number) {
    cursor.question = index;
    cursor.composing = false;
    const previous = cursor.answers[index];
    const question = agent.pending?.questions[index];
    const rows = question ? this.questionRows(question, cursor, index) : [];
    cursor.option = !previous
      ? 0
      : previous.wasCustom
        ? Math.max(
            0,
            rows.findIndex((row) => row.kind === "earlier"),
          )
        : Math.max(0, (previous.optionIndex ?? 1) - 1);
  }

  /** The rows a question offers: its options, Type something., Skip, and your earlier own answer. */
  private questionRows(
    question: { options: ReadonlyArray<{ label: string; description?: string }> },
    cursor: QuestionCursor,
    index = cursor.question,
  ): QuestionRow[] {
    const earlier = cursor.answers[index];
    return [
      ...question.options.map(
        (option, position): QuestionRow => ({
          kind: "option",
          index: position,
          label: option.label,
          description: option.description,
        }),
      ),
      { kind: "type", label: TYPE_SOMETHING, description: undefined },
      { kind: "skip", label: "Skip (let the planner decide)", description: undefined },
      ...(earlier?.wasCustom
        ? [{ kind: "earlier", label: `✎ your answer: ${earlier.answer}`, description: undefined } as QuestionRow]
        : []),
    ];
  }

  /** The keys of a question's list: move, jump, confirm, or start typing on Type something. */
  private handleQuestion(agent: LaneAgent, data: string, is: (...keys: KeyId[]) => boolean) {
    const pending = agent.pending;
    const cursor = this.questionCursor(agent);
    const question = pending?.questions[cursor.question];
    if (!pending || !question) return;
    const rows = this.questionRows(question, cursor);
    const half = Math.max(1, Math.floor((this.laneHeights.get(agent.id) ?? 10) / 2));
    const key = printable(data);
    if (is("escape")) this.modal = { kind: "escape", choice: 0 };
    else if (is("enter")) this.confirmQuestion(agent);
    else if (rows[cursor.option]?.kind === "type" && (key === " " || isTextInput(data))) {
      // Typing on Type something. starts the answer with what you typed (j, k and digits included).
      this.startComposing(agent);
      if (key !== " ") this.edit(this.input(agent), data);
    } else if (is("up", "ctrl+k") || key === "k") cursor.option = (cursor.option - 1 + rows.length) % rows.length;
    else if (is("down", "ctrl+j") || key === "j") cursor.option = (cursor.option + 1) % rows.length;
    else if (key && /^[1-9]$/u.test(key)) {
      if (Number(key) <= rows.length) cursor.option = Number(key) - 1;
    } else if (is("left", "backspace", "right")) {
      // ←/backspace go back a question and → forward (as far as you have answered).
      if (is("right")) {
        const reachable = cursor.answers.indexOf(undefined);
        const last = reachable === -1 ? pending.questions.length - 1 : reachable;
        if (cursor.question < last) this.moveToQuestion(agent, cursor, cursor.question + 1);
      } else if (cursor.question > 0) this.moveToQuestion(agent, cursor, cursor.question - 1);
    } else if (is("ctrl+u")) this.scrollLane(agent, -half);
    else if (is("ctrl+d")) this.scrollLane(agent, half);
    else if (is("pageUp")) this.scrollLane(agent, -(this.laneHeights.get(agent.id) ?? 10));
    else if (is("pageDown")) this.scrollLane(agent, this.laneHeights.get(agent.id) ?? 10);
    else if (is("ctrl+n", "ctrl+p")) this.stepSub(agent, is("ctrl+n") ? 1 : -1);
    else if (is("ctrl+o")) agent.chat.setExpanded(!agent.chat.isExpanded);
    else if (is("ctrl+t")) agent.chat.setThinkingHidden(!agent.chat.thinkingHidden);
  }

  /** Type something.: the lane's input becomes the answer line (a suite editor in Insert mode). */
  private startComposing(agent: LaneAgent) {
    const cursor = this.questionCursor(agent);
    cursor.composing = true;
    const input = this.input(agent);
    input.focused = true;
    try {
      input[EDITOR_INSERT]?.();
    } catch {
      // A provider without Insert on demand keeps its mode.
    }
  }

  /** Enter on a question: the highlighted row, or the answer you typed. */
  private confirmQuestion(agent: LaneAgent) {
    const pending = agent.pending;
    const cursor = this.questionCursor(agent);
    const question = pending?.questions[cursor.question];
    if (!pending || !question) return;
    const input = this.input(agent);
    const rows = this.questionRows(question, cursor);
    const row = rows[cursor.option];
    const earlier = cursor.answers[cursor.question];
    let answer: PlanModeQuestionAnswer | undefined;
    if (cursor.composing) {
      const text = input.getValue().trim();
      if (!text) return;
      answer = { id: question.id, header: question.header, question: question.question, answer: text, wasCustom: true };
      input.setValue("");
      cursor.composing = false;
    } else if (!row || row.kind === "type") return this.startComposing(agent);
    else if (row.kind === "skip") {
      this.questions.delete(agent.id);
      agent.answer(undefined);
      return;
    } else if (row.kind === "earlier") answer = earlier;
    else {
      answer = {
        id: question.id,
        header: question.header,
        question: question.question,
        answer: row.label,
        wasCustom: false,
        optionIndex: row.index + 1,
      };
    }
    cursor.answers[cursor.question] = answer;
    const unanswered = pending.questions.findIndex((_question, index) => cursor.answers[index] === undefined);
    if (unanswered === -1 && cursor.question === pending.questions.length - 1) {
      this.questions.delete(agent.id);
      agent.answer(cursor.answers.filter((value): value is PlanModeQuestionAnswer => value !== undefined));
      return;
    }
    // On to the next question (or, after the last, the first one still unanswered).
    const next = cursor.question + 1 < pending.questions.length ? cursor.question + 1 : unanswered;
    this.moveToQuestion(agent, cursor, next);
  }

  /** Enter in a lane or the merger pane: answer its question, or send what you typed. */
  private submit(agent: LaneAgent, merger = false) {
    if (this.asking(agent)) return this.confirmQuestion(agent);
    const input = this.input(agent);
    const text = input.getValue().trim();
    if (!text) return;
    input.setValue("");
    this.scroll.follow(`${agent.id}:chat`);
    this.showTrace.add(agent.id);
    if (merger) this.options.sayToMerger?.(text);
    else this.options.say(agent, text);
  }

  private scrollLane(agent: LaneAgent, delta: number) {
    // A rendered plan keeps its own place in the page's picture, not in lines this page keeps.
    if (this.showsPlan(agent) && !this.selectedSub(agent) && this.options.renders?.scroll(agent.id, delta)) return;
    const key = this.viewKey(agent);
    this.scroll.scrollBy(key, delta, this.lineCounts.get(key) ?? 0, this.laneHeights.get(agent.id) ?? 10);
  }

  /** Size the M pane to `rows` (kept within both panes' minimums) and remember it as a share. */
  private resizeMerger(rows: number) {
    if (!this.options.mergerShare || this.lastAvailable <= 0 || !this.merger()) return;
    const clamped = Math.max(MERGER_MIN_ROWS, Math.min(this.lastAvailable - MIN_LANE_ROWS, rows));
    this.lastMergerRows = clamped;
    this.options.mergerShare.set(clamped / this.lastAvailable);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // The M pane's title rule is the divider: drag it to resize; double-click it to size M
    // automatically again.
    const onDivider = this.merger() !== undefined && this.lastMergerRows > 0 && event.y === this.mergerTop;
    if (this.draggingDivider) {
      if (event.type === "drag" || event.type === "move") {
        this.resizeMerger(this.actionsTop - event.y);
        this.options.requestRender();
        return { capture: true };
      }
      if (event.type === "release") {
        this.draggingDivider = false;
        return { handled: true };
      }
    }
    if (onDivider && event.type === "press" && event.button === "left") {
      this.draggingDivider = true;
      return { capture: true };
    }
    if (onDivider && event.type === "click" && (event.clickCount ?? 1) >= 2) {
      this.options.mergerShare?.set(undefined);
      this.options.requestRender();
      return { handled: true };
    }
    const lane =
      event.y >= this.laneTop && event.y < this.mergerTop
        ? this.laneLayout.find((candidate) => event.x >= candidate.x && event.x < candidate.x + candidate.width + 1)
        : undefined;
    const merger = this.merger();
    const inMerger = merger !== undefined && event.y >= this.mergerTop && event.y < this.actionsTop;
    const scrolled = lane?.agent ?? (inMerger ? merger : undefined);
    if (event.type === "wheel" && scrolled) {
      this.scrollLane(scrolled, Math.sign(event.wheelDelta ?? 0) * 3);
      this.options.requestRender();
      return { handled: true };
    }
    if (event.type === "click") {
      const targets = this.targets();
      if (lane) this.focus = this.options.agents().indexOf(lane.agent);
      else if (inMerger) this.focus = targets.findIndex((target) => target.kind === "merger");
      else if (event.y >= this.actionsTop) this.focus = targets.length - 1;
      this.options.requestRender();
      return { handled: true };
    }
    return event.type === "move" || event.type === "release" ? undefined : { handled: true };
  }

  render(width: number): string[] {
    const height = this.options.rowsAvailable();
    const agents = this.options.agents();
    const target = this.focusedTarget();
    const merger = this.merger();
    for (const agent of this.everyone()) this.syncRevision(agent);
    const renders = this.options.renders;
    renders?.beginFrame();
    try {
      return this.renderPage(width, height, agents, target, merger);
    } finally {
      renders?.endFrame();
    }
  }

  private renderPage(
    width: number,
    height: number,
    agents: readonly LaneAgent[],
    target: Target,
    merger: LaneAgent | undefined,
  ): string[] {
    const theme = this.theme;
    const header = pageHeader(theme, width, this.options.title, this.context(), this.step());
    const footer = this.footer(width, target);
    // Everything fits the screen and the actions bar always shows: when room runs short, the task
    // shrinks to one line, then the stats rows go, then the merger pane (unless you are in it), and
    // the lanes are cut last.
    const mergerFocused = target.kind === "merger";
    // Once the plans are in and drawn as pages, the stats table only repeats the lane titles (and the
    // header has the totals): the pages get its rows.
    const reviewing = this.options.renders?.enabled() === true && this.step() === "Review";
    const stats = reviewing ? [] : this.statsLines(width);
    const mergerMin = merger ? MERGER_MIN_ROWS : 0;
    const fixed = header.length + footer.length + stats.length + MIN_LANE_ROWS + mergerMin;
    const taskMax = Math.max(1, Math.min(MAX_TASK_LINES, Math.floor(height / 6), height - fixed));
    const base = [...header, ...this.taskLines(width, taskMax)];
    const room = height - base.length - footer.length;
    this.statsShown = stats.length > 0 && room - stats.length >= MIN_LANE_ROWS + mergerMin;
    const top = this.statsShown ? [...base, ...stats] : base;
    const available = Math.max(1, height - top.length - footer.length);
    const showMerger = merger !== undefined && (mergerFocused || available >= MIN_LANE_ROWS + MERGER_MIN_ROWS);
    const share = this.options.mergerShare?.get();
    const wanted =
      share !== undefined
        ? Math.round(available * share)
        : mergerFocused || merger?.pending
          ? Math.floor(available * MERGER_FOCUSED_SHARE)
          : MERGER_COLLAPSED_ROWS;
    const mergerRows = showMerger ? Math.max(MERGER_MIN_ROWS, Math.min(available - MIN_LANE_ROWS, wanted)) : 0;
    this.lastAvailable = available;
    this.lastMergerRows = mergerRows;
    const laneRows = Math.max(1, available - mergerRows);
    this.laneTop = top.length;
    // The lanes render at least their own minimum; cut them to the rows they were given.
    const lanes = this.renderLanes(agents, width, Math.max(MIN_LANE_ROWS, laneRows), target).slice(0, laneRows);
    this.mergerTop = top.length + lanes.length;
    const pane =
      showMerger && merger
        ? this.lane(merger, width, mergerRows, mergerFocused, true).slice(0, available - lanes.length)
        : [];
    this.actionsTop = this.mergerTop + pane.length;
    const middle = padLines([...lanes, ...pane], available);
    // The footer (actions bar and keys) is never the part that gets cut.
    const above = [...top, ...middle].slice(0, Math.max(0, height - footer.length));
    return [...above, ...footer].map((line) => truncateToWidth(line, width));
  }

  /** The task under the header: wrapped onto up to `max` lines, cut with a count past that. */
  private taskLines(width: number, max: number): string[] {
    const theme = this.theme;
    const label = ` ${theme.fg("dim", "Task")}  `;
    const indent = " ".repeat(visibleWidth(label));
    const lines = wrap(this.options.task().trim(), Math.max(10, width - indent.length)).filter((line) => line.trim());
    if (lines.length === 0) return [];
    let shown = lines.slice(0, max);
    if (lines.length > max) {
      const hidden = lines.length - max;
      const more = theme.fg("dim", ` … ${hidden} more line${hidden === 1 ? "" : "s"}`);
      shown = [
        ...lines.slice(0, max - 1),
        `${truncateToWidth(lines[max - 1] ?? "", width - indent.length - visibleWidth(more) - 1, "")}${more}`,
      ];
    }
    return shown.map((line, index) => truncateToWidth(`${index === 0 ? label : indent}${line}`, width));
  }

  private context() {
    const agents = this.options.agents();
    const all = this.everyone();
    const tokens = all.reduce((sum, agent) => sum + agent.stats.totalTokens, 0);
    const cost = all.reduce((sum, agent) => sum + agent.stats.costUsd, 0);
    return [
      agents.length === 1 ? "1 planner" : `${agents.length} planners`,
      ...(tokens ? [`${formatTokens(tokens)} tok`] : []),
      ...(cost ? [formatCost(cost)] : []),
    ].join(" · ");
  }

  private renderLanes(agents: readonly LaneAgent[], width: number, rows: number, target: Target): string[] {
    const gap = " │ ";
    const count = Math.max(1, agents.length);
    const laneWidth = Math.max(20, Math.floor((width - gap.length * (count - 1)) / count));
    this.laneLayout = [];
    const columns = agents.map((agent, index) => {
      this.laneLayout.push({ x: index * (laneWidth + gap.length), width: laneWidth, agent });
      return this.lane(agent, laneWidth, rows, target.kind === "lane" && target.agent === agent);
    });
    if (columns.length === 0) return padLines([this.theme.fg("dim", "  No planners.")], rows);
    const lines: string[] = [];
    for (let row = 0; row < rows; row += 1) {
      lines.push(
        columns.map((column) => padVisible(column[row] ?? "", laneWidth)).join(this.theme.fg("borderMuted", gap)),
      );
    }
    return lines;
  }

  /** A new plan version is shown from its top, in place of the trace. */
  private syncRevision(agent: LaneAgent) {
    if (agent.plan === undefined || this.seenRevision.get(agent.id) === agent.revision) return;
    this.seenRevision.set(agent.id, agent.revision);
    this.showTrace.delete(agent.id);
    this.scroll.toTop(`${agent.id}:plan`);
  }

  private lane(agent: LaneAgent, width: number, rows: number, focused: boolean, merger = false): string[] {
    const theme = this.theme;
    const color = focused ? "borderAccent" : "borderMuted";
    const title = `${agent.id}${merger ? " · main agent" : ""} · ${agent.name}${agent.spec.thinkingLevel ? ` ${agent.spec.thinkingLevel}` : ""}`;
    // The stats table carries the status; when it is off (a short screen), the title says it.
    const corner = [
      ...(agent.revision > 1 ? [theme.fg("muted", `v${agent.revision}`)] : []),
      ...(this.statsShown ? [] : [this.status(agent)]),
    ].join(theme.fg("dim", " · "));
    const head = labeledRule(
      theme,
      width,
      `${this.stateIcon(agent)} ${focused ? theme.fg("accent", theme.bold(title)) : theme.fg("muted", title)}`,
      corner,
      color,
    );
    const selected = this.selectedSub(agent);
    const subagents = this.subagentLines(agent, selected, width, rows);
    // A question gets the room it needs, short of the title, two lines of chat, and the answer line.
    const asking = this.asking(agent);
    const question = asking ? this.questionLines(agent, width, Math.max(1, rows - 1 - subagents.length - 2 - 2)) : [];
    const composing = asking && this.questionCursor(agent).composing;
    const input = this.input(agent);
    input.focused = this.focused && focused && this.modal === undefined && (!asking || composing);
    // The input grows to half the lane, leaving the title and at least two lines of chat.
    const inputRoom = Math.max(
      MAX_INPUT_LINES,
      Math.min(Math.floor(rows / 2), rows - 1 - subagents.length - question.length - 1 - 2),
    );
    const inputLines = asking
      ? composing
        ? this.inputLines(input, focused, width, "", inputRoom)
        : [
            theme.fg(
              "dim",
              focused
                ? `› ⏎ picks the highlighted answer; type one on ${TYPE_SOMETHING}`
                : `› tab to answer ${agent.id}`,
            ),
          ]
      : this.inputLines(input, focused, width, `tab to talk to ${agent.id}`, inputRoom);
    const bodyHeight = Math.max(2, rows - 1 - subagents.length - question.length - 1 - inputLines.length);
    this.laneHeights.set(agent.id, bodyHeight);
    const key = this.viewKey(agent);
    const renders = this.options.renders;
    const rendered =
      !selected && !asking && this.showsPlan(agent) && renders?.enabled()
        ? renders.body(agent.id, agent.revision, agent.plan ?? "", { cols: width, rows: bodyHeight })
        : undefined;
    const renderFailure =
      !selected && !asking && this.showsPlan(agent) && renders?.enabled() ? renders.failure(agent.id) : undefined;
    const all = selected
      ? [
          ...wrap(`${selected.label}: ${selected.task}`, width).map((line) => theme.fg("muted", line)),
          "",
          ...this.renderer.lines(selected.trace, width),
        ]
      : this.showsPlan(agent)
        ? this.renderer.planLines(`${agent.id}:${agent.revision}`, agent.plan ?? "", width)
        : this.chatLines(agent, width);
    this.lineCounts.set(key, all.length);
    const view = this.scroll.window(key, all, bodyHeight);
    const empty = agent.status === "starting" ? `${spinner()} starting…` : "(nothing yet)";
    const body = rendered ?? (all.length === 0 ? [theme.fg("dim", empty)] : view.lines);
    // The views as tabs: the one shown bright, the other dim (←/→ switch); then where you are in it.
    const tab = (label: string, current: boolean) =>
      current ? theme.fg(focused ? "accent" : "text", theme.bold(label)) : theme.fg("dim", label);
    const tabs = asking
      ? tab("answer", true)
      : selected
        ? tab(`${selected.id} chat`, true)
        : agent.plan !== undefined
          ? `${tab("plan", this.showsPlan(agent))}  ${tab("chat", !this.showsPlan(agent))}`
          : tab("chat", true);
    const page = rendered ? renders?.position?.(agent.id) : undefined;
    const position = rendered
      ? page && page.total > page.last - page.first + 1
        ? theme.fg("dim", `${page.first}–${page.last}/${page.total}`)
        : ""
      : renderFailure
        ? theme.fg("dim", truncateToWidth(`not rendered: ${renderFailure}`, Math.max(10, width - 24)))
        : view.below > 0 || view.start > 0
          ? theme.fg("dim", `${view.start + 1}–${view.start + view.lines.length}/${all.length}`)
          : "";
    return [
      head,
      ...subagents,
      ...padLines(body, bodyHeight),
      ...question,
      labeledRule(theme, width, tabs, position, color),
      ...inputLines.map((line) => truncateToWidth(line, width)),
    ];
  }

  /**
   * The subagent rows under a lane's title: while you look at one, a window of all of them around it
   * (the one you are on highlighted); otherwise the ones still running. A pane too short for them
   * (the merger, collapsed) leaves the running ones out.
   */
  private subagentLines(agent: LaneAgent, selected: SubagentView | undefined, width: number, rows: number) {
    const theme = this.theme;
    const subs = agent.subagents.agents;
    const line = (sub: SubagentView, current: boolean) => {
      const running = sub.stats.state === "running" || sub.stats.state === "starting";
      const state = running ? (sub.stats.lastActivity ?? "starting") : sub.stats.state;
      const text = truncateToWidth(
        `${current ? theme.fg("accent", "› ") : "  "}${subIcon(theme, sub)} ${sub.id} ${sub.label} · ${sub.model} · ${state}`,
        width,
      );
      return current ? selectedRow(theme, width, text) : theme.fg("dim", text);
    };
    if (selected) {
      const index = subs.indexOf(selected);
      const start = Math.max(0, Math.min(index - 1, subs.length - MAX_SUBAGENT_LINES));
      return subs.slice(start, start + MAX_SUBAGENT_LINES).map((sub) => line(sub, sub === selected));
    }
    if (rows < 10) return [];
    return subs
      .filter((sub) => sub.stats.state === "running" || sub.stats.state === "starting")
      .slice(0, MAX_SUBAGENT_LINES)
      .map((sub) => line(sub, false));
  }

  /**
   * One live row per planner (and M once it is there): its state, model, how long its turn has run,
   * and the tools, subagent tasks, tokens and cost it has used so far.
   */
  private statsLines(width: number): string[] {
    const theme = this.theme;
    const rows = this.everyone();
    const merger = this.merger();
    if (rows.length === 0) return [];
    const now = Date.now();
    const count = (value: number, one: string, many: string) => (value ? `${value} ${value === 1 ? one : many}` : "");
    const table = renderTable(
      theme,
      rows,
      [
        {
          header: "",
          get: (agent) =>
            `${this.stateIcon(agent)} ${theme.bold(agent.id)} ${theme.fg("muted", `${agent === merger ? "main agent · " : ""}${agent.name}${agent.spec.thinkingLevel ? ` ${agent.spec.thinkingLevel}` : ""}`)}`,
          flex: true,
          min: 12,
        },
        {
          header: "",
          get: (agent) => formatDuration((agent.stats.endedAt ?? now) - agent.stats.startedAt),
          align: "right",
        },
        { header: "", get: (agent) => count(agent.stats.toolCalls, "tool", "tools"), align: "right" },
        {
          header: "",
          get: (agent) => count(agent.stats.subagentTasks, "subagent", "subagents"),
          align: "right",
        },
        {
          header: "",
          get: (agent) => (agent.stats.totalTokens ? `${formatTokens(agent.stats.totalTokens)} tok` : ""),
          align: "right",
        },
        {
          header: "",
          get: (agent) => (agent.stats.costUsd ? formatCost(agent.stats.costUsd) : ""),
          align: "right",
        },
        { header: "", get: (agent) => this.activity(agent), flex: true, min: 10 },
      ],
      Math.max(20, width - 1),
    );
    return table.lines.map((line) => truncateToWidth(` ${line}`, width));
  }

  private stateIcon(agent: LaneAgent) {
    const theme = this.theme;
    switch (agent.status) {
      case "starting":
      case "working":
        return theme.fg("accent", spinner());
      case "asking":
        return theme.fg("warning", "?");
      case "idle":
        return agent.plan ? theme.fg("success", "✓") : theme.fg("muted", "·");
      case "failed":
        return theme.fg("error", "✗");
      default:
        return theme.fg("dim", "–");
    }
  }

  /** What an agent is doing right now, in a few words. */
  private activity(agent: LaneAgent) {
    const theme = this.theme;
    switch (agent.status) {
      case "starting":
        return theme.fg("dim", "starting");
      case "working":
        return agent.stats.wrappingUp
          ? theme.fg("warning", "wrapping up")
          : theme.fg("dim", agent.stats.lastActivity ?? "working");
      case "asking":
        return theme.fg("warning", "asking you");
      case "idle":
        return agent.plan
          ? theme.fg("success", `plan ready${agent.revision > 1 ? ` (v${agent.revision})` : ""}`)
          : theme.fg("muted", "waiting for you");
      case "failed":
        return theme.fg("error", `failed${agent.error ? `: ${agent.error}` : ""}`);
      default:
        return theme.fg("dim", "stopped");
    }
  }

  private status(agent: LaneAgent) {
    const theme = this.theme;
    const elapsed = formatDuration((agent.stats.endedAt ?? Date.now()) - agent.stats.startedAt);
    const parts: string[] = [];
    switch (agent.status) {
      case "starting":
        parts.push(`${theme.fg("accent", spinner())} starting`);
        break;
      case "working":
        parts.push(
          `${theme.fg("accent", spinner())} ${agent.stats.wrappingUp ? theme.fg("warning", "wrapping up") : truncateToWidth(agent.stats.lastActivity ?? "working", 28, "…")}`,
        );
        break;
      case "asking":
        parts.push(theme.fg("warning", "? asking you"));
        break;
      case "idle":
        parts.push(agent.plan ? theme.fg("success", "✓ plan ready") : theme.fg("muted", "waiting for you"));
        break;
      case "failed":
        parts.push(theme.fg("error", "✗ failed"));
        break;
      default:
        parts.push(theme.fg("dim", "stopped"));
    }
    parts.push(theme.fg("dim", elapsed));
    if (agent.stats.costUsd) parts.push(theme.fg("dim", formatCost(agent.stats.costUsd)));
    return parts.join(theme.fg("dim", " · "));
  }

  /**
   * A planner's current question, laid out like the ask_user_question dialog: the question in bold,
   * then numbered options with their descriptions beneath, every line wrapped (never cut). When the
   * lane is too short for all of it, only the highlighted option keeps its description, and past
   * that the block is cut to `max` lines.
   */
  private questionLines(agent: LaneAgent, width: number, max: number): string[] {
    const pending = agent.pending;
    if (!pending) return [];
    const theme = this.theme;
    const cursor = this.questionCursor(agent);
    const question = pending.questions[cursor.question];
    if (!question) return [];
    const count = pending.questions.length > 1 ? ` (${cursor.question + 1}/${pending.questions.length})` : "";
    // One mark per question: answered, current, still to go.
    const progress =
      pending.questions.length > 1
        ? pending.questions
            .map((_question, index) =>
              index === cursor.question
                ? theme.fg("warning", "◉")
                : cursor.answers[index]
                  ? theme.fg("success", "●")
                  : theme.fg("dim", "○"),
            )
            .join("")
        : "";
    const earlier = cursor.answers[cursor.question];
    const rows = this.questionRows(question, cursor);
    const build = (descriptions: "all" | "focused") => {
      const lines = [
        labeledRule(theme, width, theme.fg("warning", theme.bold(`? ${question.header}${count}`)), progress, "warning"),
        ...hang(" ", theme.bold(question.question), width),
      ];
      rows.forEach((row, index) => {
        const focused = index === cursor.option;
        const chosen = row.kind === "option" && !earlier?.wasCustom && earlier?.optionIndex === row.index + 1;
        const prefix = ` ${focused ? theme.fg("accent", "❯") : " "} ${theme.fg(focused ? "accent" : "muted", `${index + 1}.`)} `;
        const tone = focused ? "accent" : row.kind === "option" || row.kind === "earlier" ? "text" : "muted";
        const label = theme.fg(tone, focused ? theme.bold(row.label) : row.label);
        lines.push(...hang(prefix, `${label}${chosen ? theme.fg("success", " ✓") : ""}`, width));
        if (row.description && (descriptions === "all" || focused)) {
          lines.push(...hang(" ".repeat(visibleWidth(prefix)), theme.fg("muted", row.description), width));
        }
      });
      return lines;
    };
    const full = build("all");
    if (full.length <= max) return full;
    return build("focused").slice(0, Math.max(1, max));
  }

  private footer(width: number, target: Target): string[] {
    const theme = this.theme;
    const actions = this.options.actions();
    if (this.actionIndex >= actions.length) this.actionIndex = 0;
    const onBar = target.kind === "actions";
    const bar = actions.map((action, index) => {
      const label = ` ${action.label} `;
      return onBar && index === this.actionIndex
        ? theme.bg("selectedBg", theme.fg("accent", theme.bold(label)))
        : theme.fg(onBar ? "text" : "muted", label);
    });
    const barLine = actions.length
      ? ` ${bar.join(theme.fg("dim", "·"))}`
      : theme.fg("dim", "  Actions appear once a plan is in.");
    const current = onBar ? actions[this.actionIndex] : undefined;
    const lines = [rule(theme, width, onBar ? "borderAccent" : "borderMuted"), truncateToWidth(barLine, width)];
    if (this.modal?.kind === "escape") {
      const choices = this.escapeChoices();
      const modal = this.modal;
      const row = choices
        .map((choice, index) =>
          index === modal.choice
            ? theme.bg("selectedBg", theme.fg("accent", theme.bold(` ${choice.label} `)))
            : ` ${choice.label} `,
        )
        .join(theme.fg("dim", "·"));
      lines.push(truncateToWidth(` ${theme.fg("warning", "Leave planning?")}  ${row}`, width));
      lines.push(
        hintLine(theme, width, [
          { key: "⏎", label: "choose", primary: true },
          { key: "←→", label: "move" },
          { key: "esc", label: "back" },
        ]),
      );
      return lines;
    }
    lines.push(truncateToWidth(` ${theme.fg("muted", current?.description ?? this.laneHint(target))}`, width));
    lines.push(hintLine(theme, width, this.hints(target)));
    return lines;
  }

  private laneHint(target: Target) {
    if (target.kind === "actions") return "";
    const merger = target.kind === "merger";
    const agent = target.agent;
    const typed = this.input(agent).getValue();
    if (typed.startsWith("/") && !typed.startsWith("//") && !agent.pending) {
      if (merger)
        return "⏎ puts this command in your session's editor (M is your main session); // sends a slash message.";
      const found = matchingCommands(typed);
      return found.length === 0
        ? "No such command. /help lists them; // sends a message that starts with a slash."
        : found
            .map((command) => `/${command.name}${command.args ? ` ${command.args}` : ""}: ${command.description}`)
            .join(" · ");
    }
    const sub = this.selectedSub(agent);
    if (sub) {
      return `Subagent ${sub.id} of ${agent.id}, on ${sub.model}. ^n/^p other subagents · esc back to ${agent.id} · typing talks to ${agent.id}.`;
    }
    if (this.asking(agent) && agent.pending) {
      if (this.questionCursor(agent).composing)
        return `Your answer to ${agent.id}: ⏎ saves it, esc goes back to the options.`;
      const several = agent.pending.questions.length > 1;
      return `${agent.id} is asking you: pick an answer and press ⏎, or type one on ${TYPE_SOMETHING}${several ? " ←→ move between its questions." : ""}`;
    }
    if (agent.working) return `${agent.id} is working. Type to steer it; it reads your message after its current step.`;
    if (agent.status === "failed") {
      return `${agent.id} failed. Type a message to have it try again, or Tab to the actions (a login problem has its own).`;
    }
    if (merger && agent.plan) {
      return "M's merged plan is ready. Talk to M and choose Revise plan M to change it; Tab to the actions to implement it.";
    }
    if (merger) return "Talk the plans over with M; when you are ready, Tab to the actions and choose Write plan M.";
    const m = this.merger();
    if (agent.plan && m && m.plan === undefined && !m.working) {
      return `${agent.id}'s plan is ready. Both plans are in: Tab to M to talk them over, or Tab to the actions and Write plan M.`;
    }
    if (agent.plan) return `${agent.id}'s plan is ready. Talk to it to change it; Tab to the actions to implement it.`;
    return `${agent.id} is waiting for you. Type a message and press ⏎.`;
  }

  private hints(target: Target): Hint[] {
    const panes = this.targets().length - 1;
    if (target.kind === "actions") {
      return [
        { key: "⏎", label: "do it", primary: true },
        { key: "←→", label: "choose" },
        { key: "tab", label: panes > 1 ? "panes" : "lane" },
        { key: "esc", label: "leave" },
      ];
    }
    const agent = target.agent;
    const merger = target.kind === "merger";
    const sub = this.selectedSub(agent);
    const onChat = !this.showsPlan(agent) && !sub;
    if (this.asking(agent) && agent.pending) {
      if (this.questionCursor(agent).composing) {
        return [
          { key: "⏎", label: "save answer", primary: true },
          { key: "esc", label: "options" },
          { key: "tab", label: panes > 1 ? "next pane" : "actions" },
        ];
      }
      return [
        { key: "⏎", label: "answer", primary: true },
        { key: "↑↓ j/k", label: "pick" },
        { key: "1-9", label: "jump" },
        ...(agent.pending.questions.length > 1 ? [{ key: "←→", label: "question" }] : []),
        { key: "^u/^d", label: "chat" },
        { key: "tab", label: panes > 1 ? "next pane" : "actions" },
        { key: "esc", label: "leave" },
      ];
    }
    return [
      { key: "⏎", label: "send", primary: true },
      { key: "↑↓", label: "scroll" },
      ...(agent.plan !== undefined ? [{ key: "←→", label: this.showsPlan(agent) ? "chat" : "plan" }] : []),
      { key: "^u/^d", label: "page" },
      ...(agent.subagents.agents.length > 0 ? [{ key: "^n/^p", label: sub ? "subagent" : "subagents" }] : []),
      ...(onChat
        ? [
            { key: "^o", label: "tools" },
            { key: "^t", label: "thinking" },
          ]
        : []),
      ...(merger && this.options.mergerShare ? [{ key: "⇧↑↓", label: "resize" }] : []),
      { key: "tab", label: panes > 1 ? "next pane" : "actions" },
      { key: "esc", label: sub ? `back to ${agent.id}` : "leave" },
    ];
  }
}

/** A plain character typed, from a legacy or a kitty-protocol terminal. */
function printable(data: string): string | undefined {
  if (data.length === 1) return data;
  return decodeKittyPrintable(data);
}

/** Typed text or a paste: what starts an answer of your own on Type something. */
function isTextInput(data: string): boolean {
  if (data.startsWith("\x1b[200~")) return true;
  const text = printable(data) ?? data;
  const control = [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
  return text.length > 0 && !control && text !== " ";
}

/** `text` wrapped after `prefix`, continuation lines indented to line up under it. */
function hang(prefix: string, text: string, width: number): string[] {
  const indent = visibleWidth(prefix);
  if (indent >= width - 4) return wrap(prefix + text, width);
  return wrap(text, width - indent).map((line, index) => (index === 0 ? prefix : " ".repeat(indent)) + line);
}

function subIcon(theme: Theme, sub: SubagentView) {
  switch (sub.stats.state) {
    case "starting":
    case "running":
      return theme.fg("accent", spinner());
    case "done":
      return theme.fg("success", "✓");
    case "failed":
    case "timeout":
      return theme.fg("error", "✗");
    default:
      return theme.fg("dim", "–");
  }
}

export { effortText };
