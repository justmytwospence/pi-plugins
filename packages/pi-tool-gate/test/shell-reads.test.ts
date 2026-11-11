import { expect, test } from "vitest";
import toolGate from "../src/index.ts";
import { askShellReads, declareShellReads, SHELL_READS_CHANNEL } from "../src/shell-reads.ts";
import { harness } from "./harness.ts";

function bus() {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  return {
    on: (channel: string, listener: (data: unknown) => void) => { listeners.set(channel, [...(listeners.get(channel) ?? []), listener]); },
    emit: (channel: string, data: unknown) => { for (const listener of listeners.get(channel) ?? []) listener(data); },
  };
}

test("an owner answers; no owner leaves the answer undefined", () => {
  const events = bus();
  expect(askShellReads(events, "ls", "/r")).toBeUndefined();
  expect(askShellReads(undefined, "ls", "/r")).toBeUndefined();
  declareShellReads(events, (command, cwd) => command === "ls" && cwd === "/r");
  expect(askShellReads(events, "ls", "/r")).toBe(true);
  expect(askShellReads(events, "ls", "/elsewhere")).toBe(false);
  expect(askShellReads(events, "rm x", "/r")).toBe(false);
});

test("any owner's no wins, and a throwing predicate is a no", () => {
  const events = bus();
  declareShellReads(events, () => true);
  declareShellReads(events, () => false);
  expect(askShellReads(events, "ls", "/r")).toBe(false);
  const thrown = bus();
  declareShellReads(thrown, () => { throw new Error("x"); });
  expect(askShellReads(thrown, "ls", "/r")).toBe(false);
});

test("malformed requests get no answer", () => {
  const events = bus();
  declareShellReads(events, () => true);
  for (const request of [{ version: 2, command: "ls", cwd: "/r" }, { version: 1, cwd: "/r" }, { version: 1, command: "ls" }]) {
    const copy: Record<string, unknown> = { ...request };
    events.emit(SHELL_READS_CHANNEL, copy);
    expect(copy.reads).toBeUndefined();
  }
});

test("the gate answers with its read-only analysis, expansions included", () => {
  const h = harness();
  toolGate(h.pi);
  const ask = (command: string) => askShellReads(h.pi.events as never, command, "/r");
  expect(ask("git status")).toBe(true);
  expect(ask("wc -l $(git ls-files)")).toBe(true);
  expect(ask("npm test")).toBe(false);
  expect(ask("sed -i s/a/b/ x")).toBe(false);
});
