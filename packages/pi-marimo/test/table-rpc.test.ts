import { describe, expect, test } from "vitest";
import { editableMarkdown, markdownCellCode, markdownText } from "../src/core/markdown.js";
import { FUNCTION_CALL_PREFIX, NotebookState } from "../src/core/notebook.js";
import { summarizeOutput } from "../src/core/output.js";
import { callFunction, parseSearch } from "../src/core/table-rpc.js";

const attachment = { url: "http://127.0.0.1:1", sessionId: "s" };

function target() {
  const notebook = new NotebookState();
  return { attachment, notebook };
}

describe("function calls", () => {
  test("results with our prefix are stored, others ignored", () => {
    const nb = new NotebookState();
    expect(nb.apply("function-call-result", { function_call_id: `${FUNCTION_CALL_PREFIX}1`, return_value: 1, status: { code: "ok" } })).toBe(false);
    nb.apply("function-call-result", { function_call_id: "browser-1", return_value: 2, status: { code: "ok" } });
    expect([...nb.functionResults.keys()]).toEqual([`${FUNCTION_CALL_PREFIX}1`]);
  });

  test("callFunction posts camelCase and resolves with the result", async () => {
    const t = target();
    const posts: any[] = [];
    const post = async (_t: unknown, endpoint: string, body: any) => {
      posts.push({ endpoint, body });
      t.notebook.apply("function-call-result", { function_call_id: body.functionCallId, return_value: { ok: 1 }, status: { code: "ok" } });
    };
    await expect(callFunction(t, "bkHC-0", "search", { page_size: 5 }, { post })).resolves.toEqual({ ok: 1 });
    expect(posts[0].endpoint).toBe("function_call");
    expect(posts[0].body).toMatchObject({ namespace: "bkHC-0", functionName: "search", args: { page_size: 5 } });
    expect(posts[0].body.functionCallId.startsWith(FUNCTION_CALL_PREFIX)).toBe(true);
    expect(t.notebook.functionResults.size).toBe(0);
  });

  test("an error status rejects with its message; no answer times out", async () => {
    const t = target();
    const bad = async (_t: unknown, _e: string, body: any) => {
      t.notebook.apply("function-call-result", { function_call_id: body.functionCallId, return_value: null, status: { code: "error", message: "boom" } });
    };
    await expect(callFunction(t, "x", "search", {}, { post: bad })).rejects.toThrow("boom");
    await expect(callFunction(t, "x", "search", {}, { post: async () => {}, waitMs: 50 })).rejects.toThrow("did not answer search");
  });

  test("parseSearch reads inline JSON and file references", async () => {
    const file = async (ref: string) => (ref === "./@file/x" ? '[{"a":2}]' : "[]");
    await expect(parseSearch({ data: '[{"a":1}]', total_rows: 7 }, file)).resolves.toMatchObject({ records: [{ a: 1 }], totalRows: 7 });
    await expect(parseSearch({ data: "./@file/x", total_rows: "too_many" }, file)).resolves.toMatchObject({ records: [{ a: 2 }], totalRows: "many" });
  });
});

describe("table metadata", () => {
  test("a marimo table keeps its object id, types, selection and column settings", () => {
    const html = `<marimo-ui-element object-id='bkHC-0' random-id='x'><marimo-table data-label='"T"' data-data='[{"Index0":0,"a":1,"b":"x","_marimo_row_id":"0"}]' data-total-rows='30' data-field-types='[["a",["integer","int64"]],["b",["string","object"]]]' data-selection='"multi"' data-hidden-columns='["b"]' data-freeze-columns-left='["a"]'></marimo-table></marimo-ui-element>`;
    const t = summarizeOutput({ channel: "output", mimetype: "text/html", data: html })!.table!;
    expect(t).toMatchObject({ objectId: "bkHC-0", selection: "multi", hidden: ["b"], freezeLeft: ["a"], columns: ["a"], rowHeaders: ["Index0"], label: "T" });
    expect(t.fieldTypes?.a).toEqual({ kind: "integer", dtype: "int64" });
    expect(t.records?.[0]?._marimo_row_id).toBe("0");
    const lazy = summarizeOutput({ channel: "output", mimetype: "text/html", data: `<marimo-ui-element object-id='k-0'><marimo-table data-data='"./@file/1.json"' data-total-rows='5' data-field-types='[["a",["integer","int64"]]]'></marimo-table></marimo-ui-element>` })!.table!;
    expect(lazy).toMatchObject({ objectId: "k-0", dataRef: "./@file/1.json", columns: ["a"], records: [] });
  });
});

describe("markdown cell code", () => {
  test("round trips through markdownText", () => {
    for (const text of ["# Title", 'say """hi"""', `both """ and ''' and \\ here`]) {
      expect(markdownText(markdownCellCode(text))).toBe(text);
    }
    expect(markdownCellCode("# T\n\n")).toBe('mo.md(r"""\n# T\n""")');
  });
  test("f-string markdown is not editable", () => {
    expect(editableMarkdown('mo.md(f"# {x}")')).toBeUndefined();
    expect(editableMarkdown('mo.md("# a")')).toBe("# a");
  });
});

describe("expected edits", () => {
  test("a code-mode edit Pi made is not an agent change", async () => {
    const nb = new NotebookState();
    nb.apply("kernel-ready", { cell_ids: ["a"], codes: ['mo.md("# a")'], names: ["_"] });
    (nb as any).readyAt = Date.now() - 5000;
    nb.expectEdit("a", 'mo.md(r"""\n# b\n""")');
    nb.apply("notebook-document-transaction", { transaction: { source: "code-mode", changes: [{ type: "set-code", cellId: "a", code: 'mo.md(r"""\n# b\n""")' }] } });
    expect(nb.agentChanges.size).toBe(0);
    nb.apply("notebook-document-transaction", { transaction: { source: "code-mode", changes: [{ type: "set-code", cellId: "a", code: "x = 1" }] } });
    expect(nb.agentChanges.get("a")?.kind).toBe("edited");
  });
});
