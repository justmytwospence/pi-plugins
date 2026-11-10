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
export const EDIT = "Edit the plan";
export const SAVE = "Save for later";
export const KEEP = "No, keep planning";
export const APPROVAL_QUESTION = "Implement this plan?";
export const APPROVAL_HINT = "↑↓ navigate  enter select  escape/ctrl+c cancel";

function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
}

/** The label of the row that implements on a plan model pair's worker, e.g. `Yes, implement with Sonnet 5.5`. */
export function pairLabel(workerName: string, compact = false): string {
  return `Yes, ${compact ? "compact and " : ""}implement with ${clean(workerName)
    .trim()
    .replace(/^Claude /u, "")}`;
}

export type ApprovalChoice =
  | { kind: "here"; withPair?: true }
  | { kind: "compact-here"; withPair?: true }
  | { kind: "edit" }
  | { kind: "save" }
  | { kind: "keep" };

export interface ApprovalInput {
  /** The model whose effort the approval sets: the session model, or a plan pair's worker. */
  planning?: ModelSpec;
  recommendations?: ReadonlyMap<string, ModelSpecThinkingLevel>;
  recommendedThinkingLevel?: ModelSpecThinkingLevel;
  effortDefaultKey?: string;
  /** A sentence after the question, e.g. who implements and who answers its questions. */
  note?: string;
  /** A plan model pair's worker to offer: its rows switch the session to the pair, then implement. */
  alternate?: { model: ModelSpec; name: string };
}

export interface ApprovalResult {
  choice: ApprovalChoice;
  thinkingLevel?: ModelSpecThinkingLevel;
  effortSource: EffortSource;
}

/** Keep this object for one approval, including returns from Edit; not across approvals. */
export interface ApprovalState {
  selectedId: string;
  efforts: Map<string, ModelSpecThinkingLevel | undefined>;
  manuallyAdjusted: Set<string>;
  sources: Map<string, EffortSource>;
  effortDefaultKey?: string;
}

export function createApprovalState(): ApprovalState {
  return {
    selectedId: "here",
    efforts: new Map(),
    manuallyAdjusted: new Set(),
    sources: new Map(),
  };
}

const modelId = (spec: ModelSpec) => JSON.stringify([spec.provider, spec.modelId]);
type Row = { id: string; choice: ApprovalChoice; label: string; model?: ModelSpec };
const effortId = (row: Row) => (row.model ? modelId(row.model) : "");
type Catalog = Pick<ReturnType<typeof modelCatalog>, "efforts">;

function recommendedFor(input: ApprovalInput, model: ModelSpec | undefined): ModelSpecThinkingLevel | undefined {
  return (model && input.recommendations?.get(formatModelKey(model))) ?? input.recommendedThinkingLevel;
}

function initialEffort(input: ApprovalInput, model: ModelSpec | undefined): ModelSpecThinkingLevel | undefined {
  return recommendedFor(input, model) ?? model?.thinkingLevel ?? input.planning?.thinkingLevel;
}

/** A single inline Pi-layout component, also exported for remote-client rendering fixtures. */
export class ApprovalPicker implements Component {
  private readonly rows: [Row, ...Row[]];
  private readonly question: string;
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
    this.question = `${APPROVAL_QUESTION}${input.note ? ` ${clean(input.note)}` : ""}`;
    const alternate = input.alternate;
    this.rows = [
      { id: "here", choice: { kind: "here" }, label: HERE, model: input.planning },
      ...(alternate
        ? [
            {
              id: "pair",
              choice: { kind: "here", withPair: true } as const,
              label: pairLabel(alternate.name),
              model: alternate.model,
            },
          ]
        : []),
      { id: "compact-here", choice: { kind: "compact-here" }, label: COMPACT_HERE, model: input.planning },
      ...(alternate
        ? [
            {
              id: "compact-pair",
              choice: { kind: "compact-here", withPair: true } as const,
              label: pairLabel(alternate.name, true),
              model: alternate.model,
            },
          ]
        : []),
      { id: "edit", choice: { kind: "edit" }, label: EDIT },
      { id: "save", choice: { kind: "save" }, label: SAVE },
      { id: "keep", choice: { kind: "keep" }, label: KEEP },
    ];
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
    for (const row of this.rows) {
      if (!row.model) continue;
      const id = effortId(row);
      const levels = this.levels(row);
      state.efforts.set(
        id,
        normalizeEffort(state.efforts.has(id) ? state.efforts.get(id) : initialEffort(input, row.model), levels),
      );
      if (!state.manuallyAdjusted.has(id) && !state.sources.has(id)) {
        state.sources.set(id, recommendedFor(input, row.model) !== undefined ? "system1" : "fallback");
      }
    }
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }

  private levels(row: Row): ModelSpecThinkingLevel[] {
    return row.model ? this.catalog.efforts(row.model).filter((level) => level !== undefined) : [];
  }

  private get selected(): Row {
    return this.rows.find((row) => row.id === this.state.selectedId) ?? this.rows[0];
  }

  private effort(row: Row) {
    return row.model ? this.state.efforts.get(effortId(row)) : undefined;
  }

  private result(row: Row): ApprovalResult {
    const thinkingLevel = this.effort(row);
    return {
      choice: row.choice,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      effortSource: this.state.manuallyAdjusted.has(effortId(row))
        ? "manual"
        : (this.state.sources.get(effortId(row)) ?? "fallback"),
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
    const effort =
      row.choice.kind === "edit" || row.choice.kind === "save" || row.choice.kind === "keep"
        ? "Select an implementation choice to adjust effort"
        : !this.levels(row).length
          ? "Effort: not supported"
          : `←/→ effort: ${this.effort(row) ?? "default"}`;
    const rule = this.theme.fg("border", "─".repeat(Math.max(0, width)));
    const contentWidth = Math.max(1, width - 2);
    // A separate arrow-prefixed effort row looks like an option to Collie's screen reader.
    const question = wrapTextWithAnsi(`${this.question} ${effort}`, contentWidth).map(
      (line) => ` ${this.theme.fg("accent", this.theme.bold(line))}`,
    );
    return [
      rule,
      "",
      ...question,
      "",
      ...this.rows.map((option) => {
        const label = truncateToWidth(option.label, Math.min(OPTION_MAX, Math.max(0, width - 4)), "…");
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
    const rows = this.rows;
    const index = rows.findIndex((item) => item.id === row.id);
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      matchesKey(data, "ctrl+c") ||
      matchesKey(data, "escape")
    ) {
      this.finish(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.finish(this.result(row));
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.state.selectedId = rows[(index - 1 + rows.length) % rows.length]?.id ?? row.id;
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.state.selectedId = rows[(index + 1) % rows.length]?.id ?? row.id;
    } else if (matchesKey(data, "left") || matchesKey(data, "right")) {
      const levels = this.levels(row);
      if (!row.model || !levels.length) return;
      const current = levels.indexOf(this.effort(row) as ModelSpecThinkingLevel);
      const next =
        current < 0
          ? matchesKey(data, "right")
            ? 0
            : levels.length - 1
          : (current + (matchesKey(data, "right") ? 1 : -1) + levels.length) % levels.length;
      if (levels[next] !== this.effort(row)) {
        this.state.efforts.set(effortId(row), levels[next]);
        this.state.manuallyAdjusted.add(effortId(row));
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
      const rows = this.rows;
      const currentLabels = rows.map((row) => row.label);
      const labels = currentLabels.map((label, index) =>
        currentLabels.some((other, otherIndex) => otherIndex !== index && other === label)
          ? `${truncateToWidth(label, OPTION_MAX - String(index + 1).length - 3, "…")} [${index + 1}]`
          : label,
      );
      const selectedIndex = rows.findIndex((row) => row.id === this.selected.id);
      const currentLabel = labels[selectedIndex] as string;
      const actions = [currentLabel, ...labels.filter((label) => label !== currentLabel)];
      const selected = await ui.select(this.question, actions, { signal: this.signal });
      if (this.signal?.aborted) return undefined;
      if (selected === undefined) return undefined;
      const row = rows[labels.indexOf(selected)];
      if (!row) return undefined;
      this.state.selectedId = row.id;
      const levels = this.levels(row);
      if (row.model && levels.length) {
        const current = this.effort(row);
        const options = [current ?? "Model default", ...levels.filter((level) => level !== current)];
        const selectedEffort = await ui.select("Implementation effort", options, { signal: this.signal });
        if (this.signal?.aborted) return undefined;
        if (selectedEffort === undefined) continue;
        if (!options.includes(selectedEffort)) return undefined;
        this.state.efforts.set(
          effortId(row),
          selectedEffort === "Model default" ? undefined : (selectedEffort as ModelSpecThinkingLevel),
        );
        if ((selectedEffort === "Model default" ? undefined : selectedEffort) !== current)
          this.state.manuallyAdjusted.add(effortId(row));
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
