// A notebook's widgets in the view: one line each (a slider's bar, a dropdown's choice, ...), how a
// key changes one, and the sender that coalesces quick changes (holding → on a slider) into one call
// to marimo's set_ui_element_value.
import type { NotebookState } from "../core/notebook.js";
import { truncate } from "../core/notebook.js";
import type { Widget } from "../core/output.js";
import type { FrameTheme } from "../frame.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

/** The widget's current value: the one set since it was created (from Pi, or replayed by marimo), else its initial one. */
export function widgetValue(nb: NotebookState, w: Widget): unknown {
  return nb.uiValues.has(w.objectId) ? nb.uiValues.get(w.objectId) : w.initial;
}

const BAR = 16;

const fmt = (v: unknown): string => (typeof v === "number" ? String(Number(v.toFixed(6))) : v === null || v === undefined ? "none" : typeof v === "string" ? v : JSON.stringify(v) ?? "");

/** A value's place along a slider (0..1): by value, or by index when the slider has explicit steps. */
function position(w: Widget, v: number): number {
  if (w.steps.length > 1) {
    const i = nearest(w.steps, v);
    return i / (w.steps.length - 1);
  }
  const { start = 0, stop = 1 } = w;
  return stop === start ? 0 : Math.max(0, Math.min(1, (v - start) / (stop - start)));
}

function nearest(steps: number[], v: number): number {
  let best = 0;
  for (let i = 1; i < steps.length; i++) if (Math.abs(steps[i]! - v) < Math.abs(steps[best]! - v)) best = i;
  return best;
}

function bar(theme: FrameTheme, knobs: number[], bold?: number): string {
  const at = knobs.map((p) => Math.round(p * (BAR - 1)));
  let out = "";
  for (let i = 0; i < BAR; i++) {
    const k = at.indexOf(i);
    if (k >= 0) out += k === bold ? theme.bold(theme.fg("accent", "●")) : theme.fg("accent", "●");
    else if (i < Math.max(...at) && (at.length === 1 || i > Math.min(...at))) out += theme.fg("accent", "━");
    else out += theme.fg("dim", "─");
  }
  return out;
}

const range = (w: Widget): string => (w.start !== undefined && w.stop !== undefined ? `${fmt(w.start)}–${fmt(w.stop)}` : "");

/** One line for a widget (no indent): its label, then its control. */
export function widgetLine(w: Widget, value: unknown, focus: { sub: number } | undefined, theme: FrameTheme): string {
  const label = w.label && w.kind !== "button" ? `${focus ? theme.bold(w.label) : w.label}  ` : "";
  let control: string;
  switch (w.kind) {
    case "slider": {
      const v = typeof value === "number" ? value : Number(value) || 0;
      control = `${bar(theme, [position(w, v)])}  ${fmt(v)}${range(w) ? theme.fg("dim", `  ${range(w)}`) : ""}`;
      break;
    }
    case "range-slider": {
      const [a, b] = Array.isArray(value) ? value.map((x) => Number(x) || 0) : [w.start ?? 0, w.stop ?? 0];
      control = `${bar(theme, [position(w, a!), position(w, b!)], focus?.sub)}  ${fmt(a)}–${fmt(b)}`;
      break;
    }
    case "number":
      control = `‹ ${fmt(value)} ›${range(w) ? theme.fg("dim", `  ${range(w)}`) : ""}`;
      break;
    case "checkbox":
      control = value === true ? "[x]" : "[ ]";
      break;
    case "switch":
      control = value === true ? `${theme.fg("accent", "●")} on` : `${theme.fg("dim", "○")} off`;
      break;
    case "text":
    case "text-area":
      control = `"${truncate(String(value ?? "").replace(/\n/gu, "⏎"), 40)}"`;
      break;
    case "date":
      control = fmt(value);
      break;
    case "dropdown":
    case "radio": {
      const current = w.kind === "dropdown" ? (Array.isArray(value) ? value[0] : undefined) : value;
      const i = w.options.indexOf(String(current));
      control = `‹ ${current === undefined || current === null ? "none" : String(current)} ›${w.options.length ? theme.fg("dim", `  ${i >= 0 ? i + 1 : "-"} of ${w.options.length}`) : ""}`;
      break;
    }
    case "multiselect": {
      const chosen = new Set(Array.isArray(value) ? value.map(String) : []);
      const parts = w.options.map((o, i) => {
        const text = chosen.has(o) ? theme.fg("accent", `[${o}]`) : o;
        return focus && focus.sub === i ? theme.bold(text) : text;
      });
      control = parts.length ? parts.join(" ") : theme.fg("dim", "(no options)");
      break;
    }
    case "button": {
      const n = Number(value) || 0;
      control = `[ ${w.label || "button"} ]${n > 0 ? theme.fg("dim", `  pressed ${n}×`) : ""}`;
      break;
    }
    default:
      control = theme.fg("dim", `[${w.tag.replace(/^marimo-/u, "")} widget: o opens the notebook]`);
  }
  return `${label}${control}${w.disabled ? theme.fg("dim", "  (disabled)") : ""}`;
}

export type WidgetAction = "dec" | "inc" | "dec10" | "inc10" | "toggle";

const decimals = (n: number): number => {
  const s = String(n);
  const e = /e-(\d+)$/u.exec(s);
  if (e) return Number(e[1]);
  return s.includes(".") ? s.split(".")[1]!.length : 0;
};

const by = (action: WidgetAction): number => (action === "inc" ? 1 : action === "dec" ? -1 : action === "inc10" ? 10 : action === "dec10" ? -10 : 0);

function stepped(v: number, step: number, k: number, lo: number | undefined, hi: number | undefined, origin = 0): number {
  let next = v + step * k;
  if (lo !== undefined) next = Math.max(lo, next);
  if (hi !== undefined) next = Math.min(hi, next);
  return Number(next.toFixed(Math.max(decimals(step), decimals(origin))));
}

/** What a key does to a widget: its next value and sub-position, and whether marimo should hear of it; undefined when the key does nothing. */
export function nextValue(w: Widget, value: unknown, action: WidgetAction, sub: number): { value: unknown; sub: number; send: boolean } | undefined {
  const k = by(action);
  switch (w.kind) {
    case "slider": {
      if (action === "toggle") return undefined;
      const v = typeof value === "number" ? value : Number(value) || 0;
      if (w.steps.length) {
        const i = Math.max(0, Math.min(w.steps.length - 1, nearest(w.steps, v) + k));
        return { value: w.steps[i], sub, send: true };
      }
      const start = w.start ?? 0;
      const stop = w.stop ?? 1;
      const step = w.step ?? (Number.isInteger(start) && Number.isInteger(stop) && stop - start >= 10 ? 1 : (stop - start) / 100);
      return { value: stepped(v, step, k, start, stop, start), sub, send: true };
    }
    case "number": {
      if (action === "toggle") return undefined;
      const v = typeof value === "number" ? value : Number(value) || 0;
      return { value: stepped(v, w.step ?? 1, k, w.start, w.stop, w.start ?? 0), sub, send: true };
    }
    case "range-slider": {
      if (action === "toggle") return { value, sub: sub === 0 ? 1 : 0, send: false };
      const pair = Array.isArray(value) ? value.map((x) => Number(x) || 0) : [w.start ?? 0, w.stop ?? 0];
      const start = w.start ?? 0;
      const stop = w.stop ?? 1;
      const step = w.step ?? (Number.isInteger(start) && Number.isInteger(stop) && stop - start >= 10 ? 1 : (stop - start) / 100);
      const h = sub === 1 ? 1 : 0;
      const moved = stepped(pair[h]!, step, k, h === 0 ? start : pair[0], h === 0 ? pair[1] : stop, start);
      const next = [...pair];
      next[h] = moved;
      return { value: next, sub: h, send: true };
    }
    case "checkbox":
    case "switch":
      return { value: value !== true, sub, send: true };
    case "dropdown":
    case "radio": {
      if (!w.options.length) return undefined;
      const current = w.kind === "dropdown" ? (Array.isArray(value) ? value[0] : undefined) : value;
      const at = w.options.indexOf(String(current));
      const step = action === "toggle" ? 1 : Math.sign(k);
      const i = ((at < 0 ? (step > 0 ? -1 : 0) : at) + step + w.options.length) % w.options.length;
      const option = w.options[i]!;
      return { value: w.kind === "dropdown" ? [option] : option, sub, send: true };
    }
    case "multiselect": {
      if (!w.options.length) return undefined;
      if (action !== "toggle") return { value, sub: Math.max(0, Math.min(w.options.length - 1, sub + Math.sign(k))), send: false };
      const option = w.options[Math.max(0, Math.min(w.options.length - 1, sub))]!;
      const chosen = Array.isArray(value) ? value.map(String) : [];
      return { value: chosen.includes(option) ? chosen.filter((o) => o !== option) : [...chosen, option], sub, send: true };
    }
    case "button":
      if (action === "dec" || action === "dec10") return undefined;
      return { value: (Number(value) || 0) + 1, sub, send: true };
    default:
      return undefined;
  }
}

/** A slider's value at a place along its bar (0..1): a step of its own, or a multiple of its step. */
function valueAt(w: Widget, p: number): number {
  const q = Math.max(0, Math.min(1, p));
  if (w.steps.length > 1) return w.steps[Math.round(q * (w.steps.length - 1))]!;
  const start = w.start ?? 0;
  const stop = w.stop ?? 1;
  const step = w.step ?? (Number.isInteger(start) && Number.isInteger(stop) && stop - start >= 10 ? 1 : (stop - start) / 100);
  const raw = start + q * (stop - start);
  const snapped = step > 0 ? start + Math.round((raw - start) / step) * step : raw;
  return Number(Math.max(start, Math.min(stop, snapped)).toFixed(Math.max(decimals(step), decimals(start))));
}

/** What a click does at a column of a widget's line (as widgetLine draws it, from its first column). */
export type WidgetHit =
  | { action: WidgetAction; sub?: number }
  | { value: unknown; sub?: number; drag?: boolean }
  | { type: true };

export function widgetHit(w: Widget, value: unknown, col: number): WidgetHit | undefined {
  const label = w.label && w.kind !== "button" ? visibleWidth(w.label) + 2 : 0;
  const c = col - label;
  if (c < 0) return undefined;
  switch (w.kind) {
    case "slider":
      return c < BAR ? { value: valueAt(w, c / (BAR - 1)), drag: true } : undefined;
    case "range-slider": {
      if (c >= BAR) return undefined;
      const pair = Array.isArray(value) ? value.map((x) => Number(x) || 0) : [w.start ?? 0, w.stop ?? 0];
      const v = valueAt(w, c / (BAR - 1));
      // The nearer knob moves, and never past the other.
      const h = Math.abs(v - pair[0]!) <= Math.abs(v - pair[1]!) ? 0 : 1;
      const next = [...pair];
      next[h] = h === 0 ? Math.min(v, pair[1]!) : Math.max(v, pair[0]!);
      return { value: next, sub: h, drag: true };
    }
    case "number": {
      const end = 2 + visibleWidth(fmt(value)) + 1;
      return c <= 1 ? { action: "dec" } : c >= end && c <= end + 1 ? { action: "inc" } : c < end ? { type: true } : undefined;
    }
    case "checkbox":
      return c < 3 ? { action: "toggle" } : undefined;
    case "switch":
      return c < 5 ? { action: "toggle" } : undefined;
    case "text":
    case "text-area":
    case "date":
      return { type: true };
    case "dropdown":
    case "radio": {
      const current = w.kind === "dropdown" ? (Array.isArray(value) ? value[0] : undefined) : value;
      const end = 2 + visibleWidth(current === undefined || current === null ? "none" : String(current)) + 1;
      return c <= 1 ? { action: "dec" } : c <= end + 1 ? { action: "inc" } : undefined;
    }
    case "multiselect": {
      const chosen = new Set(Array.isArray(value) ? value.map(String) : []);
      let at = 0;
      for (let i = 0; i < w.options.length; i++) {
        const o = w.options[i]!;
        const len = visibleWidth(chosen.has(o) ? `[${o}]` : o);
        if (c >= at && c < at + len) return { value: chosen.has(o) ? [...chosen].filter((x) => x !== o) : [...chosen, o], sub: i };
        at += len + 1;
      }
      return undefined;
    }
    case "button":
      return c < visibleWidth(`[ ${w.label || "button"} ]`) ? { action: "toggle" } : undefined;
    default:
      return undefined;
  }
}

/** The widgets whose value is typed (Enter opens a prompt for it). */
export function typeable(w: Widget): boolean {
  return w.kind === "text" || w.kind === "text-area" || w.kind === "date" || w.kind === "number";
}

/** A typed value for a widget, or what is wrong with it. */
export function typedValue(w: Widget, text: string): { value: unknown } | { error: string } {
  if (w.kind === "number") {
    const n = Number(text.trim());
    const bounded = w.start !== undefined && w.stop !== undefined;
    if (!text.trim() || !Number.isFinite(n) || (w.start !== undefined && n < w.start) || (w.stop !== undefined && n > w.stop)) {
      return { error: bounded ? `Enter a number between ${fmt(w.start)} and ${fmt(w.stop)}.` : "Enter a number." };
    }
    return { value: n };
  }
  if (w.kind === "date") return /^\d{4}-\d{2}-\d{2}$/u.test(text.trim()) ? { value: text.trim() } : { error: "Enter a date as YYYY-MM-DD." };
  return { value: text };
}

type Target = { url: string; sessionId: string };

/** Sends the latest value of each widget `delayMs` after its last change, so a held key makes one call, not twenty. */
export class WidgetSender {
  private readonly pending = new Map<string, { timer: ReturnType<typeof setTimeout>; target: Target; objectId: string; value: unknown }>();

  constructor(
    private readonly send: (target: Target, objectId: string, value: unknown) => Promise<void>,
    private readonly delayMs = 120,
    private readonly onError?: (e: unknown) => void,
  ) {}

  set(target: Target, objectId: string, value: unknown): void {
    const key = `${target.url}\0${objectId}`;
    const known = this.pending.get(key);
    if (known) clearTimeout(known.timer);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.send(target, objectId, value).catch((e: unknown) => this.onError?.(e));
    }, this.delayMs);
    timer.unref?.();
    this.pending.set(key, { timer, target, objectId, value });
  }

  dispose(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}
