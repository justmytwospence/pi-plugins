import { Container } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { createFocusProxy, findChatContainer, TranscriptPanels } from "../src/transcript.ts";

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
  expect(findChatContainer(root)).toBe(chat);
  for (const invalid of [undefined, {}, { children: [] }, new Container(), { children: [document] }]) {
    expect(findChatContainer(invalid)).toBeUndefined();
  }
  document.children[1] = child();
  expect(findChatContainer(root)).toBeUndefined();
  document.children[1] = new Container();
  (chat as any).removeChild = undefined;
  expect(findChatContainer(root)).toBeUndefined();
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
