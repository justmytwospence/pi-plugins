import { expect, test } from "vitest";
import { DEFAULT_EFFORT_UPDATES, effortUpdatesConfig, emptyState, plan, restoreState, rewritePayload } from "../src/effort-updates.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
const asst = (text: string, id?: string) => ({ type: "message", role: "assistant", ...(id ? { id, status: "completed" } : {}), content: [{ type: "output_text", text }] });
const call = (id: string) => ({ type: "function_call", call_id: id, name: "bash", arguments: "{}" });
const out = (id: string) => ({ type: "function_call_output", call_id: id, output: "ok" });
const cfg = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });

test("the first request sets the baseline; later changes become items replayed in place", () => {
  const s = emptyState();
  const h1 = [user("plan it")];
  expect(plan(s, h1, "low")).toMatchObject({ input: h1, effort: "low", changed: true });

  // Mid-run: the level goes up after a tool result.
  const h2 = [...h1, asst("ok"), call("1"), out("1")];
  const p2 = plan(s, h2, "high");
  expect(p2.effort).toBe("low");
  expect(p2.input).toEqual([...h2, cfg("high")]);

  // The next request replays it in place, unchanged effort: nothing new.
  const h3 = [...h2, call("2"), out("2")];
  const p3 = plan(s, h3, "high");
  expect(p3).toMatchObject({ effort: "low", changed: false });
  expect(p3.input).toEqual([...h2, cfg("high"), call("2"), out("2")]);

  // A new prompt at a lower level: the item goes before the user message.
  const h4 = [...h3, asst("done"), user("thanks")];
  const p4 = plan(s, h4, "medium");
  expect(p4.input).toEqual([...h2, cfg("high"), call("2"), out("2"), asst("done"), cfg("medium"), user("thanks")]);
  expect(p4.effort).toBe("low");
});

test("two changes at one position merge; a change back to the level in force adds nothing", () => {
  const s = emptyState();
  const h = [user("a"), asst("b"), call("1"), out("1")];
  plan(s, h.slice(0, 1), "medium");
  plan(s, h, "high");
  const merged = plan(s, h, "xhigh");
  expect(merged.input.filter((i: any) => i.type === "configuration_update")).toEqual([cfg("xhigh")]);
  const back = plan(s, h, "medium");
  expect(back.input).toEqual(h);
});

test("a rewritten history resets the baseline; output-only fields do not count as a rewrite", () => {
  const s = emptyState();
  plan(s, [user("a")], "low");
  const live = [user("a"), asst("b", "msg_1"), call("1"), out("1")];
  plan(s, live, "high");
  // A replay drops id/status: still the same history.
  const replay = [user("a"), asst("b"), call("1"), out("1"), call("2"), out("2")];
  expect(plan(s, replay, "high")).toMatchObject({ effort: "low", changed: false });
  // Compaction rewrote it: start over at the requested effort.
  const compacted = [user("summary of everything"), user("next")];
  expect(plan(s, compacted, "high")).toMatchObject({ input: compacted, effort: "high", changed: true });
  expect(s.transitions).toEqual([]);
});

test("rewritePayload pins the effort, and leaves other payloads alone", () => {
  const s = emptyState();
  const first = { model: "gpt-6-astra", input: [user("a")], reasoning: { effort: "medium", summary: "auto" } };
  rewritePayload(s, first);
  const second = { model: "gpt-6-astra", input: [user("a"), asst("b"), call("1"), out("1")], reasoning: { effort: "xhigh", summary: "auto" } };
  expect(rewritePayload(s, second)).toBe(true);
  expect(second.reasoning).toEqual({ effort: "medium", summary: "auto" });
  expect(second.input.at(-1)).toEqual(cfg("xhigh"));

  for (const other of [{ messages: [] }, { input: [user("a")] }, { input: [user("a")], reasoning: { effort: "none" } }, { input: [cfg("low"), user("a")], reasoning: { effort: "low" } }]) {
    const before = JSON.stringify(other);
    expect(rewritePayload(s, other)).toBe(false);
    expect(JSON.stringify(other)).toBe(before);
  }
});

test("restoreState keeps valid fields only", () => {
  expect(restoreState(undefined)).toEqual({ transitions: [] });
  expect(restoreState({ base: "low", current: "high", transitions: [{ index: 3, anchor: "x", effort: "high" }, { index: 1.5, anchor: "y", effort: "high" }, { index: 2, anchor: "z", effort: "ultra" }] })).toEqual({
    base: "low",
    current: "high",
    transitions: [{ index: 3, anchor: "x", effort: "high" }],
  });
  expect(effortUpdatesConfig({ models: ["a/*", 1] })).toEqual({ ...DEFAULT_EFFORT_UPDATES, models: ["a/*"] });
});
