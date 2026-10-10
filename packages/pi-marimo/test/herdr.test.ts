import { describe, expect, test } from "vitest";
import { HerdrHold } from "../src/herdr.js";

function bus() {
  const sent: Array<[string, unknown]> = [];
  return { sent, emit: (channel: string, data: unknown) => void sent.push([channel, data]) };
}

describe("herdr reports of the kernel hold", () => {
  test("the token while held, then cleared with a notification", async () => {
    const b = bus();
    const herdr = new HerdrHold(b);
    await herdr.apply({ kind: "held", value: "fit.py: Model fit" });
    herdr.resend();
    await herdr.apply({ kind: "finished", title: "fit.py finished", body: "ran 2m00s" });
    expect(b.sent).toEqual([
      ["herdr:token", { key: "marimo", value: "fit.py: Model fit" }],
      ["herdr:token", { key: "marimo", value: "fit.py: Model fit" }],
      ["herdr:token", { key: "marimo", value: undefined }],
      ["herdr:notify", { title: "fit.py finished", body: "ran 2m00s", sound: "done", unlessFocused: true }],
    ]);
  });

  test("a release clears without a notification; nothing without an event bus", async () => {
    const b = bus();
    const herdr = new HerdrHold(b);
    await herdr.apply({ kind: "released" });
    await herdr.apply({ kind: "held", value: "fit.py: 2 queued" });
    await herdr.apply({ kind: "released" });
    herdr.resend();
    expect(b.sent.map(([c]) => c)).toEqual(["herdr:token", "herdr:token"]);
    await new HerdrHold(undefined).apply({ kind: "held", value: "x" });
  });
});
