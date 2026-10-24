import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, expect, test } from "vitest";
import { transcriptWriter } from "../src/conversation.ts";
import { recordedRun } from "../src/index.ts";
import type { Run } from "../src/run.ts";
import { type SessionSource, SessionView, openViewer } from "../src/ui/viewer.ts";
import { KEY, fakeRun, fakeTui, fakeUI, plain } from "./ui-helpers.ts";

// Pi's message and tool components draw with Pi's theme.
beforeAll(() => initTheme("dark"));

const CTRL_C = "\x03";
const SHIFT_TAB = "\x1b[Z";

function liveRun(over: Parameters<typeof fakeRun>[0] = {}) {
  const run = fakeRun({ child: {} as never, state: { turns: 1, startedAt: Date.now() }, ...over });
  const c = run.conversation;
  c.apply({ type: "message_end", message: { role: "user", content: "Find where the config is loaded" } });
  c.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Looking with **rg**." }, { type: "toolCall", id: "t", name: "bash", arguments: { command: "rg loadConfig" } }] } });
  c.apply({ type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "rg loadConfig" } });
  c.apply({ type: "tool_execution_end", toolCallId: "t", result: { content: [{ type: "text", text: "src/config.ts:8" }] }, isError: false });
  c.apply({ type: "message_end", message: { role: "toolResult", toolCallId: "t", toolName: "bash", content: [{ type: "text", text: "src/config.ts:8" }] } });
  return run;
}

function setup(runs: Run[] = [liveRun()], rows = 40) {
  const tui = fakeTui(rows);
  const calls = { done: 0, steer: [] as Array<[string, string]>, stop: [] as string[], background: [] as string[], switched: [] as string[] };
  const source: SessionSource = {
    runs: () => runs,
    enabled: () => true,
    actions: (run) => ({
      steer: (m) => calls.steer.push([run.id, m]) > 0,
      stop: () => void calls.stop.push(run.id),
      background: () => void calls.background.push(run.id),
      canBackground: () => true,
    }),
    contextWindow: () => 200_000,
    onSwitch: (run) => void calls.switched.push(run.id),
  };
  const v = new SessionView(tui as never, runs[0]!, plain, () => void calls.done++, source.actions(runs[0]!), undefined, source);
  v.focused = true;
  return { v, tui, calls, runs };
}

const text = (lines: string[]) => lines.map((l) => stripVTControlCharacters(l).trimEnd()).join("\n");
const type = (v: SessionView, s: string) => {
  for (const ch of s) v.handleInput(ch);
};

test("a subagent's session draws as Pi draws main: transcript, working row, editor, list, footer", () => {
  const { v, runs } = setup();
  const lines = v.render(100);
  // The whole screen, no box and no banner.
  expect(lines).toHaveLength(40);
  expect(lines.every((l) => visibleWidth(l) <= 100)).toBe(true);
  const out = text(lines);
  expect(out).not.toContain("not your main session");
  expect(out).not.toContain("╭");
  expect(out).not.toContain("[User]");
  // Pi's components: the user message, Markdown, and the bash card with its output.
  expect(out).toMatch(/Find where the config is loaded[^]*Looking with rg\.[^]*\$ rg loadConfig[^]*src\/config\.ts:8/u);
  expect(out).toContain("Working");
  // The editor's rules, then the list (this session marked), then the footer.
  expect(out).toMatch(/─{20}\n.*\n─{20}[^]*○ main\n ◉ Find where the config is loaded  scout/u);
  expect(out).toContain("claude-haiku-5 • low");
  expect(out).toContain(`/tmp • ${"Find where the config is loaded"}`);
  // The transcript sits at the top; the editor and footer at the bottom.
  expect(text([lines[1]!])).toContain("Find where the config is loaded");
  expect(text(lines.slice(-2))).toContain("claude-haiku-5");
  void runs;
  v.dispose();
});

test("it follows new output until scrolled up, and again from the end", () => {
  const { v, runs } = setup([liveRun()], 20);
  const c = runs[0]!.conversation;
  const say = (text: string) => {
    const message = { role: "assistant", content: [{ type: "text", text }] };
    c.apply({ type: "message_start", message });
    c.apply({ type: "message_end", message });
  };
  say(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n\n"));
  expect(text(v.render(60))).toContain("line 39");
  v.handleInput("\x1b[5~"); // PageUp
  say("line 40");
  let out = text(v.render(60));
  expect(out).not.toContain("line 40");
  expect(out).toContain("↓ Jump to latest message · ctrl+end");
  v.handleInput("\x1b[1;5F"); // Ctrl+End
  out = text(v.render(60));
  expect(out).toContain("line 40");
  v.dispose();
});

test("typing steers; Ctrl+C clears, then twice on an empty editor stops; Esc goes back to main", () => {
  const { v, calls, runs } = setup();
  type(v, "focus on tests");
  v.handleInput(KEY.enter);
  expect(calls.steer).toEqual([[runs[0]!.id, "focus on tests"]]);
  type(v, "draft");
  v.handleInput(CTRL_C);
  expect(text(v.render(100))).not.toContain("draft");
  expect(calls.stop).toEqual([]);
  v.handleInput(CTRL_C);
  expect(text(v.render(100))).toContain("ctrl+c again to stop Find where the config is loaded");
  v.handleInput(CTRL_C);
  expect(calls.stop).toEqual([runs[0]!.id]);
  expect(calls.done).toBe(0);
  v.handleInput(KEY.escape);
  expect(calls.done).toBe(1);
  v.dispose();
});

test("Tab and Shift+Tab switch sessions through main; drafts stay with their run", () => {
  const second = liveRun({ label: "Second task", state: { startedAt: Date.now() + 1 } });
  const { v, calls, runs } = setup([liveRun(), second]);
  type(v, "half a thought");
  v.handleInput("\t");
  expect(v.current).toBe(second);
  expect(calls.switched).toEqual([second.id]);
  let out = text(v.render(100));
  expect(out).toContain("◉ Second task");
  expect(out).not.toContain("half a thought");
  v.handleInput(SHIFT_TAB);
  expect(v.current).toBe(runs[0]);
  expect(text(v.render(100))).toContain("half a thought");
  // Past the last run is main: the view closes.
  v.handleInput("\t");
  v.handleInput("\t");
  expect(calls.done).toBe(1);
  void out;
  v.dispose();
});

test("↓ from the editor enters the list: select, switch, background, back", () => {
  const second = liveRun({ label: "Second task", state: { startedAt: Date.now() + 1 } });
  const { v, calls } = setup([liveRun(), second]);
  v.handleInput(KEY.down);
  expect((v as any)[Symbol.for("pi-plugins.input-context.v1")]()).toBe("list");
  expect(text(v.render(100))).toContain("j/k select");
  v.handleInput("j");
  v.handleInput("b");
  expect(calls.background).toEqual([second.id]);
  v.handleInput(KEY.enter);
  expect(v.current).toBe(second);
  // Back in the editor after switching; ↓ and Esc in the list return to it.
  v.handleInput(KEY.down);
  v.handleInput(KEY.escape);
  expect(calls.done).toBe(0);
  type(v, "x");
  v.handleInput(KEY.enter);
  expect(calls.steer).toEqual([[second.id, "x"]]);
  // main in the list goes back.
  v.handleInput(KEY.down);
  v.handleInput("k");
  v.handleInput("k");
  expect(calls.done).toBe(0);
  v.handleInput(KEY.enter);
  expect(calls.done).toBe(1);
  v.dispose();
});

test("a finished run has no editor: it shows how it ended; Esc or q goes back", () => {
  const run = liveRun({ child: undefined, state: { status: "failed", error: "boom", endedAt: Date.now() } });
  const { v, calls } = setup([run]);
  const out = text(v.render(100));
  expect(out).toContain("✗ failed: boom");
  expect(out).not.toContain("Working");
  type(v, "hello");
  v.handleInput(CTRL_C);
  v.handleInput(CTRL_C);
  expect(calls.steer).toEqual([]);
  expect(calls.stop).toEqual([]);
  v.handleInput("q");
  expect(calls.done).toBe(1);
  v.dispose();
});

test("opened mid-tool, the running tool's card gets its result later", () => {
  const run = liveRun();
  const c = run.conversation;
  c.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "u", name: "bash", arguments: { command: "npm test" } }] } });
  c.apply({ type: "tool_execution_start", toolCallId: "u", toolName: "bash", args: { command: "npm test" } });
  c.apply({ type: "tool_execution_update", toolCallId: "u", partialResult: { content: [{ type: "text", text: "running 3 tests" }] } });
  const { v } = setup([run]);
  expect(text(v.render(100))).toContain("running 3 tests");
  c.apply({ type: "tool_execution_end", toolCallId: "u", result: { content: [{ type: "text", text: "3 passed" }] }, isError: false });
  expect(text(v.render(100))).toContain("3 passed");
  v.dispose();
});

test("openViewer shows an overlay that re-renders on new messages and resolves on close", async () => {
  const ui = fakeUI();
  const run = liveRun();
  const closed = openViewer(ui, run);
  expect(ui.customs[0]?.options).toMatchObject({ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } });
  const before = ui.tui.renders;
  run.conversation.apply({ type: "message_start", message: { role: "assistant", content: [] } });
  expect(ui.tui.renders).toBeGreaterThan(before);
  ui.customs[0]?.component.handleInput(KEY.escape);
  await closed;
  const after = ui.tui.renders;
  run.conversation.apply({ type: "message_end", message: { role: "assistant", content: [] } });
  expect(ui.tui.renders).toBe(after);
});

test("a recorded run opens from its saved conversation, or else its task and output", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-test-"));
  const record = { id: "abc123", agent: "scout", task: "t", model: "m/x", thinking: "low", byJev: { agent: true, model: false, thinking: false }, status: "running" as const, turns: 2, tokens: 1_500, cost: 0.01, seconds: 9, outputPath: path.join(dir, "abc123", "output.md"), async: true };
  mkdirSync(path.dirname(record.outputPath), { recursive: true });
  writeFileSync(record.outputPath, "the answer");
  const fallback = recordedRun(record);
  expect(fallback.conversation.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(fallback.state).toMatchObject({ status: "stopped", turns: 2, endedAt: 9_000 });
  expect(fallback.state.sessionFile).toBeUndefined();
  const withNativeHistory = recordedRun({ ...record, sessionFile: "/missing/native-child.jsonl" });
  expect(withNativeHistory.state.sessionFile).toBe("/missing/native-child.jsonl");
  expect(withNativeHistory.conversation.messages).toEqual(fallback.conversation.messages);
  const save = transcriptWriter(path.join(dir, "abc123", "messages.jsonl"));
  save({ role: "user", content: [{ type: "text", text: "t" }] });
  save({ role: "assistant", content: [{ type: "text", text: "a" }] });
  save({ role: "toolResult", content: [{ type: "text", text: "r" }] });
  expect(recordedRun(record).conversation.messages).toHaveLength(3);
  const restored = recordedRun({ ...record, sessionFile: "/native/child.jsonl" });
  expect(restored.state.sessionFile).toBe("/native/child.jsonl");
  expect(restored.conversation.messages).toHaveLength(3);
  // Not one of this session's live runs, it is still listed while shown.
  const v = new SessionView(fakeTui() as never, restored, plain, () => undefined, {}, undefined, { runs: () => [], actions: () => ({}), enabled: () => true });
  const out = text(v.render(80));
  expect(out).toContain("◉ t");
  expect(out).toContain("■ stopped");
  v.dispose();
});
