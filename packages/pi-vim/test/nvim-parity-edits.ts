import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type NvimParityCase,
  type NvimParitySnapshot,
  runNvimParityCase,
  runPiParityCase,
} from "./nvim-oracle.js";

const ESC = "\x1b";

type EditParityCase = NvimParityCase & {
  expected: NvimParitySnapshot;
};

const EDIT_PARITY_CASES: EditParityCase[] = [
  {
    name: "x deletes the cursor grapheme and keeps cursor on next char",
    initial: { text: "abcdef", cursor: { line: 0, col: 2 } },
    keys: ["x"],
    expected: {
      text: "abdef",
      cursor: { line: 0, col: 2 },
      mode: "normal",
      register: "c",
    },
  },
  {
    name: "3x deletes three chars and leaves cursor on following char",
    initial: { text: "abcdef", cursor: { line: 0, col: 1 } },
    keys: ["3", "x"],
    expected: {
      text: "aef",
      cursor: { line: 0, col: 1 },
      mode: "normal",
      register: "bcd",
    },
  },
  {
    name: "9x near EOL clamps to line and backs cursor up",
    initial: { text: "abc", cursor: { line: 0, col: 1 } },
    keys: ["9", "x"],
    expected: {
      text: "a",
      cursor: { line: 0, col: 0 },
      mode: "normal",
      register: "bc",
    },
  },
  {
    name: "x on final char deletes it and moves to previous char",
    initial: { text: "abc", cursor: { line: 0, col: 2 } },
    keys: ["x"],
    expected: {
      text: "ab",
      cursor: { line: 0, col: 1 },
      mode: "normal",
      register: "c",
    },
  },
  {
    name: "X deletes the char before the cursor and lands where it began",
    initial: { text: "abcd", cursor: { line: 0, col: 2 } },
    keys: ["X"],
    expected: {
      text: "acd",
      cursor: { line: 0, col: 1 },
      mode: "normal",
      register: "b",
    },
  },
  {
    name: "2X deletes two chars before the cursor",
    initial: { text: "abcd", cursor: { line: 0, col: 3 } },
    keys: ["2", "X"],
    expected: {
      text: "ad",
      cursor: { line: 0, col: 1 },
      mode: "normal",
      register: "bc",
    },
  },
  {
    name: "5X clamps the count at the start of the line",
    initial: { text: "abcd", cursor: { line: 0, col: 2 } },
    keys: ["5", "X"],
    expected: {
      text: "cd",
      cursor: { line: 0, col: 0 },
      mode: "normal",
      register: "ab",
    },
  },
  {
    name: "X at column 0 is a no-op that preserves the register",
    initial: {
      text: "abc",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["X"],
    expected: {
      text: "abc",
      cursor: { line: 0, col: 0 },
      mode: "normal",
      register: "keep",
    },
  },
  {
    name: "s changes one char after insertion",
    initial: { text: "abcdef", cursor: { line: 0, col: 2 } },
    keys: ["s", "X", ESC],
    expected: {
      text: "abXdef",
      cursor: { line: 0, col: 2 },
      mode: "normal",
      register: "c",
    },
  },
  {
    name: "2s changes two chars after insertion",
    initial: { text: "abcdef", cursor: { line: 0, col: 2 } },
    keys: ["2", "s", "X", ESC],
    expected: {
      text: "abXef",
      cursor: { line: 0, col: 2 },
      mode: "normal",
      register: "cd",
    },
  },
  {
    name: "S changes the current line linewise",
    initial: { text: "abcdef", cursor: { line: 0, col: 2 } },
    keys: ["S", "X", ESC],
    expected: {
      text: "X",
      cursor: { line: 0, col: 0 },
      mode: "normal",
      register: "abcdef\n",
    },
  },
  {
    name: "D deletes through EOL and backs cursor onto last remaining char",
    initial: { text: "abcdef", cursor: { line: 0, col: 2 } },
    keys: ["D"],
    expected: {
      text: "ab",
      cursor: { line: 0, col: 1 },
      mode: "normal",
      register: "cdef",
    },
  },
  {
    name: "C changes through EOL after insertion",
    initial: { text: "abcdef", cursor: { line: 0, col: 2 } },
    keys: ["C", "X", ESC],
    expected: {
      text: "abX",
      cursor: { line: 0, col: 2 },
      mode: "normal",
      register: "cdef",
    },
  },
  {
    name: "r replaces one char without changing register",
    initial: {
      text: "abcdef",
      cursor: { line: 0, col: 2 },
      register: "keep",
    },
    keys: ["r", "X"],
    expected: {
      text: "abXdef",
      cursor: { line: 0, col: 2 },
      mode: "normal",
      register: "keep",
    },
  },
  {
    name: "3r replaces three chars and lands on last replacement",
    initial: {
      text: "abcdef",
      cursor: { line: 0, col: 2 },
      register: "keep",
    },
    keys: ["3", "r", "X"],
    expected: {
      text: "abXXXf",
      cursor: { line: 0, col: 4 },
      mode: "normal",
      register: "keep",
    },
  },
  {
    name: "5r on too-short tail leaves buffer and register unchanged",
    initial: {
      text: "abc",
      cursor: { line: 0, col: 1 },
      register: "keep",
    },
    keys: ["5", "r", "X"],
    expected: {
      text: "abc",
      cursor: { line: 0, col: 1 },
      mode: "normal",
      register: "keep",
    },
  },
  {
    name: "r on final char keeps cursor on replaced final char",
    initial: {
      text: "abc",
      cursor: { line: 0, col: 2 },
      register: "keep",
    },
    keys: ["r", "X"],
    expected: {
      text: "abX",
      cursor: { line: 0, col: 2 },
      mode: "normal",
      register: "keep",
    },
  },
  {
    name: "x deletes a leading emoji grapheme",
    initial: { text: "😀x", cursor: { line: 0, col: 0 } },
    keys: ["x"],
    expected: {
      text: "x",
      cursor: { line: 0, col: 0 },
      mode: "normal",
      register: "😀",
    },
  },
  {
    name: "r replaces a leading emoji grapheme",
    initial: {
      text: "😀x",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["r", "a"],
    expected: {
      text: "ax",
      cursor: { line: 0, col: 0 },
      mode: "normal",
      register: "keep",
    },
  },
  {
    name: "r accepts a composed replacement grapheme",
    initial: {
      text: "abc",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["r", "e\u0301"],
    expected: {
      text: "e\u0301bc",
      cursor: { line: 0, col: 0 },
      mode: "normal",
      register: "keep",
    },
  },
  // '.' as the replacement char must reach the pending-replace handler as an
  // argument, not be swallowed by the dot-repeat interception (see PR #37).
  {
    name: "r. replaces with a period (not dot-repeat)",
    initial: {
      text: "abcde",
      cursor: { line: 0, col: 1 },
      register: "keep",
    },
    keys: ["r", "."],
    expected: {
      text: "a.cde",
      cursor: { line: 0, col: 1 },
      mode: "normal",
      register: "keep",
    },
  },
];

const KNOWN_NVIM_PARITY_GAPS = new Set([
  "S changes the current line linewise",
  "D deletes through EOL and backs cursor onto last remaining char",
]);

async function assertFinalStateMatchesNvim(
  testCase: EditParityCase,
): Promise<void> {
  const { expected, ...parityCase } = testCase;
  const nvim = await runNvimParityCase(parityCase);

  assert.deepEqual(nvim, expected, "curated final state should match nvim");
  assert.deepEqual(
    runPiParityCase(parityCase),
    expected,
    "pi-vim final state should match nvim",
  );
}

describe("nvim parity single-key edits and replace", () => {
  for (const testCase of EDIT_PARITY_CASES) {
    if (KNOWN_NVIM_PARITY_GAPS.has(testCase.name)) {
      it.skip(`known nvim parity gap: ${testCase.name}`);
      continue;
    }

    it(testCase.name, async () => {
      await assertFinalStateMatchesNvim(testCase);
    });
  }
});
