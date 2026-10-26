import { afterEach, beforeEach, expect, test, vi } from "vitest";
import piRecap, { ENTRY, LABEL, MARK, NAME_ENTRY, WIDGET, recapDue, recapLines } from "../src/index.ts";
import { harness } from "./harness.ts";

const LONG = "I changed the parser so empty lines are skipped.\n\nMore detail on a second line.";
let n = 0;
const user = (text: string) => ({ type: "message", id: `e${n++}`, message: { role: "user", content: text } });
const assistant = (text: string) => ({ type: "message", id: `e${n++}`, message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
const turns = (count: number) => Array.from({ length: count }, (_, i) => [user(`prompt ${i}`), assistant(LONG)]).flat();
const LINE = (text: string) => ` ${MARK}${LABEL}${text}`;

function setup(answer = "Fixed the parser; tests pass", prompts = 3) {
  const h = harness();
  const branch: any[] = turns(prompts);
  // Like Pi, an appended entry becomes the branch's leaf.
  const appendEntry = h.pi.appendEntry;
  h.pi.appendEntry = (customType: string, data: unknown) => {
    appendEntry(customType, data);
    branch.push({ type: "custom", id: `e${n++}`, customType, data });
  };
  let renderer: any;
  h.pi.registerEntryRenderer = (type: string, r: any) => { if (type === ENTRY) renderer = r; };
  piRecap(h.pi);
  const complete = vi.fn(async () => ({ stopReason: "stop", content: [{ type: "text", text: answer }] }));
  const modelRegistry = { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true, complete };
  const ctx = h.ctx({ sessionManager: { getBranch: () => branch, getSessionId: () => "s" }, modelRegistry, waitForIdle: async () => undefined });
  const settle = async (aborted = false) => {
    await h.emit("agent_before_settle", { type: "agent_before_settle" }, ctx);
    await h.emit("agent_settled", { type: "agent_settled", aborted }, ctx);
  };
  const ask = () => {
    let got: Promise<string | undefined> | undefined;
    h.pi.events.emit("recap:summary", { reply: (p: Promise<string | undefined>) => { got = p; } });
    return got;
  };
  const recaps = () => h.entries.filter((e) => e.customType === ENTRY).map((e: any) => e.data.text);
  const plainTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s };
  const render = (text: string, width = 200, theme: any = plainTheme) =>
    renderer({ customType: ENTRY, data: { text } }, { expanded: false }, theme).render(width);
  return { h, ctx, ui: ctx.ui, branch, complete, settle, ask, recaps, render };
}

beforeEach(() => {
  vi.useFakeTimers();
  delete process.env.PI_RECAP;
  delete process.env.PI_RECAP_DELAY_MS;
});
afterEach(() => vi.useRealTimers());

test("the recap is written into the transcript after the idle delay, and drawn like Claude Code's", async () => {
  const { h, ctx, ui, settle, complete, recaps, render } = setup();
  await h.emit("session_start", {}, ctx);
  await h.emit("agent_start", {}, ctx);
  await settle();
  await vi.advanceTimersByTimeAsync(179_000);
  expect(recaps()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(recaps()).toEqual(["Fixed the parser; tests pass"]);
  expect(complete).toHaveBeenCalledOnce();
  expect(ui.widgets.has(WIDGET)).toBe(false);
  expect(render("Fixed the parser; tests pass")).toEqual([LINE("Fixed the parser; tests pass")]);
  // It stays in the transcript when the next run starts.
  await h.emit("agent_start", {}, ctx);
  expect(recaps()).toHaveLength(1);
});

test("the whole line is dim bold, the text also italic", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => `<b>${s}</b>`, italic: (s: string) => `<i>${s}</i>` };
  const lines = setup().render("done", 200, theme);
  expect(lines).toEqual([" <dim><b>※ </b></dim><dim><b>recap: </b></dim><dim><b><i>done</i></b></dim>"]);
});

test("pi-herdr's request gets the same memoized text, with one model call", async () => {
  const { h, ctx, settle, complete, ask, recaps } = setup();
  await h.emit("session_start", {}, ctx);
  const herdr = ask();
  await settle();
  expect(await herdr).toBe("Fixed the parser; tests pass");
  expect(await ask()).toBe("Fixed the parser; tests pass");
  await vi.advanceTimersByTimeAsync(180_000);
  expect(recaps()).toEqual(["Fixed the parser; tests pass"]);
  // The recap entry itself does not start a new turn's recap.
  expect(await ask()).toBe("Fixed the parser; tests pass");
  expect(complete).toHaveBeenCalledOnce();
});

test("a long recap is whole and wrapped in the transcript, clipped only for pi-herdr's token", async () => {
  const long = `Fixed the parser to skip empty lines and reran the suite; ${"all tests pass ".repeat(4).trim()}`;
  const { h, ctx, settle, ask, recaps, render } = setup(long);
  await h.emit("session_start", {}, ctx);
  await settle();
  const token = (await ask())!;
  expect(token.length).toBe(80);
  expect(token.endsWith("…")).toBe(true);
  await vi.advanceTimersByTimeAsync(180_000);
  expect(recaps()).toEqual([long]);
  const lines = render(long, 60);
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.join(" ")).not.toContain("…");
  expect(lines.map((l: string) => l.trim()).join(" ")).toBe(`${MARK}${LABEL}${long}`.trim());
});

test("a new turn gets a new recap", async () => {
  const { h, ctx, branch, complete, ask, settle } = setup();
  await h.emit("session_start", {}, ctx);
  await settle();
  await ask();
  branch.push(user("and the writer"), assistant(LONG));
  await h.emit("agent_start", {}, ctx);
  await settle();
  await ask();
  expect(complete).toHaveBeenCalledTimes(2);
});

test("as in Claude Code, no automatic recap before 3 prompts, nor before 2 more since the last", async () => {
  const early = setup(undefined, 2);
  await early.h.emit("session_start", {}, early.ctx);
  await early.settle();
  await vi.advanceTimersByTimeAsync(200_000);
  expect(early.recaps()).toEqual([]);

  const { h, ctx, branch, settle, recaps } = setup("first");
  await h.emit("session_start", {}, ctx);
  await settle();
  await vi.advanceTimersByTimeAsync(200_000);
  expect(recaps()).toEqual(["first"]);
  branch.push(user("one more"), assistant(LONG));
  await settle();
  await vi.advanceTimersByTimeAsync(200_000);
  expect(recaps()).toHaveLength(1);
  branch.push(user("and another"), assistant(LONG));
  await settle();
  await vi.advanceTimersByTimeAsync(200_000);
  expect(recaps()).toHaveLength(2);

  expect(recapDue([...turns(3), { type: "custom", customType: ENTRY }])).toBe(false);
});

test("no automatic recap after an interrupted run, a short reply already on screen, a new run or PI_RECAP=0", async () => {
  const a = setup();
  await a.h.emit("session_start", {}, a.ctx);
  await a.settle(true);
  await vi.advanceTimersByTimeAsync(200_000);
  expect(a.recaps()).toEqual([]);

  const b = setup();
  b.branch.push(user("push it"), assistant("Pushed."));
  await b.h.emit("session_start", {}, b.ctx);
  await b.settle();
  await vi.advanceTimersByTimeAsync(200_000);
  expect(b.recaps()).toEqual([]);
  expect(await b.ask()).toBe("Pushed.");

  const c = setup();
  await c.h.emit("session_start", {}, c.ctx);
  await c.settle();
  await vi.advanceTimersByTimeAsync(60_000);
  await c.h.emit("agent_start", {}, c.ctx);
  await vi.advanceTimersByTimeAsync(200_000);
  expect(c.recaps()).toEqual([]);

  process.env.PI_RECAP = "0";
  const d = setup();
  await d.h.emit("session_start", {}, d.ctx);
  await d.settle();
  await vi.advanceTimersByTimeAsync(200_000);
  expect(d.recaps()).toEqual([]);
  expect(await d.ask()).toBe("Fixed the parser; tests pass");
});

test("PI_RECAP_DELAY_MS sets the delay", async () => {
  process.env.PI_RECAP_DELAY_MS = "10000";
  const { h, ctx, settle, recaps } = setup();
  await h.emit("session_start", {}, ctx);
  await settle();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(recaps()).toHaveLength(1);
});

test("non-interactive sessions stay dormant and answer no requests", async () => {
  const { h, ctx, settle, ask, complete } = setup();
  ctx.mode = "print";
  await h.emit("session_start", {}, ctx);
  await settle();
  expect(ask()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(200_000);
  expect(complete).not.toHaveBeenCalled();
});

test("/recap writes the recap at once, even early or for a short reply, and warns when there is nothing", async () => {
  const { h, ctx, ui, branch, recaps } = setup(undefined, 1);
  await h.emit("session_start", {}, ctx);
  await h.commands.get("recap").handler("", ctx);
  expect(recaps()).toEqual(["Fixed the parser; tests pass"]);
  expect(ui.widgets.has(WIDGET)).toBe(false);
  branch.push(user("push it"), assistant("Pushed."));
  await h.commands.get("recap").handler("", ctx);
  expect(recaps().at(-1)).toBe("Pushed.");
  branch.length = 0;
  await h.commands.get("recap").handler("", ctx);
  expect(recaps()).toHaveLength(2);
  expect(ui.widgets.has(WIDGET)).toBe(false);
  expect(ui.notes.at(-1)).toEqual({ message: "Nothing to recap yet", type: "warning" });
});

test("long recaps wrap under the label, at the prose measure when one is set", () => {
  const text = "one two three four five six seven eight nine ten";
  const lines = recapLines(text, 30, undefined, 0);
  expect(lines[0].startsWith(` ${MARK}${LABEL}`)).toBe(true);
  expect(lines.length).toBeGreaterThan(1);
  for (const l of lines.slice(1)) expect(l.startsWith(" ".repeat(1 + MARK.length)) && l[1 + MARK.length] !== " ").toBe(true);
  expect(recapLines(text, 200, undefined, 0)).toHaveLength(1);
  const measured = recapLines(text, 200, undefined, 20);
  expect(measured.length).toBeGreaterThan(1);
  for (const l of measured) expect(l.trimEnd().length).toBeLessThanOrEqual(3 + 20);
});

test("the session is named after the latest prompt, then the turn's recap; a name you set wins", async () => {
  const { h, ctx, settle } = setup("Fixed the parser; tests pass");
  await h.emit("session_start", {}, ctx);
  await h.emit("input", { type: "input", text: "/model", source: "interactive" }, ctx);
  expect(h.pi.getSessionName()).toBeUndefined();
  await h.emit("input", { type: "input", text: "  make the parser\nskip empty lines ", source: "interactive" }, ctx);
  expect(h.pi.getSessionName()).toBe("make the parser skip empty lines");
  await h.emit("agent_start", {}, ctx);
  await settle();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.pi.getSessionName()).toBe("Fixed the parser; tests pass");
  expect(h.entries.filter((e) => e.customType === NAME_ENTRY).map((e: any) => e.data.name)).toEqual([
    "make the parser skip empty lines",
    "Fixed the parser; tests pass",
  ]);
  // Your own name stays until you clear it.
  h.pi.setSessionName("Parser work");
  await h.emit("input", { type: "input", text: "now the lexer", source: "interactive" }, ctx);
  expect(h.pi.getSessionName()).toBe("Parser work");
  h.pi.setSessionName("");
  await h.emit("input", { type: "input", text: "now the lexer", source: "interactive" }, ctx);
  expect(h.pi.getSessionName()).toBe("now the lexer");
});

test("a resumed session recognizes its automatic name; PI_RECAP_NAME=0 leaves names alone", async () => {
  const { h, ctx } = setup();
  const entries = [{ type: "custom", customType: NAME_ENTRY, data: { name: "old recap" } }];
  (ctx.sessionManager as any).getEntries = () => entries;
  h.pi.setSessionName("old recap");
  await h.emit("session_start", {}, ctx);
  await h.emit("input", { type: "input", text: "next thing", source: "interactive" }, ctx);
  expect(h.pi.getSessionName()).toBe("next thing");
  process.env.PI_RECAP_NAME = "0";
  try {
    await h.emit("input", { type: "input", text: "another", source: "interactive" }, ctx);
    expect(h.pi.getSessionName()).toBe("next thing");
  } finally {
    delete process.env.PI_RECAP_NAME;
  }
});
