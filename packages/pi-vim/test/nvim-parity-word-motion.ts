import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

const WORD_MOTION_PARITY_CASES: NvimParityCase[] = [
  {
    name: "w: moves to the start of the next word",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 0 } },
    keys: ["w"],
  },
  {
    name: "w: treats punctuation as separate word spans",
    initial: { text: "foo.bar baz", cursor: { line: 0, col: 0 } },
    keys: ["w"],
  },
  {
    name: "w: moves multiple words with count",
    initial: { text: "one two three four", cursor: { line: 0, col: 0 } },
    keys: ["2", "w"],
  },
  {
    name: "e: moves to a punctuation-delimited word end",
    initial: { text: "foo.bar baz", cursor: { line: 0, col: 0 } },
    keys: ["e"],
  },
  {
    name: "b: moves back through punctuation-delimited words",
    initial: { text: "foo.bar baz", cursor: { line: 0, col: 8 } },
    keys: ["b"],
  },
  {
    name: "W: moves to the start of the next WORD",
    initial: { text: "Foo.Bar   Baz", cursor: { line: 0, col: 0 } },
    keys: ["W"],
  },
  {
    name: "W: moves multiple WORDs with count before a trailing WORD",
    initial: { text: "one.two three.four five", cursor: { line: 0, col: 0 } },
    keys: ["2", "W"],
  },
  {
    name: "E: moves to the end of a punctuation-containing WORD",
    initial: { text: "Foo.Bar   Baz", cursor: { line: 0, col: 0 } },
    keys: ["E"],
  },
  {
    name: "B: moves to the beginning of the previous WORD",
    initial: { text: "Foo.Bar   Baz", cursor: { line: 0, col: 10 } },
    keys: ["B"],
  },
  {
    name: "w: moves across lines to the next word",
    initial: { text: "foo\nbar", cursor: { line: 0, col: 2 } },
    keys: ["w"],
  },
  {
    name: "e: moves across lines to the next word end",
    initial: { text: "foo\nbar", cursor: { line: 0, col: 2 } },
    keys: ["e"],
  },
  {
    name: "b: moves across lines to the previous word",
    initial: { text: "foo\nbar", cursor: { line: 1, col: 0 } },
    keys: ["b"],
  },
];

describe("nvim parity word motions", () => {
  for (const testCase of WORD_MOTION_PARITY_CASES) {
    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }
});
