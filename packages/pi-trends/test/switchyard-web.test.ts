import { describe, expect, it } from "vitest";
import extension from "../src/index.ts";

function load() {
  const bus = new Map<string, ((d: any) => void)[]>();
  const pi: any = {
    on: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    registerMessageRenderer: () => {},
    getThinkingLevel: () => "off",
    events: {
      on: (c: string, fn: (d: any) => void) => void bus.set(c, [...(bus.get(c) ?? []), fn]),
      emit: (c: string, d: any) => { for (const fn of bus.get(c) ?? []) fn(d); },
    },
  };
  extension(pi);
  return pi;
}

const ask = async (pi: any, args: string, probe: boolean, ctx?: any) => {
  const req: any = { version: 1, name: "trends", args, probe, ctx };
  pi.events.emit("switchyard.web-command.v1", req);
  return { req, view: probe ? undefined : await req.view };
};

const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } };
const ctxWith = (entries: unknown[]) => ({
  model: { contextWindow: 10_000 },
  sessionManager: { getBranch: () => entries },
});

describe("trends web view", () => {
  it("accepts only the bare command", async () => {
    const pi = load();
    expect((await ask(pi, "", true)).req.accept).toBe(true);
    expect((await ask(pi, "widget on", true)).req.accept).toBeUndefined();
  });

  it("says when there are no calls yet", async () => {
    const { view } = await ask(load(), "", false, ctxWith([]));
    expect(view.title).toBe("Trends");
    expect(view.body).toEqual({ t: "text", text: "No model calls in this session yet." });
    expect(view.actions.map((a: any) => a.command)).toEqual(["/trends widget on", "/trends widget off"]);
  });

  it("lists metrics and a table of calls", async () => {
    const entries = [
      { type: "message", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "hi" } },
      { type: "message", timestamp: "2026-01-01T00:00:05Z", message: { role: "assistant", provider: "p", model: "m", usage, content: [{ type: "text" }] } },
    ];
    const { view } = await ask(load(), "", false, ctxWith(entries));
    expect(view.body.t).toBe("section");
    expect(view.body.children[0].t).toBe("list");
    expect(view.body.children[1].t).toBe("table");
    expect(view.body.children[1].rows).toHaveLength(1);
  });
});
