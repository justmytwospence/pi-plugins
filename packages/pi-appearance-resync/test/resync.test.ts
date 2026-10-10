import { describe, expect, test } from "vitest";
import { type Scheme, type SchemeSource, type Timers, isSchemeSource, resync, schemeReport } from "../src/index.ts";

/** A TUI stand-in that, like pi-tui, hands consumed reports to every listener. */
function fakeTui() {
  const listeners = new Set<(scheme: Scheme) => void>();
  const consumed: string[] = [];
  const source: SchemeSource = {
    onTerminalColorSchemeChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    consumeTerminalColorSchemeReport(data) {
      consumed.push(data);
      const scheme: Scheme = data.endsWith("1n") ? "dark" : "light";
      for (const l of listeners) l(scheme);
      return true;
    },
  };
  /** The terminal reporting a change. */
  const report = (scheme: Scheme) => {
    for (const l of listeners) l(scheme);
  };
  return { source, consumed, report, listeners };
}

function fakeTimers() {
  let now = 0;
  let next = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set: (fn, ms) => {
      queue.set(next, { at: now + ms, fn });
      return next++;
    },
    clear: (handle) => void queue.delete(handle as number),
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...queue.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      queue.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  return { timers, advance, pending: () => queue.size };
}

describe("resync", () => {
  test("replays a report after each delay", () => {
    const tui = fakeTui();
    const clock = fakeTimers();
    resync(tui.source, { delays: [250, 1000], timers: clock.timers });
    tui.report("light");
    clock.advance(249);
    expect(tui.consumed).toEqual([]);
    clock.advance(1);
    expect(tui.consumed).toEqual([schemeReport("light")]);
    clock.advance(750);
    expect(tui.consumed).toEqual([schemeReport("light"), schemeReport("light")]);
    expect(clock.pending()).toBe(0);
  });

  test("does not replay its own replays", () => {
    const tui = fakeTui();
    const clock = fakeTimers();
    resync(tui.source, { delays: [250], timers: clock.timers });
    tui.report("dark");
    clock.advance(10_000);
    expect(tui.consumed).toEqual([schemeReport("dark")]);
  });

  test("a new report replaces the replays pending for the previous one", () => {
    const tui = fakeTui();
    const clock = fakeTimers();
    resync(tui.source, { delays: [250, 1000], timers: clock.timers });
    tui.report("light");
    clock.advance(100);
    tui.report("dark");
    clock.advance(10_000);
    expect(tui.consumed).toEqual([schemeReport("dark"), schemeReport("dark")]);
  });

  test("stopping unsubscribes and cancels pending replays", () => {
    const tui = fakeTui();
    const clock = fakeTimers();
    const stop = resync(tui.source, { delays: [250], timers: clock.timers });
    tui.report("light");
    stop();
    clock.advance(10_000);
    tui.report("dark");
    clock.advance(10_000);
    expect(tui.consumed).toEqual([]);
    expect(tui.listeners.size).toBe(0);
  });
});

test("schemeReport encodes mode 2031 reports", () => {
  expect(schemeReport("dark")).toBe("\x1b[?997;1n");
  expect(schemeReport("light")).toBe("\x1b[?997;2n");
});

test("isSchemeSource requires both hooks", () => {
  expect(isSchemeSource(fakeTui().source)).toBe(true);
  expect(isSchemeSource({ onTerminalColorSchemeChange: () => () => {} })).toBe(false);
  expect(isSchemeSource(undefined)).toBe(false);
});
