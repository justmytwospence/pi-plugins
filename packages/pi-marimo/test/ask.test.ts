import { expect, test } from "vitest";
import { askMessage } from "../src/ask.js";
import { NotebookState } from "../src/core/notebook.js";

test("the message names the cell, its section, its Lens marks and the flags that reach the notebook", () => {
  const nb = new NotebookState();
  nb.apply("kernel-ready", { cell_ids: ["h", "a"], codes: ['mo.md("# Model fit")', "m = fit()"], names: ["_", "fit"] });
  nb.apply("model-lifecycle", { model_id: "m1", message: { method: "open", state: { _lens_id: "l", _state: { revision: 1, nextLabel: "S2", selections: [{ id: "s1", label: "S1", note: "", target: { kind: "notebook", cellIds: ["a"] } }], history: [] } } } });
  const f = { attachment: { url: "http://127.0.0.1:2718", sessionId: "s", path: "/w/notebooks/fit.py" }, notebook: nb };
  expect(askMessage("  why so slow?  ", f, nb.cells.get("a"), "/w")).toBe(
    `why so slow?\n\n(From pi-marimo's notebook view: about cell a "fit" under "Model fit", which has Lens selection S1 in notebooks/fit.py. marimo-pair: --url http://127.0.0.1:2718 --file /w/notebooks/fit.py)`,
  );
  expect(askMessage("hi", f, undefined, "/elsewhere")).toBe("hi\n\n(From pi-marimo's notebook view: about the notebook in /w/notebooks/fit.py. marimo-pair: --url http://127.0.0.1:2718 --file /w/notebooks/fit.py)");
});
