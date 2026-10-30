import { Container } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { createFocusProxy, resolveTranscript, TranscriptPanels } from "../src/transcript.ts";

const child = () => ({ render: () => ["unrelated"], invalidate() {} });
function tree() {
  const root = new Container();
  const document = new Container();
  const chat = new Container();
  document.addChild(new Container()); document.addChild(new Container()); document.addChild(chat);
  root.addChild(document);
  return { root, document, chat };
}

test("resolves only the expected private document/chat shape", () => {
  const { root, chat, document } = tree();
  expect(resolveTranscript(root)).toEqual({ chat, source: "document-root" });
  for (const invalid of [undefined, {}, { children: [] }, new Container(), { children: [document] }]) {
    expect(resolveTranscript(invalid)).toHaveProperty("reason");
  }
  document.children[1] = child();
  expect(resolveTranscript(root)).toHaveProperty("reason");
  document.children[1] = new Container();
  (chat as any).removeChild = undefined;
  expect(resolveTranscript(root)).toHaveProperty("reason");
});

const view = (document: unknown, primary = true) => ({ primary, child: document, scrollTo() {} });

test("fullscreen resolves the mounted primary transcript, never root or nested chats", () => {
  const { document, chat } = tree();
  const other = tree();
  const tui = Object.assign(other.root, { mode: "fullscreen", getPrimaryScrollView: () => view(document) });
  expect(resolveTranscript(tui)).toEqual({ chat, source: "primary-scroll-view" });
});

test("before first frame skips empty implicit view for Sidebar-style nested primary", () => {
  const { document, chat } = tree();
  const nested: any = { entries: [{ component: { children: [view(tree().document, false), view(document)] } }] };
  nested.children = [nested]; // Cycle-safe.
  const implicit = { render: () => [], invalidate() {} };
  expect(resolveTranscript({ mode: "fullscreen", getPrimaryScrollView: () => view(implicit), layoutRoot: nested }))
    .toEqual({ chat, source: "primary-scroll-view" });
});

test("ambiguous, absent and malformed primary views fail closed", () => {
  const good = view(tree().document);
  for (const layoutRoot of [{ children: [good, view(tree().document)] }, { children: [view(tree().document, false)] }, { children: [view(new Container())] }]) {
    expect(resolveTranscript({ mode: "fullscreen", layoutRoot })).toHaveProperty("reason");
  }
  const malformed = new Container(); malformed.addChild(new Container());
  expect(resolveTranscript({ mode: "fullscreen", getPrimaryScrollView: () => view(malformed), layoutRoot: { children: [good] } }))
    .toMatchObject({ reason: "malformed primary transcript document" });
  const empty = view(new Container());
  for (const direct of [empty, view({ render: () => [], invalidate() {} })]) {
    expect(resolveTranscript({ mode: "fullscreen", getPrimaryScrollView: () => direct, layoutRoot: { children: [direct, good] } }))
      .toMatchObject({ reason: "malformed primary transcript document" });
  }
  expect(resolveTranscript({ mode: "fullscreen", getPrimaryScrollView: () => empty, layoutRoot: { children: [good] } }))
    .toMatchObject({ reason: "malformed primary transcript document" });
  // Arbitrary three-child documents without a primary view are not candidates.
  expect(resolveTranscript({ mode: "fullscreen", layoutRoot: tree().root })).toHaveProperty("reason");
});

test("diagnostics contain only bounded component metadata, never document text", () => {
  const secret = "SECRET command output editor draft";
  const malformed = new Container(); malformed.addChild({ render: () => [secret], invalidate() {}, text: secret } as any);
  const result = resolveTranscript({ mode: "fullscreen", getPrimaryScrollView: () => view(malformed), text: secret });
  expect(result).toMatchObject({ shape: { rendererMode: "fullscreen", documentChildCount: 1, documentChildren: ["Object"], primaryLookup: true } });
  expect(JSON.stringify(result)).not.toContain(secret);
  const root = new Container(); for (let i = 0; i < 100; i++) root.addChild(child());
  const info = resolveTranscript(root);
  expect("shape" in info && info.shape.rootChildren).toHaveLength(12);
});

test("replaces at the same index and cleans up only owned snapshots", () => {
  const { chat } = tree();
  const panels = new TranscriptPanels();
  const before = child(), after = child(), live = child(), frozen = child();
  chat.addChild(before); panels.insert(chat, live); chat.addChild(after);
  panels.replace(chat, live, frozen);
  expect(chat.children).toEqual([before, frozen, after]);
  const next = child(), final = child();
  panels.insert(chat, next); panels.replace(chat, next, final);
  expect(chat.children).toEqual([before, frozen, after, final]);
  panels.clear(); panels.clear();
  expect(chat.children).toEqual([before, after]);
});

test("a clear or rebuild never resurrects a removed live panel or snapshot", () => {
  const { chat } = tree();
  const panels = new TranscriptPanels();
  const live = child();
  panels.insert(chat, live); chat.clear();
  panels.replace(chat, live, child());
  expect(chat.children).toEqual([]);
  const next = child(); panels.insert(chat, next); panels.replace(chat, next, child());
  chat.clear(); const unrelated = child(); chat.addChild(unrelated);
  panels.clear(); expect(chat.children).toEqual([unrelated]);
});

test("focus proxy has zero rows and forwards only focus/input/disposal", () => {
  const panel = { focused: false, handleInput: vi.fn(), dispose: vi.fn() };
  const proxy = createFocusProxy(panel);
  expect(proxy.render(1)).toEqual([]);
  proxy.focused = true; expect(panel.focused).toBe(true);
  panel.focused = false; expect(proxy.focused).toBe(false);
  proxy.handleInput("secret"); expect(panel.handleInput).toHaveBeenCalledWith("secret");
  expect((proxy as any)[Symbol.for("pi-plugins.input-context.v1")]()).toBe("terminal");
  proxy.invalidate(); proxy.dispose(); expect(panel.dispose).toHaveBeenCalledOnce();
});
