/** EX text-field controls are engine-local on both suite surfaces. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesKey } from "@earendil-works/pi-tui";
import { ModalEditor } from "../src/engine/modal-editor.js";
import { EmbeddedEditor, MainEditor, EDITOR_MODE } from "../src/index.js";
import { stubTui, stubTheme, stubKeybindings, sendKeys } from "./harness.js";

const ESC = "\x1b";
const controls = [
  { up: "\x15", down: "\x04", name: "legacy" },
  { up: "\x1b[117;5u", down: "\x1b[100;5u", name: "Kitty" },
];
const keybindings = {
  matches: (data: string, action: string) => action === "app.exit" && matchesKey(data, "ctrl+d"),
} as typeof stubKeybindings;

for (const keys of controls) {
  describe(`EX controls (${keys.name})`, () => {
    it("raw engine clears EX with CtrlU and no-ops CtrlD without host dispatch", () => {
      const editor = new ModalEditor(stubTui, stubTheme, keybindings);
      let exits = 0;
      let submissions = 0;
      editor.onCtrlD = () => exits++;
      editor.onSubmit = () => submissions++;
      for (const draft of ["", "unchanged draft"]) {
        editor.setText(draft);
        editor.enterInsertAtEnd();
        sendKeys(editor, [ESC, ":", "t", "r", "e", "e"]);
        editor.handleInput(keys.down);
        assert.equal(editor.getModeContext().ex, "tree");
        editor.handleInput(keys.up);
        assert.deepEqual(editor.getModeContext(), {
          state: "ex", mode: "normal", ex: "", pending: "", autocomplete: false,
        });
        editor.handleInput(keys.down);
        assert.equal(editor.getModeContext().ex, "");
        editor.handleInput("w");
        assert.equal(editor.getModeContext().ex, "w", "EX remains editable after clearing");
        assert.equal(editor.getText(), draft);
        editor.handleInput(ESC);
      }
      assert.equal(exits, 0);
      assert.equal(submissions, 0);
      editor.dispose();
    });

    for (const surface of ["main", "embedded"] as const) {
      it(`${surface} keeps empty/populated EX local and accepts a command after CtrlU`, () => {
        const scrolls: number[] = [];
        let exits = 0;
        let cancels = 0;
        const commands: string[] = [];
        const tui = Object.assign({}, stubTui, { scrollBy: (lines: number) => scrolls.push(lines) });
        const editor = surface === "main"
          ? new MainEditor(tui, stubTheme, keybindings)
          : new EmbeddedEditor({
              surface, tui, theme: stubTheme, keybindings,
              initialMode: "normal", scrollViewport: (direction) => scrolls.push(direction),
              onCancel: () => cancels++,
              onExCommand: (_name, _args, raw) => { commands.push(raw); return true; },
            });
        editor.onCtrlD = () => exits++;
        if (editor instanceof MainEditor) {
          editor.setCommandNamesFn(() => new Set(["tree"]));
          editor.setRunCommandFn((command) => { commands.push(command); });
        }
        editor.enterInsertAtEnd();
        sendKeys(editor, [ESC, ":", keys.down]);
        assert.equal(editor[EDITOR_MODE]().state, "ex");
        assert.equal(editor[EDITOR_MODE]().ex, "");
        sendKeys(editor, ["n", "o", "p", "e", keys.down]);
        assert.equal(editor[EDITOR_MODE]().ex, "nope");
        editor.handleInput(keys.up);
        assert.equal(editor[EDITOR_MODE]().state, "ex");
        assert.equal(editor[EDITOR_MODE]().ex, "");
        sendKeys(editor, ["t", "r", "e", "e", "\r"]);
        assert.deepEqual(commands, [surface === "main" ? "/tree" : "tree"]);
        assert.equal(editor[EDITOR_MODE]().state, "normal");
        assert.deepEqual(scrolls, []);
        assert.equal(exits, 0);
        assert.equal(cancels, 0);
        assert.equal(editor.getText(), "");
        editor.dispose();
      });
    }
  });
}
