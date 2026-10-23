import { describe, expect, test } from "vitest";
import { type Scheme, type SchemeSource, type Timers, herdrNeedsResync, isSchemeSource, parseServerVersion, resync, ResyncNeed, schemeReport } from "../src/index.ts";

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

describe("standing down once Herdr is fixed", () => {
  test("Herdr versions up to 0.9.5 need the replays, later ones do not", () => {
    for (const v of ["0.9.3", "0.9.5", "v0.9.5", "0.8.12", "0.9.5-preview.1", undefined, "", "garbage"]) expect(herdrNeedsResync(v)).toBe(true);
    for (const v of ["0.9.6", "0.10.0", "1.0.0", "0.9.6-preview.2"]) expect(herdrNeedsResync(v)).toBe(false);
  });

  test("reads the running server's version from herdr status", () => {
    expect(parseServerVersion("status: running\nversion: 0.9.3\nendpoint_compatible: yes\n")).toBe("0.9.3");
    expect(parseServerVersion("status: stopped\n")).toBeUndefined();
  });

  test("follows the running server, keeps the last verdict on a failed read, and ignores non-Herdr terminals", async () => {
    let version: string | undefined = "0.9.5";
    const need = new ResyncNeed({ HERDR_ENV: "1", TERM_PROGRAM: "herdr", TERM_PROGRAM_VERSION: "0.9.6" }, async () => version);
    expect(need.get()).toBe(false); // the pane's version, until the server answers
    await need.refresh();
    expect(need.get()).toBe(true); // an older server than the pane claims
    version = "0.9.6";
    await need.refresh();
    expect(need.get()).toBe(false);
    version = undefined;
    await need.refresh();
    expect(need.get()).toBe(false);
    const outside = new ResyncNeed({ TERM_PROGRAM: "ghostty" }, async () => "0.9.6");
    await outside.refresh();
    expect(outside.get()).toBe(true);
  });

  test("skips the replays while not needed, and asks for a refresh on every report", () => {
    const tui = fakeTui();
    const clock = fakeTimers();
    let needed = false;
    let refreshes = 0;
    resync(tui.source, { delays: [250], timers: clock.timers, needed: () => needed, reported: () => refreshes++ });
    tui.report("dark");
    clock.advance(1000);
    expect(tui.consumed).toEqual([]);
    expect(refreshes).toBe(1);
    needed = true;
    tui.report("light");
    clock.advance(1000);
    expect(tui.consumed).toEqual(["\x1b[?997;2n"]);
    expect(refreshes).toBe(2);
  });
});
