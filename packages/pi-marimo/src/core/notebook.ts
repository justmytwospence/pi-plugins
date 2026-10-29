// A notebook's live state, rebuilt from the messages marimo streams to its
// frontends: the cell document (kernel-ready, notebook-document-transaction),
// each cell's run state and errors (cell-op), and the dataflow graph
// (variables). Only what an agent needs is kept; outputs are dropped.

import { LensTracker } from "./lens.js";
import { type CellOutput, type ConsoleLine, appendConsole, summarizeOutput } from "./output.js";
import { type Heading, headingsFromCode, isMarkdownCell, sameCode } from "./markdown.js";

export type EditSource = "frontend" | "code-mode" | "kernel" | string;

export interface Cell {
  id: string;
  code: string;
  name: string;
  disabled: boolean;
  /** "idle" | "queued" | "running" | "disabled-transitively" */
  status: string;
  /** When the current run started (ms since epoch), while running. */
  runningSince?: number;
  /** Inputs changed and the cell has not rerun (lazy runtime). */
  stale: boolean;
  /** One-line description of the error the cell's last run raised. */
  error?: string;
  /** The cell did not run because an ancestor failed. */
  blocked?: string;
  /** What the cell last output and printed, for the notebook view only (never in the agent's snapshot). */
  output?: CellOutput;
  console?: ConsoleLine[];
  /** Code the kernel last ran for this cell, when known. */
  lastRunCode?: string;
  /** How long the cell's last finished run took (ms), when known. */
  lastRunMs?: number;
  /** Who last changed the code, and at which change number. */
  editedBy?: EditSource;
  editSeq: number;
}

export interface RunningCell {
  cell: Cell;
  section: string[];
  since?: number;
}

/** A change made through marimo's code mode (marimo-pair) since the user's last prompt. */
export interface AgentChange {
  kind: "created" | "edited" | "deleted" | "moved" | "renamed";
  /** The code before the first such change (empty for a new cell). */
  before: string;
  /** The cell's name, for a deleted or renamed one. */
  name?: string;
  at: number;
}

/** A widget value the user set from Pi since their last prompt. */
export interface UserSet {
  cell: string;
  objectId: string;
  label: string;
  value: unknown;
  at: number;
}

/** A variable's value as marimo's variables panel shows it. */
export interface VariableValue {
  value?: string;
  datatype?: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const isInternal = (id: string): boolean => id.startsWith("__");

export function describeError(output: Record<string, unknown>): { error?: string; blocked?: string } {
  const errors = Array.isArray(output.data) ? output.data.map(record) : [];
  const parts: string[] = [];
  let blocked: string | undefined;
  for (const err of errors) {
    const type = typeof err.type === "string" ? err.type : "error";
    const msg = typeof err.msg === "string" ? err.msg.trim().split("\n")[0] : "";
    if (type === "ancestor-prevented" || type === "ancestor-stopped") {
      blocked = msg || "an ancestor cell failed";
      continue;
    }
    if (type === "exception") {
      const name = typeof err.exception_type === "string" ? err.exception_type : "Exception";
      parts.push(msg ? `${name}: ${msg}` : name);
    } else if (type === "multiple-defs") {
      const name = typeof err.name === "string" ? err.name : "?";
      parts.push(`multiple definitions of ${name}`);
    } else if (type === "interruption") {
      parts.push("interrupted");
    } else {
      parts.push(msg ? `${type}: ${msg}` : type);
    }
  }
  const error = parts.length ? truncate(parts.join("; "), 200) : undefined;
  return { error, blocked: error ? undefined : blocked };
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export class NotebookState {
  order: string[] = [];
  cells = new Map<string, Cell>();
  defs = new Map<string, string[]>();
  /** Each variable's defining cells, and the cells that use it (the dataflow graph). */
  declaredBy = new Map<string, string[]>();
  usedBy = new Map<string, string[]>();
  /** Variable values and types (`variable-values`), for the view only. */
  values = new Map<string, VariableValue>();
  /** Widget values that differ from their elements' initial ones (kernel-ready's `ui_values`, and the ones set from Pi). */
  uiValues = new Map<string, unknown>();
  /** Code-mode (marimo-pair) changes since the user's last prompt, by cell id. Kept across reconnects, so a browser reload does not erase what the user is reviewing. */
  agentChanges = new Map<string, AgentChange>();
  /** Widget values the user set from Pi since their last prompt, by object id. Kept across reconnects too. */
  userSets = new Map<string, UserSet>();
  ready = false;
  /** Increments on every document change. */
  seq = 0;
  /**
   * When the notebook was last used (ms since epoch): the latest cell run the
   * kernel reports (replayed on connect, so a notebook's history counts), or an
   * edit seen live.
   */
  lastActivity = 0;
  /** marimo-lens selections (lens.ts), from widget model messages. */
  lens = new LensTracker();
  private readyAt = 0;
  private headingCache = new Map<string, Heading[]>();

  reset(): void {
    this.order = [];
    this.cells.clear();
    this.defs.clear();
    this.declaredBy.clear();
    this.usedBy.clear();
    this.values.clear();
    this.uiValues.clear();
    this.ready = false;
    this.lastActivity = 0;
    this.readyAt = 0;
    this.headingCache.clear();
    this.lens.reset();
  }

  private ensure(id: string): Cell {
    let cell = this.cells.get(id);
    if (!cell) {
      cell = { id, code: "", name: "_", disabled: false, status: "idle", stale: false, editSeq: 0 };
      this.cells.set(id, cell);
    }
    return cell;
  }

  headings(cell: Cell): Heading[] {
    let headings = this.headingCache.get(cell.code);
    if (!headings) {
      headings = headingsFromCode(cell.code);
      if (this.headingCache.size > 2000) this.headingCache.clear();
      this.headingCache.set(cell.code, headings);
    }
    return headings;
  }

  isMarkdown(cell: Cell): boolean {
    return isMarkdownCell(cell.code);
  }

  /** Apply one streamed message. Returns true when agent-visible state changed. */
  apply(op: string, raw: unknown): boolean {
    const data = record(raw);
    switch (op) {
      case "kernel-ready":
        return this.kernelReady(data);
      case "notebook-document-transaction":
        return this.transaction(record(data.transaction));
      case "cell-op":
        return this.cellOp(data);
      case "variables":
        return this.variables(data);
      case "variable-values":
        return this.variableValues(data);
      case "remove-ui-elements":
        return this.removeUi(data);
      case "model-lifecycle":
        return this.lens.apply(data);
      default:
        return false;
    }
  }

  private kernelReady(data: Record<string, unknown>): boolean {
    this.reset();
    const ids = strings(data.cell_ids);
    const codes = strings(data.codes);
    const names = strings(data.names);
    const configs = Array.isArray(data.configs) ? data.configs.map(record) : [];
    const lastRun = record(data.last_executed_code);
    // Milliseconds once a run finished; while one runs, marimo keeps its start time (seconds) there.
    const times = record(data.last_execution_time);
    ids.forEach((id, i) => {
      const cell = this.ensure(id);
      cell.code = codes[i] ?? "";
      cell.name = names[i] || "_";
      cell.disabled = configs[i]?.disabled === true;
      if (typeof lastRun[id] === "string") cell.lastRunCode = lastRun[id] as string;
      const t = times[id];
      if (typeof t === "number" && t >= 0 && t < 1e9) cell.lastRunMs = t;
    });
    for (const [id, value] of Object.entries(record(data.ui_values))) this.uiValues.set(id, value);
    this.order = ids;
    this.ready = true;
    this.readyAt = Date.now();
    return true;
  }

  private place(id: string, before: unknown, after: unknown): void {
    this.order = this.order.filter((other) => other !== id);
    if (typeof before === "string" && this.order.includes(before)) {
      this.order.splice(this.order.indexOf(before), 0, id);
    } else if (typeof after === "string" && this.order.includes(after)) {
      this.order.splice(this.order.indexOf(after) + 1, 0, id);
    } else {
      this.order.push(id);
    }
  }

  /** Past the replay on connect: what arrives now happens now. */
  private live(): boolean {
    return this.readyAt > 0 && Date.now() - this.readyAt > 1500;
  }

  private transaction(tx: Record<string, unknown>): boolean {
    const source = typeof tx.source === "string" ? tx.source : "unknown";
    const changes = Array.isArray(tx.changes) ? tx.changes.map(record) : [];
    // Changes made through code mode (marimo-pair) while we watch are the agent's, for the view to mark.
    const agent = source === "code-mode" && this.live();
    const now = Date.now();
    let changed = false;
    for (const change of changes) {
      const id = typeof change.cellId === "string" ? change.cellId : "";
      const entry = this.agentChanges.get(id);
      switch (change.type) {
        case "create-cell": {
          const cell = this.ensure(id);
          cell.code = typeof change.code === "string" ? change.code : "";
          cell.name = typeof change.name === "string" && change.name ? change.name : "_";
          cell.disabled = record(change.config).disabled === true;
          cell.editedBy = source;
          cell.editSeq = ++this.seq;
          this.place(id, change.before, change.after);
          if (agent) this.agentChanges.set(id, { kind: "created", before: "", at: now });
          changed = true;
          break;
        }
        case "delete-cell": {
          const old = this.cells.get(id);
          if (!agent || entry?.kind === "created") this.agentChanges.delete(id);
          else this.agentChanges.set(id, { kind: "deleted", before: entry?.before ?? old?.code ?? "", ...(old ? { name: old.name } : {}), at: now });
          this.cells.delete(id);
          this.order = this.order.filter((other) => other !== id);
          this.defs.delete(id);
          this.seq++;
          changed = true;
          break;
        }
        case "move-cell":
          if (agent && !entry) this.agentChanges.set(id, { kind: "moved", before: this.cells.get(id)?.code ?? "", at: now });
          this.place(id, change.before, change.after);
          this.seq++;
          changed = true;
          break;
        case "reorder-cells": {
          const ids = strings(change.cellIds).filter((cid) => this.cells.has(cid));
          const rest = this.order.filter((cid) => !ids.includes(cid));
          const next = [...ids, ...rest];
          if (next.join() !== this.order.join()) { this.order = next; this.seq++; changed = true; }
          break;
        }
        case "set-code": {
          const cell = this.ensure(id);
          const code = typeof change.code === "string" ? change.code : "";
          // The browser respelling a markdown cell is not an edit.
          if (cell.code !== code && sameCode(cell.code, code)) cell.code = code;
          else if (cell.code !== code) {
            if (agent) {
              if (!entry || entry.kind === "moved" || entry.kind === "renamed") this.agentChanges.set(id, { kind: "edited", before: entry?.before ?? cell.code, at: now });
              else entry.at = now;
            }
            cell.code = code;
            cell.editedBy = source;
            cell.editSeq = ++this.seq;
            changed = true;
          }
          break;
        }
        case "set-name": {
          const cell = this.ensure(id);
          if (agent && !entry) this.agentChanges.set(id, { kind: "renamed", before: cell.code, name: cell.name, at: now });
          cell.name = typeof change.name === "string" && change.name ? change.name : "_";
          changed = true;
          break;
        }
        case "set-config": {
          const cell = this.ensure(id);
          const disabled = change.disabled === true;
          if (cell.disabled !== disabled) { cell.disabled = disabled; changed = true; }
          break;
        }
      }
    }
    // An edit counts as use when it arrives live, not in the replay on connect.
    if (source !== "kernel" && changed && this.live()) this.lastActivity = Date.now();
    return changed;
  }

  private cellOp(data: Record<string, unknown>): boolean {
    const id = typeof data.cell_id === "string" ? data.cell_id : "";
    if (!id || isInternal(id) || !this.cells.has(id)) return false;
    const cell = this.ensure(id);
    let changed = false;
    if (typeof data.status === "string" && typeof data.timestamp === "number") {
      this.lastActivity = Math.max(this.lastActivity, data.timestamp * 1000);
    }
    if (typeof data.status === "string" && data.status !== cell.status) {
      const was = cell.status;
      const at = typeof data.timestamp === "number" ? data.timestamp * 1000 : Date.now();
      if (was === "running" && data.status === "idle" && cell.runningSince !== undefined) cell.lastRunMs = Math.max(0, at - cell.runningSince);
      cell.status = data.status;
      if (data.status === "queued") {
        // The previous run's error is about to be replaced.
        cell.error = undefined;
        cell.blocked = undefined;
        cell.console = undefined;
      }
      if (data.status === "running") {
        // The cell makes its widgets anew, with their initial values.
        this.dropUiValues(id);
        cell.runningSince = at;
        cell.lastRunCode = cell.code;
        cell.error = undefined;
        cell.blocked = undefined;
        cell.stale = false;
      } else {
        cell.runningSince = undefined;
      }
      changed = true;
    }
    if (typeof data.stale_inputs === "boolean" && data.stale_inputs !== cell.stale) {
      cell.stale = data.stale_inputs;
      changed = true;
    }
    // Outputs and console lines are for the view: they never mark the state changed.
    if ("console" in data) cell.console = appendConsole(cell.console, data.console);
    if (data.output !== null && typeof data.output === "object") {
      const output = record(data.output);
      cell.output = summarizeOutput(output);
      const { error, blocked } = output.channel === "marimo-error" ? describeError(output) : {};
      if (error !== cell.error || blocked !== cell.blocked) {
        cell.error = error;
        cell.blocked = blocked;
        changed = true;
      }
    }
    return changed;
  }

  private variables(data: Record<string, unknown>): boolean {
    const vars = Array.isArray(data.variables) ? data.variables.map(record) : [];
    const defs = new Map<string, string[]>();
    for (const v of vars) {
      if (typeof v.name !== "string") continue;
      for (const id of strings(v.declared_by)) {
        if (!defs.has(id)) defs.set(id, []);
        defs.get(id)!.push(v.name);
      }
    }
    for (const names of defs.values()) names.sort();
    this.declaredBy = new Map(vars.filter((v) => typeof v.name === "string").map((v) => [v.name as string, strings(v.declared_by)]));
    this.usedBy = new Map(vars.filter((v) => typeof v.name === "string").map((v) => [v.name as string, strings(v.used_by)]));
    for (const name of [...this.values.keys()]) if (!this.declaredBy.has(name)) this.values.delete(name);
    const before = JSON.stringify([...this.defs.entries()].sort());
    this.defs = defs;
    return before !== JSON.stringify([...defs.entries()].sort());
  }

  /** Variable values for the view; never a change the agent sees. */
  private variableValues(data: Record<string, unknown>): boolean {
    for (const v of Array.isArray(data.variables) ? data.variables.map(record) : []) {
      if (typeof v.name !== "string") continue;
      this.values.set(v.name, {
        ...(typeof v.value === "string" ? { value: v.value } : {}),
        ...(typeof v.datatype === "string" ? { datatype: v.datatype } : {}),
      });
    }
    return false;
  }

  private removeUi(data: Record<string, unknown>): boolean {
    if (typeof data.cell_id === "string") this.dropUiValues(data.cell_id);
    return false;
  }

  /** marimo names a cell's UI elements `<cell id>-<n>`. */
  private dropUiValues(cellId: string): void {
    for (const key of [...this.uiValues.keys()]) if (key.startsWith(`${cellId}-`)) this.uiValues.delete(key);
  }

  /** The variables a cell uses, sorted. */
  uses(cellId: string): string[] {
    return [...this.usedBy].filter(([, cells]) => cells.includes(cellId)).map(([name]) => name).sort();
  }

  /** The cells, in notebook order, that define what this cell uses. */
  parents(cellId: string): string[] {
    const from = new Set(this.uses(cellId).flatMap((name) => this.declaredBy.get(name) ?? []));
    from.delete(cellId);
    return this.order.filter((id) => from.has(id));
  }

  /** The cells, in notebook order, that use what this cell defines. */
  children(cellId: string): string[] {
    const to = new Set((this.defs.get(cellId) ?? []).flatMap((name) => this.usedBy.get(name) ?? []));
    to.delete(cellId);
    return this.order.filter((id) => to.has(id));
  }

  /** The user set a widget from Pi: shown at once, and named in the agent's next context. */
  setUserValue(cell: string, objectId: string, label: string, value: unknown, now = Date.now()): void {
    this.uiValues.set(objectId, value);
    this.userSets.set(objectId, { cell, objectId, label, value, at: now });
  }

  /** The user sent a prompt: the agent's changes and the widget values set before it are no longer new. */
  markPrompt(): void {
    this.agentChanges.clear();
    this.userSets.clear();
  }

  /** Cells in notebook order. */
  ordered(): Cell[] {
    return this.order.map((id) => this.cells.get(id)).filter((cell): cell is Cell => cell !== undefined);
  }

  /** The heading path ("Section", "Subsection") a cell sits under, including its own headings. */
  sectionPath(cellId: string): string[] {
    const stack: Heading[] = [];
    for (const cell of this.ordered()) {
      for (const heading of this.headings(cell)) {
        while (stack.length && stack[stack.length - 1]!.level >= heading.level) stack.pop();
        stack.push(heading);
      }
      if (cell.id === cellId) break;
    }
    return stack.map((h) => h.text);
  }

  running(): RunningCell | undefined {
    const cell = this.ordered().find((c) => c.status === "running");
    return cell ? { cell, section: this.sectionPath(cell.id), since: cell.runningSince } : undefined;
  }

  queued(): number {
    return this.ordered().filter((c) => c.status === "queued").length;
  }

  errors(): Cell[] {
    return this.ordered().filter((c) => c.error);
  }

  /** Code changed since the kernel last ran it (only known once a run was seen). */
  edited(cell: Cell): boolean {
    return cell.lastRunCode !== undefined && !sameCode(cell.lastRunCode, cell.code);
  }
}
