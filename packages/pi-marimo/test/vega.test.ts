import { expect, test } from "vitest";
import { VegaRenderer } from "../src/core/vega.js";

const settle = () => new Promise((r) => setTimeout(r, 0));

test("a spec renders once, and its outcome is remembered", async () => {
  let calls = 0;
  const r = new VegaRenderer(async () => { calls++; return "iVBOR"; });
  let done = 0;
  expect(r.request('{"a":1}', () => done++).status).toBe("rendering");
  expect(r.request('{"a":1}', () => done++).status).toBe("rendering");
  await settle();
  expect(r.peek('{"a":1}')).toEqual({ status: "ready", png: "iVBOR" });
  expect(r.request('{"a":1}', () => done++).status).toBe("ready");
  expect(calls).toBe(1);
  expect(done).toBe(1);
});

test("a failed render is reported, not retried every frame", async () => {
  let calls = 0;
  const r = new VegaRenderer(async () => { calls++; throw new Error("uv: not found"); });
  r.request("{}", () => undefined);
  await settle();
  expect(r.request("{}", () => undefined)).toEqual({ status: "failed", reason: "uv: not found" });
  expect(calls).toBe(1);
});
