import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayPath, FilePicker, mention, parseQuery } from "../src/file-picker.js";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const tick = () => new Promise((r) => setImmediate(r));

describe("file picker", () => {
  it("parses project and explicit-directory queries", () => {
    assert.deepEqual(parseQuery("foo", "/p", "/h"), { root: "/p", prefix: "", term: "foo" });
    assert.deepEqual(parseQuery("~/Down/inv", "/p", "/h"), { root: "/h/Down", prefix: "~/Down/", term: "inv" });
    assert.deepEqual(parseQuery("/etc/ho", "/p", "/h"), { root: "/etc", prefix: "/etc/", term: "ho" });
    assert.deepEqual(parseQuery("../x", "/p/q", "/h"), { root: "/p", prefix: "../", term: "x" });
    assert.deepEqual(parseQuery("~", "/p", "/h"), { root: "/h", prefix: "~", term: "" });
  });

  it("displays paths relative to the project, home or root", () => {
    assert.equal(displayPath("/p/src/a.ts", "/p", "/h"), "src/a.ts");
    assert.equal(displayPath("/h/notes.md", "/p", "/h"), "~/notes.md");
    assert.equal(displayPath("/etc/hosts", "/p", "/h"), "/etc/hosts");
    assert.equal(mention("a b.txt"), '@"a b.txt" ');
  });

  it("fuzzy-filters, descends with tab and inserts a mention", async () => {
    const roots: string[] = [];
    let result: string | undefined;
    const lister = async (root: string) => {
      roots.push(root);
      return root === process.cwd() ? ["src/", "src/index.ts", "README.md"] : ["index.ts"];
    };
    const picker = new FilePicker(process.cwd(), theme, () => {}, (t) => { result = t; }, lister);
    await tick();
    for (const ch of "srcidx") picker.handleInput(ch);
    assert.match(picker.render(80).join("\n"), /> src\/index\.ts/);
    picker.handleInput("\r");
    assert.equal(result, "@src/index.ts ");

    const again = new FilePicker(process.cwd(), theme, () => {}, (t) => { result = t; }, lister);
    await tick();
    again.handleInput("s");
    again.handleInput("\t");
    await tick();
    assert.match(again.render(80).join("\n"), /\.\/src\/index\.ts/);
    again.handleInput("\r");
    assert.equal(result, "@src/index.ts ");
    assert.ok(roots.some((r) => r.endsWith("/src")));
  });

  it("cancels on escape", async () => {
    let result: string | undefined = "x";
    const picker = new FilePicker("/p", theme, () => {}, (t) => { result = t; }, async () => []);
    picker.handleInput("\x1b");
    assert.equal(result, undefined);
  });
});

describe("Ctrl-X Ctrl-F chord", () => {
  it("opens the picker in Insert mode and inserts its result", async () => {
    const { MainEditor } = await import("../src/main-editor.js");
    const { stubKeybindings, stubTheme, stubTui } = await import("./harness.js");
    const editor = new MainEditor(stubTui, stubTheme, stubKeybindings);
    let opened = 0;
    editor.setFilePickerFn(async () => { opened++; return "@a.ts "; });
    editor.handleInput("x");
    editor.handleInput("\x18");
    editor.handleInput("\x06");
    await tick();
    assert.equal(opened, 1);
    assert.equal(editor.getText(), "x@a.ts ");
    editor.dispose();
  });

  it("replays Ctrl-X when another key follows", async () => {
    const { MainEditor } = await import("../src/main-editor.js");
    const { stubKeybindings, stubTheme, stubTui } = await import("./harness.js");
    const editor = new MainEditor(stubTui, stubTheme, stubKeybindings);
    let opened = 0;
    editor.setFilePickerFn(async () => { opened++; return undefined; });
    editor.handleInput("\x18");
    editor.handleInput("y");
    assert.equal(opened, 0);
    assert.equal(editor.getText(), "y");
    editor.dispose();
  });
});
