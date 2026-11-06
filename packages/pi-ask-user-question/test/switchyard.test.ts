import { describe, expect, it } from "vitest";
import adapter, {
  type AdapterContext,
  type Claim,
  type InteractionResponse,
  type PiUiRequest,
  type PiUiResponse,
  type QueuedStep,
} from "../src/switchyard/adapter.ts";

/**
 * Request payloads in the shape pi-ask-user-question and pi-tool-gate send over RPC
 * (`extension_ui_request`, dialog methods). Titles follow the plugins' RPC formatting:
 * ask-user-question `[header] question` plus `--- n. label ---` preview blocks, numbered
 * options with a final "N. Type something."; tool-gate "Allow this call?" plus field lines.
 */

export const fruitQuestion = {
  question: "Which fruit should we use?",
  header: "Fruit",
  options: [
    { label: "Apple", description: "Red and crunchy", preview: "An apple a day" },
    { label: "Banana", description: "Yellow and soft", preview: "Potassium" },
    { label: "Cherry", description: "Small and sweet" },
  ],
};

export const toppingsQuestion = {
  question: "Which toppings?",
  header: "Toppings",
  multiSelect: true,
  options: [
    { label: "Cream", description: "Whipped", preview: "```\ncream\n```" },
    { label: "Nuts", description: "Crunchy" },
    { label: "Syrup", description: "Sweet" },
  ],
};

export const sizeQuestion = {
  question: "What size?",
  header: "Size",
  options: [
    { label: "Small", description: "" },
    { label: "Large", description: "" },
  ],
};

export const fruitSelect: PiUiRequest = {
  id: "aq-1",
  method: "select",
  title:
    "[Fruit] Which fruit should we use?\n\n--- 1. Apple ---\nAn apple a day\n\n--- 2. Banana ---\nPotassium",
  options: [
    "1. Apple - Red and crunchy",
    "2. Banana - Yellow and soft",
    "3. Cherry - Small and sweet",
    "4. Type something.",
  ],
};

export const fruitOtherInput: PiUiRequest = {
  id: "aq-2",
  method: "input",
  title: `${fruitSelect.title}\n\nType your answer:`,
};

/** Format recorded from pi-ask-user-question 0.1.2 (test/compat/ask-user-question.compat.test.ts). */
export const toppingsInput: PiUiRequest = {
  id: "aq-3",
  method: "input",
  title:
    "[Toppings] Which toppings?\n\n1. Cream - Whipped\n2. Nuts - Crunchy\n3. Syrup - Sweet\n\nEnter the numbers of all that apply, comma-separated (e.g. 1,3), or type an answer of your own.",
  placeholder: "1,3",
};

export const sizeSelect: PiUiRequest = {
  id: "aq-4",
  method: "select",
  title: "[Size] What size?",
  options: ["1. Small", "2. Large", "3. Type something."],
};

const CALL = "call-ask-1";

type Outcome =
  | { kind: "claim"; claim: Claim }
  | { kind: "queued"; response: PiUiResponse }
  | { kind: "generic" };

/**
 * A minimal stand-in for the Switchyard host session: per-adapter state, claiming of dialogs
 * and the queue of answers a claim produced for the follow-up dialogs of the same tool call.
 */
function harness() {
  const store = new Map<string, unknown>();
  const ctx: AdapterContext = {
    state: {
      get: <T = unknown>(key: string) => store.get(key) as T | undefined,
      set: (key: string, value: unknown) => void store.set(key, structuredClone(value)),
      delete: (key: string) => void store.delete(key),
      keys: () => [...store.keys()],
    },
    log: () => {},
  };
  let queue: QueuedStep[] = [];
  const resolve = (step: PiUiResponse | QueuedStep, req: PiUiRequest) => {
    const source = "match" in step ? step.response : step;
    return typeof source === "function" ? source(req) : source;
  };
  return {
    start: (questions: unknown[]) =>
      adapter.onToolStart({ toolCallId: CALL, name: "ask_user_question", args: { questions } }, ctx),
    end: () => adapter.onToolEnd({ toolCallId: CALL, name: "ask_user_question" }, ctx),
    update: (toolCallId: string, name: string, details: unknown) =>
      adapter.onToolUpdate({ toolCallId, name, details }, ctx),
    endTool: (toolCallId: string, name: string) => adapter.onToolEnd({ toolCallId, name }, ctx),
    queued: () => queue.length,
    onUiRequest(req: PiUiRequest): Outcome {
      const i = queue.findIndex((s) => (typeof s.match === "function" ? s.match(req) : false));
      if (i !== -1) {
        const response = resolve(queue[i]!, req);
        if (response !== undefined) {
          queue.splice(i, 1);
          return { kind: "queued", response };
        }
      }
      const claim = adapter.claimInteraction(req, ctx);
      return claim ? { kind: "claim", claim } : { kind: "generic" };
    },
    respond(claim: Claim, req: PiUiRequest, answer: InteractionResponse): PiUiResponse {
      const out = claim.toPiResponse(answer);
      if (!("sequence" in out)) return out;
      const [first, ...rest] = out.sequence;
      const response = resolve(first!, req);
      if (response === undefined) throw new Error("first step did not answer the dialog");
      queue = rest.filter((s): s is QueuedStep => "match" in s);
      return response;
    },
  };
}
type Harness = ReturnType<typeof harness>;

function claimOf(h: Harness, req: PiUiRequest): Claim {
  const out = h.onUiRequest(req);
  if (out.kind !== "claim") throw new Error(`expected claim, got ${out.kind}`);
  return out.claim;
}

/** Play Pi's dialog sequence: answer the first claim with `answer`, everything else must be queued. */
function play(h: Harness, dialogs: PiUiRequest[], answer: InteractionResponse) {
  const [first, ...rest] = dialogs;
  const claim = claimOf(h, first!);
  const sent = [h.respond(claim, first!, answer)];
  for (const d of rest) {
    const q = h.onUiRequest(d);
    expect(q.kind, `dialog ${d.id} should be answered from the form`).toBe("queued");
    if (q.kind === "queued") sent.push(q.response);
  }
  return { claim, sent };
}

describe("ask-user-question switchyard adapter", () => {
  it("claims the first dialog and presents every question in one form", async () => {
    const h = harness();
    await h.start([fruitQuestion, toppingsQuestion]);
    const claim = claimOf(h, fruitSelect);
    expect(claim.ownerToolCallId).toBe(CALL);
    expect(claim.title).toBe("Fruit and 1 more question");
    expect(claim.presentation).toMatchObject({
      t: "form",
      formId: `ask-user-question:${CALL}`,
      submitLabel: "Submit answers",
      fields: [
        {
          kind: "select",
          name: "q1",
          label: "Which fruit should we use?",
          allowOther: { label: "Type something." },
          options: [
            { value: "Apple", label: "Apple", description: "Red and crunchy", preview: "An apple a day" },
            { value: "Banana" },
            { value: "Cherry" },
          ],
        },
        {
          kind: "multiselect",
          name: "q2",
          options: [{ value: "Cream", preview: "```\ncream\n```" }, {}, {}],
        },
      ],
    });
  });

  it("single select -> the numbered option string", async () => {
    const h = harness();
    await h.start([fruitQuestion]);
    const { sent } = play(h, [fruitSelect], { kind: "form", values: { q1: "Banana" } });
    expect(sent).toEqual([{ value: "2. Banana - Yellow and soft" }]);
    expect(h.queued()).toBe(0);
  });

  it("single + multi select -> option string, then '1,3' for the multi-select input", async () => {
    const h = harness();
    await h.start([fruitQuestion, toppingsQuestion]);
    const { sent } = play(h, [fruitSelect, toppingsInput], {
      kind: "form",
      values: { q1: "Apple", q2: ["Syrup", "Cream"] },
    });
    expect(sent).toEqual([{ value: "1. Apple - Red and crunchy" }, { value: "1,3" }]);
  });

  it("Other -> 'Type something.' then the typed answer in the follow-up input", async () => {
    const h = harness();
    await h.start([fruitQuestion, toppingsQuestion]);
    const { sent } = play(h, [fruitSelect, fruitOtherInput, toppingsInput], {
      kind: "form",
      values: { q1: { other: "Durian" }, q2: ["Nuts"] },
    });
    expect(sent).toEqual([{ value: "4. Type something." }, { value: "Durian" }, { value: "2" }]);
  });

  it("skips questions whose showIf is unmet (no dialog, no queued answer)", async () => {
    const h = harness();
    const conditional = { ...toppingsQuestion, showIf: { header: "Fruit", answers: ["Banana"] } };
    await h.start([fruitQuestion, conditional, sizeQuestion]);
    const claim = claimOf(h, fruitSelect);
    expect(claim.presentation).toMatchObject({
      fields: [{}, { name: "q2", showIf: { field: "q1", values: ["Banana"] } }, {}],
    });
    expect(h.respond(claim, fruitSelect, { kind: "form", values: { q1: "Apple", q3: "Large" } })).toEqual({
      value: "1. Apple - Red and crunchy",
    });
    expect(h.queued()).toBe(1);
    // Pi skips the toppings dialog and asks the size next.
    expect(h.onUiRequest(sizeSelect)).toMatchObject({ kind: "queued", response: { value: "2. Large" } });
    expect(h.queued()).toBe(0);
  });

  it("asks the conditional question when its condition is met", async () => {
    const h = harness();
    const conditional = { ...toppingsQuestion, showIf: { header: "Fruit", answers: ["Banana"] } };
    await h.start([fruitQuestion, conditional, sizeQuestion]);
    const { sent } = play(h, [fruitSelect, toppingsInput, sizeSelect], {
      kind: "form",
      values: { q1: "Banana", q2: ["Cream", "Nuts"], q3: "Small" },
    });
    expect(sent).toEqual([{ value: "2. Banana - Yellow and soft" }, { value: "1,2" }, { value: "1. Small" }]);
  });

  it("a showIf that references no earlier question never matches", async () => {
    const h = harness();
    await h.start([fruitQuestion, { ...sizeQuestion, showIf: { header: "Nope", answers: ["x"] } }]);
    expect(claimOf(h, fruitSelect).presentation).toMatchObject({
      fields: [{}, { showIf: { field: "__unmet__", values: [] } }],
    });
  });

  it("cancel -> {cancelled: true} and nothing queued", async () => {
    const h = harness();
    await h.start([fruitQuestion, toppingsQuestion]);
    const claim = claimOf(h, fruitSelect);
    expect(h.respond(claim, fruitSelect, { kind: "cancel" })).toEqual({ cancelled: true });
    expect(h.queued()).toBe(0);
  });

  it("rejects an incomplete or mistyped answer without answering Pi", async () => {
    const h = harness();
    await h.start([fruitQuestion, toppingsQuestion]);
    const claim = claimOf(h, fruitSelect);
    expect(() => h.respond(claim, fruitSelect, { kind: "form", values: { q1: "Apple" } })).toThrow(
      /choose at least one/,
    );
    expect(() => h.respond(claim, fruitSelect, { kind: "form", values: { q1: "Kiwi", q2: ["Nuts"] } })).toThrow(
      /unknown option/,
    );
    expect(() => h.respond(claim, fruitSelect, { kind: "form", values: { q2: ["Nuts"] } })).toThrow(/needs an answer/);
    expect(() => h.respond(claim, fruitSelect, { kind: "action", actionId: "x" })).toThrow(/expected the question form/);
    try {
      h.respond(claim, fruitSelect, { kind: "form", values: {} });
    } catch (err) {
      expect((err as Error).name).toBe("InteractionResponseError");
      expect((err as { code?: string }).code).toBe("invalid_request");
    }
  });

  it("forgets the call when the tool ends", async () => {
    const h = harness();
    await h.start([fruitQuestion, toppingsQuestion]);
    await h.end();
    expect(h.onUiRequest(fruitSelect)).toEqual({ kind: "generic" });
  });

  it("leaves dialogs to generic when the tool args are unknown or do not match", async () => {
    const h = harness();
    expect(h.onUiRequest(fruitSelect)).toEqual({ kind: "generic" });
    await h.start([sizeQuestion]);
    expect(h.onUiRequest(fruitSelect)).toEqual({ kind: "generic" });
  });

  it("ignores unparsable tool args and claims a call only once", async () => {
    const bad = harness();
    await bad.start([{ question: "?", header: "Bad", options: [{ label: "only one" }] }]);
    expect(bad.onUiRequest(sizeSelect)).toEqual({ kind: "generic" });
    const h = harness();
    await h.start([sizeQuestion]);
    expect(h.onUiRequest(sizeSelect)).toMatchObject({ kind: "claim" });
    expect(h.onUiRequest({ ...sizeSelect, id: "again" })).toEqual({ kind: "generic" });
  });

  describe("questions another tool advertises in details.askUserQuestion", () => {
    const PLANNER_CALL = "call-ask-planner-1";

    it("claims the dialog as a form owned by that tool call", () => {
      const h = harness();
      h.update(PLANNER_CALL, "ask_planner", { askUserQuestion: { questions: [sizeQuestion] } });
      const claim = claimOf(h, sizeSelect);
      expect(claim.ownerToolCallId).toBe(PLANNER_CALL);
      expect(claim.presentation).toMatchObject({ t: "form", formId: `ask-user-question:${PLANNER_CALL}` });
    });

    it("drops the claim when an update no longer advertises a question, and when the tool ends", () => {
      const cleared = harness();
      cleared.update(PLANNER_CALL, "ask_planner", { askUserQuestion: { questions: [sizeQuestion] } });
      cleared.update(PLANNER_CALL, "ask_planner", { pending: true });
      expect(cleared.onUiRequest(sizeSelect)).toEqual({ kind: "generic" });
      const ended = harness();
      ended.update(PLANNER_CALL, "finish_plan", { askUserQuestion: { questions: [sizeQuestion] } });
      ended.endTool(PLANNER_CALL, "finish_plan");
      expect(ended.onUiRequest(sizeSelect)).toEqual({ kind: "generic" });
    });

    it("ignores malformed advertisements and does not reset a claimed question on a repeat", () => {
      const bad = harness();
      bad.update(PLANNER_CALL, "ask_planner", { askUserQuestion: { questions: [{ question: "?" }] } });
      expect(bad.onUiRequest(sizeSelect)).toEqual({ kind: "generic" });
      const h = harness();
      const details = { askUserQuestion: { questions: [sizeQuestion] } };
      h.update(PLANNER_CALL, "ask_planner", details);
      expect(h.onUiRequest(sizeSelect)).toMatchObject({ kind: "claim" });
      h.update(PLANNER_CALL, "ask_planner", details);
      expect(h.onUiRequest({ ...sizeSelect, id: "again" })).toEqual({ kind: "generic" });
    });

    it("leaves the tool's own path unchanged: its own updates are ignored", async () => {
      const h = harness();
      await h.start([sizeQuestion]);
      h.update(CALL, "ask_user_question", { askUserQuestion: { questions: [fruitQuestion] } });
      expect(h.onUiRequest(fruitSelect)).toEqual({ kind: "generic" });
      expect(h.onUiRequest(sizeSelect)).toMatchObject({ kind: "claim" });
    });
  });
});
