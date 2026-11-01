import assert from "node:assert/strict";
import { test } from "node:test";
import { Container } from "@earendil-works/pi-tui";
import { CHECKPOINT_DETAILS_KEY, TRANSCRIPT_BLOCK, TRANSCRIPT_ROWS, transcriptCheckpoint, readTranscriptCheckpoint, type TranscriptContext, type TranscriptRowsContext } from "../src/transcript-contract.js";
import { collectUserWords, indexTranscript, spliceTranscriptRows } from "../src/transcript-index.js";

const context: TranscriptContext = { userWords: new Map() };
class ToolExecutionComponent {
  invalidate() {}
  toolName = "unknown-tool"; toolCallId = "tool1"; args = {}; isPartial = false;
  constructor(public result: { details?: object; content?: unknown; isError?: boolean }, public text = "A report-looking final plan") {}
  render() { return [this.text]; }
}
class CustomMessageComponent {
  invalidate() {}
  constructor(public message: { display?: boolean; details?: object }) {}
  render() { return ["custom artifact"]; }
}
class AssistantMessageComponent {
  invalidate() {}
  isStreaming = false;
  constructor(public lastMessage: { content: unknown[]; stopReason: string }) {}
  render() { return ["assistant"]; }
}
const checkpoint = { id: "event1", kind: "third-party-kind" };

test("checkpoint annotations are immutable, versioned and preserve other details", () => {
  const original = { content: [{ type: "text", text: "answer" }], details: { markdown: [0], nested: { n: 1 } } };
  const marked = transcriptCheckpoint(original, checkpoint);
  assert.deepEqual(original.details, { markdown: [0], nested: { n: 1 } });
  assert.equal(marked.content, original.content);
  assert.equal(marked.details.nested, original.details.nested);
  assert.deepEqual(readTranscriptCheckpoint(JSON.parse(JSON.stringify(marked)).details), checkpoint);
  assert.equal(readTranscriptCheckpoint({ [CHECKPOINT_DETAILS_KEY]: { version: 2, checkpoint } }), undefined);
  assert.equal(readTranscriptCheckpoint({ [CHECKPOINT_DETAILS_KEY]: { version: 1, checkpoint: { id: "", kind: "report" } } }), undefined);
  assert.throws(() => transcriptCheckpoint(original, { id: "", kind: "report" }), TypeError);
  assert.throws(() => transcriptCheckpoint({ details: "scalar" } as never, checkpoint), TypeError);
});
test("explicit unknown-plugin annotations work and wording cannot create a stop", () => {
  const root = new Container();
  const plain = new ToolExecutionComponent({});
  const marked = new ToolExecutionComponent(transcriptCheckpoint({ details: {} }, checkpoint), "x");
  root.addChild(plain); root.addChild(marked);
  const before = indexTranscript(root, 80, context);
  assert.deepEqual(before.blocks.map(b => b.checkpoint?.id), [undefined, "event1"]);
  plain.text = "IMPORTANT COMPLETE REPORT APPROVED PLAN";
  marked.text = "unimportant status";
  assert.deepEqual(indexTranscript(root, 80, context).blocks.map(b => b.checkpoint?.id), [undefined, "event1"]);
  marked.isPartial = true;
  assert.equal(indexTranscript(root, 80, context).blocks[1]?.checkpoint, undefined);
});
test("custom messages use only the versioned annotation and explicit display", () => {
  const root = new Container();
  root.addChild(new CustomMessageComponent(transcriptCheckpoint({ details: {} }, checkpoint)));
  root.addChild(new CustomMessageComponent({ display: false, ...transcriptCheckpoint({ details: {} }, { ...checkpoint, id: "hidden" }) }));
  assert.deepEqual(indexTranscript(root, 80, context).blocks.map(b => b.checkpoint?.id), ["event1", undefined]);
});
test("native response boundaries depend on typed text/tool blocks and terminal state", () => {
  for (const stopReason of ["stop", "length", "error", "aborted", "pending", "deferred", "toolUse"]) {
    const node = new AssistantMessageComponent({ content: [{ type: "text", text: "arbitrary words" }], stopReason });
    assert.equal(!!indexTranscript(node, 80).blocks[0]?.checkpoint, ["stop", "length", "error", "aborted"].includes(stopReason));
    node.isStreaming = true;
    assert.equal(indexTranscript(node, 80).blocks[0]?.checkpoint, undefined);
  }
  for (const content of [[{ type: "thinking", thinking: "thoughts" }], [{ type: "text", text: "preamble" }, { type: "toolCall" }]]) {
    assert.equal(indexTranscript(new AssistantMessageComponent({ content, stopReason: "stop" }), 80).blocks[0]?.checkpoint, undefined);
  }
});
test("human words are explicit optional providers, with isolated failures and inert late offers", () => {
  let late: ((name: string, fn: any) => void) | undefined;
  const extract = () => "user answer";
  const registry = collectUserWords({ emit(_name, data) {
    const request = data as { register: typeof late };
    late = request.register;
    request.register?.("unknown-tool", () => { throw Error("provider failure"); });
    request.register?.("*", extract); request.register?.("*", extract);
  } });
  late?.("late", extract);
  assert.equal(registry.has("late"), false);
  assert.equal(registry.get("*")?.length, 1);
  const root = new ToolExecutionComponent({ isError: true });
  const block = indexTranscript(root, 80, { userWords: registry }).blocks[0]!;
  assert.equal(block.userText, "user answer");
  assert.equal(block.checkpoint?.kind, "feedback");
});
test("transformed groups expose semantic subjects as one actual visible range", () => {
  class Group {
    [TRANSCRIPT_BLOCK]() { return { kind: "tool" as const, subjects: [this, new ToolExecutionComponent(transcriptCheckpoint({ details: {} }, checkpoint))] }; }
    render() { return ["one group", "two group"]; }
  }
  const index = indexTranscript(new Group(), 80);
  assert.equal(index.blocks.length, 1);
  assert.equal(index.blocks[0]?.end, 2);
  assert.equal(index.blocks[0]?.checkpoint?.id, checkpoint.id);
});
test("unknown transformed containers do not fabricate descendant coordinates", () => {
  const root = new Container();
  root.addChild(new ToolExecutionComponent(transcriptCheckpoint({ details: {} }, checkpoint)));
  root.render = () => ["different layout"];
  assert.deepEqual(indexTranscript(root, 80).blocks, []);
});
test("row hooks map deleted sentinels and padding without teaching the indexer a sentinel", () => {
  class Cleared extends Container {
    render(w: number) { return super.render(w).filter(line => line !== "sentinel").concat("", ""); }
    [TRANSCRIPT_ROWS](ctx: TranscriptRowsContext) {
      let index = ctx.index(this.children, ctx.width);
      index = ctx.splice(index, 1, 1, []);
      index.horizons.push(1);
      return ctx.splice(index, index.lines.length, 0, ["", ""]);
    }
  }
  const root = new Cleared(); root.addChild({ render: () => ["before"], invalidate() {} }); root.addChild({ render: () => ["sentinel"], invalidate() {} });
  root.addChild(new ToolExecutionComponent(transcriptCheckpoint({ details: {} }, checkpoint)));
  const index = indexTranscript(root, 80);
  assert.deepEqual(index.lines, ["before", "A report-looking final plan", "", ""]);
  assert.equal(index.blocks.find(b => b.checkpoint)?.start, 1);
  assert.deepEqual(index.horizons, [1]);
  assert.equal(spliceTranscriptRows(index, 1, 1, []).blocks.some(b => b.checkpoint), false);
});
test("empty represented content creates no stop, image/control rows keep geometry", () => {
  class Artifact {
    invalidate() {}
    [TRANSCRIPT_BLOCK]() { return { checkpoint }; }
    constructor(public lines: string[]) {}
    render() { return this.lines; }
  }
  const root = new Container();
  root.addChild(new Artifact(["", "\x1b[31m \x1b[0m"]));
  root.addChild(new Artifact(["\x1b_Gimage-data\x1b\\", "caption"]));
  const index = indexTranscript(root, 80);
  assert.equal(index.lines.length, 4);
  assert.equal(index.blocks[0]?.checkpoint, undefined);
  assert.equal(index.blocks[1]?.start, 2);
});
test("row transforms recheck final visibility and cannot invent or alter checkpoint membership", () => {
  class Artifact {
    [TRANSCRIPT_BLOCK]() { return { checkpoint }; }
    render() { return ["visible artifact", "\x1b[31m \x1b[0m"]; }
  }
  class Removed extends Container {
    render(w: number) { return super.render(w).slice(1); }
    [TRANSCRIPT_ROWS](ctx: TranscriptRowsContext) { return ctx.splice(ctx.index(this.children, ctx.width), 0, 1, []); }
  }
  const removed = new Removed();
  removed.children.push(new Artifact() as never);
  assert.equal(indexTranscript(removed, 80).blocks[0]?.checkpoint, undefined);
  class Invented {
    render() { return ["unmarked status"]; }
    [TRANSCRIPT_ROWS](ctx: TranscriptRowsContext) {
      return { lines: [...ctx.lines], blocks: [{ start: 0, end: 1, source: this, kind: "other" as const, error: false, checkpoint }], horizons: [] };
    }
  }
  assert.deepEqual(indexTranscript(new Invented(), 80).blocks, []);
  class Altered extends Container {
    [TRANSCRIPT_ROWS](ctx: TranscriptRowsContext) {
      const index = ctx.index(this.children, ctx.width);
      index.blocks[0]!.checkpoint = { id: "forged", kind: "other-kind" };
      return index;
    }
  }
  const altered = new Altered(); altered.children.push(new Artifact() as never);
  assert.deepEqual(indexTranscript(altered, 80).blocks, []);
});
