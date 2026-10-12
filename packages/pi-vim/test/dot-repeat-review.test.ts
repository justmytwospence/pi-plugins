import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesKey } from "@earendil-works/pi-tui";
import { ModalEditor } from "../src/index.js";
import {
  createEditorWithSpy,
  createMultiLineEditor,
  sendKeys,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";
import { type NvimParityCase, runPiParityCase } from "./nvim-oracle.js";

const ESC = "\x1b";
const CTRL_R = "\x12";
const BRACKETED_PASTE = "\x1b[200~pasted\x1b[201~";

type EditorCtorArgs = ConstructorParameters<typeof ModalEditor>;

type MutableEditorState = {
  state?: { lines: string[]; cursorLine: number; cursorCol: number };
};

type AutocompleteProvider = {
  getSuggestions(
    lines: string[],
    line: number,
    col: number,
  ): Promise<{
    items: { value: string; label: string }[];
    prefix: string;
  } | null>;
  applyCompletion(
    lines: string[],
    line: number,
    col: number,
    item: unknown,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
};

type AutocompleteEditor = ModalEditor & {
  setAutocompleteProvider(provider: AutocompleteProvider): void;
  isShowingAutocomplete(): boolean;
};

function makeSubmitEditor(
  isSubmit: (data: string) => boolean = (data) => data === "\r",
): { editor: ModalEditor; submits: string[] } {
  const submits: string[] = [];
  const submitKeybindings = {
    matches: (data: string, action: string) =>
      action === "tui.input.submit" && isSubmit(data),
    getKeys: () => [] as string[],
  } as unknown as EditorCtorArgs[2];
  const editor = new ModalEditor(stubTui, stubTheme, submitKeybindings);
  (editor as unknown as { onSubmit: (text: string) => void }).onSubmit = (
    text: string,
  ) => submits.push(text);
  editor.setClipboardFn(() => undefined);
  editor.setClipboardReadFn(() => null);
  return { editor, submits };
}

function makeInterruptEditor(initialText: string): {
  editor: ModalEditor;
  setCursor(cursor: { line: number; col: number }): void;
  getEscapeLeaks(): number;
} {
  const keybindings = {
    matches: (data: string, action: string) =>
      action === "app.interrupt" && data === ESC,
    getKeys: () => [] as string[],
  } as unknown as EditorCtorArgs[2];
  const editor = new ModalEditor(stubTui, stubTheme, keybindings);
  editor.setClipboardFn(() => undefined);
  editor.setClipboardReadFn(() => null);
  editor.setText(initialText);
  editor.handleInput(ESC);

  let escapeLeaks = 0;
  (editor as unknown as { onEscape?: () => void }).onEscape = () => {
    escapeLeaks++;
  };

  const mutable = editor as unknown as MutableEditorState;
  const setCursor = ({ line, col }: { line: number; col: number }) => {
    if (!mutable.state) throw new Error("editor state unavailable");
    mutable.state.cursorLine = line;
    mutable.state.cursorCol = col;
  };
  setCursor({ line: 0, col: 0 });

  return { editor, setCursor, getEscapeLeaks: () => escapeLeaks };
}

function setRawEditorText(editor: ModalEditor, text: string): void {
  const mutable = editor as unknown as MutableEditorState;
  if (!mutable.state) throw new Error("editor state unavailable");
  mutable.state.lines = text.length === 0 ? [""] : text.split("\n");
  mutable.state.cursorLine = 0;
  mutable.state.cursorCol = 0;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("dot repeat review regressions", () => {
  it("repeats post-submit implicit insert without re-submitting", () => {
    const { editor, submits } = makeSubmitEditor();

    editor.handleInput(ESC);
    sendKeys(editor, ["i", "h", "i", "\r"]);
    assert.deepEqual(submits, ["hi"]);
    assert.equal(editor.getText(), "");
    assert.equal(editor.getMode(), "insert");

    // Post-submit typing runs in an implicit insert session, so it is now
    // dot-repeatable. The submit itself stays excluded, so replaying the
    // recorded insert re-types the text without ever submitting again.
    sendKeys(editor, ["o", "k", ESC, "0", "."]);

    assert.deepEqual(submits, ["hi"]); // no second submit
    assert.equal(editor.getText(), "okok"); // `.` re-inserted "ok"
    assert.equal(editor.getMode(), "normal");
  });

  it("does not re-submit when a Kitty-Enter ends an implicit insert", () => {
    // Pi maps the Kitty keyboard protocol's \x1b[13u to Enter/submit, exactly
    // like a legacy \r. If the implicit-insert recorder only excludes \r, the
    // Kitty-Enter gets captured and re-submits on replay: "a", Kitty-Enter,
    // "b", Esc, "." would submit twice.
    const KITTY_ENTER = "\x1b[13u";
    assert.ok(matchesKey(KITTY_ENTER, "enter")); // host treats it as submit
    const { editor, submits } = makeSubmitEditor((data) =>
      matchesKey(data, "enter"),
    );

    // A fresh editor opens in the startup implicit insert (no vim `i`).
    sendKeys(editor, ["a", KITTY_ENTER, "b", ESC]);
    assert.deepEqual(submits, ["a"]); // the Kitty-Enter submitted "a"
    assert.equal(editor.getText(), "b");
    assert.equal(editor.getMode(), "normal");

    // `.` repeats only the post-submit implicit insert ("b"); it must not
    // resurrect the captured Kitty-Enter and submit a second time.
    sendKeys(editor, ["0", "."]);
    assert.deepEqual(submits, ["a"]); // still exactly one submit
    assert.equal(editor.getText(), "bb");
  });

  it("keeps failed char-motion replay atomic and does not leak Escape", () => {
    const { editor, setCursor, getEscapeLeaks } = makeInterruptEditor(
      "a,b foo\nno comma line\nlast line",
    );

    sendKeys(editor, ["c", "f", ",", "d", "d", ESC]);
    assert.equal(editor.getText().split("\n")[0], "ddb foo");

    setCursor({ line: 1, col: 0 });
    const before = editor.getText();
    sendKeys(editor, ["."]);

    assert.equal(editor.getText(), before);
    assert.equal(getEscapeLeaks(), 0);
  });

  it("keeps rejected counted text-object replay atomic", () => {
    const { editor, setCursor, getEscapeLeaks } =
      makeInterruptEditor("(abc) tail");

    setCursor({ line: 0, col: 1 });
    sendKeys(editor, ["c", "i", "(", "x", ESC]);
    assert.equal(editor.getText(), "(x) tail");

    const before = editor.getText();
    sendKeys(editor, ["3", "."]);

    assert.equal(editor.getText(), before);
    assert.equal(getEscapeLeaks(), 0);
  });

  it("preserves redo history after failed replay rollback", () => {
    const { editor, setCursor, getEscapeLeaks } =
      makeInterruptEditor("(abc) tail");

    setCursor({ line: 0, col: 1 });
    sendKeys(editor, ["c", "i", "(", "x", ESC]);
    const changed = editor.getText();

    sendKeys(editor, ["u"]);
    const undone = editor.getText();
    assert.notEqual(undone, changed);

    sendKeys(editor, ["3", "."]);
    assert.equal(editor.getText(), undone);
    assert.equal(getEscapeLeaks(), 0);

    sendKeys(editor, [CTRL_R]);
    assert.equal(editor.getText(), changed);
  });

  it("drops stale recording when normal-mode bracketed paste cancels d/r", () => {
    for (const pending of ["d", "r"] as const) {
      const { editor } = createEditorWithSpy("abcdef");

      sendKeys(editor, [pending]);
      editor.handleInput(BRACKETED_PASTE);
      sendKeys(editor, ["x", "."]);

      assert.equal(editor.getText(), "cdef", pending);
    }
  });

  it("invalidates the prior recording across host setText resets", () => {
    const { editor } = createEditorWithSpy("");

    sendKeys(editor, ["i", "o", "l", "d"]);
    editor.setText("");
    // setText invalidates the in-flight `old` insert, so `.` never re-inserts
    // it; the post-reset implicit insert is independently repeatable instead.
    sendKeys(editor, ["n", "e", "w", ESC, "0", "."]);

    assert.equal(editor.getText(), "newnew");
    assert.ok(!editor.getText().includes("old"));
  });

  it("records identity text changes as the latest repeatable command", () => {
    const { editor } = createEditorWithSpy("Xfoo bar");

    sendKeys(editor, ["x", "0", "c", "w", "f", "o", "o", " ", ESC]);
    assert.equal(editor.getText(), "foo bar");

    sendKeys(editor, ["w", "."]);

    assert.equal(editor.getText(), "foo foo ");
  });

  it("repeats multiline O inserts in original line groups", () => {
    const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
    editor.setClipboardFn(() => undefined);
    editor.setClipboardReadFn(() => null);
    editor.setText("orig");
    editor.handleInput(ESC);

    sendKeys(editor, ["O", "\x1b[200~a\nb\x1b[201~", ESC, "3", "."]);

    assert.equal(editor.getText(), "a\na\nb\na\nb\na\nb\nb\norig");
  });

  it("cancels repeat recording for programmatic insertTextAtCursor changes", () => {
    const { editor } = createMultiLineEditor("alpha beta");

    sendKeys(editor, ["c", "w"]);
    editor.insertTextAtCursor("[Image #1] ");
    sendKeys(editor, [ESC, "0", "."]);

    // The host injection cancelled the in-flight `cw` recording, so `.` never
    // re-runs the change-word + placeholder injection (which would delete a
    // word and duplicate the placeholder). It falls back to the seed implicit
    // insert, leaving exactly one placeholder in the buffer.
    const text = editor.getText();
    assert.equal(text.match(/\[Image #1\]/g)?.length, 1);
    assert.ok(text.startsWith("alpha beta"));
  });

  it("does not resurrect repeat after a mid-insert host injection", () => {
    const { editor } = createMultiLineEditor("");

    sendKeys(editor, ["i", "a"]);
    editor.insertTextAtCursor("[H]");
    // The injection taints the session, so the continued `b` does not open a
    // fresh implicit recording. With no earlier completed change, `.` is inert.
    sendKeys(editor, ["b", ESC, "0", "."]);

    assert.equal(editor.getText(), "a[H]b");
  });

  it("clears the host taint on setText so later typing repeats again", () => {
    const { editor } = createMultiLineEditor("");

    sendKeys(editor, ["i", "a"]);
    editor.insertTextAtCursor("[H]"); // taints the session
    editor.setText(""); // full host reset clears the taint
    sendKeys(editor, ["z", ESC, "0", "."]);

    assert.equal(editor.getText(), "zz");
  });

  it("cancels repeat recording for async autocomplete Tab acceptance", async () => {
    const { editor } = createMultiLineEditor("");
    const autocompleteEditor = editor as AutocompleteEditor;

    autocompleteEditor.setAutocompleteProvider({
      async getSuggestions(lines, line, col) {
        const before = (lines[line] ?? "").slice(0, col);
        const match = before.match(/^\/(\w*)$/);
        if (!match || !"help".startsWith(match[1] ?? "")) return null;
        return {
          items: [{ value: "/help", label: "/help" }],
          prefix: `/${match[1]}`,
        };
      },
      applyCompletion(lines, line, col, _item, prefix) {
        const current = lines[line] ?? "";
        const before = current.slice(0, col - prefix.length);
        const after = current.slice(col);
        const inserted = "/help ";
        const next = [...lines];
        next[line] = before + inserted + after;
        return {
          lines: next,
          cursorLine: line,
          cursorCol: (before + inserted).length,
        };
      },
    });

    sendKeys(editor, ["i", "/", "h", "e"]);
    await wait(40);
    assert.equal(autocompleteEditor.isShowingAutocomplete(), true);

    sendKeys(editor, ["\t", ESC]);
    assert.equal(editor.getText(), "/help ");

    setRawEditorText(editor, "");
    sendKeys(editor, ["."]);
    await wait(60);

    assert.equal(editor.getText(), "");
  });
});

describe("implicit insert dot repeat", () => {
  function makeBareEditor(): ModalEditor {
    const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
    editor.setClipboardFn(() => undefined);
    editor.setClipboardReadFn(() => null);
    return editor;
  }

  it("repeats typing done in the startup implicit insert", () => {
    // A fresh editor opens directly in insert mode with no vim `i` entry, so
    // the first keystroke synthesizes one and the run becomes repeatable.
    const editor = makeBareEditor();

    sendKeys(editor, ["h", "i", ESC]);
    assert.equal(editor.getText(), "hi");
    assert.equal(editor.getMode(), "normal");

    sendKeys(editor, ["0", "."]);
    assert.equal(editor.getText(), "hihi");
  });

  it("count before . repeats the implicit insert count times", () => {
    const editor = makeBareEditor();

    sendKeys(editor, ["X", ESC, "0", "3", "."]);

    assert.equal(editor.getText(), "XXXX");
  });

  it("records nothing when an empty implicit insert is escaped", () => {
    const editor = makeBareEditor();

    sendKeys(editor, [ESC, "."]);

    assert.equal(editor.getText(), "");
    assert.equal(editor.getMode(), "normal");
  });

  it("repeats an implicit insert containing a newline", () => {
    const editor = makeBareEditor();

    // `\n` inserts a line inside the prompt (only `\r` submits), so a
    // multi-line implicit insert replays as a multi-line change.
    sendKeys(editor, ["a", "\n", "b", ESC]);
    assert.equal(editor.getText(), "a\nb");

    sendKeys(editor, ["."]);
    assert.equal(editor.getText(), "a\na\nbb");
  });
});

// Parity-style check: an implicit insert must dot-repeat byte-identically to
// pressing `i` in normal mode — that is the whole contract of the synthetic
// entry. The nvim oracle drives its own insert seed with `startinsert`, whose
// feedkeys interaction mis-consumes the first keys, so it cannot faithfully
// replay an implicit session. Instead we anchor to the explicit `i` form,
// which the nvim-parity suite already validates against real nvim, and assert
// the implicit variant lands on the same final state.
describe("implicit insert dot repeat parity", () => {
  const PARITY_PAYLOADS: {
    name: string;
    text: string;
    cursor: { line: number; col: number };
    insert: string[];
    tail: string[];
  }[] = [
    {
      name: "typed run replayed at line start",
      text: "",
      cursor: { line: 0, col: 0 },
      insert: ["h", "i"],
      tail: ["0", "."],
    },
    {
      name: "counted replay of a single char",
      text: "",
      cursor: { line: 0, col: 0 },
      insert: ["X"],
      tail: ["0", "3", "."],
    },
    {
      name: "replay at end of pre-existing text",
      text: "abc",
      cursor: { line: 0, col: 0 },
      insert: ["Z", "Y"],
      tail: ["$", "."],
    },
    {
      name: "replay after a word motion",
      text: "one two",
      cursor: { line: 0, col: 0 },
      insert: ["Q", " "],
      tail: ["w", "."],
    },
  ];

  for (const payload of PARITY_PAYLOADS) {
    it(payload.name, () => {
      const implicit: NvimParityCase = {
        name: `${payload.name} (implicit)`,
        initial: { text: payload.text, cursor: payload.cursor, mode: "insert" },
        keys: [...payload.insert, ESC, ...payload.tail],
      };
      const explicit: NvimParityCase = {
        name: `${payload.name} (explicit i)`,
        initial: { text: payload.text, cursor: payload.cursor, mode: "normal" },
        keys: ["i", ...payload.insert, ESC, ...payload.tail],
      };

      assert.deepEqual(runPiParityCase(implicit), runPiParityCase(explicit));
    });
  }
});
