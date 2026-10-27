import { describe, expect, it } from "vitest";
import piCompactPlan, { COMMAND, messagesSince, SKIP, WRITE_OWN } from "../src/index.ts";

const SYSTEM = "You are pi, a coding agent.";
const model = { api: "anthropic-messages", provider: "anthropic", id: "claude-x" };

const msg = (id: string, role: string, text: string) => ({
  type: "message",
  id,
  message: role === "assistant"
    ? { role, content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage: {}, timestamp: 1 }
    : { role, content: [{ type: "text", text }], timestamp: 1 },
});

const reply = (text: string, usage = { input: 100, cacheRead: 9900, cacheWrite: 0 }) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "stop",
  usage,
});

function setup(options: { replies: string[]; ui?: Partial<Record<string, any>>; branch?: any[]; failSplice?: boolean }) {
  const handlers = new Map<string, Array<(e: any, c: any) => unknown>>();
  const commands = new Map<string, any>();
  const pi: any = {
    on: (event: string, h: any) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
    registerCommand: (name: string, o: any) => commands.set(name, o),
  };
  piCompactPlan(pi);

  const branch = options.branch ?? [msg("u1", "user", "fix the bug"), msg("a1", "assistant", "fixed, tests pass")];
  const requests: Array<{ context: any; options: any; payload?: any }> = [];
  const replies = [...options.replies];
  const registry = {
    find: () => model,
    complete: async (_m: any, context: any, opts: any) => {
      const record: any = { context, options: opts };
      requests.push(record);
      if (opts.onPayload) {
        const side = { model: model.id, messages: context.messages.map((m: any) => ({ role: m.role, content: m.content })) };
        try {
          record.payload = await opts.onPayload(options.failSplice ? { model: "other", messages: [] } : side, model);
        } catch (error: any) {
          return { role: "assistant", content: [], stopReason: "error", errorMessage: error.message };
        }
      }
      return reply(replies.shift() ?? "");
    },
  };
  const notes: Array<[string, string?]> = [];
  const compacts: any[] = [];
  let editorText = "";
  const ui = {
    input: async () => "",
    select: async () => undefined,
    editor: async (_t: string, prefill?: string) => prefill,
    notify: (m: string, t?: string) => notes.push([m, t]),
    setWidget: () => undefined,
    getEditorText: () => editorText,
    setEditorText: (t: string) => {
      editorText = t;
    },
    ...options.ui,
  };
  const ctx: any = {
    hasUI: true,
    model,
    modelRegistry: registry,
    ui,
    waitForIdle: async () => undefined,
    getSystemPrompt: () => SYSTEM,
    compact: (o: any) => {
      compacts.push(o);
      o.onComplete?.({});
    },
    sessionManager: {
      getLeafId: () => "u1",
      getBranch: () => branch,
      buildSessionProjection: () => ({ messages: branch.map((e: any) => e.message) }),
    },
  };
  const mainPayload = { model: model.id, system: [{ type: "text", text: SYSTEM }], tools: [{ name: "bash" }], messages: [{ role: "user", content: [{ type: "text", text: "fix the bug" }] }] };
  const sendMain = () => handlers.get("before_provider_request")?.forEach((h) => h({ payload: mainPayload }, ctx));
  const run = (args: string) => commands.get(COMMAND).handler(args, ctx);
  return { run, sendMain, requests, notes, compacts, handlers, ctx, getEditor: () => editorText };
}

const json = (draft: string, questions: unknown[] = []) => JSON.stringify({ questions, draft });

describe("/compact-plan", () => {
  it("drafts on the session's last request and compacts with the approved focus", async () => {
    const t = setup({ replies: [json("Next task: ship it")] });
    t.sendMain();
    await t.run("ship it");
    expect(t.requests).toHaveLength(1);
    const payload = t.requests[0]!.payload;
    expect(payload.system[0].text).toBe(SYSTEM);
    expect(payload.tools).toEqual([{ name: "bash" }]);
    // The session's request, then its final reply, then the drafting instructions.
    expect(payload.messages[0].content[0].text).toBe("fix the bug");
    expect(payload.messages[1].content[0].text).toBe("fixed, tests pass");
    expect(payload.messages[2].content[0].text).toContain("ship it");
    expect(t.compacts[0].customInstructions).toBe("Next task: ship it");
    expect(t.getEditor()).toBe("ship it");
    expect(t.notes.at(-1)?.[0]).toMatch(/99% from cache/);
  });

  it("sends the session's context as a plain request without a captured one", async () => {
    const t = setup({ replies: [json("D")] });
    await t.run("next");
    expect(t.requests[0]!.options.onPayload).toBeUndefined();
    expect(t.requests[0]!.context.systemPrompt).toBe(SYSTEM);
    expect(t.requests[0]!.context.messages).toHaveLength(3);
    expect(t.compacts).toHaveLength(1);
  });

  it("falls back to a plain request when the splice is refused", async () => {
    const t = setup({ replies: [json("D")], failSplice: true });
    t.sendMain();
    await t.run("next");
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1]!.options.onPayload).toBeUndefined();
    expect(t.compacts[0].customInstructions).toBe("D");
  });

  it("asks the questions and revises the draft with the answers", async () => {
    const asked: string[] = [];
    const t = setup({
      replies: [json("first", [{ question: "Keep A?", options: ["Keep", "Drop"] }, { question: "Scope?", options: ["x"] }, { question: "Tests?", options: ["y"] }]), json("revised")],
      ui: {
        select: async (title: string, options: string[]) => {
          asked.push(title);
          expect(options.slice(-2)).toEqual([WRITE_OWN, SKIP]);
          return title === "Keep A?" ? "Drop" : title === "Scope?" ? WRITE_OWN : SKIP;
        },
        input: async () => "only the CLI",
      },
    });
    t.sendMain();
    await t.run("next");
    expect(asked).toEqual(["Keep A?", "Scope?", "Tests?"]);
    expect(t.requests).toHaveLength(2);
    const last = t.requests[1]!.payload.messages.at(-1).content[0].text;
    expect(last).toContain("Q: Keep A?\nA: Drop");
    expect(last).toContain("Q: Scope?\nA: only the CLI");
    expect(last).not.toContain("Tests?");
    expect(t.compacts[0].customInstructions).toBe("revised");
  });

  it("does not revise when every question is skipped", async () => {
    const t = setup({ replies: [json("first", [{ question: "Q", options: ["a", "b"] }])], ui: { select: async () => SKIP } });
    await t.run("next");
    expect(t.requests).toHaveLength(1);
    expect(t.compacts[0].customInstructions).toBe("first");
  });

  it("uses the edited focus", async () => {
    const t = setup({ replies: [json("D")], ui: { editor: async () => "  my focus  " } });
    await t.run("next");
    expect(t.compacts[0].customInstructions).toBe("my focus");
  });

  it("cancels on Esc in the editor, a question or the goal prompt", async () => {
    for (const ui of [{ editor: async () => undefined }, { editor: async () => "   " }]) {
      const t = setup({ replies: [json("D")], ui });
      await t.run("next");
      expect(t.compacts).toHaveLength(0);
    }
    const q = setup({ replies: [json("D", [{ question: "Q", options: ["a"] }])], ui: { select: async () => undefined } });
    await q.run("next");
    expect(q.compacts).toHaveLength(0);
    const g = setup({ replies: [json("D")], ui: { input: async () => undefined } });
    await g.run("");
    expect(g.requests).toHaveLength(0);
  });

  it("asks for the goal when none is given, and may leave it to the model", async () => {
    const t = setup({ replies: [json("D")] });
    await t.run("");
    expect(t.requests[0]!.context.messages.at(-1).content[0].text).toContain("infer the most likely next step");
    expect(t.getEditor()).toBe("");
  });

  it("reports a failed request and does not compact", async () => {
    const t = setup({ replies: [""] });
    await t.run("next");
    expect(t.compacts).toHaveLength(0);
    expect(t.notes.at(-1)).toEqual(["compact-plan: drafting failed (the model sent an empty reply)", "error"]);
  });

  it("forgets the captured request after a compaction", async () => {
    const t = setup({ replies: [json("D")] });
    t.sendMain();
    t.handlers.get("session_compact")?.forEach((h) => h({}, t.ctx));
    await t.run("next");
    expect(t.requests[0]!.options.onPayload).toBeUndefined();
  });
});

describe("messagesSince", () => {
  const branch = [msg("u1", "user", "a"), msg("a1", "assistant", "b"), msg("u2", "user", "c")];
  it("returns the messages after the request's leaf", () => {
    expect(messagesSince(branch, "a1")?.map((m: any) => m.role)).toEqual(["user"]);
    expect(messagesSince(branch, null)).toHaveLength(3);
  });
  it("gives up when the leaf is gone or a compaction intervenes", () => {
    expect(messagesSince(branch, "zz")).toBeUndefined();
    expect(messagesSince([...branch, { type: "compaction", id: "c" }], "u1")).toBeUndefined();
  });
});
