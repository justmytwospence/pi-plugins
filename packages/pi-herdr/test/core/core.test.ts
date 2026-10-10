// Shared verbatim by pi-herdr and opencode-herdr (test/core).
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Activity } from "../../src/core/activity.ts";
import { herdrTarget, socketCall, splitDirection } from "../../src/core/herdr.ts";
import { checksMark, parsePrView, prToken } from "../../src/core/pr.ts";
import { PaneReporter, WorkspaceReporter } from "../../src/core/report.ts";
import { clipReply, MAX_LINES, shortModel, stripNext, titleFromPrompt } from "../../src/core/text.ts";
import { fakeCall } from "./fake.ts";

describe("text", () => {
  it("shortens model ids and titles prompts", () => {
    expect(shortModel("claude-opus-5-5")).toBe("opus-5-5");
    expect(shortModel("anthropic/claude-sonnet-5-5-20260101")).toBe("sonnet-5-5");
    expect(shortModel("gpt-6-astra")).toBe("gpt-6-astra");
    expect(titleFromPrompt("/skill:foo\n\n  fix the   auth flow  \nmore")).toBe("fix the auth flow");
    expect(titleFromPrompt("x".repeat(100))?.length).toBe(60);
    expect(titleFromPrompt("/only-a-command")).toBeUndefined();
  });

  it("drops the next-prompt line and clips long replies from the front", () => {
    expect(stripNext("Done.\n\n<next>commit it</next>")).toBe("Done.");
    const long = Array.from({ length: MAX_LINES + 5 }, (_, i) => `line ${i}`).join("\n");
    const out = clipReply(long, "/s.jsonl");
    expect(out.startsWith("[earlier part cut; full reply in /s.jsonl]")).toBe(true);
    expect(out.endsWith(`line ${MAX_LINES + 4}`)).toBe(true);
  });

  it("splits beside wide panes and below tall or narrow ones", () => {
    expect(splitDirection({ width: 200, height: 50 })).toBe("right");
    expect(splitDirection({ width: 165, height: 57 })).toBe("right");
    expect(splitDirection({ width: 120, height: 40 })).toBe("down");
    expect(splitDirection(undefined)).toBe("right");
  });
});

describe("activity", () => {
  it("counts holds per label and releases the oldest per channel", () => {
    const a = new Activity();
    expect(a.token()).toBeUndefined();
    a.apply("herdr:background", { active: true, label: "subagents (2)" });
    a.apply("herdr:background", { active: true, label: "subagents (2)" });
    a.apply("herdr:working", { active: true, label: "planner" });
    expect(a.token()).toBe("subagents (2) ×2 · planner");
    a.apply("herdr:background", { active: false });
    expect(a.token()).toBe("subagents (2) · planner");
    a.apply("herdr:working", { active: false });
    a.apply("herdr:background", { active: false });
    expect(a.token()).toBeUndefined();
    a.apply("herdr:background", { active: false });
    expect(a.size).toBe(0);
  });

  it("releases by id", () => {
    const a = new Activity();
    a.apply("herdr:background", { active: true, label: "child a", id: "child:a" });
    a.apply("herdr:background", { active: true, label: "child b", id: "child:b" });
    a.apply("herdr:background", { active: false, id: "child:b" });
    expect(a.token()).toBe("child a");
  });
});

describe("pr", () => {
  it("formats the token", () => {
    expect(prToken(undefined)).toBeUndefined();
    expect(prToken({ number: 12, state: "OPEN", isDraft: false, reviewDecision: "APPROVED", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] })).toBe("#12 ✓ approved");
    expect(prToken({ number: 12, state: "OPEN", isDraft: true, reviewDecision: "", statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }] })).toBe("#12 draft …");
    expect(prToken({ number: 12, state: "OPEN", reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [{ state: "FAILURE" }, { status: "QUEUED" }] })).toBe("#12 ✗ changes");
    expect(prToken({ number: 12, state: "MERGED" })).toBe("#12 merged");
    expect(checksMark([])).toBeUndefined();
    expect(checksMark([{ state: "SUCCESS" }, { state: "PENDING" }])).toBe("…");
    expect(parsePrView('{"number":3}')?.number).toBe(3);
    expect(parsePrView("nope")).toBeUndefined();
  });
});

describe("reporters", () => {
  it("sends tokens once, clears, refreshes and presents", async () => {
    const f = fakeCall();
    const r = new PaneReporter(f.call, "w1:p1");
    await r.setToken("bg", "subagents", 90_000);
    await r.setToken("bg", "subagents", 90_000);
    await r.setToken("bad name!", "x");
    expect(f.of("pane.report_metadata")).toHaveLength(1);
    expect(f.log[0]!.params).toMatchObject({ pane_id: "w1:p1", source: "pi-herdr", tokens: { bg: "subagents" }, ttl_ms: 90_000 });
    await r.refresh(Date.now() + 1_000);
    expect(f.of("pane.report_metadata")).toHaveLength(1);
    await r.refresh(Date.now() + 31_000);
    expect(f.of("pane.report_metadata")).toHaveLength(2);
    await r.setToken("bg", undefined);
    expect(f.log.at(-1)!.params.tokens).toEqual({ bg: null });
    await r.setPresentation("fix auth", "pi opus");
    expect(f.log.at(-1)!.params).toMatchObject({ agent: "pi", applies_to_source: "herdr:pi", title: "fix auth", display_agent: "pi opus" });
    await r.setToken("task", "fix auth");
    await r.clearAll();
    const last2 = f.log.slice(-2).map((l) => l.params);
    expect(last2[0]).toMatchObject({ clear_title: true, clear_display_agent: true });
    expect(last2[1]!.tokens).toEqual({ task: null });
    const seqs = f.log.map((l) => l.params.seq as number);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("reports workspace tokens", async () => {
    const f = fakeCall();
    const w = new WorkspaceReporter(f.call, "w1");
    await w.setToken("pr", "#1 ✓");
    expect(f.log[0]).toMatchObject({ method: "workspace.report_metadata", params: { workspace_id: "w1", tokens: { pr: "#1 ✓" } } });
  });
});

describe("socket", () => {
  it("talks one JSON line each way and never throws", async () => {
    expect(herdrTarget({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1" })).toEqual({ socketPath: "/s", paneId: "w1:p1" });
    expect(herdrTarget({ HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1" })).toBeUndefined();
    const dir = mkdtempSync(path.join(tmpdir(), "pi-herdr-sock-"));
    const sock = path.join(dir, "h.sock");
    const server = net.createServer((c) =>
      c.on("data", (d) => {
        const req = JSON.parse(d.toString());
        c.write(`${JSON.stringify(req.method === "bad" ? { id: req.id, error: { code: "not_found", message: "nope" } } : { id: req.id, result: { echo: req.params } })}\n`);
      }),
    );
    await new Promise<void>((r) => server.listen(sock, r));
    const call = socketCall(sock);
    expect(await call("pane.get", { pane_id: "x" })).toEqual({ result: { echo: { pane_id: "x" } } });
    expect((await call("bad", {})).error?.code).toBe("not_found");
    server.close();
    expect((await socketCall(path.join(dir, "missing.sock"))("x", {})).error?.code).toBe("socket");
  });
});
