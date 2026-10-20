import { SkillInvocationMessageComponent, UserMessageComponent, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import stickyLastPrompt, {
  findTranscriptView,
  CLEAR_SENTINEL,
  OWNER,
  PinBar,
  WIDGET_ID,
  WRAPPER_TAG,
  collectAnchors,
  extractUserText,
  isClearSentinel,
  layoutRectOf,
  selectAnchor,
  type AnchorIndex,
} from "../src/index.ts";

// ─── Fakes ───

/** A pi-tui Container look-alike: `constructor.name` must be "Container" for recursion. */
class Container {
  children: unknown[] = [];
  render(width: number): string[] {
    return this.children.flatMap((child) => (child as { render(w: number): string[] }).render(width));
  }
}

class Block {
  constructor(
    readonly lines: string[],
    readonly tag?: { kind: "user"; text: string } | { kind: "skill"; name: string },
  ) {}
  render(): string[] {
    return this.lines;
  }
}

const classify = (child: unknown) => (child instanceof Block ? child.tag : undefined);

/** Real Pi message components by prototype (so `instanceof` holds) with canned rendering. */
function userMessage(text: string, lines: string[]): UserMessageComponent {
  return Object.assign(Object.create(UserMessageComponent.prototype) as UserMessageComponent, { text, children: [], render: () => lines });
}
function skillMessage(name: string, lines: string[]): SkillInvocationMessageComponent {
  return Object.assign(Object.create(SkillInvocationMessageComponent.prototype) as SkillInvocationMessageComponent, { skillBlock: { name }, children: [], render: () => lines });
}

function index(children: unknown[]): AnchorIndex {
  const result: AnchorIndex = { anchors: [], horizons: [] };
  collectAnchors(children, 80, 0, result, classify);
  return result;
}

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => `\x1b[48;5;236m${text}\x1b[49m`,
} as unknown as Theme;

type Entry = { component: unknown; hidden?: boolean; options?: Record<string, unknown> };

/** The fullscreen renderer surface sticky-last-prompt touches, with hasOverlay on the prototype. */
class FakeScreen {
  mode = "fullscreen";
  terminal = { columns: 80, rows: 30 };
  overlayStack: Entry[] = [];
  renders = 0;
  scrollTo: Array<{ top: number; options?: unknown }> = [];
  doc = new Container();
  sv = {
    scrollTop: 0,
    contentHeight: 0,
    child: this.doc,
    getContentWidth: (width: number) => width,
    scrollTo: (top: number, options?: unknown) => this.scrollTo.push({ top, options }),
  };
  hasOverlay(): boolean {
    return this.overlayStack.some((entry) => this.isOverlayVisible(entry));
  }
  isOverlayVisible(entry: Entry): boolean {
    return !entry.hidden;
  }
  getPrimaryScrollView() {
    return this.sv;
  }
  showOverlay(component: unknown, options: Record<string, unknown>) {
    const entry: Entry = { component, options };
    this.overlayStack.push(entry);
    return {
      hide: () => {
        this.overlayStack = this.overlayStack.filter((candidate) => candidate !== entry);
      },
      setHidden: (hidden: boolean) => {
        entry.hidden = hidden;
      },
      isHidden: () => !!entry.hidden,
      focus() {},
      unfocus() {},
      isFocused: () => false,
    };
  }
  requestRender() {
    this.renders++;
  }
}

function harness() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
  };
  const emit = async (event: string, ctx: unknown) => {
    for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
  };
  const screen = new FakeScreen();
  const notes: Array<{ message: string; type: string }> = [];
  const widgets = new Map<string, unknown>();
  const components = new Map<string, Component & { dispose?(): void }>();
  const ui = {
    theme,
    notify: (message: string, type: string) => notes.push({ message, type }),
    // Like SDK 1.1, the factory runs once on registration; replacement disposes its component.
    setWidget: (key: string, content: unknown) => {
      components.get(key)?.dispose?.();
      components.delete(key);
      widgets.delete(key);
      if (content !== undefined) {
        widgets.set(key, content);
        if (typeof content === "function") components.set(key, content(screen, ui.theme));
      }
    },
  };
  const ctx = { mode: "tui", hasUI: true, ui };
  return { pi: pi as unknown as ExtensionAPI, emit, screen, notes, widgets, components, ctx };
}

function bar(screen: FakeScreen) {
  return screen.overlayStack.find((entry) => entry.component instanceof PinBar)?.component as PinBar | undefined;
}

// ─── Anchors ───

test("anchors record every prompt's rows; other components only add height", () => {
  const chat = new Container();
  chat.children = [
    new Block(["a1", "a2"], { kind: "user", text: "first  prompt\n  here" }),
    new Block(["r1", "r2", "r3"]),
    new Block(["s1"], { kind: "skill", name: " review " }),
    new Block(["b1"], { kind: "user", text: "second" }),
  ];
  const result = index([new Block(["h1", "h2"]), chat]);
  expect(result.anchors.map(({ source: _source, ...anchor }) => anchor)).toEqual([
    { start: 2, end: 4, text: "first prompt here" },
    { start: 7, end: 8, text: "[skill] review" },
    { start: 8, end: 9, text: "second" },
  ]);
  expect(result.horizons).toEqual([]);
});

test("a clear sentinel takes no rows and records a horizon", () => {
  expect(isClearSentinel([CLEAR_SENTINEL])).toBe(true);
  expect(isClearSentinel(["\u0000other-marker\u0000"])).toBe(false);
  expect(isClearSentinel(["text"])).toBe(false);
  expect(isClearSentinel([])).toBe(false);
  const result = index([
    new Block(["a"], { kind: "user", text: "before" }),
    new Block([CLEAR_SENTINEL]),
    new Block(["b"], { kind: "user", text: "after" }),
  ]);
  expect(result.anchors.map(({ source: _source, ...anchor }) => anchor)).toEqual([
    { start: 0, end: 1, text: "before" },
    { start: 1, end: 2, text: "after" },
  ]);
  expect(result.horizons).toEqual([{ row: 1 }]);
});

test("the default classifier recognizes Pi's user and skill message components", () => {
  const result: AnchorIndex = { anchors: [], horizons: [] };
  collectAnchors([userMessage("hello  there", ["u1", "u2"]), skillMessage("review", ["s"]), new Block(["x"])], 80, 0, result);
  expect(result.anchors.map(({ source: _source, ...anchor }) => anchor)).toEqual([
    { start: 0, end: 2, text: "hello there" },
    { start: 2, end: 3, text: "[skill] review" },
  ]);
});

test("extractUserText reads strings and text parts only", () => {
  expect(extractUserText("hi")).toBe("hi");
  expect(extractUserText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("a\nb");
  expect(extractUserText(42)).toBe("");
});

test("the pin is the latest prompt fully above the viewport; a straddling prompt blanks the bar", () => {
  const result: AnchorIndex = {
    anchors: [
      { start: 0, end: 2, text: "one" },
      { start: 10, end: 13, text: "two" },
    ],
    horizons: [],
  };
  expect(selectAnchor(result, 0)).toBeUndefined();
  expect(selectAnchor(result, 2)?.text).toBe("one");
  expect(selectAnchor(result, 9)?.text).toBe("one");
  expect(selectAnchor(result, 10)).toBeUndefined(); // two starts exactly on the boundary
  expect(selectAnchor(result, 11)).toBeUndefined(); // two is crossing the edge
  expect(selectAnchor(result, 13)?.text).toBe("two");
});

test("a clear horizon hides earlier prompts until the viewport scrolls back above it", () => {
  const result: AnchorIndex = {
    anchors: [
      { start: 0, end: 1, text: "before" },
      { start: 5, end: 6, text: "after" },
    ],
    horizons: [{ row: 3 }],
  };
  expect(selectAnchor(result, 3)).toBeUndefined();
  expect(selectAnchor(result, 4)).toBeUndefined();
  expect(selectAnchor(result, 6)?.text).toBe("after");
  expect(selectAnchor(result, 2)?.text).toBe("before");
});

// ─── Pin bar ───

test("the bar renders one padded themed row, or nothing without text", () => {
  let text = "";
  const clicks: number[] = [];
  const pin = new PinBar(() => text, () => clicks.push(1));
  pin.setTheme(theme);
  expect(pin.render(20)).toEqual([]);
  expect(pin.renderedRows).toBe(0);
  text = "a prompt that is far too long for the bar";
  const [line] = pin.render(20);
  expect(line.startsWith("\x1b[48;5;236m")).toBe(true);
  expect(line).toContain("a prompt that i");
  expect(line).toContain("…");
  expect(visibleWidth(line)).toBe(20);
  expect(pin.renderedRows).toBe(1);
  pin.reset();
  expect(pin.render(20)).toEqual([]);
});

test("the bar owns a left press and click inside its row and nothing else", () => {
  const clicks: number[] = [];
  const pin = new PinBar(() => "pinned", () => clicks.push(1));
  pin.setTheme(theme);
  pin.render(40);
  const event = (overrides: Record<string, unknown>) =>
    ({ type: "click", button: "left", x: 3, y: 0, screenX: 3, screenY: 0, width: 40, height: 1, shift: false, alt: false, ctrl: false, ...overrides }) as TuiMouseEvent;
  expect(pin.handleMouse(event({ type: "press" }))).toEqual({ handled: true, render: false });
  expect(pin.handleMouse(event({}))).toEqual({ handled: true });
  expect(clicks).toEqual([1]);
  expect(pin.handleMouse(event({ button: "right" }))).toBeUndefined();
  expect(pin.handleMouse(event({ type: "wheel" }))).toBeUndefined();
  expect(pin.handleMouse(event({ y: 1 }))).toBeUndefined();
  expect(clicks).toEqual([1]);
});

// ─── Extension ───

test("fullscreen session: overlay shown, hasOverlay ignores only our bar, click jumps, shutdown restores", async () => {
  const h = harness();
  stickyLastPrompt(h.pi);
  await h.emit("session_start", h.ctx);
  expect([...h.widgets.keys()].some((key) => key.startsWith(`${WIDGET_ID}/`))).toBe(true);
  const pin = bar(h.screen);
  expect(pin).toBeDefined();
  expect(Object.hasOwn(h.screen, "hasOverlay")).toBe(true);
  expect((h.screen.hasOverlay as unknown as Record<symbol, unknown>)[WRAPPER_TAG]).toBe(OWNER);
  expect(h.screen.hasOverlay()).toBe(false);
  const other = h.screen.showOverlay({ render: () => [] }, {});
  expect(h.screen.hasOverlay()).toBe(true);
  other.hide();

  // Two prompts; the viewport sits below both: the bar pins the second one.
  const chat = new Container();
  chat.children = [userMessage("first", ["p1", "p2"]), new Block(["x", "x", "x"]), userMessage("second", ["q"])];
  h.screen.doc.children = [chat];
  h.screen.sv.scrollTop = 7;
  h.screen.sv.contentHeight = 6;
  expect(pin!.render(40)[0]).toContain("second");
  pin!.handleMouse({ type: "click", button: "left", x: 1, y: 0, screenX: 1, screenY: 0, width: 40, height: 1, shift: false, alt: false, ctrl: false });
  expect(h.screen.scrollTo).toEqual([{ top: 4, options: { disableFollow: true } }]);

  await h.emit("session_shutdown", h.ctx);
  expect(h.widgets.size).toBe(0);
  expect(bar(h.screen)).toBeUndefined();
  expect(Object.hasOwn(h.screen, "hasOverlay")).toBe(false);
  expect(pin!.render(40)).toEqual([]);
});

test("the pin re-derives after a transcript rebuild and a resize without polling", async () => {
  const h = harness();
  stickyLastPrompt(h.pi);
  await h.emit("session_start", h.ctx);
  const pin = bar(h.screen)!;
  const chat = new Container();
  chat.children = [userMessage("old", ["p"]), new Block(["x", "x"])];
  h.screen.doc.children = [chat];
  h.screen.sv.scrollTop = 2;
  h.screen.sv.contentHeight = 3;
  expect(pin.render(40)[0]).toContain("old");
  // Rebuild: Container.clear() replaces the children array at the same height.
  const rebuilt = new Container();
  rebuilt.children = [userMessage("new", ["p"]), new Block(["x", "x"])];
  h.screen.doc.children = [rebuilt];
  expect(pin.render(40)[0]).toContain("new");
  // Resize: the width key changes and the prompt's extent is measured again.
  h.screen.terminal.columns = 20;
  expect(pin.render(20)[0]).toContain("new");
  // Cleared: the horizon hides the pre-clear prompt while the viewport is below it.
  rebuilt.children.push(new Block([CLEAR_SENTINEL]));
  h.screen.doc.children = [...h.screen.doc.children];
  h.screen.sv.scrollTop = 3;
  expect(pin.render(20)).toEqual([]);
  h.screen.sv.scrollTop = 2;
  expect(pin.render(20)[0]).toContain("new");
});

test.each(["data", "accessor"])("an untagged own %s wrapper is chained and its exact descriptor restored", async (kind) => {
  const h = harness();
  const receivers: unknown[] = [];
  const foreign = function (this: FakeScreen) {
    receivers.push(this);
    return FakeScreen.prototype.hasOverlay.call(this);
  };
  Object.defineProperty(h.screen, "hasOverlay", kind === "data"
    ? { value: foreign, writable: false, enumerable: true, configurable: true }
    : { get: () => foreign, enumerable: true, configurable: true });
  const descriptor = Object.getOwnPropertyDescriptor(h.screen, "hasOverlay");
  stickyLastPrompt(h.pi);
  await h.emit("session_start", h.ctx);
  expect(h.notes).toEqual([]);
  expect(bar(h.screen)).toBeDefined();
  expect(h.screen.hasOverlay()).toBe(false);
  const dialog = h.screen.showOverlay({ render: () => [] }, {});
  expect(h.screen.hasOverlay()).toBe(true);
  expect(receivers).toEqual([h.screen]); // call the previous method with the real receiver
  dialog.hide();
  await h.emit("session_shutdown", h.ctx);
  expect(Object.getOwnPropertyDescriptor(h.screen, "hasOverlay")).toEqual(descriptor);
  expect(h.screen.hasOverlay).toBe(foreign);
});

test("a wrapper bearing our owner tag keeps this copy inactive without changing it", async () => {
  const h = harness();
  const tagged = Object.assign(() => true, { [WRAPPER_TAG]: OWNER });
  h.screen.hasOverlay = tagged;
  const descriptor = Object.getOwnPropertyDescriptor(h.screen, "hasOverlay");
  stickyLastPrompt(h.pi);
  await h.emit("session_start", h.ctx);
  expect(h.notes.at(-1)?.type).toBe("warning");
  expect(h.notes.at(-1)?.message).toMatch(/another copy already wraps/);
  expect(bar(h.screen)).toBeUndefined();
  await h.emit("session_shutdown", h.ctx);
  expect(Object.getOwnPropertyDescriptor(h.screen, "hasOverlay")).toEqual(descriptor);
});

test("a non-configurable own wrapper is preserved without mounting a scroll-blocking bar", async () => {
  const h = harness();
  Object.defineProperty(h.screen, "hasOverlay", { value: () => true, configurable: false });
  const descriptor = Object.getOwnPropertyDescriptor(h.screen, "hasOverlay");
  stickyLastPrompt(h.pi);
  await h.emit("session_start", h.ctx);
  expect(bar(h.screen)).toBeUndefined();
  await h.emit("session_shutdown", h.ctx);
  expect(Object.getOwnPropertyDescriptor(h.screen, "hasOverlay")).toEqual(descriptor);
});

test("cleanup never replaces a later accessor even if it returns our wrapper", async () => {
  const h = harness();
  stickyLastPrompt(h.pi);
  await h.emit("session_start", h.ctx);
  const ours = h.screen.hasOverlay;
  Object.defineProperty(h.screen, "hasOverlay", { get: () => ours, configurable: true });
  const later = Object.getOwnPropertyDescriptor(h.screen, "hasOverlay");
  await h.emit("session_shutdown", h.ctx);
  expect(Object.getOwnPropertyDescriptor(h.screen, "hasOverlay")).toEqual(later);
  expect((ours as unknown as Record<symbol, unknown>)[WRAPPER_TAG]).toBeUndefined();
  h.screen.showOverlay({ render: () => [] }, {});
  expect(h.screen.hasOverlay()).toBe(true);
});

test("a wrapper installed after ours is left in place on teardown and ours becomes pass-through", async () => {
  const h = harness();
  stickyLastPrompt(h.pi);
  await h.emit("session_start", h.ctx);
  const ours = h.screen.hasOverlay;
  const later = () => ours.call(h.screen);
  h.screen.hasOverlay = later;
  await h.emit("session_shutdown", h.ctx);
  expect(h.screen.hasOverlay).toBe(later);
  // Nothing visible is ours any more, and the released wrapper defers to the prototype.
  h.screen.showOverlay({ render: () => [] }, {});
  expect(h.screen.hasOverlay()).toBe(true);
});

test("a second sticky bar overlay is reported once and this bar stays blank", async () => {
  const h = harness();
  stickyLastPrompt(h.pi);
  await h.emit("session_start", h.ctx);
  const pin = bar(h.screen)!;
  const chat = new Container();
  chat.children = [userMessage("prompt", ["p"]), new Block(["x", "x"])];
  h.screen.doc.children = [chat];
  h.screen.sv.scrollTop = 2;
  expect(pin.render(40)[0]).toContain("prompt");
  h.screen.showOverlay({ render: () => ["other bar"] }, { anchor: "top-left", row: 0, col: 0, width: "100%", nonCapturing: true });
  expect(pin.render(40)).toEqual([]);
  expect(pin.render(40)).toEqual([]);
  expect(h.notes.filter((note) => /another top prompt bar/.test(note.message))).toHaveLength(1);
});

test("non-fullscreen and non-TUI sessions stay dormant", async () => {
  const h = harness();
  h.screen.mode = "regular";
  stickyLastPrompt(h.pi);
  await h.emit("session_start", h.ctx);
  expect(bar(h.screen)).toBeUndefined();
  const h2 = harness();
  stickyLastPrompt(h2.pi);
  await h2.emit("session_start", { ...h2.ctx, mode: "rpc" });
  expect(h2.widgets.size).toBe(0);
});

const leftClick: TuiMouseEvent = {
  type: "click", button: "left", x: 1, y: 0, screenX: 1, screenY: 0,
  width: 40, height: 1, shift: false, alt: false, ctrl: false,
};

test("bar lines fit zero, tiny and wide-character widths, and use the current theme", () => {
  let active = theme;
  const pin = new PinBar(() => "界界 e\u0301 👩‍💻 a long label", () => {});
  pin.setTheme(() => active);
  for (const width of [0, 1, 2, 3, 4, 5, 10, 40]) {
    const lines = pin.render(width);
    expect(lines.length).toBe(width === 0 ? 0 : 1);
    for (const line of lines) expect(visibleWidth(line)).toBe(width);
  }
  active = { ...theme, bg: (_color: string, text: string) => `\x1b[48;5;237m${text}\x1b[49m` } as unknown as Theme;
  pin.invalidate();
  expect(pin.render(40)[0]).toContain("\x1b[48;5;237m");
  expect(pin.handleMouse({ ...leftClick, x: -1 })).toBeUndefined();
  expect(pin.handleMouse({ ...leftClick, x: 40 })).toBeUndefined();
  for (const type of ["release", "drag", "move", "wheel"] as const) {
    expect(pin.handleMouse({ ...leftClick, type })).toBeUndefined();
  }
});

test("malformed renderers and zero-height prompts do not become jump targets", () => {
  const empty = new Block([], { kind: "user", text: "invisible" });
  const result = index([null, {}, { render: () => 7 }, { render: () => { throw new Error("gone"); } }, empty]);
  expect(result.anchors).toEqual([]);
  expect(result.horizons).toEqual([]);
  expect(selectAnchor(result, Number.NaN)).toBeUndefined();
  expect(selectAnchor(result, -1)).toBeUndefined();
});

test("only the exact clear marker has zero height; multiple clears use the latest horizon", () => {
  const result = index([
    new Block(["p"], { kind: "user", text: "one" }),
    new Block([CLEAR_SENTINEL]),
    new Block(["\u0000literal", "reply"]),
    new Block(["p"], { kind: "user", text: "two" }),
    new Block([CLEAR_SENTINEL]),
    new Block(["reply"]),
    new Block(["p"], { kind: "user", text: "three" }),
  ]);
  expect(result.horizons).toEqual([{ row: 1 }, { row: 4 }]);
  expect(selectAnchor(result, 4)).toBeUndefined();
  expect(selectAnchor(result, 3)).toBeUndefined(); // two is at the boundary
  expect(selectAnchor(result, 6)?.text).toBe("three");
});

test("nested same-height replacement, in-place text edits and skill expansion remeasure live", async () => {
  const h = harness();
  stickyLastPrompt(h.pi);
  await h.emit("session_start", h.ctx);
  const chat = new Container();
  chat.children = [userMessage("old", ["p"]), new Block(["x", "x"])];
  h.screen.doc.children = [chat];
  h.screen.sv.contentHeight = 3;
  h.screen.sv.scrollTop = 2;
  const pin = bar(h.screen)!;
  expect(pin.render(40)[0]).toContain("old");
  // Only the nested array changes; outer document and contentHeight remain identical.
  chat.children = [userMessage("new", ["p"]), new Block(["x", "x"])];
  expect(pin.render(40)[0]).toContain("new");
  Object.assign(chat.children[0]!, { text: "edited" });
  expect(pin.render(40)[0]).toContain("edited");
  chat.children[0] = skillMessage("review", ["s"]);
  expect(pin.render(40)[0]).toContain("[skill] review");
  Object.assign(chat.children[0]!, { render: () => ["s", "expanded", "body"] });
  expect(pin.render(40)).toEqual([]);
  h.screen.sv.scrollTop = 3;
  expect(pin.render(40)[0]).toContain("[skill] review");
});

test("resize uses content width (including scrollbar), rechecks visibility and prevents stale clicks", async () => {
  const h = harness();
  stickyLastPrompt(h.pi);
  await h.emit("session_start", h.ctx);
  const widths: number[] = [];
  const message = userMessage("wrapping", ["p"]);
  message.render = (width) => { widths.push(width); return width < 30 ? ["p", "p", "p", "p"] : ["p"]; };
  h.screen.doc.children = [message, new Block(["x", "x", "x", "x"])];
  h.screen.sv.getContentWidth = (width) => width - 1;
  h.screen.sv.scrollTop = 2;
  const pin = bar(h.screen)!;
  expect(pin.render(40)[0]).toContain("wrapping");
  expect(widths.at(-1)).toBe(79);
  h.screen.terminal.columns = 20;
  pin.handleMouse(leftClick); // resized after paint, before next paint
  expect(h.screen.scrollTo).toEqual([]);
  expect(pin.render(20)).toEqual([]);
  expect(widths.at(-1)).toBe(19);
  h.screen.sv.scrollTop = 4;
  expect(pin.render(20)[0]).toContain("wrapping");
});

test("clicks revalidate identity after same-label rebuild/clear and refresh moved offsets", async () => {
  const h = harness();
  stickyLastPrompt(h.pi);
  await h.emit("session_start", h.ctx);
  const before = new Block(["x", "x", "x"]);
  const message = userMessage("prompt", ["p"]);
  h.screen.doc.children = [before, message, new Block(["x", "x", "x"])];
  h.screen.sv.scrollTop = 7;
  const pin = bar(h.screen)!;
  pin.render(40);
  before.lines.push("more");
  pin.handleMouse(leftClick);
  expect(h.screen.scrollTo).toEqual([{ top: 3, options: { disableFollow: true } }]);
  h.screen.scrollTo.length = 0;
  h.screen.doc.children[1] = userMessage("prompt", ["p"]);
  pin.handleMouse(leftClick);
  expect(h.screen.scrollTo).toEqual([]);
  pin.render(40);
  h.screen.doc.children.push(new Block([CLEAR_SENTINEL]));
  h.screen.sv.scrollTop = 8;
  pin.handleMouse(leftClick);
  expect(h.screen.scrollTo).toEqual([]);
  expect(pin.render(40)).toEqual([]);
});

test("restart, stale factory, widget disposal and shutdown are idempotent", async () => {
  const h = harness();
  stickyLastPrompt(h.pi);
  await h.emit("session_start", h.ctx);
  const [key, factory] = [...h.widgets.entries()][0]!;
  const old = bar(h.screen)!;
  await h.emit("session_start", h.ctx);
  expect(h.widgets.size).toBe(1);
  expect(h.screen.overlayStack).toHaveLength(1);
  expect(old.render(20)).toEqual([]);
  await h.emit("session_shutdown", h.ctx);
  expect((factory as (screen: FakeScreen) => Component)(h.screen).render(20)).toEqual([]);
  expect(h.screen.overlayStack).toEqual([]);
  await h.emit("session_start", h.ctx);
  h.ctx.ui.setWidget(key, undefined); // host-driven disposal, not an extension shutdown event
  expect(h.screen.overlayStack).toEqual([]);
  expect(Object.hasOwn(h.screen, "hasOverlay")).toBe(false);
  await h.emit("session_shutdown", h.ctx);
  await h.emit("session_shutdown", h.ctx);
  expect(h.widgets.size).toBe(0);
});

test("an older copy's late teardown cannot remove a newer wrapper or widget", async () => {
  const old = harness();
  stickyLastPrompt(old.pi);
  await old.emit("session_start", old.ctx);
  const newer = harness();
  newer.ctx.ui = old.ctx.ui;
  stickyLastPrompt(newer.pi);
  await newer.emit("session_start", newer.ctx);
  expect(old.widgets.size).toBe(2); // duplicate owner yields, but has its own probe widget
  expect(old.screen.overlayStack).toHaveLength(1);
  expect(old.notes.at(-1)?.message).toMatch(/another copy already wraps/);
  const newerKey = [...old.widgets.keys()][1]!;
  const original = old.screen.hasOverlay;
  const later = () => original.call(old.screen);
  old.screen.hasOverlay = later;
  old.ctx.ui.setWidget(WIDGET_ID, ["upstream's widget"]);
  await old.emit("session_shutdown", old.ctx);
  expect(old.screen.hasOverlay).toBe(later);
  expect(old.widgets.has(newerKey)).toBe(true);
  expect(old.widgets.has(WIDGET_ID)).toBe(true);
  await newer.emit("session_shutdown", newer.ctx);
  expect(old.screen.hasOverlay).toBe(later);
  expect(old.widgets.has(WIDGET_ID)).toBe(true);
});

test("old TUI resources are released before rebinding to a non-TUI session", async () => {
  const h = harness();
  stickyLastPrompt(h.pi);
  await h.emit("session_start", h.ctx);
  await h.emit("session_start", { mode: "print", hasUI: false });
  expect(h.widgets.size).toBe(0);
  expect(h.screen.overlayStack).toEqual([]);
  expect(Object.hasOwn(h.screen, "hasOverlay")).toBe(false);
});

test("theme replacement reaches the existing overlay without rerunning the widget factory", async () => {
  const h = harness();
  stickyLastPrompt(h.pi);
  await h.emit("session_start", h.ctx);
  h.screen.doc.children = [userMessage("prompt", ["p"]), new Block(["x", "x"])];
  h.screen.sv.scrollTop = 2;
  const pin = bar(h.screen)!;
  expect(pin.render(40)[0]).toContain("\x1b[48;5;236m");
  h.ctx.ui.theme = { ...theme, bg: (_color: string, text: string) => `\x1b[48;5;237m${text}\x1b[49m` } as unknown as Theme;
  pin.invalidate();
  expect(pin.render(40)[0]).toContain("\x1b[48;5;237m");
});

test("one failed cleanup operation does not strand the widget or renderer wrapper", async () => {
  const h = harness();
  const show = h.screen.showOverlay.bind(h.screen);
  h.screen.showOverlay = (component, options) => {
    const handle = show(component, options);
    const hide = handle.hide;
    handle.hide = () => { hide(); throw new Error("terminal gone"); };
    return handle;
  };
  stickyLastPrompt(h.pi);
  await h.emit("session_start", h.ctx);
  await expect(h.emit("session_shutdown", h.ctx)).resolves.toBeUndefined();
  expect(h.widgets.size).toBe(0);
  expect(h.screen.overlayStack).toEqual([]);
  expect(Object.hasOwn(h.screen, "hasOverlay")).toBe(false);
  await expect(h.emit("session_shutdown", h.ctx)).resolves.toBeUndefined();
});

test("a non-extensible renderer stays inactive without leaving a probe", async () => {
  const h = harness();
  Object.freeze(h.screen);
  const symbols = Object.getOwnPropertySymbols(h.screen);
  stickyLastPrompt(h.pi);
  await h.emit("session_start", h.ctx);
  expect(bar(h.screen)).toBeUndefined();
  expect(Object.getOwnPropertySymbols(h.screen)).toEqual(symbols);
  expect(Object.hasOwn(h.screen, "hasOverlay")).toBe(false);
  await h.emit("session_shutdown", h.ctx);
});

test("layoutRectOf finds a nested component's rectangle in the last frame", () => {
  const transcript = {};
  const root = {
    component: {},
    rect: { x: 0, y: 0, width: 165, height: 50 },
    children: [
      { component: {}, rect: { x: 0, y: 0, width: 82, height: 50 }, children: [{ component: transcript, rect: { x: 0, y: 0, width: 82, height: 40 } }] },
      { component: {}, rect: { x: 83, y: 0, width: 82, height: 50 } },
    ],
  };
  expect(layoutRectOf(root, transcript)).toEqual({ x: 0, y: 0, width: 82, height: 40 });
  expect(layoutRectOf(root, {})).toBeUndefined();
  expect(layoutRectOf(undefined, transcript)).toBeUndefined();
});

test("findTranscriptView finds main's transcript under a split root while another view is primary", () => {
  const valid = (value: unknown): value is { scrollTop: number } => typeof (value as { scrollTop?: unknown })?.scrollTop === "number";
  const transcript = { scrollTop: 3, primary: true, child: { children: [] } };
  const side = { scrollTop: 0, primary: true, child: { render: () => [] } };
  const main = { children: [transcript, { children: [] }] };
  const split = { entries: [{ component: main }, { component: {} }, { component: { entries: [{ component: side }] } }] };
  expect(findTranscriptView(split, valid)).toBe(transcript);
  expect(findTranscriptView({ entries: [{ component: side }] }, valid)).toBeUndefined();
});
