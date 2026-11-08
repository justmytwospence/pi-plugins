import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type KeybindingsManager,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { FlowState } from "./flow-contract.js";
import type { EffortSource } from "./implementation-effort.js";
import { formatModelKey, type ModelSpec, type ModelSpecThinkingLevel } from "./implementation-models.js";
import { modelCatalog, normalizeEffort } from "./model-catalog.js";
import { type RemoteUi, raceRemote } from "./switchyard-remote.js";

/** Pi 1.5's `blocked` option for inline `ctx.ui.custom()` (OSC 7501 program status). The 1.2.0 types here lack it, hence the cast; older Pi ignores it. */
const blockedOn = (kind: "question" | "permission" | "auth", message: string) =>
  ({ blocked: { kind, message } }) as never;

export const OPTION_MAX = 42;
export const HERE = "Yes, implement here";
export const COMPACT_HERE = "Yes, compact plan and implement here";
export const LINKED_EXECUTE = "Execute with linked worker";
export const LINKED_COMPACT = "Compact first, then execute";
export const LINKED_FRESH = "Execute in a fresh conversation";
export const APPROVE = "Approve and implement";
export const CONTEXT_KEEP = "Keep history";
export const CONTEXT_COMPACT = "Compact to approved plan";
export const CONTEXT_FRESH = "Fresh conversation";
export const EDIT = "Edit the plan";
export const SAVE = "Save for later";
export const KEEP = "No, keep planning";
export const APPROVAL_QUESTION = "Implement this plan?";
export const APPROVAL_HINT = "↑↓ navigate  enter select  escape/ctrl+c cancel";

function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
}

export function handoffLabel(name: string, effort?: string): string {
  const label = `Yes, hand off to ${clean(name)}`;
  const full = effort ? `${label} (${effort})` : label;
  return truncateToWidth(full, OPTION_MAX, "…") === full ? full : truncateToWidth(label, OPTION_MAX, "…");
}

export type ApprovalChoice =
  | { kind: "here" }
  | { kind: "compact-here" }
  | {
      kind: "handoff";
      target: ModelSpec;
      targetName: string;
      intent?: "independent" | "linked-execution";
      flow?: FlowState;
      context?: "keep" | "compact" | "clear";
    }
  | { kind: "edit" }
  | { kind: "save" }
  | { kind: "keep" };

export interface ApprovalInput {
  planning?: ModelSpec;
  targets: Array<{ target: ModelSpec; targetName: string; thinkingPinned?: true }>;
  recommendations?: ReadonlyMap<string, ModelSpecThinkingLevel>;
  defaultThinkingLevel?: ModelSpecThinkingLevel;
  recommendedThinkingLevel?: ModelSpecThinkingLevel;
  effortDefaultKey?: string;
  intent?: "independent" | "linked-execution";
  flow?: FlowState;
  /** Only advertised when the optional approved-plan host handoff is available. */
  freshTarget?: { target: ModelSpec; targetName: string };
  contextNote?: string;
}

export interface ApprovalResult {
  choice: ApprovalChoice;
  thinkingLevel?: ModelSpecThinkingLevel;
  effortSource: EffortSource;
}

/** Keep this object for one approval, including returns from Edit; not across approvals. */
export interface ApprovalState {
  selectedId: string;
  context: "keep" | "compact" | "clear";
  stage: "main" | "context";
  efforts: Map<string, ModelSpecThinkingLevel | undefined>;
  manuallyAdjusted: Set<string>;
  sources: Map<string, EffortSource>;
  effortDefaultKey?: string;
}

export function createApprovalState(): ApprovalState {
  return {
    selectedId: "here",
    context: "keep",
    stage: "main",
    efforts: new Map(),
    manuallyAdjusted: new Set(),
    sources: new Map(),
  };
}

const modelId = (spec: ModelSpec) => JSON.stringify([spec.provider, spec.modelId]);
type Row = { id: string; choice: ApprovalChoice; label: string; model?: ModelSpec };
// Fresh has its own default and manual overrides; edits must not change in-place effort.
const effortId = (row: Row) =>
  `${row.choice.kind === "handoff" && row.choice.context === "clear" ? "fresh:" : ""}${row.model ? modelId(row.model) : ""}`;
type Catalog = Pick<ReturnType<typeof modelCatalog>, "efforts">;

function initialEffort(row: Row, input: ApprovalInput, linked: boolean): ModelSpecThinkingLevel | undefined {
  const pinned =
    row.model && input.targets.some((entry) => entry.thinkingPinned && modelId(entry.target) === modelId(row.model!));
  if (pinned) return row.model?.thinkingLevel;
  const recommended =
    (row.model && input.recommendations?.get(formatModelKey(row.model))) ?? input.recommendedThinkingLevel;
  if (row.choice.kind !== "handoff") return recommended ?? input.planning?.thinkingLevel;
  if (!linked) return row.model?.thinkingLevel ?? input.defaultThinkingLevel ?? recommended ?? "medium";
  return recommended ?? row.model?.thinkingLevel ?? input.defaultThinkingLevel ?? "medium";
}

/** A single inline Pi-layout component, also exported for remote-client rendering fixtures. */
export class ApprovalPicker implements Component {
  private readonly rows: [Row, ...Row[]];
  private readonly question: string;
  private readonly linked: boolean;
  private readonly linkedRows: Row[];
  private contextSelected = "keep";
  private finished = false;
  private readonly onAbort = () => this.finish(undefined);

  constructor(
    input: ApprovalInput,
    private readonly state: ApprovalState,
    private readonly catalog: Catalog,
    private readonly theme: Theme,
    private readonly keybindings: Pick<KeybindingsManager, "matches">,
    private readonly requestRender: () => void,
    private readonly done: (result: ApprovalResult | undefined) => void,
    private readonly signal?: AbortSignal,
  ) {
    const linked = input.intent === "linked-execution";
    this.linked = linked;
    if (state.context === "clear" && !input.freshTarget) state.context = "keep";
    state.stage = "main";
    const worker = linked ? input.targets[0] : undefined;
    this.question = APPROVAL_QUESTION;
    if (linked && input.contextNote) this.question += ` ${clean(input.contextNote)}`;
    this.linkedRows = linked
      ? worker
        ? (["keep", "compact", ...(input.freshTarget ? ["clear" as const] : [])] as const).map((context) => ({
            id: `linked:${context}:${modelId(worker.target)}`,
            choice: {
              kind: "handoff",
              ...(context === "clear" ? (input.freshTarget ?? worker) : worker),
              intent: "linked-execution",
              ...(input.flow ? { flow: structuredClone(input.flow) } : {}),
              context,
            },
            label: context === "keep" ? LINKED_EXECUTE : context === "compact" ? LINKED_COMPACT : LINKED_FRESH,
            model: context === "clear" ? input.freshTarget?.target : worker.target,
          }))
        : []
      : [];
    const executionRows: Row[] = linked
      ? this.linkedRows.length
        ? [this.linkedRows[0] as Row, { id: "context", choice: { kind: "keep" }, label: "" }]
        : []
      : [
          { id: "here", choice: { kind: "here" }, label: HERE, model: input.planning },
          { id: "compact-here", choice: { kind: "compact-here" }, label: COMPACT_HERE, model: input.planning },
          ...input.targets.map(({ target, targetName }) => ({
            id: `handoff:${modelId(target)}`,
            choice: { kind: "handoff" as const, target, targetName },
            label: handoffLabel(targetName),
            model: target,
          })),
        ];
    const remainingRows: [Row, ...Row[]] = [
      { id: "edit", choice: { kind: "edit" }, label: EDIT },
      { id: "save", choice: { kind: "save" }, label: SAVE },
      { id: "keep", choice: { kind: "keep" }, label: KEEP },
    ];
    this.rows = [...executionRows, ...remainingRows] as [Row, ...Row[]];
    if (!this.rows.some((row) => row.id === state.selectedId)) state.selectedId = this.rows[0].id;
    if (input.effortDefaultKey !== undefined && input.effortDefaultKey !== state.effortDefaultKey) {
      for (const id of state.efforts.keys()) {
        if (!state.manuallyAdjusted.has(id)) {
          state.efforts.delete(id);
          state.sources.delete(id);
        }
      }
      state.effortDefaultKey = input.effortDefaultKey;
    }
    for (const row of linked ? this.linkedRows : this.rows) {
      if (!row.model) continue;
      const id = effortId(row);
      const levels = this.levels(row);
      const initial = initialEffort(row, input, linked);
      state.efforts.set(id, normalizeEffort(state.efforts.has(id) ? state.efforts.get(id) : initial, levels));
      if (!state.manuallyAdjusted.has(id)) {
        const pinned = input.targets.some(
          (entry) => entry.thinkingPinned && modelId(entry.target) === modelId(row.model!),
        );
        const recommended =
          input.recommendations?.has(formatModelKey(row.model)) || input.recommendedThinkingLevel !== undefined;
        const configured =
          row.choice.kind === "handoff" &&
          !linked &&
          (row.model.thinkingLevel !== undefined || input.defaultThinkingLevel !== undefined);
        if (!state.sources.has(id))
          state.sources.set(id, pinned || configured ? "configured" : recommended ? "system1" : "fallback");
      }
    }
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }

  private levels(row: Row): ModelSpecThinkingLevel[] {
    return row.model ? this.catalog.efforts(row.model).filter((level) => level !== undefined) : [];
  }

  private get activeWorker(): Row | undefined {
    return this.linkedRows.find((row) => row.choice.kind === "handoff" && row.choice.context === this.state.context);
  }

  private get currentRows(): [Row, ...Row[]] {
    if (this.linked && this.state.stage === "context") {
      const ordered = [
        this.state.context,
        ...(["keep", "compact", "clear"] as const).filter((c) => c !== this.state.context),
      ];
      return ordered
        .filter((c) => this.linkedRows.some((row) => row.choice.kind === "handoff" && row.choice.context === c))
        .map((c) => ({
          id: c,
          choice: { kind: "keep" } as ApprovalChoice,
          label: c === "keep" ? CONTEXT_KEEP : c === "compact" ? CONTEXT_COMPACT : CONTEXT_FRESH,
        })) as [Row, ...Row[]];
    }
    return this.rows;
  }

  private get selected(): Row {
    const id = this.state.stage === "context" ? this.contextSelected : this.state.selectedId;
    return this.currentRows.find((row) => row.id === id) ?? this.currentRows[0];
  }

  private effort(row: Row) {
    return row.model ? this.state.efforts.get(effortId(row)) : undefined;
  }

  private get questionWithWorker(): string {
    if (!this.linked) return this.question;
    const worker = this.activeWorker?.model;
    return `${this.question} ${worker ? `Linked worker: ${clean(formatModelKey(worker))}.` : "Linked worker unavailable."}`;
  }

  private label(row: Row): string {
    if (this.linked && this.state.stage === "main") {
      if (row.id === "context")
        return `Context: ${this.state.context === "keep" ? CONTEXT_KEEP : this.state.context === "compact" ? "Compact to plan" : CONTEXT_FRESH}`;
      if (row.choice.kind === "handoff") return APPROVE;
    }
    return row.choice.kind === "handoff" && row.choice.intent !== "linked-execution"
      ? handoffLabel(row.choice.targetName, this.effort(row))
      : row.label;
  }

  private result(row: Row): ApprovalResult {
    const actual = this.linked && row.choice.kind === "handoff" ? (this.activeWorker ?? row) : row;
    const thinkingLevel = this.effort(actual);
    return {
      choice: actual.choice,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      effortSource: this.state.manuallyAdjusted.has(effortId(actual))
        ? "manual"
        : (this.state.sources.get(effortId(actual)) ?? "fallback"),
    };
  }

  private finish(result: ApprovalResult | undefined): void {
    if (this.finished) return;
    this.finished = true;
    this.dispose();
    this.done(result);
  }

  dispose(): void {
    this.signal?.removeEventListener("abort", this.onAbort);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const row = this.selected;
    const effortRow = this.linked ? this.activeWorker : row;
    const effort =
      !this.linked && (row.choice.kind === "edit" || row.choice.kind === "save" || row.choice.kind === "keep")
        ? "Select an implementation choice to adjust effort"
        : !effortRow || !this.levels(effortRow).length
          ? "Effort: not supported"
          : `←/→ effort: ${this.effort(effortRow) ?? "default"}`;
    const rule = this.theme.fg("border", "─".repeat(Math.max(0, width)));
    const contentWidth = Math.max(1, width - 2);
    // A separate arrow-prefixed effort row looks like an option to Collie's screen reader.
    const question = wrapTextWithAnsi(
      `${this.questionWithWorker} ${this.linked ? `Context: ${this.state.context === "keep" ? CONTEXT_KEEP : this.state.context === "compact" ? CONTEXT_COMPACT : CONTEXT_FRESH}. ` : ""}${effort}`,
      contentWidth,
    ).map((line) => ` ${this.theme.fg("accent", this.theme.bold(line))}`);
    return [
      rule,
      "",
      ...question,
      "",
      ...this.currentRows.map((option) => {
        const label = truncateToWidth(this.label(option), Math.min(OPTION_MAX, Math.max(0, width - 4)), "…");
        return ` ${this.theme.fg(option.id === row.id ? "accent" : "text", `${option.id === row.id ? "→" : " "} ${label}`)}`;
      }),
      "",
      ...wrapTextWithAnsi(
        this.theme.fg("dim", "↑↓") +
          this.theme.fg("muted", " navigate") +
          "  " +
          this.theme.fg("dim", "enter") +
          this.theme.fg("muted", " select") +
          "  " +
          this.theme.fg("dim", "escape/ctrl+c") +
          this.theme.fg("muted", " cancel"),
        contentWidth,
      ).map((line) => ` ${line}`),
      "",
      rule,
    ].map((line) => {
      const clipped = truncateToWidth(line, width);
      return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
    });
  }

  handleInput(data: string): void {
    if (this.finished) return;
    const row = this.selected;
    const rows = this.currentRows;
    const index = rows.findIndex((item) => item.id === row.id);
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      matchesKey(data, "ctrl+c") ||
      matchesKey(data, "escape")
    ) {
      if (this.state.stage === "context") {
        this.state.stage = "main";
        this.invalidate();
        this.requestRender();
      } else this.finish(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.state.stage === "context") {
        this.state.context = row.id as ApprovalState["context"];
        this.state.stage = "main";
        this.state.selectedId = this.rows[0].id;
        this.invalidate();
        this.requestRender();
        return;
      }
      if (this.linked && row.id === "context") {
        this.state.stage = "context";
        this.contextSelected = this.state.context;
        this.invalidate();
        this.requestRender();
        return;
      }
      this.finish(this.result(row));
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      const id = rows[(index - 1 + rows.length) % rows.length]?.id ?? row.id;
      if (this.state.stage === "context") this.contextSelected = id;
      else this.state.selectedId = id;
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      const id = rows[(index + 1) % rows.length]?.id ?? row.id;
      if (this.state.stage === "context") this.contextSelected = id;
      else this.state.selectedId = id;
    } else if (matchesKey(data, "left") || matchesKey(data, "right")) {
      if (this.state.stage === "context") return;
      const effortRow = this.linked
        ? row.id === "context" || row.choice.kind === "handoff"
          ? this.activeWorker
          : undefined
        : row;
      if (!effortRow) return;
      const levels = this.levels(effortRow);
      if (!effortRow.model || !levels.length) return;
      const current = levels.indexOf(this.effort(effortRow) as ModelSpecThinkingLevel);
      const next =
        current < 0
          ? matchesKey(data, "right")
            ? 0
            : levels.length - 1
          : (current + (matchesKey(data, "right") ? 1 : -1) + levels.length) % levels.length;
      if (levels[next] !== this.effort(effortRow)) {
        this.state.efforts.set(effortId(effortRow), levels[next]);
        this.state.manuallyAdjusted.add(effortId(effortRow));
      }
    } else {
      return; // The review viewport's independent Ctrl+U/D listener remains in charge.
    }
    this.invalidate();
    this.requestRender();
  }

  /** RPC selects by unique labels, never by a possibly colliding truncated model name. */
  async selectRPC(ui: Pick<ExtensionUIContext, "select">): Promise<ApprovalResult | undefined> {
    while (!this.signal?.aborted) {
      const rows = this.currentRows;
      const currentLabels = rows.map((row) => this.label(row));
      const labels = currentLabels.map((label, index) =>
        currentLabels.some((other, otherIndex) => otherIndex !== index && other === label)
          ? `${truncateToWidth(label, OPTION_MAX - String(index + 1).length - 3, "…")} [${index + 1}]`
          : label,
      );
      const selectedIndex = rows.findIndex((row) => row.id === this.selected.id);
      const currentLabel = labels[selectedIndex] as string;
      const actions = [currentLabel, ...labels.filter((label) => label !== currentLabel)];
      const worker = this.activeWorker;
      const details = this.linked
        ? ` Context: ${this.state.context === "keep" ? CONTEXT_KEEP : this.state.context === "compact" ? CONTEXT_COMPACT : CONTEXT_FRESH}. ${worker && this.levels(worker).length ? `Effort: ${this.effort(worker) ?? "default"}` : "Effort: not supported"}`
        : "";
      const selected = await ui.select(this.questionWithWorker + details, actions, { signal: this.signal });
      if (this.signal?.aborted) return undefined;
      if (selected === undefined) {
        if (this.state.stage === "context") {
          this.state.stage = "main";
          continue;
        }
        return undefined;
      }
      const row = rows[labels.indexOf(selected)];
      if (!row) return undefined;
      if (this.state.stage === "context") {
        this.state.context = row.id as ApprovalState["context"];
        this.state.stage = "main";
        this.state.selectedId = this.rows[0].id;
        continue;
      }
      this.state.selectedId = row.id;
      if (this.linked && row.id === "context") {
        this.state.stage = "context";
        this.contextSelected = this.state.context;
        continue;
      }
      const effortRow = this.linked && row.choice.kind === "handoff" ? (this.activeWorker ?? row) : row;
      const levels = this.levels(effortRow);
      if (effortRow.model && levels.length) {
        const current = this.effort(effortRow);
        const options = [current ?? "Model default", ...levels.filter((level) => level !== current)];
        const selectedEffort = await ui.select("Implementation effort", options, { signal: this.signal });
        if (this.signal?.aborted) return undefined;
        if (selectedEffort === undefined) continue;
        if (!options.includes(selectedEffort)) return undefined;
        this.state.efforts.set(
          effortId(effortRow),
          selectedEffort === "Model default" ? undefined : (selectedEffort as ModelSpecThinkingLevel),
        );
        if ((selectedEffort === "Model default" ? undefined : selectedEffort) !== current)
          this.state.manuallyAdjusted.add(effortId(effortRow));
      }
      return this.result(row);
    }
    return undefined;
  }
}

/** The caller owns the review viewport and holdBlocked lease, including time spent editing. */
export async function pickApproval(
  ctx: ExtensionContext,
  input: ApprovalInput,
  state: ApprovalState,
  signal?: AbortSignal,
  remote?: RemoteUi,
): Promise<(ApprovalResult & { remote?: boolean }) | undefined> {
  if (!ctx.hasUI || signal?.aborted) return undefined;
  const planning =
    input.planning ??
    (ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id, thinkingLevel: ctx.thinkingLevel } : undefined);
  const resolved = {
    ...input,
    planning: planning ? { ...planning, thinkingLevel: planning.thinkingLevel ?? ctx.thinkingLevel } : undefined,
  };
  const catalog = modelCatalog(ctx);
  const components: ApprovalPicker[] = [];
  const terminal = (sig: AbortSignal | undefined) =>
    ctx.ui.custom<ApprovalResult | undefined>(
      (tui, theme, keybindings, done) => {
        const component = new ApprovalPicker(
          resolved,
          state,
          catalog,
          theme,
          keybindings,
          () => tui.requestRender(),
          done,
          sig,
        );
        components.push(component);
        return component;
      },
      blockedOn("question", "Approve the plan"),
    );
  try {
    if (ctx.mode === "tui") {
      if (!remote) return await terminal(signal);
      // Both UIs can be live at once. Never let one side's intermediate stage or
      // context change turn the other side's visible selection into approval.
      const remoteState: ApprovalState = {
        ...state,
        efforts: new Map(state.efforts),
        manuallyAdjusted: new Set(state.manuallyAdjusted),
        sources: new Map(state.sources),
      };
      const { value, from } = await raceRemote<ApprovalResult>(
        (sig) => terminal(sig),
        (sig) => {
          // RPC-style dialogs for the web: rendering and keyboard dependencies are unused.
          const component = new ApprovalPicker(
            resolved,
            remoteState,
            catalog,
            ctx.ui.theme,
            { matches: () => false },
            () => {},
            () => {},
            sig,
          );
          components.push(component);
          return component.selectRPC(remote);
        },
        signal,
      );
      if (value && from === "remote") {
        state.selectedId = remoteState.selectedId;
        state.context = remoteState.context;
        state.stage = remoteState.stage;
        state.efforts = remoteState.efforts;
        state.manuallyAdjusted = remoteState.manuallyAdjusted;
        state.sources = remoteState.sources;
        state.effortDefaultKey = remoteState.effortDefaultKey;
      }
      return value ? { ...value, remote: from === "remote" } : undefined;
    }
    // RPC cannot render custom components. Rendering and keyboard dependencies are unused here.
    const component = new ApprovalPicker(
      resolved,
      state,
      catalog,
      ctx.ui.theme,
      { matches: () => false },
      () => {},
      () => {},
      signal,
    );
    components.push(component);
    return await component.selectRPC(ctx.ui);
  } finally {
    for (const c of components) c.dispose();
  }
}
