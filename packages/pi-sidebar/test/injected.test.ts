import { describe, expect, it } from "vitest";
import { ENVELOPE_PREFIX, INJECTED_WINDOW_MS, InjectedPrompt } from "../src/injected.ts";

const enter = (d: string) => d === "\r";
const paste = (t: string) => `\x1b[200~${t}\x1b[201~`;

describe("InjectedPrompt", () => {
  it("ignores pi-herdr inbox envelopes, which pi-herdr delivers to main itself", () => {
    const p = new InjectedPrompt(() => 0);
    expect(p.observe(`${ENVELOPE_PREFIX}eyJ2IjoxfQ\x1b[201~`, true, enter)).toBeUndefined();
    expect(p.observe("\r", false, enter)).toBeUndefined();
    // The marker matches pi-herdr's (copied structurally, not imported).
    expect(ENVELOPE_PREFIX).toBe("\x1b[200~\u2063\u2063pi-herdr/v1 ");
  });

  it("takes a paste into an empty composer and the Enter right after it", () => {
    let now = 0;
    const p = new InjectedPrompt(() => now);
    expect(p.observe(paste("hi\r\nthere"), true, enter)).toBeUndefined();
    now = 300;
    expect(p.observe("\x1b[I", false, enter)).toBeUndefined();
    expect(p.observe("\r", false, enter)).toBe("hi\nthere");
    expect(p.observe("\r", true, enter)).toBeUndefined();
  });

  it("leaves a paste alone when Enter is late, another key comes between, or the composer had a draft", () => {
    let now = 0;
    const p = new InjectedPrompt(() => now);
    p.observe(paste("a"), true, enter);
    now = INJECTED_WINDOW_MS + 1;
    expect(p.observe("\r", false, enter)).toBeUndefined();
    p.observe(paste("a"), true, enter);
    p.observe("b", false, enter);
    expect(p.observe("\r", false, enter)).toBeUndefined();
    p.observe(paste("a"), false, enter);
    expect(p.observe("\r", false, enter)).toBeUndefined();
    p.observe(paste("   "), true, enter);
    expect(p.observe("\r", false, enter)).toBeUndefined();
  });
});
