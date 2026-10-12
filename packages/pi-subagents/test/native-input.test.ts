import { Editor } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { FleetView } from "../src/ui/fleet.ts";
import { ConversationViewer } from "../src/ui/viewer.ts";
import { INPUT_CONTEXT } from "../src/editor-contract.ts";
import { fakeRun, fakeUI, fakeTui, KEY, plain } from "./ui-helpers.ts";
const theme = { borderColor: (s: string) => s, selectList: { selectedPrefix: (s: string) => s, selectedText: (s: string) => s, description: (s: string) => s, scrollInfo: (s: string) => s, noMatch: (s: string) => s } };

test("actual native Editor retains h/j/k/l and Ctrl-U/D while Fleet is virtually selected", () => {
  const ui = fakeUI();
  const editor = new Editor(ui.tui as never, theme);
  ui.tui.focused = editor;
  const fleet = new FleetView({ runs: () => [fakeRun()], enabled: () => true, actions: () => ({}) });
  fleet.setUI(ui); fleet.update();
  try {
    for (const key of ["h", "j", "k", "l", "x", "b"]) {
      editor.setText("");
      expect(ui.press(KEY.down)).toBe(true);
      expect(ui.press(key)).toBe(false);
      editor.handleInput(key);
      expect(editor.getText()).toBe(key);
    }
    editor.setText("draft");
    expect(ui.press(KEY.down)).toBe(true);
    expect(ui.press("\x15")).toBe(false);
    editor.handleInput("\x15");
    expect(editor.getText()).toBe("");
    editor.setText("abc");
    expect(ui.press(KEY.down)).toBe(true);
    expect(ui.press("\x04")).toBe(false);
    editor.handleInput("\x1b[H"); editor.handleInput("\x04");
    expect(editor.getText()).toBe("bc");
  } finally { fleet.dispose(); }
});

test("native steering input retains edit keys while read-only Ctrl-U/D scroll exactly half pages", () => {
  const tui = fakeTui(27);
  const run = fakeRun({ child: {} as never });
  run.conversation.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") }] } });
  let steered = "";
  // Deliberately conflicting full-page bindings: literal Ctrl-U/D remain the half-page primary.
  const viewer = new ConversationViewer(tui, run, plain, () => undefined, { steer: (message) => { steered = message; return true; } }, { matches: (data, id) => id === "tui.select.pageUp" && data === "\x15" });
  viewer.focused = true;
  try {
    viewer.render(100);
    const bottom = (viewer as any).scroll;
    viewer.handleInput("\x15"); expect((viewer as any).scroll).toBe(bottom - 10);
    viewer.handleInput("\x04"); expect((viewer as any).scroll).toBe(bottom);
    viewer.handleInput("\x1b[5~"); expect((viewer as any).scroll).toBe(bottom - 20);
    viewer.handleInput(KEY.enter);
    expect(viewer[INPUT_CONTEXT]()).toBe("editor");
    for (const key of "draft") viewer.handleInput(key);
    viewer.handleInput("\x15");
    for (const key of "abc") viewer.handleInput(key);
    viewer.handleInput("\x01"); viewer.handleInput("\x04");
    viewer.handleInput(KEY.enter);
    expect(steered).toBe("bc");
    expect(viewer[INPUT_CONTEXT]()).toBe("viewer");
  } finally { viewer.dispose(); }
});

test("input callbacks contain asynchronous and synchronous stop/dismiss failures", async () => {
  const ui = fakeUI();
  ui.tui.focused = { getText: () => "", setText: () => undefined, [Symbol.for("pi-plugins.editor-mode.v1")]: () => ({ state: "normal", autocomplete: false }) };
  const run = fakeRun({ child: {} as never });
  const fleet = new FleetView({ runs: () => [run], enabled: () => true, actions: () => ({ stop: async () => { throw new Error("failed stop"); } }), dismissedAt: () => 0, dismiss: async () => { throw new Error("failed dismiss"); } });
  fleet.setUI(ui); fleet.update();
  ui.press(KEY.down); expect(ui.press("x")).toBe(true); expect(ui.press("x")).toBe(true);
  run.state.status = "failed"; run.state.endedAt = Date.now();
  expect(ui.press("x")).toBe(true);
  const viewer = new ConversationViewer(fakeTui(), fakeRun({ child: {} as never }), plain, () => undefined, { stop: async () => { throw new Error("failed viewer stop"); } });
  expect(() => { viewer.handleInput("x"); viewer.handleInput("x"); }).not.toThrow();
  await Promise.resolve(); await Promise.resolve();
  fleet.dispose(); viewer.dispose();
});
