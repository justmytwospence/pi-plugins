import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayPath, FilePicker, matchSegment, mention, newestModified, parseQuery } from "../src/file-picker.js";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("file picker", () => {
  const tree: Record<string, string[]> = {
    "/": ["etc", "Users"],
    "/h": ["Downloads", "Documents", "Projects", "prefs", ".config"],
    "/h/Projects": ["pi-plugins", "pi-vim-old", "dotfiles"],
    "/p": ["src"],
  };
  const subdirs = (dir: string) => tree[dir] ?? [];
  const parse = (q: string, cwd = "/p") => parseQuery(q, cwd, "/h", subdirs);

  it("parses project and explicit-directory queries", () => {
    assert.deepEqual(parse("foo"), { root: "/p", prefix: "", term: "foo" });
    assert.deepEqual(parse("~/Downloads/inv"), { root: "/h/Downloads", prefix: "~/Downloads/", term: "inv" });
    assert.deepEqual(parse("/etc/ho"), { root: "/etc", prefix: "/etc/", term: "ho" });
    assert.deepEqual(parse("../x", "/p/q"), { root: "/p", prefix: "../", term: "x" });
    assert.deepEqual(parse("./src/i"), { root: "/p/src", prefix: "./src/", term: "i" });
    assert.deepEqual(parse("~"), { root: "/h", prefix: "~", term: "" });
  });

  it("matches directory segments by prefix, then fuzzily", () => {
    assert.equal(matchSegment("dow", ["Documents", "Downloads"]), "Downloads");
    assert.equal(matchSegment("pr", ["Projects", "prefs"]), "prefs");
    assert.equal(matchSegment("dl", ["Documents", "Downloads"]), "Downloads");
    assert.equal(matchSegment("cfg", [".config"]), undefined);
    assert.equal(matchSegment(".cfg", [".config"]), ".config");
    assert.deepEqual(parse("~/dl/inv"), { root: "/h/Downloads", prefix: "~/Downloads/", term: "inv" });
    assert.deepEqual(parse("~/Proj/pipl/READ"), { root: "/h/Projects/pi-plugins", prefix: "~/Projects/pi-plugins/", term: "READ" });
    assert.deepEqual(parse("~/zzz/x"), { root: undefined, prefix: "~/zzz/", term: "x" });
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
    await tick();
    assert.match(picker.render(80).join("\n"), /> src\/index\.ts/);
    picker.handleInput("\r");
    assert.equal(result, "@src/index.ts ");

    const again = new FilePicker(process.cwd(), theme, () => {}, (t) => { result = t; }, lister);
    await tick();
    again.handleInput("s");
    await tick();
    again.handleInput("\t");
    await tick();
    assert.match(again.render(80).join("\n"), /\.\/src\/index\.ts/);
    again.handleInput("\r");
    assert.equal(result, "@src/index.ts ");
    assert.ok(roots.some((r) => r.endsWith("/src")));
  });

  it("lists the fuzzily resolved directory and inserts its real path", async () => {
    let result: string | undefined;
    const roots: string[] = [];
    const lister = async (root: string) => { roots.push(root); return ["invoice.pdf"]; };
    const picker = new FilePicker("/p", theme, () => {}, (t) => { result = t; }, lister, subdirs);
    for (const ch of "/Us/") picker.handleInput(ch);
    await tick();
    assert.ok(roots.includes("/Users"));
    assert.match(picker.render(80).join("\n"), /> \/Users\/invoice\.pdf/);
    picker.handleInput("\r");
    assert.equal(result, "@/Users/invoice.pdf ");
  });

  it("searches home as well for a plain query, ranked together", async () => {
    let result: string | undefined;
    const lister = async (root: string) =>
      root === "/h/proj" ? ["src/dl-worker.ts", "docs/"] : root === "/h" ? ["Downloads/", "Downloads/a.pdf", "proj/docs/"] : [];
    const picker = new FilePicker("/h/proj", theme, () => {}, (t) => { result = t; }, lister, subdirs, "/h");
    for (const ch of "download") picker.handleInput(ch);
    await tick();
    const shown = picker.render(80).join("\n");
    assert.match(shown, /> ~\/Downloads\//);
    picker.handleInput("\r");
    assert.equal(result, "@~/Downloads/ ");

    // Entries inside the project appear once, with project-relative labels.
    const docs = new FilePicker("/h/proj", theme, () => {}, () => {}, lister, subdirs, "/h");
    for (const ch of "docs") docs.handleInput(ch);
    await tick();
    const lines = docs.render(80).join("\n");
    assert.match(lines, /> docs\//);
    assert.doesNotMatch(lines, /~\/proj\/docs/);
  });

  it("cancels on escape", async () => {
    let result: string | undefined = "x";
    const picker = new FilePicker("/p", theme, () => {}, (t) => { result = t; }, async () => []);
    picker.handleInput("\x1b");
    assert.equal(result, undefined);
  });
});

describe("Downloads recency", () => {
  it("sorts newest first with deterministic ties and unreadable entries last", async () => {
    const entries = ["missing-z", "old", "new-b", "new-a", "missing-a"];
    const result = await newestModified("/fixture", entries, async (path) => {
      if (path.includes("missing")) throw new Error("gone");
      return path.endsWith("old") ? 10 : 20;
    });
    assert.deepEqual(result, ["new-a", "new-b", "old", "missing-a", "missing-z"]);
    assert.deepEqual(entries, ["missing-z", "old", "new-b", "new-a", "missing-a"]);
  });

  it("bounds concurrent metadata reads", async () => {
    let active = 0, peak = 0;
    await newestModified("/fixture", Array.from({ length: 100 }, (_, i) => String(i)), async () => {
      peak = Math.max(peak, ++active);
      await tick();
      active--;
      return 1;
    });
    assert.ok(peak <= 16);
    assert.equal(active, 0);
  });

  it("resolves fuzzy Downloads aliases, retains recency while filtering, and inserts the newest match", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "picker-recency-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const downloads = join(home, "Downloads");
    await mkdir(downloads);
    for (const [name, time] of [["invoice.pdf", 10], ["zinvoice.pdf", 20]] as const) {
      const path = join(downloads, name);
      await writeFile(path, "fixture");
      await utimes(path, time, time);
    }
    let chosen: string | undefined;
    let reads = 0;
    const picker = new FilePicker("/fixture", theme, () => {}, (text) => { chosen = text; }, async (root) => {
      if (root !== downloads) return [];
      reads++;
      return ["invoice.pdf", "zinvoice.pdf"];
    }, (dir) => dir === home ? ["Downloads"] : [], home);
    for (const ch of "~/dl/") picker.handleInput(ch);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.match(picker.render(120).join("\n"), /> ~\/Downloads\/zinvoice.pdf/);
    for (const ch of "invoice") picker.handleInput(ch);
    assert.match(picker.render(120).join("\n"), /> ~\/Downloads\/zinvoice.pdf/);
    assert.match(picker.render(120).join("\n"), /newest modified first/);
    assert.equal(reads, 1);
    picker.handleInput("\r");
    assert.equal(chosen, "@~/Downloads/zinvoice.pdf ");
  });
});

describe("Ctrl-X Ctrl-E chord", () => {
  for (const mode of ["insert", "normal", "pending", "ex"]) {
    it(`external editor chord respects ${mode} input ownership`, async () => {
      const { MainEditor } = await import("../src/main-editor.js");
      const { stubKeybindings, stubTheme, stubTui } = await import("./harness.js");
      const editor = new MainEditor(stubTui, stubTheme, stubKeybindings);
      editor.setText("draft");
      let opened = 0;
      editor.onAction("app.editor.external", () => { opened++; });
      if (mode !== "insert") editor.handleInput("\x1b");
      if (mode === "pending") editor.handleInput("d");
      if (mode === "ex") editor.handleInput(":");
      editor.handleInput("\x18");
      editor.handleInput("\x05");
      assert.equal(opened, mode === "insert" || mode === "normal" ? 1 : 0);
      assert.equal(editor.getText(), "draft");
      editor.dispose();
    });
  }

  it("replays unmatched Ctrl-X, times out, and clears its timer on disposal", async () => {
    const { MainEditor, CTRL_X_TIMEOUT_MS } = await import("../src/main-editor.js");
    const { stubKeybindings, stubTheme, stubTui } = await import("./harness.js");
    const editor = new MainEditor(stubTui, stubTheme, stubKeybindings);
    let copied = 0;
    let opened = 0;
    editor.onAction("app.editor.external", () => { opened++; });
    // Copy's fallback is observable even with the harness's simplified keybindings.
    editor.onExtensionShortcut = (data) => {
      if (data !== "\x18") return false;
      copied++;
      return true;
    };
    editor.handleInput("\x18");
    editor.handleInput("a");
    assert.equal(copied, 1);
    assert.equal(editor.getText(), "a");
    editor.handleInput("\x18");
    await new Promise((resolve) => setTimeout(resolve, CTRL_X_TIMEOUT_MS + 30));
    assert.equal(copied, 2);
    editor.handleInput("\x18");
    editor.dispose();
    await new Promise((resolve) => setTimeout(resolve, CTRL_X_TIMEOUT_MS + 30));
    assert.equal(copied, 2);
    assert.equal(opened, 0);
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
