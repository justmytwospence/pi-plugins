import { expect, test } from "vitest";
import askUserQuestion from "../src/index.ts";
import { ASK_SERVICE_CHANNEL, type AskServiceRequest } from "../src/service.ts";
import { harness, KEYS, tuiContext } from "./harness.ts";

const params = {
  questions: [
    { question: "Keep approach A?", header: "Approach A", options: [{ label: "Keep", description: "" }, { label: "Drop", description: "" }] },
  ],
};

function request(h: ReturnType<typeof harness>): AskServiceRequest {
  const req: AskServiceRequest = { version: 1 };
  h.pi.events.emit(ASK_SERVICE_CHANNEL, req);
  return req;
}

test("answers a service request with the question dialog, holding herdr:blocked", async () => {
  const h = harness();
  askUserQuestion(h.pi);
  const req = request(h);
  expect(req.provider).toBe("pi-ask-user-question");
  const result = await req.ask!(tuiContext([KEYS.down, KEYS.enter], { events: h.events }) as any, params, { label: "Compaction plan" });
  expect(result).toMatchObject({ cancelled: false, answers: [{ kind: "option", answer: "Drop" }] });
  expect(h.events.filter((e) => e.channel === "herdr:blocked").map((e) => e.data)).toEqual([{ active: true, label: "Compaction plan" }, { active: false }]);
});

test("reports invalid questions and a missing UI instead of asking", async () => {
  const h = harness();
  askUserQuestion(h.pi);
  const ask = request(h).ask!;
  const one = { questions: [{ question: "Q?", header: "Q", options: [{ label: "only", description: "" }] }] };
  expect(await ask(tuiContext([]) as any, one)).toMatchObject({ error: "empty_options" });
  expect(await ask({ hasUI: false } as any, params)).toMatchObject({ error: "no_ui" });
});

test("leaves an answered request and other versions alone", () => {
  const h = harness();
  askUserQuestion(h.pi);
  const other = async () => ({ cancelled: true, answers: [] });
  const answered: AskServiceRequest = { version: 1, ask: other, provider: "other" };
  h.pi.events.emit(ASK_SERVICE_CHANNEL, answered);
  expect(answered.provider).toBe("other");
  const future: any = { version: 2 };
  h.pi.events.emit(ASK_SERVICE_CHANNEL, future);
  expect(future.ask).toBeUndefined();
});
