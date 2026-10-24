import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

const OPERATOR_MOTION_FINAL_STATE_CASES: NvimParityCase[] = [
  {
    name: "dw - deletes to the next word start",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 0 } },
    keys: ["d", "w"],
  },
  {
    name: "de - deletes through the current word end",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 0 } },
    keys: ["d", "e"],
  },
  {
    name: "db - deletes back to the previous word start",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 7 } },
    keys: ["d", "b"],
  },
  {
    name: "d$ - deletes through line end from line start",
    initial: { text: "foo bar", cursor: { line: 0, col: 0 } },
    keys: ["d", "$"],
  },
  {
    name: "d0 - deletes back to absolute line start",
    initial: { text: "  foo bar baz", cursor: { line: 0, col: 8 } },
    keys: ["d", "0"],
  },
  {
    name: "d^ - deletes back to first non-blank",
    initial: { text: "  foo bar baz", cursor: { line: 0, col: 8 } },
    keys: ["d", "^"],
  },
  {
    name: "dW - deletes to the next WORD start",
    initial: { text: "foo.bar   baz.qux", cursor: { line: 0, col: 0 } },
    keys: ["d", "W"],
  },
  {
    name: "dE - deletes through the current WORD end",
    initial: { text: "foo.bar   baz.qux", cursor: { line: 0, col: 0 } },
    keys: ["d", "E"],
  },
  {
    name: "dB - deletes back to the previous WORD start",
    initial: { text: "foo.bar   baz.qux", cursor: { line: 0, col: 14 } },
    keys: ["d", "B"],
  },
  {
    name: "dl - deletes the char under the cursor",
    initial: { text: "foo bar", cursor: { line: 0, col: 1 } },
    keys: ["d", "l"],
  },
  {
    name: "3dl - deletes three chars",
    initial: { text: "foo bar", cursor: { line: 0, col: 1 } },
    keys: ["3", "d", "l"],
  },
  {
    name: "d5l - clamps to line end",
    initial: { text: "foo bar", cursor: { line: 0, col: 5 } },
    keys: ["d", "5", "l"],
  },
  {
    name: "dh - deletes the char before the cursor",
    initial: { text: "foo bar", cursor: { line: 0, col: 4 } },
    keys: ["d", "h"],
  },
  {
    name: "dh at col 0 - no-op",
    initial: { text: "foo bar", cursor: { line: 0, col: 0 } },
    keys: ["d", "h"],
  },
  {
    name: "cl - changes the char under the cursor",
    initial: { text: "foo bar", cursor: { line: 0, col: 1 } },
    keys: ["c", "l", "Z", "\x1b"],
  },
  {
    name: "2cl - changes two chars",
    initial: { text: "foo bar", cursor: { line: 0, col: 1 } },
    keys: ["2", "c", "l", "Z", "\x1b"],
  },
  {
    name: "cl at last char - changes it",
    initial: { text: "foo bar", cursor: { line: 0, col: 6 } },
    keys: ["c", "l", "Z", "\x1b"],
  },
  {
    name: "cl on empty line - enters insert",
    initial: { text: "", cursor: { line: 0, col: 0 } },
    keys: ["c", "l", "Z", "\x1b"],
  },
  {
    name: "ch - changes the char before the cursor",
    initial: { text: "foo bar", cursor: { line: 0, col: 4 } },
    keys: ["c", "h", "Z", "\x1b"],
  },
  {
    name: "yl then P - yanks the char under the cursor",
    initial: { text: "foo bar", cursor: { line: 0, col: 4 } },
    keys: ["y", "l", "P"],
  },
  {
    name: "y2h then p - yanks two chars back and moves the cursor",
    initial: { text: "foo bar", cursor: { line: 0, col: 4 } },
    keys: ["y", "2", "h", "p"],
  },
  {
    name: "cw - changes whitespace to the next word start",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 3 } },
    keys: ["c", "w", "Z", "\x1b"],
  },
  {
    name: "ce - changes through the current word end",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 0 } },
    keys: ["c", "e", "Z", "\x1b"],
  },
  {
    name: "cb - changes back to the previous word start",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 7 } },
    keys: ["c", "b", "Z", "\x1b"],
  },
  {
    name: "c$ - changes through line end",
    initial: { text: "  foo bar baz", cursor: { line: 0, col: 2 } },
    keys: ["c", "$", "Z", "\x1b"],
  },
  {
    name: "c0 - changes back to absolute line start",
    initial: { text: "  foo bar baz", cursor: { line: 0, col: 8 } },
    keys: ["c", "0", "Z", "\x1b"],
  },
  {
    name: "c^ - changes back to first non-blank",
    initial: { text: "  foo bar baz", cursor: { line: 0, col: 8 } },
    keys: ["c", "^", "Z", "\x1b"],
  },
  {
    name: "cW - changes through the current WORD end",
    initial: { text: "foo.bar   baz.qux", cursor: { line: 0, col: 0 } },
    keys: ["c", "W", "Z", "\x1b"],
  },
  {
    name: "cE - changes through the current WORD end",
    initial: { text: "foo.bar   baz.qux", cursor: { line: 0, col: 0 } },
    keys: ["c", "E", "Z", "\x1b"],
  },
  {
    name: "cB - changes back to the previous WORD start",
    initial: { text: "foo.bar   baz.qux", cursor: { line: 0, col: 14 } },
    keys: ["c", "B", "Z", "\x1b"],
  },
  {
    name: "yw - yanks to the next word start",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 0 } },
    keys: ["y", "w"],
  },
  {
    name: "ye - yanks through the current word end",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 0 } },
    keys: ["y", "e"],
  },
  {
    name: "y$ - yanks through line end",
    initial: { text: "  foo bar baz", cursor: { line: 0, col: 2 } },
    keys: ["y", "$"],
  },
  {
    name: "yW - yanks to the next WORD start",
    initial: { text: "foo.bar   baz.qux", cursor: { line: 0, col: 0 } },
    keys: ["y", "W"],
  },
  {
    name: "yE - yanks through the current WORD end",
    initial: { text: "foo.bar   baz.qux", cursor: { line: 0, col: 0 } },
    keys: ["y", "E"],
  },
  {
    name: "2d$ - deletes charwise through the next line end",
    initial: {
      text: "hello world\nfoo bar\nbaz",
      cursor: { line: 0, col: 6 },
    },
    keys: ["2", "d", "$"],
  },
  {
    name: "3d$ - deletes charwise across three line ends",
    initial: { text: "aaa\nbbb\nccc\nddd", cursor: { line: 0, col: 1 } },
    keys: ["3", "d", "$"],
  },
  {
    name: "5d$ - clamps an overflowing count to the last line",
    initial: { text: "aaa\nbbb", cursor: { line: 0, col: 1 } },
    keys: ["5", "d", "$"],
  },
  {
    name: "d5$ - operator-side count deletes through the fifth line end",
    initial: { text: "aaa\nbbb\nccc", cursor: { line: 0, col: 1 } },
    keys: ["d", "5", "$"],
  },
  {
    name: "2d$ on the last line is a no-op",
    initial: { text: "aa\nbbbb", cursor: { line: 1, col: 1 } },
    keys: ["2", "d", "$"],
  },
  {
    name: "2d$ on a single line is a no-op",
    initial: { text: "onlyline", cursor: { line: 0, col: 2 } },
    keys: ["2", "d", "$"],
  },
  {
    name: "2d$ from column zero deletes linewise",
    initial: {
      text: "hello world\nfoo bar\nbaz",
      cursor: { line: 0, col: 0 },
    },
    keys: ["2", "d", "$"],
  },
  {
    name: "2d$ from the first non-blank deletes linewise",
    initial: { text: "  ab cd\nfoo\nbaz", cursor: { line: 0, col: 2 } },
    keys: ["2", "d", "$"],
  },
  {
    name: "2d$ past the first non-blank stays charwise",
    initial: { text: "  ab cd\nfoo\nbaz", cursor: { line: 0, col: 3 } },
    keys: ["2", "d", "$"],
  },
  {
    name: "2d$ linewise through the last line joins upward",
    initial: { text: "x\naa\nbb", cursor: { line: 1, col: 0 } },
    keys: ["2", "d", "$"],
  },
  {
    name: "2c$ - changes charwise through the next line end",
    initial: {
      text: "hello world\nfoo bar\nbaz",
      cursor: { line: 0, col: 6 },
    },
    keys: ["2", "c", "$", "Z", "\x1b"],
  },
  {
    name: "3c$ - changes charwise across three line ends",
    initial: { text: "aaa\nbbb\nccc\nddd", cursor: { line: 0, col: 1 } },
    keys: ["3", "c", "$", "Z", "\x1b"],
  },
  {
    name: "2c$ from column zero stays charwise (never linewise)",
    initial: {
      text: "hello world\nfoo bar\nbaz",
      cursor: { line: 0, col: 0 },
    },
    keys: ["2", "c", "$", "Z", "\x1b"],
  },
  {
    name: "3c$ on the last line is a no-op",
    initial: { text: "aa\nbbbb", cursor: { line: 1, col: 1 } },
    keys: ["3", "c", "$", "Z", "\x1b"],
  },
  {
    name: "2d0 - count is ignored, deletes back to line start",
    initial: { text: "  foo bar", cursor: { line: 0, col: 6 } },
    keys: ["2", "d", "0"],
  },
  {
    name: "2d^ - count is ignored, deletes back to first non-blank",
    initial: { text: "  foo bar", cursor: { line: 0, col: 6 } },
    keys: ["2", "d", "^"],
  },
  {
    name: "2c0 - count is ignored, changes back to line start",
    initial: { text: "  foo bar", cursor: { line: 0, col: 6 } },
    keys: ["2", "c", "0", "Z", "\x1b"],
  },
  {
    name: "2c^ - count is ignored, changes back to first non-blank",
    initial: { text: "  foo bar", cursor: { line: 0, col: 6 } },
    keys: ["2", "c", "^", "Z", "\x1b"],
  },
];

describe("nvim parity operators with motions", () => {
  for (const testCase of OPERATOR_MOTION_FINAL_STATE_CASES) {
    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }
});
