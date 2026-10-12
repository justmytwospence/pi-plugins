import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

const CHAR_FIND_FINAL_STATE_CASES: NvimParityCase[] = [
  {
    name: "f moves to the next matching character",
    initial: { text: "hello world", cursor: { line: 0, col: 0 } },
    keys: ["f", "o"],
  },
  {
    name: "F moves to the previous matching character",
    initial: { text: "alpha beta", cursor: { line: 0, col: 8 } },
    keys: ["F", "a"],
  },
  {
    name: "t moves to before the next matching character",
    initial: { text: "hello world", cursor: { line: 0, col: 0 } },
    keys: ["t", "o"],
  },
  {
    name: "T moves to after the previous matching character",
    initial: { text: "abcde", cursor: { line: 0, col: 4 } },
    keys: ["T", "b"],
  },
  {
    name: "2f moves to the second forward match",
    initial: { text: "foooo", cursor: { line: 0, col: 0 } },
    keys: ["2", "f", "o"],
  },
  {
    name: "3F moves to the third backward match",
    initial: { text: "ooood", cursor: { line: 0, col: 4 } },
    keys: ["3", "F", "o"],
  },
  {
    name: "2t moves to before the second forward match",
    initial: { text: "abacad", cursor: { line: 0, col: 0 } },
    keys: ["2", "t", "a"],
  },
  {
    name: "2T moves to after the second backward match",
    initial: { text: "abacada", cursor: { line: 0, col: 6 } },
    keys: ["2", "T", "a"],
  },
  {
    name: "; repeats the last forward find",
    initial: { text: "hello world", cursor: { line: 0, col: 0 } },
    keys: ["f", "o", ";"],
  },
  {
    name: ", reverses the last forward find",
    initial: { text: "hello world", cursor: { line: 0, col: 0 } },
    keys: ["f", "o", ";", ","],
  },
  {
    name: "; repeats the last backward find",
    initial: { text: "one two one", cursor: { line: 0, col: 10 } },
    keys: ["F", "o", ";"],
  },
  {
    name: ", reverses the last backward find",
    initial: { text: "one two one", cursor: { line: 0, col: 10 } },
    keys: ["F", "o", ";", ","],
  },
  {
    name: "2; repeats the last find twice",
    initial: { text: "axbxcxdxe", cursor: { line: 0, col: 0 } },
    keys: ["f", "x", "2", ";"],
  },
  {
    name: "; repeats till motions without sticking to the first target",
    initial: { text: "axbxcxd", cursor: { line: 0, col: 0 } },
    keys: ["t", "x", ";"],
  },
  // '.' as a char-find target must reach the pending-motion handler as an
  // argument, not be swallowed by the dot-repeat interception (see PR #37).
  {
    name: "f. finds the next period (not dot-repeat)",
    initial: { text: "ab.cd.ef", cursor: { line: 0, col: 0 } },
    keys: ["f", "."],
  },
  {
    name: "F. finds the previous period",
    initial: { text: "ab.cd.ef", cursor: { line: 0, col: 5 } },
    keys: ["F", "."],
  },
  {
    name: "t. moves to before the next period",
    initial: { text: "ab.cd.ef", cursor: { line: 0, col: 0 } },
    keys: ["t", "."],
  },
  {
    name: "df. deletes up to the next period",
    initial: { text: "ab.cd.ef", cursor: { line: 0, col: 0 } },
    keys: ["d", "f", "."],
  },
];

describe("nvim parity char-find motions", () => {
  for (const testCase of CHAR_FIND_FINAL_STATE_CASES) {
    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }
});
