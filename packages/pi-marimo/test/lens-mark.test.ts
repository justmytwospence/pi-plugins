import { expect, test } from "vitest";
import { NotebookState } from "../src/core/notebook.js";
import type { Followed } from "../src/core/watcher.js";
import { markCell, pngInfo, unmarkSelection } from "../src/ui/lens-mark.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";

function withLens(): Followed {
  const nb = new NotebookState();
  nb.apply("kernel-ready", { cell_ids: ["a"], codes: ["plot()"], names: ["chart"] });
  nb.apply("model-lifecycle", { model_id: "m1", message: { method: "open", state: { _lens_id: "l", _state: { revision: 4, nextLabel: "S3", selections: [], history: [] } } } });
  return { attachment: { url: "http://h", sessionId: "s", path: "/w/nb.py" }, notebook: nb, connection: "connected", current: true, touchedAt: 0 };
}

test("a PNG's size and digest; anything else is not a PNG", () => {
  expect(pngInfo(png)).toMatchObject({ width: 10, height: 10, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
  expect(pngInfo("aGVsbG8gd29ybGQsIHRoaXMgaXMgbm90IGEgcG5n")).toBeUndefined();
});

test("a mark goes to the notebook's Lens with its picture, and resolves with its label once Lens agrees", async () => {
  const f = withLens();
  const sent: any[] = [];
  const post = async (_t: unknown, modelId: string, content: any, buffers: string[]) => {
    sent.push({ modelId, content, buffers });
    // Lens answers on the stream.
    setTimeout(() => f.notebook.apply("model-lifecycle", { model_id: "m1", message: { method: "custom", content: { protocol: "marimo-lens.response", requestId: content.requestId, ok: true, revision: 5, payload: {} } } }), 10);
  };
  expect(await markCell(f, f.notebook.cells.get("a")!, "why?", { post: post as never, png })).toBe("S3");
  expect(sent[0]).toMatchObject({ modelId: "m1", buffers: [png], content: { type: "selection.put", payload: { expectedRevision: 4, imageAction: "replace", selection: { label: "S3", note: "why?", target: { cellIds: ["a"] }, description: { label: "Cell chart" } } } } });
});

test("Lens's refusal comes back as the error; silence times out", async () => {
  const f = withLens();
  const refuse = async (_t: unknown, _m: string, content: any) => {
    setTimeout(() => f.notebook.apply("model-lifecycle", { model_id: "m1", message: { method: "custom", content: { protocol: "marimo-lens.response", requestId: content.requestId, ok: false, revision: 4, payload: {}, error: { code: "selection_label_conflict", message: "The next Lens selection label is S4." } } } }), 10);
  };
  await expect(markCell(f, f.notebook.cells.get("a")!, "", { post: refuse as never })).rejects.toThrow("The next Lens selection label is S4.");
  await expect(unmarkSelection(f, "sel-1", { post: (async () => {}) as never, waitMs: 50 })).resolves.toBeUndefined();
  await expect(markCell(f, f.notebook.cells.get("a")!, "", { post: (async () => {}) as never, waitMs: 50 })).rejects.toThrow("Lens did not answer.");
});
