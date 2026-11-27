import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Editor, setKeybindings } from "@earendil-works/pi-tui";
import type { EditorCreator } from "../src/editor.ts";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { RemoteUi } from "../src/switchyard-remote.ts";
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
function open(a: Approval, width = 60, mirror?: { ui: RemoteUi; title: string; signal: AbortSignal }, order?: string[], createEditor?: EditorCreator) {
  let doneCount = 0;
  let plainCalls = 0;
  let dialog: { render(width: number): string[]; handleInput(data: string): void; focused: boolean } | undefined;
  const ctx = {
    mode: "tui",
    ui: {
      custom: (factory: (...args: unknown[]) => typeof dialog) =>
        new Promise((resolve) => {
          order?.push("native");
          dialog = factory({ terminal: { rows: 40, columns: width }, requestRender() {} }, themeModule.theme, kb, (value: unknown) => { doneCount++; resolve(value); });
          if (dialog) dialog.focused = true;
        }),
      select: async () => { plainCalls++; return undefined; },
      editor: async () => { plainCalls++; return undefined; },
    },
  };
  const answer = askApproval(ctx as never, a, "Allow?", createEditor, mirror) as Promise<ApprovalAnswer | undefined>;
  const screen = () => stripVTControlCharacters((dialog?.render(width) ?? []).join("\n"));
  const press = (...keys: string[]) => keys.forEach((k) => dialog?.handleInput(k));
  return { answer, screen, press, doneCount: () => doneCount, plainCalls: () => plainCalls };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

test("a throwing embedded editor disposal still completes once", async () => {
  const dispose = vi.fn(() => { throw new Error("dispose failed"); });
  const createEditor: EditorCreator = (tui, theme) => Object.assign(new Editor(tui, theme), { dispose });
  const dialog = open(approval(), 60, undefined, undefined, createEditor);
  dialog.press(ESC, ESC);
  expect(await dialog.answer).toEqual({ choice: "Block" });
  expect(dispose).toHaveBeenCalledOnce();
  expect(dialog.doneCount()).toBe(1);
});

describe("mirrored approvals", () => {
  function remote() {
    const select = deferred<string | undefined>();
    const input = deferred<string | undefined>();
    const editor = deferred<string | undefined>();
    const order: string[] = [];
    const ui = {
      select: vi.fn((_title: string, _options: string[], opts?: { signal?: AbortSignal }) => { order.push("remote"); opts?.signal?.addEventListener("abort", () => select.resolve(undefined)); return select.promise; }),
      input: vi.fn((_title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) => { opts?.signal?.addEventListener("abort", () => input.resolve(undefined)); return input.promise; }),
      editor: vi.fn((_title: string, _prefill?: string, opts?: { signal?: AbortSignal }) => { opts?.signal?.addEventListener("abort", () => editor.resolve(undefined)); return editor.promise; }),
      confirm: vi.fn(async () => false),
    };
    const outer = new AbortController();
    const dialog = open(approval(), 60, { ui, title: "remote title", signal: outer.signal }, order);
    return { ui, select, input, editor, outer, dialog, order };
  }
  test("remote allow closes native once and starts first", async () => {
    const r = remote();
    expect(r.order).toEqual(["remote", "native"]);
    r.select.resolve("Allow once");
    expect(await r.dialog.answer).toEqual({ choice: "Allow once" });
    expect(r.dialog.doneCount()).toBe(1);
  });
  test("native block aborts remote with terminal reason", async () => {
    const r = remote();
    r.dialog.press(ESC);
    expect(await r.dialog.answer).toEqual({ choice: "Block" });
    expect(r.ui.select.mock.calls[0]![2]!.signal!.reason).toBe("terminal");
  });
  test("an intermediate remote answer does not beat native", async () => {
    const r = remote();
    r.select.resolve("Block with a message");
    await Promise.resolve();
    expect(r.ui.input).toHaveBeenCalled();
    r.dialog.press(ESC);
    expect(await r.dialog.answer).toEqual({ choice: "Block" });
    expect(r.ui.input.mock.calls[0]![2]!.signal!.reason).toBe("terminal");
  });
  test("remote message and edit return complete answers", async () => {
    const a = remote();
    a.select.resolve("Block with a message");
    await Promise.resolve();
    a.input.resolve("  please stop  ");
    expect(await a.dialog.answer).toEqual({ choice: "Block", message: "please stop" });
    const b = remote();
    b.select.resolve("Edit the rule...");
    await Promise.resolve();
    b.editor.resolve("  Bash(npm publish)  ");
    expect(await b.dialog.answer).toEqual({ choice: "Edit the rule...", edited: "Bash(npm publish)" });
  });
  test("cancel, abort during edit, invalid answers and errors fail closed", async () => {
    const a = remote();
    a.select.resolve(undefined);
    expect(await a.dialog.answer).toBeUndefined();
    expect(a.dialog.plainCalls()).toBe(0);
    const b = remote();
    b.select.resolve("Edit the rule...");
    await Promise.resolve();
    b.outer.abort();
    expect(await b.dialog.answer).toBeUndefined();
    expect(b.dialog.doneCount()).toBe(1);
    expect(b.dialog.plainCalls()).toBe(0);
    const c = remote();
    c.select.resolve("unoffered");
    expect(await c.dialog.answer).toBeUndefined();
    const ui: RemoteUi = { select: async () => { throw new Error("disconnected"); }, input: async () => undefined, editor: async () => undefined, confirm: async () => false };
    const d = open(approval(), 60, { ui, title: "remote", signal: new AbortController().signal });
    expect(await d.answer).toBeUndefined();
    expect(d.doneCount()).toBe(1);
    expect(d.plainCalls()).toBe(0);
  });
  test("RPC message uses the ordinary two-argument input", async () => {
    const input = vi.fn(async () => "  please stop  ");
    const ctx = { mode: "rpc", ui: { select: async () => "Block with a message", input } };
    expect(await askApproval(ctx as never, approval(), "title")).toEqual({ choice: "Block", message: "please stop" });
    expect(input).toHaveBeenCalledWith("Message for the agent", "why, or what to do instead");
  });
});

describe("the approval dialog's rule rows", () => {
  test("the rules are in the question, one flat line each, over short rows", async () => {
    const d = open(approval({ grant: ["Rule: Bash(git push:*)", "Rule: Bash(rm -rf build)"] }), 46);
    await Promise.resolve();
    const lines = d.screen().split("\n");
    const question = lines.findIndex((l) => l.trim().startsWith("Target:"));
    const finalQuestion = lines.slice(question, lines.findIndex((l) => l.includes("→ Allow once"))).map((l) => l.trim()).filter(Boolean);
    // The title already names the tool, so the question does not repeat it as an action.
    expect(d.screen()).not.toContain("Action:");
    expect(finalQuestion.join(" ")).toContain("Target: git push origin feature");
    expect(finalQuestion).toContain("Rule: Bash(git push:*)");
    expect(finalQuestion).toContain("Rule: Bash(rm -rf build)");
    const rows = lines.map((l) => l.replace(/^\s*→?\s*/u, "").trim());
    for (const option of [...OPTIONS, "Block with a message"]) expect(rows).toContain(option);
    for (const option of [...OPTIONS, "Block with a message"]) expect(option.length).toBeLessThanOrEqual(42);
    d.press(ESC);
    expect(await d.answer).toEqual({ choice: "Block" });
  });

  test.each([46, 120, 180])("two-rule approvals leave room for the activity and blocked footer at %s columns", async (width) => {
    const command = "cd ~/Projects/app && git push origin feature && curl -s -X POST https://api.example.com/v1/deployments/1234567890/restart";
    const grant = ["Rule: Bash(git push:*)", "Rule: Bash(curl -s -X POST https://api.example.com/v1/deployments/1234567890/restart?force=true&notify=all)"];
    const d = open(approval({
      view: { tool: "bash", subject: "", body: { kind: "code", lang: "bash", text: command } },
      agentCase: "The rebase rewrote the branch.", grant,
    }), width);
    await Promise.resolve();
    const lines = d.screen().split("\n");
    // A collapsed Sidebar preserves one transcript row; activity + separator + footer need three.
    expect(lines.length + 1 + 3).toBeLessThanOrEqual(40);
    expect(lines.at(-1)).toMatch(/^─+$/u);
    const questionLines = lines.slice(lines.findIndex((line) => line.trim().startsWith("Target:")), lines.findIndex((line) => line.includes("→ Allow once"))).filter((line) => line.trim());
    expect(questionLines.length).toBeLessThanOrEqual(8);
    const question = questionLines.join("").replace(/\s+/gu, "");
    // The preview shows the whole command; the question keeps only a short label of it.
    for (const part of ["Target: cd ~/Projects/app && git push origin feature && curl -s -X …", ...grant]) expect(question).toContain(part.replace(/\s+/gu, ""));
    expect(question).not.toContain(command.replace(/\s+/gu, ""));
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

  test.each([46, 120, 180])("explicit generic action and target appear in the final question at %s columns", async (width) => {
    const view = { tool: "deploy", subject: "", action: "deploy restart", target: "production-api", body: { kind: "code" as const, lang: undefined, text: "preview only" } };
    const d = open(approval({ view, grant: ["Rule: Deploy(restart)"] }), width);
    await Promise.resolve();
    const lines = d.screen().split("\n");
    const start = lines.findIndex((line) => line.trim().startsWith("Action:"));
    const end = lines.findIndex((line) => line.includes("→ Allow once"));
    const finalQuestion = lines.slice(start, end).map((line) => line.trim()).join(" ");
    expect(finalQuestion).toContain("Action: deploy restart");
    expect(finalQuestion).toContain("Target: production-api");
    expect(finalQuestion).toContain("Rule: Deploy(restart)");
    d.press(ESC);
    await d.answer;
  });

  test("legacy views with no subject or command say the target is not specified", async () => {
    const d = open(approval({ view: { tool: "deploy", subject: "", body: { kind: "code", lang: undefined, text: "" } } }));
    await Promise.resolve();
    expect(d.screen()).toContain("Target: Not specified");
    d.press(ESC);
    await d.answer;
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
