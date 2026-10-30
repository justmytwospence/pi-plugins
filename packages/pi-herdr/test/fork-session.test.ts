import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import { createTreeFork, FORK_BOUNDARY } from "../src/fork-session.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "pi-herdr-fork-")); dirs.push(dir); return dir; };
const user = (manager: SessionManager, text: string) => manager.appendMessage({ role: "user", content: text, timestamp: 1 });
const assistant = (manager: SessionManager, text: string) => manager.appendMessage({
  role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "anthropic", model: "fixture",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp: 2,
});
const snapshot = (manager: SessionManager) => ({
  bytes: readFileSync(manager.getSessionFile()!), mode: statSync(manager.getSessionFile()!).mode,
  leaf: manager.getLeafId(), id: manager.getSessionId(), file: manager.getSessionFile(),
  entries: structuredClone(manager.getEntries()), header: structuredClone(manager.getHeader()),
});

function fixture() {
  const dir = temp();
  const manager = SessionManager.create("/original", dir);
  const metadata = manager.appendModelChange("anthropic", "fixture");
  manager.appendThinkingLevelChange("medium");
  manager.appendCustomEntry("other:state", { keep: "extension context" });
  manager.appendCustomMessageEntry("other:message", "Visible context", true, { keep: true });
  const question = user(manager, "Question");
  const answer = assistant(manager, "Answer");
  const descendant = user(manager, "Descendant");
  manager.branch(question);
  const sibling = assistant(manager, "Sibling");
  const tip = user(manager, "Current tip");
  chmodSync(manager.getSessionFile()!, 0o640);
  return { dir, manager, metadata, question, answer, descendant, sibling, tip };
}

test.each(["answer", "tip", "question", "metadata"] as const)("forks inclusively at %s without modifying the live source or its bytes", (point) => {
  const f = fixture(); const before = snapshot(f.manager);
  const entryId = f[point];
  const destination = temp();
  const file = createTreeFork(before.file!, destination, "/current", entryId);
  const fork = SessionManager.open(file);
  expect(file).not.toBe(before.file);
  expect(fork.getSessionDir()).toBe(destination);
  expect(fork.getSessionId()).not.toBe(before.id);
  expect(fork.getHeader()).toMatchObject({ cwd: "/current", parentSession: before.file });
  expect(fork.getCwd()).toBe("/current");
  const branch = fork.getBranch();
  expect(branch.slice(0, -1)).toEqual(f.manager.getBranch(entryId));
  expect(branch.at(-1)).toMatchObject({ type: "custom", customType: FORK_BOUNDARY, parentId: entryId, data: { sourceSessionId: before.id, entryId } });
  expect(branch.some((entry) => entry.id === f.descendant)).toBe(false);
  if (point === "answer") expect(branch.some((entry) => entry.id === f.sibling)).toBe(false);
  if (point !== "metadata") {
    expect(branch).toContainEqual(expect.objectContaining({ customType: "other:state", data: { keep: "extension context" } }));
    expect(fork.buildSessionContext().messages).toContainEqual(expect.objectContaining({ customType: "other:message", content: "Visible context" }));
  }
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  expect(snapshot(f.manager)).toEqual(before);
});

test("keeps resolved labels and lets Pi re-chain ancestry and remap compaction kept-entry references", () => {
  const dir = temp(); const manager = SessionManager.create("/repo", dir);
  const question = user(manager, "Question");
  const label = manager.appendLabelChange(question, "Bookmark");
  const answer = assistant(manager, "Answer");
  const compaction = manager.appendCompaction("Summary", label, 100, { extension: "details" }, true);
  const tip = user(manager, "Continue");
  const before = snapshot(manager);
  const fork = SessionManager.open(createTreeFork(before.file!, dir, "/repo", tip));
  expect(fork.getLabel(question)).toBe("Bookmark");
  expect(fork.getEntry(label)).toBeUndefined();
  expect(fork.getEntry(answer)?.parentId).toBe(question);
  expect(fork.getEntry(compaction)).toMatchObject({ parentId: answer, firstKeptEntryId: answer, summary: "Summary", details: { extension: "details" }, fromHook: true });
  const entries = fork.getBranch();
  const ids = new Set(entries.map((entry) => entry.id));
  expect(entries.every((entry) => entry.parentId === null || ids.has(entry.parentId))).toBe(true);
  expect(entries.filter((entry) => entry.type === "label")).toHaveLength(1);
  expect(snapshot(manager)).toEqual(before);
});

test("each extraction has its own file and ID, even at the same point", () => {
  const f = fixture(); const before = snapshot(f.manager);
  const files = [0, 1].map(() => createTreeFork(before.file!, f.dir, "/repo", f.answer));
  expect(new Set(files).size).toBe(2);
  expect(new Set(files.map((file) => SessionManager.open(file).getSessionId())).size).toBe(2);
  expect(snapshot(f.manager)).toEqual(before);
});

test("rejects an unknown or not-yet-persisted entry without creating a fork", () => {
  const f = fixture(); const before = snapshot(f.manager); const files = readdirSync(f.dir);
  expect(() => createTreeFork(before.file!, f.dir, "/repo", "unpersisted")).toThrow(/selected entry unpersisted was not persisted yet/);
  expect(readdirSync(f.dir)).toEqual(files);
  expect(snapshot(f.manager)).toEqual(before);
});

test("rejects missing and empty source paths without initializing or modifying them", () => {
  const dir = temp(); const missing = join(dir, "missing.jsonl");
  expect(() => createTreeFork(missing, dir, "/repo", "entry")).toThrow(/source session is not persisted/);
  expect(existsSync(missing)).toBe(false);
  const empty = join(dir, "empty.jsonl"); writeFileSync(empty, "", { mode: 0o640 });
  expect(() => createTreeFork(empty, dir, "/repo", "entry")).toThrow(/source session is not persisted/);
  expect(readFileSync(empty, "utf8")).toBe("");
  expect(statSync(empty).mode & 0o777).toBe(0o640);
  expect(readdirSync(dir)).toEqual(["empty.jsonl"]);
});
