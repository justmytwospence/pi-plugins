import { describe, expect, it } from "vitest";
import piIssues, { startMessage } from "../src/index.ts";
import { fakeExec, github, repo, ROOT } from "./fake.ts";

function harness(exec = fakeExec(repo(), github([{ number: 76, title: "Library panel", body: "Branch `library`" }]))) {
  const tools: any[] = [];
  const commands = new Map<string, any>();
  const sent: { text: string; opts?: unknown }[] = [];
  const pi = {
    on: () => undefined,
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string, options: any) => commands.set(name, options),
    sendUserMessage: (text: string, opts?: unknown) => sent.push({ text, ...(opts ? { opts } : {}) }),
  };
  piIssues(pi as any, { exec, inHerdr: () => true });
  const notes: string[] = [];
  const ctx = (o: { input?: string; select?: string; idle?: boolean; hasUI?: boolean } = {}) => ({
    cwd: ROOT,
    hasUI: o.hasUI ?? true,
    isIdle: () => o.idle ?? true,
    ui: {
      notify: (m: string) => notes.push(m),
      input: async () => o.input,
      select: async (_t: string, options: string[]) => o.select ?? options[0],
    },
  });
  return { tools, commands, sent, notes, ctx, exec };
}

describe("pi-issues", () => {
  it("registers the issue tool and /issue", () => {
    const h = harness();
    expect(h.tools.map((t) => t.name)).toEqual(["issue"]);
    expect([...h.commands.keys()]).toEqual(["issue"]);
  });

  it("/issue #76 suggests the branch the issue names and asks the agent to start it", async () => {
    const h = harness();
    await h.commands.get("issue").handler("#76", h.ctx({ input: "" }));
    expect(h.sent).toEqual([{ text: startMessage([76], "library") }]);
    expect(h.sent[0]!.text).toBe("Start GitHub issue #76 on branch `library` with the issue tool (action=start), then start its worktree session as the result says.");
  });

  it("/issue with no number picks from open issues, takes a typed branch, and queues while busy", async () => {
    const exec = fakeExec(
      repo(),
      github([{ number: 76, title: "Library panel" }]),
      (line) => (line.startsWith("gh issue list") ? JSON.stringify([{ number: 76, title: "Library panel", milestone: { title: "Launch" } }]) : undefined),
    );
    const h = harness(exec);
    await h.commands.get("issue").handler("", h.ctx({ input: " shelf ", select: "#76 Library panel  · Launch", idle: false }));
    expect(h.sent).toEqual([{ text: startMessage([76], "shelf"), opts: { deliverAs: "followUp" } }]);
  });

  it("/issue rejects words that are not issue numbers, and Escape sends nothing", async () => {
    const h = harness();
    await h.commands.get("issue").handler("76 later", h.ctx());
    expect(h.notes).toEqual(["Usage: /issue [number...]"]);
    await h.commands.get("issue").handler("76", h.ctx({ input: undefined }));
    expect(h.sent).toEqual([]);
  });

  it("issue action=status sets a status by name, and names the valid ones otherwise", async () => {
    const h = harness();
    const tool = h.tools[0];
    const out = await tool.execute("id", { action: "status", issues: [76], status: "done" }, undefined, undefined, { cwd: ROOT });
    expect(out.content[0].text).toBe("Set #76 to Done.");
    expect(h.exec.calls.some((c: string) => c.includes("issue=I_76 -f status=S_done"))).toBe(true);
    await expect(tool.execute("id", { action: "status", issues: [76], status: "Shipped" }, undefined, undefined, { cwd: ROOT })).rejects.toThrow(
      'Unknown status "Shipped"; this repository has: Backlog, Todo, In progress, In review, Done',
    );
  });
});
