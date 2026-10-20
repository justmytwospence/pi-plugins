import { describe, expect, it } from "vitest";
import { compactExchange, EXCHANGE_ENTRY, RESET_ENTRY, threadFromBranch } from "../src/thread.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) as never;
const exchange = (...messages: never[]) => ({ type: "custom", customType: EXCHANGE_ENTRY, data: { version: 1, messages, timestamp: 0 } });

describe("threadFromBranch", () => {
  it("joins the exchanges after the last reset, ignoring other entries", () => {
    const branch = [
      exchange(user("old")),
      { type: "custom", customType: RESET_ENTRY, data: {} },
      { type: "message", message: user("main's own") },
      exchange(user("q1")),
      { type: "custom", customType: "other", data: { messages: [user("x")] } },
      exchange(user("q2")),
    ];
    expect(threadFromBranch(branch).map((m: any) => m.content[0].text)).toEqual(["q1", "q2"]);
  });

  it("is empty for a branch without Sidebar entries", () => {
    expect(threadFromBranch([{ type: "message" }])).toEqual([]);
  });
});

describe("compactExchange", () => {
  it("cuts long tool results and drops images, leaving other messages as they are", () => {
    const messages = [
      user("q"),
      { role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "y".repeat(50) }, { type: "image", data: "…" }] },
    ] as never[];
    const compact = compactExchange(messages, 10) as any[];
    expect(compact[0]).toEqual(messages[0]);
    expect(compact[1].content[0].text).toMatch(/^y{10}\n… \(40 more characters/);
    expect(compact[1].content[1]).toEqual({ type: "text", text: "(image not kept in Sidebar's history)" });
    expect((messages[1] as any).content[0].text).toHaveLength(50);
  });
});
