import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Bridge } from "../src/bridge.ts";
import { PaneReporter } from "../src/core/report.ts";
import { displayAgent, firstUserText } from "../src/identity.ts";
import { lastAssistantText, readReply } from "../src/session.ts";
import { fakeCall } from "./core/fake.ts";

describe("identity", () => {
  it("names the agent and finds the first prompt", () => {
    expect(displayAgent("claude-opus-5-5", "xhigh")).toBe("pi opus-5-5:xhigh");
    expect(displayAgent("claude-opus-5-5", "off")).toBe("pi opus-5-5");
    expect(displayAgent(undefined, "high")).toBe("pi");
    const entries = [
      { type: "custom" },
      { type: "message", message: { role: "assistant", content: "no" } },
      { type: "message", message: { role: "user", content: [{ type: "image" }, { type: "text", text: "hello" }] } },
    ];
    expect(firstUserText(entries)).toBe("hello");
  });
});

describe("session reply", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const session = [
    line({ type: "session", version: 3 }),
    line({ type: "message", message: { role: "user", content: "go" } }),
    line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "first" }] } }),
    line({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } }),
    line({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "Done.\n\n<next>commit it</next>" }] } }),
    line({ type: "custom", customType: "x", data: {} }),
    "",
  ].join("\n");

  it("takes the last assistant text and drops the next-prompt line", () => {
    expect(lastAssistantText(session)).toBe("Done.\n\n<next>commit it</next>");
    const dir = mkdtempSync(path.join(tmpdir(), "pi-herdr-"));
    const file = path.join(dir, "s.jsonl");
    writeFileSync(file, session);
    expect(readReply(file)).toBe("Done.");
    expect(readReply(path.join(dir, "missing.jsonl"))).toBeUndefined();
  });
});

describe("bridge", () => {
  it("zooms while held, only if it was not zoomed", async () => {
    let zoomed = false;
    const f = fakeCall({
      "pane.layout": () => ({ result: { layout: { zoomed, panes: [{ pane_id: "w1:p1", rect: { width: 200, height: 50 } }] } } }),
      "pane.zoom": (p) => {
        zoomed = p.mode === "on";
        return { result: {} };
      },
    });
    const b = new Bridge(f.call, new PaneReporter(f.call, "w1:p1"));
    await b.zoom(true);
    await b.zoom(true);
    await b.zoom(false);
    expect(zoomed).toBe(true);
    await b.zoom(false);
    expect(zoomed).toBe(false);
    zoomed = true;
    await b.zoom(true);
    await b.zoom(false);
    expect(zoomed).toBe(true);
    expect(f.of("pane.zoom")).toHaveLength(2);
  });

  it("runs a command in a split and reports back", async () => {
    const f = fakeCall({
      "pane.layout": () => ({ result: { layout: { zoomed: false, panes: [{ pane_id: "w1:p1", rect: { width: 120, height: 40 } }] } } }),
      "pane.split": () => ({ result: { pane: { pane_id: "w1:p2" } } }),
    });
    const b = new Bridge(f.call, new PaneReporter(f.call, "w1:p1"));
    let got: [boolean, string] | undefined;
    await b.split({ command: "vi +3 'a b'", cwd: "/r", done: (ok, m) => (got = [ok, m]) });
    expect(f.of("pane.split")[0]!.params).toMatchObject({ target_pane_id: "w1:p1", direction: "down", cwd: "/r" });
    expect(f.of("pane.send_input")[0]!.params).toEqual({ pane_id: "w1:p2", text: "vi +3 'a b'; exit", keys: ["enter"] });
    expect(got).toEqual([true, "w1:p2"]);
  });

  it("closes the split when the command cannot be sent", async () => {
    const f = fakeCall({
      "pane.layout": () => ({ result: { layout: { zoomed: false, panes: [{ pane_id: "w1:p1", rect: { width: 120, height: 40 } }] } } }),
      "pane.split": () => ({ result: { pane: { pane_id: "w1:p2" } } }),
      "pane.send_input": () => ({ error: { code: "pane_send_failed", message: "too long" } }),
    });
    const b = new Bridge(f.call, new PaneReporter(f.call, "w1:p1"));
    let got: [boolean, string] | undefined;
    await b.split({ command: "x", cwd: "/r", done: (ok, m) => (got = [ok, m]) });
    expect(f.of("pane.close")[0]!.params).toEqual({ pane_id: "w1:p2" });
    expect(got).toEqual([false, "herdr opened a split but could not run the command: too long (pane_send_failed)"]);
  });

  it("notifies unless focused", async () => {
    let focused = true;
    const f = fakeCall({ "pane.get": () => ({ result: { pane: { focused } } }) });
    const b = new Bridge(f.call, new PaneReporter(f.call, "w1:p1"));
    await b.notify({ title: "done", unlessFocused: true });
    expect(f.of("notification.show")).toHaveLength(0);
    focused = false;
    await b.notify({ title: "done", body: "x", sound: "done", unlessFocused: true });
    expect(f.of("notification.show")[0]!.params).toEqual({ title: "done", body: "x", sound: "done" });
  });
});
