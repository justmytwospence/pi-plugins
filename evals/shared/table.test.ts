import assert from "node:assert/strict";
import { test } from "node:test";
import { table } from "./table.ts";

test("columns padded to their widest cell, the first left-aligned and the rest right-aligned", () => {
  assert.equal(table([["a", "1"], ["long", "100"]]), "a       1\nlong  100");
  // Numbers are cells too; trailing blanks of the last column are trimmed.
  assert.equal(table([["calls", "n", "held"], ["walked", 12, ""], ["  clear", 3, 1]]), "calls     n  held\nwalked   12\n  clear   3     1");
  assert.equal(table([]), "");
});
