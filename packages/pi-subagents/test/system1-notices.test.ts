import "./isolated-agent-dir.ts";
import { expect, test, vi } from "vitest";
import { Child } from "../src/child.ts";
import { type RunLink, relaySystem1Notice } from "../src/run.ts";
import { type System1Notice, encodeSystem1Notice } from "../src/system1.ts";

const notice = (at = Date.now()): System1Notice => ({ version: 1, at, kind: "provider_failed", waterfall: ["jev", "openai-decisions"], backend: "jev", code: "quota_exhausted", next: "openai-decisions" });
function rpc(onSystem1Notice = vi.fn(), onDialog = vi.fn(async () => ({ value: "Block" }))) {
  const child = new Child({ task: "offline", cwd: "/tmp", model: "worker/test", thinking: "low", sessionDir: "/tmp", onSystem1Notice, onDialog });
  const send = vi.spyOn(child as any, "send").mockImplementation(() => undefined);
  const line = (event: Record<string, unknown>) => (child as any).onLine(JSON.stringify({ type: "extension_ui_request", id: "ui-1", ...event }));
  return { child, onSystem1Notice, onDialog, send, line };
}

test("branded RPC notify forwards structured health, never an approval or conversation message", () => {
  const env = rpc();
  const value = notice();
  env.line({ method: "notify", message: encodeSystem1Notice(value), notifyType: "warning" });
  expect(env.onSystem1Notice).toHaveBeenCalledExactlyOnceWith(value);
  expect(env.onDialog).not.toHaveBeenCalled();
  expect(env.send).not.toHaveBeenCalled();
  expect(env.child.conversation.messages).toEqual([]);
  expect(env.child.state.error).toBeUndefined();
});

test("ordinary, malformed, oversized and invalid branded RPC notifications are ignored", () => {
  const env = rpc();
  const prefix = "pi-system1.notice.v1:";
  for (const message of [
    "ordinary notification", undefined, null, 17, prefix + "{", prefix + " ".repeat(4097),
    prefix + JSON.stringify({ ...notice(), backend: "other" }),
    prefix + JSON.stringify({ ...notice(), code: "secret error text" }),
    prefix + JSON.stringify({ ...notice(), at: null }),
    prefix + JSON.stringify({ ...notice(), raw: "provider response" }),
  ]) env.line({ method: "notify", message });
  env.line({ method: "setStatus", message: encodeSystem1Notice(notice()) });
  expect(env.onSystem1Notice).not.toHaveBeenCalled();
  expect(env.onDialog).not.toHaveBeenCalled();
  expect(env.send).not.toHaveBeenCalled();
});

test("notice sink errors leave the RPC stream and ordinary permission dialogs intact", async () => {
  const env = rpc(vi.fn(() => { throw new Error("stale observer"); }));
  expect(() => env.line({ method: "notify", message: encodeSystem1Notice(notice()) })).not.toThrow();
  env.line({ method: "select", title: "Allow?", options: ["Allow once", "Block"] });
  await Promise.resolve();
  expect(env.onDialog).toHaveBeenCalledOnce();
  expect(env.send).toHaveBeenCalledExactlyOnceWith({ type: "extension_ui_response", id: "ui-1", value: "Block" });
});

test("RunLink retains only the newest eight parked notices and routes live ones through the current owner", () => {
  const link: RunLink = { done: Promise.resolve() };
  const values = Array.from({ length: 12 }, (_, i) => notice(i));
  for (const value of values) relaySystem1Notice(link, value);
  expect(link.system1Notices).toEqual(values.slice(-8));
  const current = vi.fn();
  link.system1Notice = current;
  relaySystem1Notice(link, notice(20));
  expect(current).toHaveBeenCalledExactlyOnceWith(notice(20));
  expect(link.system1Notices).toHaveLength(8);
});
