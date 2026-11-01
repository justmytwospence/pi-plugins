import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import subagents from "../src/index.ts";
import { setPiInvocation } from "../src/child.ts";
import { readTranscriptCheckpoint } from "../src/transcript-contract.ts";
import { harness } from "./harness.ts";

afterEach(() => { setPiInvocation(undefined); vi.unstubAllEnvs(); });

const checkpoint = (record: any) => readTranscriptCheckpoint(JSON.parse(JSON.stringify(record)).details);

async function setup(fixture: string) {
  vi.stubEnv("FAKE_NO_DIALOG", "1");
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", fixture)] });
  const h = harness();
  let tool: any;
  h.pi.registerTool = (value: unknown) => { tool = value; };
  subagents(h.pi);
  const ctx = h.ctx({ cwd: mkdtempSync(path.join(tmpdir(), "subagents-checkpoint-")), hasUI: false, model: { provider: "p", id: "m" } });
  await h.emit("session_start", { type: "session_start" }, ctx);
  return { h, ctx, run: (id: string, params: object) => tool.execute(id, params, undefined, undefined, ctx) };
}

test("foreground and retrieved results persist reports while status remains plain", async () => {
  const { h, ctx, run } = await setup("fake-pi.mjs");
  const result = await run("foreground", { task: "do work", agent: "general" });
  expect(checkpoint(result)).toEqual({ id: "foreground", kind: "report" });
  const id = result.details.runs[0].id;
  expect(checkpoint(await run("status", { action: "status", id }))).toBeUndefined();
  expect(checkpoint(await run("retrieval", { action: "result", id }))).toEqual({ id: "retrieval", kind: "report" });
  await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
});

test("fast async launch stays plain after completion; delivered message is a report", async () => {
  const { h, ctx, run } = await setup("fake-pi.mjs");
  const launch = await run("launch", { task: "fast work", agent: "general", async: true });
  await vi.waitFor(() => expect(h.messages.length).toBeGreaterThan(0));
  expect(checkpoint(launch)).toBeUndefined();
  expect(checkpoint(h.messages[0].message)).toEqual({ id: expect.any(String), kind: "report" });
  await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
});

test("a stopped foreground run returns a marked terminal failure", async () => {
  const { h, ctx, run } = await setup("fake-pi-loop.mjs");
  const pending = run("foreground-failure", { task: "long work", agent: "general" });
  let id: string | undefined;
  await vi.waitFor(async () => {
    const status = await run("status", { action: "status" });
    id = status.details.runs[0]?.id;
    expect(id).toBeTruthy();
  });
  expect(checkpoint(await run("stop", { action: "stop", id }))).toBeUndefined();
  const result = await pending;
  expect(result.isError).toBe(true);
  expect(checkpoint(result)).toEqual({ id: "foreground-failure", kind: "report" });
  await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
});

test("running result and stop acknowledgements remain plain; failure delivery is marked", async () => {
  const { h, ctx, run } = await setup("fake-pi-loop.mjs");
  const launch = await run("launch", { task: "long work", agent: "general", async: true });
  const id = launch.details.runs[0].id;
  expect(checkpoint(await run("running", { action: "result", id }))).toBeUndefined();
  expect(checkpoint(await run("steer", { action: "steer", id, message: "continue" }))).toBeUndefined();
  expect(checkpoint(await run("stop", { action: "stop", id }))).toBeUndefined();
  await vi.waitFor(() => expect(h.messages.length).toBeGreaterThan(0));
  expect(checkpoint(h.messages[0].message)).toEqual({ id: expect.any(String), kind: "report" });
  expect(checkpoint(launch)).toBeUndefined();
  await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
});
