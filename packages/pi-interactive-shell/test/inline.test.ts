import { Container } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import interactiveShell from "../src/index.ts";
import * as handoffModule from "../src/handoff.ts";

const descriptors = [process.stdin, process.stdout].map(stream => Object.getOwnPropertyDescriptor(stream, "isTTY"));
afterEach(() => {
  vi.restoreAllMocks();
  [process.stdin, process.stdout].forEach((stream, i) => {
    if (descriptors[i]) Object.defineProperty(stream, "isTTY", descriptors[i]!);
    else delete (stream as any).isTTY;
  });
});
const status = { output: "(interactive command exited with code 0)", exitCode: 0, cancelled: false, truncated: false as const };
function setup() {
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
  const handlers = new Map<string, any>(), events = new Map<string, any>();
  const pi = { on: (name: string, fn: any) => handlers.set(name, fn), sendMessage: vi.fn(), events: {
    on: (name: string, fn: any) => events.set(name, fn), emit: vi.fn(),
  } };
  const chat = new Container(), document = new Container(), root = new Container();
  document.addChild(new Container()); document.addChild(new Container()); document.addChild(chat); root.addChild(document);
  const tui = Object.assign(root, { requestRender: vi.fn() });
  let proxy: any;
  const custom = vi.fn((factory: any, _options?: unknown) => new Promise(resolve => { proxy = factory(tui, {}, {}, resolve); }));
  const ctx = { mode: "tui", hasUI: true, isIdle: () => true, ui: { custom } };
  interactiveShell(pi as any); handlers.get("session_start")({}, ctx);
  return { pi, handlers, events, ctx, chat, custom, proxy: () => proxy,
    bash: (excluded = false) => handlers.get("user_bash")({ command: "i true", cwd: "/tmp", excludeFromContext: excluded }, ctx) };
}

test.each([false, true])("inline manual completion returns immediately with only status (excluded=%s)", async excluded => {
  const panel = { focused: false, render: () => ["live"], invalidate() {}, handleInput: vi.fn(), dispose: vi.fn(), shutdown: vi.fn() };
  const frozen = { render: () => ["PRIVATE DISPLAY"], invalidate() {} };
  let finish!: (result: typeof status, snapshot: typeof frozen) => void;
  const handoff = vi.spyOn(handoffModule, "handoff").mockImplementation((_tui, _theme, _cmd, _cwd, done) => {
    finish = done; return panel as any;
  });
  const h = setup();
  const before = new Container(), after = new Container(); h.chat.addChild(before);
  const running = h.bash(excluded); h.chat.addChild(after);
  expect(h.custom.mock.calls[0][1]).toEqual({ overlay: false });
  expect(handoff.mock.calls[0].slice(5)).toEqual([true, true]);
  expect(h.chat.children).toEqual([before, panel, after]);
  expect(h.proxy()).not.toBe(panel); expect(h.proxy().render(80)).toEqual([]);
  h.proxy().focused = true; expect(panel.focused).toBe(true);
  h.proxy().handleInput("x"); expect(panel.handleInput).toHaveBeenCalledWith("x");
  finish(status, frozen);
  expect(await running).toEqual({ result: status });
  expect(h.chat.children).toEqual([before, frozen, after]);
  await new Promise(resolve => setImmediate(resolve)); expect(h.pi.sendMessage).not.toHaveBeenCalled();
  await h.handlers.get("session_shutdown")(); expect(h.chat.children).toEqual([before, after]);
});

test("exactly accepted inline suggestion continues once with status only", async () => {
  const frozen = { render: () => ["PRIVATE DISPLAY"], invalidate() {} };
  vi.spyOn(handoffModule, "handoff").mockImplementation((_tui, _theme, _cmd, _cwd, done) => {
    queueMicrotask(() => done(status, frozen));
    return { render: () => [], invalidate() {}, dispose() {}, handleInput() {}, focused: true } as any;
  });
  const h = setup();
  h.events.get("interactive-shell:suggestion-accepted")({ text: "!i true" });
  expect(await h.bash()).toEqual({ result: status });
  await new Promise(resolve => setImmediate(resolve));
  expect(h.pi.sendMessage).toHaveBeenCalledOnce();
  expect(JSON.stringify(h.pi.sendMessage.mock.calls)).not.toContain("PRIVATE DISPLAY");
  await h.bash();
  await new Promise(resolve => setImmediate(resolve));
  expect(h.pi.sendMessage).toHaveBeenCalledOnce();
});

test("shutdown during malformed-tree probe cannot launch fallback", async () => {
  const handoff = vi.spyOn(handoffModule, "handoff");
  const h = setup();
  h.ctx.ui.custom.mockImplementation((factory: any) => new Promise(resolve => { factory({}, {}, {}, resolve); }));
  const running = h.bash();
  await h.handlers.get("session_shutdown")();
  expect((await running).result.exitCode).toBe(1);
  expect(handoff).not.toHaveBeenCalled();
  expect(h.custom).toHaveBeenCalledOnce();
});
