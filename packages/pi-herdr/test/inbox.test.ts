import { describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import { DraftGuard } from "../src/draft-guard.ts";
import {
  ackTokenName,
  decodeEnvelope,
  type Envelope,
  encodeEnvelope,
  Inbox,
  type InboxHost,
  isEnvelopePaste,
  messageText,
  type Outcome,
  PASTE_END,
  PASTE_START,
  parseInboxToken,
} from "../src/inbox.ts";
import { fakeCall } from "./core/fake.ts";

const env = (over: Partial<Envelope> = {}): Envelope => ({
  v: 1,
  id: "abc123",
  from: { pane: "w1:p1", name: "lead", host: "mac", cwd: "/r" },
  text: "hello\nthere \x1b[201~ tricky",
  delivery: "steer",
  ...over,
});

describe("envelope", () => {
  it("round-trips, even text that contains a paste end", () => {
    const wire = encodeEnvelope(env());
    expect(isEnvelopePaste(wire)).toBe(true);
    expect(wire.indexOf(PASTE_END)).toBe(wire.length - PASTE_END.length);
    expect(decodeEnvelope(wire)).toEqual(env());
  });

  it("rejects malformed envelopes and ordinary pastes", () => {
    expect(isEnvelopePaste(`${PASTE_START}hello${PASTE_END}`)).toBe(false);
    const wire = encodeEnvelope(env());
    expect(decodeEnvelope(wire.replace(/.{8}(?=\x1b\[201~$)/u, "!!!!!!!!"))).toBeUndefined();
    expect(decodeEnvelope(encodeEnvelope(env({ text: "  " })))).toBeUndefined();
    expect(decodeEnvelope(encodeEnvelope(env({ id: "../x" })))).toBeUndefined();
    expect(decodeEnvelope(encodeEnvelope({ ...env(), delivery: "now" as never }))).toBeUndefined();
  });

  it("tells the model who sent it and whether its reply goes back", () => {
    expect(messageText(env())).toContain('Message from pi agent "lead" in herdr pane w1:p1 (mac, /r)');
    expect(messageText(env())).toContain("not sent back automatically");
    expect(messageText(env())).toContain("do not message it back unless it asks");
    expect(messageText(env({ from: { pane: "w1:p1", title: "Fix the parser" } }))).toContain('the pi session "Fix the parser"');
    expect(messageText(env({ awaitsReply: true }))).toContain("is sent back");
  });

  it("parses inbox tokens", () => {
    expect(parseInboxToken("v1:4242")).toBe(4242);
    expect(parseInboxToken("v2:1")).toBeUndefined();
    expect(parseInboxToken(undefined)).toBeUndefined();
  });
});

function host(state: { idle?: boolean; blocked?: number; fail?: boolean } = {}) {
  const delivered: [string, string | undefined][] = [];
  const acks: [string, Outcome][] = [];
  const notes: string[] = [];
  const h: InboxHost = {
    isIdle: () => state.idle,
    blocked: () => state.blocked ?? 0,
    deliver: (e, as) => {
      if (state.fail) return false;
      delivered.push([e.id, as]);
      return true;
    },
    ack: (e, o) => acks.push([e.id, o]),
    notify: (m) => notes.push(m),
  };
  return { h, delivered, acks, notes, state };
}

describe("inbox", () => {
  it("consumes envelopes and passes everything else through", () => {
    const t = host({ idle: true });
    const inbox = new Inbox(t.h);
    expect(inbox.input("a")).toBeUndefined();
    expect(inbox.input(`${PASTE_START}x${PASTE_END}`)).toBeUndefined();
    expect(inbox.input(encodeEnvelope(env()))).toEqual({ consume: true });
    expect(t.delivered).toEqual([["abc123", undefined]]);
    expect(t.acks).toEqual([["abc123", "started"]]);
  });

  it("drops a malformed envelope with a notice instead of typing it", () => {
    const t = host({ idle: true });
    expect(new Inbox(t.h).input(`${PASTE_START}\u2063\u2063pi-herdr/v1 garbage${PASTE_END}`)).toEqual({ consume: true });
    expect(t.delivered).toEqual([]);
    expect(t.notes[0]).toContain("malformed");
  });

  it.each([
    [{ idle: true }, "steer", undefined, "started"],
    [{ idle: false }, "steer", "steer", "steered"],
    [{ idle: false }, "queue", "followUp", "queued"],
    [{ idle: undefined }, "queue", "followUp", "queued"],
    [{ idle: false, blocked: 1 }, "steer", "steer", "steered"],
  ] as const)("delivers by state %o (%s)", (state, delivery, as, outcome) => {
    const t = host(state);
    expect(new Inbox(t.h).receive(env({ delivery }))).toBe(outcome);
    expect(t.delivered).toEqual([["abc123", as]]);
    expect(t.acks).toEqual([["abc123", outcome]]);
  });

  it("holds a message while a dialog is open on an idle session, and says so", () => {
    const t = host({ idle: true, blocked: 1 });
    const inbox = new Inbox(t.h);
    expect(inbox.receive(env())).toBe("held");
    expect(t.delivered).toEqual([]);
    expect(t.notes[0]).toContain("held until the dialog closes");
    inbox.flush();
    expect(t.delivered).toEqual([]);
    t.state.blocked = 0;
    inbox.flush();
    expect(t.delivered).toEqual([["abc123", undefined]]);
    expect(inbox.held).toEqual([]);
  });

  it("delivers a message only once", () => {
    const t = host({ idle: true });
    const inbox = new Inbox(t.h);
    inbox.receive(env());
    expect(inbox.receive(env())).toBeUndefined();
    expect(t.delivered).toHaveLength(1);
  });

  it("holds a message pi refused and retries on flush", () => {
    const t = host({ idle: true, fail: true });
    const inbox = new Inbox(t.h);
    expect(inbox.receive(env())).toBe("held");
    t.state.fail = false;
    inbox.flush();
    expect(t.delivered).toEqual([["abc123", undefined]]);
  });
});

describe("draft guard", () => {
  const ENTER = "\r";
  const paste = (t: string) => `${PASTE_START}${t}${PASTE_END}`;
  function editor(text = "", accept = true) {
    let clock = 10_000;
    const state = { text, notes: [] as string[], submitted: [] as string[] };
    const guard = new DraftGuard({
      getText: () => state.text,
      setText: (t) => { state.text = t; },
      notify: (m) => state.notes.push(m),
      submit: (t) => { if (accept) state.submitted.push(t); return accept; },
      isEnter: (d) => d === ENTER,
    }, () => clock);
    /** What the editor does with input the guard passes through: Enter submits and clears. */
    const type = (data: string) => {
      const r = guard.input(data);
      if (r?.consume) return "consumed";
      if (data === ENTER) {
        const sent = state.text;
        state.text = "";
        return sent;
      }
      state.text += data.startsWith(PASTE_START) ? data.slice(PASTE_START.length, -PASTE_END.length) : data;
      return undefined;
    };
    return { state, type, tick: (ms: number) => { clock += ms; } };
  }

  it("sends an injected prompt alone without the editor, and the idle draft never leaves it", () => {
    const e = editor("my draft ");
    expect(e.type(paste("from elsewhere"))).toBeUndefined();
    e.tick(300);
    expect(e.type(ENTER)).toBe("consumed");
    expect(e.state.submitted).toEqual(["from elsewhere"]);
    expect(e.state.text).toBe("my draft ");
    expect(e.state.notes[0]).toContain("your draft is back");
  });

  it("lets Enter through as before when pi refuses the prompt", () => {
    const e = editor("my draft ", false);
    e.type(paste("x"));
    e.tick(300);
    expect(e.type(ENTER)).toBe("my draft x");
  });

  it("does nothing without a draft", () => {
    const e = editor("");
    e.type(paste("hi"));
    e.tick(300);
    expect(e.type(ENTER)).toBe("hi");
    expect(e.state.notes).toEqual([]);
  });

  it("leaves your own quick paste onto a draft you are typing alone", () => {
    const e = editor("");
    e.type("l");
    e.type("ook: ");
    e.tick(1_000);
    e.type(paste("https://x"));
    e.tick(200);
    expect(e.type(ENTER)).toBe("look: https://x");
  });

  it("does nothing when Enter is late or another key comes between", () => {
    const late = editor("draft ");
    late.type(paste("x"));
    late.tick(900);
    expect(late.type(ENTER)).toBe("draft x");
    const between = editor("draft ");
    between.type(paste("x"));
    between.type("y");
    expect(between.type(ENTER)).toBe("draft xy");
  });

  it("ignores focus reports between the paste and Enter", () => {
    const e = editor("draft ");
    e.type(paste("x"));
    expect(e.type("\x1b[I")).toBeUndefined();
    e.tick(100);
    expect(e.type(ENTER)).toBe("consumed");
    expect(e.state.submitted).toEqual(["x"]);
    expect(e.state.text).toBe("draft ");
  });

  it("does nothing when the paste did not land in the main editor", () => {
    let clock = 10_000;
    const state = { text: "draft" };
    const guard = new DraftGuard({ getText: () => state.text, setText: (t) => { state.text = t; }, notify() {}, submit: () => true, isEnter: (d) => d === ENTER }, () => clock);
    guard.input(paste("into an overlay"));
    clock += 100;
    expect(guard.input(ENTER)).toBeUndefined();
    expect(state.text).toBe("draft");
  });

  it("does not run an injected command over a draft, and keeps the draft", () => {
    const e = editor("draft");
    e.type(paste("/reload"));
    e.tick(300);
    expect(e.type(ENTER)).toBe("consumed");
    expect(e.state.text).toBe("draft");
    expect(e.state.submitted).toEqual([]);
    expect(e.state.notes[0]).toContain("`/reload`");
  });
});

describe("agents", () => {
  const tokens: Record<string, string> = {};
  const target = { name: "other", agent: "pi", agent_status: "idle", pane_id: "w2:p1", tokens: { inbox: "v1:99" } };
  const make = (handlers: Parameters<typeof fakeCall>[0] = {}) => {
    const f = fakeCall({
      "agent.get": (p) => p.target === "other" || p.target === "w2:p1" ? { result: { agent: target } } : { error: { code: "agent_not_found", message: "no" } },
      "pane.process_info": () => ({ result: { process_info: { foreground_processes: [{ pid: 99 }] } } }),
      "pane.get": () => ({ result: { pane: { tokens } } }),
      ...handlers,
    });
    const agents = new Agents({
      call: f.call,
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      selfPane: "w1:p1",
      cwd: () => "/r",
      self: async () => ({ pane: "w1:p1", name: "lead" }),
      ackPollMs: 1,
      ackTimeoutMs: 50,
    });
    return { f, agents };
  };

  it("sends through the inbox and reports the receiver's outcome", async () => {
    const { f, agents } = make({
      "pane.send_text": (p) => {
        const e = decodeEnvelope(p.text)!;
        tokens[ackTokenName(e.id)] = "queued";
        return { result: {} };
      },
    });
    const r = await agents.send("other", "do it", { delivery: "queue" });
    expect(r).toMatchObject({ via: "inbox", outcome: "queued" });
    const e = decodeEnvelope(f.of("pane.send_text")[0]!.params.text)!;
    expect(e).toMatchObject({ text: "do it", delivery: "queue", from: { pane: "w1:p1", name: "lead" } });
    expect(f.of("agent.prompt")).toEqual([]);
  });

  it("says when the receiver did not confirm", async () => {
    const { agents } = make();
    expect((await agents.send("other", "x", {})).outcome).toBeUndefined();
  });

  it("falls back to agent.prompt when the agent has no inbox", async () => {
    const { f, agents } = make({ "agent.get": () => ({ result: { agent: { ...target, tokens: {} } } }) });
    expect((await agents.send("other", "x", {})).via).toBe("prompt");
    expect(f.of("pane.send_text")).toEqual([]);
    expect(f.of("agent.prompt")[0]!.params).toMatchObject({ target: "w2:p1", text: "x" });
  });

  it("never sends into a pane whose pi is not in front, and never steers by default", async () => {
    const bg = make({ "pane.process_info": () => ({ result: { process_info: { foreground_processes: [{ pid: 1 }] } } }) });
    await expect(bg.agents.send("other", "x", {})).rejects.toThrow("not in the foreground");
    expect(bg.f.of("agent.prompt")).toEqual([]);
    expect(bg.f.of("pane.send_text")).toEqual([]);
    const working = make({ "agent.get": () => ({ result: { agent: { ...target, agent_status: "working" } } }) });
    await expect(working.agents.send("other", "x", {})).rejects.toThrow("delivery=steer");
    expect(working.f.of("pane.send_text")).toEqual([]);
  });

  it("refuses this session's own pane, a missing agent and blocked targets without an inbox", async () => {
    const { agents } = make({ "agent.get": () => ({ result: { agent: { ...target, pane_id: "w1:p1" } } }) });
    await expect(agents.send("me", "x", {})).rejects.toThrow("own pane");
    await expect(make().agents.send("nobody", "x", {})).rejects.toThrow('No agent "nobody"');
    const blocked = make({ "agent.get": () => ({ result: { agent: { ...target, tokens: {}, agent_status: "blocked" } } }) });
    await expect(blocked.agents.send("other", "x", { delivery: "steer" })).rejects.toThrow("dialog");
  });

  it("labels a remote read as a screen read that can be cut short", async () => {
    const calls: string[][] = [];
    const agents = new Agents({
      call: fakeCall().call,
      exec: async (_cmd, args) => {
        calls.push(args);
        if (args[2] === "agent" && args[3] === "get") return { code: 0, stdout: JSON.stringify({ result: { agent: { ...target, agent_session: { kind: "path", value: "/nuc/s.jsonl" } } } }), stderr: "" };
        return { code: 0, stdout: "the screen\n", stderr: "" };
      },
      selfPane: "w1:p1",
      cwd: () => "/r",
      self: async () => ({ pane: "w1:p1" }),
    });
    const out = await agents.read("other", { machine: "NUC" });
    expect(out).toContain("screen read from NUC");
    expect(out).toContain("cut a long reply short");
    expect(out).toContain("the screen");
    expect(calls.at(-1)).toEqual(["--machine", "NUC", "agent", "read", "w2:p1", "--source", "recent-unwrapped", "--lines", "80"]);
  });

  it("waits for a turn to start and settle", async () => {
    const states = ["idle", "working", "working", "idle"];
    let seq = 1;
    const { agents } = make({
      "agent.get": () => {
        const s = states.length > 1 ? states.shift()! : states[0]!;
        if (s === "working") seq = 2;
        return { result: { agent: { ...target, agent: "codex", agent_status: s, state_change_seq: seq } } };
      },
      "agent.read": () => ({ result: { read: { text: "done!" } } }),
    });
    (agents as any).deps.waitPollMs = 1;
    const out = await agents.wait("other", { timeoutMs: 5_000 });
    expect(out).toContain("done!");
    expect(out).not.toContain("did not start");
  });
});
