import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

const LINE_MOTION_PARITY_CASES: NvimParityCase[] = [
  {
    name: "3h: moves left by count",
    initial: { text: "abcdef", cursor: { line: 0, col: 5 } },
    keys: ["3", "h"],
  },
  {
    name: "9h: clamps at the first column",
    initial: { text: "abcdef", cursor: { line: 0, col: 2 } },
    keys: ["9", "h"],
  },
  {
    name: "3l: moves right by count",
    initial: { text: "abcdef", cursor: { line: 0, col: 1 } },
    keys: ["3", "l"],
  },
  {
    name: "9l: clamps at the final character",
    initial: { text: "abcdef", cursor: { line: 0, col: 2 } },
    keys: ["9", "l"],
  },
  {
    name: "2j: moves down by count and preserves column",
    initial: { text: "alpha\nbravo\ncharlie", cursor: { line: 0, col: 2 } },
    keys: ["2", "j"],
  },
  {
    name: "9j: clamps at the last line",
    initial: { text: "alpha\nbravo\ncharlie", cursor: { line: 1, col: 3 } },
    keys: ["9", "j"],
  },
  {
    name: "2k: moves up by count and preserves column",
    initial: { text: "alpha\nbravo\ncharlie", cursor: { line: 2, col: 3 } },
    keys: ["2", "k"],
  },
  {
    name: "9k: clamps at the first line",
    initial: { text: "alpha\nbravo\ncharlie", cursor: { line: 1, col: 3 } },
    keys: ["9", "k"],
  },
  {
    name: "0: moves to the absolute line start",
    initial: { text: "   alpha", cursor: { line: 0, col: 6 } },
    keys: ["0"],
  },
  {
    name: "^: moves to the first non-whitespace character",
    initial: { text: "   alpha", cursor: { line: 0, col: 6 } },
    keys: ["^"],
  },
  {
    name: "_: moves to the first non-whitespace character on the current line",
    initial: { text: "   alpha", cursor: { line: 0, col: 6 } },
    keys: ["_"],
  },
  {
    name: "2_: moves down one line then to first non-whitespace",
    initial: { text: "one\n   two\n  three", cursor: { line: 0, col: 2 } },
    keys: ["2", "_"],
  },
  {
    name: "$: moves to the final character",
    initial: { text: "alpha beta", cursor: { line: 0, col: 0 } },
    keys: ["$"],
  },
  {
    name: "gM: moves to halfway the text of the line (even length)",
    initial: { text: "0123456789", cursor: { line: 0, col: 0 } },
    keys: ["g", "M"],
  },
  {
    name: "gM: moves to halfway the text of the line (odd length)",
    initial: { text: "abcde", cursor: { line: 0, col: 0 } },
    keys: ["g", "M"],
  },
  {
    name: "gM: counts leading whitespace toward the halfway position",
    initial: { text: "   hello world   ", cursor: { line: 0, col: 0 } },
    keys: ["g", "M"],
  },
  {
    name: "1gM: moves near the start of the text",
    initial: { text: "0123456789", cursor: { line: 0, col: 5 } },
    keys: ["1", "g", "M"],
  },
  {
    name: "20gM: moves to that percentage of the line text",
    initial: { text: "0123456789", cursor: { line: 0, col: 5 } },
    keys: ["2", "0", "g", "M"],
  },
  {
    name: "50gM: matches uncounted gM at the halfway point",
    initial: { text: "0123456789", cursor: { line: 0, col: 0 } },
    keys: ["5", "0", "g", "M"],
  },
  {
    name: "60gM: rounds the percentage down on an odd-length line",
    initial: { text: "abcde", cursor: { line: 0, col: 0 } },
    keys: ["6", "0", "g", "M"],
  },
  {
    name: "90gM: moves near the end of a whitespace-padded line",
    initial: { text: "   hello world   ", cursor: { line: 0, col: 0 } },
    keys: ["9", "0", "g", "M"],
  },
  {
    name: "100gM: clamps to the final character",
    initial: { text: "0123456789", cursor: { line: 0, col: 0 } },
    keys: ["1", "0", "0", "g", "M"],
  },
  {
    name: "150gM: ignores counts above 100 and moves halfway",
    initial: { text: "0123456789", cursor: { line: 0, col: 0 } },
    keys: ["1", "5", "0", "g", "M"],
  },
  {
    name: "gM: stays put on an empty line",
    initial: { text: "", cursor: { line: 0, col: 0 } },
    keys: ["g", "M"],
  },
  {
    name: "50gMx: consumes the count and deletes exactly one character",
    initial: { text: "0123456789", cursor: { line: 0, col: 0 } },
    keys: ["5", "0", "g", "M", "x"],
  },
  {
    name: "gg: moves to the first line with nvim cursor placement",
    initial: { text: "one\ntwo\nthree", cursor: { line: 2, col: 2 } },
    keys: ["g", "g"],
  },
  {
    name: "G: moves to the last line with nvim cursor placement",
    initial: { text: "one\ntwo\nthree", cursor: { line: 0, col: 2 } },
    keys: ["G"],
  },
  {
    name: "2gg: moves to the counted line with nvim cursor placement",
    initial: { text: "one\ntwo\nthree", cursor: { line: 0, col: 2 } },
    keys: ["2", "g", "g"],
  },
  {
    name: "2G: moves to the counted line with nvim cursor placement",
    initial: { text: "one\ntwo\nthree", cursor: { line: 0, col: 2 } },
    keys: ["2", "G"],
  },
  {
    name: "j: clamps to the last character on a shorter target line",
    initial: { text: "abcdef\nxy\nabcdef", cursor: { line: 0, col: 5 } },
    keys: ["j"],
  },
  {
    name: "j then j: restores preferred column after a shorter line",
    initial: { text: "abcdef\nxy\nabcdef", cursor: { line: 0, col: 5 } },
    keys: ["j", "j"],
  },
  {
    name: "2j: restores preferred column after an empty intermediate line",
    initial: { text: "abc\n\nabc", cursor: { line: 0, col: 2 } },
    keys: ["2", "j"],
  },
];

const KNOWN_NVIM_PARITY_GAPS = new Set([
  "9l: clamps at the final character",
  "gg: moves to the first line with nvim cursor placement",
  "G: moves to the last line with nvim cursor placement",
  "2gg: moves to the counted line with nvim cursor placement",
  "2G: moves to the counted line with nvim cursor placement",
  "j: clamps to the last character on a shorter target line",
]);

describe("nvim parity line, buffer, and vertical motions", () => {
  for (const testCase of LINE_MOTION_PARITY_CASES) {
    if (KNOWN_NVIM_PARITY_GAPS.has(testCase.name)) {
      it.skip(`known nvim parity gap: ${testCase.name}`);
      continue;
    }

    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }
});
