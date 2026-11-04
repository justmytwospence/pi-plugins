import { expect, test } from "vitest";
import subagents from "../src/index.ts";
import { harness } from "./harness.ts";

function load() {
  const h = harness();
  const bus = new Map<string, ((d: any) => void)[]>();
  h.pi.events = {
    emit: (c: string, d: unknown) => { for (const fn of bus.get(c) ?? []) fn(d); },
    on: (c: string, fn: (d: any) => void) => { bus.set(c, [...(bus.get(c) ?? []), fn]); return () => undefined; },
  } as any;
  subagents(h.pi);
  return h;
}

const ask = async (h: ReturnType<typeof load>, args: string, probe: boolean, ctx?: unknown) => {
  const req: any = { version: 1, name: "subagents", args, probe, ctx };
  h.pi.events.emit("switchyard.web-command.v1", req);
  return { req, view: probe ? undefined : await req.view };
};

const ctx = { sessionManager: { getBranch: () => [], getSessionId: () => "s" } };

test("claims the list and stats, not id or stop", async () => {
  const h = load();
  for (const a of ["", "stats", "stats all", "stats --all"]) expect((await ask(h, a, true)).req.accept).toBe(true);
  for (const a of ["stop all", "abc123"]) expect((await ask(h, a, true)).req.accept).toBeUndefined();
});

test("the list says when there are no runs and offers the stats", async () => {
  const { view } = await ask(load(), "", false, ctx);
  expect(view.title).toBe("Subagent runs");
  expect(view.body).toEqual({ t: "text", text: "No subagent runs in this session." });
  expect(view.actions.map((a: any) => a.command)).toEqual(["/subagents stats", "/subagents stats all"]);
});

test("stats view has tables and a way back", async () => {
  const { view } = await ask(load(), "stats", false, ctx);
  expect(view.title).toBe("Subagent stats");
  expect(view.body.children.filter((c: any) => c.t === "table")).toHaveLength(2);
  expect(view.actions).toEqual([{ label: "Back to runs", command: "/subagents" }]);
});
