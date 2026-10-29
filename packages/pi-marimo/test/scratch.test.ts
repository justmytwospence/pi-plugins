import { expect, test } from "vitest";
import { runScratch } from "../src/ui/scratch.js";

const enc = new TextEncoder();
function body(chunks: string[]): AsyncIterable<Uint8Array> {
  return (async function* () { for (const c of chunks) yield enc.encode(c); })();
}

test("the scratchpad streams what the code prints, then its result", async () => {
  const calls: Array<{ url: string; init?: any }> = [];
  const fetchImpl = async (url: string, init?: any) => {
    calls.push({ url, init });
    if (init?.method !== "POST") return { ok: true, status: 200, body: null, text: async () => '<html data-token="tok">' };
    return {
      ok: true, status: 200, text: async () => "",
      // Events split across chunks, one cut mid-line.
      body: body([
        'event: stdout\ndata: {"data": "one\\ntw',
        'o\\n"}\n\nevent: stderr\ndata: {"data": "<span>Warn</span>ing"}\n\n',
        'event: done\ndata: {"success": true, "output": {"mimetype": "text/plain", "data": "42"}}\n\n',
      ]),
    };
  };
  const events: unknown[] = [];
  const result = await runScratch({ url: "http://h:3", sessionId: "s" }, "print(1)", undefined, (e) => events.push(e), undefined, fetchImpl as never);
  expect(events).toEqual([{ stream: "stdout", text: "one" }, { stream: "stdout", text: "two" }, { stream: "stderr", text: "Warning" }]);
  expect(result).toEqual({ success: true, output: { mimetype: "text/plain", data: "42" } });
  const post = calls.find((c) => c.init?.method === "POST")!;
  expect(post.url).toBe("http://h:3/api/kernel/execute");
  expect(JSON.parse(post.init.body)).toEqual({ code: "print(1)" });
  expect(post.init.headers).toMatchObject({ "Marimo-Session-Id": "s", "Marimo-Server-Token": "tok", Accept: "text/event-stream" });
});

test("a stale server token is fetched again once; another refusal throws", async () => {
  const tokens = ["old", "new"];
  const posts: string[] = [];
  const fetchImpl = async (_url: string, init?: any) => {
    if (init?.method !== "POST") { const token = tokens.shift(); return { ok: true, status: 200, body: null, text: async () => `<html data-token="${token}">` }; }
    posts.push(init.headers["Marimo-Server-Token"]);
    if (init.headers["Marimo-Server-Token"] !== "new") return { ok: false, status: 401, body: null, text: async () => "" };
    return { ok: true, status: 200, body: body(['event: done\ndata: {"success": false, "output": {"mimetype": "text/plain", "data": ""}}\n\n']), text: async () => "" };
  };
  expect(await runScratch({ url: "http://h:4", sessionId: "s" }, "x", undefined, () => {}, undefined, fetchImpl as never)).toMatchObject({ success: false });
  expect(posts).toEqual(["old", "new"]);
  const refused = async (_url: string, init?: any) => init?.method !== "POST" ? { ok: true, status: 200, body: null, text: async () => '<html data-token="t">' } : { ok: false, status: 500, body: null, text: async () => "" };
  await expect(runScratch({ url: "http://h:5", sessionId: "s" }, "x", undefined, () => {}, undefined, refused as never)).rejects.toThrow("marimo answered 500");
});
