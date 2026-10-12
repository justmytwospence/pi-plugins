/**
 * Suite integration tests: the editor factory protocol, the two surfaces'
 * lifecycle and input ownership, the mode context other components read, the
 * draft snapshot API, the insert hook and the duplicate-install diagnostic.
 * The engine itself is covered by the imported upstream tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import installPiVim, {
  DUPLICATE_WARNING,
  EDITOR_FACTORY_CHANNEL,
  EDITOR_INSERT,
  EDITOR_MODE,
  EDITOR_SNAPSHOT,
  EDITOR_SURFACE,
  type EditorFactoryOptions,
  type EditorFactoryRequest,
  type EditorSnapshot,
  EmbeddedEditor,
  INPUT_CONTEXT,
  MainEditor,
  MODE_CHANGE_EVENT,
  ModalEditor,
  PROVIDER_NAME,
  readEditorMode,
  readEditorSurface,
  readInputContext,
  type SuiteEditor,
} from "../src/index.js";
import { setPiVimSettingsReaderForTests } from "../src/engine/settings.js";
import {
  createCursorShapeTui,
  createExtensionApiHarness,
  type ExtensionApiHarness,
  sendKeys,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

const ESC = "\x1b";
const CTRL_U = "\x15";
const CTRL_D = "\x04";
const INSERT_SHAPE = "\x1b[5 q";
const BLOCK_SHAPE = "\x1b[1 q";
const RESET_SHAPE = "\x1b[0 q";

type EditorFactory = (
  tui: typeof stubTui,
  theme: typeof stubTheme,
  keybindings: typeof stubKeybindings,
) => MainEditor;

type Notification = { message: string; type: string };

type Installed = {
  pi: ExtensionApiHarness;
  ctx: {
    cwd: string;
    hasUI: boolean;
    mode: string;
    ui: Record<string, unknown>;
    shutdown(): void;
  };
  notifications: Notification[];
  readonly shutdownCalls: number;
  editorFactory(): EditorFactory;
  start(): Promise<void>;
  shutdown(reason?: string): Promise<void>;
  request(): EditorFactoryRequest;
  embedded(
    overrides?: Partial<EditorFactoryOptions> & { tui?: unknown },
  ): { editor: SuiteEditor; calls: EmbeddedCalls };
};

type EmbeddedCalls = {
  submitted: string[];
  cancels: number;
  scrolls: number[];
  ex: Array<[string, string, string]>;
  notices: Notification[];
};

/** Install the extension against a harness whose ctx mimics Pi's TUI surface. */
function install(options: { existingFactory?: unknown } = {}): Installed {
  const pi = createExtensionApiHarness();
  const notifications: Notification[] = [];
  let factory: EditorFactory | undefined;
  let shutdownCalls = 0;
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui",
    ui: {
      theme: stubTheme,
      setEditorComponent(next: EditorFactory | undefined): void {
        factory = next;
      },
      getEditorComponent(): unknown {
        return factory ?? options.existingFactory;
      },
      notify(message: string, type: string): void {
        notifications.push({ message, type });
      },
    },
    shutdown(): void {
      shutdownCalls++;
    },
  };
  installPiVim(pi);
  const installed: Installed = {
    pi,
    ctx,
    notifications,
    get shutdownCalls() {
      return shutdownCalls;
    },
    editorFactory() {
      if (!factory) throw new Error("no editor factory installed");
      return factory;
    },
    async start() {
      await pi.emit("session_start", undefined, ctx);
    },
    async shutdown(reason?: string) {
      await pi.emit("session_shutdown", { type: "session_shutdown", reason }, ctx);
    },
    request() {
      const request: EditorFactoryRequest = { version: 1 };
      pi.events.emit(EDITOR_FACTORY_CHANNEL, request);
      return request;
    },
    embedded(overrides = {}) {
      const request = installed.request();
      assert.ok(request.factory, "expected an answered factory request");
      const calls: EmbeddedCalls = {
        submitted: [],
        cancels: 0,
        scrolls: [],
        ex: [],
        notices: [],
      };
      const editor = request.factory({
        surface: "embedded",
        tui: stubTui,
        theme: stubTheme,
        keybindings: stubKeybindings,
        onSubmit: (text) => calls.submitted.push(text),
        onCancel: () => calls.cancels++,
        scrollViewport: (direction) => calls.scrolls.push(direction),
        onExCommand: (name, args, raw) => {
          calls.ex.push([name, args, raw]);
          return false;
        },
        notify: (message, type) => calls.notices.push({ message, type }),
        ...(overrides as Partial<EditorFactoryOptions>),
      });
      return { editor, calls };
    },
  };
  return installed;
}

async function started(options: { existingFactory?: unknown } = {}) {
  const installed = install(options);
  await installed.start();
  return installed;
}

/** Type text in Insert mode, then Escape and `0`: idle Normal at column 0. */
function seed(editor: SuiteEditor | ModalEditor, text: string): void {
  for (const char of text) editor.handleInput(char);
  editor.handleInput(ESC);
  editor.handleInput("0");
}

function mode(editor: SuiteEditor) {
  return editor[EDITOR_MODE]();
}

function scrollableTui(rows = 40) {
  const scrolls: number[] = [];
  const tui = {
    requestRender() {},
    terminal: { rows, cols: 120 },
    scrollBy(lines: number) {
      scrolls.push(lines);
    },
  } as unknown as typeof stubTui;
  return { tui, scrolls };
}

const interruptKeybindings = {
  matches: (data: string, action: string) =>
    action === "app.interrupt" && data === ESC,
} as unknown as typeof stubKeybindings;

describe("editor factory protocol", () => {
  it("leaves a request unanswered before session_start and after shutdown", async () => {
    const installed = install();
    assert.deepEqual(installed.request(), { version: 1 });

    await installed.start();
    const answered = installed.request();
    assert.equal(typeof answered.factory, "function");
    assert.equal(answered.provider, PROVIDER_NAME);

    await installed.shutdown();
    assert.deepEqual(installed.request(), { version: 1 });
  });

  it("rejects a retained factory after session replacement or shutdown", async () => {
    const installed = await started();
    const old = installed.request().factory!;
    await installed.start();
    assert.throws(() => old({ surface: "embedded", tui: stubTui, theme: stubTheme, keybindings: stubKeybindings }), /no longer active/);
    const live = installed.request().factory!;
    await installed.shutdown();
    assert.throws(() => live({ surface: "embedded", tui: stubTui, theme: stubTheme, keybindings: stubKeybindings }), /no longer active/);
  });

  it("does not install or answer in non-TUI modes", async () => {
    for (const mode of ["rpc", "json", "print"]) {
      const installed = install();
      installed.ctx.mode = mode;
      await installed.start();
      assert.deepEqual(installed.request(), { version: 1 });
      assert.throws(() => installed.editorFactory(), /no editor factory/);
    }
  });

  it("leaves an already answered request alone", async () => {
    const installed = await started();
    const other = () => {
      throw new Error("must not be called");
    };
    const request: EditorFactoryRequest = {
      version: 1,
      factory: other,
      provider: "other",
    };
    installed.pi.events.emit(EDITOR_FACTORY_CHANNEL, request);
    assert.equal(request.factory, other);
    assert.equal(request.provider, "other");
  });

  it("ignores payloads that are not a version 1 request", async () => {
    const installed = await started();
    for (const payload of [undefined, null, 1, "x", {}, { version: 2 }]) {
      assert.doesNotThrow(() =>
        installed.pi.events.emit(EDITOR_FACTORY_CHANNEL, payload),
      );
    }
  });

  it("creates both surfaces with validated options", async () => {
    const installed = await started();
    const { factory } = installed.request();
    assert.ok(factory);
    const main = factory({
      surface: "main",
      tui: stubTui,
      theme: stubTheme,
      keybindings: stubKeybindings,
    });
    assert.ok(main instanceof MainEditor);
    assert.equal(main[EDITOR_SURFACE], "main");
    assert.throws(
      () => factory({ surface: "embedded" } as EditorFactoryOptions),
      TypeError,
    );
    const { editor } = installed.embedded();
    assert.ok(editor instanceof EmbeddedEditor);
    assert.ok(editor instanceof ModalEditor);
    assert.equal(editor[EDITOR_SURFACE], "embedded");
    assert.equal(editor[INPUT_CONTEXT](), "editor");
    assert.equal(readEditorSurface(editor), "embedded");
    assert.equal(readInputContext(editor), "editor");
    assert.equal(readEditorMode(editor)?.state, "insert");
    assert.equal(typeof editor.getCursor, "function");
    assert.equal(typeof editor.getLines, "function");
    assert.equal(typeof editor.isShowingAutocomplete, "function");
    assert.equal(typeof editor.dispose, "function");
  });

  it("installs the main editor through setEditorComponent with the main surface", async () => {
    const installed = await started();
    const editor = installed.editorFactory()(stubTui, stubTheme, stubKeybindings);
    assert.ok(editor instanceof MainEditor);
    assert.equal(editor[EDITOR_SURFACE], "main");
    assert.equal(readEditorSurface(editor), "main");
    assert.equal(readInputContext(editor), "editor");
    assert.equal(typeof editor[EDITOR_SNAPSHOT].capture, "function");
    assert.equal(typeof editor[EDITOR_INSERT], "function");
  });

  it("registers only session_start and session_shutdown handlers", () => {
    const installed = install();
    assert.equal(installed.pi.handlersFor("session_start").length, 1);
    assert.equal(installed.pi.handlersFor("session_shutdown").length, 1);
    assert.equal(installed.pi.handlersFor("session_end").length, 0);
  });

  it("reads contract helpers tolerantly", () => {
    assert.equal(readInputContext(null), undefined);
    assert.equal(readInputContext({ [INPUT_CONTEXT]: "list" }), "list");
    assert.equal(readInputContext({ [INPUT_CONTEXT]: () => "viewer" }), "viewer");
    assert.equal(readInputContext({ [INPUT_CONTEXT]: () => "other" }), undefined);
    assert.equal(readEditorSurface({}), undefined);
    assert.equal(readEditorMode({}), undefined);
  });
});

describe("mode context substates", () => {
  it("reports insert, idle normal, visual and visual-line", async () => {
    const { editor } = (await started()).embedded();
    assert.deepEqual(mode(editor), {
      state: "insert",
      mode: "insert",
      pending: "",
      ex: null,
      autocomplete: false,
    });
    seed(editor, "hello world");
    assert.deepEqual(mode(editor), {
      state: "normal",
      mode: "normal",
      pending: "",
      ex: null,
      autocomplete: false,
    });
    editor.handleInput("v");
    assert.equal(mode(editor).state, "visual");
    assert.equal(mode(editor).mode, "visual");
    editor.handleInput("V");
    assert.equal(mode(editor).state, "visual");
    assert.equal(mode(editor).mode, "visual-line");
    editor.handleInput(ESC);
    assert.equal(mode(editor).state, "normal");
  });

  it("reports every pending prefix as typed", async () => {
    const { editor } = (await started()).embedded();
    seed(editor, "alpha beta gamma");
    const cases: Array<[string[], string]> = [
      [["2"], "2"],
      [["2", "d"], "2d"],
      [["2", "d", "3"], "2d3"],
      [["d", "2", "f"], "d2f"],
      [["d", "i"], "di"],
      [["c", "a"], "ca"],
      [["y", "t"], "yt"],
      [["f"], "f"],
      [["g"], "g"],
      [["3", "g"], "3g"],
      [["r"], "r"],
      [["2", "r"], "2r"],
    ];
    for (const [keys, expected] of cases) {
      sendKeys(editor, keys);
      const context = mode(editor);
      assert.equal(context.state, "pending", keys.join(""));
      assert.equal(context.pending, expected, keys.join(""));
      assert.equal(context.mode, "normal");
      editor.handleInput(ESC);
      assert.equal(mode(editor).state, "normal", `after ${keys.join("")}`);
      assert.equal(mode(editor).pending, "");
    }
    assert.equal(editor.getText(), "alpha beta gamma");
  });

  it("reports a visual-mode count or motion prefix as pending", async () => {
    const { editor } = (await started()).embedded();
    seed(editor, "alpha beta");
    sendKeys(editor, ["v", "2"]);
    assert.equal(mode(editor).state, "pending");
    assert.equal(mode(editor).mode, "visual");
    assert.equal(mode(editor).pending, "2");
    sendKeys(editor, ["l", "f"]);
    assert.equal(mode(editor).pending, "f");
    editor.handleInput(ESC);
    assert.equal(mode(editor).state, "visual");
  });

  it("reports the EX line without its colon", async () => {
    const { editor } = (await started()).embedded();
    seed(editor, "text");
    editor.handleInput(":");
    assert.deepEqual(mode(editor), {
      state: "ex",
      mode: "normal",
      pending: "",
      ex: "",
      autocomplete: false,
    });
    sendKeys(editor, ["w", "q"]);
    assert.equal(mode(editor).ex, "wq");
    editor.handleInput(ESC);
    assert.equal(mode(editor).state, "normal");
    assert.equal(mode(editor).ex, null);
  });

  it("reports a discarded Normal-mode paste as pending until it ends", async () => {
    const { editor } = (await started()).embedded();
    seed(editor, "text");
    editor.handleInput("\x1b[200~partial");
    assert.equal(mode(editor).state, "pending");
    editor.handleInput(" rest\x1b[201~");
    assert.equal(mode(editor).state, "normal");
    assert.equal(editor.getText(), "text");
  });

  it("reports an open autocomplete popup", async () => {
    const { editor } = (await started()).embedded();
    const internal = editor as unknown as { autocompleteState: string | null };
    internal.autocompleteState = "regular";
    assert.equal(mode(editor).autocomplete, true);
    internal.autocompleteState = null;
    assert.equal(mode(editor).autocomplete, false);
  });

  it("lets an open autocomplete popup own Escape in Insert mode", async () => {
    const { editor } = (await started()).embedded();
    const internal = editor as unknown as { autocompleteState: string | null };
    for (const char of "text") editor.handleInput(char);
    internal.autocompleteState = "regular";
    // Native Editor requires both popup state and a list, as a real provider
    // supplies; a lone flag is not an open autocomplete popup.
    (editor as unknown as { autocompleteList: object }).autocompleteList = {};
    editor.handleInput(ESC);
    assert.equal(mode(editor).state, "insert");
    assert.equal(editor.isShowingAutocomplete(), false);
    editor.handleInput(ESC);
    assert.equal(mode(editor).state, "normal");
  });
});

describe("main editor Ctrl+U / Ctrl+D", () => {
  it("scrolls the fullscreen transcript by half a page in idle Normal mode only", async () => {
    const installed = await started();
    const { tui, scrolls } = scrollableTui(40);
    const editor = installed.editorFactory()(tui, stubTheme, stubKeybindings);
    seed(editor, "hello world");
    editor.handleInput(CTRL_U);
    editor.handleInput(CTRL_D);
    assert.deepEqual(scrolls, [-20, 20]);
    assert.equal(editor.getText(), "hello world");
    assert.equal(mode(editor).state, "normal");
  });

  it("uses at least one line when the terminal size is unknown", async () => {
    const installed = await started();
    const scrolls: number[] = [];
    const tui = {
      requestRender() {},
      terminal: {},
      scrollBy(lines: number) {
        scrolls.push(lines);
      },
    } as unknown as typeof stubTui;
    const editor = installed.editorFactory()(tui, stubTheme, stubKeybindings);
    seed(editor, "x");
    editor.handleInput(CTRL_D);
    assert.deepEqual(scrolls, [1]);
  });

  it("consumes the keys without a scrollable TUI (regular mode)", async () => {
    const installed = await started();
    const editor = installed.editorFactory()(stubTui, stubTheme, stubKeybindings);
    seed(editor, "hello world");
    editor.handleInput("$");
    editor.handleInput(CTRL_U);
    editor.handleInput(CTRL_D);
    assert.equal(editor.getText(), "hello world");
    assert.equal(mode(editor).state, "normal");
  });

  it("keeps Visual mode on the engine (no transcript scroll)", async () => {
    const installed = await started();
    const { tui, scrolls } = scrollableTui();
    const editor = installed.editorFactory()(tui, stubTheme, stubKeybindings);
    seed(editor, "hello world");
    sendKeys(editor, ["w", "v"]);
    editor.handleInput(CTRL_D);
    assert.deepEqual(scrolls, []);
    assert.equal(mode(editor).mode, "visual");
    sendKeys(editor, ["e", "d"]);
    assert.equal(editor.getText(), "hello ");
  });

  it("keeps Insert mode on the editor (Ctrl+U deletes to line start)", async () => {
    const installed = await started();
    const { tui, scrolls } = scrollableTui();
    const editor = installed.editorFactory()(tui, stubTheme, stubKeybindings);
    for (const char of "hello world") editor.handleInput(char);
    editor.handleInput(CTRL_U);
    assert.deepEqual(scrolls, []);
    assert.equal(editor.getText(), "");
    assert.equal(mode(editor).state, "insert");
  });

  it("keeps pending commands on the engine", async () => {
    const installed = await started();
    const { tui, scrolls } = scrollableTui();
    const editor = installed.editorFactory()(tui, stubTheme, stubKeybindings);
    seed(editor, "hello world");
    editor.handleInput("2");
    editor.handleInput(CTRL_D);
    assert.deepEqual(scrolls, []);
    assert.equal(mode(editor).state, "normal");
  });

  it("edits EX locally without closing it or scrolling the transcript", async () => {
    const installed = await started();
    const { tui, scrolls } = scrollableTui();
    const editor = installed.editorFactory()(tui, stubTheme, stubKeybindings);
    seed(editor, "hello");
    sendKeys(editor, [":", "w"]);
    editor.handleInput(CTRL_D);
    assert.equal(mode(editor).ex, "w");
    editor.handleInput(CTRL_U);
    assert.deepEqual(scrolls, []);
    assert.equal(mode(editor).ex, "");
    assert.equal(mode(editor).state, "ex");
    editor.handleInput(CTRL_D);
    assert.equal(mode(editor).state, "ex");
    assert.equal(editor.getText(), "hello");
  });

  it("still hands idle Normal Escape to Pi", async () => {
    const installed = await started();
    const editor = installed.editorFactory()(
      stubTui,
      stubTheme,
      interruptKeybindings,
    );
    let interrupts = 0;
    editor.onEscape = () => interrupts++;
    seed(editor, "hi");
    editor.handleInput(ESC);
    assert.equal(interrupts, 1);
    assert.equal(installed.shutdownCalls, 0);
  });
});

describe("embedded editor input ownership", () => {
  it("handles Escape locally first and cancels only from idle Normal mode", async () => {
    const installed = await started();
    const { editor, calls } = installed.embedded({
      keybindings: interruptKeybindings,
    });
    let interrupts = 0;
    (editor as EmbeddedEditor).onEscape = () => interrupts++;
    for (const char of "hello world") editor.handleInput(char);

    editor.handleInput(ESC); // Insert -> Normal
    assert.equal(mode(editor).state, "normal");
    assert.equal(calls.cancels, 0);

    sendKeys(editor, ["v", ESC]); // Visual -> Normal
    assert.equal(mode(editor).state, "normal");
    assert.equal(calls.cancels, 0);

    sendKeys(editor, ["2", "d", ESC]); // drop pending keys
    assert.equal(mode(editor).state, "normal");
    assert.equal(calls.cancels, 0);

    sendKeys(editor, [":", "q", ESC]); // close the EX line
    assert.equal(mode(editor).ex, null);
    assert.equal(calls.cancels, 0);

    editor.handleInput(ESC); // idle Normal -> cancel
    assert.equal(calls.cancels, 1);
    assert.equal(interrupts, 0, "never reaches the parent editor");
    assert.equal(installed.shutdownCalls, 0);
    assert.equal(editor.getText(), "hello world");
  });

  it("scrolls the consumer viewport in idle Normal mode only", async () => {
    const { editor, calls } = (await started()).embedded();
    seed(editor, "hello world");
    editor.handleInput(CTRL_U);
    editor.handleInput(CTRL_D);
    assert.deepEqual(calls.scrolls, [-1, 1]);
    assert.equal(editor.getText(), "hello world");

    sendKeys(editor, ["v"]);
    editor.handleInput(CTRL_D);
    assert.deepEqual(calls.scrolls, [-1, 1]);
    sendKeys(editor, [ESC, "d"]);
    editor.handleInput(CTRL_D);
    assert.deepEqual(calls.scrolls, [-1, 1]);
    assert.equal(mode(editor).state, "normal");

    sendKeys(editor, ["A"]);
    editor.handleInput(CTRL_U);
    assert.deepEqual(calls.scrolls, [-1, 1]);
    assert.equal(editor.getText(), "", "Insert keeps the editor's delete-to-line-start");
  });

  it("consumes Ctrl+U / Ctrl+D without a scrollViewport hook", async () => {
    const { editor } = (await started()).embedded({ scrollViewport: undefined });
    seed(editor, "hello");
    editor.handleInput(CTRL_U);
    editor.handleInput(CTRL_D);
    assert.equal(editor.getText(), "hello");
    assert.equal(mode(editor).state, "normal");
  });

  it("submits on Enter in Insert and Normal mode through the native path", async () => {
    const { editor, calls } = (await started()).embedded();
    for (const char of "draft") editor.handleInput(char);
    editor.handleInput("\r");
    assert.deepEqual(calls.submitted, ["draft"]);
    assert.equal(editor.getText(), "");
    for (const char of "again") editor.handleInput(char);
    editor.handleInput(ESC);
    editor.handleInput("\r");
    assert.deepEqual(calls.submitted, ["draft", "again"]);
  });

  it("honors a consumer-assigned onSubmit", async () => {
    const { editor, calls } = (await started()).embedded();
    const mine: string[] = [];
    editor.onSubmit = (text) => mine.push(text);
    seed(editor, "text");
    sendKeys(editor, [":", "w", "q", "\r"]);
    assert.deepEqual(mine, ["text"]);
    assert.deepEqual(calls.submitted, []);
  });
});

describe("embedded editor EX line", () => {
  const runEx = (editor: SuiteEditor, line: string) => {
    editor.handleInput(":");
    for (const char of line) editor.handleInput(char);
    editor.handleInput("\r");
  };

  it("submits on :w, :wq and :x like Enter", async () => {
    const { editor, calls } = (await started()).embedded();
    for (const line of ["w", "wq", "x"]) {
      editor[EDITOR_INSERT]();
      seed(editor, `text ${line}`);
      runEx(editor, line);
      assert.equal(editor.getText(), "");
      assert.equal(mode(editor).state, "normal");
    }
    assert.deepEqual(calls.submitted, ["text w", "text wq", "text x"]);
    assert.deepEqual(calls.notices, []);
  });

  it("cancels on the :q family, guarding a non-empty draft", async () => {
    const { editor, calls } = (await started()).embedded();
    seed(editor, "draft");
    runEx(editor, "q");
    assert.equal(calls.cancels, 0);
    assert.deepEqual(calls.notices, [
      { message: "Editor is not empty; use :q! to close anyway", type: "warning" },
    ]);
    runEx(editor, "q!");
    assert.equal(calls.cancels, 1);
    runEx(editor, "qa!");
    assert.equal(calls.cancels, 2);
    assert.equal(editor.getText(), "draft");

    sendKeys(editor, ["d", "d"]);
    for (const line of ["q", "qa", "quit", "qall", "quitall"]) runEx(editor, line);
    assert.equal(calls.cancels, 7);
    assert.equal(calls.notices.length, 1);
  });

  it("consults onExCommand first with name, trimmed args and the raw line", async () => {
    const installed = await started();
    const handled: string[] = [];
    const { editor, calls } = installed.embedded({
      onExCommand: (name, args, raw) => {
        calls.ex.push([name, args, raw]);
        if (name === "mine") {
          handled.push(args);
          return true;
        }
        return false;
      },
    });
    seed(editor, "text");
    runEx(editor, "mine  one   two ");
    runEx(editor, "w");
    runEx(editor, "nope");
    assert.deepEqual(calls.ex, [
      ["mine", "one   two", "mine  one   two"],
      ["w", "", "w"],
      ["nope", "", "nope"],
    ]);
    assert.deepEqual(handled, ["one   two"]);
    assert.deepEqual(calls.submitted, ["text"]);
    assert.deepEqual(calls.notices, [
      { message: "Unsupported ex command: :nope", type: "warning" },
    ]);
  });

  it("never dispatches Pi commands or shell lines to the session", async () => {
    const installed = await started();
    installed.pi.setCommands(["tree"]);
    const { editor, calls } = installed.embedded();
    seed(editor, "draft");
    for (const line of ["tree", "model opus", "!ls", "!!ls", "s/a/b/", "q extra"]) {
      runEx(editor, line);
    }
    assert.deepEqual(calls.submitted, []);
    assert.equal(installed.shutdownCalls, 0);
    assert.equal(editor.getText(), "draft");
    assert.deepEqual(
      calls.notices.map((n) => n.message),
      [
        "Unsupported ex command: :tree",
        "Unsupported ex command: :model opus",
        "Unsupported ex command: :!ls",
        "Unsupported ex command: :!!ls",
        "Unsupported ex command: :s/a/b/",
        "Editor is not empty; use :q! to close anyway",
      ],
    );
    assert.equal(calls.cancels, 0);
  });

  it("is silent without a notify hook", async () => {
    const { editor, calls } = (await started()).embedded({ notify: undefined });
    seed(editor, "draft");
    assert.doesNotThrow(() => runEx(editor, "tree"));
    assert.doesNotThrow(() => runEx(editor, "q"));
    assert.equal(calls.cancels, 0);
    assert.equal(editor.getText(), "draft");
  });
});

describe("embedded editor lifecycle", () => {
  it("applies initialText, initialMode and paddingX", async () => {
    const installed = await started();
    const { editor } = installed.embedded({
      initialText: "one\ntwo",
      initialMode: "normal",
      paddingX: 2,
    });
    assert.equal(editor.getText(), "one\ntwo");
    assert.equal(mode(editor).state, "normal");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 2 });
    assert.equal((editor as EmbeddedEditor).getPaddingX(), 2);

    const { editor: insert } = installed.embedded({ initialText: "abc" });
    assert.equal(mode(insert).state, "insert");
    assert.deepEqual(insert.getCursor(), { line: 0, col: 3 });
    assert.equal((insert as EmbeddedEditor).getPaddingX(), 0);
  });

  it("emits mode changes with the embedded surface", async () => {
    const installed = await started();
    const { editor } = installed.embedded({ initialText: "x" });
    sendKeys(editor, [ESC, "v"]);
    assert.deepEqual(
      installed.pi.eventBusEmissions().filter((e) => e.event === MODE_CHANGE_EVENT),
      [
        {
          event: MODE_CHANGE_EVENT,
          data: { mode: "normal", previousMode: "insert", surface: "embedded" },
        },
        {
          event: MODE_CHANGE_EVENT,
          data: { mode: "visual", previousMode: "normal", surface: "embedded" },
        },
      ],
    );
  });

  it("does not emit for the initial Normal mode", async () => {
    const installed = await started();
    installed.embedded({ initialText: "x", initialMode: "normal" });
    assert.deepEqual(
      installed.pi.eventBusEmissions().filter((e) => e.event === MODE_CHANGE_EVENT),
      [],
    );
  });

  it("dispose is idempotent, ignores later input and runs at session shutdown", async () => {
    const installed = await started();
    const { editor, calls } = installed.embedded();
    seed(editor, "keep");
    editor.dispose();
    editor.dispose();
    assert.equal((editor as EmbeddedEditor).isDisposed(), true);
    editor.handleInput("x");
    editor.handleInput(ESC);
    assert.equal(editor.getText(), "keep");
    assert.equal(calls.cancels, 0);

    const { editor: live } = installed.embedded();
    await installed.shutdown();
    assert.equal((live as EmbeddedEditor).isDisposed(), true);
  });

  it("resets the cursor shape it wrote and the hardware cursor it enabled", async () => {
    const installed = await started();
    const tui = createCursorShapeTui({ initialShowHardwareCursor: false });
    const { editor } = installed.embedded({ tui });
    editor.focused = true;
    const lines = editor.render(40);
    assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
    assert.deepEqual(tui.hardwareCursorValues, [true]);
    assert.deepEqual(tui.terminalWrites, [INSERT_SHAPE]);

    editor.dispose();
    assert.deepEqual(tui.terminalWrites, [INSERT_SHAPE, RESET_SHAPE]);
    assert.deepEqual(tui.hardwareCursorValues, [true, false]);
    editor.dispose();
    assert.deepEqual(tui.terminalWrites, [INSERT_SHAPE, RESET_SHAPE]);
  });

  it("leaves a hardware cursor it did not enable alone and writes nothing it never changed", async () => {
    const installed = await started();
    const tui = createCursorShapeTui({ initialShowHardwareCursor: true });
    const { editor } = installed.embedded({ tui });
    editor.dispose();
    assert.deepEqual(tui.terminalWrites, []);
    assert.deepEqual(tui.hardwareCursorValues, []);
  });

  it("shares the cursor shape cache with the main editor on the same TUI", async () => {
    const installed = await started();
    const tui = createCursorShapeTui({ initialShowHardwareCursor: true });
    const main = installed.editorFactory()(tui, stubTheme, stubKeybindings);
    main.focused = true;
    seed(main, "prompt");
    main.render(40);
    assert.deepEqual(tui.terminalWrites, [BLOCK_SHAPE]);

    const { editor } = installed.embedded({ tui });
    editor.focused = true;
    editor.render(40);
    assert.deepEqual(tui.terminalWrites, [BLOCK_SHAPE, INSERT_SHAPE]);
    editor.dispose();
    assert.deepEqual(tui.terminalWrites, [BLOCK_SHAPE, INSERT_SHAPE, RESET_SHAPE]);

    main.render(40);
    assert.deepEqual(tui.terminalWrites, [
      BLOCK_SHAPE,
      INSERT_SHAPE,
      RESET_SHAPE,
      BLOCK_SHAPE,
    ]);
  });

  it("gives embedded editors the session clipboard policy", async () => {
    const restore = setPiVimSettingsReaderForTests(() => ({
      clipboardMirror: "never",
    }));
    try {
      const { editor } = (await started()).embedded();
      assert.equal(
        (editor as EmbeddedEditor).getClipboardMirrorPolicy(),
        "never",
      );
    } finally {
      restore();
    }
  });
});

describe("draft snapshots", () => {
  it("preserves history, repeat and cursor when Pi restores an unchanged draft", async () => {
    const installed = await started();
    const editor = installed.editorFactory()(stubTui, stubTheme, stubKeybindings);
    seed(editor, "one two three");
    sendKeys(editor, ["d", "w", "w"]);
    const cursor = editor.getCursor();
    editor.setText(editor.getText());
    assert.deepEqual(editor.getCursor(), cursor);
    sendKeys(editor, ["."]);
    assert.equal(editor.getText(), "two ");
    sendKeys(editor, ["u", "u"]);
    assert.equal(editor.getText(), "one two three");
  });
  it("preserves a live Insert change's undo boundary and repeat recording", async () => {
    const installed = await started();
    const { editor } = installed.embedded();
    for (const key of "hello") editor.handleInput(key);
    const snapshot = editor[EDITOR_SNAPSHOT].capture();
    const { editor: restored } = installed.embedded();
    restored[EDITOR_SNAPSHOT].restore(snapshot);
    for (const current of [editor, restored]) {
      sendKeys(current, ["!", ESC, "u"]);
      assert.equal(current.getText(), "");
      sendKeys(current, ["\x12", "."]);
      assert.equal(current.getText(), "hellohello!!");
    }
  });

  it("captures text, cursor, mode, anchor and opaque history", async () => {
    const { editor } = (await started()).embedded();
    seed(editor, "alpha beta");
    sendKeys(editor, ["y", "w", "w", "v", "l"]);
    const snapshot = editor[EDITOR_SNAPSHOT].capture();
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.text, "alpha beta");
    assert.deepEqual(snapshot.cursor, { line: 0, col: 7 });
    assert.equal(snapshot.mode, "visual");
    assert.deepEqual(snapshot.anchor, { line: 0, col: 6 });
    assert.equal(typeof snapshot.history, "object");
  });

  it("restores exactly in-process, including undo, redo, register and repeat", async () => {
    const installed = await started();
    const { editor } = installed.embedded();
    seed(editor, "one two three");
    sendKeys(editor, ["d", "w"]); // "two three", register "one "
    sendKeys(editor, ["u"]); // undo -> "one two three", redo available
    sendKeys(editor, ["x"]); // "ne two three"; last change x
    const snapshot = editor[EDITOR_SNAPSHOT].capture();

    const { editor: other } = installed.embedded();
    seed(other, "unrelated");
    assert.equal(other[EDITOR_SNAPSHOT].restore(snapshot), true);
    assert.equal(other.getText(), "ne two three");
    assert.deepEqual(other.getCursor(), { line: 0, col: 0 });
    assert.equal(mode(other).state, "normal");

    sendKeys(other, ["."]); // repeat x
    assert.equal(other.getText(), "e two three");
    sendKeys(other, ["u", "u"]);
    assert.equal(other.getText(), "one two three");
    sendKeys(other, ["$", "p"]); // register "x" overwritten by x? no: last write was "n"
    assert.equal(other.getText(), "one two threen");
  });

  it("applies a snapshot without history like setText, keeping the old draft undoable", async () => {
    const { editor } = (await started()).embedded();
    seed(editor, "before");
    const plain: EditorSnapshot = {
      version: 1,
      text: "after\nmore",
      cursor: { line: 1, col: 99 },
      mode: "normal",
    };
    assert.equal(editor[EDITOR_SNAPSHOT].restore(plain), true);
    assert.equal(editor.getText(), "after\nmore");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 4 }, "cursor clamped");
    assert.equal(mode(editor).state, "normal");
    sendKeys(editor, ["u"]);
    assert.equal(editor.getText(), "before");
  });

  it("ignores a forged history and rejects other versions unchanged", async () => {
    const { editor } = (await started()).embedded();
    seed(editor, "before");
    const forged: EditorSnapshot = {
      version: 1,
      text: "x",
      cursor: { line: 0, col: 0 },
      mode: "insert",
      history: { undo: [{ bogus: true }] },
    };
    assert.equal(editor[EDITOR_SNAPSHOT].restore(forged), true);
    assert.equal(editor.getText(), "x");
    assert.equal(mode(editor).state, "insert");
    sendKeys(editor, [ESC, "u"]);
    assert.equal(editor.getText(), "before");

    const wrong = { version: 2, text: "y", cursor: { line: 0, col: 0 }, mode: "normal" };
    assert.equal(
      editor[EDITOR_SNAPSHOT].restore(wrong as unknown as EditorSnapshot),
      false,
    );
    assert.equal(editor.getText(), "before");
  });

  it("clears pending keys and the EX line, and restores a visual anchor", async () => {
    const installed = await started();
    const { editor } = installed.embedded();
    seed(editor, "alpha beta gamma");
    sendKeys(editor, ["w", "v", "e"]);
    const snapshot = editor[EDITOR_SNAPSHOT].capture();

    const { editor: other } = installed.embedded();
    seed(other, "zzz");
    sendKeys(other, [":", "w"]);
    assert.equal(other[EDITOR_SNAPSHOT].restore(snapshot), true);
    assert.equal(mode(other).state, "visual");
    assert.equal(mode(other).ex, null);
    sendKeys(other, ["d"]);
    assert.equal(other.getText(), "alpha  gamma");

    sendKeys(other, ["2", "d"]);
    assert.equal(mode(other).state, "pending");
    assert.equal(other[EDITOR_SNAPSHOT].restore(snapshot), true);
    assert.equal(mode(other).pending, "");
    assert.equal(other.getText(), "alpha beta gamma");
  });

  it("clears stale autocomplete state when restoring a draft", async () => {
    const { editor } = (await started()).embedded();
    seed(editor, "draft");
    const snapshot = editor[EDITOR_SNAPSHOT].capture();
    const internal = editor as unknown as { autocompleteState: string | null; autocompleteList?: object };
    editor[EDITOR_INSERT]();
    internal.autocompleteState = "regular";
    internal.autocompleteList = {};
    assert.equal(mode(editor).autocomplete, true);
    editor[EDITOR_SNAPSHOT].restore(snapshot);
    assert.equal(mode(editor).state, "normal");
    assert.equal(mode(editor).autocomplete, false);
  });

  it("emits a mode change when a restore switches modes", async () => {
    const installed = await started();
    const { editor } = installed.embedded();
    seed(editor, "text");
    const normal = editor[EDITOR_SNAPSHOT].capture();
    editor.handleInput("i");
    const before = installed.pi.eventBusEmissions().length;
    editor[EDITOR_SNAPSHOT].restore(normal);
    const emitted = installed.pi.eventBusEmissions().slice(before);
    assert.deepEqual(emitted, [
      {
        event: MODE_CHANGE_EVENT,
        data: { mode: "normal", previousMode: "insert", surface: "embedded" },
      },
    ]);
  });
});

describe("insert hook", () => {
  it("enters Insert mode at the end of the text from any state", async () => {
    const installed = await started();
    const editor = installed.editorFactory()(stubTui, stubTheme, stubKeybindings);
    seed(editor, "first\nsecond");
    editor[EDITOR_INSERT]();
    assert.equal(mode(editor).state, "insert");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 6 });

    sendKeys(editor, [ESC, "g", "g", "v"]);
    editor[EDITOR_INSERT]();
    assert.equal(mode(editor).state, "insert");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 6 });

    sendKeys(editor, [ESC, "2", "d"]);
    editor[EDITOR_INSERT]();
    assert.deepEqual(mode(editor), {
      state: "insert",
      mode: "insert",
      pending: "",
      ex: null,
      autocomplete: false,
    });
    for (const char of "!") editor.handleInput(char);
    assert.equal(editor.getText(), "first\nsecond!");
  });

  it("works after setText, the way pi-next-prompt accepts a suggestion", async () => {
    const installed = await started();
    const editor = installed.editorFactory()(stubTui, stubTheme, stubKeybindings);
    seed(editor, "old");
    editor.setText("run the tests");
    editor[EDITOR_INSERT]();
    assert.equal(mode(editor).state, "insert");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 13 });
    for (const char of " now") editor.handleInput(char);
    assert.equal(editor.getText(), "run the tests now");
  });
});

describe("duplicate pi-vim diagnostic", () => {
  it("warns and installs only the first suite owner on a shared event bus", async () => {
    const installed = install();
    let installs = 0;
    const set = installed.ctx.ui.setEditorComponent as (factory: EditorFactory) => void;
    installed.ctx.ui.setEditorComponent = (factory: EditorFactory) => { installs++; set(factory); };
    installPiVim(installed.pi);
    await installed.start();
    assert.equal(installs, 1);
    assert.deepEqual(installed.notifications, [{ message: DUPLICATE_WARNING, type: "warning" }]);
    assert.ok(installed.request().factory);
    await installed.shutdown();
  });
  it("warns once when a foreign modal editor factory is already installed", async () => {
    const foreign = () => new ModalEditor(stubTui, stubTheme, stubKeybindings);
    const installed = await started({ existingFactory: foreign });
    assert.deepEqual(installed.notifications, [
      { message: DUPLICATE_WARNING, type: "warning" },
    ]);
    installed.pi.events.emit(MODE_CHANGE_EVENT, {
      mode: "normal",
      previousMode: "insert",
    });
    assert.equal(installed.notifications.length, 1);
  });

  it("warns once when a foreign mode-change event appears later", async () => {
    const installed = await started();
    assert.deepEqual(installed.notifications, []);
    installed.pi.events.emit(MODE_CHANGE_EVENT, {
      mode: "normal",
      previousMode: "insert",
    });
    installed.pi.events.emit(MODE_CHANGE_EVENT, {
      mode: "insert",
      previousMode: "normal",
    });
    assert.deepEqual(installed.notifications, [
      { message: DUPLICATE_WARNING, type: "warning" },
    ]);
  });

  it("stays quiet for its own editors, wrapped or not, and for other editors", async () => {
    const first = await started();
    const own = first.editorFactory();
    const wrapped = (
      tui: typeof stubTui,
      theme: typeof stubTheme,
      keybindings: typeof stubKeybindings,
    ) => own(tui, theme, keybindings);
    const second = await started({ existingFactory: wrapped });
    const editor = second.editorFactory()(stubTui, stubTheme, stubKeybindings);
    sendKeys(editor, [ESC, "i"]);
    assert.deepEqual(second.notifications, []);

    const plain = await started({
      existingFactory: () => ({ getText: () => "", setText() {}, handleInput() {} }),
    });
    assert.deepEqual(plain.notifications, []);
  });
});
