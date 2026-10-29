import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { planTitle } from "../src/plan-file.js";

const plan = (text: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "title-")), "calm-river.md");
  writeFileSync(file, text);
  return file;
};

test("a plan is called by its first heading, never by its file name", () => {
  assert.equal(planTitle(plan("# Toy demo: `greet.mjs` CLI\n\n## Summary\n")), "Toy demo: greet.mjs CLI");
  assert.equal(planTitle(plan("# Plan: Exec mode UX\n")), "Exec mode UX");
  assert.equal(planTitle(plan("\nAdd a flag to the CLI.\n\n## Changes\n")), "Add a flag to the CLI.");
});

test("a long title is cut and a plan with no text is just the plan", () => {
  assert.equal(planTitle(plan(`# ${"word ".repeat(30)}`)).length, 60);
  assert.ok(planTitle(plan(`# ${"word ".repeat(30)}`)).endsWith("…"));
  assert.equal(planTitle(plan("")), "the plan");
  assert.equal(planTitle("/no/such/file.md"), "the plan");
});
