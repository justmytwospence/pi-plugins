/**
 * Behaviour of the commands added on top of the upstream engine that the
 * Neovim oracle cannot check: swallowed arguments of unsupported commands,
 * Neovim 0.13's `il`/`al`, Replace mode's Backspace, labels and settings.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModalEditor } from "../src/index.js";
import type { ModalEditorOptions } from "../src/engine/modal-editor.js";
import { sendKeys, stubKeybindings, stubTheme, stubTui } from "./harness.js";

const ESC = "\x1b";

function editorWith(text: string, opts: ModalEditorOptions = {}, cursor?: [number, number]): ModalEditor {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings, opts);
  editor.setClipboardFn(() => undefined);
  editor.setClipboardReadFn(() => null);
  editor.setText(text);
  editor.handleInput(ESC);
  const state = (editor as unknown as { state: { cursorLine: number; cursorCol: number } }).state;
  state.cursorLine = cursor?.[0] ?? 0;
  state.cursorCol = cursor?.[1] ?? 0;
  return editor;
}

const type = (editor: ModalEditor, s: string) => sendKeys(editor, Array.from(s));
const label = (editor: ModalEditor) => editor.render(80).at(-1) ?? "";

describe("unsupported commands swallow their argument", () => {
  for (const [keys, why] of [
    ["qa", "macro recording"],
    ["@a", "macro playback"],
    ["ma", "marks"],
    ["'a", "mark jumps"],
    ["`a", "mark jumps"],
    ["zz", "scrolling"],
    ["ZZ", "write-quit"],
    ["]a", "bracket commands"],
    ["g'a", "g-mark jumps"],
  ] as const) {
    it(`${keys} (${why}) neither types text nor enters Insert mode`, () => {
      const editor = editorWith("foo bar");
      type(editor, keys);
      assert.equal(editor.getMode(), "normal");
      assert.equal(editor.getText(), "foo bar");
    });
  }

  it('"a names a register without typing it', () => {
    const editor = editorWith("foo bar");
    type(editor, '"ayw');
    assert.equal(editor.getText(), "foo bar");
    assert.equal(editor.getRegister(), "foo ");
    assert.equal(editor.getMode(), "normal");
  });

  it("an operator cancels on a mark motion and drops its argument", () => {
    const editor = editorWith("foo bar");
    type(editor, "d'ax");
    assert.equal(editor.getText(), "oo bar");
  });

  it("gU waits for a motion instead of letting i open Insert mode", () => {
    const editor = editorWith("foo bar");
    type(editor, "gUiw");
    assert.equal(editor.getText(), "FOO bar");
    assert.equal(editor.getMode(), "normal");
  });

  it("the pending argument shows in the mode label", () => {
    const editor = editorWith("foo");
    type(editor, "q");
    assert.match(label(editor), / NORMAL q_ $/);
    type(editor, '"');
    assert.match(label(editor), / NORMAL $/);
  });
});

describe("line text objects (Neovim 0.13 il / al)", () => {
  it("cil changes the line without its surrounding blanks", () => {
    const editor = editorWith("  foo bar  ", {}, [0, 4]);
    type(editor, `cilX${ESC}`);
    assert.equal(editor.getText(), "  X  ");
    assert.equal(editor.getRegister(), "foo bar");
  });

  it("dal deletes every line", () => {
    const editor = editorWith("a\nb", {}, [1, 0]);
    type(editor, "dal");
    assert.equal(editor.getText(), "");
    assert.equal(editor.getRegister(), "a\nb\n");
  });

  it("vil selects the trimmed line", () => {
    const editor = editorWith("  foo  ", {}, [0, 3]);
    type(editor, "vild");
    assert.equal(editor.getText(), "    ");
  });

  it("il wins over the targets.vim last modifier", () => {
    const editor = editorWith("  foo (x)", { targets: true }, [0, 3]);
    type(editor, "dil");
    assert.equal(editor.getText(), "  ");
  });
});

describe("Replace mode", () => {
  it("shows REPLACE and restores characters on Backspace", () => {
    const editor = editorWith("abcdef", {}, [0, 1]);
    type(editor, "RXYZ");
    assert.equal(editor.getText(), "aXYZef");
    assert.match(label(editor), / REPLACE $/);
    sendKeys(editor, ["\x7f", "\x7f"]);
    assert.equal(editor.getText(), "aXcdef");
    sendKeys(editor, [ESC]);
    assert.equal(editor.getMode(), "normal");
  });

  it("Backspace removes characters typed past the end", () => {
    const editor = editorWith("ab", {}, [0, 1]);
    type(editor, "RXYZ");
    assert.equal(editor.getText(), "aXYZ");
    sendKeys(editor, ["\x7f", "\x7f"]);
    assert.equal(editor.getText(), "aX");
  });

  it("is one undo step", () => {
    const editor = editorWith("abcdef", {}, [0, 0]);
    type(editor, `RXY${ESC}u`);
    assert.equal(editor.getText(), "abcdef");
  });
});

describe("surround.vim", () => {
  const opts = { surround: true };

  it("is off unless enabled: Visual S keeps Vim's line change", () => {
    const editor = editorWith("foo");
    type(editor, `vSx${ESC}`);
    assert.equal(editor.getText(), "x");
  });

  it("shows the keys and the tag prompt while waiting", () => {
    const editor = editorWith("foo bar", opts);
    type(editor, "ysiwtdi");
    assert.match(label(editor), / NORMAL ystdi_ $/);
    type(editor, "v>");
    assert.equal(editor.getText(), "<div>foo</div> bar");
  });

  it("Escape at the replacement cancels without changing text", () => {
    const editor = editorWith("foo bar", opts);
    type(editor, `ysiw${ESC}`);
    assert.equal(editor.getText(), "foo bar");
    assert.equal(editor.getMode(), "normal");
  });

  it("an added surround is one undo step", () => {
    const editor = editorWith("foo bar", opts);
    type(editor, "ysiw)u");
    assert.equal(editor.getText(), "foo bar");
  });

  it("keeps the unnamed register", () => {
    const editor = editorWith("(foo)", opts, [0, 2]);
    editor.setRegister("keep");
    type(editor, "ds(");
    assert.equal(editor.getText(), "foo");
    assert.equal(editor.getRegister(), "keep");
  });
});

describe("registers and selections", () => {
  it('"_ lasts for one command', () => {
    const editor = editorWith("abc", {}, [0, 0]);
    editor.setRegister("keep");
    type(editor, '"_xx');
    assert.equal(editor.getText(), "c");
    assert.equal(editor.getRegister(), "b");
  });

  it("gv after a Visual operator reselects the old span", () => {
    const editor = editorWith("hello world", {}, [0, 0]);
    type(editor, "vlyw");
    type(editor, "gv");
    assert.equal(editor.getMode(), "visual");
    type(editor, "d");
    assert.equal(editor.getText(), "llo world");
  });

  it("gi returns to where Insert mode was left", () => {
    const editor = editorWith("abc def", {}, [0, 0]);
    type(editor, `eaX${ESC}0giY${ESC}`);
    assert.equal(editor.getText(), "abcXY def");
  });
});

describe("display-line motion (row space)", () => {
  const long = `${"word ".repeat(30)}(inner text) tail`;

  it("surround and targets work on a wrapped line", () => {
    const editor = editorWith(long, { displayLineMotion: true, surround: true, targets: true });
    editor.render(40);
    type(editor, "ci(X");
    sendKeys(editor, [ESC]);
    assert.equal(editor.getText(), `${"word ".repeat(30)}(X) tail`);
    type(editor, "gg0ysiw]");
    assert.equal(editor.getText(), `[word] ${"word ".repeat(29)}(X) tail`);
    assert.ok(!editor.getText().includes("\n"));
  });

  it("gUip does not split the wrapped paragraph", () => {
    const editor = editorWith(long, { displayLineMotion: true });
    editor.render(40);
    type(editor, "gUip");
    assert.equal(editor.getText(), long.toUpperCase());
  });

  it("ysip and >> keep the wrapped line whole", () => {
    const editor = editorWith(`${long}\nnext`, { displayLineMotion: true, surround: true });
    editor.render(40);
    type(editor, "gg>>");
    assert.equal(editor.getText(), `  ${long}\nnext`);
    type(editor, "ggysip)");
    // surround.vim indents the pair like the first wrapped line.
    assert.equal(editor.getText(), `  (\n  ${long}\nnext\n  )`);
  });
});
