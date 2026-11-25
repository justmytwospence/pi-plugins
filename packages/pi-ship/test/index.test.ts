import { describe, expect, it } from "vitest";
import piShip from "../src/index.ts";
import { clock, fakeExec, OLD, ok, run, SHA } from "./fake.ts";

const PUSHED = `To git@github.com:o/r.git\n   ${OLD.slice(0, 7)}..${SHA.slice(0, 7)}  main -> main\n`;

function harness(rules: Array<[RegExp, any]> = []) {
  const c = clock();
  const handlers = new Map<string, Array<(e: any, ctx: any) => unknown>>();
  const commands = new Map<string, any>();
  const bus = new Map<string, Array<(d: any) => void>>();
  const emitted: Array<{ channel: string; data: any }> = [];
  const sent: Array<{ message: any; opts: any }> = [];
  const { exec, calls } = fakeExec([
    ...rules,
    [/^gh api/, ok(SHA)],
    [/^gh run list/, ok(JSON.stringify([run({ conclusion: "failure" })]))],
    [/^gh run view/, ok("it broke")],
  ]);
  const pi = {
    on: (name: string, h: (e: any, ctx: any) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    registerCommand: (name: string, o: any) => commands.set(name, o),
    sendMessage: (message: any, opts: any) => sent.push({ message, opts }),
    events: {
      on: (ch: string, h: (d: any) => void) => bus.set(ch, [...(bus.get(ch) ?? []), h]),
      emit: (channel: string, data: any) => {
        emitted.push({ channel, data });
        for (const h of bus.get(channel) ?? []) h(data);
      },
    },
  };
  piShip(pi as any, { exec, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
  const ctx = { cwd: "/r", mode: "tui", hasUI: true, idle: true, isIdle() { return this.idle; }, ui: { notify: () => undefined } };
  const emit = async (name: string, event: any) => {
    for (const h of handlers.get(name) ?? []) await h(event, ctx);
  };
  const bash = (command: string, text: string, isError = false) => ({ type: "tool_result", toolName: "bash", toolCallId: "t", isError, input: { command }, content: [{ type: "text", text }], details: undefined });
  return { c, ctx, emit, bash, commands, bus, emitted, sent, calls };
}

describe("pi-ship", () => {
  it("registers /ship and offers its activity section in the TUI", async () => {
    const h = harness();
    expect([...h.commands.keys()]).toEqual(["ship"]);
    await h.emit("session_start", { type: "session_start" });
    const offered = h.emitted.filter((e) => e.channel === "activity:section");
    expect(offered).toHaveLength(1);
    expect(offered[0]!.data.section.id).toBe("ship");
    h.bus.get("activity:host")![0]!({});
    expect(h.emitted.filter((e) => e.channel === "activity:section")).toHaveLength(2);
  });

  it("offers nothing outside the TUI", async () => {
    const h = harness();
    h.ctx.mode = "rpc";
    await h.emit("session_start", { type: "session_start" });
    expect(h.emitted.filter((e) => e.channel === "activity:section")).toEqual([]);
  });

  it("a successful git push through bash starts a watch that wakes the agent on red", async () => {
    const h = harness();
    await h.emit("session_start", { type: "session_start" });
    await h.emit("tool_result", h.bash("git push origin main", PUSHED));
    await h.c.advance(120_000);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(h.sent[0]!.message).toMatchObject({ customType: "pi-ship", display: true });
    expect(h.sent[0]!.message.content).toContain("CI failed for main");
    const section = h.emitted.find((e) => e.channel === "activity:section")!.data.section;
    expect(section.entries(h.c.now())[0]).toMatchObject({ key: `ci:${SHA.slice(0, 7)}`, status: "failed" });
    expect(section.pill(h.c.now())).toEqual({ label: "", alert: "CI failed" });
  });

  it("holds the message until the agent is idle, then sends it at agent_end", async () => {
    const h = harness();
    await h.emit("session_start", { type: "session_start" });
    h.ctx.idle = false;
    await h.emit("tool_result", h.bash("git push", PUSHED));
    await h.c.advance(120_000);
    expect(h.sent).toEqual([]);
    h.ctx.idle = true;
    await h.emit("agent_end", { type: "agent_end", messages: [] });
    expect(h.sent).toHaveLength(1);
  });

  it("drops a message that bg_wait already consumed", async () => {
    const h = harness();
    await h.emit("session_start", { type: "session_start" });
    h.ctx.idle = false;
    await h.emit("tool_result", h.bash("git push", PUSHED));
    await h.c.advance(120_000);
    h.bus.get("bg:external-consumed")![0]!({ id: `ci:${SHA.slice(0, 7)}` });
    h.ctx.idle = true;
    await h.emit("agent_end", { type: "agent_end", messages: [] });
    expect(h.sent).toEqual([]);
  });

  it("ignores failed pushes, other commands, other hosts and other tools", async () => {
    const h = harness();
    await h.emit("session_start", { type: "session_start" });
    await h.emit("tool_result", h.bash("git push", PUSHED, true));
    await h.emit("tool_result", h.bash("git status", PUSHED));
    await h.emit("tool_result", h.bash("git push", PUSHED.replace("github.com:o/r", "gitlab.com:o/r")));
    await h.emit("tool_result", { ...h.bash("git push", PUSHED), toolName: "read" });
    await h.emit("tool_result", h.bash("git push", "Everything up-to-date"));
    await h.c.advance(120_000);
    expect(h.calls.filter((c) => c.startsWith("gh"))).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("session_shutdown ends the watches and withdraws the section", async () => {
    const h = harness([[/^gh run list/, ok(JSON.stringify([run({ status: "in_progress", conclusion: "" })]))]]);
    await h.emit("session_start", { type: "session_start" });
    await h.emit("tool_result", h.bash("git push", PUSHED));
    await h.c.advance(20_000);
    await h.emit("session_shutdown", { type: "session_shutdown" });
    expect(h.emitted.some((e) => e.channel === "activity:gone" && e.data.id === "ship")).toBe(true);
    await h.c.advance(10 * 60_000);
    expect(h.sent).toEqual([]);
  });
});
