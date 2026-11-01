import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, ScrollView } from "@earendil-works/pi-tui";
import { TRANSCRIPT_BLOCK, type TranscriptContext } from "../src/transcript-contract.js";
import { indexTranscript, selectCheckpoint } from "../src/transcript-index.js";
import { captureTranscript, scrollToCheckpoint } from "../src/transcript-viewport.js";

const context: TranscriptContext = { userWords: new Map() };
class Block {
  invalidate() {}
  constructor(public text: string, readonly id?: string) {}
  [TRANSCRIPT_BLOCK]() { return { checkpoint: this.id ? { id: this.id, kind: "test" } : undefined }; }
  render(width: number) { return Array.from({ length: 5 }, (_, i) => `${this.text.slice(0, width)} ${i}`); }
}
function transcript() {
  const root = new Container();
  for (const [text, id] of [["prompt", "p"], ["ordinary tools", undefined], ["answer", "a"], ["plan", "plan"], ["progress", undefined], ["report", "r"], ["final", "f"]]) root.addChild(new Block(text!, id));
  return root;
}
test("checkpoint selection skips unmarked blocks, is strict and clamps without wrapping", () => {
  const index = indexTranscript(transcript(), 80);
  assert.equal(selectCheckpoint(index, 0, 5, -1), undefined);
  assert.equal(selectCheckpoint(index, 0, 5, 1), 9);
  assert.equal(selectCheckpoint(index, 13, 5, -1), 9);
  assert.equal(selectCheckpoint(index, 13, 5, 1), 14);
  assert.equal(selectCheckpoint(index, 29, 5, 1), undefined);
  assert.equal(selectCheckpoint(index, 30, 20, -1), 15);
  assert.equal(selectCheckpoint(index, 15, 20, 1), undefined);
  assert.equal(selectCheckpoint({ lines: ["x"], blocks: [], horizons: [] }, 0, 5, 1), undefined);
});
function host() {
  const doc = transcript();
  const calls: Array<{ row: number; options: unknown }> = [];
  const view = { children: [doc], scrollTop: 20, viewportHeight: 5, getContentWidth: (width: number) => width - 1,
    scrollTo(row: number, options?: unknown) { calls.push({ row, options }); this.scrollTop = row; } };
  const tui = { mode: "fullscreen", getPrimaryScrollView: () => view, requestRender() {},
    currentLayout: { root: { component: view, rect: { width: 46 }, scrollContentLines: doc.render(45), children: [] as unknown[] } } };
  return { tui, view, doc, calls };
}
test("navigation uses the actual split width and keeps follow disabled", () => {
  const { tui, calls } = host();
  assert.equal(captureTranscript(tui)?.width, 45);
  scrollToCheckpoint(tui, context, -1);
  assert.deepEqual(calls, [{ row: 14, options: { disableFollow: true } }]);
  scrollToCheckpoint(tui, context, 1);
  assert.equal(calls.at(-1)?.row, 24);
});
test("missing/ambiguous geometry and regular mode fail closed", () => {
  const { tui, calls } = host();
  tui.currentLayout.root.children.push(tui.currentLayout.root);
  assert.ok(captureTranscript(tui), "cycles do not make a second box");
  tui.currentLayout.root.children.push({ component: tui.getPrimaryScrollView(), rect: { width: 46 } });
  assert.equal(captureTranscript(tui), undefined);
  scrollToCheckpoint(tui, context, 1);
  assert.deepEqual(calls, []);
  tui.mode = "regular";
  assert.equal(captureTranscript(tui), undefined);
});
test("frozen copy scroll-back refuses changed rows, widths, views and documents", () => {
  const { tui, view, doc, calls } = host();
  const capture = captureTranscript(tui)!;
  capture.scrollTo(2);
  assert.equal(calls.length, 1);
  (doc.children[0] as Block).text = "same-height edit";
  capture.scrollTo(3);
  assert.equal(calls.length, 1);
  (doc.children[0] as Block).text = "prompt";
  tui.currentLayout.root.rect.width = 80;
  capture.scrollTo(3);
  assert.equal(calls.length, 1);
  tui.currentLayout.root.rect.width = 46;
  view.children = [transcript()];
  capture.scrollTo(3);
  assert.equal(calls.length, 1);
});
test("navigation refuses growth/shrink before the real ScrollView receives its next layout", () => {
  let fillerRows = 90;
  const document = new Container();
  document.addChild(new Block("first", "first"));
  document.addChild({ render: () => Array<string>(fillerRows).fill("work"), invalidate() {} });
  document.addChild(new Block("last", "last"));
  const view = new ScrollView(document, { follow: "end", primary: true });
  const box = { component: view, rect: { width: 80 }, scrollContentLines: document.render(80) };
  const tui = { mode: "fullscreen", getPrimaryScrollView: () => view, currentLayout: { root: box }, requestRender() {} };
  const frame = () => { box.scrollContentLines = document.render(80); view.updateLayout(box.scrollContentLines.length, 10, () => {}); };
  frame(); view.scrollTo(50, { disableFollow: true });
  fillerRows = 190;
  assert.equal(captureTranscript(tui), undefined);
  scrollToCheckpoint(tui, context, 1);
  assert.equal(view.scrollTop, 50, "must not clamp a new target against old content height");
  assert.equal(view.isFollowingEnd, false);
  frame(); scrollToCheckpoint(tui, context, 1);
  assert.equal(view.scrollTop, 190);
  frame(); assert.equal(view.isFollowingEnd, false);
  view.scrollTo(50, { disableFollow: true });
  fillerRows = 10;
  scrollToCheckpoint(tui, context, -1);
  assert.equal(view.scrollTop, 50, "must not suppress follow against a stale old maximum");
  frame(); scrollToCheckpoint(tui, context, -1); scrollToCheckpoint(tui, context, 1);
  assert.equal(view.scrollTop, 10);
  frame(); assert.equal(view.isFollowingEnd, false, "fresh-layout end checkpoint keeps follow disabled");
});
