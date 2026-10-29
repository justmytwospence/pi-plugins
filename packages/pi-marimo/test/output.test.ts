import { describe, expect, test } from "vitest";
import { NotebookState } from "../src/core/notebook.js";
import { appendConsole, htmlToText, summarizeOutput } from "../src/core/output.js";
import { snapshot } from "../src/core/render.js";
import { runCells } from "../src/ui/interrupt.js";

describe("cell output for the notebook view", () => {
  test("html becomes text; tables, images and charts are named, not dumped", () => {
    expect(htmlToText("<div><b>a</b> &amp; b</div><p>second</p><script>x()</script>")).toBe("a & b\nsecond");
    expect(summarizeOutput({ channel: "output", mimetype: "text/plain", data: "42" })).toEqual({ kind: "text", text: "42" });
    expect(summarizeOutput({ channel: "output", mimetype: "text/html", data: '<marimo-table data-total-rows="12" data-data="[]"></marimo-table>' })).toEqual({ kind: "table", text: "[table, 12 rows]" });
    expect(summarizeOutput({ channel: "output", mimetype: "image/png", data: "iVBOR" })).toMatchObject({ kind: "image", text: "[image png]" });
    expect(summarizeOutput({ channel: "output", mimetype: "application/vnd.vegalite.v5+json", data: "{}" })?.kind).toBe("chart");
    expect(summarizeOutput({ channel: "output", mimetype: "text/html", data: "<marimo-plotly data-figure='x'></marimo-plotly>" })?.kind).toBe("chart");
    expect(summarizeOutput({ channel: "output", mimetype: "text/plain", data: "" })).toBeUndefined();
    expect(summarizeOutput({ channel: "marimo-error", mimetype: "application/vnd.marimo+error", data: [] })).toBeUndefined();
    expect(summarizeOutput({ channel: "output", mimetype: "text/plain", data: "x".repeat(20_000) })!.text.length).toBeLessThanOrEqual(8_000);
  });

  test("mo.md output (text/markdown carrying HTML) becomes text, not raw HTML", () => {
    const data = '<span class="markdown prose dark:prose-invert contents"><h2 id="a">Slow fit</h2><span class="paragraph">Some text.</span></span>';
    const out = summarizeOutput({ channel: "output", mimetype: "text/markdown", data });
    expect(out?.kind).toBe("text");
    expect(out?.text).toContain("Slow fit");
    expect(out?.text).not.toContain("<span");
  });

  test("console lines append per message, a cleared console empties, a rerun starts over", () => {
    let lines = appendConsole(undefined, [{ channel: "stdout", mimetype: "text/plain", data: "one\ntwo\n" }]);
    lines = appendConsole(lines, { channel: "stderr", mimetype: "text/plain", data: "warn\n" });
    expect(lines?.map((l) => `${l.stream}:${l.text}`)).toEqual(["stdout:one", "stdout:two", "stderr:warn"]);
    expect(appendConsole(lines, [])).toBeUndefined();
    expect(appendConsole(lines, null)).toBe(lines);
    expect(appendConsole(undefined, Array.from({ length: 100 }, (_, i) => ({ channel: "stdout", data: `l${i}\n` })))!.length).toBe(40);
  });

  test("a cell keeps its output and console, a rerun clears the console, and none of it reaches the agent's snapshot or marks a change", () => {
    const nb = new NotebookState();
    nb.apply("kernel-ready", { cell_ids: ["a"], codes: ["print('secret-token'); 1"], names: ["_"] });
    expect(nb.apply("cell-op", { cell_id: "a", console: [{ channel: "stdout", data: "secret-console\n" }], output: { channel: "output", mimetype: "text/plain", data: "secret-output" } })).toBe(false);
    const cell = nb.cells.get("a")!;
    expect(cell.output?.text).toBe("secret-output");
    expect(cell.console?.[0]?.text).toBe("secret-console");
    const text = snapshot([{ notebook: nb, attachment: { path: "/w/nb.py", url: "http://x", sessionId: "s" } }]);
    expect(text).not.toContain("secret-output");
    expect(text).not.toContain("secret-console");
    nb.apply("cell-op", { cell_id: "a", status: "queued" });
    expect(cell.console).toBeUndefined();
    expect(cell.output?.text).toBe("secret-output");
  });
});

describe("running cells", () => {
  test("POSTs cellIds and codes with the session and server token headers", async () => {
    const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
    let token = "old";
    const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (init?.method !== "POST") return { ok: true, status: 200, text: async () => `<html data-token="${token}">` };
      return init.headers?.["Marimo-Server-Token"] === "new" ? { ok: true, status: 200, text: async () => "" } : { ok: false, status: 401, text: async () => "" };
    };
    // The page is fetched once, with the stale token; after a 401 it is fetched again.
    const pending = runCells({ url: "http://h:1", sessionId: "sess" }, [{ id: "a", code: "x = 1" }, { id: "b", code: "y = x" }], undefined, fetchImpl as never);
    token = "new";
    await pending.catch(() => undefined);
    const posts = calls.filter((c) => c.init?.method === "POST");
    expect(posts.length).toBeGreaterThanOrEqual(1);
    expect(posts[0]!.url).toBe("http://h:1/api/kernel/run");
    expect(JSON.parse(posts[0]!.init!.body!)).toEqual({ cellIds: ["a", "b"], codes: ["x = 1", "y = x"] });
    expect(posts[0]!.init!.headers).toMatchObject({ "Marimo-Session-Id": "sess", "Content-Type": "application/json" });
  });

  test("a rejected run throws with marimo's status", async () => {
    const fetchImpl = async (_url: string, init?: { method?: string }) => init?.method === "POST" ? { ok: false, status: 500, text: async () => "" } : { ok: true, status: 200, text: async () => '<html data-token="t5">' };
    await expect(runCells({ url: "http://h:2", sessionId: "s" }, [{ id: "a", code: "" }], undefined, fetchImpl as never)).rejects.toThrow("marimo answered 500");
  });
});

describe("inline images", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
  test("a png output, bare or as a data URL in an <img>, keeps its bytes; other images and huge ones do not", () => {
    expect(summarizeOutput({ channel: "output", mimetype: "image/png", data: png })?.image).toEqual({ mime: "image/png", data: png });
    expect(summarizeOutput({ channel: "output", mimetype: "image/png", data: `data:image/png;base64,${png}` })?.image?.data).toBe(png);
    const html = summarizeOutput({ channel: "output", mimetype: "text/html", data: `<img src='data:image/png;base64,${png}'/>` });
    expect(html).toMatchObject({ kind: "image", image: { data: png } });
    expect(summarizeOutput({ channel: "output", mimetype: "image/jpeg", data: png })?.image).toBeUndefined();
    expect(summarizeOutput({ channel: "output", mimetype: "image/png", data: "A".repeat(2_000_001) })?.image).toBeUndefined();
  });
});

describe("chart specs", () => {
  const spec = { $schema: "https://vega.github.io/schema/vega-lite/v6.json", mark: "bar", data: { values: [{ a: 1 }] } };
  test("a Vega-Lite mimetype and mo.ui.altair_chart's data-spec both keep the spec", () => {
    expect(summarizeOutput({ channel: "output", mimetype: "application/vnd.vegalite.v6+json", data: JSON.stringify(spec) })).toMatchObject({ kind: "chart", vega: JSON.stringify(spec) });
    expect(summarizeOutput({ channel: "output", mimetype: "application/vnd.vegalite.v5+json", data: spec })?.vega).toBe(JSON.stringify(spec));
    const attr = JSON.stringify(spec).replace(/"/gu, "&quot;");
    expect(summarizeOutput({ channel: "output", mimetype: "text/html", data: `<marimo-ui-element><marimo-vega data-initial-value='{}' data-spec='${attr}'></marimo-vega></marimo-ui-element>` })?.vega).toBe(JSON.stringify(spec));
  });
  test("plotly and oversized or malformed specs keep only their label", () => {
    expect(summarizeOutput({ channel: "output", mimetype: "text/html", data: "<marimo-plotly data-figure='x'></marimo-plotly>" })?.vega).toBeUndefined();
    expect(summarizeOutput({ channel: "output", mimetype: "application/vnd.vegalite.v6+json", data: "x".repeat(10) })?.vega).toBeUndefined();
    expect(summarizeOutput({ channel: "output", mimetype: "application/vnd.vegalite.v6+json", data: `{"d":"${"x".repeat(1_600_000)}"}` })?.vega).toBeUndefined();
  });
});

describe("tables, widgets and tracebacks", () => {
  // As marimo 0.25 writes mo.ui.table([{a: 1, b: "x"}, {a: 2, b: "y"}]): single quotes, the rows a JSON string of JSON.
  const table = `<marimo-ui-element object-id='Hbol-0' random-id='r'><marimo-table data-initial-value='[]' data-label='null' data-data='&quot;[{&#92;&quot;a&#92;&quot;:1,&#92;&quot;b&#92;&quot;:&#92;&quot;x&#92;&quot;},{&#92;&quot;a&#92;&quot;:2,&#92;&quot;b&#92;&quot;:&#92;&quot;y&#92;&quot;}]&quot;' data-total-rows='2' data-total-columns='2' data-field-types='[[&quot;a&quot;,[&quot;integer&quot;,&quot;int64&quot;]],[&quot;b&quot;,[&quot;string&quot;,&quot;object&quot;]]]'></marimo-table></marimo-ui-element>`;

  test("a marimo table keeps its first page, its row count and which columns are numbers; it is no widget", () => {
    const out = summarizeOutput({ channel: "output", mimetype: "text/html", data: table })!;
    expect(out).toMatchObject({ kind: "table", text: "[table, 2 rows]" });
    expect(out.table).toEqual({ columns: ["a", "b"], numeric: [true, false], rows: [["1", "x"], ["2", "y"]], totalRows: 2, totalColumns: 2 });
    expect(out.widgets).toBeUndefined();
    expect(summarizeOutput({ channel: "output", mimetype: "text/html", data: "<marimo-table data-total-rows='&quot;too_many&quot;' data-data='[]'></marimo-table>" })?.text).toBe("[table, many rows]");
  });

  test("an HTML table with little around it is a table; one inside prose stays text", () => {
    const html = "<table><thead><tr><th>name</th><th>n</th></tr></thead><tbody><tr><td>a</td><td>1,200</td></tr><tr><td>b</td><td>3.5</td></tr></tbody></table>";
    const out = summarizeOutput({ channel: "output", mimetype: "text/html", data: html })!;
    expect(out.kind).toBe("table");
    expect(out.table).toMatchObject({ columns: ["name", "n"], numeric: [false, true], rows: [["a", "1,200"], ["b", "3.5"]] });
    const prose = `<p>${"A long explanation of the numbers. ".repeat(4)}</p>${html}`;
    expect(summarizeOutput({ channel: "output", mimetype: "text/html", data: prose })?.kind).toBe("text");
  });

  test("widgets: their kind, label, value and range, as marimo writes them", () => {
    const slider = "<marimo-ui-element object-id='Hbol-0' random-id='x'><marimo-slider data-initial-value='0.3' data-label='&quot;&lt;span class=&#92;&quot;markdown&#92;&quot;&gt;alpha&lt;/span&gt;&quot;' data-start='0' data-stop='1' data-step='0.1' data-steps='[]' data-disabled='false'></marimo-slider></marimo-ui-element>";
    const dropdown = "<marimo-ui-element object-id='Hbol-1' random-id='y'><marimo-dropdown data-initial-value='[&quot;Two&quot;]' data-label='null' data-options='[&quot;One&quot;,&quot;Two&quot;]' data-allow-select-none='false'></marimo-dropdown></marimo-ui-element>";
    const checkbox = "<marimo-ui-element object-id='Hbol-2' random-id='z'><marimo-checkbox data-initial-value='true' data-label='&quot;c&quot;' data-disabled='true'></marimo-checkbox></marimo-ui-element>";
    const text = "<marimo-ui-element object-id='Hbol-3' random-id='t'><marimo-text data-initial-value='&quot;hi&quot;' data-label='&quot;t&quot;'></marimo-text></marimo-ui-element>";
    const button = "<marimo-ui-element object-id='Hbol-4' random-id='b'><marimo-button data-initial-value='0' data-label='&quot;go&quot;'></marimo-button></marimo-ui-element>";
    const other = "<marimo-ui-element object-id='Hbol-5' random-id='o'><marimo-file-browser data-initial-value='[]'></marimo-file-browser></marimo-ui-element>";
    const out = summarizeOutput({ channel: "output", mimetype: "text/html", data: `<div>${slider}${dropdown}${checkbox}${text}${button}${other}</div>` })!;
    expect(out.kind).toBe("widgets");
    expect(out.widgets?.map((w) => w.kind)).toEqual(["slider", "dropdown", "checkbox", "text", "button", "other"]);
    expect(out.widgets?.[0]).toMatchObject({ objectId: "Hbol-0", label: "alpha", initial: 0.3, start: 0, stop: 1, step: 0.1, steps: [], disabled: false });
    expect(out.widgets?.[1]).toMatchObject({ label: "", initial: ["Two"], options: ["One", "Two"] });
    expect(out.widgets?.[2]).toMatchObject({ initial: true, disabled: true });
    expect(out.widgets?.[5]).toMatchObject({ kind: "other", tag: "marimo-file-browser" });
    // A widget beside text keeps both.
    const both = summarizeOutput({ channel: "output", mimetype: "text/html", data: `<div>${slider}<p>value 0.3</p></div>` })!;
    expect(both).toMatchObject({ kind: "text", text: "value 0.3" });
    expect(both.widgets).toHaveLength(1);
  });

  test("a traceback is highlighted HTML on the console: it reads as plain stderr", () => {
    const lines = appendConsole(undefined, { channel: "stderr", mimetype: "application/vnd.marimo+traceback", data: '<pre><span class="gt">Traceback (most recent call last):</span>\n  File <span class="s">"x.py"</span>\n<span class="ne">ZeroDivisionError</span>: division by zero</pre>' });
    expect(lines?.map((l) => `${l.stream}:${l.text}`)).toEqual(["stderr:Traceback (most recent call last):", 'stderr:  File "x.py"', "stderr:ZeroDivisionError: division by zero"]);
  });

  test("a mimebundle (marimo 0.25's matplotlib figures) shows its PNG", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
    expect(summarizeOutput({ channel: "output", mimetype: "application/vnd.marimo+mimebundle", data: { "image/png": `data:image/png;base64,${png}`, "text/plain": "<Figure>" } })).toMatchObject({ kind: "image", image: { data: png } });
    expect(summarizeOutput({ channel: "output", mimetype: "application/vnd.marimo+mimebundle", data: JSON.stringify({ "text/plain": "42" }) })).toEqual({ kind: "text", text: "42" });
  });
});
