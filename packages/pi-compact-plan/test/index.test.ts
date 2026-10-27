import { describe, expect, it } from "vitest";
import piCompactPlan, { APPROVE, CANCEL, CHANGE, COMMAND, EDIT, messagesSince, SKIP, WRITE_OWN } from "../src/index.ts";
import { ENTRY, OUTCOME_ENTRY } from "../src/view.ts";

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
    registerEntryRenderer: () => undefined,
    appendEntry: (customType: string, data: any) => entries.push({ customType, data: structuredClone(data) }),
    events: { emit: () => undefined, on: () => () => undefined },
  };
  const entries: Array<{ customType: string; data: any }> = [];
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
    select: async (title: string, options: string[]) => (title === "Compact with this focus?" ? APPROVE : options[0]),
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
      getLeafEntry: () => branch[0],
      getSessionId: () => "session-1",
      getBranch: () => branch,
      buildSessionProjection: () => ({ messages: branch.map((e: any) => e.message) }),
    },
  };
  const mainPayload = { model: model.id, system: [{ type: "text", text: SYSTEM }], tools: [{ name: "bash" }], messages: [{ role: "user", content: [{ type: "text", text: "fix the bug" }] }] };
  const sendMain = () => handlers.get("before_provider_request")?.forEach((h) => h({ payload: mainPayload }, ctx));
  const run = (args: string) => commands.get(COMMAND).handler(args, ctx);
  return { run, sendMain, requests, notes, compacts, handlers, ctx, entries, pi, getEditor: () => editorText };
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
    expect(t.requests[0]!.options.sessionId).toBe("session-1");
    // The session's request, then its final reply, then the drafting instructions.
    expect(payload.messages[0].content[0].text).toBe("fix the bug");
    expect(payload.messages[1].content[0].text).toBe("fixed, tests pass");
    expect(payload.messages[2].content[0].text).toContain("ship it");
    expect(t.compacts[0].customInstructions).toBe("Next task: ship it");
    expect(t.getEditor()).toBe("ship it");
    expect(t.entries.map((e) => e.customType)).toEqual([ENTRY, OUTCOME_ENTRY]);
    expect(t.entries[1]!.data).toMatchObject({ status: "compacted", draft: "Next task: ship it", cached: 99, tokens: 10000 });
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
          if (title === "Compact with this focus?") return APPROVE;
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
    const t = setup({ replies: [json("first", [{ question: "Q", options: ["a", "b"] }])], ui: { select: async (title: string) => (title === "Q" ? SKIP : APPROVE) } });
    await t.run("next");
    expect(t.requests).toHaveLength(1);
    expect(t.compacts[0].customInstructions).toBe("first");
  });

  /** A select that answers the review prompt from a script, and the rest with their first option. */
  const review = (...choices: string[]) => async (title: string, options: string[]) =>
    title === "Compact with this focus?" ? choices.shift() : options[0];

  it("edits the focus, then compacts with the edit", async () => {
    const t = setup({ replies: [json("D")], ui: { select: review(EDIT, APPROVE), editor: async (_t: string, prefill: string) => `  ${prefill} plus mine  ` } });
    await t.run("next");
    expect(t.compacts[0].customInstructions).toBe("D plus mine");
    expect(t.entries[1]!.data).toMatchObject({ status: "compacted", edited: true });
  });

  it("revises the draft with feedback, continuing the side conversation", async () => {
    const t = setup({ replies: [json("D1"), json("D2")], ui: { select: review(CHANGE, APPROVE), input: async () => "keep the CI notes" } });
    t.sendMain();
    await t.run("next");
    expect(t.requests).toHaveLength(2);
    const messages = t.requests[1]!.payload.messages;
    expect(messages.at(-2).role).toBe("assistant");
    expect(messages.at(-1).content[0].text).toContain("The current draft:\n\nD1");
    expect(messages.at(-1).content[0].text).toContain("keep the CI notes");
    expect(t.compacts[0].customInstructions).toBe("D2");
  });

  it("keeps the draft when a revision fails", async () => {
    const t = setup({ replies: [json("D1"), ""], ui: { select: review(CHANGE, APPROVE), input: async () => "x" } });
    await t.run("next");
    expect(t.notes.some(([m]) => m.includes("drafting failed"))).toBe(true);
    expect(t.compacts[0].customInstructions).toBe("D1");
  });

  it("cancels from the review, a question or the goal prompt", async () => {
    for (const choice of [CANCEL, undefined]) {
      const t = setup({ replies: [json("D")], ui: { select: review(choice as string) } });
      await t.run("next");
      expect(t.compacts).toHaveLength(0);
      expect(t.entries.at(-1)!.data.status).toBe("cancelled");
    }
    const q = setup({ replies: [json("D", [{ question: "Q", options: ["a"] }])], ui: { select: async () => undefined } });
    await q.run("next");
    expect(q.compacts).toHaveLength(0);
    const g = setup({ replies: [json("D")], ui: { input: async () => undefined } });
    await g.run("");
    expect(g.requests).toHaveLength(0);
  });

  it("records a failed compaction", async () => {
    const t = setup({ replies: [json("D")] });
    t.ctx.compact = (o: any) => o.onError(new Error("boom"));
    await t.run("next");
    expect(t.entries.at(-1)!.data).toMatchObject({ status: "failed", error: "boom" });
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

  it("ignores a request that does not end with the session's latest entry (a summary request)", async () => {
    const t = setup({ replies: [json("D")] });
    t.ctx.sessionManager.getLeafEntry = () => msg("u9", "user", "something else entirely");
    t.sendMain();
    await t.run("next");
    expect(t.requests[0]!.options.onPayload).toBeUndefined();
  });

  it("forgets the captured request after a compaction", async () => {
    const t = setup({ replies: [json("D")] });
    t.sendMain();
    t.handlers.get("session_compact")?.forEach((h) => h({}, t.ctx));
    await t.run("next");
    expect(t.requests[0]!.options.onPayload).toBeUndefined();
  });
});

describe("/compact-plan with pi-ask-user-question's dialog", () => {
  function withService(results: any[]) {
    const t = setup({ replies: [json("D1", [{ question: "Keep A?", header: "Approach A", options: [{ label: "Keep", description: "" }, { label: "Drop", description: "" }] }]), json("D2"), json("D3")] });
    const calls: any[] = [];
    t.ctx.ui.select = async () => {
      throw new Error("Pi's select must not be used");
    };
    (t as any).pi.events.emit = (channel: string, data: any) => {
      if (channel === "pi-plugins.ask-user-question.v1") data.ask = async (_ctx: any, params: any, options: any) => {
        calls.push({ params, options });
        return results.shift() ?? { cancelled: true, answers: [] };
      };
    };
    return { t, calls };
  }
  const option = (question: string, answer: string, notes?: string) => ({ index: 0, question, kind: "option", answer, ...(notes ? { notes } : {}) });

  it("asks the questions and the review in the dialog, with notes", async () => {
    const { t, calls } = withService([
      { cancelled: false, answers: [option("Keep A?", "Drop", "but keep its test")], note: "be brief" },
      { cancelled: false, answers: [option("review", APPROVE, "mention the CI flake")] },
    ]);
    await t.run("next");
    expect(calls[0].params.questions[0]).toMatchObject({ question: "Keep A?", header: "Approach A", multiSelect: false });
    expect(calls[1].params.questions[0].options.map((o: any) => o.label)).toEqual([APPROVE, EDIT, CANCEL]);
    const refine = t.requests[1]!.context.messages.at(-1).content[0].text;
    expect(refine).toContain("A: Drop\nNote: but keep its test");
    expect(refine).toContain("Note: be brief");
    expect(t.compacts[0].customInstructions).toBe("D2\n- **Also:** mention the CI flake");
  });

  it("revises with a typed answer in the review", async () => {
    const { t } = withService([
      { cancelled: false, answers: [{ index: 0, question: "Keep A?", kind: "unanswered", answer: null }] },
      { cancelled: false, answers: [{ index: 0, question: "review", kind: "custom", answer: "shorter please" }] },
      { cancelled: false, answers: [option("review", APPROVE)] },
    ]);
    await t.run("next");
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1]!.context.messages.at(-1).content[0].text).toContain("The user wants this changed: shorter please");
    expect(t.compacts[0].customInstructions).toBe("D2");
  });

  it("cancels when the dialog is declined", async () => {
    const { t } = withService([{ cancelled: true, answers: [] }]);
    await t.run("next");
    expect(t.compacts).toHaveLength(0);
  });

  it("falls back to Pi's selects when the dialog refuses the questions", async () => {
    const { t } = withService([{ error: "empty_options", message: "x" }]);
    const titles: string[] = [];
    t.ctx.ui.select = async (title: string, options: string[]) => {
      titles.push(title);
      return options[0];
    };
    await t.run("next");
    expect(titles[0]).toBe("Keep A?");
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
