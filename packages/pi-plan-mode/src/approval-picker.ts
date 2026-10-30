import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type KeybindingsManager,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ModelSpec, ModelSpecThinkingLevel } from "./implementation-models.js";
import { modelCatalog, normalizeEffort } from "./model-catalog.js";

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

export function handoffLabel(name: string, effort?: string): string {
  const label = `Yes, hand off to ${clean(name)}`;
  const full = effort ? `${label} (${effort})` : label;
  return truncateToWidth(full, OPTION_MAX, "…") === full ? full : truncateToWidth(label, OPTION_MAX, "…");
}

export type ApprovalChoice =
  | { kind: "here" }
  | { kind: "compact-here" }
  | { kind: "handoff"; target: ModelSpec; targetName: string }
  | { kind: "edit" }
  | { kind: "save" }
  | { kind: "keep" };

export interface ApprovalInput {
  planning?: ModelSpec;
  targets: Array<{ target: ModelSpec; targetName: string }>;
  defaultThinkingLevel?: ModelSpecThinkingLevel;
}

export interface ApprovalResult {
  choice: ApprovalChoice;
  thinkingLevel?: ModelSpecThinkingLevel;
}

/** Keep this object for one approval, including returns from Edit; not across approvals. */
export interface ApprovalState {
  selectedId: string;
  efforts: Map<string, ModelSpecThinkingLevel | undefined>;
}

export function createApprovalState(): ApprovalState {
  return { selectedId: "here", efforts: new Map() };
}

const modelId = (spec: ModelSpec) => JSON.stringify([spec.provider, spec.modelId]);
type Row = { id: string; choice: ApprovalChoice; label: string; model?: ModelSpec };
type Catalog = Pick<ReturnType<typeof modelCatalog>, "efforts">;

/** A single inline Pi-layout component, also exported for remote-client rendering fixtures. */
export class ApprovalPicker implements Component {
  private readonly rows: [Row, ...Row[]];
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
    this.rows = [
      { id: "here", choice: { kind: "here" }, label: HERE, model: input.planning },
      { id: "compact-here", choice: { kind: "compact-here" }, label: COMPACT_HERE, model: input.planning },
      ...input.targets.map(({ target, targetName }) => ({
        id: `handoff:${modelId(target)}`,
        choice: { kind: "handoff" as const, target, targetName },
        label: handoffLabel(targetName),
        model: target,
      })),
      { id: "edit", choice: { kind: "edit" }, label: EDIT },
      { id: "save", choice: { kind: "save" }, label: SAVE },
      { id: "keep", choice: { kind: "keep" }, label: KEEP },
    ];
    if (!this.rows.some((row) => row.id === state.selectedId)) state.selectedId = "here";
    for (const row of this.rows) {
      if (!row.model) continue;
      const id = modelId(row.model);
      const levels = this.levels(row);
      const initial =
        row.choice.kind === "handoff"
          ? (row.model.thinkingLevel ?? input.defaultThinkingLevel ?? "medium")
          : input.planning?.thinkingLevel;
      state.efforts.set(id, normalizeEffort(state.efforts.has(id) ? state.efforts.get(id) : initial, levels));
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
    return row.model ? this.state.efforts.get(modelId(row.model)) : undefined;
  }

  private label(row: Row): string {
    return row.choice.kind === "handoff" ? handoffLabel(row.choice.targetName, this.effort(row)) : row.label;
  }

  private result(row: Row): ApprovalResult {
    const thinkingLevel = this.effort(row);
    return { choice: row.choice, ...(thinkingLevel !== undefined ? { thinkingLevel } : {}) };
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
    const question = wrapTextWithAnsi(`${APPROVAL_QUESTION} ${effort}`, contentWidth).map(
      (line) => ` ${this.theme.fg("accent", this.theme.bold(line))}`,
    );
    return [
      rule,
      "",
      ...question,
      "",
      ...this.rows.map((option) => {
        const label = truncateToWidth(this.label(option), Math.min(OPTION_MAX, Math.max(0, width - 4)), "…");
        return ` ${this.theme.fg(option === row ? "accent" : "text", `${option === row ? "→" : " "} ${label}`)}`;
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
    const index = this.rows.indexOf(row);
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
      this.state.selectedId = this.rows[(index - 1 + this.rows.length) % this.rows.length]?.id ?? row.id;
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.state.selectedId = this.rows[(index + 1) % this.rows.length]?.id ?? row.id;
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
      this.state.efforts.set(modelId(row.model), levels[next]);
    } else {
      return; // The review viewport's independent Ctrl+U/D listener remains in charge.
    }
    this.invalidate();
    this.requestRender();
  }

  /** RPC selects by unique labels, never by a possibly colliding truncated model name. */
  async selectRPC(ctx: ExtensionContext): Promise<ApprovalResult | undefined> {
    while (!this.signal?.aborted) {
      const currentLabels = this.rows.map((row) => this.label(row));
      const labels = currentLabels.map((label, index) =>
        currentLabels.some((other, otherIndex) => otherIndex !== index && other === label)
          ? `${truncateToWidth(label, OPTION_MAX - String(index + 1).length - 3, "…")} [${index + 1}]`
          : label,
      );
      // RPC has no initial-selection option; put the retained action first for Enter.
      const currentLabel = labels[this.rows.indexOf(this.selected)] as string;
      const actions = [currentLabel, ...labels.filter((label) => label !== currentLabel)];
      const selected = await ctx.ui.select(APPROVAL_QUESTION, actions, { signal: this.signal });
      if (this.signal?.aborted || selected === undefined) return undefined;
      const row = this.rows[labels.indexOf(selected)];
      if (!row) return undefined;
      this.state.selectedId = row.id;
      const levels = this.levels(row);
      if (row.model && levels.length) {
        const current = this.effort(row);
        const options = [current ?? "Model default", ...levels.filter((level) => level !== current)];
        const selectedEffort = await ctx.ui.select("Implementation effort", options, { signal: this.signal });
        if (this.signal?.aborted) return undefined;
        if (selectedEffort === undefined) continue;
        if (!options.includes(selectedEffort)) return undefined;
        this.state.efforts.set(
          modelId(row.model),
          selectedEffort === "Model default" ? undefined : (selectedEffort as ModelSpecThinkingLevel),
        );
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
): Promise<ApprovalResult | undefined> {
  if (!ctx.hasUI || signal?.aborted) return undefined;
  const planning =
    input.planning ??
    (ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id, thinkingLevel: ctx.thinkingLevel } : undefined);
  const resolved = {
    ...input,
    planning: planning ? { ...planning, thinkingLevel: planning.thinkingLevel ?? ctx.thinkingLevel } : undefined,
  };
  const catalog = modelCatalog(ctx);
  let component: ApprovalPicker | undefined;
  try {
    if (ctx.mode === "tui") {
      return await ctx.ui.custom<ApprovalResult | undefined>((tui, theme, keybindings, done) => {
        component = new ApprovalPicker(
          resolved,
          state,
          catalog,
          theme,
          keybindings,
          () => tui.requestRender(),
          done,
          signal,
        );
        return component;
      });
    }
    // RPC cannot render custom components. Rendering and keyboard dependencies are unused here.
    component = new ApprovalPicker(
      resolved,
      state,
      catalog,
      ctx.ui.theme,
      { matches: () => false },
      () => {},
      () => {},
      signal,
    );
    return await component.selectRPC(ctx);
  } finally {
    component?.dispose();
  }
}
