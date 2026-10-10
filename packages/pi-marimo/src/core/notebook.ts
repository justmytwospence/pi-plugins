// A notebook's live state, rebuilt from the messages marimo streams to its
// frontends: the cell document (kernel-ready, notebook-document-transaction),
// each cell's run state and errors (cell-op), and the dataflow graph
// (variables). Only what an agent needs is kept; outputs are dropped.

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
  /** Code the kernel last ran for this cell, when known. */
  lastRunCode?: string;
  /** Who last changed the code, and at which change number. */
  editedBy?: EditSource;
  editSeq: number;
}

export interface RunningCell {
  cell: Cell;
  section: string[];
  since?: number;
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
  ready = false;
  /** Increments on every document change. */
  seq = 0;
  /**
   * When the notebook was last used (ms since epoch): the latest cell run the
   * kernel reports (replayed on connect, so a notebook's history counts), or an
   * edit seen live.
   */
  lastActivity = 0;
  private readyAt = 0;
  private headingCache = new Map<string, Heading[]>();

  reset(): void {
    this.order = [];
    this.cells.clear();
    this.defs.clear();
    this.ready = false;
    this.lastActivity = 0;
    this.readyAt = 0;
    this.headingCache.clear();
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
    ids.forEach((id, i) => {
      const cell = this.ensure(id);
      cell.code = codes[i] ?? "";
      cell.name = names[i] || "_";
      cell.disabled = configs[i]?.disabled === true;
      if (typeof lastRun[id] === "string") cell.lastRunCode = lastRun[id] as string;
    });
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

  private transaction(tx: Record<string, unknown>): boolean {
    const source = typeof tx.source === "string" ? tx.source : "unknown";
    const changes = Array.isArray(tx.changes) ? tx.changes.map(record) : [];
    let changed = false;
    for (const change of changes) {
      const id = typeof change.cellId === "string" ? change.cellId : "";
      switch (change.type) {
        case "create-cell": {
          const cell = this.ensure(id);
          cell.code = typeof change.code === "string" ? change.code : "";
          cell.name = typeof change.name === "string" && change.name ? change.name : "_";
          cell.disabled = record(change.config).disabled === true;
          cell.editedBy = source;
          cell.editSeq = ++this.seq;
          this.place(id, change.before, change.after);
          changed = true;
          break;
        }
        case "delete-cell":
          this.cells.delete(id);
          this.order = this.order.filter((other) => other !== id);
          this.defs.delete(id);
          this.seq++;
          changed = true;
          break;
        case "move-cell":
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
            cell.code = code;
            cell.editedBy = source;
            cell.editSeq = ++this.seq;
            changed = true;
          }
          break;
        }
        case "set-name": {
          const cell = this.ensure(id);
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
    if (source !== "kernel" && changed && this.readyAt && Date.now() - this.readyAt > 1500) this.lastActivity = Date.now();
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
      cell.status = data.status;
      if (data.status === "queued") {
        // The previous run's error is about to be replaced.
        cell.error = undefined;
        cell.blocked = undefined;
      }
      if (data.status === "running") {
        const at = typeof data.timestamp === "number" ? data.timestamp * 1000 : Date.now();
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
    if (data.output !== null && typeof data.output === "object") {
      const output = record(data.output);
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
    const before = JSON.stringify([...this.defs.entries()].sort());
    this.defs = defs;
    return before !== JSON.stringify([...defs.entries()].sort());
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
