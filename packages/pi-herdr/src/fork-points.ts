import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";

/** Only the versioned public phase shape is meaningful; opaque signatures are untagged. */
function textPhase(signature: string | undefined): "commentary" | "final_answer" | undefined {
  if (!signature) return undefined;
  try {
    const value: unknown = JSON.parse(signature);
    if (typeof value !== "object" || value === null || !("v" in value) || value.v !== 1 || !("phase" in value)) return undefined;
    return value.phase === "commentary" || value.phase === "final_answer" ? value.phase : undefined;
  } catch {
    return undefined;
  }
}

/** Prompts and completed textual answers, never internal transcript records. */
export function isForkPoint(entry: SessionEntry): boolean {
  if (entry.type !== "message") return false;
  const message = entry.message;
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content.trim().length > 0
      : message.content.some((block) => block.type === "image" || (block.type === "text" && block.text.trim().length > 0));
  }
  if (message.role !== "assistant" || message.stopReason !== "stop") return false;
  if (message.content.some((block) => block.type === "toolCall")) return false;
  return message.content.some((block) => block.type === "text" && block.text.trim().length > 0 && textPhase(block.textSignature) !== "commentary");
}

/** Display-only projection. Original ancestry remains authoritative for copying history. */
export function projectForkTree(tree: readonly SessionTreeNode[], leafId: string | null): { tree: SessionTreeNode[]; leafId: string | null; ids: Set<string> } {
  const projected: SessionTreeNode[] = [];
  const ids = new Set<string>();
  let projectedLeaf: string | null = null;
  type Frame = { node: SessionTreeNode; children: SessionTreeNode[]; parentId: string | null };
  const stack: Frame[] = [];
  for (let i = tree.length - 1; i >= 0; i--) stack.push({ node: tree[i], children: projected, parentId: null });
  while (stack.length) {
    const { node, children, parentId } = stack.pop()!;
    let nearestId = parentId;
    let destination = children;
    if (isForkPoint(node.entry)) {
      const retained: SessionTreeNode = { ...node, entry: { ...node.entry, parentId }, children: [] };
      children.push(retained);
      ids.add(node.entry.id);
      nearestId = node.entry.id;
      destination = retained.children;
    }
    if (node.entry.id === leafId) projectedLeaf = nearestId;
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i], children: destination, parentId: nearestId });
    }
  }
  return { tree: projected, leafId: projectedLeaf, ids };
}
