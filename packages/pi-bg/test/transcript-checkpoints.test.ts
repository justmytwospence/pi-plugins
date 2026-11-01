import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blocks } from "../src/result-view.ts";
import { fakeCtx, fakePi, until } from "./fake.ts";

const key = "pi-plugins.transcript.v1";
const checkpoint = (record: any) => record.details?.[key]?.checkpoint;
const reload = (record: any) => JSON.parse(JSON.stringify(record));
const shutdowns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
});

async function load() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-checkpoint-"));
  process.env.PI_BG_DIR = dir;
  const { default: piBg } = await import("../src/index.ts");
  const f = fakePi();
  const c = fakeCtx(dir);
  c.ctx.sessionManager.getSessionId = () => `checkpoint-${path.basename(dir)}`;
  piBg(f.pi as any);
  for (const h of f.handlers.get("session_start") ?? []) await h({ reason: "startup" }, c.ctx);
  shutdowns.push(async () => {
    for (const h of f.handlers.get("session_shutdown") ?? []) await h({ reason: "quit" }, c.ctx);
    delete process.env.PI_BG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = (name: string, id: string, params: object) => f.tools.get(name).execute(id, params, undefined, undefined, c.ctx);
  return { ...f, ...c, call };
}

describe("background transcript checkpoints", () => {
  it("aggregates only explicit block checkpoints, preserving content and Markdown indexes", () => {
    const first = { id: "delivery-1", kind: "report" };
    const list = [
      { text: "ready" },
      { text: "# Report", markdown: true, checkpoint: first },
      { text: "second", markdown: true, checkpoint: { id: "delivery-2", kind: "report" } },
    ];
    const saved = structuredClone(list);
    const result = blocks(list, "wait-call");
    expect(result.content.map((b: { text: string }) => b.text)).toEqual(["ready", "# Report", "second"]);
    expect(result.details.markdown).toEqual([1, 2]);
    expect(checkpoint(reload(result))).toEqual({ id: "wait-call", kind: "report" });
    expect(checkpoint(blocks(list))).toEqual(first);
    expect(list).toEqual(saved);
    expect(checkpoint(blocks([{ text: "report-looking text", markdown: true }], "wait-call"))).toBeUndefined();
  });

  it("keeps a historical launch plain after completion while its wake-up persists a report", async () => {
    const x = await load();
    const launch = await x.call("bg_run", "launch-call", { command: "sleep 2.5; echo done", kind: "job", name: "checkpoint-job" });
    expect(checkpoint(launch)).toBeUndefined();
    const historical = reload(launch);
    await until(() => x.sent.length > 0, 6_000);
    expect(checkpoint(historical)).toBeUndefined();
    expect(checkpoint(launch)).toBeUndefined();
    const wake = reload(x.sent[0].message);
    expect(checkpoint(wake)).toEqual({ id: expect.any(String), kind: "report" });
    expect(wake.details.tasks).toEqual([expect.objectContaining({ kind: "end" })]);
    expect(checkpoint(await x.call("bg_logs", "logs-call", {}))).toBeUndefined();
  });

  it("leaves ready notifications and waits plain but marks external completed reports", async () => {
    const x = await load();
    await x.call("bg_run", "service-call", { command: "sleep 2.5; echo READY; sleep 20", kind: "service", name: "checkpoint-service", ready: "READY" });
    await until(() => x.sent.length > 0, 6_000);
    expect(checkpoint(reload(x.sent[0].message))).toBeUndefined();
    expect(checkpoint(await x.call("bg_wait", "ready-call", { id: "checkpoint-service" }))).toBeUndefined();
    x.pi.events.emit("bg:external", { id: "outside:work", label: "outside", state: "done", result: "# Answer" });
    const report = reload(await x.call("bg_wait", "external-call", { id: "outside:work" }));
    expect(checkpoint(report)).toEqual({ id: "external-call", kind: "report" });
    expect(report.details.markdown).toEqual([1]);
    expect(report.content[1].text).toBe("# Answer");
    x.pi.events.emit("bg:external", { id: "outside:failure", label: "failure", state: "failed", summary: "failed" });
    const failure = reload(await x.call("bg_wait", "external-failure", { id: "outside:failure" }));
    expect(checkpoint(failure)).toEqual({ id: "external-failure", kind: "report" });
  });

  it("retains an end report delivered as an extra during a ready-only targeted wait", async () => {
    const x = await load();
    await x.call("bg_run", "service-call", { command: "sleep 6; echo READY; sleep 20", kind: "service", name: "target", ready: "READY" });
    await x.call("bg_run", "job-call", { command: "sleep 2.5; echo done", kind: "job", name: "extra" });
    const report = reload(await x.call("bg_wait", "mixed-wait", { id: "target" }));
    expect(report.content.map((b: any) => b.text).join("\n")).toMatch(/extra.*ended/s);
    expect(checkpoint(report)).toEqual({ id: "mixed-wait", kind: "report" });
  }, 12_000);

  it("marks failed starts and completed waits using their tool call IDs", async () => {
    const x = await load();
    const failed = reload(await x.call("bg_run", "failed-call", { command: "echo bad; exit 2", kind: "job", name: "failure" }));
    expect(checkpoint(failed)).toEqual({ id: "failed-call", kind: "report" });
    await x.call("bg_run", "job-call", { command: "sleep 2.5; echo finished", kind: "job", name: "waited" });
    const report = reload(await x.call("bg_wait", "wait-call", { id: "waited" }));
    expect(checkpoint(report)).toEqual({ id: "wait-call", kind: "report" });
    expect(report.content.some((b: any) => b.text.includes("finished"))).toBe(true);
    expect(checkpoint(await x.call("bg_wait", "empty-call", {}))).toBeUndefined();
  }, 10_000);
});
