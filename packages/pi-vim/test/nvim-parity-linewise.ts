import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

const LINEWISE_REPEAT_FINAL_STATE_CASES: NvimParityCase[] = [
  {
    name: "dd deletes the current line",
    initial: { text: "one\ntwo\nthree", cursor: { line: 1, col: 0 } },
    keys: ["d", "d"],
  },
  {
    name: "3dd deletes the current line and two following lines",
    initial: {
      text: "one\ntwo\nthree\nfour\nfive",
      cursor: { line: 1, col: 0 },
    },
    keys: ["3", "d", "d"],
  },
  {
    name: "d2d deletes two lines with an operator count",
    initial: {
      text: "one\ntwo\nthree\nfour",
      cursor: { line: 1, col: 0 },
    },
    keys: ["d", "2", "d"],
  },
  {
    name: "cc changes the current line",
    initial: { text: "one\ntwo words\nthree", cursor: { line: 1, col: 0 } },
    keys: ["c", "c", "\x1b"],
  },
  {
    name: "2cc changes two lines with a prefix count",
    initial: {
      text: "one\ntwo\nthree\nfour",
      cursor: { line: 1, col: 0 },
    },
    keys: ["2", "c", "c", "\x1b"],
  },
  {
    name: "c2c changes two lines with an operator count",
    initial: {
      text: "one\ntwo\nthree\nfour",
      cursor: { line: 1, col: 0 },
    },
    keys: ["c", "2", "c", "\x1b"],
  },
  {
    name: "yy yanks the current line without mutation",
    initial: {
      text: "one\ntwo words\nthree",
      cursor: { line: 1, col: 4 },
      register: "seed",
    },
    keys: ["y", "y"],
  },
  {
    name: "2yy yanks two lines with a prefix count",
    initial: {
      text: "one\ntwo\nthree\nfour",
      cursor: { line: 1, col: 0 },
      register: "seed",
    },
    keys: ["2", "y", "y"],
  },
  {
    name: "y2y yanks two lines with an operator count",
    initial: {
      text: "one\ntwo\nthree\nfour",
      cursor: { line: 1, col: 0 },
      register: "seed",
    },
    keys: ["y", "2", "y"],
  },
];

const UNDERSCORE_LINEWISE_FINAL_STATE_CASES: NvimParityCase[] = [
  {
    name: "d_ deletes the current line linewise",
    initial: { text: "one\n  two\nthree", cursor: { line: 1, col: 0 } },
    keys: ["d", "_"],
  },
  {
    name: "c_ changes the current line linewise",
    initial: { text: "one\n  two\nthree", cursor: { line: 1, col: 0 } },
    keys: ["c", "_", "\x1b"],
  },
  {
    name: "y_ yanks the current line linewise",
    initial: {
      text: "one\n  two\nthree",
      cursor: { line: 1, col: 4 },
      register: "seed",
    },
    keys: ["y", "_"],
  },
];

const LINEWISE_RANGE_FINAL_STATE_CASES: NvimParityCase[] = [
  {
    name: "d2j deletes the current line through two lines below",
    initial: {
      text: "one\ntwo\nthree\nfour\nfive",
      cursor: { line: 1, col: 0 },
    },
    keys: ["d", "2", "j"],
  },
  {
    name: "d2k deletes the current line through two lines above",
    initial: {
      text: "one\ntwo\nthree\nfour\nfive",
      cursor: { line: 3, col: 0 },
    },
    keys: ["d", "2", "k"],
  },
  {
    name: "y2j yanks the current line through two lines below",
    initial: {
      text: "one\ntwo\nthree\nfour\nfive",
      cursor: { line: 1, col: 0 },
      register: "seed",
    },
    keys: ["y", "2", "j"],
  },
  {
    name: "y2k yanks the current line through two lines above",
    initial: {
      text: "one\ntwo\nthree\nfour\nfive",
      cursor: { line: 3, col: 0 },
      register: "seed",
    },
    keys: ["y", "2", "k"],
  },
  {
    name: "dG deletes from the current line through EOF",
    initial: { text: "one\ntwo\nthree\nfour", cursor: { line: 1, col: 0 } },
    keys: ["d", "G"],
  },
];

const LINEWISE_FINAL_STATE_CASES: NvimParityCase[] = [
  ...LINEWISE_REPEAT_FINAL_STATE_CASES,
  ...UNDERSCORE_LINEWISE_FINAL_STATE_CASES,
  ...LINEWISE_RANGE_FINAL_STATE_CASES,
];

const KNOWN_NVIM_PARITY_GAPS = new Set([
  "cc changes the current line",
  "2cc changes two lines with a prefix count",
  "c2c changes two lines with an operator count",
  "c_ changes the current line linewise",
  "y2k yanks the current line through two lines above",
]);

describe("nvim parity linewise operators", () => {
  for (const testCase of LINEWISE_FINAL_STATE_CASES) {
    if (KNOWN_NVIM_PARITY_GAPS.has(testCase.name)) {
      it.skip(`known nvim parity gap: ${testCase.name}`);
      continue;
    }

    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }
});
