import { mkdtempSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import nextPrompt, { SECTION } from "../src/index.ts";
import { INSTRUCTION, INTERACTIVE_INSTRUCTION } from "../src/tag.ts";
const { default: interactiveShell } = await import(new URL("../../pi-interactive-shell/src/index.ts", import.meta.url).href);
import { fakeJev, harness } from "./harness.ts";

const original = [process.stdin, process.stdout].map(stream => Object.getOwnPropertyDescriptor(stream, "isTTY"));
afterEach(() => {
  [process.stdin, process.stdout].forEach((stream, i) => {
    if (original[i]) Object.defineProperty(stream, "isTTY", original[i]!);
    else delete (stream as any).isTTY;
  });
});

async function setup(first: boolean, tty = true) {
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { configurable: true, value: tty });
  const h = harness();
  for (const plugin of first ? [interactiveShell, nextPrompt] : [nextPrompt, interactiveShell]) plugin(h.pi);
  const jev = fakeJev(() => ({ useful: { type: "bool", probability: 0.9 } }));
  const ctx = h.ctx({ cwd: mkdtempSync("/tmp/handoff-next-"), modelRegistry: jev.registry, isIdle: () => true });
  await h.emit("session_start", {}, ctx);
  const sections: Record<string, string> = {};
  await h.emit("before_agent_start", { prompt: "do interactive step", systemPromptOptions: { sections } }, ctx);
  await h.emit("agent_start", {}, ctx);
  await h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Run this yourself.\n<next>!i sudo true</next>" }] } }, ctx);
  await h.emit("agent_before_settle", { outcome: "completed" }, ctx);
  await h.emit("agent_settled", {}, ctx);
  return { h, ctx, sections };
}

test.each([false, true])("optional capability and Tab-only acceptance work in both registration orders (%s)", async first => {
  const { h, ctx, sections } = await setup(first);
  expect(sections[SECTION]).toBe(INSTRUCTION + INTERACTIVE_INSTRUCTION);
  expect(ctx.ui.press("\t")).toBe(true);
  expect(ctx.ui.editorText).toBe("!i sudo true");
  expect(h.messages).toEqual([]);
});

test("no terminal means no handoff guidance", async () => {
  const { sections } = await setup(false, false);
  expect(sections[SECTION]).toBe(INSTRUCTION);
});

test("typing a draft prevents accepting a command", async () => {
  const { ctx } = await setup(true);
  ctx.ui.editorText = "my draft";
  ctx.ui.press("\t");
  expect(ctx.ui.editorText).toBe("my draft");
});

test("an interceptor clears the offer even when it stops user_bash propagation", async () => {
  const { h, ctx } = await setup(true);
  // Only invoke the first handler, exactly as Pi does when the interceptor returns a result.
  await h.handlers.get("user_bash")![0]({ command: "i", cwd: ctx.cwd }, ctx);
  expect(ctx.ui.press("\t")).toBe(false);
  expect(ctx.ui.editorText).toBe("");
});

test("ordinary user bash also clears the offer", async () => {
  const { h, ctx } = await setup(false);
  await h.emit("user_bash", { command: "true", cwd: ctx.cwd }, ctx);
  expect(ctx.ui.press("\t")).toBe(false);
});
