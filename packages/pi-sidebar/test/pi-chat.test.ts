import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { PiChat } from "../src/pi-chat.ts";

// pi-cc-render gives AssistantMessageComponent a prototype setExpanded (Ctrl+O opens collapsed
// thinking). Stand in for it so the test does not need that sibling.
const proto = AssistantMessageComponent.prototype as unknown as { setExpanded?(value: boolean): void };
afterEach(() => {
  delete proto.setExpanded;
});

describe("PiChat", () => {
  it("keeps assistant messages in step with its own Ctrl+O state", () => {
    const calls: boolean[] = [];
    proto.setExpanded = function (value: boolean) {
      calls.push(value);
    };
    const chat = new PiChat(() => undefined, { cwd: process.cwd() });
    chat.setExpanded(true);
    chat.seed([{ role: "assistant", content: [{ type: "text", text: "hi" }] }], () => undefined);
    expect(calls.at(-1)).toBe(true); // a new message starts with the chat's state, not main's
    chat.setExpanded(false);
    expect(calls.at(-1)).toBe(false);
  });
});
