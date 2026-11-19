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
import type { EffortSource } from "./implementation-effort.ts";
import {
  formatModelKey,
  type ImplementationContextChoice,
  type ModelSpec,
  type ModelSpecThinkingLevel,
} from "./implementation-models.ts";
import { modelCatalog, normalizeEffort } from "./model-catalog.ts";
import { type RemoteUi, raceRemote } from "./switchyard-remote.ts";

/** Pi 1.5's `blocked` option for inline `ctx.ui.custom()` (OSC 7501 program status). The 1.2.0 types here lack it, hence the cast; older Pi ignores it. */
const blockedOn = (kind: "question" | "permission" | "auth", message: string) =>
  ({ blocked: { kind, message } }) as never;

export const OPTION_MAX = 42;
/** The terminal dialog's one implement action; model, effort and context are settings above it. */
export const IMPLEMENT = "Yes, implement";
export const HERE = "Yes, implement here";
export const COMPACT_HERE = "Yes, compact plan and implement here";
export const EDIT = "Edit the plan";
export const SAVE = "Save for later";
export const KEEP = "No, keep planning";
export const APPROVAL_QUESTION = "Implement this plan?";
export const APPROVAL_HINT = "↑↓ navigate  enter select  escape/ctrl+c cancel";
/** Without pi-cache-guard's `big`, a conversation of this many tokens defaults to compacting to the plan. */
export const COMPACT_DEFAULT_MIN_TOKENS = 100_000;

function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
}

/** A model's display name without control characters or the `Claude ` prefix. */
export function shortModelName(name: string): string {
  return clean(name)
    .trim()
    .replace(/^Claude /u, "");
}

/** The label of a row that implements on a named model, e.g. `Yes, implement with Sonnet 5.5`. */
export function pairLabel(workerName: string, compact = false): string {
  return `Yes, ${compact ? "compact and " : ""}implement with ${shortModelName(workerName)}`;
}

/** Another model the plan can be implemented on. */
export interface ApprovalAlternate {
  model: ModelSpec;
  name: string;
  /** pair-worker: the worker of a plan model pair the session switches to; planner: a selected pair's planner. */
  kind?: "pair-worker" | "planner";
  /** The clause for the Model line while this worker is selected; defaults to the input's note for a pair worker. */
  note?: string;
  /** The pair's key (`provider/id`) to switch to, for a pair worker. */
  pair?: string;
}

/** `alternate` is the index into the input's alternates; absent for the first model. */
export type ApprovalChoice =
  | { kind: "here"; alternate?: number }
  | { kind: "compact-here"; alternate?: number }
  | { kind: "edit" }
  | { kind: "save" }
  | { kind: "keep" };

/** What the context default is decided from: the conversation and its prompt cache. */
export interface ApprovalContextInfo {
  tokens?: number;
  /** The next request would re-write the prompt cache. */
  cold: boolean;
  /** A miss on this conversation would reach pi-cache-guard's warning threshold. */
  big: boolean;
  /** The user's own `defaultImplementationContext`; it wins over the automatic rule. */
  configured?: ImplementationContextChoice;
}

/** Explicit setting, then another model implementing (it reads the conversation uncached), then a cold or big cache, else keep. */
export function defaultImplementationContext(
  info: ApprovalContextInfo | undefined,
  otherModel: boolean,
): ImplementationContextChoice {
  return info?.configured ?? (otherModel || info?.cold || info?.big ? "clear" : "keep");
}

export interface ApprovalInput {
  /** The model whose effort the approval sets: the session model, or a plan pair's worker. */
  planning?: ModelSpec;
  /** Its display name (the Model line); without it the model id is shown. */
  planningName?: string;
  recommendations?: ReadonlyMap<string, ModelSpecThinkingLevel>;
  recommendedThinkingLevel?: ModelSpecThinkingLevel;
  effortDefaultKey?: string;
  /** A short clause about the pair's worker (who answers its questions, who stays on), shown on the Model line while the worker is selected. */
  note?: string;
  /** Names the implementer of the first model (a selected pair's worker); without it the session model is named. */
  implementerName?: string;
  /** Other models to offer: pair workers (each switching to its pair), or a selected pair's planner. */
  alternates?: ApprovalAlternate[];
  /** The conversation and its cache, for the context default. */
  context?: ApprovalContextInfo;
}

export interface ApprovalResult {
  choice: ApprovalChoice;
  thinkingLevel?: ModelSpecThinkingLevel;
  effortSource: EffortSource;
}

/** Keep this object for one approval, including returns from Edit; not across approvals. */
export interface ApprovalState {
  selectedId: string;
  /** The model the settings apply to: 0 is the session or the selected pair's worker, then each alternate. */
  modelIndex: number;
  /** A context chosen with `c` or an RPC row; undefined follows the automatic default. */
  context?: ImplementationContextChoice;
  efforts: Map<string, ModelSpecThinkingLevel | undefined>;
  manuallyAdjusted: Set<string>;
  sources: Map<string, EffortSource>;
  effortDefaultKey?: string;
}

export function createApprovalState(): ApprovalState {
  return {
    selectedId: "implement",
    modelIndex: 0,
    efforts: new Map(),
    manuallyAdjusted: new Set(),
    sources: new Map(),
  };
}

const modelId = (spec: ModelSpec) => JSON.stringify([spec.provider, spec.modelId]);
type Catalog = Pick<ReturnType<typeof modelCatalog>, "efforts">;
type ModelEntry = { spec: ModelSpec | undefined; name: string; worker: boolean; note?: string | undefined };
type RpcRow = {
  id: string;
  label: string;
  index?: number;
  context?: ImplementationContextChoice;
  kind?: "edit" | "save" | "keep";
};
const ACTIONS = ["implement", "edit", "save", "keep"] as const;
const ACTION_LABELS: Record<(typeof ACTIONS)[number], string> = {
  implement: IMPLEMENT,
  edit: EDIT,
  save: SAVE,
  keep: KEEP,
};

function recommendedFor(input: ApprovalInput, model: ModelSpec | undefined): ModelSpecThinkingLevel | undefined {
  return (model && input.recommendations?.get(formatModelKey(model))) ?? input.recommendedThinkingLevel;
}

function initialEffort(input: ApprovalInput, model: ModelSpec | undefined): ModelSpecThinkingLevel | undefined {
  return recommendedFor(input, model) ?? model?.thinkingLevel ?? input.planning?.thinkingLevel;
}

const fmtTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** A single inline Pi-layout component, also exported for remote-client rendering fixtures. */
export class ApprovalPicker implements Component {
  private readonly models: [ModelEntry, ...ModelEntry[]];
  private finished = false;
  private readonly onAbort = () => this.finish(undefined);

  constructor(
    private readonly input: ApprovalInput,
    private readonly state: ApprovalState,
    private readonly catalog: Catalog,
    private readonly theme: Theme,
    private readonly keybindings: Pick<KeybindingsManager, "matches">,
    private readonly requestRender: () => void,
    private readonly done: (result: ApprovalResult | undefined) => void,
    private readonly signal?: AbortSignal,
  ) {
    const note = (text: string | undefined) => (text ? clean(text).trim() || undefined : undefined);
    const shared = note(input.note);
    const first: ModelEntry = {
      spec: input.planning,
      name: shortModelName(input.implementerName ?? input.planningName ?? input.planning?.modelId ?? "this model"),
      worker: !!input.implementerName,
    };
    const rest = (input.alternates ?? []).map(
      (alternate): ModelEntry => ({
        spec: alternate.model,
        name: shortModelName(alternate.name),
        worker: alternate.kind === "pair-worker",
      }),
    );
    this.models = [first, ...rest];
    const anyWorker = this.models.some((entry) => entry.worker);
    this.models.forEach((entry, index) => {
      const own = index === 0 ? undefined : note(input.alternates?.[index - 1]?.note);
      entry.note = own ?? (entry.worker || !anyWorker ? shared : undefined);
    });
    if (state.modelIndex >= this.models.length) state.modelIndex = 0;
    if (!(ACTIONS as readonly string[]).includes(state.selectedId)) state.selectedId = "implement";
    if (input.effortDefaultKey !== undefined && input.effortDefaultKey !== state.effortDefaultKey) {
      for (const id of state.efforts.keys()) {
        if (!state.manuallyAdjusted.has(id)) {
          state.efforts.delete(id);
          state.sources.delete(id);
        }
      }
      state.effortDefaultKey = input.effortDefaultKey;
    }
    for (const { spec } of this.models) {
      if (!spec) continue;
      const id = modelId(spec);
      const levels = this.levels(spec);
      state.efforts.set(
        id,
        normalizeEffort(state.efforts.has(id) ? state.efforts.get(id) : initialEffort(input, spec), levels),
      );
      if (!state.manuallyAdjusted.has(id) && !state.sources.has(id)) {
        state.sources.set(id, recommendedFor(input, spec) !== undefined ? "system1" : "fallback");
      }
    }
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }

  private levels(spec: ModelSpec | undefined): ModelSpecThinkingLevel[] {
    return spec ? this.catalog.efforts(spec).filter((level) => level !== undefined) : [];
  }

  private get action(): (typeof ACTIONS)[number] {
    return (ACTIONS as readonly string[]).includes(this.state.selectedId)
      ? (this.state.selectedId as (typeof ACTIONS)[number])
      : "implement";
  }

  private get model(): ModelEntry {
    return this.models[this.state.modelIndex] ?? this.models[0];
  }

  private effort(spec: ModelSpec | undefined) {
    return spec ? this.state.efforts.get(modelId(spec)) : undefined;
  }

  private contextFor(index: number): ImplementationContextChoice {
    return this.state.context ?? defaultImplementationContext(this.input.context, !!this.models[index]?.worker);
  }

  private implementResult(index: number, context: ImplementationContextChoice): ApprovalResult {
    const spec = this.models[index]?.spec;
    const thinkingLevel = this.effort(spec);
    const id = spec ? modelId(spec) : "";
    return {
      choice: {
        kind: context === "clear" ? "compact-here" : "here",
        ...(index > 0 ? { alternate: index - 1 } : {}),
      },
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      effortSource: this.state.manuallyAdjusted.has(id) ? "manual" : (this.state.sources.get(id) ?? "fallback"),
    };
  }

  private result(): ApprovalResult {
    const action = this.action;
    if (action === "implement")
      return this.implementResult(this.state.modelIndex, this.contextFor(this.state.modelIndex));
    return { choice: { kind: action }, effortSource: "fallback" };
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

  /** The Context line's parenthesis: the conversation's size and why compacting is the default. */
  private contextDetails(index: number): string {
    const info = this.input.context;
    const parts = [
      ...(info?.tokens !== undefined ? [`${fmtTokens(info.tokens)} tokens`] : []),
      ...(this.models[index]?.worker ? ["other model"] : info?.cold ? ["cache cold"] : []),
    ];
    return parts.length ? ` (${parts.join(", ")})` : "";
  }

  render(width: number): string[] {
    const index = this.state.modelIndex;
    const model = this.model;
    const levels = this.levels(model.spec);
    const rule = this.theme.fg("border", "─".repeat(Math.max(0, width)));
    const contentWidth = Math.max(1, width - 2);
    // Flat lines in the question block, never rows: an arrow-prefixed or indented line looks like an option to Collie.
    const line = (text: string, key?: string, bold = false) =>
      wrapTextWithAnsi(
        this.theme.fg("accent", bold ? this.theme.bold(text) : text) + (key ? this.theme.fg("dim", ` · ${key}`) : ""),
        contentWidth,
      ).map((wrapped) => ` ${wrapped}`);
    const settings = [
      ...line(APPROVAL_QUESTION, undefined, true),
      ...line(
        `Model: ${model.name}${model.note ? ` (${model.note})` : ""}`,
        this.models.length > 1
          ? this.models.length > 2
            ? `tab ${index + 1}/${this.models.length}`
            : "tab"
          : undefined,
      ),
      ...line(
        levels.length ? `Effort: ${this.effort(model.spec) ?? "default"}` : "Effort: not supported",
        levels.length ? "←/→" : undefined,
      ),
      ...line(
        `Context: ${this.contextFor(index) === "clear" ? "compact to plan" : "keep conversation"}${this.contextDetails(index)}`,
        "c",
      ),
    ];
    return [
      rule,
      "",
      ...settings,
      "",
      ...ACTIONS.map((id) => {
        const label = truncateToWidth(ACTION_LABELS[id], Math.min(OPTION_MAX, Math.max(0, width - 4)), "…");
        return ` ${this.theme.fg(id === this.action ? "accent" : "text", `${id === this.action ? "→" : " "} ${label}`)}`;
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
      ).map((hint) => ` ${hint}`),
      "",
      rule,
    ].map((row) => {
      const clipped = truncateToWidth(row, width);
      return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
    });
  }

  handleInput(data: string): void {
    if (this.finished) return;
    const index = ACTIONS.indexOf(this.action);
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      matchesKey(data, "ctrl+c") ||
      matchesKey(data, "escape")
    ) {
      this.finish(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.finish(this.result());
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.state.selectedId = ACTIONS[(index - 1 + ACTIONS.length) % ACTIONS.length] ?? "implement";
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.state.selectedId = ACTIONS[(index + 1) % ACTIONS.length] ?? "implement";
    } else if (matchesKey(data, "tab")) {
      if (this.models.length < 2) return;
      this.state.modelIndex = (this.state.modelIndex + 1) % this.models.length;
    } else if (data === "c" || data === "C") {
      this.state.context = this.contextFor(this.state.modelIndex) === "clear" ? "keep" : "clear";
    } else if (matchesKey(data, "left") || matchesKey(data, "right")) {
      const spec = this.model.spec;
      const levels = this.levels(spec);
      if (!spec || !levels.length) return;
      const current = levels.indexOf(this.effort(spec) as ModelSpecThinkingLevel);
      const next =
        current < 0
          ? matchesKey(data, "right")
            ? 0
            : levels.length - 1
          : (current + (matchesKey(data, "right") ? 1 : -1) + levels.length) % levels.length;
      if (levels[next] !== this.effort(spec)) {
        this.state.efforts.set(modelId(spec), levels[next]);
        this.state.manuallyAdjusted.add(modelId(spec));
      }
    } else {
      return; // The review viewport's independent Ctrl+U/D listener remains in charge.
    }
    this.invalidate();
    this.requestRender();
  }

  /** The RPC list: one button per model and context, since buttons are all such a dialog has. */
  private rpcRows(): RpcRow[] {
    const alternates = this.input.alternates ?? [];
    const first = this.input.implementerName;
    const rows = (compact: boolean): RpcRow[] => [
      {
        id: compact ? "compact-here" : "here",
        label: first ? pairLabel(first, compact) : compact ? COMPACT_HERE : HERE,
        index: 0,
        context: compact ? "clear" : "keep",
      },
      ...alternates.map((alternate, i) => ({
        id: `${compact ? "compact-pair" : "pair"}${i === 0 ? "" : `-${i + 1}`}`,
        label: pairLabel(alternate.name, compact),
        index: i + 1,
        context: compact ? ("clear" as const) : ("keep" as const),
      })),
    ];
    const both = [...rows(false), ...rows(true)];
    return [
      ...both,
      { id: "edit", label: EDIT, kind: "edit" },
      { id: "save", label: SAVE, kind: "save" },
      { id: "keep", label: KEEP, kind: "keep" },
    ];
  }

  /** RPC selects by unique labels, never by a possibly colliding truncated model name. */
  async selectRPC(ui: Pick<ExtensionUIContext, "select">): Promise<ApprovalResult | undefined> {
    const workers = this.models.filter((entry) => entry.worker && entry.note);
    const notes = workers.length
      ? workers.map((entry) => ` With ${entry.name}, ${entry.note}.`).join("")
      : this.models[0].note
        ? ` ${this.models[0].note}`
        : "";
    const question = `${APPROVAL_QUESTION}${notes}`;
    while (!this.signal?.aborted) {
      const rows = this.rpcRows();
      const currentId =
        this.action === "implement"
          ? (rows.find(
              (row) => row.index === this.state.modelIndex && row.context === this.contextFor(this.state.modelIndex),
            )?.id ?? "here")
          : this.action;
      const currentLabels = rows.map((row) => row.label);
      const labels = currentLabels.map((label, index) =>
        currentLabels.some((other, otherIndex) => otherIndex !== index && other === label)
          ? `${truncateToWidth(label, OPTION_MAX - String(index + 1).length - 3, "…")} [${index + 1}]`
          : label,
      );
      const selectedIndex = Math.max(
        0,
        rows.findIndex((row) => row.id === currentId),
      );
      const currentLabel = labels[selectedIndex] as string;
      const actions = [currentLabel, ...labels.filter((label) => label !== currentLabel)];
      const selected = await ui.select(question, actions, { signal: this.signal });
      if (this.signal?.aborted) return undefined;
      if (selected === undefined) return undefined;
      const row = rows[labels.indexOf(selected)];
      if (!row) return undefined;
      if (row.kind) {
        this.state.selectedId = row.kind;
        return { choice: { kind: row.kind }, effortSource: "fallback" };
      }
      const modelIndex = row.index ?? 0;
      const context = row.context ?? "keep";
      this.state.selectedId = "implement";
      this.state.modelIndex = modelIndex;
      this.state.context = context;
      const spec = this.models[modelIndex]?.spec;
      const levels = this.levels(spec);
      if (spec && levels.length) {
        const current = this.effort(spec);
        const options = [current ?? "Model default", ...levels.filter((level) => level !== current)];
        const selectedEffort = await ui.select("Implementation effort", options, { signal: this.signal });
        if (this.signal?.aborted) return undefined;
        if (selectedEffort === undefined) continue;
        if (!options.includes(selectedEffort)) return undefined;
        this.state.efforts.set(
          modelId(spec),
          selectedEffort === "Model default" ? undefined : (selectedEffort as ModelSpecThinkingLevel),
        );
        if ((selectedEffort === "Model default" ? undefined : selectedEffort) !== current)
          this.state.manuallyAdjusted.add(modelId(spec));
      }
      return this.implementResult(modelIndex, context);
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
    ...(input.planningName === undefined && !input.planning && ctx.model?.name ? { planningName: ctx.model.name } : {}),
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
        state.modelIndex = remoteState.modelIndex;
        state.context = remoteState.context;
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
