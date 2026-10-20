import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { assembleContext, describeLive, mainDelta, roleMessage, statusMessage, summarizeArgs } from "../src/transcript.ts";
import type { LiveState } from "../src/main-state.ts";

let n = 0;
function chain(messages: any[]): SessionEntry[] {
  const entries: SessionEntry[] = [];
  let parent: string | null = null;
  for (const message of messages) {
    const id = `e${++n}`;
    entries.push({ type: "message", id, parentId: parent, timestamp: new Date(0).toISOString(), message } as SessionEntry);
    parent = id;
  }
  return entries;
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const assistant = (content: any[]) => ({ role: "assistant", content, provider: "p", model: "m", api: "anthropic-messages", usage: {}, stopReason: "stop", timestamp: 0 });
const call = (id: string, command: string) => ({ type: "toolCall", id, name: "bash", arguments: { command } });
const result = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0 });

describe("mainDelta", () => {
  it("returns what main committed after its last request", () => {
    const e = chain([user("go"), assistant([call("a", "ls")]), result("a"), assistant([{ type: "text", text: "done" }])]);
    const delta = mainDelta(e, e[2]!.id, e[3]!.id);
    expect(delta.messages.map((m) => m.role)).toEqual(["assistant"]);
    expect(delta.pending).toEqual([]);
  });

  it("removes a tool call that has no result yet, keeps the turn's text and describes the call", () => {
    const e = chain([user("go"), assistant([{ type: "thinking", thinking: "t" }, { type: "text", text: "running tests" }, call("b", "npm test")])]);
    const delta = mainDelta(e, e[0]!.id, e[1]!.id);
    expect(delta.messages).toHaveLength(1);
    expect((delta.messages[0] as any).content).toEqual([{ type: "text", text: "running tests" }]);
    expect(delta.pending).toEqual([{ name: "bash", summary: "npm test" }]);
  });

  it("drops a turn that holds nothing but open calls", () => {
    const e = chain([user("go"), assistant([call("b2", "npm test")])]);
    const delta = mainDelta(e, e[0]!.id, e[1]!.id);
    expect(delta.messages).toEqual([]);
    expect(delta.pending).toEqual([{ name: "bash", summary: "npm test" }]);
  });

  it("keeps the calls of a parallel turn that have returned, with their results", () => {
    const e = chain([user("go"), assistant([{ type: "thinking", thinking: "t" }, call("c", "a"), call("d", "b")]), result("c")]);
    const delta = mainDelta(e, e[0]!.id, e[2]!.id);
    expect(delta.messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    expect((delta.messages[0] as any).content).toEqual([call("c", "a")]);
    expect(delta.pending).toEqual([{ name: "bash", summary: "b" }]);
  });

  it("keeps finished tool turns", () => {
    const e = chain([user("go"), assistant([call("f", "a")]), result("f")]);
    const delta = mainDelta(e, e[0]!.id, e[2]!.id);
    expect(delta.messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
  });

  it("drops a leading orphan tool result", () => {
    const e = chain([user("go"), assistant([call("g", "a")]), result("g"), assistant([{ type: "text", text: "x" }])]);
    const delta = mainDelta(e, e[1]!.id, e[3]!.id);
    expect(delta.messages.map((m) => m.role)).toEqual(["assistant"]);
  });

  it("skips the delta when the recorded leaf is gone from the path", () => {
    const e = chain([user("a"), user("b")]);
    const delta = mainDelta(e, "missing", e[1]!.id);
    expect(delta.messages).toEqual([]);
    expect(delta.skipped).toMatch(/changed/);
  });

  it("is empty with no recorded leaf", () => {
    expect(mainDelta(chain([user("a")]), null, null)).toEqual({ messages: [], pending: [] });
  });
});

describe("live note", () => {
  const live: LiveState = {
    state: "working", since: 0, finished: [],
    tools: [{ id: "t", name: "bash", summary: "npm test", startedAt: 1000 }],
    streaming: "half a sentence",
  };

  it("describes the running tool and the streaming tail", () => {
    const text = describeLive(live, { messages: [], pending: [] }, 43_000);
    expect(text).toContain("Main is working");
    expect(text).toContain("Running now: bash `npm test` (42s)");
    expect(text).toContain("half a sentence");
  });

  it("shows results of finished parallel calls and does not repeat them as pending", () => {
    const text = describeLive(
      { ...live, tools: [], finished: [{ id: "r", name: "read", summary: "a.ts", startedAt: 0, isError: false, preview: "line 1\nline 2" }] },
      { messages: [], pending: [{ name: "read", summary: "a.ts" }, { name: "bash", summary: "sleep 9" }] },
      5000,
    );
    expect(text).toContain("Finished, while other calls of the same turn still run: read `a.ts`");
    expect(text).toContain("    line 2");
    expect(text).toContain("Called, no result yet: bash `sleep 9`");
    expect(text).not.toContain("Called, no result yet: read");
  });

  it("falls back to pending calls and reports an exited main", () => {
    const text = describeLive({ ...live, state: "idle", tools: [], streaming: undefined }, { messages: [], pending: [{ name: "edit", summary: "src/a.ts" }] }, 5000, false);
    expect(text).toContain("has exited");
    expect(text).toContain("Called, no result yet: edit `src/a.ts`");
    expect(text).not.toContain("Writing now");
  });

  it("writes the role and the timestamped status as user messages", () => {
    const role = roleMessage(0) as any;
    expect(role.role).toBe("user");
    expect(role.content[0].text).toMatch(/^<sidebar>\nYou are Sidebar/);
    expect(role.content[0].text).toContain("spans time");
    const status = statusMessage("Main is idle.", 0) as any;
    expect(status.content[0].text).toBe('<sidebar-status at="1970-01-01T00:00:00.000Z">\nMain is idle.\n</sidebar-status>');
  });
});

describe("assembleContext", () => {
  const system = { role: "system", content: "", timestamp: 0 } as any;
  const d = assistant([{ type: "text", text: "d" }]) as any;
  const role = user("role") as any;
  const status = user("status") as any;

  it("puts main's delta and the role first and the live status just before the newest question", () => {
    const q1 = user("q1") as any;
    const a1 = assistant([{ type: "text", text: "a1" }]) as any;
    const q2 = user("q2") as any;
    expect(assembleContext([system, q1, a1, q2], [d], role, status)).toEqual([system, d, role, q1, a1, status, q2]);
    expect(assembleContext([q1], [], role, status)).toEqual([role, status, q1]);
  });

  it("keeps the status before the question during Sidebar's own tool calls", () => {
    const q = user("q") as any;
    const callTurn = assistant([call("s1", "ls")]) as any;
    const res = result("s1") as any;
    expect(assembleContext([system, q, callTurn, res], [], role, status)).toEqual([system, role, status, q, callTurn, res]);
  });
});

describe("summarizeArgs", () => {
  it("prefers the command or path and truncates", () => {
    expect(summarizeArgs({ command: "ls   -la\n x" })).toBe("ls -la x");
    expect(summarizeArgs({ path: "a.ts", offset: 1 })).toBe("a.ts");
    expect(summarizeArgs({ x: "y".repeat(500) }, 20)).toHaveLength(20);
    expect(summarizeArgs(undefined)).toBe("");
  });
});
