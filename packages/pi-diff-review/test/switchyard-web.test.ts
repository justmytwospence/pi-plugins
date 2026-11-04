import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import extension from "../src/index.ts";
import { gitRepo } from "./helpers.ts";

function load() {
  const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
  const bus = new Map<string, ((d: any) => void)[]>();
  const pi = {
    on: (n: string, h: (e: unknown, c: unknown) => unknown) => handlers.set(n, h),
    registerCommand: () => {},
    getCommands: () => [{ name: "rewind-undo" }],
    appendEntry: () => {},
    events: {
      on: (c: string, fn: (d: any) => void) => void bus.set(c, [...(bus.get(c) ?? []), fn]),
      emit: (c: string, d: any) => { for (const fn of bus.get(c) ?? []) fn(d); },
    },
  };
  extension(pi as unknown as ExtensionAPI);
  return { pi, handlers };
}

test("/diff web view returns the patch as a diff node with scope actions", async () => {
  const repo = gitRepo();
  repo.write("file.txt", "before\n");
  repo.run("add", "-A");
  repo.run("commit", "-qm", "fixture");
  repo.write("file.txt", "after\n");
  const { pi, handlers } = load();
  const ctx = { cwd: repo.root, mode: "rpc", hasUI: true, sessionManager: { getBranch: () => [] }, ui: { notify() {} } };
  await handlers.get("session_start")!({}, ctx);

  const probe: any = { version: 1, name: "diff", args: "head", probe: true };
  pi.events.emit("switchyard.web-command.v1", probe);
  expect(probe.accept).toBe(true);

  const req: any = { version: 1, name: "diff", args: "head", probe: false, ctx };
  pi.events.emit("switchyard.web-command.v1", req);
  const view = await req.view;
  expect(view.title).toContain("Diff:");
  const file = view.body.children.find((c: any) => c.t === "section");
  expect(file.title).toContain("file.txt");
  expect(file.children[0].t).toBe("diff");
  expect(file.children[0].patch).toContain("+after");
  expect(view.actions.map((a: any) => a.command)).not.toContain("/diff head");
  expect(view.actions.map((a: any) => a.command)).toContain("/diff session");
});

test("/diff web view fails outside a git repository", async () => {
  const { pi, handlers } = load();
  const ctx = { cwd: "/tmp", mode: "rpc", hasUI: true, sessionManager: { getBranch: () => [] }, ui: { notify() {} } };
  await handlers.get("session_start")!({}, ctx);
  const req: any = { version: 1, name: "diff", args: "", probe: false, ctx };
  pi.events.emit("switchyard.web-command.v1", req);
  await expect(req.view).rejects.toThrow("Not a git repository");
});
