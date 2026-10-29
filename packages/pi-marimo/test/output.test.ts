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
