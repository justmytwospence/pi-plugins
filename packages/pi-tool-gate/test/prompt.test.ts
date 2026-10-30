import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { type Approval, type ApprovalAnswer, askApproval } from "../src/prompt.ts";

const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", sdk).href);
const themeModule = await import(new URL("./modes/interactive/theme/theme.js", sdk).href);

let kb: unknown;
beforeAll(() => {
  initTheme("dark", false);
  kb = new KeybindingsManager({});
  setKeybindings(kb as never);
});

const OPTIONS = ["Allow once", "Allow rule for this session", "Allow rule in this project", "Allow rule everywhere", "Edit the rule...", "Block"];
const approval = (extra: Partial<Approval> = {}): Approval => ({
  view: { tool: "bash", subject: "", body: { kind: "code", lang: "bash", text: "git push origin feature" } },
  held: "it changes something other people see",
  options: OPTIONS,
  grant: ["Rule: Bash(git push:*)"],
  editRow: "Edit the rule...",
  editText: "Bash(git push:*)",
  ...extra,
});

/** The dialog as Pi's terminal UI hosts it: drive it with keys, read what it draws, await its answer. */
function open(a: Approval, width = 60) {
  let dialog: { render(width: number): string[]; handleInput(data: string): void; focused: boolean } | undefined;
  const ctx = {
    mode: "tui",
    ui: {
      custom: (factory: (...args: unknown[]) => typeof dialog) =>
        new Promise((resolve) => {
          dialog = factory({ terminal: { rows: 40, columns: width }, requestRender() {} }, themeModule.theme, kb, resolve);
          if (dialog) dialog.focused = true;
        }),
      select: async () => undefined,
      editor: async () => undefined,
    },
  };
  const answer = askApproval(ctx as never, a, "Allow?") as Promise<ApprovalAnswer | undefined>;
  const screen = () => stripVTControlCharacters((dialog?.render(width) ?? []).join("\n"));
  const press = (...keys: string[]) => keys.forEach((k) => dialog?.handleInput(k));
  return { answer, screen, press };
}
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

describe("the approval dialog's rule rows", () => {
  test("the rules are in the question, one flat line each, over short rows", async () => {
    const d = open(approval({ grant: ["Rule: Bash(git push:*)", "Rule: Bash(rm -rf build)"] }), 46);
    await Promise.resolve();
    const lines = d.screen().split("\n");
    const question = lines.findIndex((l) => l.trim().startsWith("Allow bash"));
    expect(lines.slice(question, question + 3).map((l) => l.trim())).toEqual(["Allow bash git push origin feature?", "Rule: Bash(git push:*)", "Rule: Bash(rm -rf build)"]);
    const rows = lines.map((l) => l.replace(/^\s*→?\s*/u, "").trim());
    for (const option of [...OPTIONS, "Block with a message"]) expect(rows).toContain(option);
    for (const option of [...OPTIONS, "Block with a message"]) expect(option.length).toBeLessThanOrEqual(42);
    d.press(ESC);
    expect(await d.answer).toEqual({ choice: "Block" });
  });

  test.each([46, 120])("managed globals keep project saves and session choices readable at %s columns", async (width) => {
    const options = OPTIONS.filter((row) => row !== "Allow rule everywhere");
    const d = open(approval({ options, grant: ["Rule: Bash(git push:*)", "Project saves: ~/repo/.pi/tool-gate.json (shared)"] }), width);
    await Promise.resolve();
    const text = d.screen();
    expect(text).not.toContain("Allow rule everywhere");
    expect(text).toContain("Allow rule for this session");
    expect(text).toContain("Allow rule in this project");
    expect(text).toContain("Project saves:");
    expect(text.split("\n").every((line) => line.length <= width)).toBe(true);
    d.press(DOWN, DOWN, ENTER);
    expect(await d.answer).toEqual({ choice: "Allow rule in this project" });
  });

  test("long rules wrap, and a very long list is cut", async () => {
    const long = `Rule: Bash(${"curl -s https://example.com/api/x ".repeat(12)})`;
    const d = open(approval({ grant: Array.from({ length: 6 }, () => long) }), 46);
    await Promise.resolve();
    const text = d.screen();
    expect(text).toContain("...");
    expect(text.split("\n").every((l) => l.length <= 46)).toBe(true);
    d.press(ESC);
    await d.answer;
  });

  test("selecting a row answers with it", async () => {
    const d = open(approval());
    await Promise.resolve();
    d.press(DOWN, DOWN, ENTER);
    expect(await d.answer).toEqual({ choice: "Allow rule in this project" });
  });

  test("Edit the rule opens a field holding the rule; Enter answers with the text, Esc goes back to the rows", async () => {
    const d = open(approval());
    await Promise.resolve();
    d.press(DOWN, DOWN, DOWN, DOWN, ENTER);
    const text = d.screen();
    expect(text).toContain("Edit the rule");
    expect(text).toMatch(/› Bash\(git push:\*\)/u);
    expect(text).toContain("enter submit");
    d.press(ESC);
    expect(d.screen()).not.toContain("› Bash");
    expect(d.screen()).toContain("enter select");
    d.press(ENTER);
    d.press("x");
    d.press(ENTER);
    expect(await d.answer).toEqual({ choice: "Edit the rule...", edited: "Bash(git push:*)x" });
  });

  test("the field keeps what was typed when it is closed and reopened, and an empty one stays open", async () => {
    const d = open(approval());
    await Promise.resolve();
    d.press(DOWN, DOWN, DOWN, DOWN, ENTER, "y", ESC, ENTER);
    expect(d.screen()).toMatch(/› Bash\(git push:\*\)y/u);
    // Select everything with the editor's own keys is editor business: clear by backspacing.
    for (let i = 0; i < "Bash(git push:*)y".length; i++) d.press("\x7f");
    d.press(ENTER);
    expect(d.screen()).toContain("Type a rule, or Esc to go back.");
    d.press("a", ENTER);
    expect(await d.answer).toEqual({ choice: "Edit the rule...", edited: "a" });
  });

  test("after an edit that was not a rule, the field is open at once with why and the text as typed", async () => {
    const d = open(approval({ editText: "WebFetch(domain:x)", editError: "Not a rule: WebFetch(...) is not supported." }));
    await Promise.resolve();
    const text = d.screen();
    expect(text).toMatch(/› WebFetch\(domain:x\)/u);
    expect(text).toContain("Not a rule: WebFetch(...) is not supported.");
    d.press(ENTER);
    expect(await d.answer).toEqual({ choice: "Edit the rule...", edited: "WebFetch(domain:x)" });
  });

  test("Block with a message still opens its own field, and Esc in it goes back", async () => {
    const d = open(approval());
    await Promise.resolve();
    d.press("n");
    expect(d.screen()).toContain("Message for the agent");
    expect(d.screen()).not.toMatch(/› Bash/u);
    d.press("n", "o", ENTER);
    expect(await d.answer).toEqual({ choice: "Block", message: "no" });
  });

  test("without the terminal UI, the rows are a select and Edit opens the editor on the rule", async () => {
    const selects: Array<{ title: string; options: string[] }> = [];
    const edits: Array<{ title: string; prefill?: string }> = [];
    const ctx = {
      mode: "rpc",
      ui: {
        select: async (title: string, options: string[]) => {
          selects.push({ title, options });
          return "Edit the rule...";
        },
        editor: async (title: string, prefill?: string) => {
          edits.push({ title, prefill });
          return "  Bash(git push origin:*)  ";
        },
      },
    };
    const answer = await askApproval(ctx as never, approval(), "Allow? bash: git push");
    expect(answer).toEqual({ choice: "Edit the rule...", edited: "Bash(git push origin:*)" });
    expect(selects[0]?.options).toEqual([...OPTIONS, "Block with a message"]);
    expect(edits).toEqual([{ title: "Edit the rule", prefill: "Bash(git push:*)" }]);
    // An editor that is dismissed gives no text.
    ctx.ui.editor = async () => undefined as never;
    expect(await askApproval(ctx as never, approval(), "Allow?")).toEqual({ choice: "Edit the rule..." });
  });
});
