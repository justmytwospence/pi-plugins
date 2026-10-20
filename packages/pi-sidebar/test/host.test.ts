import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Herdr, type Runner } from "../src/herdr.ts";
import { forwardedArgs, isConversationRequest, payloadSystemText, registerHost } from "../src/host.ts";
import { FILES, runtimeDir } from "../src/protocol.ts";
import { FakePi, fakeCtx } from "./fake.ts";

let base: string;
const KEYS = ["TMPDIR", "PI_CODING_AGENT_DIR", "HERDR_ENV", "HERDR_PANE_ID", "PI_CACHE_RETENTION"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const root = tmpdir();

beforeEach(() => {
  base = mkdtempSync(join(root, "pi-sidebar-host-"));
  process.env.TMPDIR = base;
  process.env.PI_CODING_AGENT_DIR = join(base, "agent");
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_PANE_ID;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
});

const PROMPT = "You are an expert coding assistant operating inside pi.";
const mainPayload = () => ({
  model: "claude-x",
  system: [{ type: "text", text: "identity" }, { type: "text", text: `${PROMPT}\nmore` }],
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
});

function attach(sessionId: string) {
  const dir = runtimeDir(sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILES.side), JSON.stringify({ version: 1, pid: process.pid, startedAt: 0 }));
  return dir;
}

describe("forwardedArgs", () => {
  it("passes main's extension-loading flags on, with absolute paths", () => {
    expect(forwardedArgs(["-ne", "-e", "./packages/pi-sidebar", "--extension=/abs/x.ts", "--model", "m", "-e", "npm:foo", "--no-mcp", "hello"], "/repo"))
      .toEqual(["-ne", "-e", "/repo/packages/pi-sidebar", "-e", "/abs/x.ts", "-e", "npm:foo", "--no-mcp"]);
    expect(forwardedArgs(["--continue", "prompt"], "/repo")).toEqual([]);
  });
});

describe("telling main's requests apart", () => {
  it("reads the system text of each API shape", () => {
    expect(payloadSystemText(mainPayload())).toContain(PROMPT);
    expect(payloadSystemText({ instructions: "INS", input: [] })).toBe("INS");
    expect(payloadSystemText({ messages: [{ role: "system", content: "SYS" }] })).toBe("SYS");
  });

  it("accepts main's conversation requests only", () => {
    expect(isConversationRequest(mainPayload(), "claude-x", PROMPT)).toBe(true);
    expect(isConversationRequest(mainPayload(), "other-model", PROMPT)).toBe(false);
    expect(isConversationRequest({ ...mainPayload(), system: [{ type: "text", text: "Summarize this conversation" }] }, "claude-x", PROMPT)).toBe(false);
  });
});

describe("publishing main's last request", () => {
  it("writes nothing while no Sidebar is attached", async () => {
    const pi = new FakePi();
    registerHost(pi as any);
    const { ctx } = fakeCtx({ sessionId: "s1", systemPrompt: PROMPT, model: { provider: "anthropic", id: "claude-x", api: "anthropic-messages" } });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await pi.emit("before_provider_request", { payload: mainPayload() }, ctx);
    await pi.emit("after_provider_response", { status: 200, headers: {} }, ctx);
    expect(existsSync(runtimeDir("s1"))).toBe(false);
  });

  it("writes the request as finally sent, with the leaf it covered", async () => {
    const dir = attach("s2");
    const pi = new FakePi();
    registerHost(pi as any);
    const { ctx } = fakeCtx({ sessionId: "s2", leafId: "leaf-7", systemPrompt: PROMPT, model: { provider: "anthropic", id: "claude-x", api: "anthropic-messages" } });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    const payload = mainPayload();
    await pi.emit("before_provider_request", { payload }, ctx);
    // A later handler edits the same object in place before it is sent.
    (payload.messages[0]!.content as any[]).push({ type: "text", text: "added later" });
    await pi.emit("after_provider_response", { status: 200, headers: {} }, ctx);
    await new Promise((r) => setTimeout(r, 50));
    const written = JSON.parse(readFileSync(join(dir, FILES.payload), "utf8"));
    expect(written.leafId).toBe("leaf-7");
    expect(written.api).toBe("anthropic-messages");
    expect(written.payload.messages[0].content).toHaveLength(2);
    const host = JSON.parse(readFileSync(join(dir, FILES.host), "utf8"));
    expect(host.sessionId).toBe("s2");
    expect(host.pid).toBe(process.pid);
  });

  it("ignores requests that are not main's conversation", async () => {
    const dir = attach("s3");
    const pi = new FakePi();
    registerHost(pi as any);
    const { ctx } = fakeCtx({ sessionId: "s3", systemPrompt: PROMPT, model: { provider: "anthropic", id: "claude-x", api: "anthropic-messages" } });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await pi.emit("before_provider_request", { payload: { ...mainPayload(), system: [{ type: "text", text: "summarize" }] } }, ctx);
    await pi.emit("after_provider_response", { status: 200, headers: {} }, ctx);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(dir, FILES.payload))).toBe(false);
  });

  it("publishes the running tool and the reply being streamed", async () => {
    const dir = attach("s4");
    const pi = new FakePi();
    registerHost(pi as any);
    const { ctx } = fakeCtx({ sessionId: "s4" });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await pi.emit("agent_start", {}, ctx);
    await pi.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "npm test" } }, ctx);
    await new Promise((r) => setTimeout(r, 50));
    let live = JSON.parse(readFileSync(join(dir, FILES.live), "utf8"));
    expect(live.state).toBe("working");
    expect(live.tools).toEqual([expect.objectContaining({ name: "bash", summary: "npm test" })]);
    await pi.emit("tool_execution_end", { toolCallId: "t1", toolName: "bash" }, ctx);
    await pi.emit("message_update", { message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "Tests pass" }] } }, ctx);
    await new Promise((r) => setTimeout(r, 400));
    live = JSON.parse(readFileSync(join(dir, FILES.live), "utf8"));
    expect(live.tools).toEqual([]);
    expect(live.streaming).toBe("Tests pass");
  });

  it("publishes finished results until main commits them", async () => {
    const dir = attach("s7");
    const pi = new FakePi();
    registerHost(pi as any);
    const { ctx } = fakeCtx({ sessionId: "s7" });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await pi.emit("agent_start", {}, ctx);
    await pi.emit("tool_execution_start", { toolCallId: "r", toolName: "read", args: { path: "a.ts" } }, ctx);
    await pi.emit("tool_execution_end", { toolCallId: "r", toolName: "read", isError: false, result: { content: [{ type: "text", text: "export const a = 1;" }] } }, ctx);
    await new Promise((r) => setTimeout(r, 50));
    let live = JSON.parse(readFileSync(join(dir, FILES.live), "utf8"));
    expect(live.finished).toEqual([expect.objectContaining({ name: "read", summary: "a.ts", preview: "export const a = 1;" })]);
    await pi.emit("message_end", { message: { role: "toolResult", toolCallId: "r" } }, ctx);
    await new Promise((r) => setTimeout(r, 400));
    live = JSON.parse(readFileSync(join(dir, FILES.live), "utf8"));
    expect(live.finished).toEqual([]);
  });
});

describe("cleanup", () => {
  it("keeps the shared files on reload and removes them when the session ends", async () => {
    const dir = attach("s6");
    const pi = new FakePi();
    registerHost(pi as any);
    const { ctx } = fakeCtx({ sessionId: "s6" });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await pi.emit("session_shutdown", { reason: "reload" }, ctx);
    expect(existsSync(dir)).toBe(true);
    await pi.emit("session_start", { reason: "reload" }, ctx);
    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("pane control", () => {
  function fakeHerdr(state: { sidebar?: { pane_id: string; tab_id: string } }) {
    const calls: string[][] = [];
    const run: Runner = async (args) => {
      calls.push(args);
      const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
      const key = args.slice(0, 2).join(" ");
      if (key === "pane get") return ok({ pane: { pane_id: "w:p1", tab_id: "w:t1", workspace_id: "w" } });
      if (key === "pane list") return ok({ panes: [{ pane_id: "w:p1", tab_id: "w:t1" }, ...(state.sidebar ? [{ ...state.sidebar, label: "sidebar w:p1" }] : [])] });
      if (key === "tab list") return ok({ tabs: [{ tab_id: "w:t1", label: "1" }] });
      if (key === "pane split") return ok({ pane: { pane_id: "w:p2" } });
      if (key === "pane move") return ok({ move_result: { pane: { pane_id: state.sidebar?.pane_id } } });
      return ok({});
    };
    return { herdr: new Herdr(run, async () => {}), calls };
  }

  const mainCtx = () => fakeCtx({ sessionId: "s5", systemPrompt: PROMPT, model: { provider: "anthropic", id: "claude-x", api: "anthropic-messages" } });

  it("explains that Herdr is needed outside it", async () => {
    const pi = new FakePi();
    const host = registerHost(pi as any, fakeHerdr({}).herdr);
    const c = mainCtx();
    await host.toggle(c.ctx as any);
    expect(c.notes[0]!.message).toMatch(/Herdr/);
  });

  it("creates Sidebar beside main, bound to this session", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w:p1";
    process.env.PI_CACHE_RETENTION = "long";
    const { herdr, calls } = fakeHerdr({});
    const pi = new FakePi();
    const host = registerHost(pi as any, herdr);
    const c = mainCtx();
    await pi.emit("session_start", { reason: "startup" }, c.ctx);
    await host.toggle(c.ctx as any);
    expect(c.notes).toEqual([]);
    const split = calls.find((a) => a[0] === "pane" && a[1] === "split")!;
    // Herdr's ratio is main's share: Sidebar gets the default 40%.
    expect(split[split.indexOf("--ratio") + 1]).toBe("0.6");
    expect(split).toEqual(expect.arrayContaining(["w:p1", "--direction", "right", "--focus", `PI_SIDEBAR_HOST=${runtimeDir("s5")}`, "PI_SIDEBAR_MAIN_PANE=w:p1", "PI_CACHE_RETENTION=long"]));
    expect(calls).toContainEqual(["pane", "rename", "w:p2", "sidebar w:p1"]);
    const start = calls.find((a) => a[0] === "agent")!;
    expect(start.slice(0, 6)).toEqual(["agent", "start", start[2], "--kind", "pi", "--pane"]);
    expect(start).toEqual(expect.arrayContaining(["--continue", "--model", "anthropic/claude-x", "--thinking", "high"]));
    expect(existsSync(join(runtimeDir("s5"), FILES.host))).toBe(true);
  });

  it("parks a visible Sidebar and brings a parked one back", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w:p1";
    const state: { sidebar?: { pane_id: string; tab_id: string } } = { sidebar: { pane_id: "w:p2", tab_id: "w:t1" } };
    const { herdr, calls } = fakeHerdr(state);
    const pi = new FakePi();
    const host = registerHost(pi as any, herdr);
    const c = mainCtx();
    await host.toggle(c.ctx as any);
    expect(calls.find((a) => a[1] === "move")).toEqual(["pane", "move", "w:p2", "--new-tab", "--workspace", "w", "--label", "sidebar-parked", "--no-focus"]);
    calls.length = 0;
    state.sidebar = { pane_id: "w:p2", tab_id: "w:t9" };
    await new Promise((r) => setTimeout(r, 750));
    await host.toggle(c.ctx as any);
    expect(calls.find((a) => a[1] === "move")).toEqual(expect.arrayContaining(["pane", "move", "w:p2", "--tab", "w:t1", "--target-pane", "w:p1", "--focus"]));
  });

  it("ignores a second press while the first is still in flight", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w:p1";
    const { herdr, calls } = fakeHerdr({ sidebar: { pane_id: "w:p2", tab_id: "w:t1" } });
    const pi = new FakePi();
    const host = registerHost(pi as any, herdr);
    const c = mainCtx();
    await Promise.all([host.toggle(c.ctx as any), host.toggle(c.ctx as any)]);
    expect(calls.filter((a) => a[1] === "move")).toHaveLength(1);
  });
});
