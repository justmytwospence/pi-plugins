import { expect, test } from "vitest";
import { failure, interactiveCommand } from "../src/handoff.ts";

test("only the explicit i word is intercepted", () => {
  for (const text of ["sudo true", "id", "install x", "i-have-a-command"]) expect(interactiveCommand(text)).toBeUndefined();
  expect(interactiveCommand("i")).toBe("");
  expect(interactiveCommand("i \t ")).toBe("");
  expect(interactiveCommand("i\tprintf 'a b'")).toBe("printf 'a b'");
});

test("errors are concise status-only results", () => {
  expect(failure("requires terminal")).toEqual({ output: "(interactive command: requires terminal)", exitCode: 1, cancelled: false, truncated: false });
});
