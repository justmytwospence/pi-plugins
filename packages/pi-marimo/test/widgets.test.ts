import { afterEach, expect, test, vi } from "vitest";
import type { Widget } from "../src/core/output.js";
import { NotebookState } from "../src/core/notebook.js";
import { WidgetSender, nextValue, typedValue, widgetLine, widgetValue } from "../src/ui/widgets.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const w = (over: Partial<Widget>): Widget => ({ objectId: "a-0", kind: "slider", tag: "marimo-slider", label: "n", initial: 3, options: [], steps: [], disabled: false, ...over });

afterEach(() => vi.useRealTimers());

test("sliders step by their step, by their steps when given, stay in range, and keep tidy decimals", () => {
  expect(nextValue(w({ start: 0, stop: 10 }), 3, "inc", 0)).toEqual({ value: 4, sub: 0, send: true });
  expect(nextValue(w({ start: 0, stop: 10 }), 9, "inc10", 0)?.value).toBe(10);
  expect(nextValue(w({ start: 0, stop: 1, step: 0.1 }), 0.3, "inc", 0)?.value).toBe(0.4);
  expect(nextValue(w({ start: 0, stop: 1 }), 0.5, "dec", 0)?.value).toBe(0.49);
  expect(nextValue(w({ start: 0, stop: 100, steps: [1, 5, 10, 50] }), 5, "inc", 0)?.value).toBe(10);
  expect(nextValue(w({ start: 0, stop: 10 }), 3, "toggle", 0)).toBeUndefined();
});

test("numbers, ranges, choices, checkboxes and buttons", () => {
  expect(nextValue(w({ kind: "number" }), 7, "dec10", 0)?.value).toBe(-3);
  expect(nextValue(w({ kind: "range-slider", start: 0, stop: 10 }), [2, 5], "inc", 1)).toEqual({ value: [2, 6], sub: 1, send: true });
  expect(nextValue(w({ kind: "range-slider", start: 0, stop: 10 }), [2, 5], "toggle", 0)).toMatchObject({ sub: 1, send: false });
  expect(nextValue(w({ kind: "range-slider", start: 0, stop: 10 }), [5, 5], "inc", 0)?.value).toEqual([5, 5]);
  expect(nextValue(w({ kind: "dropdown", options: ["a", "b"] }), ["b"], "inc", 0)?.value).toEqual(["a"]);
  expect(nextValue(w({ kind: "radio", options: ["a", "b"] }), "a", "dec", 0)?.value).toBe("b");
  expect(nextValue(w({ kind: "multiselect", options: ["a", "b", "c"] }), ["a"], "inc", 0)).toEqual({ value: ["a"], sub: 1, send: false });
  expect(nextValue(w({ kind: "multiselect", options: ["a", "b", "c"] }), ["a"], "toggle", 1)?.value).toEqual(["a", "b"]);
  expect(nextValue(w({ kind: "multiselect", options: ["a", "b", "c"] }), ["a", "b"], "toggle", 0)?.value).toEqual(["b"]);
  expect(nextValue(w({ kind: "checkbox" }), true, "inc", 0)?.value).toBe(false);
  expect(nextValue(w({ kind: "button" }), 2, "toggle", 0)?.value).toBe(3);
  expect(nextValue(w({ kind: "text" }), "x", "inc", 0)).toBeUndefined();
});

test("typed values are checked", () => {
  expect(typedValue(w({ kind: "number", start: 0, stop: 10 }), "12")).toEqual({ error: "Enter a number between 0 and 10." });
  expect(typedValue(w({ kind: "number" }), "x")).toEqual({ error: "Enter a number." });
  expect(typedValue(w({ kind: "number" }), " 4.5 ")).toEqual({ value: 4.5 });
  expect(typedValue(w({ kind: "date" }), "2024-1-2")).toEqual({ error: "Enter a date as YYYY-MM-DD." });
  expect(typedValue(w({ kind: "text" }), "hi there")).toEqual({ value: "hi there" });
});

test("a widget's line, with the value set since it was made", () => {
  const nb = new NotebookState();
  const slider = w({ start: 0, stop: 10 });
  expect(widgetValue(nb, slider)).toBe(3);
  nb.uiValues.set("a-0", 10);
  const line = widgetLine(slider, widgetValue(nb, slider), undefined, theme);
  expect(line).toBe(`n  ${"━".repeat(15)}●  10  0–10`);
  expect(widgetLine(w({ kind: "dropdown", options: ["One", "Two"], label: "" }), ["Two"], undefined, theme)).toBe("‹ Two ›  2 of 2");
  expect(widgetLine(w({ kind: "checkbox", label: "c", disabled: true }), false, undefined, theme)).toBe("c  [ ]  (disabled)");
  expect(widgetLine(w({ kind: "other", tag: "marimo-file-browser", label: "" }), [], undefined, theme)).toBe("[file-browser widget: o opens the notebook]");
});

test("the sender sends only a widget's last value, after the delay", async () => {
  vi.useFakeTimers();
  const sent: unknown[] = [];
  const sender = new WidgetSender(async (_t, id, value) => { sent.push([id, value]); }, 120);
  const target = { url: "http://h", sessionId: "s" };
  sender.set(target, "a-0", 1);
  sender.set(target, "a-0", 2);
  sender.set(target, "a-1", true);
  await vi.advanceTimersByTimeAsync(100);
  expect(sent).toEqual([]);
  sender.set(target, "a-0", 3);
  await vi.advanceTimersByTimeAsync(130);
  expect(sent).toEqual([["a-1", true], ["a-0", 3]]);
  sender.dispose();
});
