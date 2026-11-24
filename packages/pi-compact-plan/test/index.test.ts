import { afterEach, describe, expect, it, vi } from "vitest";

const piCompact = vi.hoisted(() => vi.fn(async (..._args: any[]) => ({ summary: "Pi's summary", firstKeptEntryId: "a1", tokensBefore: 1000 })));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({ ...(await original<object>()), compact: piCompact }));

import piCompactPlan, {
  CANCEL,
  CHANGE,
  COMMAND,
  CONTINUE,
  CONTINUE_PROMPT,
  continuation,
  DIRECT_PREFIX,
  EDIT,
  keptStart,
  messagesSince,
  OUTLINE_MIN_TOKENS,
  REVIEW_QUESTION,
  SKIP,
  SOURCE_FULL,
  SOURCE_OUTLINE,
  STOP,
  SUMMARY_WARM_MS,
  WRITE_OWN,
} from "../src/index.ts";
import { OUTLINE_SYSTEM } from "../src/protocol.ts";
import { ENTRY, OUTCOME_ENTRY } from "../src/view.ts";

const SYSTEM = "You are pi, a coding agent.";
const model = { api: "anthropic-messages", provider: "anthropic", id: "claude-x" };
const CACHED = { input: 100, cacheRead: 9900, cacheWrite: 0 };

const msg = (id: string, role: string, text: string) => ({
  type: "message",
  id,
  message: role === "assistant"
    ? { role, content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage: {}, timestamp: 1 }
    : { role, content: [{ type: "text", text }], timestamp: 1 },
});

const reply = (text: string, usage = CACHED) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage });

afterEach(() => {
  piCompact.mockClear();
  vi.useRealTimers();
});

function setup(options: { replies: Array<string | object>; ui?: Partial<Record<string, any>>; branch?: any[]; failSplice?: boolean; tokens?: number; usage?: typeof CACHED }) {
  const handlers = new Map<string, Array<(e: any, c: any) => unknown>>();
  const commands = new Map<string, any>();
  const listeners = new Map<string, Array<(data: any) => void>>();
  const sent: string[] = [];
  const entries: Array<{ customType: string; data: any }> = [];
  const pi: any = {
    on: (event: string, h: any) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
    registerCommand: (name: string, o: any) => commands.set(name, o),
    registerEntryRenderer: () => undefined,
    appendEntry: (customType: string, data: any) => entries.push({ customType, data: structuredClone(data) }),
    events: {
      emit: () => undefined,
      on: (channel: string, h: any) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), h]);
        return () => undefined;
      },
    },
    sendUserMessage: (text: string) => sent.push(text),
  };
  piCompactPlan(pi);

  const branch = options.branch ?? [msg("u1", "user", "fix the bug"), msg("a1", "assistant", "fixed, tests pass")];
  const requests: Array<{ context: any; options: any; payload?: any }> = [];
  const replies = [...options.replies];
  const registry = {
    find: () => model,
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
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
      const next = replies.shift() ?? "";
      return typeof next === "string" ? reply(next, options.usage) : next;
    },
  };
  const notes: Array<[string, string?]> = [];
  const compacts: any[] = [];
  const results: any[] = [];
  let editorText = "";
  const ui = {
    input: async () => "",
    select: async (title: string, opts: string[]) => (title === REVIEW_QUESTION ? STOP : opts[0]),
    editor: async (_t: string, prefill?: string) => prefill,
    notify: (m: string, t?: string) => notes.push([m, t]),
    setWidget: () => undefined,
    getEditorText: () => editorText,
    setEditorText: (t: string) => {
      editorText = t;
    },
    ...options.ui,
  };
  let pending: Promise<void> = Promise.resolve();
  const controller = new AbortController();
  /** Pi's manual compaction: the session_before_compact handlers, then success or failure. */
  const ctx: any = {
    hasUI: true,
    model,
    modelRegistry: registry,
    ui,
    waitForIdle: async () => undefined,
    getSystemPrompt: () => SYSTEM,
    ...(options.tokens !== undefined ? { getContextUsage: () => ({ tokens: options.tokens, contextWindow: 1_000_000, percent: null }) } : {}),
    compact: (o: any) => {
      compacts.push(o);
      pending = (async () => {
        const event = {
          type: "session_before_compact",
          reason: "manual",
          customInstructions: o.customInstructions,
          willRetry: false,
          branchEntries: branch,
          signal: controller.signal,
          preparation: {
            firstKeptEntryId: "a1",
            tokensBefore: 1000,
            isSplitTurn: false,
            messagesToSummarize: [],
            turnPrefixMessages: [],
            fileOps: { read: new Set(["src/a.ts", "src/b.ts"]), written: new Set<string>(), edited: new Set(["src/b.ts"]) },
            settings: {},
          },
        };
        let result: any;
        for (const h of handlers.get("session_before_compact") ?? []) result = (await h(event, ctx)) ?? result;
        results.push(result);
        if (result?.cancel) o.onError?.(new Error("Compaction cancelled"));
        else o.onComplete?.({});
      })();
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
  const run = async (args: string) => {
    await commands.get(COMMAND).handler(args, ctx);
    await pending;
  };
  const emitEvent = (channel: string, data: unknown) => listeners.get(channel)?.forEach((h) => h(data));
  /** The focus the compaction used: the outcome entry records it, whoever wrote the summary. */
  const focus = () => entries.find((e) => e.customType === OUTCOME_ENTRY)?.data.draft;
  return { run, emitEvent, commands, sendMain, requests, notes, compacts, results, handlers, ctx, entries, pi, sent, controller, focus, getEditor: () => editorText };
}

const json = (draft: string, questions: unknown[] = []) => JSON.stringify({ questions, draft });
const lastText = (request: { payload?: any; context: any }) => (request.payload ? request.payload.messages : request.context.messages).at(-1).content[0].text as string;

/** A select that answers the review prompt from a script, and the rest with their first option. */
const review = (...choices: Array<string | undefined>) => async (title: string, options: string[]) => (title === REVIEW_QUESTION ? choices.shift() : options[0]);

describe("/compact-plan", () => {
  it("registers one command", () => {
    const t = setup({ replies: [] });
    expect([...t.commands.keys()]).toEqual([COMMAND]);
  });

  it("drafts on the session's last request, then writes the summary from the prompt cache", async () => {
    const t = setup({ replies: [json("- **Keep verbatim:** retry()"), "## Goal\nship it"] });
    t.sendMain();
    await t.run("ship it");
    expect(t.requests).toHaveLength(2);
    const payload = t.requests[0]!.payload;
    expect(payload.system[0].text).toBe(SYSTEM);
    expect(payload.tools).toEqual([{ name: "bash" }]);
    expect(t.requests[0]!.options.sessionId).toBe("session-1");
    // The session's request, then its final reply, then the drafting instructions.
    expect(payload.messages[0].content[0].text).toBe("fix the bug");
    expect(payload.messages[1].content[0].text).toBe("fixed, tests pass");
    expect(payload.messages[2].content[0].text).toContain("ship it");

    // The summary: the same prefix, with the focus and where the kept part starts.
    const summary = t.requests[1]!.payload;
    expect(summary.system[0].text).toBe(SYSTEM);
    expect(summary.messages).toHaveLength(3);
    const prompt = summary.messages[2].content[0].text;
    expect(prompt).toContain("- **Keep verbatim:** retry()");
    expect(prompt).toContain('starts with the assistant message that begins: "fixed, tests pass"');
    expect(t.compacts[0].customInstructions.startsWith(DIRECT_PREFIX)).toBe(true);
    expect(t.results[0].compaction).toEqual({
      summary: "## Goal\nship it\n\n<read-files>\nsrc/a.ts\n</read-files>\n\n<modified-files>\nsrc/b.ts\n</modified-files>",
      firstKeptEntryId: "a1",
      tokensBefore: 1000,
      usage: CACHED,
      details: { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] },
    });
    expect(piCompact).not.toHaveBeenCalled();

    expect(t.getEditor()).toBe("ship it");
    expect(t.sent).toEqual([]);
    expect(t.entries.map((e) => e.customType)).toEqual([ENTRY, OUTCOME_ENTRY]);
    expect(t.entries[1]!.data).toMatchObject({ status: "compacted", summary: "cache", draft: "- **Keep verbatim:** retry()", cached: 99, tokens: 20000 });
  });

  it("falls back to Pi's summarizer with the focus when the cached summary fails", async () => {
    const toolCall = { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }], stopReason: "toolUse", usage: CACHED };
    for (const bad of ["", toolCall, { ...reply("half"), stopReason: "length" }]) {
      const t = setup({ replies: [json("Focus"), bad] });
      t.sendMain();
      await t.run("next");
      expect(piCompact).toHaveBeenCalledOnce();
      expect(piCompact.mock.calls[0]![0]).toMatchObject({ firstKeptEntryId: "a1" });
      expect(piCompact.mock.calls[0]![4]).toBe("Focus");
      expect(t.results[0].compaction.summary).toBe("Pi's summary");
      expect(t.entries.at(-1)!.data).toMatchObject({ status: "compacted" });
      expect(t.entries.at(-1)!.data.summary).toBeUndefined();
      piCompact.mockClear();
    }
  });

  it("records the error when Pi's summarizer fails too", async () => {
    piCompact.mockRejectedValueOnce(new Error("offline"));
    const t = setup({ replies: [json("Focus"), ""] });
    t.sendMain();
    await t.run("next");
    expect(t.results[0]).toEqual({ cancel: true });
    expect(t.entries.at(-1)!.data).toMatchObject({ status: "failed", error: "offline" });
  });

  it("cancels the compaction when it is stopped while the summary is written", async () => {
    const t = setup({ replies: [json("Focus")] });
    t.sendMain();
    const complete = t.ctx.modelRegistry.complete;
    let calls = 0;
    t.ctx.modelRegistry.complete = async (...args: any[]) => {
      if (++calls === 2) t.controller.abort();
      return complete(...args);
    };
    await t.run("next");
    expect(t.results[0]).toEqual({ cancel: true });
    expect(piCompact).not.toHaveBeenCalled();
    expect(t.entries.at(-1)!.data.status).toBe("cancelled");
  });

  it("lets Pi write the summary when the drafting did not come from the cache", async () => {
    // No captured request: a plain drafting request.
    const t = setup({ replies: [json("D")] });
    await t.run("next");
    expect(t.requests[0]!.options.onPayload).toBeUndefined();
    expect(t.requests[0]!.context.systemPrompt).toBe(SYSTEM);
    expect(t.requests[0]!.context.messages).toHaveLength(3);
    expect(t.compacts[0].customInstructions).toBe("D");
    expect(t.results[0]).toBeUndefined();
    // A provider that did not cache the spliced request.
    const u = setup({ replies: [json("D")], usage: { input: 10_000, cacheRead: 0, cacheWrite: 0 } });
    u.sendMain();
    await u.run("next");
    expect(u.requests).toHaveLength(1);
    expect(u.compacts[0].customInstructions).toBe("D");
  });

  it("lets Pi write the summary when the review outlasted the cache", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setup({
      replies: [json("D")],
      ui: {
        select: async () => {
          vi.setSystemTime(Date.now() + SUMMARY_WARM_MS + 1);
          return STOP;
        },
      },
    });
    t.sendMain();
    await t.run("next");
    expect(t.requests).toHaveLength(1);
    expect(t.compacts[0].customInstructions).toBe("D");
  });

  it("sends a plain request to the model behind a virtual selection (a plan model pair)", async () => {
    const t = setup({ replies: [json("D")] });
    const targets: any[] = [];
    const complete = t.ctx.modelRegistry.complete;
    t.ctx.modelRegistry.complete = (m: any, ...rest: any[]) => (targets.push(m), complete(m, ...rest));
    t.ctx.model = { api: "pi-virtual", provider: "anthropic", id: "opusplan" };
    await t.run("next");
    expect(targets).toEqual([model]);
    expect(t.compacts).toHaveLength(1);
  });

  it("reports a virtual selection that has not answered yet instead of sending to it", async () => {
    const t = setup({ replies: [json("D")], branch: [msg("u1", "user", "fix the bug")] });
    t.ctx.model = { api: "pi-virtual", provider: "anthropic", id: "opusplan" };
    await t.run("next");
    expect(t.requests).toHaveLength(0);
    expect(t.notes.at(-1)![0]).toContain("anthropic/opusplan has not answered yet");
    expect(t.compacts).toHaveLength(0);
  });

  it("falls back to a plain request when the splice is refused, and lets Pi summarize", async () => {
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
      replies: [json("first", [{ question: "Keep A?", options: ["Keep", "Drop"] }, { question: "Scope?", options: ["x"] }, { question: "Tests?", options: ["y"] }]), json("revised"), "summary"],
      ui: {
        select: async (title: string, options: string[]) => {
          if (title === REVIEW_QUESTION) return STOP;
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
    expect(t.requests).toHaveLength(3);
    const last = lastText(t.requests[1]!);
    expect(last).toContain("Q: Keep A?\nA: Drop");
    expect(last).toContain("Q: Scope?\nA: only the CLI");
    expect(last).not.toContain("Tests?");
    expect(t.focus()).toBe("revised");
  });

  it("does not revise when every question is skipped", async () => {
    const t = setup({ replies: [json("first", [{ question: "Q", options: ["a", "b"] }])], ui: { select: async (title: string) => (title === "Q" ? SKIP : STOP) } });
    await t.run("next");
    expect(t.requests).toHaveLength(1);
    expect(t.compacts[0].customInstructions).toBe("first");
  });

  it("edits the focus, then compacts with the edit", async () => {
    const t = setup({ replies: [json("D")], ui: { select: review(EDIT, STOP), editor: async (_t: string, prefill: string) => `  ${prefill} plus mine  ` } });
    await t.run("next");
    expect(t.compacts[0].customInstructions).toBe("D plus mine");
    expect(t.entries[1]!.data).toMatchObject({ status: "compacted", edited: true });
  });

  it("revises the draft with feedback, continuing the side conversation", async () => {
    const t = setup({ replies: [json("D1"), json("D2"), "summary"], ui: { select: review(CHANGE, STOP), input: async () => "keep the CI notes" } });
    t.sendMain();
    await t.run("next");
    expect(t.requests).toHaveLength(3);
    const messages = t.requests[1]!.payload.messages;
    expect(messages.at(-2).role).toBe("assistant");
    expect(messages.at(-1).content[0].text).toContain("The current draft:\n\nD1");
    expect(messages.at(-1).content[0].text).toContain("keep the CI notes");
    expect(t.focus()).toBe("D2");
    expect(lastText(t.requests[2]!)).toContain("D2");
  });

  it("compacts and continues with the next prompt, or the current work without one", async () => {
    const t = setup({ replies: [json("D")], ui: { select: review(CONTINUE) } });
    await t.run("  ship it\n\n  keep this indentation  \nnext  ");
    expect(t.sent).toEqual([continuation("ship it\n\n  keep this indentation  \nnext")]);
    expect(t.getEditor()).toBe("");
    expect(t.entries.at(-1)!.data).toMatchObject({ status: "compacted", continued: true });
    const u = setup({ replies: [json("D")], ui: { select: review(CONTINUE) } });
    await u.run("");
    expect(u.sent).toEqual([continuation(CONTINUE_PROMPT)]);
  });

  it("marks the continuation as sent after a finished compaction, so a prompt about compacting is not taken as a request to compact", () => {
    const text = continuation("Compact for Phase 4");
    expect(text.startsWith("[/compact-plan compacted this session; the summary above is the result. Do not compact again.")).toBe(true);
    expect(text.endsWith("\n\nCompact for Phase 4")).toBe(true);
  });

  it("does not send anything after compact and stop", async () => {
    const t = setup({ replies: [json("D")] });
    await t.run("ship it");
    expect(t.sent).toEqual([]);
    expect(t.getEditor()).toBe("ship it");
  });

  it("keeps the draft when a revision fails", async () => {
    const t = setup({ replies: [json("D1"), ""], ui: { select: review(CHANGE, STOP), input: async () => "x" } });
    await t.run("next");
    expect(t.notes.some(([m]) => m.includes("drafting failed"))).toBe(true);
    expect(t.compacts[0].customInstructions).toBe("D1");
  });

  it("cancels from the review or a question", async () => {
    for (const choice of [CANCEL, undefined]) {
      const t = setup({ replies: [json("D")], ui: { select: review(choice) } });
      await t.run("next");
      expect(t.compacts).toHaveLength(0);
      expect(t.entries.at(-1)!.data.status).toBe("cancelled");
    }
    const q = setup({ replies: [json("D", [{ question: "Q", options: ["a"] }])], ui: { select: async () => undefined } });
    await q.run("next");
    expect(q.compacts).toHaveLength(0);
  });

  it("does not continue on compaction failure, including a late success callback", async () => {
    const t = setup({ replies: [json("D")], ui: { select: review(CONTINUE) } });
    t.ctx.compact = (o: any) => {
      o.onError(new Error("boom"));
      o.onComplete();
    };
    await t.run("next");
    expect(t.entries.at(-1)!.data).toMatchObject({ status: "failed", error: "boom", continued: true });
    expect(t.sent).toEqual([]);
  });

  it("waits for deferred compaction success and continues only once", async () => {
    const t = setup({ replies: [json("D")], ui: { select: review(CONTINUE) } });
    let callbacks: any;
    t.ctx.compact = (o: any) => {
      callbacks = o;
    };
    await t.run("next");
    expect(t.sent).toEqual([]);
    expect(t.entries.map((e) => e.customType)).toEqual([ENTRY]);
    callbacks.onComplete();
    callbacks.onComplete();
    expect(t.sent).toEqual([continuation("next")]);
    expect(t.entries.map((e) => e.customType)).toEqual([ENTRY, OUTCOME_ENTRY]);
  });

  it("drafts without a next prompt, without asking for one", async () => {
    const input = vi.fn(async () => "");
    const t = setup({ replies: [json("D")], ui: { input } });
    await t.run("");
    expect(input).not.toHaveBeenCalled();
    expect(lastText(t.requests[0]!)).toContain("did not say what comes next");
    expect(t.getEditor()).toBe("");
  });

  it("waits for idle before drafting and needs a UI", async () => {
    const t = setup({ replies: [json("D")] });
    t.ctx.waitForIdle = async () => expect(t.requests).toHaveLength(0);
    t.ctx.hasUI = false;
    await t.run("next");
    expect(t.requests).toHaveLength(0);
    t.ctx.hasUI = true;
    await t.run("next");
    expect(t.compacts).toHaveLength(1);
  });

  it("reports a failed request and does not compact", async () => {
    for (const fails of ["empty", "request"]) {
      const t = setup({ replies: [""] });
      if (fails === "request") t.ctx.modelRegistry.complete = async () => { throw new Error("offline"); };
      await t.run("next");
      expect(t.notes.at(-1)).toEqual([`compact-plan: drafting failed (${fails === "empty" ? "the model sent an empty reply" : "offline"})`, "error"]);
      expect(t.compacts).toHaveLength(0);
      expect(t.entries).toHaveLength(0);
    }
  });

  it("stops drafting with Escape and clears the working widget", async () => {
    const widget = vi.fn();
    let input: (data: string) => unknown = () => undefined;
    const unsubscribe = vi.fn();
    const t = setup({ replies: [], ui: { setWidget: widget, onTerminalInput: (fn: typeof input) => { input = fn; return unsubscribe; } } });
    t.ctx.modelRegistry.complete = async (_model: any, _context: any, options: any) => {
      expect(input("\u001b")).toEqual({ consume: true });
      expect(options.signal.aborted).toBe(true);
      return reply("D");
    };
    await t.run("next");
    expect(t.notes.at(-1)).toEqual(["compact-plan: stopped", "info"]);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(widget.mock.calls.at(-1)).toEqual([COMMAND, undefined]);
    expect(t.compacts).toHaveLength(0);
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

  it("leaves compactions it did not start alone", async () => {
    const t = setup({ replies: [] });
    for (const customInstructions of [undefined, "keep the plan", `${DIRECT_PREFIX}00000000-0000-0000-0000-000000000000`]) {
      const results = await Promise.all((t.handlers.get("session_before_compact") ?? []).map((h) => h({ customInstructions, preparation: {}, branchEntries: [], signal: new AbortController().signal }, t.ctx)));
      expect(results).toEqual([undefined]);
    }
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
      { cancelled: false, answers: [option("review", STOP, "mention the CI flake")] },
    ]);
    await t.run("next");
    expect(calls[0].params.questions[0]).toMatchObject({ question: "Keep A?", header: "Approach A", multiSelect: false });
    expect(calls[1].params.questions[0].options.map((o: any) => o.label)).toEqual([STOP, CONTINUE, EDIT, CANCEL]);
    expect(calls[1].params.questions[0].options[1].description).toBe("Compact, then send your next prompt.");
    const refine = lastText(t.requests[1]!);
    expect(refine).toContain("A: Drop\nNote: but keep its test");
    expect(refine).toContain("Note: be brief");
    expect(t.compacts[0].customInstructions).toBe("D2\n- **Also:** mention the CI flake");
  });

  it("revises with a typed answer in the review", async () => {
    const { t } = withService([
      { cancelled: false, answers: [{ index: 0, question: "Keep A?", kind: "unanswered", answer: null }] },
      { cancelled: false, answers: [{ index: 0, question: "review", kind: "custom", answer: "shorter please" }] },
      { cancelled: false, answers: [option("review", STOP)] },
    ]);
    await t.run("next");
    expect(t.requests).toHaveLength(2);
    expect(lastText(t.requests[1]!)).toContain("The user wants this changed: shorter please");
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

describe("keptStart", () => {
  it("quotes the first kept message, or names its tool calls", () => {
    const long = "x ".repeat(200);
    const calls = { type: "message", id: "a2", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }, { type: "toolCall", name: "read" }] } };
    const branch = [msg("u1", "user", "  fix\n the   bug "), msg("a1", "assistant", long), calls];
    expect(keptStart(branch, "u1", false)).toEqual({ role: "user", excerpt: "fix the bug", splitTurn: false });
    expect(keptStart(branch, "a1", true)!.excerpt).toHaveLength(160);
    expect(keptStart(branch, "a2", true)).toEqual({ role: "assistant", excerpt: "[tool calls: bash, read]", splitTurn: true });
    expect(keptStart(branch, "zz", false)).toBeUndefined();
  });
});

describe("drafting source", () => {
  const big = OUTLINE_MIN_TOKENS * 4;
  const asked = (pick?: string) => {
    const calls: Array<{ title: string; options: string[] }> = [];
    const select = async (title: string, options: string[]) => {
      calls.push({ title, options });
      return title === REVIEW_QUESTION ? STOP : (pick ?? options[0]);
    };
    return { calls, select };
  };

  it("does not ask when the conversation is in the prompt cache", async () => {
    const q = asked();
    const t = setup({ replies: [json("Focus"), "summary"], tokens: big, ui: { select: q.select } });
    t.emitEvent("cache:state", { cold: false, tokens: big });
    t.sendMain();
    await t.run("ship it");
    expect(q.calls.map((c) => c.title)).toEqual([REVIEW_QUESTION]);
    expect(t.requests[0]!.options.onPayload).toBeDefined();
  });

  it("asks when cache-guard says cold, outline first; the outline draft leaves the summary to Pi", async () => {
    const q = asked();
    const t = setup({ replies: [json("Focus")], tokens: big, ui: { select: q.select } });
    t.emitEvent("cache:state", { cold: true, tokens: big });
    t.sendMain();
    await t.run("ship it");
    expect(q.calls[0]!.options).toEqual([SOURCE_OUTLINE, SOURCE_FULL]);
    expect(q.calls[0]!.title).toContain("probably no longer in the prompt cache");
    expect(t.requests[0]!.options.onPayload).toBeUndefined();
    expect(t.requests[0]!.context.systemPrompt).toBe(OUTLINE_SYSTEM);
    expect(JSON.stringify(t.requests[0]!.context.messages[0])).toContain("<session-outline>");
    expect(t.compacts[0].customInstructions).toBe("Focus");
    expect(t.entries.find((e) => e.customType === OUTCOME_ENTRY)!.data.source).toBe("outline");
  });

  it("refills the cache from the full conversation when chosen, then writes the summary from it", async () => {
    const q = asked(SOURCE_FULL);
    const t = setup({ replies: [json("Focus"), "summary"], tokens: big, ui: { select: q.select }, usage: { input: 100, cacheRead: 0, cacheWrite: 9900 } });
    t.emitEvent("cache:state", { cold: true, tokens: big });
    t.sendMain();
    await t.run("ship it");
    expect(t.requests).toHaveLength(2);
    expect(t.requests[0]!.options.onPayload).toBeDefined();
    expect(t.compacts[0].customInstructions.startsWith(DIRECT_PREFIX)).toBe(true);
    expect(t.entries.at(-1)!.data).toMatchObject({ summary: "cache", cached: 0 });
  });

  it("asks when there is no request to reuse", async () => {
    const q = asked();
    const t = setup({ replies: [json("Focus")], tokens: big, ui: { select: q.select } });
    await t.run("ship it");
    expect(q.calls[0]!.options[0]).toBe(SOURCE_OUTLINE);
    expect(q.calls[0]!.title).toContain("not in the prompt cache");
  });

  it("does not ask for a small conversation", async () => {
    const q = asked();
    const t = setup({ replies: [json("Focus"), "summary"], tokens: OUTLINE_MIN_TOKENS - 1, ui: { select: q.select } });
    t.emitEvent("cache:state", { cold: true });
    t.sendMain();
    await t.run("ship it");
    expect(q.calls.map((c) => c.title)).toEqual([REVIEW_QUESTION]);
    expect(t.requests[0]!.options.onPayload).toBeDefined();
  });

  it("does not ask when the outline would not be much smaller", async () => {
    const q = asked();
    const t = setup({ replies: [json("Focus"), "summary"], tokens: OUTLINE_MIN_TOKENS, ui: { select: q.select } });
    t.emitEvent("cache:state", { cold: true });
    t.sendMain();
    t.ctx.sessionManager.buildSessionProjection = () => ({ messages: Array.from({ length: 100 }, (_, i) => ({ role: "user", content: `${i} ${"x".repeat(3_500)}`, timestamp: 1 })) });
    await t.run("ship it");
    expect(q.calls.map((c) => c.title)).toEqual([REVIEW_QUESTION]);
  });

  it("cancels when the source question is dismissed", async () => {
    const t = setup({ replies: [json("Focus")], tokens: big, ui: { select: async () => undefined } });
    await t.run("ship it");
    expect(t.requests).toHaveLength(0);
    expect(t.compacts).toHaveLength(0);
    expect(t.notes).toContainEqual(["Compaction cancelled", "info"]);
  });

  it("describes the choice in pi-ask-user-question's dialog", async () => {
    const t = setup({ replies: [json("Focus")], tokens: big });
    const calls: any[] = [];
    t.pi.events.emit = (channel: string, data: any) => {
      if (channel === "pi-plugins.ask-user-question.v1") data.ask = async (_ctx: any, params: any) => {
        calls.push(params);
        return calls.length === 1 ? { cancelled: false, answers: [{ index: 0, question: "", kind: "option", answer: SOURCE_OUTLINE }] } : { cancelled: false, answers: [{ index: 0, question: "", kind: "option", answer: STOP }] };
      };
    };
    await t.run("ship it");
    const [outline, full] = calls[0].questions[0].options;
    expect(outline.description).toContain("Pi's summarizer still reads everything");
    expect(full.description).toContain("uncached");
    expect(t.requests[0]!.context.systemPrompt).toBe(OUTLINE_SYSTEM);
  });
});
