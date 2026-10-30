import type { AssistantMessage, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { isForkPoint, projectForkTree } from "../src/fork-points.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const text = (value: string, textSignature?: string): TextContent => ({ type: "text", text: value, textSignature });
const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
function message(message: SessionMessageEntry["message"], id = "message", parentId: string | null = null): SessionMessageEntry {
  return { type: "message", id, parentId, timestamp, message };
}
function user(content: UserMessage["content"] = "Prompt", id = "user", parentId: string | null = null) {
  return message({ role: "user", content, timestamp: 1 }, id, parentId);
}
function answer(content: AssistantMessage["content"] = [text("Answer")], stopReason: AssistantMessage["stopReason"] = "stop") {
  return message({
    role: "assistant", content, stopReason, api: "anthropic-messages", provider: "anthropic", model: "fixture", timestamp: 2,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
}
function hidden(id: string, parentId: string | null = null): SessionEntry {
  return { type: "custom", customType: "fixture", data: {}, id, parentId, timestamp };
}
function node(entry: SessionEntry, children: SessionTreeNode[] = []): SessionTreeNode {
  return { entry, children };
}

test.each(["Prompt", " \n Prompt \t", [text(""), text("Prompt")], [image], [text(" \n"), image]].map((content) => ({ content })))("accepts nonempty user content $content", ({ content }) => {
  expect(isForkPoint(user(content))).toBe(true);
});
test.each(["", " \n\t", [], [text("")], [text(" \n"), text("\t")]].map((content) => ({ content })))("rejects empty user content $content", ({ content }) => {
  expect(isForkPoint(user(content))).toBe(false);
});
test("accepts a final stop answer, including untagged text alongside thinking", () => {
  expect(isForkPoint(answer())).toBe(true);
  expect(isForkPoint(answer([{ type: "thinking", thinking: "Private" }, text("Answer")]))).toBe(true);
});
test.each(["length", "toolUse", "pending", "deferred", "error", "aborted"] as const)("rejects %s even with answer text", (reason) => {
  expect(isForkPoint(answer([text("Answer")], reason))).toBe(false);
});
test.each([[], [text("")], [text(" \n\t")], [{ type: "thinking" as const, thinking: "Private" }]].map((content) => ({ content })))("rejects empty/thinking-only assistant content $content", ({ content }) => {
  expect(isForkPoint(answer(content))).toBe(false);
});
test("rejects tool calls even when stopped and accompanied by final text", () => {
  const tool = { type: "toolCall" as const, id: "call", name: "read", arguments: {} };
  expect(isForkPoint(answer([tool]))).toBe(false);
  expect(isForkPoint(answer([text("Answer", '{"v":1,"phase":"final_answer"}'), tool]))).toBe(false);
});
test("rejects system, tool results, custom messages and bookkeeping entries", () => {
  const entries: SessionEntry[] = [
    message({ role: "system", content: "Instructions", timestamp: 0 }),
    message({ role: "toolResult", toolCallId: "call", toolName: "read", content: [text("Result")], isError: false, timestamp: 1 }),
    message({ role: "custom", customType: "fixture", content: "Visible custom message", display: true, timestamp: 1 }),
    hidden("custom"),
    { type: "custom_message", customType: "fixture", content: "Visible", display: true, id: "custom-message", parentId: null, timestamp },
    { type: "session_info", name: "Title", id: "info", parentId: null, timestamp },
    { type: "model_change", provider: "anthropic", modelId: "fixture", id: "model", parentId: null, timestamp },
    { type: "label", targetId: "user", label: "Label", id: "label", parentId: null, timestamp },
  ];
  for (const entry of entries) expect(isForkPoint(entry)).toBe(false);
});
test("uses textSignature phase per block without rewriting mixed answers", () => {
  const commentary = text("Working on it", '{"v":1,"phase":"commentary"}');
  const final = text("Done", '{"v":1,"phase":"final_answer"}');
  expect(isForkPoint(answer([commentary]))).toBe(false);
  expect(isForkPoint(answer([commentary, text(" \n", final.textSignature)]))).toBe(false);
  expect(isForkPoint(answer([final]))).toBe(true);
  const mixed = answer([commentary, final]);
  const before = structuredClone(mixed);
  expect(isForkPoint(mixed)).toBe(true);
  expect(mixed).toEqual(before);
  expect(isForkPoint(answer([commentary, text("Untagged final")]))).toBe(true);
});
test.each([
  undefined, "", "opaque-provider-signature", "{broken", "null", "[]", "1", '"commentary"',
  '{"phase":"commentary"}', '{"v":0,"phase":"commentary"}', '{"v":"1","phase":"commentary"}',
  '{"v":2,"phase":"commentary"}', '{"v":1,"phase":"unknown"}', '{"v":1}',
])("treats invalid/legacy signature %j as untagged", (signature) => {
  expect(isForkPoint(answer([text("Answer", signature)]))).toBe(true);
});

test("promotes descendants, rechains display parents and preserves sibling order and labels", () => {
  const a = node(user("A", "a", "root"), [
    node(hidden("gap", "a"), [node(user("B", "b", "gap")), node(hidden("gap2", "gap"), [node(user("C", "c", "gap2"))])]),
    node(user("D", "d", "a")),
  ]);
  a.label = "Selected label";
  a.labelTimestamp = timestamp;
  a.children[0].children[1].children[0].label = "Promoted label";
  a.children[0].children[1].children[0].labelTimestamp = "later";
  const tree = [node(hidden("root"), [a, node(hidden("other", "root"), [node(user("E", "e", "other"))])]), node(user("F", "f"))];
  const before = structuredClone(tree);
  const projected = projectForkTree(tree, "c");
  expect(projected.tree.map((n) => n.entry.id)).toEqual(["a", "e", "f"]);
  expect(projected.tree[0].children.map((n) => [n.entry.id, n.entry.parentId])).toEqual([["b", "a"], ["c", "a"], ["d", "a"]]);
  expect(projected.tree.map((n) => n.entry.parentId)).toEqual([null, null, null]);
  expect(projected.tree[0]).toMatchObject({ label: "Selected label", labelTimestamp: timestamp });
  expect(projected.tree[0].children[1]).toMatchObject({ label: "Promoted label", labelTimestamp: "later" });
  expect(projected.ids).toEqual(new Set(["a", "b", "c", "d", "e", "f"]));
  expect(projected.leafId).toBe("c");
  expect(tree).toEqual(before);
  expect(projected.tree).not.toBe(tree);
  expect(projected.tree[0]).not.toBe(a);
  expect(projected.tree[0].entry).not.toBe(a.entry);
  expect(projected.tree[0].children).not.toBe(a.children);
  // Changing display-only parent links or children cannot modify the source tree.
  projected.tree[0].entry.parentId = "display-only";
  projected.tree[0].children.pop();
  expect(tree).toEqual(before);
});
test("maps trailing hidden nodes to the nearest retained ancestor, not a later sibling", () => {
  const completed = answer(); completed.id = "answer"; completed.parentId = "user";
  const tree = [node(user(), [node(completed, [node(hidden("one", "answer"), [node(hidden("leaf", "one"))])]), node(user("Sibling", "sibling", "user"))])];
  expect(projectForkTree(tree, "leaf").leafId).toBe("answer");
  expect(projectForkTree(tree, "answer").leafId).toBe("answer");
  expect(projectForkTree(tree, "user").leafId).toBe("user");
  expect(projectForkTree(tree, null).leafId).toBeNull();
  expect(projectForkTree(tree, "missing").leafId).toBeNull();
});
test("keeps other-branch points without selecting them when the leaf branch has no retained ancestor", () => {
  const tree = [node(hidden("root"), [node(hidden("leaf", "root")), node(user("Other branch", "other", "root"))])];
  const result = projectForkTree(tree, "leaf");
  expect(result.tree.map((n) => n.entry.id)).toEqual(["other"]);
  expect(result.tree[0].entry.parentId).toBeNull();
  expect(result.leafId).toBeNull();
  expect(result.ids).toEqual(new Set(["other"]));
});
test("returns an empty projection for empty trees and wholly ineligible trees", () => {
  for (const tree of [[], [node(hidden("root"), [node(answer([text("Internal")], "toolUse")), node(user("", "empty", "root"))])]]) {
    expect(projectForkTree(tree, "empty")).toEqual({ tree: [], leafId: null, ids: new Set() });
  }
});
test("projects deeply nested sessions iteratively without mutating frozen source nodes", () => {
  const depth = 30_000;
  let tree: SessionTreeNode[] = [];
  for (let i = depth - 1; i >= 0; i--) {
    const parentId = i === 0 ? null : String(i - 1);
    const entry = i % 2 === 0 ? user("Prompt", String(i), parentId) : hidden(String(i), parentId);
    Object.freeze(entry);
    const next = node(entry, tree);
    Object.freeze(next.children);
    Object.freeze(next);
    tree = [next];
  }
  Object.freeze(tree);
  const result = projectForkTree(tree, String(depth - 1));
  expect(result.ids.size).toBe(depth / 2);
  expect(result.leafId).toBe(String(depth - 2));
  let nodes = result.tree;
  for (let i = 0; i < depth; i += 2) {
    expect(nodes).toHaveLength(1);
    expect(nodes[0].entry.id).toBe(String(i));
    expect(nodes[0].entry.parentId).toBe(i === 0 ? null : String(i - 2));
    nodes = nodes[0].children;
  }
  expect(nodes).toEqual([]);
});
