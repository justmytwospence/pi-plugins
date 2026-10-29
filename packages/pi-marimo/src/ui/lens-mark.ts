// Lens selections made from Pi's notebook view (`m`): a `selection.put` sent to the notebook's Lens
// widget as the browser sends it (an anywidget custom message over /api/kernel/set_model_value),
// with the cell's picture when Pi has one. The selection is then Lens's like any other: the agent's
// Lens skill reads and resolves it, and pi-marimo shows it in context, the footer and the view.
import { createHash, randomBytes } from "node:crypto";
import { LENS_REQUEST_PREFIX, type LensImage, lensDeleteCommand, lensMarkCommand } from "../core/lens.js";
import type { Cell, NotebookState } from "../core/notebook.js";
import { truncate } from "../core/notebook.js";
import type { Followed } from "../core/watcher.js";
import { setModelValue } from "./interrupt.js";
import { cellLabel, firstLine } from "./rows.js";

/** The document Pi's selections say they were made in (the browser names its page `document:<uuid>`). */
export const LENS_DOCUMENT_ID = `document:pi-marimo-${randomBytes(6).toString("hex")}`;

/** A PNG's size and digest, as Lens wants them beside its bytes; undefined for anything else. */
export function pngInfo(base64: string): Omit<LensImage, "base64"> | undefined {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** What a cell's output is, for the selection's description. */
function outputDetail(cell: Cell): string {
  const out = cell.output;
  if (!out) return "no output yet";
  if (out.table) return `table, ${out.table.totalRows === "many" ? "many" : (out.table.totalRows ?? out.table.rows.length)} rows × ${out.table.totalColumns ?? out.table.columns.length} columns`;
  if (out.kind === "image") return "image output";
  if (out.kind === "chart") return "chart output";
  return truncate(firstLine(out.text) || "no output yet", 200);
}

type Post = typeof setModelValue;
export interface LensCallOptions { token?: string; png?: string; post?: Post; waitMs?: number }

/** Waits for Lens's answer to a request, or for `done` to hold; rejects with Lens's error. */
async function answer(nb: NotebookState, requestId: string, done: () => boolean, waitMs: number): Promise<void> {
  const end = Date.now() + waitMs;
  for (;;) {
    const r = nb.lens.response(requestId);
    if (r) {
      if (r.ok) return;
      throw new Error(r.message ?? r.code ?? "Lens refused the mark");
    }
    if (done()) return;
    if (Date.now() > end) throw new Error("Lens did not answer.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Marks a cell for the agent as a new Lens selection, with the note; resolves with its label (`S3`). */
export async function markCell(f: Followed, cell: Cell, note: string, o: LensCallOptions = {}): Promise<string> {
  const lens = f.notebook.lens.instances()[0];
  if (!lens) throw new Error("This notebook has no Lens.");
  const requestId = `${LENS_REQUEST_PREFIX}${randomBytes(8).toString("hex")}`;
  const selectionId = `pi-${randomBytes(6).toString("hex")}`;
  const png = o.png ?? cell.output?.image?.data;
  const info = png ? pngInfo(png) : undefined;
  const command = lensMarkCommand({
    requestId,
    selectionId,
    label: lens.nextLabel,
    revision: lens.revision,
    cellId: cell.id,
    note,
    documentId: LENS_DOCUMENT_ID,
    createdAt: new Date().toISOString(),
    what: `Cell ${cellLabel(cell)}`,
    detail: outputDetail(cell),
    ...(info && png ? { image: { ...info, base64: png } } : {}),
  });
  await (o.post ?? setModelValue)(f.attachment, lens.modelId, command.content, command.buffers, o.token);
  await answer(f.notebook, requestId, () => f.notebook.lens.selections().some((s) => s.id === selectionId), o.waitMs ?? 8000);
  return lens.nextLabel;
}

/** Removes a Lens selection. */
export async function unmarkSelection(f: Followed, selectionId: string, o: LensCallOptions = {}): Promise<void> {
  const lens = f.notebook.lens.instances()[0];
  if (!lens) throw new Error("This notebook has no Lens.");
  const requestId = `${LENS_REQUEST_PREFIX}${randomBytes(8).toString("hex")}`;
  await (o.post ?? setModelValue)(f.attachment, lens.modelId, lensDeleteCommand({ requestId, selectionId, revision: lens.revision }), [], o.token);
  await answer(f.notebook, requestId, () => !f.notebook.lens.selections().some((s) => s.id === selectionId), o.waitMs ?? 8000);
}
